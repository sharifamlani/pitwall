import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { makeStorage, memento, stub, tempDir } from '../support';
import { StorageService } from '../../../src/core/services/StorageService';
import { SessionSearchRecord, STORAGE_KEYS } from '../../../src/core/types';
import { canonicalPath } from '../../../src/core/utils/paths';
import { RecordOverlay, StampClock, Stamped } from '../../../src/core/services/storageOverlay';

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

test('chats stored twice under one id collapse to one row, keeping the newest fields', async () => {
  // What createChat left before the fix: the chat twice. Every later update
  // rewrote the first copy, so the second is the stale one.
  const globalState = memento();
  const fresh = { id: 'c1', worktreeId: 'wt-1', name: 'Renamed', harness: 'claude', harnessSessionId: 's1', createdAt: 1, lastAccessedAt: 300, seenAt: 200, status: 'idle' };
  const stale = { ...fresh, name: 'Session', harnessSessionId: null, lastAccessedAt: 1, seenAt: 1 };
  const other = { ...fresh, id: 'c2', name: 'Other', harnessSessionId: 's2' };
  await globalState.update(STORAGE_KEYS.CHATS, [fresh, stale, other]);
  let writes = 0;
  const update = globalState.update;
  globalState.update = async (key: string, value: unknown) => {
    writes++;
    return update(key, value);
  };
  const storage = makeStorage(globalState);

  assert.deepEqual(storage.getChats(), [fresh, other], 'one row per id, the newest copy');
  assert.equal(writes, 0, 'reading alone writes nothing');

  storage.updateChat('c2', { name: 'Other renamed' });
  await new Promise((resolve) => setImmediate(resolve));
  const stored = globalState.get<{ id: string; name: string }[]>(STORAGE_KEYS.CHATS, []);
  assert.deepEqual(stored.map((chat) => [chat.id, chat.name]), [['c1', 'Renamed'], ['c2', 'Other renamed']], 'the next write persists the clean list');
  assert.deepEqual(makeStorage(globalState).getChats().find((chat) => chat.id === 'c1'), fresh);
});

test('a created chat is stored once, so a reload lists it once', async () => {
  const globalState = memento();
  const storage = makeStorage(globalState);
  const chat = storage.createChat('wt-1', 'claude', 'Session');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    globalState.get<{ id: string }[]>(STORAGE_KEYS.CHATS, []).map((stored) => stored.id),
    [chat.id],
    'one stored record'
  );
  assert.deepEqual(makeStorage(globalState).getChats().map((reloaded) => reloaded.id), [chat.id], 'one row after a reload');
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

test('one harness session stored under two chat ids reads as one row in every window, and the store converges on it', async () => {
  const globalState = echoingMemento();
  const windowA = makeStorage(globalState as never);
  const windowB = makeStorage(globalState as never);
  // Two windows imported the session before either saw the other's import (random ids, before the fix).
  const a = windowA.createChat('wt-1', 'claude', 'CLI chat', { harnessSessionId: 's-cli', autoImported: true, createdAt: 1_000 });
  globalState.echo({});
  const b = windowB.createChat('wt-1', 'claude', 'CLI chat', { harnessSessionId: 's-cli', autoImported: true, createdAt: 1_000 });
  // A user's own chat of another session is never touched.
  windowB.createChat('wt-1', 'claude', 'Other', { harnessSessionId: 's-other' });
  assert.notEqual(a.id, b.id);

  const rows = (storage: StorageService) => storage.getChats().filter((chat) => chat.harnessSessionId === 's-cli');
  const winner = [a.id, b.id].sort()[0];
  assert.deepEqual(rows(windowA).map((chat) => chat.id), [winner], 'A shows one row');
  windowA.setActiveChatId('x');
  windowB.setActiveChatId('x');
  windowA.setActiveChatId('x');
  assert.deepEqual(rows(windowB).map((chat) => chat.id), [winner], 'B shows the same row');
  assert.deepEqual(
    savedAt<{ id: string }[]>(globalState, STORAGE_KEYS.CHATS).map((chat) => chat.id).sort(),
    [a.id, b.id, windowB.getChats().find((chat) => chat.name === 'Other')!.id].sort(),
    'the hidden copy stays in the store (nothing irreversible)'
  );

  // A user-started chat of the session wins over an import of it, whatever its age.
  const own = windowA.createChat('wt-1', 'claude', 'Mine', { harnessSessionId: 's-cli', createdAt: 5_000 });
  assert.deepEqual(rows(windowA).map((chat) => chat.id), [own.id]);
});

// PR #64 round 2 (QA): the dedupe picks the row by user state, merges the
// loser's state into it, and never deletes the loser.

type TwinChat = { id: string; name: string; customName?: boolean; seenAt?: number; lastAccessedAt: number; mergedInto?: string };
const SESSION_DUP = 's-dup';
/** The session imported twice (createdAt 1000 and 2000); `extra` is the store's other keys. */
async function twinStore(newer: Partial<TwinChat>, extra: Record<string, unknown> = {}, older: Partial<TwinChat> = {}) {
  const globalState = echoingMemento();
  const twin = (id: string, createdAt: number, fields: Partial<TwinChat>) => ({
    id, harness: 'claude', harnessSessionId: SESSION_DUP, worktreeId: 'wt-1', name: 'CLI chat',
    createdAt, lastAccessedAt: createdAt, seenAt: createdAt, status: 'idle', autoImported: true, ...fields,
  });
  await globalState.update(STORAGE_KEYS.CHATS, [twin('chat-old', 1_000, older), twin('chat-new', 2_000, newer)]);
  for (const [key, value] of Object.entries(extra)) {
    await globalState.update(key, value);
  }
  const logs: string[] = [];
  const window = () =>
    new StorageService({ globalState, workspaceState: memento() } as unknown as vscode.ExtensionContext, () => true, { log: (line) => logs.push(line) });
  return { globalState, logs, windowA: window(), windowB: window() };
}
const dupRows = (storage: StorageService) => storage.getChats().filter((chat) => chat.harnessSessionId === SESSION_DUP);
const storedTwins = (g: ReturnType<typeof echoingMemento>) =>
  savedAt<TwinChat[]>(g, STORAGE_KEYS.CHATS).filter((chat) => chat.id === 'chat-old' || chat.id === 'chat-new');
/** Both windows list one row, the same one; the other copy is still stored, marked, and hidden from every read. */
function assertOneRowKept(f: Awaited<ReturnType<typeof twinStore>>, winner: string, loser: string) {
  assert.deepEqual(dupRows(f.windowA).map((chat) => chat.id), [winner], 'window A lists the row holding the user state');
  assert.deepEqual(dupRows(f.windowB).map((chat) => chat.id), [winner], 'window B lists the same row');
  for (const window of [f.windowA, f.windowB]) {
    assert.equal(window.getChat(loser), undefined, 'the loser is hidden from reads');
    assert.ok(!window.getStarredChats().some((chat) => chat.id === loser));
  }
  const stored = storedTwins(f.globalState);
  assert.equal(stored.length, 2, 'both records stay in the store');
  assert.equal(stored.find((chat) => chat.id === loser)?.mergedInto, winner, 'the loser is marked merged into the winner');
}

test('dedupe: the hidden copy survives every later write (a rename or seen-mark, a new chat, an unrelated delete)', async () => {
  const f = await twinStore({}, { [STORAGE_KEYS.STARRED_CHATS]: ['chat-new'] });
  assertOneRowKept(f, 'chat-new', 'chat-old');
  const hiddenStored = () => storedTwins(f.globalState).find((chat) => chat.id === 'chat-old');

  f.windowA.updateChat('chat-new', { name: 'Renamed', customName: true });
  await f.windowB.markChatSeen('chat-new', 50_000);
  assert.equal(hiddenStored()?.mergedInto, 'chat-new', 'a rename and a seen-mark of the kept row keep the hidden copy');
  const other = f.windowA.createChat('wt-1', 'claude', 'Other', { harnessSessionId: 's-other' });
  assert.equal(hiddenStored()?.mergedInto, 'chat-new', 'creating another chat keeps the hidden copy');
  f.windowB.deleteChats([other.id], { rememberSession: false });
  assert.equal(hiddenStored()?.mergedInto, 'chat-new', 'deleting an unrelated chat keeps the hidden copy');
  assert.deepEqual(dupRows(f.windowA).map((chat) => [chat.id, chat.name]), [['chat-new', 'Renamed']]);
  assert.deepEqual(dupRows(f.windowB).map((chat) => chat.id), ['chat-new']);
});

test('dedupe: removing the kept row removes its hidden copy, so the session is not listed again in either window', async () => {
  const f = await twinStore({}, { [STORAGE_KEYS.STARRED_CHATS]: ['chat-new'] });
  assertOneRowKept(f, 'chat-new', 'chat-old');
  assert.deepEqual(f.windowA.deleteChats(['chat-new']), ['chat-new']);
  assert.deepEqual(dupRows(f.windowA), [], 'window A lists no row for the session');
  assert.deepEqual(dupRows(f.windowB), [], 'window B lists no row for the session');
  assert.deepEqual(storedTwins(f.globalState), [], 'both records are gone');
});

test('dedupe: the dropped copy held the star; the starred row is kept and stays starred in both windows', async () => {
  const f = await twinStore({}, { [STORAGE_KEYS.STARRED_CHATS]: ['chat-new'] });
  assertOneRowKept(f, 'chat-new', 'chat-old');
  assert.deepEqual(f.windowA.getStarredChats().map((chat) => chat.id), ['chat-new']);
  assert.deepEqual(f.windowB.getStarredChats().map((chat) => chat.id), ['chat-new']);
});

test('dedupe: the dropped copy held the custom name; the renamed row is kept with its name', async () => {
  const f = await twinStore({ name: 'My name', customName: true });
  assertOneRowKept(f, 'chat-new', 'chat-old');
  assert.deepEqual(dupRows(f.windowB).map((chat) => [chat.name, chat.customName]), [['My name', true]]);
});

test('dedupe: the dropped copy was the active chat; it is kept and stays active', async () => {
  const f = await twinStore({}, { [STORAGE_KEYS.ACTIVE_CHAT]: 'chat-new' });
  assertOneRowKept(f, 'chat-new', 'chat-old');
  assert.equal(f.windowA.getActiveChatId(), 'chat-new');
  assert.equal(f.windowB.getActiveChatId(), 'chat-new');
});

test('dedupe: the dropped copy had a Pitwall terminal; it is kept with its PID record', async () => {
  stub.workspace.workspaceFolders = [{ uri: { fsPath: '/workspace/dup' } }];
  const folder = '/workspace/dup';
  const f = await twinStore({}, { [STORAGE_KEYS.TERMINAL_PIDS]: { [folder]: { 'chat-new': 4242 } } });
  assertOneRowKept(f, 'chat-new', 'chat-old');
  assert.deepEqual(f.windowA.getTerminalPids(), { 'chat-new': 4242 });
  assert.deepEqual(f.windowB.getTerminalPids(), { 'chat-new': 4242 });
});

test('dedupe: state on both copies merges into the kept row in one logged write, and a user-started chat keeps the import’s state', async () => {
  stub.workspace.workspaceFolders = [{ uri: { fsPath: '/workspace/dup' } }];
  const folder = '/workspace/dup';
  // The older copy is starred (it wins); the newer one has the name, the focus, the terminal and the later times.
  const f = await twinStore(
    { name: 'My name', customName: true, seenAt: 9_000, lastAccessedAt: 8_000 },
    {
      [STORAGE_KEYS.STARRED_CHATS]: ['chat-old'],
      [STORAGE_KEYS.ACTIVE_CHAT]: 'chat-new',
      [STORAGE_KEYS.TERMINAL_PIDS]: { [folder]: { 'chat-new': 4242 } },
    }
  );
  assertOneRowKept(f, 'chat-old', 'chat-new');
  const [kept] = dupRows(f.windowA);
  assert.deepEqual([kept.name, kept.customName, kept.seenAt, kept.lastAccessedAt], ['My name', true, 9_000, 8_000], 'name and times merge in');
  for (const window of [f.windowA, f.windowB]) {
    assert.deepEqual(window.getStarredChats().map((chat) => chat.id), ['chat-old']);
    assert.equal(window.getActiveChatId(), 'chat-old', 'the active chat points at the kept row');
    assert.deepEqual(window.getTerminalPids(), { 'chat-old': 4242 }, 'the PID record points at the kept row');
  }
  assert.deepEqual(f.logs, ['[Pitwall] dedupe kept chat-old merged chat-new'], 'one explicit merge, logged once');
  const before = f.globalState.snapshots.length;
  dupRows(f.windowA);
  dupRows(f.windowB);
  assert.equal(f.globalState.snapshots.length, before, 'a merged pair is not written again');

  // A user-started chat wins over an import and still takes the import's later times.
  const g = await twinStore({ seenAt: 7_000, lastAccessedAt: 6_000 }, {}, { autoImported: false } as Partial<TwinChat>);
  assertOneRowKept(g, 'chat-old', 'chat-new');
  assert.deepEqual(dupRows(g.windowB).map((chat) => [chat.seenAt, chat.lastAccessedAt]), [[7_000, 6_000]]);
});

test('the overlay lets go of a write once the store shows it, so another window’s later write wins', () => {
  type Row = { name: string; at?: number };
  const clock = new StampClock(() => 1_000, 7);
  const overlay = new RecordOverlay<Row>({ fields: true, clock });
  const copy = (records: Record<string, Row>, stamps: Stamped<Row>['stamps'] = {}, removed: Record<string, number> = {}) =>
    ({ records, stamps, removed });

  overlay.note('mine', { name: 'Mine' }); // created here
  overlay.note('theirs', { name: 'Renamed', at: 1 }, { name: 'Theirs', at: 1 }); // only renamed here
  overlay.note('gone', null);

  // A stale copy that lacks this window's writes (older, unstamped records):
  // created records come back, an edited record another window may have
  // removed does not, removals hold.
  assert.deepEqual(overlay.merge(copy({ gone: { name: 'Gone' } })).records, { mine: { name: 'Mine' } });
  const written = overlay.merge(copy({ theirs: { name: 'Theirs', at: 2 } }));
  assert.deepEqual(written.records, { theirs: { name: 'Renamed', at: 2 }, mine: { name: 'Mine' } });

  // A copy showing every write with this window's own stamps releases
  // nothing: an echo of an earlier copy carries the same stamps, and an older
  // echo can still land after it.
  overlay.settle(written);
  assert.equal(overlay.size, 3);
  overlay.settle(copy({ mine: { name: 'Mine' }, theirs: { name: 'Theirs', at: 2 }, gone: { name: 'Gone' } }, { mine: written.stamps.mine }));
  assert.equal(overlay.size, 3, 'an equal stamp is never a release');

  // A newer write of the created record supersedes it; the rest are kept.
  const createdStamp = (written.stamps.mine as Record<string, number>)['#'];
  const newer = (stamp: number) => stamp + 1000;
  overlay.settle(
    copy({ mine: { name: 'Rewritten' }, theirs: { name: 'Theirs', at: 2 } }, { mine: { name: newer(createdStamp), '#': newer(createdStamp) } })
  );
  assert.equal(overlay.size, 2, 'the superseded creation is let go');

  // Another window's later rename wins at once, even while this window holds its own.
  const renameStamp = (written.stamps.theirs as Record<string, number>).name;
  const later = copy(
    { theirs: { name: 'Later', at: 3 } },
    { theirs: { name: newer(renameStamp), at: newer(renameStamp) } },
    { gone: newer(written.removed.gone) }
  );
  assert.deepEqual(overlay.merge(later).records, { theirs: { name: 'Later', at: 3 } });
  overlay.settle(later);
  assert.equal(overlay.size, 0, 'a superseded write and a superseded removal are let go');
  assert.deepEqual(overlay.merge(later).records, { theirs: { name: 'Later', at: 3 } });
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

// PR #28 fix round: write stamps instead of a hold (QA probe).

/** A window over a shared store whose clock the test moves. */
function clockedWindow(globalState: ReturnType<typeof echoingMemento>, clock: { now: number }, windowTag: number) {
  return new StorageService(
    { globalState, workspaceState: memento() } as unknown as vscode.ExtensionContext,
    () => true,
    { now: () => clock.now, windowTag }
  );
}

async function seedChats(globalState: ReturnType<typeof echoingMemento>, ...ids: string[]) {
  await globalState.update(
    STORAGE_KEYS.CHATS,
    ids.map((id) => ({ id, harness: 'claude', harnessSessionId: null, worktreeId: 'wt-1', name: id, createdAt: 1, lastAccessedAt: 1, seenAt: 1, status: 'idle' }))
  );
}

/** Six rounds, 20 s apart, in which every window reads and writes something else. */
function rounds(clock: { now: number }, ...windows: StorageService[]) {
  for (let round = 0; round < 6; round++) {
    clock.now += 20_000;
    for (const window of windows) {
      window.getChats();
      window.touchChat('c2');
    }
  }
}

type SavedChat = { id: string; name: string; seenAt?: number; status: string };
const savedChat = (g: ReturnType<typeof echoingMemento>, id: string) =>
  savedAt<SavedChat[]>(g, STORAGE_KEYS.CHATS).find((chat) => chat.id === id)!;

test('two windows writing the same field within seconds both converge on the later write', async () => {
  const globalState = echoingMemento();
  await seedChats(globalState, 'c1', 'c2');
  const clock = { now: 1_800_000_000_000 };
  const windowA = clockedWindow(globalState, clock, 1);
  const windowB = clockedWindow(globalState, clock, 2);

  windowA.updateChat('c1', { name: 'FromA' });
  clock.now += 5_000;
  windowB.updateChat('c1', { name: 'FromB' });
  rounds(clock, windowA, windowB);

  assert.equal(windowA.getChat('c1')!.name, 'FromB');
  assert.equal(windowB.getChat('c1')!.name, 'FromB');
  assert.equal(savedChat(globalState, 'c1').name, 'FromB');
});

test('a later seenAt from another window is never reverted by an earlier one', async () => {
  const globalState = echoingMemento();
  await seedChats(globalState, 'c1', 'c2');
  const clock = { now: 1_800_000_000_000 };
  const windowA = clockedWindow(globalState, clock, 1);
  const windowB = clockedWindow(globalState, clock, 2);

  await windowA.markChatSeen('c1', 100);
  const stale = globalState.snapshots.at(-1)!; // A's earlier seenAt
  clock.now += 1_000;
  await windowB.markChatSeen('c1', 200);
  globalState.echo(stale);
  rounds(clock, windowA, windowB);

  assert.equal(windowA.getChat('c1')!.seenAt, 200);
  assert.equal(windowB.getChat('c1')!.seenAt, 200);
  assert.equal(savedChat(globalState, 'c1').seenAt, 200);
});

test('a stale storage echo carrying older stamps never overwrites a newer write', async () => {
  const globalState = echoingMemento();
  await seedChats(globalState, 'c1', 'c2');
  const clock = { now: 1_800_000_000_000 };
  const windowA = clockedWindow(globalState, clock, 1);
  const windowB = clockedWindow(globalState, clock, 2);

  windowA.updateChat('c1', { name: 'FromA' });
  const stale = globalState.snapshots.at(-1)!; // FromA, with A's older stamp
  clock.now += 1_000;
  windowB.updateChat('c1', { name: 'FromB' });

  globalState.echo(stale);
  assert.equal(windowB.getChat('c1')!.name, 'FromB', 'B never sees its newer write reverted');

  // B's next write puts the newer stamp back; A follows it at once.
  windowB.touchChat('c2');
  assert.equal(windowA.getChat('c1')!.name, 'FromB');
  windowA.touchChat('c2');
  assert.equal(savedChat(globalState, 'c1').name, 'FromB');
  rounds(clock, windowA, windowB);
  assert.equal(savedChat(globalState, 'c1').name, 'FromB');
  assert.equal(windowA.getChat('c1')!.name, 'FromB');
});

test('a star in A and a rename in B on the same chat both survive', async () => {
  const globalState = echoingMemento();
  await seedChats(globalState, 'c1', 'c2');
  const clock = { now: 1_800_000_000_000 };
  const windowA = clockedWindow(globalState, clock, 1);
  const windowB = clockedWindow(globalState, clock, 2);
  const stale = globalState.snapshots.at(-1)!; // neither edit

  windowA.toggleStar('c1');
  windowA.updateChat('c1', { status: 'active' }); // and a field of the record itself
  clock.now += 1_000;
  windowB.updateChat('c1', { name: 'Renamed', customName: true });
  globalState.echo(stale);
  rounds(clock, windowA, windowB);

  for (const window of [windowA, windowB]) {
    assert.ok(window.isStarred('c1'));
    assert.equal(window.getChat('c1')!.name, 'Renamed');
    assert.equal(window.getChat('c1')!.status, 'active');
  }
  assert.equal(savedChat(globalState, 'c1').name, 'Renamed');
  assert.equal(savedChat(globalState, 'c1').status, 'active');
  assert.deepEqual(savedAt(globalState, STORAGE_KEYS.STARRED_CHATS), ['c1']);
});

// PR #28 round 3: an echo of this window's own earlier copy shows its stamps,
// and an older echo can still land after it, so only a newer stamp releases.

test("an echo of this window's earlier copy followed by an older echo never loses a chat edit", async () => {
  const globalState = echoingMemento();
  await seedChats(globalState, 'c1', 'c2');
  const s0 = globalState.snapshots.at(-1)!;
  const clock = { now: 1_800_000_000_000 };
  const storage = clockedWindow(globalState, clock, 1);

  storage.updateChat('c1', { name: 'X' });
  const s1 = globalState.snapshots.at(-1)!;
  clock.now += 1_000;
  storage.updateChat('c2', { name: 'Y' });

  globalState.echo(s1);
  storage.getChats();
  globalState.echo(s0);
  storage.getChats();
  clock.now += 1_000;
  storage.touchChat('c2');

  assert.equal(storage.getChat('c1')!.name, 'X');
  assert.equal(storage.getChat('c2')!.name, 'Y');
  assert.equal(savedChat(globalState, 'c1').name, 'X');
  assert.equal(savedChat(globalState, 'c2').name, 'Y');
});

test("an echo of this window's earlier copy followed by an older echo never loses a terminal PID", async () => {
  stub.workspace.workspaceFolders = [{ uri: { fsPath: '/workspace/echo2' } }];
  const globalState = echoingMemento();
  await seedChats(globalState, 'c1', 'c2');
  const s0 = globalState.snapshots.at(-1)!;
  const clock = { now: 1_800_000_000_000 };
  const storage = clockedWindow(globalState, clock, 1);

  await storage.rememberTerminalPid('c1', 111);
  const s1 = globalState.snapshots.at(-1)!;
  clock.now += 1_000;
  await storage.rememberTerminalPid('c2', 222);

  globalState.echo(s1);
  storage.getTerminalPids();
  globalState.echo(s0);
  assert.deepEqual(storage.getTerminalPids(), { c1: 111, c2: 222 });

  storage.setActiveChatId('c1');
  assert.deepEqual(pidRecords(globalState.saved())['/workspace/echo2'], { c1: 111, c2: 222 });
});
