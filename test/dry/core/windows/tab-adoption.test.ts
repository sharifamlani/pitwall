/**
 * Tab adoption wiring (T8, live I1): which sessions a window's restored
 * Claude tabs are matched against. Only this window's folder's sessions,
 * by their agent title (the tab's title) or their row name, once the
 * folder's listing has landed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { claudeUiSurfaces } from '../../../../src/harnesses/claude/claudeUi';
import { startTabAdoption } from '../../../../src/core/windows/tabAdoption';
import type { ChatSession } from '../../../../src/core/types';
import type { HarnessSession } from '../../../../src/core/harness/types';
import { ClaudeHarness } from '../../../../src/harnesses/claude/ClaudeHarness';
import { claudeProfile, entry } from '../../harnesses/claude/claudeFixture';
import { HarnessRegistry } from '../../../../src/core/harness/HarnessRegistry';
import { SessionImportService } from '../../../../src/core/services/SessionImportService';
import { WorktreeCatalog } from '../../../../src/core/services/WorktreeCatalog';
import { UNBOUND_FRONT_MAX_MS, unboundTabMayBeChat } from '../../../../src/core/services/chatVisibility';
import { fakeAdapter, makeStorage, sessionRecord, worktreeRecord } from '../../support';

const LAB_C = 'C:\\lab\\uj-lab-c';
const LAB_C_WT = 'C:\\lab\\uj-lab-c-wt';

/** Restored tabs, already in their group when the tracker starts (no open event). */
function restoredWindow(titles: string[]) {
  const tabs = titles.map((label) => ({ label, input: new vscode.TabInputWebview('mainThreadWebview-claudeVSCodePanel'), isActive: false }));
  const groups = [{ isActive: true, activeTab: tabs[tabs.length - 1], tabs }];
  const surfaces = claudeUiSurfaces({
    getTabGroups: () => groups as never,
    onDidChangeTabs: () => ({ dispose: () => undefined }),
    onDidChangeTabGroups: () => ({ dispose: () => undefined }),
    log: () => undefined,
  } as never);
  const bound = () => surfaces.describeTabs()[0].tabs.map((tab) => tab.sessionId);
  return { surfaces, bound };
}

const session = (sessionId: string, summary: string, cwd = LAB_C): HarnessSession =>
  ({ harness: 'claude', sessionId, cwd, summary, gitBranch: null, lastUpdated: null, lastActivity: null, messageCount: 1 }) as HarnessSession;

const chat = (harnessSessionId: string, name: string, worktreeId = 'wt-main'): ChatSession =>
  ({ id: `chat-${harnessSessionId}`, harness: 'claude', harnessSessionId, name, worktreeId }) as ChatSession;

test("a window's restored tabs bind to its folder's sessions by agent title once the listing lands (GT, R1)", async () => {
  const { surfaces, bound } = restoredWindow(['Lab C one', 'Lab C two']);
  let land: (sessions: HarnessSession[]) => void = () => undefined;
  const listing = new Promise<HarnessSession[]>((resolve) => (land = resolve));
  const adoption = startTabAdoption({
    folder: LAB_C,
    adapters: [{ id: 'claude', nativeUi: { surfaces } as never, listSessionsForWorktree: () => listing }],
    // The rows carry the first prompt, not Claude's title.
    chats: () => [chat('095a88d2', 'reply with exactly: lab c one'), chat('23c80023', 'reply with exactly: lab c two')],
    worktreePathOf: () => LAB_C,
  });
  assert.deepEqual(bound(), [undefined, undefined], 'nothing before the listing lands');
  land([session('095a88d2', 'Lab C one'), session('23c80023', 'Lab C two')]);
  await surfaces.adoptBeforeOpen(1_000);
  assert.deepEqual(bound(), ['095a88d2', '23c80023']);
  adoption.dispose();
  surfaces.dispose();
});

test("a panel tab titled with the session's custom title (the user's /rename in Claude) binds to that session (v0.6.0)", async (t) => {
  // Session b3778905: tab "Main" (its custom title), aiTitle and row name "Pitwall initial idea".
  const profile = claudeProfile(t);
  const folder = profile.dir('pitwall');
  const id = 'b3778905-8f98-43f8-94de-35553b9f2d2b';
  profile.write(id, folder, [entry.user('hi'), entry.aiTitle('Pitwall initial idea'), entry.customTitle('Main')]);
  const harness = new ClaudeHarness();
  const { surfaces, bound } = restoredWindow(['Main']);
  const adoption = startTabAdoption({
    folder,
    adapters: [{ id: 'claude', nativeUi: { surfaces } as never, listSessionsForWorktree: (target) => harness.listSessionsForWorktree(target) }],
    chats: () => [chat(id, 'Pitwall initial idea')],
    worktreePathOf: () => folder,
  });
  await surfaces.adoptBeforeOpen(1_000);
  assert.deepEqual(bound(), [id], 'the tab binds, so a click focuses it instead of reaching the live-process guard');
  adoption.dispose();
  surfaces.dispose();
});

test("another folder's session (a worktree's) with the same title is no candidate, and a title two of this folder's sessions share binds nothing (E5)", async () => {
  const { surfaces, bound } = restoredWindow(['E10b live', 'Claude in Chrome browser…']);
  const adoption = startTabAdoption({
    folder: LAB_C,
    adapters: [
      {
        id: 'claude',
        nativeUi: { surfaces } as never,
        listSessionsForWorktree: async () => [
          session('main-live', 'E10b live'),
          session('chrome-1', 'Claude in Chrome browser automation'),
          session('chrome-2', 'Claude in Chrome browser automation'),
        ],
      },
    ],
    chats: () => [chat('wt-live', 'E10b live', 'wt-wt')],
    worktreePathOf: (row) => (row.worktreeId === 'wt-wt' ? LAB_C_WT : LAB_C),
  });
  await surfaces.adoptBeforeOpen(1_000);
  assert.deepEqual(bound(), ['main-live', undefined], "the worktree's chat is not this window's; the shared title stays unknown");
  adoption.dispose();
  surfaces.dispose();
});

test('a title a later scan reports adopts its tab then', async () => {
  const { surfaces, bound } = restoredWindow(['Plus b']);
  const listed = new vscode.EventEmitter<HarnessSession[]>();
  const adoption = startTabAdoption({
    folder: LAB_C,
    adapters: [{ id: 'claude', nativeUi: { surfaces } as never, listSessionsForWorktree: async () => [] }],
    chats: () => [],
    worktreePathOf: () => undefined,
    onSessionsListed: listed.event,
  });
  await surfaces.adoptBeforeOpen(1_000);
  assert.deepEqual(bound(), [undefined]);
  listed.fire([session('27b31ca7', 'Plus b', LAB_C_WT)]);
  assert.deepEqual(bound(), [undefined], 'a session of another folder is ignored');
  listed.fire([session('27b31ca7', 'Plus b')]);
  assert.deepEqual(bound(), ['27b31ca7']);
  adoption.dispose();
  surfaces.dispose();
});

test('an empty window adopts nothing and lists nothing', () => {
  let listed = 0;
  const { surfaces } = restoredWindow(['Lab C one']);
  startTabAdoption({
    folder: undefined,
    adapters: [{ id: 'claude', nativeUi: { surfaces } as never, listSessionsForWorktree: async () => (listed++, []) }],
    chats: () => [],
    worktreePathOf: () => undefined,
  }).dispose();
  assert.equal(listed, 0);
  surfaces.dispose();
});

test("a brand-new chat's tab binds once importLive reads its session (QA on #73)", async (t) => {
  const { surfaces, bound } = restoredWindow(['Night ferry story']);
  const storage = makeStorage();
  const repo = storage.addRepository('uj-lab-c', LAB_C);
  const worktree = worktreeRecord({ id: 'wt-c', repoId: repo.id, path: LAB_C });
  const listed = new vscode.EventEmitter<HarnessSession[]>();
  const transcript = sessionRecord('claude', '12f645db', { cwd: LAB_C, summary: 'Night ferry story', lastActivity: Date.now() - 1_000 });
  const adapter = fakeAdapter('claude', {
    nativeUi: { surfaces } as never,
    getSession: async (sessionId: string) => (sessionId === '12f645db' ? transcript : null),
  });
  const importer = new SessionImportService(
    storage,
    new WorktreeCatalog(storage, {
      listRepositoryWorktrees: () => ({ isGit: true, worktrees: [worktree] }),
      listRepositoryWorktreesAsync: async () => ({ isGit: true, worktrees: [worktree] }),
    } as never),
    new HarnessRegistry([adapter]),
    { isVisible: () => false, onSessionsListed: (sessions) => listed.fire(sessions), readSettings: () => ({ enabled: true, retentionDays: 7 }) }
  );
  t.after(() => importer.dispose());
  const adoption = startTabAdoption({
    folder: LAB_C,
    adapters: [{ id: 'claude', nativeUi: { surfaces } as never, listSessionsForWorktree: async () => [] }],
    chats: () => storage.getChats(),
    worktreePathOf: (chat) => (chat.worktreeId === worktree.id ? LAB_C : undefined),
    onSessionsListed: listed.event,
  });
  await surfaces.adoptBeforeOpen(1_000);
  assert.deepEqual(bound(), [undefined], 'the tab is in front, bound to nothing');

  await importer.importLive(['12f645db']);
  const chat = storage.getChats().find((entry) => entry.harnessSessionId === '12f645db')!;
  assert.ok(chat, 'listed');
  assert.deepEqual(bound(), ['12f645db'], 'the tab binds to it at once');
  assert.equal(surfaces.activeUnboundTabOpenedAt(), undefined, 'bound: no unbound tab in front');
  assert.equal(
    unboundTabMayBeChat(chat, { adapters: () => [adapter], chats: () => [chat], worktreePathOf: () => LAB_C, folders: () => [LAB_C], isOpenAnywhere: () => false }),
    false,
    'bound: the ordinary front check takes over'
  );
  adoption.dispose();
  surfaces.dispose();
});

// ---------------------------------------------------------------------------
// The unbound-tab front heuristic (QA round 2 on #73): an unbound tab the
// user opened stands for one chat only, a chat with no open surface anywhere
// that started after the tab opened, and only while exactly one chat fits.
// ---------------------------------------------------------------------------

/** A window whose Claude tabs the real tracker watches: `restored` were there before it started; `open` is a tab opening now. */
function liveWindow(restored: string[] = []) {
  const tabOf = (label: string) => ({ label, input: new vscode.TabInputWebview('mainThreadWebview-claudeVSCodePanel'), isActive: false });
  const group = { isActive: true, viewColumn: 1, activeTab: undefined as unknown, tabs: restored.map(tabOf) as unknown[] };
  group.activeTab = group.tabs[group.tabs.length - 1];
  let fire: (event: vscode.TabChangeEvent) => void = () => undefined;
  const surfaces = claudeUiSurfaces({
    getTabGroups: () => [group] as never,
    onDidChangeTabs: (listener) => ((fire = listener), { dispose: () => undefined }),
    onDidChangeTabGroups: () => ({ dispose: () => undefined }),
    log: () => undefined,
  });
  return {
    surfaces,
    open(label: string) {
      const tab = tabOf(label);
      group.tabs.push(tab);
      group.activeTab = tab;
      fire({ opened: [tab], closed: [], changed: [] } as never);
      return tab;
    },
    show(tab: unknown) {
      group.activeTab = tab;
      fire({ opened: [], closed: [], changed: [tab] } as never);
    },
  };
}

const HOUR = 60 * 60_000;
const listedChat = (harnessSessionId: string, createdAt: number, worktreeId = 'wt-c'): ChatSession =>
  ({ id: `chat-${harnessSessionId}`, harness: 'claude', harnessSessionId, name: harnessSessionId, worktreeId, createdAt, lastAccessedAt: createdAt }) as ChatSession;

/**
 * The heuristic's inputs over one window: every chat listed, `open` the chats with a surface anywhere,
 * `panel` whether the live record says the Claude panel runs a session (default: every one).
 */
function frontDeps(
  window: ReturnType<typeof liveWindow>,
  chats: () => ChatSession[],
  open: Set<string> = new Set(),
  now?: () => number,
  panel: (sessionId: string) => boolean | undefined = () => true
) {
  return {
    adapters: () => [{ id: 'claude', nativeUi: { surfaces: window.surfaces }, isPanelSession: panel } as never],
    chats,
    worktreePathOf: (chat: ChatSession) => (chat.worktreeId === 'wt-c' ? LAB_C : LAB_C_WT),
    folders: () => [LAB_C],
    isOpenAnywhere: (chat: ChatSession) => open.has(chat.id) || window.surfaces.isOpen(chat.harnessSessionId!),
    ...(now ? { now } : {}),
  };
}

test('an unbound tab the user opened stands for the one chat of this folder that started after it, with no open surface', (t) => {
  const window = liveWindow();
  t.after(() => window.surfaces.dispose());
  window.open('Claude Code');
  const fresh = listedChat('s-new', Date.now());
  const chats = [fresh];
  assert.equal(unboundTabMayBeChat(fresh, frontDeps(window, () => chats)), true, 'the new chat being watched');
  assert.equal(unboundTabMayBeChat({ ...fresh, harness: 'codex' } as ChatSession, frontDeps(window, () => chats)), false, "another harness's chat");
  const elsewhere = listedChat('s-wt', Date.now(), 'wt-other');
  assert.equal(unboundTabMayBeChat(elsewhere, frontDeps(window, () => [fresh, elsewhere])), false, "another folder's chat");
});

test('an unbound tab never stands for a chat that started before it opened (an hour-old chat, open or not)', (t) => {
  const window = liveWindow();
  t.after(() => window.surfaces.dispose());
  const old = listedChat('s-old', Date.now() - HOUR);
  window.open('Claude Code');
  const chats = [old];
  assert.equal(unboundTabMayBeChat(old, frontDeps(window, () => chats)), false, 'no surface (an outside terminal): older than the tab');
  assert.equal(unboundTabMayBeChat(old, frontDeps(window, () => chats, new Set([old.id]))), false, 'in a Pitwall terminal: it has its own surface');
});

test('a chat with an open surface anywhere is never the unbound tab, and leaves the one chat that fits (R4)', (t) => {
  const window = liveWindow();
  t.after(() => window.surfaces.dispose());
  const unboundTab = window.open('Claude Code');
  const bound = listedChat('s-bound', Date.now());
  window.surfaces.expect('s-bound', 'Bound chat');
  window.open('Bound chat');
  assert.equal(window.surfaces.isOpen('s-bound'), true, 'its own tab bound');
  window.show(unboundTab);
  assert.notEqual(window.surfaces.activeUnboundTabOpenedAt(), undefined, 'the unbound tab is in front again');
  const terminal = listedChat('s-term', Date.now());
  const otherWindow = listedChat('s-other', Date.now());
  const fresh = listedChat('s-new', Date.now());
  const chats = [bound, terminal, otherWindow, fresh];
  const deps = frontDeps(window, () => chats, new Set([terminal.id, otherWindow.id]));
  assert.equal(unboundTabMayBeChat(bound, deps), false, 'a chat with a bound tab here');
  assert.equal(unboundTabMayBeChat(terminal, deps), false, 'a chat in a terminal');
  assert.equal(unboundTabMayBeChat(otherWindow, deps), false, "a chat open in another window (the registry's openSessionIds)");
  assert.equal(unboundTabMayBeChat(fresh, deps), true, 'the one chat that fits');
});

test('two chats that fit: the unbound tab stands for neither', (t) => {
  const window = liveWindow();
  t.after(() => window.surfaces.dispose());
  window.open('Claude Code');
  const chats = [listedChat('s-one', Date.now()), listedChat('s-two', Date.now())];
  for (const chat of chats) {
    assert.equal(unboundTabMayBeChat(chat, frontDeps(window, () => chats)), false, chat.harnessSessionId!);
  }
});

test('a restored unbound tab (no open time) never stands for any chat', (t) => {
  const window = liveWindow(['Claude Code']);
  t.after(() => window.surfaces.dispose());
  assert.equal(window.surfaces.activeUnboundTabOpenedAt(), undefined);
  const fresh = listedChat('s-new', Date.now());
  assert.equal(unboundTabMayBeChat(fresh, frontDeps(window, () => [fresh])), false);
});

test('an unbound tab stands for its chat for a bounded time only (UNBOUND_FRONT_MAX_MS)', (t) => {
  const window = liveWindow();
  t.after(() => window.surfaces.dispose());
  window.open('Claude Code');
  // The tab's own open time, as the surface service stamped it. A Date.now() read before open() can be
  // a millisecond earlier than that stamp on a slow tick, and the chat would then have "started before
  // the tab" (main CI 44682589278).
  const openedAt = window.surfaces.activeUnboundTabOpenedAt();
  assert.ok(openedAt !== undefined, 'the tab the user just opened has an open time');
  const fresh = listedChat('s-new', openedAt);
  const at = (now: number) => frontDeps(window, () => [fresh], new Set(), () => now);
  assert.equal(unboundTabMayBeChat(fresh, at(openedAt + UNBOUND_FRONT_MAX_MS)), true);
  assert.equal(unboundTabMayBeChat(fresh, at(openedAt + UNBOUND_FRONT_MAX_MS + 1_000)), false, 'a tab left unbound that long holds no new chat');
});

test("an unbound tab stands only for a chat the Claude panel runs: never an outside terminal's, nor one the record says nothing of (QA #73 round 3, G1)", (t) => {
  const window = liveWindow();
  t.after(() => window.surfaces.dispose());
  window.open('Claude Code');
  const fresh = listedChat('s-new', Date.now());
  const entrypoints: Record<string, boolean | undefined> = { 's-new': false };
  const deps = frontDeps(window, () => [fresh], new Set(), undefined, (id) => entrypoints[id]);
  assert.equal(unboundTabMayBeChat(fresh, deps), false, '`claude` in an outside terminal (entrypoint cli)');
  entrypoints['s-new'] = undefined;
  assert.equal(unboundTabMayBeChat(fresh, deps), false, 'not in the live record, or it does not say: unknown never fits');
  entrypoints['s-new'] = true;
  assert.equal(unboundTabMayBeChat(fresh, deps), true, 'a panel chat (entrypoint claude-vscode)');
  const noRead = frontDeps(window, () => [fresh]);
  noRead.adapters = () => [{ id: 'claude', nativeUi: { surfaces: window.surfaces } } as never];
  assert.equal(unboundTabMayBeChat(fresh, noRead), false, 'a harness with no live record never fits');

  // A terminal chat does not count as a candidate either: the panel chat beside it is still the one.
  const outside = listedChat('s-cli', Date.now());
  const both = frontDeps(window, () => [fresh, outside], new Set(), undefined, (id) => id === 's-new');
  assert.equal(unboundTabMayBeChat(fresh, both), true, 'the panel chat, beside an outside terminal chat');
  assert.equal(unboundTabMayBeChat(outside, both), false, 'the outside terminal chat');
});

test('a chat started after the tab opened counts by the earlier of its stamps: a row made after the tab with activity before it never fits', (t) => {
  const window = liveWindow();
  t.after(() => window.surfaces.dispose());
  window.open('Claude Code');
  const openedAt = window.surfaces.activeUnboundTabOpenedAt();
  assert.ok(openedAt !== undefined, 'the tab the user just opened has an open time');
  const at = () => openedAt + 1_000;
  // Listed after the tab opened (createdAt), but its session was active before it (lastAccessedAt).
  const listedLate = { ...listedChat('s-late', openedAt + 500), lastAccessedAt: openedAt - 60_000 } as ChatSession;
  assert.equal(unboundTabMayBeChat(listedLate, frontDeps(window, () => [listedLate], new Set(), at)), false, 'activity before the tab');
  const activeLate = { ...listedChat('s-late', openedAt - 60_000), lastAccessedAt: openedAt + 500 } as ChatSession;
  assert.equal(unboundTabMayBeChat(activeLate, frontDeps(window, () => [activeLate], new Set(), at)), false, 'row made before the tab');
});
