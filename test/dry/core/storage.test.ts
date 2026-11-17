import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import * as path from 'path';
import { makeStorage, memento, stub, tempDir } from '../support';
import { SessionSearchRecord, STORAGE_KEYS } from '../../../src/core/types';
import { canonicalPath } from '../../../src/core/utils/paths';

test('chats written before multi-harness support migrate on read, once', async () => {
  const globalState = memento();
  await globalState.update(STORAGE_KEYS.CHATS, [
    {
      id: 'legacy',
      worktreeId: 'wt-1',
      name: 'Legacy',
      claudeSessionId: 'legacy-claude-session',
      createdAt: 1,
      lastAccessedAt: 1,
      status: 'idle',
    },
  ]);
  let writes = 0;
  const update = globalState.update;
  globalState.update = async (key, value) => {
    writes++;
    return update(key, value);
  };
  const storage = makeStorage(globalState);

  const [chat] = storage.getChats();
  assert.equal(chat.harness, 'claude');
  assert.equal(chat.harnessSessionId, 'legacy-claude-session');
  assert.ok(!('claudeSessionId' in chat), 'the legacy field is dropped');
  assert.equal(writes, 1, 'the new shape is written back');

  storage.getChats();
  assert.equal(writes, 1, 'an already-migrated list is not rewritten');
});

test('repositories reorder past legacy hidden entries, and re-adding a hidden root shows it', async () => {
  const globalState = memento();
  // Older versions soft-removed a root with `hidden`; the flag is still read.
  await globalState.update(STORAGE_KEYS.REPOSITORIES, [
    { id: 'a', name: 'a', rootPath: '/a' },
    { id: 'h', name: 'hidden', rootPath: '/hidden', hidden: true },
    { id: 'c', name: 'c', rootPath: '/c' },
  ]);
  const storage = makeStorage(globalState);
  const visible = () => storage.getRepositories().map((repo) => repo.name).join(',');

  assert.equal(visible(), 'a,c');
  assert.equal(storage.moveRepository('c', 'down'), false, 'the last root cannot move down');
  assert.equal(storage.moveRepository('c', 'up'), true);
  assert.equal(visible(), 'c,a');
  assert.equal(storage.moveRepository('c', 'up'), false, 'the first root cannot move up');
  assert.equal(storage.moveRepository('missing', 'up'), false);
  assert.deepEqual(
    globalState.get<{ name: string }[]>(STORAGE_KEYS.REPOSITORIES).map((repo) => repo.name),
    ['c', 'hidden', 'a'],
    'the stored array is the tree order, hidden entries in place'
  );

  assert.equal(storage.addRepository('hidden', '/hidden').id, 'h', 'the stored root is reused');
  assert.equal(visible(), 'c,hidden,a');
});

test('terminal PIDs are kept per workspace folder in global state', async () => {
  const globalState = memento();
  const workspaceState = memento();
  const storage = makeStorage(globalState, workspaceState);
  const openFolder = (folder: string) => {
    stub.workspace.workspaceFolders = [{ uri: { fsPath: folder } }];
  };

  openFolder('/workspace/a');
  await storage.rememberTerminalPid('chat-a', 111);
  // Switching folders gives VS Code a fresh workspace store; the record must
  // survive that, but stay scoped to the folder that launched the terminal.
  openFolder('/workspace/b');
  assert.deepEqual(storage.getTerminalPids(), {});
  await storage.rememberTerminalPid('chat-b', 222);
  openFolder('/workspace/a');
  assert.deepEqual(storage.getTerminalPids(), { 'chat-a': 111 });
  assert.equal(workspaceState.get(STORAGE_KEYS.TERMINAL_PIDS), undefined);

  // Development builds stored one workspace's map in workspaceState.
  openFolder('/workspace/legacy');
  await workspaceState.update(STORAGE_KEYS.TERMINAL_PIDS, { 'chat-legacy': 999 });
  assert.deepEqual(storage.getTerminalPids(), { 'chat-legacy': 999 });
  assert.equal(workspaceState.get(STORAGE_KEYS.TERMINAL_PIDS), undefined, 'the legacy record moves');

  storage.deleteChat('chat-a');
  const records = globalState.get<Record<string, Record<string, number>>>(STORAGE_KEYS.TERMINAL_PIDS);
  assert.deepEqual(records['/workspace/a'], {}, 'deleting a chat forgets its PID everywhere');
  assert.deepEqual(records['/workspace/b'], { 'chat-b': 222 });
});

test('a user removal leaves a tombstone; a retention delete and a manual import do not', () => {
  const storage = makeStorage();
  const removed = storage.createChat('wt-1', 'codex', 'Removed', { harnessSessionId: 'thread-1' });
  const expired = storage.createChat('wt-1', 'codex', 'Expired', { harnessSessionId: 'thread-2' });

  storage.deleteChat(removed.id);
  storage.deleteChats([expired.id], { rememberSession: false });
  assert.deepEqual([...storage.getRemovedSessionKeys()], ['codex:thread-1']);

  storage.forgetRemovedSession('codex', 'thread-1');
  assert.equal(storage.getRemovedSessionKeys().size, 0);
});

function searchRecord(id: string, harness: string): SessionSearchRecord {
  return {
    id,
    query: 'q',
    engine: { harness, model: '', effort: '' },
    startedAt: 1,
    state: 'done',
    answer: 'a',
    matches: [],
    activity: [],
  } as SessionSearchRecord;
}

test('saving a search keeps stored searches of a disabled harness', async () => {
  const seed = () => {
    const globalState = memento();
    void globalState.update(STORAGE_KEYS.SESSION_SEARCHES, [searchRecord('codex-search', 'codex')]);
    return globalState;
  };
  const rawIds = (g: ReturnType<typeof memento>) =>
    g.get<{ id: string }[]>(STORAGE_KEYS.SESSION_SEARCHES).map((record) => record.id);

  const g = seed();
  const storage = makeStorage(g, memento(), (id) => id === 'claude');
  await storage.saveSessionSearch(searchRecord('claude-search', 'claude'));
  assert.deepEqual(rawIds(g), ['claude-search', 'codex-search'], 'the codex record is still stored');
  assert.deepEqual(storage.getSessionSearches().map((s) => s.id), ['claude-search'], 'but it is not read');

  const g2 = seed();
  const storage2 = makeStorage(g2, memento(), (id) => id === 'claude');
  await storage2.saveSessionSearch(searchRecord('claude-search', 'claude'));
  await storage2.removeSessionSearches(['claude-search']);
  assert.deepEqual(rawIds(g2), ['codex-search'], 'removing a visible search leaves the hidden one');
});

/**
 * A memento whose whole value a test can replace with an older snapshot, as
 * the editor does when a stale storage echo (`$acceptValue`) lands after a
 * newer write. `saved()` is what the last write would persist: every write
 * saves the whole value, like the editor's extension memento.
 */
function echoingMemento() {
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  let state: Record<string, unknown> = {};
  let saved: Record<string, unknown> = {};
  const snapshots: Record<string, unknown>[] = [];
  return {
    get: <T>(key: string, fallback?: T): T => (key in state ? clone(state[key]) : fallback) as T,
    update: async (key: string, value: unknown): Promise<void> => {
      if (value === undefined) delete state[key];
      else state[key] = clone(value);
      saved = clone(state);
      snapshots.push(clone(state));
    },
    keys: () => Object.keys(state),
    setKeysForSync: () => undefined,
    snapshots,
    saved: () => saved,
    echo: (snapshot: Record<string, unknown>) => {
      state = clone(snapshot);
    },
  };
}

const pidRecords = (value: Record<string, unknown>) =>
  value[STORAGE_KEYS.TERMINAL_PIDS] as Record<string, Record<string, number>>;

test('a stale storage echo cannot drop this window’s PID records or bring back one it removed', async () => {
  stub.workspace.workspaceFolders = [{ uri: { fsPath: '/workspace/echo' } }];
  const globalState = echoingMemento();
  await globalState.update(STORAGE_KEYS.CHATS, [
    { id: 'chat-1', harness: 'claude', worktreeId: 'wt-1', name: 'One', createdAt: 1, lastAccessedAt: 1, status: 'idle' },
  ]);
  // Another window's record, for its own folder.
  await globalState.update(STORAGE_KEYS.TERMINAL_PIDS, { '/workspace/other': { 'chat-x': 900 } });
  const storage = makeStorage(globalState as never);

  await storage.rememberTerminalPid('chat-a', 111);
  await storage.rememberTerminalPid('chat-c', 333);
  const stale = globalState.snapshots.at(-1)!; // knows a and c, not b
  await storage.rememberTerminalPid('chat-b', 222);
  storage.deleteChat('chat-c', { rememberSession: false });

  globalState.echo(stale);
  assert.deepEqual(storage.getTerminalPids(), { 'chat-a': 111, 'chat-b': 222 }, 'reads see this window’s records');

  // The next unrelated write saves the whole value, PID records included.
  storage.updateChat('chat-1', { name: 'Renamed' });
  assert.deepEqual(pidRecords(globalState.saved()), {
    '/workspace/other': { 'chat-x': 900 },
    '/workspace/echo': { 'chat-a': 111, 'chat-b': 222 },
  });
});

test('two windows over one store keep each other’s PID records through a stale echo', async () => {
  const globalState = echoingMemento();
  const inFolder = (folder: string) => {
    stub.workspace.workspaceFolders = [{ uri: { fsPath: folder } }];
  };
  const windowA = makeStorage(globalState as never);
  const windowB = makeStorage(globalState as never);

  inFolder('/workspace/b');
  await windowB.rememberTerminalPid('chat-b', 222);
  const stale = globalState.snapshots.at(-1)!; // B's record, nothing from A
  inFolder('/workspace/a');
  await windowA.rememberTerminalPid('chat-a', 111);
  inFolder('/workspace/b');
  windowB.deleteChat('chat-b', { rememberSession: false });

  globalState.echo(stale);
  inFolder('/workspace/a');
  assert.deepEqual(windowA.getTerminalPids(), { 'chat-a': 111 });
  inFolder('/workspace/b');
  assert.deepEqual(windowB.getTerminalPids(), {}, 'B’s removal stays removed in B');

  // Each window writes again; neither restores the other's removal nor
  // drops the other's record.
  inFolder('/workspace/a');
  await windowA.rememberTerminalPid('chat-a2', 112);
  assert.deepEqual(pidRecords(globalState.saved())['/workspace/a'], { 'chat-a': 111, 'chat-a2': 112 });
  inFolder('/workspace/b');
  await windowB.rememberTerminalPid('chat-b2', 223);
  assert.deepEqual(pidRecords(globalState.saved()), {
    '/workspace/a': { 'chat-a': 111, 'chat-a2': 112 },
    '/workspace/b': { 'chat-b2': 223 },
  });
});

// Row 3.0 (F3): every collection gets the PID records' stale-echo guard.

/** What the last write would persist for one key. */
const savedAt = <T>(g: ReturnType<typeof echoingMemento>, key: string): T => g.saved()[key] as T;
const names = (records: { name: string }[] | undefined) => (records ?? []).map((record) => record.name);

test("a stale storage echo cannot drop or revive this window's repositories writes", async () => {
  const globalState = echoingMemento();
  const storage = makeStorage(globalState as never);

  storage.addRepository('a', '/repos/a');
  const gone = storage.addRepository('gone', '/repos/gone');
  const stale = globalState.snapshots.at(-1)!; // knows a and gone, not b
  storage.addRepository('b', '/repos/b');
  storage.removeRepository(gone.id);

  globalState.echo(stale);
  assert.deepEqual(names(storage.getRepositories()), ['a', 'b'], 'reads see this window’s add and removal');

  // The next unrelated write saves the whole value, repositories included.
  storage.setActiveChatId('chat-x');
  assert.deepEqual(names(savedAt(globalState, STORAGE_KEYS.REPOSITORIES)), ['a', 'b']);
});

test("a stale storage echo cannot drop or revive this window's chats writes", async () => {
  const globalState = echoingMemento();
  const storage = makeStorage(globalState as never);

  const kept = storage.createChat('wt-1', 'claude', 'Kept');
  const gone = storage.createChat('wt-1', 'claude', 'Gone');
  const stale = globalState.snapshots.at(-1)!; // knows Kept and Gone, not New
  storage.createChat('wt-1', 'claude', 'New');
  storage.updateChat(kept.id, { name: 'Renamed', customName: true });
  storage.deleteChat(gone.id, { rememberSession: false });

  globalState.echo(stale);
  assert.deepEqual(names(storage.getChats()), ['Renamed', 'New']);

  storage.setActiveChatId('chat-x');
  assert.deepEqual(names(savedAt(globalState, STORAGE_KEYS.CHATS)), ['Renamed', 'New']);
});

test("a stale storage echo cannot drop or revive this window's starredChats writes", async () => {
  const globalState = echoingMemento();
  const storage = makeStorage(globalState as never);

  storage.toggleStar('chat-1');
  storage.toggleStar('chat-2');
  const stale = globalState.snapshots.at(-1)!; // 1 and 2 starred, 3 not
  storage.toggleStar('chat-3');
  storage.toggleStar('chat-2'); // unstar

  globalState.echo(stale);
  assert.deepEqual([...storage.getStarredChatIds()].sort(), ['chat-1', 'chat-3']);

  storage.setActiveChatId('chat-x');
  assert.deepEqual(savedAt<string[]>(globalState, STORAGE_KEYS.STARRED_CHATS).sort(), ['chat-1', 'chat-3']);
});

test("a stale storage echo cannot drop or revive this window's removedSessions writes", async () => {
  const globalState = echoingMemento();
  const storage = makeStorage(globalState as never);

  storage.rememberRemovedSession('claude', 's-1');
  storage.rememberRemovedSession('claude', 's-2');
  const stale = globalState.snapshots.at(-1)!; // s-1 and s-2, not s-3
  storage.rememberRemovedSession('claude', 's-3');
  storage.forgetRemovedSession('claude', 's-2');

  globalState.echo(stale);
  assert.deepEqual([...storage.getRemovedSessionKeys()].sort(), ['claude:s-1', 'claude:s-3']);

  storage.setActiveChatId('chat-x');
  assert.deepEqual(
    savedAt<{ key: string }[]>(globalState, STORAGE_KEYS.REMOVED_SESSIONS).map((record) => record.key).sort(),
    ['claude:s-1', 'claude:s-3']
  );
});

test("a stale storage echo cannot drop or revive this window's sessionSearches writes", async () => {
  const globalState = echoingMemento();
  const storage = makeStorage(globalState as never);

  await storage.saveSessionSearch(searchRecord('search-1', 'claude'));
  await storage.saveSessionSearch(searchRecord('search-2', 'claude'));
  const stale = globalState.snapshots.at(-1)!; // 2 and 1, not 3
  await storage.saveSessionSearch(searchRecord('search-3', 'claude'));
  await storage.removeSessionSearches(['search-2']);

  globalState.echo(stale);
  assert.deepEqual(storage.getSessionSearches().map((search) => search.id), ['search-3', 'search-1']);

  storage.setActiveChatId('chat-x');
  assert.deepEqual(
    savedAt<{ id: string }[]>(globalState, STORAGE_KEYS.SESSION_SEARCHES).map((search) => search.id),
    ['search-3', 'search-1']
  );
});

test("a stale storage echo cannot drop or revive this window's dismissedRepos writes", async () => {
  const globalState = echoingMemento();
  const storage = makeStorage(globalState as never);

  await storage.setDismissed('/repos/one', 100);
  await storage.setDismissed('/repos/two', 200);
  const stale = globalState.snapshots.at(-1)!; // one and two, not three
  await storage.setDismissed('/repos/three', 300);
  await storage.setDismissed('/repos/two', null);

  globalState.echo(stale);
  assert.deepEqual(storage.getDismissedRepos(), { '/repos/one': 100, '/repos/three': 300 });

  storage.setActiveChatId('chat-x');
  assert.deepEqual(savedAt(globalState, STORAGE_KEYS.DISMISSED_REPOS), { '/repos/one': 100, '/repos/three': 300 });
  assert.equal(STORAGE_KEYS.DISMISSED_REPOS, 'pitwall.dismissedRepos');
});

test('two windows over one store keep each other’s chat edits through a stale echo', async () => {
  const globalState = echoingMemento();
  await globalState.update(STORAGE_KEYS.CHATS, [
    { id: 'chat-1', harness: 'claude', harnessSessionId: null, worktreeId: 'wt-1', name: 'One', createdAt: 1, lastAccessedAt: 1, seenAt: 1, status: 'idle' },
  ]);
  const windowA = makeStorage(globalState as never);
  const windowB = makeStorage(globalState as never);
  const stale = globalState.snapshots.at(-1)!; // neither edit

  windowA.toggleStar('chat-1');
  windowA.touchChat('chat-1'); // A also opens it: a different field of the same record
  windowB.updateChat('chat-1', { name: 'Renamed', customName: true });

  globalState.echo(stale);
  assert.ok(windowA.isStarred('chat-1'), 'A still sees its star');
  assert.ok(windowA.getChat('chat-1')!.lastAccessedAt > 1, 'A still sees its open');
  assert.equal(windowB.getChat('chat-1')!.name, 'Renamed', 'B still sees its rename');

  // Each window writes again; neither drops the other's edit.
  windowA.setActiveChatId('chat-1');
  windowB.setActiveChatId('chat-1');
  windowA.setActiveChatId('chat-1');
  const [saved] = savedAt<{ name: string; lastAccessedAt: number }[]>(globalState, STORAGE_KEYS.CHATS);
  assert.equal(saved.name, 'Renamed');
  assert.ok(saved.lastAccessedAt > 1);
  assert.deepEqual(savedAt(globalState, STORAGE_KEYS.STARRED_CHATS), ['chat-1']);
  assert.equal(windowA.getChat('chat-1')!.name, 'Renamed', 'A sees B’s rename');
  assert.ok(windowB.isStarred('chat-1'), 'B sees A’s star');
});

test('two StorageService instances adding the same root through a stale echo keep one repository', async (t) => {
  const root = tempDir(t);
  const canonical = canonicalPath(root);
  const expectedId = `repo-${createHash('sha1')
    .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
    .digest('hex')
    .slice(0, 12)}`;

  // Discovered: both windows derive the same id (P17).
  {
    const globalState = echoingMemento();
    const windowA = makeStorage(globalState as never);
    const windowB = makeStorage(globalState as never);
    const a = windowA.addRepository('repo', root, { origin: 'discovered' });
    globalState.echo({}); // B never saw A's add
    const otherSpelling = process.platform === 'win32' ? root.toUpperCase() : root;
    const b = windowB.addRepository('repo', otherSpelling, { origin: 'discovered' });
    assert.equal(a.id, expectedId);
    assert.equal(b.id, expectedId);
    assert.equal(a.origin, 'discovered');
    windowA.setActiveChatId('x');
    windowB.setActiveChatId('x');
    assert.equal(savedAt<unknown[]>(globalState, STORAGE_KEYS.REPOSITORIES).length, 1);
    assert.equal(windowA.getRepositories().length, 1);
    assert.equal(windowB.getRepositories().length, 1);
  }

  // Manual: random ids, so the merge dedupes by samePath and keeps the oldest.
  {
    const globalState = echoingMemento();
    const windowA = makeStorage(globalState as never);
    const windowB = makeStorage(globalState as never);
    const a = windowA.addRepository('repo', root);
    assert.equal(windowA.addRepository('repo', root + path.sep).id, a.id, 'another spelling of the root is the same repo');
    globalState.echo({});
    await new Promise((resolve) => setTimeout(resolve, 5)); // B's add is strictly newer
    const b = windowB.addRepository('repo', root);
    assert.notEqual(a.id, b.id);
    assert.deepEqual(windowA.getRepositories().map((repo) => repo.id), [a.id], 'A keeps its own, older record');
    windowA.setActiveChatId('x');
    windowB.setActiveChatId('x');
    windowA.setActiveChatId('x');
    assert.deepEqual(savedAt<{ id: string }[]>(globalState, STORAGE_KEYS.REPOSITORIES).map((repo) => repo.id), [a.id]);
    assert.deepEqual(windowB.getRepositories().map((repo) => repo.id), [a.id], 'B converges on the oldest record');
  }
});

test('a chat created or loaded without seenAt gets a baseline', async () => {
  const globalState = memento();
  await globalState.update(STORAGE_KEYS.CHATS, [
    { id: 'old', harness: 'claude', harnessSessionId: 's-old', worktreeId: 'wt-1', name: 'Old', createdAt: 1, lastAccessedAt: 1, status: 'idle' },
  ]);
  const storage = makeStorage(globalState);

  const before = Date.now();
  const loaded = storage.getChat('old')!;
  assert.ok(loaded.seenAt! >= before, 'a record loaded without seenAt gets the first-load time');
  const stored = globalState.get<{ id: string; seenAt?: number }[]>(STORAGE_KEYS.CHATS);
  assert.equal(stored[0].seenAt, loaded.seenAt, 'the baseline is written back');
  assert.equal(storage.getChat('old')!.seenAt, loaded.seenAt, 'a later load keeps it');

  const created = storage.createChat('wt-1', 'claude', 'New');
  assert.equal(created.seenAt, created.createdAt, 'a new chat is seen when created');

  await storage.markChatSeen('old', loaded.seenAt! + 1000);
  assert.equal(storage.getChat('old')!.seenAt, loaded.seenAt! + 1000);
});
