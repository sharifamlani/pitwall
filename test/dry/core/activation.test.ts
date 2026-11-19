/**
 * Extension activation and terminal restore: what `activate()` waits for, and
 * what a restore start reveals in the sidebar.
 */
import { beforeEach, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import pkg from '../../../package.json';
import { HIDDEN_LIST_START_MS, activate } from '../../../src/extension';
import { SessionImportService } from '../../../src/core/services/SessionImportService';
import { RepoDiscoveryService } from '../../../src/core/services/RepoDiscoveryService';
import { NotificationService } from '../../../src/core/services/NotificationService';
import { localPidDomain } from '../../../src/harnesses/claude/ClaudeSessionsFile';
import { ChatSession, Repository, STORAGE_KEYS } from '../../../src/core/types';
import { worktreeId } from '../../../src/core/services/GitService';
import { encodeClaudeProjectPath } from '../../../src/harnesses/claude/paths';
import { disposeOperationLog } from '../../../src/core/services/OperationLog';
import { PROCESS_ID_TIMEOUT_MS } from '../../../src/core/services/terminalEvents';
import { chatRecord, flush, makeStorage, memento, setEnv, shownMessages, stub, tempDir, waitFor } from '../support';

beforeEach(() => stub.__reset());

/** Activate the extension over seeded storage; everything it registers is disposed when the test ends. */
async function seededActivation(
  t: { after(fn: () => unknown): void },
  chats: Partial<ChatSession>[],
  pids: Record<string, number>,
  repositories: Repository[] = []
) {
  const claudeDir = tempDir(t, 'pitwall-claude-');
  setEnv(t, { CLAUDE_CONFIG_DIR: claudeDir });
  const globalState = memento();
  const workspaceState = memento();
  await globalState.update(STORAGE_KEYS.CHATS, chats.map((chat) => chatRecord(chat)));
  await globalState.update(STORAGE_KEYS.REPOSITORIES, repositories);
  const seed = makeStorage(globalState, workspaceState);
  for (const [chatId, pid] of Object.entries(pids)) await seed.rememberTerminalPid(chatId, pid);
  const context = {
    subscriptions: [] as { dispose(): unknown }[],
    globalState,
    workspaceState,
    extensionUri: vscode.Uri.file('/extension'),
    extension: { id: 'sharifamlani.pitwall' },
  };
  let activation: Promise<unknown> | undefined;
  t.after(async () => {
    await activation?.catch(() => undefined);
    context.subscriptions.forEach((subscription) => subscription.dispose());
  });
  return {
    context,
    /** The Claude profile the extension reads (CLAUDE_CONFIG_DIR). */
    claudeDir,
    start: () => (activation = activate(context as never)),
    /** The chats storage holds now. */
    storedChats: () => globalState.get<ChatSession[]>(STORAGE_KEYS.CHATS, []),
    /** The chat whose row the extension selected last. */
    activeChatId: () => globalState.get<string | undefined>(STORAGE_KEYS.ACTIVE_CHAT, undefined),
  };
}

test('activation settles while a restored tab’s PID is still pending (R1(a))', async (t) => {
  const f = await seededActivation(t, [{ id: '40de4f00-lab', name: 'Lab ready', harnessSessionId: 'lab', status: 'active' }], {
    '40de4f00-lab': 82260,
  });
  // A reload's surviving pty whose PID the editor has not reported yet.
  stub.window.createTerminal({ name: 'Pitwall: Lab ready [40de4f]', __pid: 82260, __pidDelayMs: Infinity });

  const settled = await Promise.race([
    f.start().then(() => 'settled' as const),
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), PROCESS_ID_TIMEOUT_MS / 4)),
  ]);
  assert.equal(settled, 'settled', 'activate() does not wait for a PID read');
});

test('a chat revealed while the sidebar is hidden is revealed only once the sidebar shows and the tree settles (L1)', async (t) => {
  const f = await seededActivation(t, [{ id: '40de4f00-lab', name: 'Lab ready', harnessSessionId: 'lab', status: 'active' }], {
    '40de4f00-lab': 82260,
  });
  const lab = stub.window.createTerminal({ name: 'Pitwall: Lab ready [40de4f]', __pid: 82260 });
  await f.start();
  const view = stub.__treeViews.find((candidate) => candidate.id === 'pitwall.workspacesView')!;
  // The surviving tab is adopted (its PID is the recorded one); the user then focuses it.
  await flush();
  await flush();
  stub.window.__focusTerminal(lab);
  await flush();
  await flush();
  assert.deepEqual(view.reveals, [], 'nothing is revealed into a hidden view, whose rows do not exist yet');

  view.__setVisible(true);
  await waitFor(() => view.reveals.length > 0, 'the deferred reveal once the view shows');
  await flush();
  assert.equal(view.reveals.length, 1, 'revealed once');
});

/**
 * A plain folder holding the chats, so a chat's row has a parent row the
 * workbench must expand to reveal it (as the live lab's repository row).
 */
function labFolder(t: { after(fn: () => unknown): void }): { repository: Repository; worktreeId: string } {
  const rootPath = tempDir(t, 'pitwall-lab-');
  const repository = { id: 'lab-repo', name: 'lab', rootPath } as Repository;
  return { repository, worktreeId: worktreeId(repository.id, rootPath) };
}

test('a reveal never asks for a row that a refresh of the Workspaces view dropped meanwhile (L1)', async (t) => {
  stub.__setTreeViewsVisible(true);
  const lab = labFolder(t);
  const f = await seededActivation(
    t,
    [{ id: '40de4f00-lab', name: 'Lab ready', harnessSessionId: 'lab', status: 'active', worktreeId: lab.worktreeId }],
    { '40de4f00-lab': 82260 },
    [lab.repository]
  );
  const tab = stub.window.createTerminal({ name: 'Pitwall: Lab ready [40de4f]', __pid: 82260 });
  await f.start();
  const view = stub.__treeViews.find((candidate) => candidate.id === 'pitwall.workspacesView')!;
  // A busy window at startup: the workbench expands the parent rows well
  // after the extension host resolved them (UJ run 11: 2.5 s after a start).
  view.__revealRoundTripMs = 600;
  view.__renderDelayMs = 600;
  // The surviving tab is adopted (its PID is the recorded one).
  for (let i = 0; i < 5; i++) await flush();

  stub.window.__focusTerminal(tab); // the user's focus selects the chat's row
  await waitFor(() => view.reveals.length > 0, 'the reveal to start');
  // A refresh lands while the workbench is still expanding the parent rows
  // (a terminal opening, a turn ending, a PR badge arriving).
  await vscode.commands.executeCommand('pitwall.refreshWorkspaces');
  await waitFor(() => view.revealsDone >= view.reveals.length, 'the reveal to finish', 3_000);
  assert.deepEqual(view.treeErrors, [], 'every row the reveal expands still exists');
});

test('a tab Pitwall shows to rename it never selects or reveals that chat; the user’s own tab still does (R44)', async (t) => {
  stub.__setTreeViewsVisible(true);
  const lab = labFolder(t);
  const f = await seededActivation(
    t,
    [
      { id: 'a1b2c300-front', name: 'Front', harnessSessionId: 'front', status: 'active', worktreeId: lab.worktreeId },
      { id: 'd4e5f600-back', name: 'Back', harnessSessionId: 'back', status: 'active', worktreeId: lab.worktreeId },
    ],
    { 'a1b2c300-front': 7801, 'd4e5f600-back': 7802 },
    [lab.repository]
  );
  const front = stub.window.createTerminal({ name: 'Pitwall: Front [a1b2c3]', __pid: 7801 });
  // The reload re-tagged the background tab's title as the shell's, so Pitwall
  // shows it (without focus) to rename it, then shows the front tab again.
  const back = stub.window.createTerminal({ name: 'powershell', __pid: 7802 });
  // The workbench puts a shown editor terminal's tab in front and reports a tab change.
  const tabFor = (terminal: { name: string }, isActive: boolean) => ({
    get label() {
      return terminal.name;
    },
    input: new vscode.TabInputTerminal(),
    isPreview: false,
    isActive,
  });
  const putInFront = (shown: unknown) => {
    if (!shown) return;
    const tabs = stub.window.terminals.map((terminal) => tabFor(terminal, (terminal as unknown) === shown));
    stub.window.tabGroups.all = [{ isActive: true, viewColumn: 1, tabs, activeTab: tabs.find((tab) => tab.isActive) }];
  };
  // The rename command targets the active terminal, like the workbench with no terminal focused.
  vscode.commands.registerCommand('workbench.action.terminal.renameWithArg', (arg: { name: string }) => {
    if (stub.window.activeTerminal) stub.window.activeTerminal.name = arg.name;
  });
  stub.window.__setActiveTerminal(front);
  putInFront(front);
  const following = vscode.window.onDidChangeActiveTerminal((terminal) => {
    putInFront(terminal);
    stub.window.__fireTabsChanged();
  });
  t.after(() => following.dispose());

  await f.start();
  const view = stub.__treeViews.find((candidate) => candidate.id === 'pitwall.workspacesView')!;
  const backTitle = 'Pitwall: Back [d4e5f6]';
  await waitFor(() => back.name === backTitle && stub.window.activeTerminal === front, 'the background rename and the return to the front tab');
  const revealed = () => view.reveals.map((reveal) => (reveal.item as { data: { id: string } }).data.id);
  // Reveals wait for the tree to render after the latest refresh. Putting the
  // front tab back is the last tab change, so its reveal comes last.
  await waitFor(() => revealed().includes('a1b2c300-front'), 'the front tab’s reveal');
  for (let i = 0; i < 5; i++) await flush();
  assert.ok(!revealed().includes('d4e5f600-back'), `the tab Pitwall showed is never revealed (revealed: ${revealed().join(', ')})`);
  assert.notEqual(f.activeChatId(), 'd4e5f600-back', 'nor selected');

  stub.window.__focusTerminal(back); // the user clicks it
  await waitFor(() => revealed().includes('d4e5f600-back'), 'the user’s own click reveals it');
  assert.equal(f.activeChatId(), 'd4e5f600-back');
});

interface WorkspaceRow {
  description?: string;
}

// Phase 3 asserted here that FILES followed the clicked repo and the opened
// chat. Q8 (row 4.7) keeps FILES on this window's folder instead; that is
// tested in files-cross-repo.test.ts.
test('the list header and the order diagnostic, with a linked-worktree chat', async (t) => {
  stub.__setTreeViewsVisible(true);
  const scratch = tempDir(t);
  const repoPath = path.join(scratch, 'app');
  const linkedPath = path.join(scratch, 'app-fiu');
  fs.mkdirSync(repoPath);
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repoPath });
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat/fiu', linkedPath], { cwd: repoPath });
  const repository = { id: 'repo-app', name: 'app', rootPath: repoPath } as Repository;
  disposeOperationLog();
  t.after(disposeOperationLog);
  const logged: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logged.push(args.map(String).join(' '));
  t.after(() => {
    console.log = original;
  });
  const f = await seededActivation(
    t,
    [
      {
        id: 'f1u00000-chat',
        name: 'Worktree chat',
        harnessSessionId: 'fiu',
        worktreeId: worktreeId(repository.id, linkedPath),
        // Recent, so the session scan's retention keeps it.
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
      },
    ],
    {},
    [repository]
  );
  await f.start();
  const list = stub.__treeViews.find((candidate) => candidate.id === 'pitwall.workspacesView')!;
  const files = stub.__treeViews.find((candidate) => candidate.id === 'pitwall.filesView')!;
  assert.equal(list.description, 'sorted by who needs you');
  const rows = list.options.treeDataProvider!;
  await rows.getChildren();
  // Rows drawn once git has listed the repo, not from its plain-folder stand-in.
  await (rows as unknown as { whenListed(): Promise<void> }).whenListed();
  const [repoRow] = (await rows.getChildren()) as WorkspaceRow[];
  const operations = stub.__outputChannels.find((channel: { name: string }) => channel.name === 'Pitwall Operations');
  assert.ok(
    operations?.lines.some((line: string) => line.includes('[Pitwall] order repo-app')),
    'the order diagnostic goes to the Pitwall Operations output channel'
  );
  assert.ok(!logged.some((line) => line.startsWith('[Pitwall] order')), 'and not to console.log');

  const [chatRow] = (await rows.getChildren(repoRow)) as WorkspaceRow[];
  assert.match(String(chatRow.description), /^⎇ feat\/fiu ⧉ {2}/);
  // No workspace folder: FILES has no folder to show, whatever row is clicked (Q8).
  list.__select([repoRow]);
  assert.equal(files.description, undefined);
});

test('every command the manifest contributes is registered after activation', async (t) => {
  const f = await seededActivation(t, [], {});
  await f.start();
  const registered = new Set(await vscode.commands.getCommands());
  const contributed = (pkg.contributes.commands as { command: string }[]).map((entry) => entry.command);
  assert.deepEqual(contributed.filter((command) => !registered.has(command)), [], 'a contributed command with no handler is a dead button');
});

// Startup (E16): activation and the list's first render never wait on a scan.

/** The module objects themselves, so a test can watch calls made through them. */
const nodeFs = require('fs') as typeof fs;
const childProcess = require('child_process') as typeof import('child_process');

/**
 * Watches the startup path's I/O for one test: transcript reads and git
 * calls that block the extension host, and transcript or projects-folder
 * reads that wait for `release()`, so a test can look while a scan is held
 * mid-way. Everything is restored when the test ends.
 */
function watchStartupIo(t: { after(fn: () => unknown): void }, hold: { transcripts?: boolean; projectsDir?: string } = {}) {
  const syncTranscriptReads: string[] = [];
  const syncGit: string[][] = [];
  const held: Array<() => void> = [];
  let released = false;
  const wait = () => (released ? Promise.resolve() : new Promise<void>((resolve) => held.push(resolve)));
  const { readFileSync } = nodeFs;
  const { readFile, readdir } = nodeFs.promises;
  const { execFileSync: blockingRun } = childProcess;
  const mutableFs = nodeFs as unknown as Record<string, unknown>;
  const mutablePromises = nodeFs.promises as unknown as Record<string, unknown>;
  const mutableChild = childProcess as unknown as Record<string, unknown>;
  mutableFs.readFileSync = (file: unknown, ...rest: unknown[]) => {
    if (String(file).endsWith('.jsonl')) syncTranscriptReads.push(String(file));
    return (readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  };
  mutablePromises.readFile = async (file: unknown, ...rest: unknown[]) => {
    if (hold.transcripts && String(file).endsWith('.jsonl')) await wait();
    return (readFile as (...args: unknown[]) => unknown)(file, ...rest);
  };
  mutablePromises.readdir = async (dir: unknown, ...rest: unknown[]) => {
    if (hold.projectsDir && path.resolve(String(dir)) === hold.projectsDir) await wait();
    return (readdir as (...args: unknown[]) => unknown)(dir, ...rest);
  };
  mutableChild.execFileSync = (command: unknown, args: unknown, ...rest: unknown[]) => {
    if (command === 'git') syncGit.push(args as string[]);
    return (blockingRun as (...a: unknown[]) => unknown)(command, args, ...rest);
  };
  const release = () => {
    released = true;
    held.splice(0).forEach((resolve) => resolve());
  };
  t.after(() => {
    mutableFs.readFileSync = readFileSync;
    Object.assign(mutablePromises, { readFile, readdir });
    mutableChild.execFileSync = blockingRun;
    release();
  });
  return {
    syncTranscriptReads,
    syncGit,
    /** Reads waiting for `release()`. */
    heldCount: () => held.length,
    release,
  };
}

/** A Claude transcript from a recent session started in `cwd`. */
function writeTranscript(claudeDir: string, cwd: string, sessionId: string): void {
  const dir = path.join(claudeDir, 'projects', encodeClaudeProjectPath(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const entries = [
    { type: 'user', timestamp: at, cwd, sessionId, message: { role: 'user', content: [{ type: 'text', text: 'Fix the startup' }] } },
    { type: 'assistant', timestamp: at, cwd, sessionId, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] } },
  ];
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
}

type ListRow = WorkspaceRow & { label?: string };

/** The workbench's request for the list's rows, which reaches the extension host as a message of its own. */
function requestRows(): Promise<ListRow[]> {
  const list = stub.__treeViews.find((candidate) => candidate.id === 'pitwall.workspacesView')!;
  return new Promise((resolve, reject) =>
    setImmediate(() => list.options.treeDataProvider!.getChildren().then((rows) => resolve(rows as ListRow[]), reject))
  );
}

test('activate does not wait for the session scan', async (t) => {
  stub.__setTreeViewsVisible(true);
  // The workbench is slow to ask for the rows.
  stub.__setTreeViewFirstRenderDelay(1_000);
  const lab = labFolder(t);
  const f = await seededActivation(t, [], {}, [lab.repository]);
  writeTranscript(f.claudeDir, lab.repository.rootPath, 'scan-me');
  const io = watchStartupIo(t, { transcripts: true });

  await f.start();
  // The scan waits for the list's first render, however long the workbench
  // takes to ask for it.
  stub.__treeViews.find((candidate) => candidate.id === 'pitwall.workspacesView')!.__renderDelayMs = 1_000;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(io.heldCount(), 0, 'no transcript is read before the first render');
  const rows = await requestRows();
  assert.deepEqual(rows.map((row) => row.label), ['lab'], 'the stored repo renders');
  assert.ok(
    !f.storedChats().some((chat) => chat.harnessSessionId === 'scan-me'),
    'activation and the first render are done before the scan is'
  );
  await waitFor(() => io.heldCount() > 0, 'the scan to reach the transcript');
  assert.deepEqual(io.syncTranscriptReads, [], 'no transcript is read synchronously, which would block the extension host');

  io.release();
  await waitFor(() => f.storedChats().some((chat) => chat.harnessSessionId === 'scan-me'), 'the scan to import the session afterwards');
});

test("the session watchers' file watchers are armed only after the first render", async (t) => {
  stub.__setTreeViewsVisible(true);
  // The workbench is slow to ask for the rows.
  stub.__setTreeViewFirstRenderDelay(1_000);
  const lab = labFolder(t);
  const f = await seededActivation(t, [], {}, [lab.repository]);
  writeTranscript(f.claudeDir, lab.repository.rootPath, 'watch-me');
  const watched: string[] = [];
  const { watch } = nodeFs;
  (nodeFs as unknown as Record<string, unknown>).watch = (target: unknown, ...rest: unknown[]) => {
    watched.push(String(target));
    return (watch as (...args: unknown[]) => unknown)(target, ...rest);
  };
  t.after(() => {
    (nodeFs as unknown as Record<string, unknown>).watch = watch;
  });

  await f.start();
  stub.__treeViews.find((candidate) => candidate.id === 'pitwall.workspacesView')!.__renderDelayMs = 1_000;
  await new Promise((resolve) => setTimeout(resolve, 200));
  const projects = path.resolve(f.claudeDir, 'projects');
  const underProjects = () => watched.filter((target) => path.resolve(target).startsWith(projects));
  assert.deepEqual(underProjects(), [], 'activation arms no watcher on the Claude profile');

  await requestRows();
  await waitFor(() => underProjects().length > 0, 'the watchers once the rows are out');
});

test('a window started by a handoff claims it before the session scan, repo discovery and the session watchers start (I3, E6)', async (t) => {
  stub.__setTreeViewsVisible(true);
  disposeOperationLog();
  t.after(disposeOperationLog);
  const lab = labFolder(t);
  const f = await seededActivation(t, [], {}, [lab.repository]);
  const storage = tempDir(t, 'pitwall-storage-');
  (f.context as { globalStorageUri?: vscode.Uri }).globalStorageUri = vscode.Uri.file(storage);
  (stub.workspace as { workspaceFolders: unknown[] }).workspaceFolders = [{ uri: vscode.Uri.file(lab.repository.rootPath), name: 'lab', index: 0 }];
  writeTranscript(f.claudeDir, lab.repository.rootPath, 'scan-me');
  const { HandoffInbox } = await import('../../../src/core/windows/HandoffInbox');
  await new HandoffInbox(storage, { pid: 1, folder: undefined }, Date.now, () => undefined).send(lab.repository.rootPath, {
    kind: 'open',
    sessionIds: ['0a0a0a0a-0000-4000-8000-000000000001'],
  });
  const operations = () => (stub.__outputChannels.find((channel) => channel.name === 'Pitwall Operations')?.lines ?? []).join('\n');
  const projects = path.resolve(f.claudeDir, 'projects');
  /** For each kind of startup work, whether the handoff was already claimed when it first touched the Claude profile. */
  const firstTouch = new Map<string, boolean>();
  const touch = (kind: string) => firstTouch.has(kind) || firstTouch.set(kind, operations().includes('handoff claimed'));
  const { readdir } = nodeFs.promises;
  const { watch } = nodeFs;
  (nodeFs.promises as unknown as Record<string, unknown>).readdir = (dir: unknown, ...rest: unknown[]) => {
    if (path.resolve(String(dir)) === projects) touch('scan');
    return (readdir as (...args: unknown[]) => unknown)(dir, ...rest);
  };
  (nodeFs as unknown as Record<string, unknown>).watch = (target: unknown, ...rest: unknown[]) => {
    if (path.resolve(String(target)).startsWith(projects)) touch('watch');
    return (watch as (...args: unknown[]) => unknown)(target, ...rest);
  };
  t.after(() => {
    Object.assign(nodeFs.promises, { readdir });
    (nodeFs as unknown as Record<string, unknown>).watch = watch;
  });

  await f.start();
  await requestRows();
  await waitFor(() => operations().includes('handoff claimed'), 'the handoff claim');
  await waitFor(() => firstTouch.has('scan') && firstTouch.has('watch'), 'the scan and the watchers');
  assert.deepEqual(Object.fromEntries(firstTouch), { scan: true, watch: true }, 'nothing reads or watches the profile before the claim');
});

test("the repos' git watchers are made only after the first render, in an empty window too (I3, E16)", async (t) => {
  stub.__setTreeViewsVisible(true);
  stub.__setTreeViewFirstRenderDelay(1_000);
  const lab = labFolder(t);
  const other = labFolder(t);
  const f = await seededActivation(t, [], {}, [lab.repository, { ...other.repository, id: 'other-repo', name: 'other' }]);
  // An empty window: no folder.
  (stub.workspace as { workspaceFolders: unknown[] }).workspaceFolders = [];
  const bases: string[] = [];
  const workspace = stub.workspace as unknown as { createFileSystemWatcher: (pattern: { base?: string }) => unknown };
  const create = workspace.createFileSystemWatcher;
  workspace.createFileSystemWatcher = (pattern) => {
    bases.push(String(pattern?.base ?? pattern));
    return create(pattern);
  };
  t.after(() => (workspace.createFileSystemWatcher = create));
  const repoWatchers = () => bases.filter((base) => [lab.repository.rootPath, other.repository.rootPath].some((root) => base.startsWith(root)));

  await f.start();
  stub.__treeViews.find((candidate) => candidate.id === 'pitwall.workspacesView')!.__renderDelayMs = 1_000;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(repoWatchers(), [], 'activation makes no watcher per repo before the rows are out');
  await requestRows();
  await waitFor(() => repoWatchers().length === 6, 'three watchers per repo once the rows are out');
});

// A window whose Pitwall view is never shown still scans, tracks status and
// pops up: the first scans start after the first render or after
// HIDDEN_LIST_START_MS while the list stays hidden, never after deactivation.

/**
 * Watches the first scans on mocked setTimeout/setInterval: the moment the
 * session importer's and repo discovery's start gates open, the list's first
 * render, and every pop-up asked of NotificationService. Restored when the
 * test ends.
 */
function watchFirstScans(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const order: string[] = [];
  const notified: string[] = [];
  const importerStart = SessionImportService.prototype.start;
  const discoveryStart = RepoDiscoveryService.prototype.start;
  const notify = NotificationService.prototype.notify;
  SessionImportService.prototype.start = function (this: SessionImportService, gate?: PromiseLike<unknown>) {
    void Promise.resolve(gate).then(() => order.push('importer'));
    return importerStart.call(this, gate);
  };
  RepoDiscoveryService.prototype.start = function (this: RepoDiscoveryService, gate: PromiseLike<unknown>) {
    void Promise.resolve(gate).then(() => order.push('discovery'));
    return discoveryStart.call(this, gate);
  };
  NotificationService.prototype.notify = function (this: NotificationService, ...args: Parameters<typeof notify>) {
    notified.push(`${args[0]} ${args[1].sessionId}`);
    return notify.apply(this, args);
  };
  t.after(() => {
    SessionImportService.prototype.start = importerStart;
    RepoDiscoveryService.prototype.start = discoveryStart;
    NotificationService.prototype.notify = notify;
  });
  /** Let the promise jobs and I/O that are ready run, without moving the clock. */
  const drain = async () => {
    for (let i = 0; i < 20; i++) await flush();
  };
  /** Move the mocked clock on by `ms` and let what came due run. */
  const advance = async (ms: number) => {
    t.mock.timers.tick(ms);
    await drain();
  };
  /** Run the clock in 50 ms steps (real I/O completing between them) until `condition` holds. */
  const runUntil = async (condition: () => boolean, what: string, maxMs = 30_000) => {
    const deadline = performance.now() + 15_000;
    for (let at = 0; !condition(); at += 50) {
      if (at > maxMs || performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await advance(50);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  /** Mark the list's first render in `order` once the workbench has the rows. */
  const markRender = () => {
    const provider = stub.__treeViews.find((candidate) => candidate.id === 'pitwall.workspacesView')!.options.treeDataProvider!;
    const getChildren = provider.getChildren.bind(provider);
    provider.getChildren = (element?: unknown) => {
      const rows = getChildren(element as never);
      if (element === undefined) void Promise.resolve(rows).then(() => order.push('render'));
      return rows;
    };
  };
  /**
   * Finish the turn of a session the importer listed. The listed chat is
   * seen at its import, and a turn that ends in that same millisecond is no
   * news (endedAt > seenAt), so wait the clock past it first.
   */
  const finishAfterImport = async (storedChats: () => ChatSession[], sessionId: string, finish: () => void) => {
    const seenAt = storedChats().find((chat) => chat.harnessSessionId === sessionId)!.seenAt ?? 0;
    while (Date.now() <= seenAt) await new Promise((resolve) => setImmediate(resolve));
    finish();
  };
  /**
   * Deactivate now and let in-flight git and file work end on the real
   * clock, before the test's folders are deleted: the folders' cleanup hooks
   * were registered first, so they run before the activation's own.
   */
  const stop = async (context: { subscriptions: { dispose(): unknown }[] }) => {
    context.subscriptions.splice(0).forEach((subscription) => subscription.dispose());
    t.mock.timers.reset();
    await new Promise((resolve) => setTimeout(resolve, 300));
  };
  return { order, notified, drain, advance, runUntil, markRender, finishAfterImport, stop };
}

/**
 * A Claude Code session running in `cwd` that no row holds yet, as Claude
 * writes it: its live record in `<profile>/sessions/<pid>.json` and its
 * transcript. `finish()` ends the turn, the way a chat turn finishing does.
 */
async function liveUnlistedSession(claudeDir: string, cwd: string, sessionId: string) {
  const sessions = path.join(claudeDir, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const domain = await localPidDomain();
  const record = (status: string) =>
    fs.writeFileSync(
      path.join(sessions, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId, pidDomain: domain, cwd, status, statusUpdatedAt: Date.now() })
    );
  const dir = path.join(claudeDir, 'projects', encodeClaudeProjectPath(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, `${sessionId}.jsonl`);
  const line = (entry: object) => `${JSON.stringify({ timestamp: new Date().toISOString(), cwd, sessionId, ...entry })}
`;
  fs.writeFileSync(transcript, line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Fix the popups' }] } }));
  record('busy');
  return {
    finish: () => {
      fs.appendFileSync(
        transcript,
        line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] } })
      );
      record('idle');
    },
  };
}

test('with the Pitwall view never shown, the first scans start after HIDDEN_LIST_START_MS and a finished turn pops up', async (t) => {
  // The view stays hidden: the workbench never asks for its rows.
  const lab = labFolder(t);
  const f = await seededActivation(t, [], {}, [lab.repository]);
  const sessionId = '7e5a1c2d-3b4f-4a6e-8c9d-0e1f2a3b4c5d';
  const session = await liveUnlistedSession(f.claudeDir, lab.repository.rootPath, sessionId);
  const scans = watchFirstScans(t);

  await f.start();
  scans.markRender();
  await scans.drain();
  assert.deepEqual([...scans.order], [], 'nothing scans at activation');
  await scans.advance(HIDDEN_LIST_START_MS - 1);
  assert.deepEqual([...scans.order], [], 'nor before HIDDEN_LIST_START_MS');
  await scans.advance(1);
  assert.deepEqual([...scans.order].sort(), ['discovery', 'importer'], 'both first scans start at HIDDEN_LIST_START_MS, view hidden');

  // The attention tick sees the running session no row holds and asks the importer for a full pass (Q31).
  await scans.runUntil(() => f.storedChats().some((chat) => chat.harnessSessionId === sessionId), 'the importer to list the live session');
  // The chat turn finishes unseen: busy, then idle.
  await scans.finishAfterImport(f.storedChats, sessionId, session.finish);
  await scans.runUntil(() => scans.notified.includes(`finished ${sessionId}`), 'the finished pop-up to reach NotificationService.notify');
  assert.ok(!scans.order.includes('render'), 'no view was opened');
  await scans.stop(f.context);
});

test('a live session asked about before the first scans start, in a hidden window a handoff started, is listed once they do and pops up', async (t) => {
  // The view stays hidden, and a handoff's open hangs, so the first scans
  // wait out CLAIM_FIRST_MAX_MS after the hidden fallback (about 6 s in).
  const lab = labFolder(t);
  const f = await seededActivation(t, [], {}, [lab.repository]);
  const storage = tempDir(t, 'pitwall-storage-');
  (f.context as { globalStorageUri?: vscode.Uri }).globalStorageUri = vscode.Uri.file(storage);
  (stub.workspace as { workspaceFolders: unknown[] }).workspaceFolders = [{ uri: vscode.Uri.file(lab.repository.rootPath), name: 'lab', index: 0 }];
  const { HandoffInbox } = await import('../../../src/core/windows/HandoffInbox');
  await new HandoffInbox(storage, { pid: 1, folder: undefined }, Date.now, () => undefined).send(lab.repository.rootPath, {
    kind: 'open',
    sessionIds: ['0a0a0a0a-0000-4000-8000-000000000001'],
  });
  const { ChatRouter } = await import('../../../src/core/windows/ChatRouter');
  const runClaimed = ChatRouter.prototype.runClaimed;
  let claimed = false;
  ChatRouter.prototype.runClaimed = () => {
    claimed = true;
    return new Promise<void>(() => undefined);
  };
  t.after(() => (ChatRouter.prototype.runClaimed = runClaimed));
  const { SessionAttentionService } = await import('../../../src/core/services/SessionAttentionService');
  const asked: string[] = [];
  const ask = (SessionAttentionService.prototype as unknown as Record<string, (...args: unknown[]) => Promise<void>>).askAboutUnlisted;
  (SessionAttentionService.prototype as unknown as Record<string, unknown>).askAboutUnlisted = async function (this: unknown, ...args: unknown[]) {
    await ask.apply(this, args);
    asked.push(...[...(this as { askedUnlisted: Set<string> }).askedUnlisted].map((key) => key.split(' ')[1]));
  };
  t.after(() => ((SessionAttentionService.prototype as unknown as Record<string, unknown>).askAboutUnlisted = ask));
  const sessionId = '9a7c3e4f-5d6b-4c8a-8e1f-2a3b4c5d6e7f';
  const session = await liveUnlistedSession(f.claudeDir, lab.repository.rootPath, sessionId);
  const scans = watchFirstScans(t);

  await f.start();
  // Past the hidden fallback the claim takes the handoff and its open hangs;
  // the attention tick asks about the unlisted session before the scans start.
  await scans.runUntil(() => claimed && asked.includes(sessionId), 'the handoff claim and the ask about the unlisted session', 5_900);
  assert.deepEqual([...scans.order], [], 'asked before the first scans start');

  await scans.runUntil(() => scans.order.length === 2, 'the first scans, after CLAIM_FIRST_MAX_MS');
  await scans.runUntil(() => f.storedChats().some((chat) => chat.harnessSessionId === sessionId), 'the importer to list the session it was asked about');
  await scans.finishAfterImport(f.storedChats, sessionId, session.finish);
  await scans.runUntil(() => scans.notified.includes(`finished ${sessionId}`), 'the finished pop-up to reach NotificationService.notify');
  await scans.stop(f.context);
});

test('with the Pitwall view shown, the first scans still start only after its first render (E16)', async (t) => {
  stub.__setTreeViewsVisible(true);
  // The workbench asks for the rows 1 s after the view is made.
  stub.__setTreeViewFirstRenderDelay(1_000);
  const lab = labFolder(t);
  const f = await seededActivation(t, [], {}, [lab.repository]);
  const scans = watchFirstScans(t);

  await f.start();
  scans.markRender();
  await scans.advance(999);
  assert.deepEqual([...scans.order], [], 'nothing scans before the first render');
  await scans.advance(1);
  assert.equal(scans.order[0], 'render', 'the first render comes first');
  assert.deepEqual([...scans.order.slice(1)].sort(), ['discovery', 'importer'], 'then both first scans, well before the hidden fallback');
  await scans.stop(f.context);
});

test('a window deactivated before HIDDEN_LIST_START_MS never starts its first scans', async (t) => {
  const lab = labFolder(t);
  const f = await seededActivation(t, [], {}, [lab.repository]);
  const session = await liveUnlistedSession(f.claudeDir, lab.repository.rootPath, '8f6b2d3e-4c5a-4b7f-9d0e-1f2a3b4c5d6e');
  const scans = watchFirstScans(t);

  await f.start();
  await scans.advance(HIDDEN_LIST_START_MS - 1);
  f.context.subscriptions.splice(0).forEach((subscription) => subscription.dispose());
  session.finish();
  await scans.advance(10 * HIDDEN_LIST_START_MS);
  assert.deepEqual([...scans.order], [], 'no scan starts after deactivation');
  assert.deepEqual([...scans.notified], [], 'and nothing pops up');
  await scans.stop(f.context);
});

test('stored repos render before discovery finishes', async (t) => {
  stub.__setTreeViewsVisible(true);
  const scratch = tempDir(t);
  const appPath = path.join(scratch, 'app');
  const linkedPath = path.join(scratch, 'app-fiu');
  const notesPath = path.join(scratch, 'notes');
  fs.mkdirSync(appPath);
  fs.mkdirSync(notesPath);
  execFileSync('git', ['init', '-q', '-b', 'main', appPath]);
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: appPath });
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat/fiu', linkedPath], { cwd: appPath });
  const app = { id: 'repo-app', name: 'app', rootPath: appPath } as Repository;
  const notes = { id: 'repo-notes', name: 'notes', rootPath: notesPath } as Repository;
  const f = await seededActivation(
    t,
    [
      {
        id: 'f1u00000-chat',
        name: 'Worktree chat',
        harnessSessionId: 'fiu',
        worktreeId: worktreeId(app.id, linkedPath),
        // Recent, so retention keeps it.
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
      },
    ],
    {},
    [app, notes]
  );
  fs.mkdirSync(path.join(f.claudeDir, 'projects'), { recursive: true });
  const io = watchStartupIo(t, { projectsDir: path.resolve(f.claudeDir, 'projects') });

  await f.start();
  const rows = await requestRows();
  assert.deepEqual(rows.map((row) => row.label).sort(), ['app', 'notes'], 'every stored repo, before git has listed any');
  // The listings land in the background and the rows follow, with the
  // stored sessions from every worktree.
  await waitFor(
    async () => (await requestRows()).find((row) => row.label === 'app')?.description === '1 session',
    "the linked worktree's session once git has listed it"
  );
  assert.notEqual(stub.__contextKeys.get('pitwall.scanned'), true, 'discovery has not finished');
  assert.deepEqual(io.syncGit, [], 'no git call blocked activation or the render');
});

test('a reload with stored repos renders rows before discovery finishes', async (t) => {
  stub.__setTreeViewsVisible(true);
  const scratch = tempDir(t);
  const repositories = Array.from({ length: 3 }, (_, i) => {
    const rootPath = path.join(scratch, `folder-${i}`);
    fs.mkdirSync(rootPath);
    return { id: `repo-folder-${i}`, name: `folder-${i}`, rootPath } as Repository;
  });
  const f = await seededActivation(t, [], {}, repositories);
  for (const repo of repositories) writeTranscript(f.claudeDir, repo.rootPath, `chat-${repo.name}`);
  // A dismissed folder with three long sessions: discovery looks at them on
  // every pass; the importer never does.
  const dismissed = path.join(scratch, 'dismissed');
  fs.mkdirSync(dismissed);
  for (let i = 0; i < 3; i++) writeLongTranscript(f.claudeDir, dismissed, `long-${i}`, 16 * 1024 * 1024);
  await makeStorage(f.context.globalState as never, f.context.workspaceState as never).setDismissed(dismissed, Date.now());

  // The first start leaves its state for the reload.
  await f.start();
  await requestRows();
  await waitFor(() => stub.__contextKeys.get('pitwall.scanned') === true, 'the first start to finish discovery', 30_000);
  f.context.subscriptions.splice(0).forEach((subscription) => subscription.dispose());
  stub.__reset();
  stub.__setTreeViewsVisible(true);

  // The reload, with discovery's reads watched: the long sessions are only
  // ever discovery's to read.
  const longDir = path.resolve(f.claudeDir, 'projects', encodeClaudeProjectPath(dismissed));
  const wholeReads: string[] = [];
  const { readFile } = nodeFs.promises;
  (nodeFs.promises as unknown as Record<string, unknown>).readFile = (file: unknown, ...rest: unknown[]) => {
    if (path.resolve(String(file)).startsWith(longDir)) wholeReads.push(String(file));
    return (readFile as (...args: unknown[]) => unknown)(file, ...rest);
  };
  t.after(() => Object.assign(nodeFs.promises, { readFile }));
  await f.start();
  const rows = await requestRows();
  const scannedAtFirstRender = stub.__contextKeys.get('pitwall.scanned') === true;
  await waitFor(() => stub.__contextKeys.get('pitwall.scanned') === true, 'the reload to finish discovery', 30_000);

  assert.deepEqual(rows.map((row) => row.label).sort(), ['folder-0', 'folder-1', 'folder-2'], 'the stored rows, so no welcome shows');
  assert.equal(scannedAtFirstRender, false, 'the rows did not wait for discovery');
  // A whole 16 MB transcript is parsed in one go, blocking the extension
  // host for its length (E16).
  assert.deepEqual(wholeReads, [], 'discovery never reads a long transcript in full');
});

/** A long Claude transcript, about `bytes` long, of a session started in `cwd` a day ago. */
function writeLongTranscript(claudeDir: string, cwd: string, sessionId: string, bytes: number): void {
  const dir = path.join(claudeDir, 'projects', encodeClaudeProjectPath(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(60);
  const lines: string[] = [];
  let size = 0;
  for (let turn = 0; size < bytes; turn++) {
    const timestamp = new Date(Date.now() - 86_400_000 + turn * 1_000).toISOString();
    for (const entry of [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: `Prompt ${turn}` }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${turn}`, content: filler.repeat(1 + (turn % 6)) }] } },
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `Reply ${turn}` }] } },
    ]) {
      const line = JSON.stringify({ timestamp, cwd, sessionId, ...entry });
      lines.push(line);
      size += line.length + 1;
    }
  }
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`);
}

/** The welcome text the list shows when it has no rows, given the context keys set so far. */
function shownWelcome(): string[] {
  const holds = (when: string | undefined) =>
    !when ||
    when.split('&&').every((term) => {
      const key = term.trim();
      return key.startsWith('!') ? stub.__contextKeys.get(key.slice(1)) !== true : stub.__contextKeys.get(key) === true;
    });
  return (pkg.contributes.viewsWelcome as { view: string; contents: string; when?: string }[])
    .filter((entry) => entry.view === 'pitwall.workspacesView' && holds(entry.when))
    .map((entry) => entry.contents);
}

test('the empty-state welcome is hidden while the first scan runs', async (t) => {
  stub.__setTreeViewsVisible(true);
  // Before activation no context key is set: the list must not claim it is empty.
  assert.ok(!shownWelcome().some((text) => text.startsWith('No repositories yet')), 'not before activation');
  assert.ok(shownWelcome().some((text) => text.startsWith('Scanning for repositories')), 'a loading line instead');

  const f = await seededActivation(t, [], {});
  fs.mkdirSync(path.join(f.claudeDir, 'projects'), { recursive: true });
  const io = watchStartupIo(t, { projectsDir: path.resolve(f.claudeDir, 'projects') });
  await f.start();
  assert.deepEqual(await requestRows(), [], 'nothing stored yet');
  await waitFor(() => io.heldCount() > 0, 'the first discovery pass to start');
  assert.ok(!shownWelcome().some((text) => text.startsWith('No repositories yet')), 'not while the first scan runs');
  assert.ok(shownWelcome().some((text) => text.startsWith('Scanning for repositories')));

  io.release();
  await waitFor(() => stub.__contextKeys.get('pitwall.scanned') === true, 'the first scan to finish');
  assert.deepEqual(shownWelcome(), ['No repositories yet.\n[Add repository](command:pitwall.addRepository)'], 'only once it found nothing');
});

test('activate and first-render diagnostics go to the Pitwall Operations channel', async (t) => {
  stub.__setTreeViewsVisible(true);
  disposeOperationLog();
  t.after(disposeOperationLog);
  const logged: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logged.push(args.map(String).join(' '));
  t.after(() => {
    console.log = original;
  });
  const lab = labFolder(t);
  const f = await seededActivation(t, [], {}, [lab.repository]);
  await f.start();
  await requestRows();
  const operations = () =>
    (stub.__outputChannels.find((channel) => channel.name === 'Pitwall Operations')?.lines ?? []).map((line) =>
      line.slice(line.indexOf('] ') + 2)
    );
  await waitFor(() => operations().includes('[Pitwall] first render'), 'the first render line');
  assert.equal(operations().filter((line) => line === '[Pitwall] activate').length, 1, 'activation is logged once');
  assert.equal(operations().filter((line) => line === '[Pitwall] first render').length, 1, 'the first render is logged once');
  assert.ok(operations().indexOf('[Pitwall] activate') < operations().indexOf('[Pitwall] first render'), 'in order');
  assert.ok(!logged.some((line) => line === '[Pitwall] activate' || line === '[Pitwall] first render'), 'and not to console.log');
});

// First start after upgrading (B1): no stored worktree listing yet, so the
// list draws each root as its main worktree until git answers. A chat on a
// linked worktree must still resolve, by waiting for its repository's listing.

/** A git repository with a linked worktree, stored as a repo with one chat on the linked worktree and no stored listing. */
async function linkedWorktreeChat(t: { after(fn: () => unknown): void }, pids: Record<string, number> = {}) {
  const scratch = tempDir(t);
  const appPath = path.join(scratch, 'app');
  const linkedPath = path.join(scratch, 'app-fiu');
  fs.mkdirSync(appPath);
  execFileSync('git', ['init', '-q', '-b', 'main', appPath]);
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: appPath });
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat/fiu', linkedPath], { cwd: appPath });
  const app = { id: 'repo-app', name: 'app', rootPath: appPath } as Repository;
  const chat: Partial<ChatSession> = {
    id: 'f1a00000-chat',
    name: 'Worktree chat',
    harnessSessionId: 'fiu',
    worktreeId: worktreeId(app.id, linkedPath),
    status: 'idle',
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  };
  const f = await seededActivation(t, [chat], pids, [app]);
  writeTranscript(f.claudeDir, linkedPath, 'fiu');
  return { f, chat: chatRecord(chat), linkedPath };
}

test('a chat on a linked worktree opens on the first click of a first start, before git has listed it (B1)', async (t) => {
  const { f, chat, linkedPath } = await linkedWorktreeChat(t);
  await f.start();

  await vscode.commands.executeCommand('pitwall.openChat', { itemType: 'chat', data: chat });
  assert.ok(!shownMessages().includes('Could not find worktree for this session.'), `no error (shown: ${shownMessages().join(' | ')})`);
  const terminal = await waitFor(
    () =>
      stub.window.terminals.find(
        (candidate) => candidate.options.cwd !== undefined && path.basename(String(candidate.options.cwd)) === path.basename(linkedPath)
      ),
    "the chat's terminal in its linked worktree"
  );
  assert.ok(terminal, 'the chat opened');
});

test('a revived tab of a chat on a linked worktree is resumed on the first reload after upgrading (B1)', async (t) => {
  const { f, linkedPath } = await linkedWorktreeChat(t, { 'f1a00000-chat': 7701 });
  // A quit revived the tab as a new shell (its PID is not the recorded one).
  const tab = stub.window.createTerminal({ name: 'Pitwall: Worktree chat [f1a000]', __pid: 8701 });
  await f.start();

  await waitFor(() => tab.sent.length > 0, 'the resume line in the revived tab', 5_000);
  assert.equal(tab.sent.length, 1);
  assert.ok(tab.sent[0].includes('--resume fiu'), tab.sent[0]);
  assert.ok(tab.sent[0].includes(path.basename(linkedPath)), `resumed in the linked worktree: ${tab.sent[0]}`);
});
