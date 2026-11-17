/**
 * Extension activation and terminal restore: what `activate()` waits for, and
 * what a restore start reveals in the sidebar.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import pkg from '../../../package.json';
import { activate } from '../../../src/extension';
import { ChatSession, Repository, STORAGE_KEYS } from '../../../src/core/types';
import { worktreeId } from '../../../src/core/services/GitService';
import { encodeClaudeProjectPath } from '../../../src/harnesses/claude/paths';
import { disposeOperationLog } from '../../../src/core/services/OperationLog';
import { PROCESS_ID_TIMEOUT_MS } from '../../../src/core/services/terminalEvents';
import { chatRecord, flush, makeStorage, memento, setEnv, stub, tempDir, waitFor } from '../support';

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

test("clicking a repo row points FILES at its main worktree; opening a chat points it at the chat's worktree", async (t) => {
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
    [{ id: 'f1u00000-chat', name: 'Worktree chat', harnessSessionId: 'fiu', worktreeId: worktreeId(repository.id, linkedPath) }],
    {},
    [repository]
  );
  await f.start();
  const list = stub.__treeViews.find((candidate) => candidate.id === 'pitwall.workspacesView')!;
  const files = stub.__treeViews.find((candidate) => candidate.id === 'pitwall.filesView')!;
  assert.equal(list.description, 'sorted by who needs you');
  const rows = list.options.treeDataProvider!;
  const [repoRow] = (await rows.getChildren()) as WorkspaceRow[];
  const operations = stub.__outputChannels.find((channel: { name: string }) => channel.name === 'Pitwall Operations');
  assert.ok(
    operations?.lines.some((line: string) => line.includes('[Pitwall] order repo-app')),
    'the order diagnostic goes to the Pitwall Operations output channel'
  );
  assert.ok(!logged.some((line) => line.startsWith('[Pitwall] order')), 'and not to console.log');

  list.__select([repoRow]);
  assert.equal(files.description, 'app ⎇ main');
  assert.equal(fs.realpathSync(files.message ?? ''), fs.realpathSync(repoPath), 'the folder path');

  const [chatRow] = (await rows.getChildren(repoRow)) as WorkspaceRow[];
  assert.match(String(chatRow.description), /^⎇ feat\/fiu ⧉ {2}/);
  await vscode.commands.executeCommand('pitwall.openChat', chatRow);
  await waitFor(() => files.description === 'app ⎇ feat/fiu', 'FILES follows the opened chat');
  assert.equal(fs.realpathSync(files.message ?? ''), fs.realpathSync(linkedPath));
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
  const lab = labFolder(t);
  const f = await seededActivation(t, [], {}, [lab.repository]);
  writeTranscript(f.claudeDir, lab.repository.rootPath, 'scan-me');
  const io = watchStartupIo(t, { transcripts: true });

  await f.start();
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
  assert.deepEqual(
    rows.map((row) => [row.label, row.description]).sort(),
    [
      ['app', '1 session'],
      ['notes', '0 sessions'],
    ],
    'every stored repo, with its stored sessions from every worktree'
  );
  assert.notEqual(stub.__contextKeys.get('pitwall.scanned'), true, 'discovery has not finished');
  assert.deepEqual(io.syncGit, [], 'no git call blocked activation or the render');
});

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
