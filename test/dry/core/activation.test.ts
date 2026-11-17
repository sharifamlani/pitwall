/**
 * Extension activation and terminal restore: what `activate()` waits for, and
 * what a restore start reveals in the sidebar.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { activate } from '../../../src/extension';
import { ChatSession, Repository, STORAGE_KEYS } from '../../../src/core/types';
import { worktreeId } from '../../../src/core/services/GitService';
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
  setEnv(t, { CLAUDE_CONFIG_DIR: tempDir(t, 'pitwall-claude-') });
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
    start: () => (activation = activate(context as never)),
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
