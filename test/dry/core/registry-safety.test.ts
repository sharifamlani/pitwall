/**
 * A harness can be switched off (src/harnesses/enabled.json) while storage
 * still holds its chats and search records from a build that had it on.
 * Those records are skipped wherever they are read, never thrown on: the
 * registry only knows enabled harnesses, and `get()` of any other is a
 * programmer error.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from '../../../src/core/providers/WorkspacesTreeProvider';
import { SessionSearchTreeProvider } from '../../../src/core/providers/SessionSearchTreeProvider';
import { TerminalManager } from '../../../src/core/services/TerminalManager';
import { HarnessRegistry } from '../../../src/core/harness/HarnessRegistry';
import { SessionSearchService } from '../../../src/core/services/SessionSearchService';
import { registerChatCommands } from '../../../src/core/commands/chat';
import { SessionSearchRecord, STORAGE_KEYS } from '../../../src/core/types';
import {
  chatRecord,
  FakeTerminal,
  fakeAdapter,
  fakeSearchRunner,
  makeStorage,
  memento,
  runCommand,
  stub,
  tempDir,
  worktreeRecord,
} from '../support';

beforeEach(() => stub.__reset());

const WORKTREE = worktreeRecord({ id: 'wt-1', repoId: 'repo-1', path: '/work/demo' });

/** A Claude-only registry, like the shipped build. */
const claudeOnly = () => new HarnessRegistry([fakeAdapter('claude')]);

function search(id: string, engine: string, matchHarnesses: string[]): SessionSearchRecord {
  return {
    id,
    query: 'the flaky test',
    engine: { harness: engine, model: '', effort: '' },
    startedAt: 1,
    state: 'done',
    answer: 'Found it.',
    matches: matchHarnesses.map((harness, index) => ({
      harness,
      sessionId: `${harness}-${index}`,
      cwd: WORKTREE.path,
      title: `${harness} session`,
      lastUpdated: 1,
      reason: '',
    })),
    activity: [],
  } as SessionSearchRecord;
}

/** Storage seeded with a Claude chat, a Codex chat, and a Codex search record. */
function seededStorage(registry: HarnessRegistry) {
  const globalState = memento();
  void globalState.update(STORAGE_KEYS.CHATS, [
    chatRecord({ id: 'aabbcc00-claude', name: 'Claude chat', harness: 'claude', harnessSessionId: 'c-1', status: 'closed' }),
    chatRecord({ id: 'ccdd0000-codex', name: 'Codex chat', harness: 'codex', harnessSessionId: 'x-1', status: 'closed' }),
  ]);
  void globalState.update(STORAGE_KEYS.SESSION_SEARCHES, [search('codex-search', 'codex', ['codex'])]);
  void globalState.update(STORAGE_KEYS.REPOSITORIES, [{ id: 'repo-1', name: 'demo', rootPath: WORKTREE.path }]);
  return makeStorage(globalState, memento(), (id) => registry.has(id));
}

test('disabled harness records are skipped, not thrown', async (t) => {
  const registry = claudeOnly();
  const storage = seededStorage(registry);
  const tree = new WorkspacesTreeProvider(
    storage,
    {
      listRepositoryWorktrees: () => ({ isGit: true, worktrees: [WORKTREE] }),
      listRepositoryWorktreesAsync: async () => ({ isGit: true, worktrees: [WORKTREE] }),
      getAheadBehind: () => null,
    } as never,
    { onTerminalStateChange: () => ({ dispose: () => undefined }), isActive: () => false } as never,
    registry,
    vscode.Uri.file('/extension')
  );
  t.after(() => tree.dispose());
  await tree.whenListed();

  const rows = await tree.getChildren(new WorkspaceTreeItem(WORKTREE.name, 1, 'worktree', WORKTREE, 'worktree'));
  assert.deepEqual(rows.map((row) => row.label), ['Claude chat'], 'the Codex row is hidden and the tree renders');

  assert.deepEqual(storage.getSessionSearches(), [], 'a search answered by a disabled harness is not read');
  assert.equal(storage.getChats().length, 2, 'the Codex chat stays stored for a build that enables Codex');
});

test('terminal restore skips a chat whose harness is disabled', async (t) => {
  const registry = claudeOnly();
  const storage = seededStorage(registry);
  const manager = new TerminalManager(storage, registry, { registerPendingChat: () => undefined } as never);
  t.after(() => manager.dispose());
  vscode.commands.registerCommand('pitwall.refreshWorkspaces', () => undefined);
  vscode.commands.registerCommand('workbench.action.terminal.renameWithArg', () => undefined);

  await storage.rememberTerminalPid('aabbcc00-claude', 9001);
  await storage.rememberTerminalPid('ccdd0000-codex', 9002);
  // A quit revived both tabs as new shells with new PIDs.
  const claudeTab = stub.window.createTerminal({ name: 'Pitwall: Claude chat [aabbcc]', __pid: 9101 });
  const codexTab = stub.window.createTerminal({ name: 'Pitwall: Codex chat [ccdd00]', __pid: 9102 });

  const restore = manager.beginRestoreSync(() => WORKTREE);
  await restore.adopted;
  await restore.complete;
  assert.match(claudeTab.sent[0] ?? '', /\/work\/demo'? && claude --resume c-1$/, 'the Claude tab resumes');
  assert.deepEqual((codexTab as FakeTerminal).sent, [], 'nothing is typed into the Codex tab');
  assert.ok(!manager.isActive('ccdd0000-codex'));
});

test('the Find Session view omits searches and matches of a disabled harness', (t) => {
  const registry = claudeOnly();
  const searches = [search('codex-search', 'codex', ['codex']), search('mixed', 'claude', ['claude', 'codex'])];
  const view = new SessionSearchTreeProvider(
    { searches: () => searches, onDidChange: () => ({ dispose: () => undefined }) } as never,
    registry,
    vscode.Uri.file('/extension')
  );
  t.after(() => view.dispose());

  const roots = view.getChildren();
  assert.deepEqual(
    roots.map((node) => node.search.id),
    ['mixed'],
    'the Codex-answered search is hidden'
  );
  const matches = view.getChildren(roots[0]);
  assert.deepEqual(
    matches.map((node) => (node.kind === 'match' ? node.match.harness : node.kind)),
    ['claude'],
    'the Codex match is hidden'
  );
  for (const node of [...roots, ...matches]) {
    assert.doesNotThrow(() => view.getTreeItem(node));
  }
});

test('pitwall.newChat creates a session with the first enabled harness', async () => {
  // opencode first proves the alias follows the registry, not a hardcoded 'claude'.
  const registry = new HarnessRegistry([fakeAdapter('opencode'), fakeAdapter('claude')]);
  const storage = makeStorage(memento(), memento(), (id) => registry.has(id));
  const opened: string[] = [];
  registerChatCommands({ subscriptions: [], extensionUri: vscode.Uri.file('/extension') } as never, {
    storageService: storage,
    gitService: {} as never,
    terminalManager: {
      openChat: async (chat: { harness: string }) => void opened.push(chat.harness),
      isActive: () => false,
    } as never,
    workspacesProvider: {
      getWorktreeForItem: () => WORKTREE,
      getWorktreeById: () => WORKTREE,
      getWorktreeByIdAsync: async () => WORKTREE,
    } as never,
    harnessRegistry: registry,
    harnessWatcherRegistry: { registerPendingChat: () => undefined } as never,
    sessionImporter: { cancelExpectation: () => undefined } as never,
    sessionsNeedingYou: () => [],
    selectedRows: () => [],
    activeWorktree: () => WORKTREE,
    activateChat: () => undefined,
    showWorktree: () => undefined,
    removeChats: () => [],
    refreshTree: () => undefined,
  });

  await runCommand('pitwall.newChat', new WorkspaceTreeItem(WORKTREE.name, 1, 'worktree', WORKTREE, 'worktree'));
  assert.deepEqual(storage.getChats().map((chat) => chat.harness), ['opencode']);
  assert.deepEqual(opened, ['opencode']);
});

test('Find Session with an off-enum stored harness falls back to the first enabled harness', async (t) => {
  const dir = tempDir(t);
  const registry = new HarnessRegistry([
    fakeAdapter('claude', { sessionSearchRunner: fakeSearchRunner() }),
  ]);
  const finder = new SessionSearchService(makeStorage(), registry, dir);
  t.after(() => finder.dispose());
  stub.__setConfiguration('sessionSearch.harness', 'codex');

  const engine = await finder.engine();
  assert.equal(engine?.harness, 'claude');
});
