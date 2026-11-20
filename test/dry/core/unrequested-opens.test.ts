/**
 * Unrequested opens (0.6.0 PR #79 gate, window a, 16:37:40-46 UTC): after one
 * click on "Main" and a 26.7 s import scan, the Operations log showed three
 * more routes (cc1af807, 78c611c2, daf974fc), each starting a claude process.
 *
 * The first test replays everything the window did on its own around them,
 * sized from the incident (a 42-session folder, a long first scan held open,
 * the clicked row still selected, re-selections, a full redraw, focus and
 * visibility changes), with the real extension wired as `activate()` wires
 * it. Only a row's click command (which the workbench runs for a pointer or
 * key event, never for a refresh or a programmatic select) may open a chat.
 *
 * The second test is the diagnostic gap the incident exposed: a route line
 * cannot say what asked for it, so a row click, a hotkey, a search pick and a
 * claimed handoff all log the same `route <id> → here (<reason>)`.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate } from '../../../src/extension';
import { ChatSession, Repository, STORAGE_KEYS } from '../../../src/core/types';
import { worktreeId } from '../../../src/core/services/GitService';
import { encodeClaudeProjectPath } from '../../../src/harnesses/claude/paths';
import { disposeOperationLog } from '../../../src/core/services/OperationLog';
import { chatRecord, FakeTreeView, flush, memento, setEnv, stub, tempDir, waitFor } from '../support';

beforeEach(() => stub.__reset());

const nodeFs = require('fs') as typeof fs;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The incident's folder: uj-lab-a held 42 sessions. */
const SESSIONS = 42;
/** Sessions on disk the scan finds that storage does not hold yet, so the scan's end changes the rows. */
const NEW_ON_DISK = 6;
const sessionId = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-0000000000aa`;

/** A Claude transcript from a recent session started in `cwd` (synthetic text only). */
function writeTranscript(claudeDir: string, cwd: string, id: string, at: Date): void {
  const dir = path.join(claudeDir, 'projects', encodeClaudeProjectPath(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = at.toISOString();
  const entries = [
    { type: 'user', timestamp: stamp, cwd, sessionId: id, entrypoint: 'cli', message: { role: 'user', content: [{ type: 'text', text: 'probe' }] } },
    {
      type: 'assistant',
      timestamp: stamp,
      cwd,
      sessionId: id,
      entrypoint: 'cli',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
    },
  ];
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
}

/**
 * Hold the import scan until `release()`: the incident's first scan after the
 * view showed took 26.7 s (21 repos, 460 sessions, cold). The scan starts by
 * listing the profile's project folders; the rows' own reads go on.
 */
function holdScan(t: { after(fn: () => unknown): void }, claudeDir: string) {
  const projects = path.resolve(claudeDir, 'projects');
  const held: Array<() => void> = [];
  let released = false;
  const wait = () => (released ? Promise.resolve() : new Promise<void>((resolve) => held.push(resolve)));
  const { readdir } = nodeFs.promises;
  const promises = nodeFs.promises as unknown as Record<string, unknown>;
  promises.readdir = async (dir: unknown, ...rest: unknown[]) => {
    if (path.resolve(String(dir)) === projects) await wait();
    return (readdir as (...args: unknown[]) => unknown)(dir, ...rest);
  };
  const release = () => {
    released = true;
    held.splice(0).forEach((resolve) => resolve());
  };
  t.after(() => {
    Object.assign(promises, { readdir });
    release();
  });
  return { heldCount: () => held.length, release };
}

/** Every command run that opens a chat or a repo's chats: row clicks and the open commands they call. */
function recordOpens(t: { after(fn: () => unknown): void }): string[] {
  const opens: string[] = [];
  const commands = vscode.commands as unknown as { executeCommand: (id: string, ...args: unknown[]) => Promise<unknown> };
  const execute = commands.executeCommand;
  commands.executeCommand = (id: string, ...args: unknown[]) => {
    if (id.startsWith('_pitwall.row.') || /^pitwall\.open/.test(id)) {
      opens.push(id);
    }
    return execute(id, ...args);
  };
  t.after(() => (commands.executeCommand = execute));
  return opens;
}

const operations = () => stub.__outputChannels.find((channel) => channel.name === 'Pitwall Operations')?.lines ?? [];
/** The Operations log's open decisions: `route <id> → …` and `open <id> → …`. */
const openLines = () => operations().filter((line) => /\] \[Pitwall\] (route|open) /.test(line));

/** A window on the incident's folder: its 42 chats stored, its transcripts on disk, the list visible. */
async function incidentWindow(t: { after(fn: () => unknown): void }) {
  stub.__setTreeViewsVisible(true);
  disposeOperationLog();
  t.after(disposeOperationLog);
  const claudeDir = tempDir(t, 'pitwall-claude-');
  setEnv(t, { CLAUDE_CONFIG_DIR: claudeDir });
  const rootPath = tempDir(t, 'uj-lab-a-');
  const repository = { id: 'uj-lab-a', name: 'uj-lab-a', rootPath } as Repository;
  const wt = worktreeId(repository.id, rootPath);
  const now = Date.now();
  const chats: ChatSession[] = [];
  for (let n = 0; n < SESSIONS; n++) {
    chats.push(
      chatRecord({
        id: `chat-${n}`,
        name: n === 0 ? 'Main' : `chat ${n}`,
        worktreeId: wt,
        harnessSessionId: sessionId(n),
        createdAt: now - (SESSIONS - n) * 60_000,
        lastAccessedAt: now - (SESSIONS - n) * 60_000,
      })
    );
    writeTranscript(claudeDir, rootPath, sessionId(n), new Date(now - (SESSIONS - n) * 60_000));
  }
  for (let n = SESSIONS; n < SESSIONS + NEW_ON_DISK; n++) {
    writeTranscript(claudeDir, rootPath, sessionId(n), new Date(now - 30_000));
  }
  const globalState = memento();
  await globalState.update(STORAGE_KEYS.CHATS, chats);
  await globalState.update(STORAGE_KEYS.REPOSITORIES, [repository]);
  const context = {
    subscriptions: [] as { dispose(): unknown }[],
    globalState,
    workspaceState: memento(),
    extensionUri: vscode.Uri.file('/extension'),
    extension: { id: 'sharifamlani.pitwall' },
    globalStorageUri: vscode.Uri.file(tempDir(t, 'pitwall-storage-')),
  };
  // This window is the folder's window, as uj-lab-a was.
  (stub.workspace as { workspaceFolders: unknown[] }).workspaceFolders = [{ uri: vscode.Uri.file(rootPath), name: 'uj-lab-a', index: 0 }];
  let activation: Promise<unknown> | undefined;
  t.after(async () => {
    await activation?.catch(() => undefined);
    context.subscriptions.forEach((subscription) => subscription.dispose());
  });
  return {
    chats,
    repository,
    claudeDir,
    start: () => (activation = activate(context as never)),
    storedChats: () => globalState.get<ChatSession[]>(STORAGE_KEYS.CHATS, []),
    view: () => stub.__treeViews.find((candidate) => candidate.id === 'pitwall.workspacesView') as unknown as FakeTreeView,
  };
}

/** The workbench shows the folder's row expanded; its chat rows are then clickable. */
async function expandFolder(view: FakeTreeView, repository: Repository): Promise<void> {
  // A redraw replaces the row objects, so each try takes the folder row the editor holds now.
  await waitFor(async () => {
    const repoRow = view.__rowOf(`repository-${repository.id}`);
    if (!repoRow) {
      return false;
    }
    await view.__expand(repoRow);
    return view.__childIds(repoRow).length >= SESSIONS;
  }, 'the folder’s chat rows', 5_000);
}

/** The user clicks a row: the workbench selects it, then runs the command it holds for it. */
async function click(view: FakeTreeView, rowId: string): Promise<void> {
  const row = view.__rowOf(rowId)!;
  view.__select([row]);
  await view.__click(row);
}

test('after one click, a long import scan, redraws, re-selections and focus changes open nothing more (0.6.0 gate, 16:37:40)', async (t) => {
  const w = await incidentWindow(t);
  const scan = holdScan(t, w.claudeDir);
  const opens = recordOpens(t);
  await w.start();
  const view = w.view();
  await expandFolder(view, w.repository);
  await waitFor(() => scan.heldCount() > 0, 'the import scan to be under way');

  // 16:37:19: the one click, on Main, while the scan runs.
  await click(view, 'chat-chat-0');
  await waitFor(() => openLines().length > 0, 'the click’s route');
  await sleep(300);
  const afterClick = { opens: [...opens], lines: openLines() };
  assert.deepEqual(afterClick.opens.slice(0, 2), ['_pitwall.row.chat-chat-0', 'pitwall.openChat'], 'the click opened Main');

  // 16:37:35: the long scan ends and imports the sessions it found.
  scan.release();
  await waitFor(() => w.storedChats().length >= SESSIONS + NEW_ON_DISK, 'the scan to import the new sessions', 10_000);
  // The window on its own: a full redraw, the editor re-applying the
  // selection to the redrawn Main row, reveals selecting other rows (a tab
  // in front, a pop-up's chat), the window losing and regaining focus, the
  // list hiding and showing (which wakes another scan), and re-sorts.
  await vscode.commands.executeCommand('pitwall.refreshWorkspaces');
  await sleep(400);
  await expandFolder(view, w.repository);
  view.__select([view.__rowOf('chat-chat-0')!]);
  view.__select([view.__rowOf('chat-chat-1')!]);
  view.__select([view.__rowOf(`chat-chat-${SESSIONS - 1}`)!]);
  view.__select([view.__rowOf('chat-chat-0')!]);
  stub.window.__fireWindowState(false);
  stub.window.__fireWindowState(true);
  view.__setVisible(false);
  view.__setVisible(true);
  await expandFolder(view, w.repository);
  await vscode.commands.executeCommand('pitwall.refreshWorkspaces');
  for (let i = 0; i < 5; i++) await flush();
  await sleep(1_500);

  assert.deepEqual(opens.slice(afterClick.opens.length), [], 'no row command or open command ran without a click');
  assert.deepEqual(openLines().slice(afterClick.lines.length), [], 'no route or open line after the click’s');
});

test('every route line says what asked for it, so a click and a programmatic open are told apart (0.6.0 gate)', async (t) => {
  const w = await incidentWindow(t);
  await w.start();
  const view = w.view();
  await expandFolder(view, w.repository);

  await click(view, 'chat-chat-0');
  const routes = await waitFor(() => {
    const lines = operations().filter((line) => line.includes('[Pitwall] route '));
    return lines.length > 0 ? lines : undefined;
  }, 'the click’s route');
  for (const line of routes) {
    assert.match(line, / via=row-click\b/, `the route line names its trigger: ${line.replace(/^\[[^\]]+\] /, '')}`);
  }
});
