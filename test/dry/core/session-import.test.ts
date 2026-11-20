/**
 * The importer that reconciles chats with native sessions: auto-import,
 * retention, tombstones, and linking sessions started in an agent's UI.
 * Negative checks wait for a scan that started after the change to finish,
 * instead of sleeping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessRegistry } from '../../../src/core/harness/HarnessRegistry';
import { HarnessSession } from '../../../src/core/harness/types';
import { SessionImportService, SessionImportSettings } from '../../../src/core/services/SessionImportService';
import { importedChatId } from '../../../src/core/services/StorageService';
import { WorktreeCatalog } from '../../../src/core/services/WorktreeCatalog';
import { ChatSession, Worktree } from '../../../src/core/types';
import { fakeAdapter, flush, makeStorage, sessionRecord, waitFor, worktreeRecord } from '../support';

const DAY = 24 * 60 * 60 * 1000;

function setup(t: { after(fn: () => void): void }) {
  const storage = makeStorage();
  const repo = storage.addRepository('demo', '/work/demo');
  const worktree = worktreeRecord({ id: 'wt-main', repoId: repo.id, path: '/work/demo' });
  const worktreesByRoot = new Map<string, Worktree[]>([[repo.rootPath, [worktree]]]);
  const git = {
    listRepositoryWorktrees: (rootPath: string) => ({ isGit: true, worktrees: worktreesByRoot.get(rootPath) ?? [] }),
    listRepositoryWorktreesAsync: async (rootPath: string) => ({ isGit: true, worktrees: worktreesByRoot.get(rootPath) ?? [] }),
  };
  const sessions: HarnessSession[] = [];
  const settings: SessionImportSettings = { enabled: true, retentionDays: 7 };
  const openChats = new Set<string>();
  let listCalls = 0;
  const list = async () => {
    listCalls++;
    return sessions;
  };
  const registry = new HarnessRegistry([
    fakeAdapter('claude', { listSessionsForWorktree: list, listSessionsForRepository: list }),
  ]);
  const create = () =>
    new SessionImportService(storage, new WorktreeCatalog(storage, git as never), registry, {
      scanIntervalMs: 20,
      hotScanIntervalMs: 10,
      isChatOpen: (chat) => openChats.has(chat.id),
      readSettings: () => settings,
    });
  let service = create();
  t.after(() => service.dispose());

  /** A native session last active `ageMs` ago. */
  const appear = (sessionId: string, summary: string | null, ageMs = 0) => {
    const session = sessionRecord('claude', sessionId, { cwd: worktree.path, summary, lastUpdated: new Date(Date.now() - ageMs) });
    sessions.push(session);
    return session;
  };
  /** A chat in the worktree, linked to `sessionId` unless null. */
  const chat = (name: string, sessionId: string | null, updates: Partial<ChatSession> = {}) => {
    const created = storage.createChat(worktree.id, 'claude', name);
    return storage.updateChat(created.id, { harnessSessionId: sessionId, ...updates })!;
  };
  const linkedTo = (sessionId: string) => storage.getChats().find((entry) => entry.harnessSessionId === sessionId);
  /**
   * Resolves once a scan that started after this call has finished. A scan
   * does no async work after listing, so draining the queue completes it.
   */
  const scanned = async () => {
    const from = listCalls;
    await waitFor(() => {
      service.wake();
      return listCalls > from;
    }, 'a scan');
    await flush();
  };
  /** Another workspace root, such as a parent folder holding the repository. */
  const addRoot = (name: string, rootPath: string) => {
    const root = storage.addRepository(name, rootPath);
    const rootWorktree = worktreeRecord({ id: `wt-${name}`, repoId: root.id, name, path: rootPath });
    worktreesByRoot.set(rootPath, [rootWorktree]);
    return rootWorktree;
  };
  return {
    storage, worktree, settings, addRoot, openChats, appear, chat, linkedTo, scanned,
    get service() {
      return service;
    },
    /** A new service over the same stored state, like an extension-host reload. */
    reload() {
      service.dispose();
      service = create();
      return service;
    },
  };
}

test('recent native sessions are imported under the harness name, which follows the harness until the user renames', async (t) => {
  const f = setup(t);
  const recent = f.appear('s-recent', 'Named by the harness', 60_000);
  f.appear('s-old', 'Old session', 8 * DAY);
  f.service.start();

  const imported = await waitFor(() => f.linkedTo('s-recent'), 'the import');
  assert.equal(imported.name, 'Named by the harness');
  assert.equal(imported.autoImported, true);
  await f.scanned();
  assert.equal(f.linkedTo('s-old'), undefined, 'outside the retention window');

  recent.summary = 'Updated harness name';
  await waitFor(() => f.storage.getChat(imported.id)?.name === 'Updated harness name', 'the rename');
  f.storage.updateChat(imported.id, { name: 'My name', customName: true });
  recent.summary = 'Ignored harness name';
  await f.scanned();
  assert.equal(f.storage.getChat(imported.id)?.name, 'My name');
});

test("a name the user gave the session in Claude (/rename) renames its chat, unless the chat was renamed in Pitwall (v0.6.0)", async (t) => {
  const f = setup(t);
  // A chat the user started, named once from Claude's first title (it no longer follows the generated one)...
  const started = f.chat('Pitwall initial idea', 's-started');
  // ...and one the user renamed in Pitwall.
  const renamed = f.chat('My Pitwall name', 's-renamed', { customName: true });
  const startedSession = f.appear('s-started', 'Pitwall initial idea v2', 60_000);
  const renamedSession = f.appear('s-renamed', 'Generated title', 60_000);
  f.service.start();
  await f.scanned();
  assert.equal(f.storage.getChat(started.id)?.name, 'Pitwall initial idea', 'a generated title change leaves a user-started chat alone, as before');

  startedSession.summary = 'Main';
  startedSession.userTitled = true;
  renamedSession.summary = 'Claude-side name';
  renamedSession.userTitled = true;
  await waitFor(() => f.storage.getChat(started.id)?.name === 'Main', "the chat takes the name Claude's tab shows");
  await f.scanned();
  assert.equal(f.storage.getChat(renamed.id)?.name, 'My Pitwall name', 'a Pitwall rename is never overwritten');
  assert.equal(f.storage.getChat(renamed.id)?.customName, true);
  assert.equal(f.storage.getChat(started.id)?.customName, undefined, 'following Claude is not a Pitwall rename');
});

test('a session the user removed stays removed, and nothing is imported while the setting is off', async (t) => {
  const removed = setup(t);
  removed.appear('s-removed', 'Removed', 60_000);
  removed.storage.rememberRemovedSession('claude', 's-removed');
  removed.service.start();
  await removed.scanned();
  assert.equal(removed.linkedTo('s-removed'), undefined);

  const disabled = setup(t);
  disabled.settings.enabled = false;
  disabled.appear('s-disabled', 'Disabled', 60_000);
  disabled.service.start();
  await disabled.scanned();
  assert.equal(disabled.linkedTo('s-disabled'), undefined);
});

test('retention removes every quiet row except starred and open ones', async (t) => {
  const f = setup(t);
  const old = { createdAt: Date.now() - 8 * DAY, lastAccessedAt: Date.now() - 8 * DAY };
  const quiet = (name: string, extra: Partial<ChatSession> = {}) => {
    const session = f.appear(`s-${name}`, name, 8 * DAY);
    return f.chat(name, session.sessionId, { ...old, ...extra });
  };
  const autoImported = quiet('auto', { autoImported: true });
  const created = quiet('created');
  const unlinked = f.chat('unlinked', null, old);
  const starredAuto = quiet('starred-auto', { autoImported: true });
  const starred = quiet('starred');
  const open = quiet('open');
  f.storage.toggleStar(starredAuto.id);
  f.storage.toggleStar(starred.id);
  f.openChats.add(open.id);

  f.service.start();
  await waitFor(() => !f.storage.getChat(autoImported.id), 'the expired rows to go');
  const remaining = new Set(f.storage.getChats().map((entry) => entry.name));
  assert.deepEqual([...remaining].sort(), ['open', 'starred', 'starred-auto']);
  assert.equal(f.storage.getRemovedSessionKeys().size, 0, 'retention is not a user removal');
  void created;
  void unlinked;
});

test('a UI-started placeholder links to the first new session in its worktree and takes its name', async (t) => {
  const f = setup(t);
  const placeholder = f.chat('New Session', null, { pendingUiLaunch: true });
  await f.service.expectChat(placeholder.id, f.worktree.path, { bindSurface: false });
  f.appear('s-ui', 'UI session');
  f.service.start();

  await waitFor(() => f.storage.getChat(placeholder.id)?.harnessSessionId, 'the link');
  const linked = f.storage.getChat(placeholder.id)!;
  assert.deepEqual([linked.harnessSessionId, linked.name, linked.pendingUiLaunch], ['s-ui', 'UI session', false]);
});

test('the launch snapshot survives a reload, so the placeholder never claims an older session', async (t) => {
  const f = setup(t);
  const older = f.appear('s-pre', 'Pre-existing', 60_000);
  const placeholder = f.chat('New Session', null, { pendingUiLaunch: true });
  await f.service.expectChat(placeholder.id, f.worktree.path, { bindSurface: false });
  assert.deepEqual(f.storage.getChat(placeholder.id)?.pendingUiKnownSessionIds, ['s-pre']);

  // The host reloads before the first prompt while the older session stays
  // active elsewhere, so its timestamp is now newer than the placeholder.
  older.lastUpdated = new Date();
  older.lastActivity = Date.now();
  f.reload().start();
  await f.scanned();
  assert.equal(f.storage.getChat(placeholder.id)?.harnessSessionId, null);

  f.appear('s-ui', 'UI session');
  await waitFor(() => f.storage.getChat(placeholder.id)?.harnessSessionId === 's-ui', 'the link after the reload');
  assert.equal(f.storage.getChat(placeholder.id)?.pendingUiKnownSessionIds, undefined, 'linking clears the snapshot');
});

test('a CLI launch reserves its session for the watcher until the placeholder goes stale', async (t) => {
  const f = setup(t);
  const launch = f.chat('New Session', null);
  f.appear('s-cli', 'CLI session');
  f.service.start();
  await f.scanned();
  assert.equal(f.linkedTo('s-cli'), undefined, 'the importer does not race the watcher');
  assert.equal(f.storage.getChat(launch.id)?.harnessSessionId, null);

  f.storage.updateChat(launch.id, { createdAt: Date.now() - 2 * DAY });
  await waitFor(() => f.linkedTo('s-cli')?.autoImported, 'a stale placeholder to stop reserving');
});

test('a root nested in another keeps its own sessions, and rows imported under the outer root move to it', async (t) => {
  const f = setup(t);
  const outer = f.addRoot('work', '/work');
  // Imported under the parent folder before nested roots were told apart.
  const misplaced = f.storage.createChat(outer.id, 'claude', 'Old import', { harnessSessionId: 's-old' });
  f.storage.toggleStar(misplaced.id);
  f.appear('s-old', 'Old import', 60_000);
  f.appear('s-inner', 'Inner session', 60_000);
  const own = f.appear('s-outer', 'Outer session', 60_000);
  own.cwd = '/work/notes';
  f.service.start();

  await waitFor(() => f.linkedTo('s-inner') && f.linkedTo('s-outer'), 'the imports');
  await f.scanned();
  assert.equal(f.linkedTo('s-inner')?.worktreeId, f.worktree.id);
  assert.equal(f.linkedTo('s-outer')?.worktreeId, outer.id, 'a plain subdirectory still belongs to the outer root');
  assert.equal(f.linkedTo('s-old')?.id, misplaced.id, 'moved, not re-imported');
  assert.equal(f.linkedTo('s-old')?.worktreeId, f.worktree.id);
  assert.ok(f.storage.getStarredChatIds().has(misplaced.id), 'the star stays');
  assert.equal(f.storage.getChats().filter((chat) => chat.worktreeId === outer.id).length, 1);
});

/**
 * A global state shared by several windows, whose whole value a test can roll
 * back to an older snapshot: another window's write has not reached this
 * window yet.
 */
function sharedState() {
  const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));
  let state: Record<string, unknown> = {};
  return {
    get: <T>(key: string, fallback?: T): T => (key in state ? clone(state[key]) : fallback) as T,
    update: async (key: string, value: unknown): Promise<void> => {
      if (value === undefined) delete state[key];
      else state[key] = clone(value);
    },
    keys: () => Object.keys(state),
    setKeysForSync: () => undefined,
    snapshot: () => clone(state),
    restore: (snapshot: Record<string, unknown>) => {
      state = clone(snapshot);
    },
  };
}

test('a CLI session two windows import at once is listed once, under one chat id, in both', async (t) => {
  const shared = sharedState();
  const windowA = makeStorage(shared as never);
  const repo = windowA.addRepository('lab', '/work/lab');
  const windowB = makeStorage(shared as never);
  const worktree = worktreeRecord({ id: 'wt-lab', repoId: repo.id, path: '/work/lab' });
  const git = {
    listRepositoryWorktrees: () => ({ isGit: true, worktrees: [worktree] }),
    listRepositoryWorktreesAsync: async () => ({ isGit: true, worktrees: [worktree] }),
  };
  // The CLI chat: one harness session (one sessions-file record, one transcript).
  const sessions = [sessionRecord('claude', 's-cli', { cwd: worktree.path, summary: 'T2-C ready' })];
  const importer = (storage: typeof windowA) => {
    const list = async () => sessions;
    const registry = new HarnessRegistry([fakeAdapter('claude', { listSessionsForWorktree: list, listSessionsForRepository: list })]);
    const service = new SessionImportService(storage, new WorktreeCatalog(storage, git as never), registry, {
      scanIntervalMs: 60_000,
      readSettings: () => ({ enabled: true, retentionDays: 7 }),
    });
    t.after(() => service.dispose());
    return service;
  };
  const listed = (storage: typeof windowA) => storage.getChats().filter((chat) => chat.harnessSessionId === 's-cli');

  // Both windows' scans read the store before either import lands.
  const before = shared.snapshot();
  importer(windowA).start();
  await waitFor(() => listed(windowA).length > 0, "window A's import");
  shared.restore(before); // A's write has not reached window B
  importer(windowB).start();
  await waitFor(() => listed(windowB).length > 0, "window B's import");
  // Each window then writes something else, saving what it holds.
  windowA.setActiveChatId(undefined);
  windowB.setActiveChatId(undefined);

  assert.equal(listed(windowA).length, 1, 'window A lists the session once');
  assert.equal(listed(windowB).length, 1, 'window B lists the session once');
  assert.equal(listed(windowA)[0].id, listed(windowB)[0].id, 'both windows show the same row');
});

test('a refresh for an unlisted live session imports it at once, even while a UI launch is linking or the list is hidden', async (t) => {
  const f = setup(t);
  f.service.dispose();
  let visible = true;
  const sessions: ReturnType<typeof sessionRecord>[] = [];
  let scans = 0;
  const service = new SessionImportService(
    f.storage,
    new WorktreeCatalog(f.storage, {
      listRepositoryWorktrees: () => ({ isGit: true, worktrees: [f.worktree] }),
      listRepositoryWorktreesAsync: async () => ({ isGit: true, worktrees: [f.worktree] }),
    } as never),
    new HarnessRegistry([
      fakeAdapter('claude', {
        listSessionsForWorktree: async () => [],
        listSessionsForRepository: async () => {
          scans++;
          return sessions;
        },
      }),
    ]),
    { scanIntervalMs: 60_000, hotScanIntervalMs: 60_000, isVisible: () => visible, readSettings: () => f.settings }
  );
  t.after(() => service.dispose());
  const settle = async () => {
    for (let i = 0; i < 5; i++) await flush();
  };

  // A UI launch in another worktree of the repo is linking (hot for 5 min): scans only poll it.
  const placeholder = f.chat('New Session', null, { pendingUiLaunch: true });
  await service.expectChat(placeholder.id, '/work/demo-worktrees/feat-side', { bindSurface: false });
  service.start();
  await settle();
  sessions.push(sessionRecord('claude', 's-cli', { cwd: f.worktree.path, summary: 'CLI chat' }));
  service.wake();
  await settle();
  assert.equal(f.linkedTo('s-cli'), undefined, 'a plain wake while a launch is hot imports nothing');
  service.refresh();
  await waitFor(() => f.linkedTo('s-cli'), 'the refresh to import the session');
  assert.equal(f.storage.getChat(placeholder.id)?.harnessSessionId, null, "the other worktree's placeholder keeps waiting");

  // Nobody can see the list in this window: a plain wake skips the pass, a refresh does not.
  service.cancelExpectation(placeholder.id);
  f.storage.deleteChat(placeholder.id, { rememberSession: false });
  visible = false;
  sessions.push(sessionRecord('claude', 's-cli-2', { cwd: f.worktree.path, summary: 'Second CLI chat' }));
  const before = scans;
  service.wake();
  await settle();
  assert.equal(scans, before, 'a hidden list skips the plain pass');
  service.refresh();
  await waitFor(() => f.linkedTo('s-cli-2'), 'the refresh while hidden');
});

test('an import pruned by retention comes back under its shared id once its session is active again', async (t) => {
  const f = setup(t);
  const session = f.appear('s-back', 'Comes back', 8 * DAY);
  const old = f.storage.createChat(f.worktree.id, 'claude', 'Comes back', {
    id: importedChatId('claude', 's-back'),
    harnessSessionId: 's-back',
    autoImported: true,
    createdAt: Date.now() - 8 * DAY,
    lastAccessedAt: Date.now() - 8 * DAY,
  });
  f.service.start();
  await waitFor(() => !f.storage.getChat(old.id), 'the retention prune');

  session.lastUpdated = new Date();
  session.lastActivity = Date.now();
  const back = await waitFor(() => f.linkedTo('s-back'), 'the re-import');
  assert.equal(back.id, old.id, 'the tombstone of the pruned row does not hide the new import');
  assert.equal(f.storage.getChats().filter((chat) => chat.harnessSessionId === 's-back').length, 1);
});

/** An importer over the setup's repo whose adapter reads one session by itself from `transcripts`; its list is hidden for its whole life. */
function liveImporter(t: { after(fn: () => void): void }, f: ReturnType<typeof setup>, transcripts: Map<string, HarnessSession>) {
  f.service.dispose();
  const counts = { fullScans: 0, worktreeScans: 0 };
  const service = new SessionImportService(
    f.storage,
    new WorktreeCatalog(f.storage, {
      listRepositoryWorktrees: () => ({ isGit: true, worktrees: [f.worktree] }),
      listRepositoryWorktreesAsync: async () => ({ isGit: true, worktrees: [f.worktree] }),
    } as never),
    new HarnessRegistry([
      fakeAdapter('claude', {
        listSessionsForWorktree: async () => {
          counts.worktreeScans++;
          return [];
        },
        listSessionsForRepository: async () => {
          counts.fullScans++;
          return [];
        },
        // One transcript, read by itself: null until a line places it (its cwd).
        getSession: async (sessionId: string) => transcripts.get(sessionId) ?? null,
      }),
    ]),
    { scanIntervalMs: 60_000, hotScanIntervalMs: 60_000, isVisible: () => false, readSettings: () => f.settings }
  );
  t.after(() => service.dispose());
  return { service, counts };
}

test('importLive lists one live session by itself while the list is hidden, without a full scan; one with nothing importable yet is asked again (new-chat pickup)', async (t) => {
  const f = setup(t);
  const transcripts = new Map<string, HarnessSession>();
  const { service, counts } = liveImporter(t, f, transcripts);

  // The live record exists; its transcript does not place it yet (12f645db's first ask).
  assert.deepEqual(await service.importLive(['s-new']), { retry: ['s-new'], unplaced: [], unsupported: [] }, 'nothing to import yet: ask again');
  assert.equal(f.linkedTo('s-new'), undefined);

  // The first prompt lands: the transcript places it in the listed repo.
  const promptAt = Date.now() - 2_000;
  transcripts.set('s-new', sessionRecord('claude', 's-new', { cwd: f.worktree.path, summary: 'Night ferry story', lastActivity: promptAt }));
  assert.deepEqual(await service.importLive(['s-new']), { retry: [], unplaced: [], unsupported: [] });
  const chat = f.linkedTo('s-new');
  assert.ok(chat, 'listed by the targeted import, list hidden');
  assert.equal(chat!.name, 'Night ferry story');
  assert.equal(chat!.autoImported, true);
  assert.ok((chat!.seenAt ?? Infinity) < promptAt, 'seen before its latest prompt: a first turn that already ended unseen is still news');
  assert.deepEqual(counts, { fullScans: 0, worktreeScans: 0 }, 'no transcript but its own was read');

  // Already listed: nothing to do and nothing to retry.
  assert.deepEqual(await service.importLive(['s-new']), { retry: [], unplaced: [], unsupported: [] });
  assert.equal(f.storage.getChats().filter((entry) => entry.harnessSessionId === 's-new').length, 1);

  // A session in a folder Pitwall does not list is for discovery (asked again once it lists it); a removed one stays removed.
  transcripts.set('s-elsewhere', sessionRecord('claude', 's-elsewhere', { cwd: '/elsewhere/repo' }));
  transcripts.set('s-removed', sessionRecord('claude', 's-removed', { cwd: f.worktree.path }));
  f.storage.rememberRemovedSession('claude', 's-removed');
  assert.deepEqual(await service.importLive(['s-elsewhere', 's-removed']), { retry: [], unplaced: ['s-elsewhere'], unsupported: [] });
  assert.equal(f.linkedTo('s-removed'), undefined, 'a removed session is never brought back');
  assert.deepEqual(counts, { fullScans: 0, worktreeScans: 0 });
});

test('importLive links a UI launch waiting in that worktree instead of importing a second row', async (t) => {
  const f = setup(t);
  const transcripts = new Map<string, HarnessSession>();
  const { service } = liveImporter(t, f, transcripts);
  const placeholder = f.chat('New Session', null, { pendingUiLaunch: true });
  await service.expectChat(placeholder.id, f.worktree.path, { bindSurface: false });
  transcripts.set('s-ui', sessionRecord('claude', 's-ui', { cwd: f.worktree.path, summary: 'From the panel' }));
  assert.deepEqual(await service.importLive(['s-ui']), { retry: [], unplaced: [], unsupported: [] });
  assert.equal(f.storage.getChat(placeholder.id)?.harnessSessionId, 's-ui', 'the placeholder claims it');
  assert.equal(f.storage.getChats().filter((entry) => entry.harnessSessionId === 's-ui').length, 1, 'one row');
});

test('importLive: a waiting UI launch claims the same session a scan would (the earliest new one), whatever order they are asked in (QA probe, #73)', async (t) => {
  const f = setup(t);
  const transcripts = new Map<string, HarnessSession>();
  const { service } = liveImporter(t, f, transcripts);
  const placeholder = f.chat('New Session', null, { pendingUiLaunch: true });
  await service.expectChat(placeholder.id, f.worktree.path, { bindSurface: false });
  const now = Date.now();
  // s-ui: the panel launch's own session (created first). s-other: a terminal `claude` in the same folder 2 s later.
  transcripts.set('s-ui', sessionRecord('claude', 's-ui', { cwd: f.worktree.path, summary: 'From the panel', lastUpdated: new Date(now + 1_000) }));
  transcripts.set('s-other', sessionRecord('claude', 's-other', { cwd: f.worktree.path, summary: 'From a terminal', lastUpdated: new Date(now + 3_000) }));
  // Both are live, unlisted and busy; the live record lists s-other first.
  await service.importLive(['s-other', 's-ui']);
  assert.equal(f.storage.getChat(placeholder.id)?.harnessSessionId, 's-ui', 'the placeholder claims its own (earliest) session, as findClaimableSession over the worktree would');
  assert.equal(f.linkedTo('s-other')?.autoImported, true, 'the other is imported as its own row');
});

test("importLive compares a waiting launch against the worktree's whole listing, not just the sessions asked about", async (t) => {
  const f = setup(t);
  f.service.dispose();
  const now = Date.now();
  const transcripts = new Map<string, HarnessSession>();
  // The panel launch's own session is not live any more (its first turn ended and the tab closed),
  // so it is in the worktree's listing but not asked about.
  const own = sessionRecord('claude', 's-ui', { cwd: f.worktree.path, summary: 'From the panel', lastUpdated: new Date(now + 1_000) });
  let worktreeScans = 0;
  let launched = false;
  const service = new SessionImportService(
    f.storage,
    new WorktreeCatalog(f.storage, {
      listRepositoryWorktrees: () => ({ isGit: true, worktrees: [f.worktree] }),
      listRepositoryWorktreesAsync: async () => ({ isGit: true, worktrees: [f.worktree] }),
    } as never),
    new HarnessRegistry([
      fakeAdapter('claude', {
        listSessionsForWorktree: async () => {
          worktreeScans++;
          return [...(launched ? [own] : []), ...transcripts.values()];
        },
        getSession: async (sessionId: string) => transcripts.get(sessionId) ?? null,
      }),
    ]),
    { scanIntervalMs: 60_000, hotScanIntervalMs: 60_000, isVisible: () => false, readSettings: () => f.settings }
  );
  t.after(() => service.dispose());
  const placeholder = f.chat('New Session', null, { pendingUiLaunch: true });
  await service.expectChat(placeholder.id, f.worktree.path, { bindSurface: false });
  launched = true;
  transcripts.set('s-other', sessionRecord('claude', 's-other', { cwd: f.worktree.path, summary: 'From a terminal', lastUpdated: new Date(now + 3_000) }));
  worktreeScans = 0;
  await service.importLive(['s-other']);
  assert.equal(f.storage.getChat(placeholder.id)?.harnessSessionId, 's-ui', 'the launch claims its own session, as the hot pass would');
  assert.equal(f.linkedTo('s-other')?.autoImported, true);
  assert.equal(worktreeScans, 1, "the waiting launch's worktree was listed once");

  // A CLI chat started in Pitwall without a chosen id waits for its watcher: its session is reserved, not imported.
  const awaiting = f.chat('CLI chat', null);
  f.storage.updateChat(awaiting.id, { createdAt: now + 4_000 });
  transcripts.set('s-cli', sessionRecord('claude', 's-cli', { cwd: f.worktree.path, lastUpdated: new Date(now + 5_000) }));
  assert.deepEqual(await service.importLive(['s-cli']), { retry: [], unplaced: [], unsupported: [] }, 'settled: its watcher links it');
  assert.equal(f.linkedTo('s-cli'), undefined, 'no second row for a session a CLI chat is about to claim');
});

test('importLive reports what it read to onSessionsListed, like a scan (tab adoption titles, closed-row turn state) (QA probe, #73)', async (t) => {
  const f = setup(t);
  f.service.dispose();
  const listed: string[] = [];
  const transcripts = new Map<string, HarnessSession>();
  const service = new SessionImportService(
    f.storage,
    new WorktreeCatalog(f.storage, {
      listRepositoryWorktrees: () => ({ isGit: true, worktrees: [f.worktree] }),
      listRepositoryWorktreesAsync: async () => ({ isGit: true, worktrees: [f.worktree] }),
    } as never),
    new HarnessRegistry([fakeAdapter('claude', { getSession: async (id: string) => transcripts.get(id) ?? null })]),
    { scanIntervalMs: 60_000, hotScanIntervalMs: 60_000, isVisible: () => false, readSettings: () => f.settings, onSessionsListed: (s) => listed.push(...s.map((x) => x.sessionId)) }
  );
  t.after(() => service.dispose());
  transcripts.set('s-new', sessionRecord('claude', 's-new', { cwd: f.worktree.path, summary: 'Night ferry story', lastActivity: Date.now() - 1000 }));
  await service.importLive(['s-new']);
  assert.ok(f.linkedTo('s-new'));
  assert.deepEqual(listed, ['s-new']);
});

test('importLive imports nothing while auto-import is off, and does not ask to be retried', async (t) => {
  const f = setup(t);
  const transcripts = new Map<string, HarnessSession>();
  const { service } = liveImporter(t, f, transcripts);
  f.settings.enabled = false;
  transcripts.set('s-new', sessionRecord('claude', 's-new', { cwd: f.worktree.path, summary: 'Off' }));
  assert.deepEqual(await service.importLive(['s-new']), { retry: [], unplaced: [], unsupported: [] });
  assert.equal(f.linkedTo('s-new'), undefined, 'the setting holds for the live import too');
});

test('importLive names sessions no adapter can read by themselves, so the caller falls back to a full refresh', async (t) => {
  const f = setup(t);
  assert.deepEqual(await f.service.importLive(['s-x']), { retry: [], unplaced: [], unsupported: ['s-x'] });
});
