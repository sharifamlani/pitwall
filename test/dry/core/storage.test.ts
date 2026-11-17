import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage, memento, stub } from '../support';
import { SessionSearchRecord, STORAGE_KEYS } from '../../../src/core/types';

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
