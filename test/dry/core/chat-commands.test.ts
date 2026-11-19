/**
 * Session commands end to end over fake adapters: creation, opening in a
 * terminal or an agent's VS Code UI, forks, import, and removal. Commands are
 * harness-agnostic, so each path is proven once with the adapter shape that
 * exercises it (a chosen ID, a linked fork, a native UI).
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { StorageService } from '../../../src/core/services/StorageService';
import { TerminalManager } from '../../../src/core/services/TerminalManager';
import { HarnessRegistry } from '../../../src/core/harness/HarnessRegistry';
import { quoteShellArgument } from '../../../src/core/harness/cli';
import { WorktreeCatalog } from '../../../src/core/services/WorktreeCatalog';
import { SessionImportService } from '../../../src/core/services/SessionImportService';
import { WorkspaceTreeItem } from '../../../src/core/providers/WorkspacesTreeProvider';
import { registerChatCommands } from '../../../src/core/commands/chat';
import { registerNavigationCommands } from '../../../src/core/commands/navigation';
import { claudeUiSurfaces } from '../../../src/harnesses/claude/claudeUi';
import { registerSessionImportCommands } from '../../../src/core/commands/sessionImport';
import { registerRepositoryCommands } from '../../../src/core/commands/repository';
import { ForkResult, HarnessSession, NativeUiOpenResult } from '../../../src/core/harness/types';
import { ChatSession, HarnessId, Worktree } from '../../../src/core/types';
import {
  fakeAdapter,
  fakeNativeUi,
  flush,
  FakeTerminal,
  FakeTreeView,
  makeStorage,
  runCommand,
  sessionRecord,
  shown,
  stub,
  waitFor,
  worktreeRecord,
} from '../support';

beforeEach(() => stub.__reset());

const UUID = /^[0-9a-f-]{36}$/;

function setup(
  t: { after(fn: () => void): void },
  /** `surface` is the defaultSessionSurface setting; null leaves it unset (the shipped default). */
  options: { notInstalled?: HarnessId[]; surface?: 'terminal' | 'ui' | null } = {}
) {
  const surface = options.surface === undefined ? 'terminal' : options.surface;
  if (surface) {
    stub.__setConfiguration('defaultSessionSurface', surface);
  }
  const storage: StorageService = makeStorage();
  const repo = storage.addRepository('demo', '/work/demo');
  const folderRepo = storage.addRepository('scratch', '/work/scratch');
  const main = worktreeRecord({ id: 'wt-main', repoId: repo.id, path: '/work/demo' });
  const feature = worktreeRecord({ id: 'wt-feature', repoId: repo.id, name: 'feature-x', path: '/work/demo-feature-x', isMain: false });
  const folder = worktreeRecord({ id: 'wt-folder', repoId: folderRepo.id, name: 'scratch', path: '/work/scratch' });
  const worktrees: Worktree[] = [main, feature];

  /** Sessions that no longer exist natively; chosen IDs have no transcript yet. */
  const missing = new Set<string>();
  const resumable = async (id: string) => !missing.has(id) && !UUID.test(id) && !id.startsWith('pending-');
  const sessions: Record<HarnessId, HarnessSession[]> = { claude: [], opencode: [], codex: [], pi: [] };
  let pendingForks = 0;
  const claudeUi = fakeNativeUi('Claude Code UI', { contextValueSuffix: 'ClaudeUi' });
  const codexUi = fakeNativeUi('Codex UI', { contextValueSuffix: 'CodexUi' });
  const forks: Record<HarnessId, () => Promise<ForkResult>> = {
    claude: async () => ({ kind: 'terminal', pendingSessionId: `pending-fork-${++pendingForks}` }),
    opencode: async () => ({ kind: 'linked', sessionId: 'ses_fork' }),
    codex: async () => ({ kind: 'linked', sessionId: 'codex-fork' }),
    pi: async () => ({ kind: 'terminal', pendingSessionId: `pending-fork-${++pendingForks}` }),
  };
  const adapter = (id: HarnessId, nativeUi?: typeof claudeUi) =>
    fakeAdapter(id, {
      nativeUi: nativeUi?.nativeUi,
      isInstalled: async () => !options.notInstalled?.includes(id),
      isSessionResumable: resumable,
      listSessionsForWorktree: async () => sessions[id],
      listSessionsForRepository: async () => sessions[id],
      forkSession: () => forks[id](),
      prepareForkToNewWorktree: () => forks[id](),
    });
  const adapters = { claude: adapter('claude', claudeUi), opencode: adapter('opencode'), codex: adapter('codex', codexUi) };
  const registry = new HarnessRegistry(Object.values(adapters));

  const git = {
    getCurrentCommit: () => 'deadbeef',
    listRepositoryWorktrees: (_root: string, repoId: string) =>
      repoId === folderRepo.id ? { isGit: false, worktrees: [folder] } : { isGit: true, worktrees },
    listRepositoryWorktreesAsync: async (_root: string, repoId: string) =>
      repoId === folderRepo.id ? { isGit: false, worktrees: [folder] } : { isGit: true, worktrees },
    listWorktrees: () => worktrees,
    getBranches: () => [] as string[],
    createWorktreeWithNewBranch: (_root: string, branch: string, path: string) => {
      worktrees.push(worktreeRecord({ id: `wt-${branch}`, repoId: repo.id, name: branch, path, isMain: false }));
      return true;
    },
    hasUncommittedChanges: () => false,
    copyUncommittedChanges: () => true,
  };
  const workspaces = {
    getWorktreeById: (id: string) => [...worktrees, folder].find((worktree) => worktree.id === id),
    getWorktreeByIdAsync: async (id: string) => [...worktrees, folder].find((worktree) => worktree.id === id),
    getWorktreeForItem: (item?: WorkspaceTreeItem) =>
      item?.itemType === 'worktree'
        ? (item.data as Worktree)
        : item?.itemType === 'repository' && item.data.id === folderRepo.id
          ? folder
          : item?.itemType === 'repository' && item.data.id === repo.id
            ? main
            : undefined,
    isGitWorktree: (worktree: Worktree) => worktree.id !== folder.id,
  };
  const shown: string[] = [];
  /** What the attention service would report; tests fill it. */
  const needingYou: string[] = [];
  /** The tree's selection and the panels' worktree, for commands run from the keyboard. */
  const selectedRows: WorkspaceTreeItem[] = [];
  const active: { worktree?: Worktree } = {};
  const activated: string[] = [];
  const registrations: string[] = [];
  const watchers = { registerPendingChat: (_h: HarnessId, chatId: string) => registrations.push(chatId) };
  const terminals = new TerminalManager(storage, registry, watchers as never);
  const catalog = new WorktreeCatalog(storage, git as never);
  const importer = new SessionImportService(storage, catalog, registry, {
    scanIntervalMs: 10,
    hotScanIntervalMs: 10,
    readSettings: () => ({ enabled: false, retentionDays: 7 }),
  });
  importer.start();
  t.after(() => {
    importer.dispose();
    terminals.dispose();
  });

  const context = { subscriptions: [], extensionUri: vscode.Uri.file('/extension') } as never;
  registerChatCommands(context, {
    storageService: storage,
    gitService: git as never,
    terminalManager: terminals,
    workspacesProvider: workspaces as never,
    harnessRegistry: registry,
    harnessWatcherRegistry: watchers as never,
    sessionImporter: importer,
    sessionsNeedingYou: () => needingYou,
    selectedRows: () => selectedRows,
    activeWorktree: () => active.worktree,
    activateChat: (chat) => activated.push(chat.id),
    showWorktree: (worktree) => shown.push(worktree.id),
    removeChats: (ids, options) => {
      ids.forEach((id) => terminals.closeChat(id));
      return storage.deleteChats(ids, options);
    },
    refreshTree: () => undefined,
  });
  registerSessionImportCommands(context, storage, git as never, catalog, workspaces as never, registry, () => undefined);
  registerRepositoryCommands(context, {
    storageService: storage,
    gitService: git as never,
    harnessRegistry: registry,
    forgetWorktrees: () => undefined,
    refreshTree: () => undefined,
  });
  vscode.commands.registerCommand('pitwall.refreshWorkspaces', () => undefined);

  return {
    storage, main, feature, folder, folderRepo, worktrees, missing, sessions, adapters, terminals,
    claudeUi, codexUi, shown, activated, registrations, needingYou, selectedRows, active,
    /** A chat in a worktree (main by default), linked when `sessionId` is given. */
    chat(harness: HarnessId, name: string, sessionId: string | null = null, worktree = main): ChatSession {
      return storage.createChat(worktree.id, harness, name, { harnessSessionId: sessionId });
    },
    row: (chat: ChatSession) => new WorkspaceTreeItem(chat.name, 0, 'chat', storage.getChat(chat.id)!, 'chat'),
    worktreeRow: (worktree: Worktree) => new WorkspaceTreeItem(worktree.name, 1, 'worktree', worktree, 'worktree'),
    lastTerminal: () => stub.window.terminals.at(-1) as FakeTerminal,
    chatsIn: (worktree: Worktree) => storage.getChatsByWorktree(worktree.id),
  };
}

test('New Session launches in the worktree, with an ID chosen up front when the harness accepts one', async (t) => {
  const f = setup(t);
  await runCommand('pitwall.newClaudeChat', f.worktreeRow(f.main));
  const [claude] = f.chatsIn(f.main);
  assert.equal(claude.name, 'New Session');
  assert.match(claude.pendingHarnessSessionId ?? '', UUID);
  assert.equal(f.lastTerminal().sent[0], `claude --session-id ${claude.pendingHarnessSessionId}`);
  assert.equal(f.lastTerminal().options.cwd, f.main.path);
  assert.deepEqual([f.registrations, f.shown], [[claude.id], [f.main.id]]);

  await runCommand('pitwall.newCodexChat', f.worktreeRow(f.main));
  const codex = f.chatsIn(f.main).find((chat) => chat.harness === 'codex')!;
  assert.equal(codex.pendingHarnessSessionId, undefined, 'Codex assigns its own ID');
  assert.equal(f.lastTerminal().sent[0], 'codex');
  assert.ok(f.registrations.includes(codex.id), 'its watcher links the thread later');

  await runCommand('pitwall.newChat', new WorkspaceTreeItem('scratch', 1, 'repository', f.folderRepo, 'folderRepository'));
  assert.equal(f.chatsIn(f.folder)[0]?.harness, 'claude', 'the legacy alias works from a plain folder row');
  assert.equal(f.lastTerminal().options.cwd, f.folder.path);
});

test('"+" starts a Claude chat in the repo\'s main worktree', async (t) => {
  const f = setup(t);
  const repoRow = new WorkspaceTreeItem('demo', 1, 'repository', f.storage.getRepositories()[0], 'repository');
  await runCommand('pitwall.newSessionInRepository', repoRow);
  assert.deepEqual(f.chatsIn(f.main).map((chat) => chat.harness), ['claude']);
  assert.deepEqual(f.chatsIn(f.feature), [], 'not in a linked worktree');
  assert.equal(f.lastTerminal().options.cwd, f.main.path);
  assert.match(f.lastTerminal().sent[0], /^claude --session-id /);

  await runCommand('pitwall.newSessionInRepository', new WorkspaceTreeItem('scratch', 1, 'repository', f.folderRepo, 'folderRepository'));
  assert.equal(f.chatsIn(f.folder)[0]?.harness, 'claude', 'a plain folder row works the same');
});

test('Copy Path copies the repo root', async (t) => {
  const f = setup(t);
  await runCommand('pitwall.copyRepositoryPath', new WorkspaceTreeItem('demo', 1, 'repository', f.storage.getRepositories()[0], 'repository'));
  assert.equal(await vscode.env.clipboard.readText(), '/work/demo');
});

test('New Session starts the default agent in one click, and asks which agent when none is set', async (t) => {
  const f = setup(t);
  stub.__setConfiguration('defaultHarness', 'codex');
  t.after(() => stub.__setConfiguration('defaultHarness', undefined));
  await runCommand('pitwall.newDefaultSession', f.worktreeRow(f.main));
  assert.deepEqual(f.chatsIn(f.main).map((chat) => chat.harness), ['codex'], 'no question asked');
  assert.equal(f.lastTerminal().sent[0], 'codex');

  // No default: the installed agents are offered and the choice starts.
  stub.__setConfiguration('defaultHarness', '');
  stub.__setQuickPickHandler((items: { label: string }[]) => items.find((item) => item.label === f.adapters.opencode.displayName));
  t.after(() => stub.__setQuickPickHandler(null));
  await runCommand('pitwall.newDefaultSession', f.worktreeRow(f.main));
  assert.deepEqual(f.chatsIn(f.main).map((chat) => chat.harness), ['codex', 'opencode']);
});

test('a default agent that is not installed is not launched: New Session offers the installed ones instead', async (t) => {
  const f = setup(t, { notInstalled: ['claude'] });
  stub.__setConfiguration('defaultHarness', 'claude');
  let offered: string[] = [];
  stub.__setQuickPickHandler((items: { label: string }[], options: { placeHolder: string }) => {
    offered = items.map((item) => item.label);
    assert.match(options.placeHolder, /is the default agent but is not installed/);
    return undefined;
  });
  t.after(() => {
    stub.__setQuickPickHandler(null);
    stub.__setConfiguration('defaultHarness', undefined);
  });
  await runCommand('pitwall.newDefaultSession', f.worktreeRow(f.main));
  assert.deepEqual(offered, [f.adapters.opencode.displayName, f.adapters.codex.displayName]);
  assert.equal(f.chatsIn(f.main).length, 0, 'dismissing the question starts nothing');
});

test('Set Default Agent stores the chosen agent, and Ask Every Time clears it', async (t) => {
  const f = setup(t);
  t.after(() => {
    stub.__setQuickPickHandler(null);
    stub.__setConfiguration('defaultHarness', undefined);
  });
  const config = () => vscode.workspace.getConfiguration('pitwall').get('defaultHarness');
  stub.__setQuickPickHandler((items: { label: string }[]) => items.find((item) => item.label === f.adapters.codex.displayName));
  await runCommand('pitwall.setDefaultHarness');
  assert.equal(config(), 'codex');

  stub.__setQuickPickHandler((items: { label: string; description?: string }[]) => {
    assert.equal(items.find((item) => item.description?.includes('current'))?.label, f.adapters.codex.displayName);
    return items[0];
  });
  await runCommand('pitwall.setDefaultHarness');
  assert.equal(config(), '');
});

test('opening a chat from before chosen IDs gives it one; opening an open chat only focuses it', async (t) => {
  const f = setup(t);
  const legacy = f.chat('claude', 'Legacy');
  await runCommand('pitwall.openChat', f.row(legacy));
  const pending = f.storage.getChat(legacy.id)!.pendingHarnessSessionId;
  assert.match(pending ?? '', UUID);
  assert.equal(f.lastTerminal().sent[0], `claude --session-id ${pending}`);

  const registered = f.registrations.length;
  await runCommand('pitwall.openChat', f.row(legacy));
  assert.deepEqual([stub.window.terminals.length, f.lastTerminal().shown, f.registrations.length], [1, 2, registered]);
});

test('the row bell opens its chat, like a click', async (t) => {
  const f = setup(t);
  const chat = f.chat('claude', 'Needs you', 'claude-1');
  await runCommand('pitwall.openNeedsYouChat', f.row(chat));
  assert.equal(f.lastTerminal().sent[0], 'claude --resume claude-1');
});

test('Reveal in File Explorer shows the repo folder in the system file manager', async (t) => {
  const f = setup(t);
  const revealed: string[] = [];
  vscode.commands.registerCommand('revealFileInOS', (uri: vscode.Uri) => {
    revealed.push(uri.fsPath.replace(/\\/g, '/'));
  });
  await runCommand('pitwall.revealRepository', new WorkspaceTreeItem('demo', 1, 'repository', f.storage.getRepositories()[0], 'repository'));
  assert.deepEqual(revealed.map((path) => path.replace(/^[A-Za-z]:/, '')), ['/work/demo']);
});

test('Open in UI stops a running terminal only after confirmation, then hands over the session', async (t) => {
  const f = setup(t);
  const chat = f.chat('claude', 'Running', 'claude-1');
  await runCommand('pitwall.openChat', f.row(chat));
  const terminal = f.lastTerminal();

  stub.__warningResponses.push(undefined);
  await runCommand('pitwall.openClaudeUi', f.row(chat));
  assert.ok(shown('Close the terminal for "Running"?'));
  assert.deepEqual([terminal.disposed, f.claudeUi.opened.length], [false, 0], 'declining keeps the terminal');

  stub.__warningResponses.push('Close and Open');
  const handoff = runCommand('pitwall.openClaudeUi', f.row(chat));
  await waitFor(() => terminal.disposed, 'the terminal to close');
  stub.window.__fireDidCloseTerminal(terminal);
  await handoff;
  assert.deepEqual(f.claudeUi.opened, [{ sessionId: 'claude-1', cwd: f.main.path }]);
  assert.deepEqual(f.claudeUi.surfaces.calls, ['expect:claude-1:Running', 'settle:claude-1']);
  assert.deepEqual([stub.window.terminals.length, f.activated], [0, [chat.id]]);
});

test('Open in UI explains a refusal before touching anything', async (t) => {
  const f = setup(t);
  const unstarted = f.chat('claude', 'Unstarted');
  const gone = f.chat('claude', 'Gone', 'gone');
  const mismatch = f.chat('claude', 'Mismatch', 'claude-2');
  const codex = f.chat('codex', 'Codex', 'codex-1');
  f.missing.add('gone');
  await runCommand('pitwall.openChat', f.row(mismatch));
  f.claudeUi.nativeUi.checkAvailability = () => ({ kind: 'workspace-mismatch', uiCwd: '/elsewhere' });

  const cases: [ChatSession, string][] = [
    [unstarted, 'Start this session in the terminal first'],
    [gone, 'session no longer exists'],
    [mismatch, 'runs in the first folder open in VS Code'],
    [codex, 'This is not a Claude Code session'],
  ];
  for (const [chat, message] of cases) {
    await runCommand('pitwall.openClaudeUi', f.row(chat));
    assert.ok(shown(message), message);
  }
  assert.equal(f.claudeUi.opened.length, 0);
  assert.ok(f.terminals.isActive(mismatch.id), 'a folder mismatch never costs the running terminal');

  f.claudeUi.nativeUi.isInstalled = () => false;
  await runCommand('pitwall.openClaudeUi', f.row(gone));
  assert.ok(shown('The Claude Code UI extension is not installed'));
});

test('a click reveals a session already open in its UI, from the tree or the starred list; a live terminal still wins', async (t) => {
  const f = setup(t);
  const chat = f.chat('codex', 'Codex UI', 'codex-1');
  f.storage.toggleStar(chat.id);
  f.codexUi.surfaces.open.add('codex-1');

  await runCommand('pitwall.openChat', f.row(chat));
  stub.__setQuickPickHandler((items) => items.find((item: { chatId?: string }) => item.chatId === chat.id));
  await runCommand('pitwall.showStarredSessions');
  assert.equal(f.codexUi.opened.length, 2);
  assert.equal(stub.window.terminals.length, 0, 'no second agent beside the open panel');

  f.codexUi.surfaces.open.delete('codex-1');
  await runCommand('pitwall.openChat', f.row(chat));
  const terminal = f.lastTerminal();
  f.codexUi.surfaces.open.add('codex-1');
  await runCommand('pitwall.openChat', f.row(chat));
  assert.deepEqual([f.codexUi.opened.length, terminal.shown], [2, 2], 'the live terminal is focused instead');
});

test('with the UI as default, a click uses the UI when it can and the terminal otherwise', async (t) => {
  const f = setup(t);
  stub.__setConfiguration('defaultSessionSurface', 'ui');
  const inUi = f.chat('claude', 'UI', 'claude-ui');
  const fallback = f.chat('claude', 'Fallback', 'claude-fallback');
  const explicit = f.chat('claude', 'Explicit', 'claude-explicit');

  await runCommand('pitwall.openChat', f.row(inUi));
  assert.deepEqual(f.claudeUi.opened.map((open) => open.sessionId), ['claude-ui']);
  f.claudeUi.nativeUi.checkAvailability = () => ({ kind: 'workspace-mismatch', uiCwd: '/elsewhere' });
  await runCommand('pitwall.openChat', f.row(fallback));
  f.claudeUi.nativeUi.checkAvailability = () => ({ kind: 'available' });
  await runCommand('pitwall.openChatInTerminal', f.row(explicit));
  assert.deepEqual(stub.window.terminals.map((terminal) => terminal.sent[0]), [
    'claude --resume claude-fallback',
    'claude --resume claude-explicit',
  ]);

  // Open in Terminal on a session open in the UI closes that tab first.
  f.claudeUi.surfaces.open.add('claude-ui');
  stub.__warningResponses.push('Close and Open');
  await runCommand('pitwall.openChatInTerminal', f.row(inUi));
  assert.ok(f.claudeUi.surfaces.calls.includes('close:claude-ui'));
  assert.equal(f.lastTerminal().sent[0], 'claude --resume claude-ui');
});

test('with no setting, a click on a linked chat opens it in the UI (Q3)', async (t) => {
  const f = setup(t, { surface: null });
  const chat = f.chat('claude', 'Linked', 'claude-1');
  await runCommand('pitwall.openChat', f.row(chat));
  assert.deepEqual(f.claudeUi.opened, [{ sessionId: 'claude-1', cwd: f.main.path }]);
  assert.equal(stub.window.terminals.length, 0);
});

const SDK_REFUSAL = "Claude Code's chat panel can't resume chats made with claude -p or the SDK; opening it in a terminal.";

test('an sdk-cli chat opens in the terminal even with surface ui (Q23)', async (t) => {
  const f = setup(t, { surface: 'ui' });
  f.claudeUi.nativeUi.resumeRefusal = async (sessionId) => (sessionId.startsWith('sdk-') ? SDK_REFUSAL : undefined);
  const sdk = f.chat('claude', 'From claude -p', 'sdk-1');
  const other = f.chat('claude', 'Also from the SDK', 'sdk-2');

  await runCommand('pitwall.openChat', f.row(sdk));
  assert.equal(f.lastTerminal().sent[0], 'claude --resume sdk-1');
  assert.deepEqual(f.claudeUi.opened, [], 'never a blank "Untitled" tab');
  assert.ok(!shown(SDK_REFUSAL), 'a click falls back with no message');

  await runCommand('pitwall.openClaudeUi', f.row(other));
  assert.ok(shown(SDK_REFUSAL), 'the explicit command says why');
  assert.equal(f.lastTerminal().sent[0], 'claude --resume sdk-2');
  assert.deepEqual(f.claudeUi.opened, []);
});

/**
 * The list keyboard over a fake workbench list: `list.select` selects the row
 * and fires its command without awaiting it, as the workbench does (QA B1).
 */
function listKeys(row: WorkspaceTreeItem) {
  const view = vscode.window.createTreeView('pitwall.workspacesView', {
    treeDataProvider: { getChildren: async () => [] } as never,
  }) as unknown as FakeTreeView;
  const files = vscode.window.createTreeView('pitwall.filesView', {
    treeDataProvider: { getChildren: async () => [] } as never,
  }) as unknown as FakeTreeView;
  registerNavigationCommands({ subscriptions: [] } as never, {
    workspacesProvider: {} as never,
    workspacesTreeView: view as never,
    filesTreeView: files as never,
  });
  const events: string[] = [];
  let fired: Thenable<unknown> | undefined;
  vscode.commands.registerCommand('list.focusDown', () => undefined);
  vscode.commands.registerCommand('list.select', () => {
    view.__select([row]);
    fired = vscode.commands.executeCommand('pitwall.openChat', row);
  });
  vscode.commands.registerCommand('pitwall.workspacesView.focus', () => void events.push('focus list'));
  return {
    events,
    /** Ctrl+↓, then the row command the fake list fired. */
    press: async () => {
      fired = undefined;
      await runCommand('pitwall.list.moveDownAndOpen');
      await fired;
    },
  };
}

test('Ctrl+Down sets the marker and the row command, fired without await by a fake list.select, refocuses pitwall.workspacesView after the UI open', async (t) => {
  const f = setup(t, { surface: 'ui' });
  const chat = f.chat('claude', 'Next', 'claude-1');
  const keys = listKeys(f.row(chat));
  const open = f.claudeUi.nativeUi.openSession;
  f.claudeUi.nativeUi.openSession = async (sessionId, cwd) => {
    keys.events.push('open start');
    // The webview takes focus with its tab, a moment into the open (S1b).
    await new Promise((resolve) => setTimeout(resolve, 20));
    keys.events.push('open done');
    return open(sessionId, cwd);
  };

  await keys.press();
  assert.deepEqual(keys.events, ['open start', 'open done', 'focus list'], 'refocused once, after the awaited open');
  assert.deepEqual(f.claudeUi.opened.map((entry) => entry.sessionId), ['claude-1']);
});

test('the marker is consumed once: a later plain click does not refocus', async (t) => {
  const f = setup(t, { surface: 'ui' });
  const first = f.chat('claude', 'First', 'claude-1');
  const second = f.chat('claude', 'Second', 'claude-2');
  const keys = listKeys(f.row(first));

  await keys.press();
  assert.deepEqual(keys.events, ['focus list']);
  await runCommand('pitwall.openChat', f.row(second));
  assert.deepEqual(f.claudeUi.opened.map((entry) => entry.sessionId), ['claude-1', 'claude-2']);
  assert.deepEqual(keys.events, ['focus list'], 'a click lets the chat take focus');
});

test('terminal path calls show(true) only when the marker is set', async (t) => {
  const f = setup(t, { surface: 'terminal' });
  const first = f.chat('claude', 'First', 'claude-1');
  const second = f.chat('claude', 'Second', 'claude-2');
  const keys = listKeys(f.row(first));

  await keys.press();
  const keyed = f.lastTerminal();
  assert.equal(keyed.sent[0], 'claude --resume claude-1');
  assert.equal(stub.window.__focusedTerminal, undefined, 'Ctrl+Down keeps the list focused');

  keys.events.length = 0;
  await keys.press();
  assert.deepEqual([stub.window.terminals.length, keyed.shown], [1, 2], 'the live terminal is revealed');
  assert.deepEqual(keys.events, ['focus list'], 'an existing terminal is revealed, then the list is refocused (E8)');

  await runCommand('pitwall.openChat', f.row(second));
  assert.equal(stub.window.__focusedTerminal, f.lastTerminal(), 'a click focuses its terminal');
  assert.notEqual(f.lastTerminal(), keyed);
});

const MOVES_AFTER_THE_PRESS: [string, () => void][] = [
  ['an editor took focus', () => stub.window.__focusTextEditor({ document: { uri: vscode.Uri.file('/work/demo/file.ts') } })],
  ['a different terminal became active', () => stub.window.__focusTerminal(stub.window.createTerminal({ name: 'user shell' }))],
  ['the window lost focus', () => stub.window.__fireWindowState(false)],
];

for (const [moved, move] of MOVES_AFTER_THE_PRESS) {
  test(`Ctrl+Down onto an open terminal does not refocus the list when ${moved} after the key press (E8)`, async (t) => {
    const f = setup(t, { surface: 'terminal' });
    const chat = f.chat('claude', 'Already open', 'claude-1');
    const keys = listKeys(f.row(chat));
    await keys.press();
    const live = f.lastTerminal();
    const show = live.show.bind(live);
    let moving = true;
    live.show = (preserveFocus?: boolean) => {
      show(preserveFocus);
      if (moving) move();
    };
    t.after(() => stub.window.__fireWindowState(true));
    keys.events.length = 0;

    await keys.press();
    await settle();
    assert.deepEqual(keys.events, [], 'the list does not take focus back from where the user went');

    // A mouse click carries no Ctrl+Down marker: it never refocuses the list.
    moving = false;
    await runCommand('pitwall.openChat', f.row(chat));
    assert.deepEqual(keys.events, [], 'a click lets the chat take focus');
  });
}

test('Ctrl+Down onto a chat whose panel tab is already open reveals it, then refocuses the list (E8)', async (t) => {
  const f = setup(t, { surface: 'ui' });
  const chat = f.chat('claude', 'Open in panel', 'claude-1');
  f.claudeUi.surfaces.open.add('claude-1');
  const keys = listKeys(f.row(chat));

  await keys.press();
  assert.deepEqual(f.claudeUi.opened.map((entry) => entry.sessionId), ['claude-1'], 'the open tab is revealed');
  assert.deepEqual(keys.events, ['focus list'], 'refocused once after the reveal');
});

const afterSettle = () => new Promise((resolve) => setTimeout(resolve, 450));

/** A Ctrl+Down onto an open panel tab; the revealed webview activates a moment after the first refocus. */
async function panelPress(t: Parameters<typeof setup>[0], between?: () => void) {
  // Earlier tests' panel retries are still pending (their command is not this test's); let them end first.
  await afterSettle();
  const f = setup(t, { surface: 'ui' });
  const chat = f.chat('claude', 'Open in panel', 'claude-1');
  f.claudeUi.surfaces.open.add('claude-1');
  const keys = listKeys(f.row(chat));
  t.after(() => stub.window.__fireWindowState(true));
  await keys.press();
  assert.deepEqual(keys.events, ['focus list'], 'refocused right after the reveal');
  // The tab becomes active, then Claude's webview takes focus.
  stub.window.__fireTabsChanged({ changed: [{}] });
  between?.();
  await afterSettle();
  return keys;
}

test('Ctrl+Down onto an open panel tab refocuses the list once more after the webview activates (E8)', async (t) => {
  const keys = await panelPress(t);
  assert.deepEqual(keys.events, ['focus list', 'focus list'], 'one retry, never a loop');
});

test('the panel retry does not run once the user moved (E8)', async (t) => {
  const editor = { document: { uri: vscode.Uri.file('/work/demo/file.ts') } };
  const keys = await panelPress(t, () => stub.window.__focusTextEditor(editor));
  assert.deepEqual(keys.events, ['focus list'], 'the editor keeps focus');
});

test('the panel retry lets go when the window lost focus or a second tab change came (E8)', async (t) => {
  const blurred = await panelPress(t, () => stub.window.__fireWindowState(false));
  assert.deepEqual(blurred.events, ['focus list']);
  const second = await panelPress(t, () => stub.window.__fireTabsChanged({ changed: [{}] }));
  assert.deepEqual(second.events, ['focus list'], 'a second tab change means the user moved');
});

test('Ctrl+Down onto a chat with no terminal creates it, renames it, then refocuses the list', async (t) => {
  const f = setup(t, { surface: 'terminal' });
  const chat = f.chat('claude', 'Reply', 'claude-1');
  const other = f.chat('claude', 'Other', 'claude-2');
  const keys = listKeys(f.row(chat));
  // As live (E8): creating a terminal focuses it despite show(true).
  const create = stub.window.createTerminal;
  stub.window.createTerminal = (options) => {
    const terminal = create(options);
    stub.window.__focusTerminal(terminal);
    return terminal;
  };
  t.after(() => {
    stub.window.createTerminal = create;
  });
  // renameWithArg renames the terminal with keyboard focus, so it must run before the refocus (F4).
  vscode.commands.registerCommand('workbench.action.terminal.renameWithArg', (arg: { name: string }) => {
    keys.events.push(`rename ${stub.window.__focusedTerminal?.name ?? 'nothing'} -> ${arg.name}`);
    const target = stub.window.__focusedTerminal ?? stub.window.activeTerminal;
    if (target) target.name = arg.name;
  });

  await keys.press();
  const created = f.lastTerminal();
  assert.equal(created.sent[0], 'claude --resume claude-1');
  const order = keys.events.join(' | ');
  assert.ok(keys.events.some((event) => /^rename .* -> Pitwall: Reply/.test(event)), `the new terminal is renamed: ${order}`);
  const firstFocus = keys.events.indexOf('focus list');
  assert.ok(firstFocus > 0 && /^rename /.test(keys.events[firstFocus - 1]), `the first refocus follows the creation's rename: ${order}`);
  assert.equal(keys.events.at(-1), 'focus list', `the last refocus comes after every rename: ${order}`);
  assert.match(created.name, /^Pitwall: Reply/);

  keys.events.length = 0;
  await runCommand('pitwall.openChat', f.row(other));
  assert.ok(!keys.events.includes('focus list'), 'a plain click onto a new terminal leaves focus there');
});

/** Creating a terminal focuses it despite show(true), as live (E8). */
function terminalsTakeFocus(t: { after(fn: () => void): void }) {
  const create = stub.window.createTerminal;
  stub.window.createTerminal = (options) => {
    const terminal = create(options);
    stub.window.__focusTerminal(terminal);
    return terminal;
  };
  t.after(() => {
    stub.window.createTerminal = create;
  });
}

test('a focus change during the rename queues a second title write, and the list is refocused only after it (N5)', async (t) => {
  const f = setup(t, { surface: 'terminal' });
  terminalsTakeFocus(t);
  const events: string[] = [];
  let calls = 0;
  let focusOnCall = -1;
  vscode.commands.registerCommand('workbench.action.terminal.renameWithArg', (arg: { name: string }) => {
    calls += 1;
    events.push(`rename ${calls}`);
    const target = stub.window.__focusedTerminal ?? stub.window.activeTerminal;
    if (target) target.name = arg.name;
    // The user clicks the terminal while a title write runs: that focus
    // change queues one more title write behind it.
    if (calls === focusOnCall && target) {
      stub.window.__focusTerminal(target);
    }
  });
  const firstFocus = () => events.indexOf('focus list');

  // Calibrate: how many renames a keyed open of a new terminal makes before
  // its first refocus.
  const calibrate = listKeys(f.row(f.chat('claude', 'Calibrate', 'claude-0')));
  vscode.commands.registerCommand('pitwall.workspacesView.focus', () => void events.push('focus list'));
  await calibrate.press();
  const before = events.slice(0, firstFocus()).length;
  assert.ok(before >= 1, `a new terminal is renamed before the refocus: ${events.join(' | ')}`);

  events.length = 0;
  calls = 0;
  focusOnCall = before;
  const keys = listKeys(f.row(f.chat('claude', 'Reply', 'claude-1')));
  vscode.commands.registerCommand('pitwall.workspacesView.focus', () => void events.push('focus list'));
  await keys.press();

  const order = events.join(' | ');
  assert.ok(firstFocus() > 0, order);
  assert.deepEqual(
    events.slice(firstFocus() - 2, firstFocus() + 1),
    [`rename ${before}`, `rename ${before + 1}`, 'focus list'],
    `rename ${before} → rename ${before + 1} → focus: ${order}`
  );
});

/** A Ctrl+↓ onto a chat whose new terminal's shell integrates late (Windows PowerShell 5.1). */
async function slowShellPress(f: ReturnType<typeof setup>, chat: ChatSession) {
  const keys = listKeys(f.row(chat));
  let done = false;
  const press = keys.press().then(() => {
    done = true;
  });
  await waitFor(() => keys.events.includes('focus list'), 'the refocus right after the terminal is created', 1_000);
  assert.equal(done, false, 'the list is refocused before the 2 s wait for the shell ends');
  await press;
  return { keys, terminal: f.lastTerminal() };
}

/** Let a late start, its queued title work and any restore run out. */
async function settle() {
  for (let turn = 0; turn < 20; turn++) await flush();
}

test('a new terminal whose shell never reports integration still gets the list back at once (E8)', async (t) => {
  stub.__setLateShellIntegration(true);
  const f = setup(t, { surface: 'terminal' });
  const { keys, terminal } = await slowShellPress(f, f.chat('claude', 'Never integrates', 'claude-1'));
  assert.equal(terminal.sent[0], 'claude --resume claude-1');
  assert.deepEqual(keys.events, ['focus list'], 'once, with no title write in flight');
});

test('an sdk-cli chat on surface ui falls back to a new terminal and still gets the list back at once (E8)', async (t) => {
  stub.__setLateShellIntegration(true);
  const f = setup(t, { surface: 'ui' });
  f.claudeUi.nativeUi.resumeRefusal = async () => SDK_REFUSAL;
  const { keys, terminal } = await slowShellPress(f, f.chat('claude', 'From claude -p', 'sdk-1'));
  assert.equal(terminal.sent[0], 'claude --resume sdk-1');
  assert.deepEqual(f.claudeUi.opened, []);
  assert.deepEqual(keys.events, ['focus list']);
});

test('a shell that integrates late: the list is refocused at once and again after the late rename when nothing moved', async (t) => {
  stub.__setLateShellIntegration(true);
  const f = setup(t, { surface: 'terminal' });
  let renames: string[] = [];
  vscode.commands.registerCommand('workbench.action.terminal.renameWithArg', (arg: { name: string }) => {
    renames.push('rename');
    if (stub.window.activeTerminal) stub.window.activeTerminal.name = arg.name;
  });
  const { keys, terminal } = await slowShellPress(f, f.chat('claude', 'Slow shell', 'claude-1'));
  keys.events.length = 0;
  renames = keys.events;
  stub.window.__integrateShell(terminal);
  await waitFor(() => keys.events.includes('focus list'), 'the restore after the late rename');
  assert.deepEqual(keys.events.slice(-2), ['rename', 'focus list'], 'the late rename drops focus; the list gets it back');
});

test('a late rename does not refocus the list after the user moved on', async (t) => {
  stub.__setLateShellIntegration(true);
  const f = setup(t, { surface: 'terminal' });
  vscode.commands.registerCommand('workbench.action.terminal.renameWithArg', (arg: { name: string }) => {
    if (stub.window.activeTerminal) stub.window.activeTerminal.name = arg.name;
  });
  const claudeTab = { label: 'Other chat', input: new vscode.TabInputWebview('mainThreadWebview-claudeVSCodePanel'), isActive: true };
  /** A keyed slow-shell open, `meanwhile`, then the late rename; the refocus calls the late rename made. */
  const lateOpen = async (name: string, sessionId: string, meanwhile: () => Promise<unknown> | void) => {
    const { keys, terminal } = await slowShellPress(f, f.chat('claude', name, sessionId));
    await meanwhile();
    keys.events.length = 0;
    stub.window.__integrateShell(terminal);
    await settle();
    return keys.events;
  };

  const editor = { document: { uri: vscode.Uri.file('/work/demo/file.ts') } };
  assert.deepEqual(await lateOpen('Went to a file', 'claude-1', () => stub.window.__focusTextEditor(editor)), [], 'a file took focus');
  assert.deepEqual(
    await lateOpen('Went to a Claude tab', 'claude-2', () => {
      stub.window.tabGroups.all = [{ isActive: true, viewColumn: 1, activeTab: claudeTab, tabs: [claudeTab] }];
      stub.window.__fireTabsChanged({ changed: [claudeTab] });
    }),
    [],
    'a Claude panel tab became active'
  );
  assert.deepEqual(
    await lateOpen('Another terminal', 'claude-3', () => stub.window.__focusTerminal(stub.window.createTerminal({ name: 'user shell' }))),
    [],
    'another terminal took focus'
  );
  assert.deepEqual(await lateOpen('Left the window', 'claude-4', () => stub.window.__fireWindowState(false)), [], 'the window lost focus');
  stub.window.__fireWindowState(true);
  assert.deepEqual(
    await lateOpen('Opened another chat', 'claude-5', () => runCommand('pitwall.openClaudeUi', f.row(f.chat('claude', 'In the panel', 'claude-ui')))),
    [],
    'another Pitwall open started'
  );
});

// Carried from T2 (QA #47): the move-watchers are armed at the key press, not
// after the 'now' refocus, so the 'now' refocus also skips when an editor, a tab
// or another terminal became active since the press.
test('an editor click between Ctrl+Down and the refocus keeps focus in the editor', async (t) => {
  stub.__setLateShellIntegration(true);
  const f = setup(t, { surface: 'terminal' });
  vscode.commands.registerCommand('workbench.action.terminal.renameWithArg', (arg: { name: string }) => {
    if (stub.window.activeTerminal) stub.window.activeTerminal.name = arg.name;
  });
  const editor = { document: { uri: vscode.Uri.file('/work/demo/file.ts') } };
  // The user clicks into a file while the new terminal is still being created.
  const create = stub.window.createTerminal;
  stub.window.createTerminal = (options) => {
    const terminal = create(options);
    stub.window.__focusTextEditor(editor);
    return terminal;
  };
  t.after(() => {
    stub.window.createTerminal = create;
  });
  const keys = listKeys(f.row(f.chat('claude', 'Clicked away', 'claude-1')));

  await keys.press();
  await settle();
  assert.deepEqual(keys.events, [], 'the list does not take focus back from the editor');
  stub.window.__integrateShell(f.lastTerminal());
  await settle();
  assert.deepEqual(keys.events, [], 'nor after the late rename');
});

test('the late-refocus hold also lets go when a Claude panel tab becomes active', async (t) => {
  stub.__setLateShellIntegration(true);
  const f = setup(t, { surface: 'terminal' });
  vscode.commands.registerCommand('workbench.action.terminal.renameWithArg', (arg: { name: string }) => {
    if (stub.window.activeTerminal) stub.window.activeTerminal.name = arg.name;
  });
  const { keys, terminal } = await slowShellPress(f, f.chat('claude', 'Then a Claude tab', 'claude-1'));
  keys.events.length = 0;

  // The Claude tab sits in another editor group: clicking it makes that group
  // active, which fires only a tab-group event, not a tab event.
  const claudeTab = { label: 'Other chat', input: new vscode.TabInputWebview('mainThreadWebview-claudeVSCodePanel'), isActive: true };
  stub.window.tabGroups.all = [
    { isActive: false, viewColumn: 1, activeTab: undefined, tabs: [] },
    { isActive: true, viewColumn: 2, activeTab: claudeTab, tabs: [claudeTab] },
  ];
  stub.window.__fireTabGroupsChanged();
  stub.window.__integrateShell(terminal);
  await settle();
  assert.deepEqual(keys.events, [], 'no late restore over the Claude tab');
});

// Q27 (T3 live): the user typed "xyz" into a brand-new terminal before Pitwall
// sent its line, and the shell ran `xyzclaude --resume …`.
test('a line typed into a new terminal before the resume command is cleared first', async (t) => {
  const f = setup(t, { surface: 'terminal' });
  const create = stub.window.createTerminal;
  stub.window.createTerminal = (options) => {
    const terminal = create(options);
    stub.window.__typeKeys(terminal, 'xyz');
    return terminal;
  };
  t.after(() => {
    stub.window.createTerminal = create;
  });
  // PSReadLine's default edit mode is Windows on Windows (Esc reverts the
  // line) but Emacs elsewhere (Esc is a meta prefix there, Ctrl+U clears).
  const shells: [string, string][] = [
    ['/bin/bash', '\x15'],
    ['/usr/bin/zsh', '\x15'],
    ['C:\\Program Files\\Git\\bin\\bash.exe', '\x15'],
    ['C:\\Windows\\System32\\cmd.exe', '\x1b'],
    ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', process.platform === 'win32' ? '\x1b' : '\x15'],
    ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', process.platform === 'win32' ? '\x1b' : '\x15'],
  ];
  for (const [index, [shell, clear]] of shells.entries()) {
    stub.__setShell(shell);
    await runCommand('pitwall.openChat', f.row(f.chat('claude', `Shell ${index}`, `claude-${index}`)));
    const terminal = f.lastTerminal();
    // The clear goes alone, with no newline, and the command in a send of its
    // own: Esc followed at once by "c" could read as Alt+C.
    assert.deepEqual(
      terminal.typed.slice(0, 2),
      [clear, `claude --resume claude-${index}\n`],
      `${shell}: its line-clear, then the command`
    );
    assert.equal(terminal.sent[0], `claude --resume claude-${index}`, `${shell}: the stray keys are gone from the line the shell runs`);
  }
});

test('after closing its Claude tab, a terminal-surface open uses the terminal', async (t) => {
  const f = setup(t, { surface: 'terminal' });
  const chat = f.chat('claude', 'Lab ready', 'claude-1');
  const surfaces = claudeUiSurfaces();
  t.after(() => surfaces.dispose());
  (f.claudeUi.nativeUi as { surfaces?: unknown }).surfaces = surfaces;
  const panelTab = () => ({ label: 'Lab ready', input: new vscode.TabInputWebview('mainThreadWebview-claudeVSCodePanel'), isActive: true });
  const group: { isActive: boolean; viewColumn: number; activeTab: unknown; tabs: unknown[] } = { isActive: true, viewColumn: 1, activeTab: undefined, tabs: [] };
  stub.window.tabGroups.all = [group];
  const open = f.claudeUi.nativeUi.openSession;
  f.claudeUi.nativeUi.openSession = async (sessionId, cwd) => {
    const tab = panelTab();
    group.tabs = [tab];
    group.activeTab = tab;
    stub.window.__fireTabsChanged({ opened: [tab] });
    return open(sessionId, cwd);
  };

  await runCommand('pitwall.openClaudeUi', f.row(chat));
  assert.ok(surfaces.isOpen('claude-1'), 'the panel tab is bound');

  // A tab-model refresh rebuilds the Tab objects; then the user closes the tab.
  const rebuilt = panelTab();
  group.tabs = [rebuilt];
  group.activeTab = rebuilt;
  stub.window.__fireTabGroupsChanged();
  group.tabs = [];
  group.activeTab = undefined;
  stub.window.__fireTabsChanged({ closed: [rebuilt] });
  assert.equal(surfaces.isOpen('claude-1'), false);

  const keys = listKeys(f.row(chat));
  await keys.press();
  assert.equal(f.lastTerminal()?.sent[0], 'claude --resume claude-1', 'Ctrl+Down opens a terminal');
  assert.equal(f.claudeUi.opened.length, 1, 'not the closed panel again');
});

test("a click on a chat whose tab the editor restored binds that tab, waiting for the folder's titles, and binds no other tab (I1, I1b)", async (t) => {
  const f = setup(t, { surface: 'ui' });
  const chat = f.chat('claude', 'reply with exactly: lab c one', 'claude-1');
  const surfaces = claudeUiSurfaces();
  t.after(() => surfaces.dispose());
  (f.claudeUi.nativeUi as { surfaces?: unknown }).surfaces = surfaces;
  const panelTab = (label: string) => ({ label, input: new vscode.TabInputWebview('mainThreadWebview-claudeVSCodePanel'), isActive: false });
  // After a reload: the other chat's restored tab is in front; this chat's is behind it.
  const mine = panelTab('Lab C one');
  const other = panelTab('Lab C two');
  const group = { isActive: true, viewColumn: 1, activeTab: other, tabs: [mine, other] };
  stub.window.tabGroups.all = [group];
  // The folder's listing is still running when the click lands.
  let land: () => void = () => undefined;
  const titles: { sessionId: string; titles: string[] }[] = [];
  surfaces.setTitleSource(() => titles, new Promise<void>((resolve) => (land = resolve)));
  f.claudeUi.nativeUi.openSession = async () => ({ kind: 'opened', via: 'command' }); // the panel reveals the tab it has
  const click = runCommand('pitwall.openChat', f.row(chat));
  await flush();
  titles.push({ sessionId: 'claude-1', titles: ['Lab C one'] }, { sessionId: 'claude-2', titles: ['Lab C two'] });
  land();
  await click;
  assert.deepEqual(
    surfaces.describeTabs()[0].tabs.map((tab) => tab.sessionId),
    ['claude-1', 'claude-2'],
    'each restored tab bound to its own chat, never the front one to the clicked chat'
  );
});

test('a new UI session is a placeholder the importer links; a failed open leaves no row behind', async (t) => {
  const f = setup(t);
  await runCommand('pitwall.newClaudeChatInUi', f.worktreeRow(f.main));
  const [placeholder] = f.chatsIn(f.main);
  assert.deepEqual([placeholder.pendingUiLaunch, placeholder.harnessSessionId, stub.window.terminals.length], [true, null, 0]);
  assert.deepEqual(f.claudeUi.opened, [{ cwd: f.main.path }]);

  f.sessions.claude.push(sessionRecord('claude', 'ui-created', { cwd: f.main.path, summary: 'UI Created' }));
  await waitFor(() => f.storage.getChat(placeholder.id)?.harnessSessionId, 'the importer to link it');
  const linked = f.storage.getChat(placeholder.id)!;
  assert.deepEqual([linked.name, linked.pendingUiLaunch], ['UI Created', false]);

  f.claudeUi.nativeUi.openNewSession = async (): Promise<NativeUiOpenResult> => ({ kind: 'failed', message: 'extension host gone' });
  await runCommand('pitwall.newClaudeChatInUi', f.worktreeRow(f.main));
  assert.equal(f.chatsIn(f.main).length, 1);
  assert.ok(shown('extension host gone'));
});

test('Fork Session numbers the fork; a linked fork resumes its new ID, a terminal fork chooses one and keeps its source', async (t) => {
  const f = setup(t);
  const claude = f.chat('claude', 'Fix icons', 'claude-1');
  const codex = f.chat('codex', 'Fix icons (1)', 'codex-1');

  await runCommand('pitwall.forkChat', f.row(claude));
  const claudeFork = f.chatsIn(f.main).find((chat) => chat.name === 'Fix icons (2)')!;
  assert.deepEqual(
    [claudeFork.harnessSessionId, claudeFork.pendingHarnessSessionId, claudeFork.forkedFromSessionId],
    [null, 'pending-fork-1', 'claude-1']
  );
  assert.equal(f.lastTerminal().sent[0], 'claude --fork claude-1 --session-id pending-fork-1');
  assert.ok(f.registrations.includes(claudeFork.id));

  await runCommand('pitwall.forkChat', f.row(codex));
  const codexFork = f.chatsIn(f.main).find((chat) => chat.name === 'Fix icons (1) (1)')!;
  assert.equal(codexFork.harnessSessionId, 'codex-fork');
  assert.equal(f.lastTerminal().sent[0], 'codex --resume codex-fork');
  assert.ok(!f.registrations.includes(codexFork.id), 'nothing left for a watcher to link');

  await runCommand('pitwall.forkChat', f.row(f.chat('claude', 'Unstarted')));
  assert.ok(shown('Cannot fork a session that has not been started yet'));
});

test('Fork to New Worktree forks into a new branch worktree; a failed fork or a plain folder creates no chat', async (t) => {
  const f = setup(t);
  const opencode = f.chat('opencode', 'Plan', 'ses_1');
  stub.__inputResponses.push('feature-fork', '/work/demo-feature-fork');
  await runCommand('pitwall.forkChatWithChanges', f.row(opencode));
  const created = f.worktrees.find((worktree) => worktree.name === 'feature-fork')!;
  assert.deepEqual(f.chatsIn(created).map((chat) => [chat.name, chat.harnessSessionId]), [['Plan (1)', 'ses_fork']]);
  assert.equal(f.lastTerminal().sent[0], 'opencode --resume ses_fork');

  f.adapters.opencode.prepareForkToNewWorktree = async () => {
    throw new Error('move failed');
  };
  stub.__inputResponses.push('feature-broken', '/work/demo-broken');
  await runCommand('pitwall.forkChatWithChanges', f.row(opencode));
  assert.ok(shown('Failed to fork the opencode session into the new worktree: move failed'));
  assert.deepEqual(f.chatsIn(f.worktrees.find((worktree) => worktree.name === 'feature-broken')!), []);

  const inFolder = f.chat('claude', 'Folder', 'claude-folder', f.folder);
  await runCommand('pitwall.forkChatWithChanges', f.row(inFolder));
  assert.ok(shown('plain folder'));
});

test('Import offers only sessions not yet imported, keyed by harness and session ID', async (t) => {
  const f = setup(t);
  const now = Date.now();
  f.sessions.claude.push(sessionRecord('claude', 'shared-id', { cwd: f.main.path, summary: 'Claude one', lastUpdated: new Date(now) }));
  f.sessions.opencode.push(
    sessionRecord('opencode', 'ses_new', { cwd: f.main.path, summary: 'New', lastUpdated: new Date(now - 1000) }),
    sessionRecord('opencode', 'ses_old', { cwd: f.main.path, summary: 'Imported', lastUpdated: new Date(now - 2000) })
  );
  f.chat('opencode', 'Imported', 'ses_old');
  f.chat('opencode', 'Same ID, other harness', 'shared-id');
  f.storage.rememberRemovedSession('opencode', 'ses_new');

  let offered: string[] = [];
  stub.__setQuickPickHandler((items) => {
    offered = items.map((item: { harness: string; session: HarnessSession }) => `${item.harness}:${item.session.sessionId}`);
    return items.filter((item: { harness: string }) => item.harness === 'opencode');
  });
  await runCommand('pitwall.importSessions', f.worktreeRow(f.main));
  assert.deepEqual(offered, ['claude:shared-id', 'opencode:ses_new']);
  assert.equal(f.chatsIn(f.main).find((chat) => chat.harnessSessionId === 'ses_new')?.name, 'New');
  assert.equal(f.storage.getRemovedSessionKeys().size, 0, 'a manual import undoes an earlier removal');
});

test('Go to Next Session That Needs You opens the longest-waiting one, skips a removed chat, and says so when none waits', async (t) => {
  const f = setup(t);
  const waiting = f.chat('claude', 'Waiting', 'claude-1');
  f.needingYou.push('removed-chat', waiting.id);
  await runCommand('pitwall.openNextSessionNeedingYou');
  assert.equal(f.lastTerminal().sent[0], 'claude --resume claude-1');
  assert.deepEqual(f.activated, [waiting.id], 'its row is selected, which clears the flag');

  f.needingYou.length = 0;
  await runCommand('pitwall.openNextSessionNeedingYou');
  assert.ok(shown('No session is waiting for you.'));
});

test('with several session rows selected, Remove, Close, Star and Unstar apply to all of them', async (t) => {
  const f = setup(t);
  const [a, b, other] = [f.chat('claude', 'One', 'claude-1'), f.chat('codex', 'Two', 'codex-1'), f.chat('codex', 'Other', 'codex-2')];
  const rows = [f.row(a), f.row(b)];

  f.storage.toggleStar(a.id);
  await runCommand('pitwall.starChat', rows[1], rows);
  assert.deepEqual([...f.storage.getStarredChatIds()].sort(), [a.id, b.id].sort(), 'an already-starred row stays starred');
  await runCommand('pitwall.unstarChat', rows[0], rows);
  assert.equal(f.storage.getStarredChatIds().size, 0);

  await runCommand('pitwall.openChatInTerminal', rows[0]);
  await runCommand('pitwall.openChatInTerminal', rows[1]);
  await runCommand('pitwall.closeChat', rows[0], rows);
  assert.deepEqual([a, b].map((chat) => f.terminals.isActive(chat.id)), [false, false]);

  stub.__warningResponses.push('Remove');
  await runCommand('pitwall.deleteChat', rows[0], rows);
  assert.ok(shown('Remove 2 sessions from the list?'), 'the confirmation counts and names them');
  assert.ok(shown('• One') && shown('• Two'));
  assert.deepEqual(f.chatsIn(f.main).map((chat) => chat.id), [other.id]);

  // A click on a row outside the selection acts on that row alone.
  const [c, d] = [f.chat('claude', 'Three', 'claude-3'), f.chat('claude', 'Four', 'claude-4')];
  await runCommand('pitwall.starChat', f.row(other), [f.row(c), f.row(d)]);
  assert.deepEqual([...f.storage.getStarredChatIds()], [other.id]);
});

test('Copy Resume Command and Copy Session ID copy a linked session; an unstarted one is explained', async (t) => {
  const f = setup(t);
  const linked = f.chat('claude', 'Linked', 'claude-1');
  await runCommand('pitwall.copyResumeCommand', f.row(linked));
  assert.equal(await vscode.env.clipboard.readText(), `cd ${quoteShellArgument(f.main.path)} && claude --resume claude-1`);
  // Windows' default terminal is PowerShell, where `&&` does not parse.
  stub.__setShell('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  await runCommand('pitwall.copyResumeCommand', f.row(linked));
  assert.equal(
    await vscode.env.clipboard.readText(),
    `Set-Location -LiteralPath '${f.main.path.replace(/'/g, "''")}'; if ($?) { claude --resume claude-1 }`
  );
  await runCommand('pitwall.copySessionId', f.row(linked));
  assert.equal(await vscode.env.clipboard.readText(), 'claude-1');

  await runCommand('pitwall.copySessionId', f.row(f.chat('claude', 'Unstarted')));
  assert.equal(await vscode.env.clipboard.readText(), 'claude-1', 'nothing is copied');
  assert.ok(shown('This session has no ID yet.'));
});

test('run from the keyboard, a row command acts on the selected rows and New Session starts in the worktree on show', async (t) => {
  const f = setup(t);
  stub.__setConfiguration('defaultHarness', 'codex');
  t.after(() => stub.__setConfiguration('defaultHarness', undefined));
  const [a, b] = [f.chat('claude', 'One', 'claude-1'), f.chat('claude', 'Two', 'claude-2')];

  // One selected row: Rename and Copy Resume Command act on it.
  f.selectedRows.push(f.row(a));
  stub.__inputResponses.push('Renamed');
  await runCommand('pitwall.renameChat');
  assert.equal(f.storage.getChat(a.id)?.name, 'Renamed');
  await runCommand('pitwall.copyResumeCommand');
  assert.equal(await vscode.env.clipboard.readText(), `cd ${f.main.path} && claude --resume claude-1`);

  // Several selected rows: Rename does nothing, Remove takes them all; a worktree row in the selection is ignored.
  f.selectedRows.push(f.row(b), f.worktreeRow(f.main));
  await runCommand('pitwall.renameChat');
  assert.equal(f.storage.getChat(a.id)?.name, 'Renamed');
  stub.__warningResponses.push('Remove');
  await runCommand('pitwall.deleteChat');
  assert.deepEqual(f.chatsIn(f.main), []);

  // No row: the default agent starts in the worktree the panels show, without asking.
  f.active.worktree = f.feature;
  await runCommand('pitwall.newDefaultSession');
  assert.deepEqual(f.chatsIn(f.feature).map((chat) => chat.harness), ['codex']);
  assert.equal(f.lastTerminal().options.cwd, f.feature.path);
});

test('Remove and Clear All drop chats only after confirmation, and removed sessions stay out of auto-import', async (t) => {
  const f = setup(t);
  const removed = f.chat('claude', 'Remove me', 'claude-1');
  f.chat('codex', 'Feature one', 'codex-1', f.feature);
  f.chat('codex', 'Feature two', 'codex-2', f.feature);

  stub.__warningResponses.push(undefined);
  await runCommand('pitwall.deleteChat', f.row(removed));
  assert.ok(f.storage.getChat(removed.id), 'cancel keeps the chat');
  stub.__warningResponses.push('Remove');
  await runCommand('pitwall.deleteChat', f.row(removed));
  assert.equal(f.storage.getChat(removed.id), undefined);

  stub.__warningResponses.push('Clear All');
  await runCommand('pitwall.clearWorktreeSessions', f.worktreeRow(f.feature));
  assert.ok(shown('Clear all 2 session(s) from "feature-x"?'));
  assert.deepEqual(f.chatsIn(f.feature), []);
  assert.deepEqual([...f.storage.getRemovedSessionKeys()].sort(), ['claude:claude-1', 'codex:codex-1', 'codex:codex-2']);
});
