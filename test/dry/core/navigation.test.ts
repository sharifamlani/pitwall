/**
 * Hotkeys and list keyboard (rows 3.7, 3.8): Ctrl+Alt+1–9 jump to the nth repo
 * in inbox order, Ctrl+Alt+Shift+1–9 open its window, Ctrl+Alt+F toggles FILES,
 * and Ctrl+↓/↑ move through the list and open what they land on (P10–P12, P20).
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import pkg from '../../../package.json';
import { consumeKeepListFocus, keepListFocusOnce, registerNavigationCommands } from '../../../src/core/commands/navigation';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from '../../../src/core/providers/WorkspacesTreeProvider';
import { HarnessRegistry } from '../../../src/core/harness/HarnessRegistry';
import { SessionStatus } from '../../../src/core/providers/sessionStatus';
import { RepositoryWorktrees } from '../../../src/core/types';
import { FakeTreeView, fakeAdapter, fakeWorktreeListing, makeStorage, runCommand, stub, worktreeRecord } from '../support';

beforeEach(() => stub.__reset());

const bindings = pkg.contributes.keybindings as { command: string; key: string; mac?: string; when?: string }[];
const commandIds = new Set((pkg.contributes.commands as { command: string }[]).map((entry) => entry.command));
const bound = (key: string) => bindings.filter((binding) => binding.key === key && !binding.when).map((binding) => binding.command);
const folderOf = (uri: unknown) => (uri as vscode.Uri).fsPath.replace(/\\/g, '/').replace(/^[a-z]:/i, '');

test('Ctrl+Alt+1–9, 0, O, F and Ctrl+Alt+Shift+1–9 are bound to Pitwall commands', () => {
  for (let n = 1; n <= 9; n++) {
    assert.deepEqual(bound(`ctrl+alt+${n}`), [`pitwall.goToRepo${n}`]);
    assert.deepEqual(bound(`ctrl+alt+shift+${n}`), [`pitwall.openRepoWindow${n}`]);
    const mac = bindings.filter((binding) => binding.command === `pitwall.openRepoWindow${n}`).map((binding) => binding.mac);
    assert.deepEqual(mac, [`ctrl+cmd+shift+${n}`]);
    assert.ok(commandIds.has(`pitwall.goToRepo${n}`) && commandIds.has(`pitwall.openRepoWindow${n}`), `${n} is a declared command`);
  }
  assert.deepEqual(bound('ctrl+alt+0'), ['pitwall.openLongestWaiting']);
  assert.deepEqual(bound('ctrl+alt+n'), ['pitwall.openLongestWaiting'], 'Ctrl+Alt+N stays as an alias (P10)');
  assert.deepEqual(bound('ctrl+alt+o'), ['pitwall.openCurrentRepoWindow']);
  assert.deepEqual(bound('ctrl+alt+f'), ['pitwall.toggleFiles'], 'F moves from Find Session to FILES (P10)');
  assert.deepEqual(bound('ctrl+alt+r'), ['pitwall.search'], 'Ctrl+Alt+R is the search box (Task 9)');
  for (const command of ['pitwall.openLongestWaiting', 'pitwall.openCurrentRepoWindow', 'pitwall.toggleFiles', 'pitwall.list.moveDownAndOpen', 'pitwall.list.moveUpAndOpen']) {
    assert.ok(commandIds.has(command), `${command} is declared`);
  }
  const list = (key: string) => bindings.filter((binding) => binding.key === key);
  assert.deepEqual(list('ctrl+down').map((binding) => [binding.command, binding.when]), [
    ['pitwall.list.moveDownAndOpen', "focusedView == 'pitwall.workspacesView' && !inputFocus"],
  ]);
  assert.deepEqual(list('ctrl+up').map((binding) => [binding.command, binding.when]), [
    ['pitwall.list.moveUpAndOpen', "focusedView == 'pitwall.workspacesView' && !inputFocus"],
  ]);
});

/** Repos a, b, c, ...; b holds two chats. */
function setup(t: { after(fn: () => void): void }, repoCount = 3) {
  const storage = makeStorage();
  const statuses = new Map<string, SessionStatus>();
  const worktrees = new Map<string, ReturnType<typeof worktreeRecord>>();
  for (let i = 0; i < repoCount; i++) {
    const name = String.fromCharCode(97 + i);
    const repo = storage.addRepository(name, `/work/${name}`);
    worktrees.set(repo.id, worktreeRecord({ id: `wt-${name}`, repoId: repo.id, name, path: `/work/${name}` }));
  }
  const chats = ['one', 'two'].map((title, i) => storage.createChat('wt-b', 'claude', title, { harnessSessionId: `s${i}` }));
  // As on a reload: each repo's last listing is stored.
  for (const [repoId, worktree] of worktrees) {
    storage.saveWorktreeSnapshot(repoId, { isGit: true, worktrees: [worktree] });
  }
  const tree = new WorkspacesTreeProvider(
    storage,
    {
      ...fakeWorktreeListing((_root: string, repoId: string): RepositoryWorktrees => ({ isGit: true, worktrees: [worktrees.get(repoId)!] })),
      getAheadBehind: () => null,
    } as never,
    { onTerminalStateChange: () => ({ dispose: () => undefined }), isActive: () => false } as never,
    new HarnessRegistry([fakeAdapter('claude')]),
    vscode.Uri.file('/extension')
  );
  t.after(() => tree.dispose());
  tree.setStatusSource({
    statusOf: (id: string) => ({ status: statuses.get(id) ?? 'idle', statusSince: 0 }),
    onDidChangeStatus: new vscode.EventEmitter<string[]>().event,
  });
  const workspacesView = vscode.window.createTreeView('pitwall.workspacesView', { treeDataProvider: tree }) as unknown as FakeTreeView;
  const filesView = vscode.window.createTreeView('pitwall.filesView', { treeDataProvider: { getChildren: async () => [] } as never }) as unknown as FakeTreeView;
  const context = { subscriptions: [] as { dispose(): void }[] };
  registerNavigationCommands(context as never, {
    workspacesProvider: tree,
    workspacesTreeView: workspacesView as never,
    filesTreeView: filesView as never,
  });
  const calls: { id: string; args: unknown[] }[] = [];
  /** What each run of the repo row's click command saw: whether a keyboard walk's marker was set. */
  const repoOpens: boolean[] = [];
  context.subscriptions.push(vscode.commands.registerCommand('pitwall.openRepoChats', () => void repoOpens.push(consumeKeepListFocus())));
  for (const id of ['pitwall.openChat', 'vscode.openFolder', 'pitwall.filesView.focus', 'pitwall.filesView.removeView', 'pitwall.openNextSessionNeedingYou']) {
    context.subscriptions.push(vscode.commands.registerCommand(id, (...args: unknown[]) => void calls.push({ id, args })));
  }
  t.after(() => context.subscriptions.forEach((entry) => entry.dispose()));
  return { storage, tree, statuses, workspacesView, filesView, calls, chats, context, repoOpens };
}

const revealed = (view: FakeTreeView) => view.reveals.map((reveal) => (reveal.item as WorkspaceTreeItem).label);

test('goToRepo(n) reveals and selects the nth repo in inbox order; again opens its next chat', async (t) => {
  const { workspacesView, calls, statuses, chats, tree } = setup(t);
  // b's second session needs you, so b is first in inbox order and that session first within it.
  statuses.set(chats[1].id, 'needs');
  tree.refresh();
  assert.deepEqual((await tree.getChildren()).map((row) => row.label), ['b', 'a', 'c']);

  await runCommand('pitwall.goToRepo1');
  assert.deepEqual(revealed(workspacesView), ['b']);
  assert.deepEqual(workspacesView.reveals[0].options, { select: true, focus: true, expand: true });
  assert.equal(calls.length, 0, 'the first press only reveals');

  const [bRow] = await tree.getChildren();
  workspacesView.__select([bRow]);
  await runCommand('pitwall.goToRepo1');
  assert.deepEqual(calls.map((call) => [call.id, (call.args[0] as WorkspaceTreeItem).label]), [['pitwall.openChat', 'two']], 'the needs-you chat is next');
  await runCommand('pitwall.goToRepo1');
  assert.deepEqual(calls.map((call) => (call.args[0] as WorkspaceTreeItem).label), ['two', 'one'], 'again opens the chat after it');
  await runCommand('pitwall.goToRepo1');
  assert.deepEqual(calls.map((call) => (call.args[0] as WorkspaceTreeItem).label), ['two', 'one', 'two'], 'and wraps');

  const before = revealed(workspacesView).length;
  await runCommand('pitwall.goToRepo2');
  assert.equal(revealed(workspacesView).at(-1), 'a', 'another repo only reveals');
  await runCommand('pitwall.goToRepo9');
  assert.equal(revealed(workspacesView).length, before + 1, 'a position with no repo does nothing');
});

test('openRepoWindow(n) opens the nth repo folder in a new window', async (t) => {
  const { calls, workspacesView, tree } = setup(t);
  await tree.getChildren();
  await runCommand('pitwall.openRepoWindow3');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'vscode.openFolder');
  assert.equal(folderOf(calls[0].args[0]), '/work/c');
  assert.deepEqual(calls[0].args[1], { forceNewWindow: true });
  await runCommand('pitwall.openRepoWindow8');
  assert.equal(calls.length, 1, 'a position with no repo does nothing');

  const [, bRow] = await tree.getChildren();
  workspacesView.__select([bRow]);
  await runCommand('pitwall.openCurrentRepoWindow');
  assert.equal(calls.length, 2);
  assert.equal(folderOf(calls[1].args[0]), '/work/b');
  assert.deepEqual(calls[1].args[1], { forceNewWindow: true });

  const [chatRow] = await tree.getChildren(bRow);
  workspacesView.__select([chatRow]);
  await runCommand('pitwall.openCurrentRepoWindow');
  assert.equal(folderOf(calls[2].args[0]), '/work/b', "a session row stands for its repo");
});

test('openLongestWaiting runs the open-next-needing-you behaviour', async (t) => {
  const { calls } = setup(t);
  await runCommand('pitwall.openLongestWaiting');
  assert.deepEqual(calls.map((call) => call.id), ['pitwall.openNextSessionNeedingYou']);
});

test('toggleFiles shows FILES when hidden and hides it when shown', async (t) => {
  const { filesView, calls } = setup(t);
  filesView.visible = false;
  await runCommand('pitwall.toggleFiles');
  assert.deepEqual(calls.map((call) => call.id), ['pitwall.filesView.focus']);
  filesView.visible = true;
  await runCommand('pitwall.toggleFiles');
  assert.deepEqual(calls.map((call) => call.id), ['pitwall.filesView.focus', 'pitwall.filesView.removeView']);
});

test('move-and-open moves focus one row and opens it; on a repo row it expands and selects', async (t) => {
  const { workspacesView, calls, tree, context, repoOpens } = setup(t);
  const [aRow, bRow] = await tree.getChildren();
  const [oneRow] = await tree.getChildren(bRow);
  const focused: string[] = [];
  let landsOn = oneRow;
  // The workbench: focusing a row and then selecting it selects and opens that row.
  context.subscriptions.push(
    vscode.commands.registerCommand('list.focusDown', () => void focused.push('down')),
    vscode.commands.registerCommand('list.focusUp', () => void focused.push('up')),
    vscode.commands.registerCommand('list.select', async () => {
      workspacesView.__select([landsOn]);
      // Selecting a row opens it: the workbench runs the row's own command.
      const { command } = landsOn;
      if (command) {
        await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
      }
    })
  );

  await runCommand('pitwall.list.moveDownAndOpen');
  assert.deepEqual(focused, ['down']);
  assert.deepEqual(calls.map((call) => [call.id, (call.args[0] as WorkspaceTreeItem).data]), [['pitwall.openChat', oneRow.data]]);
  assert.equal(workspacesView.reveals.length, 0, 'a session row is opened, not revealed');

  calls.length = 0;
  landsOn = aRow;
  await runCommand('pitwall.list.moveUpAndOpen');
  assert.deepEqual(focused, ['down', 'up']);
  assert.equal(calls.length, 0, 'a repo row opens no chat');
  assert.deepEqual(repoOpens, [true], 'its click command ran and saw the walk marker');
  assert.deepEqual(
    workspacesView.reveals.map((reveal) => [(reveal.item as WorkspaceTreeItem).label, reveal.options]),
    [['a', { select: true, focus: true, expand: true }]]
  );
});

test('the marker expires after 2 s', (t) => {
  // An injected clock that moves only when the test moves it: on the real one,
  // the milliseconds a loaded machine spends between calls ate the 1 ms margin.
  const realNow = Date.now;
  const start = realNow();
  let offset = 0;
  Date.now = () => start + offset;
  t.after(() => {
    Date.now = realNow;
  });

  keepListFocusOnce();
  offset += 1_999;
  assert.equal(consumeKeepListFocus(), true, 'still set just inside 2 s');
  assert.equal(consumeKeepListFocus(), false, 'one-shot');

  keepListFocusOnce();
  offset += 2_000;
  assert.equal(consumeKeepListFocus(), false, 'expired at 2 s: a click much later is a plain click');
});

test('Ctrl+Down on a repo row still only reveals it (Q22)', async (t) => {
  const { workspacesView, calls, tree, context } = setup(t);
  const [aRow] = await tree.getChildren();
  context.subscriptions.push(
    vscode.commands.registerCommand('list.focusDown', () => undefined),
    vscode.commands.registerCommand('list.select', () => workspacesView.__select([aRow]))
  );

  await runCommand('pitwall.list.moveDownAndOpen');
  assert.equal(calls.length, 0, 'no chat opens');
  assert.deepEqual(
    workspacesView.reveals.map((reveal) => [(reveal.item as WorkspaceTreeItem).label, reveal.options]),
    [['a', { select: true, focus: true, expand: true }]]
  );
  // The repo row now has a click command (T4). The key leaves the marker for
  // that command to read, so a keyboard walk only expands; it lives 250 ms.
  assert.equal(consumeKeepListFocus(), true, 'the marker waits for the row command, which reads it and opens nothing');
  assert.equal(consumeKeepListFocus(), false, 'and is single-use');
});

test('Enter on a repo runs openRepoChats; a Ctrl+↓ landing on it does not (Q22)', async (t) => {
  const { workspacesView, tree, context, repoOpens } = setup(t);
  const [aRow] = await tree.getChildren();
  assert.equal(aRow.command?.command, 'pitwall.openRepoChats', 'the row command is what Enter (list.select) and a click run');
  assert.deepEqual(aRow.command?.arguments, [aRow]);
  const keyboard = repoOpens;
  context.subscriptions.push(
    vscode.commands.registerCommand('list.focusDown', () => undefined),
    vscode.commands.registerCommand('list.select', async () => {
      workspacesView.__select([aRow]);
      await vscode.commands.executeCommand(aRow.command!.command, ...(aRow.command!.arguments ?? []));
    })
  );
  // Enter: the workbench selects the focused row, which fires its command with no marker.
  await runCommand('list.select');
  assert.deepEqual(keyboard, [false], 'Enter opens its chats');
  // Ctrl+↓ onto the same row: the key's marker is there, so it only expands.
  await runCommand('pitwall.list.moveDownAndOpen');
  assert.deepEqual(keyboard, [false, true], 'a keyboard walk reads the marker and opens nothing');
  assert.deepEqual(workspacesView.reveals.map((reveal) => reveal.options), [{ select: true, focus: true, expand: true }]);
});

test('a repo tooltip names its keys only for positions 1–9', async (t) => {
  const { tree } = setup(t, 10);
  const rows = await tree.getChildren();
  assert.equal(rows.length, 10);
  for (const [index, row] of rows.entries()) {
    const position = index + 1;
    const tooltip = String(row.tooltip);
    if (position <= 9) {
      assert.ok(tooltip.includes(`Ctrl+Alt+${position} jumps here, Ctrl+Alt+Shift+${position} opens it in its own window`), tooltip);
    } else {
      assert.equal(tooltip, `${row.label}: Right-click for more.`);
    }
  }
});
