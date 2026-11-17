/**
 * The search box (row 3.9, Ctrl+Alt+R, §3e): repos and chats in one quick pick,
 * and a footer that hands the typed text to Find Session.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import pkg from '../../../package.json';
import { registerNavigationCommands } from '../../../src/core/commands/navigation';
import { registerSearchCommands } from '../../../src/core/commands/search';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from '../../../src/core/providers/WorkspacesTreeProvider';
import { HarnessRegistry } from '../../../src/core/harness/HarnessRegistry';
import { SessionStatus } from '../../../src/core/providers/sessionStatus';
import { RepositoryWorktrees } from '../../../src/core/types';
import { FakeQuickPick, FakeTreeView, fakeAdapter, makeStorage, runCommand, stub, worktreeRecord } from '../support';

beforeEach(() => stub.__reset());

const SEPARATOR = vscode.QuickPickItemKind.Separator;
const REPOS = '--REPOS--';
const CHATS = '--CHATS · by name or branch--';
const INSIDE = '--INSIDE CHATS--';
const LATER = 'later: instant text search (roadmap)';
const labels = (pick: FakeQuickPick) => pick.items.map((item) => (item.kind === SEPARATOR ? `--${item.label}--` : item.label));
const chatLabels = (pick: FakeQuickPick) => labels(pick).filter((label) => ['Fix login', 'Parser spike'].includes(label));

/** Repos alpha (chats "Fix login" on main, needing you, and "Parser spike" on feat/parse) and beta (none). */
function setup(t: { after(fn: () => void): void }) {
  const storage = makeStorage();
  const statuses = new Map<string, SessionStatus>();
  const worktrees = new Map<string, ReturnType<typeof worktreeRecord>>();
  for (const name of ['alpha', 'beta']) {
    const repo = storage.addRepository(name, `/work/${name}`);
    worktrees.set(repo.id, worktreeRecord({ id: `wt-${name}`, repoId: repo.id, name, path: `/work/${name}`, branch: 'main' }));
  }
  const login = storage.createChat('wt-alpha', 'claude', 'Fix login', { harnessSessionId: 's1' });
  const parser = storage.createChat('wt-alpha', 'claude', 'Parser spike', { harnessSessionId: 's2' });
  const tree = new WorkspacesTreeProvider(
    storage,
    {
      listRepositoryWorktrees: (_root: string, repoId: string): RepositoryWorktrees => ({ isGit: true, worktrees: [worktrees.get(repoId)!] }),
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
  statuses.set(login.id, 'needs');
  tree.refresh();
  const workspacesView = vscode.window.createTreeView('pitwall.workspacesView', { treeDataProvider: tree }) as unknown as FakeTreeView;
  const filesView = vscode.window.createTreeView('pitwall.filesView', { treeDataProvider: { getChildren: async () => [] } as never }) as unknown as FakeTreeView;
  const context = { subscriptions: [] as { dispose(): void }[] };
  registerNavigationCommands(context as never, { workspacesProvider: tree, workspacesTreeView: workspacesView as never, filesTreeView: filesView as never });
  registerSearchCommands(context as never, { workspacesProvider: tree });
  const calls: { id: string; args: unknown[] }[] = [];
  for (const id of ['pitwall.openChat', 'pitwall.findSession']) {
    context.subscriptions.push(vscode.commands.registerCommand(id, (...args: unknown[]) => void calls.push({ id, args })));
  }
  t.after(() => context.subscriptions.forEach((entry) => entry.dispose()));
  return { workspacesView, calls, login, parser };
}

/** Run the command and return the quick pick it opened. */
async function open(): Promise<FakeQuickPick> {
  await runCommand('pitwall.search');
  const pick = stub.__quickPicks.at(-1);
  assert.ok(pick?.shown, 'the search box is open');
  return pick;
}

const footer = (pick: FakeQuickPick) => pick.items.at(-1)!;

test('the search box shows the canvas placeholder, groups and footer', async (t) => {
  setup(t);
  const pick = await open();
  assert.equal(pick.placeholder, 'Search repos, chats, and what was said in them  (Ctrl+Alt+R)');
  assert.equal(pick.matchOnDescription, true);
  assert.deepEqual(labels(pick), [
    REPOS, 'alpha', 'beta',
    CHATS, 'Fix login', 'Parser spike',
    INSIDE, LATER,
    '----',
    footer(pick).label,
  ]);
  assert.equal(footer(pick).label, "$(sparkle) Can't find it? Describe it and let an agent search your chats");
  assert.equal(footer(pick).description, "Agntree's Find Session");
  assert.equal(pick.items.find((item) => item.label === 'alpha')!.description, '2 sessions', 'a repo row shows a count, not the sidebar summary');
  assert.equal(pick.items.find((item) => item.label === 'beta')!.description, '0 sessions');
  assert.equal(pick.sortByLabel, false, 'VS Code must not re-sort the rows or drop the separators');
  assert.match(pick.items.find((item) => item.label === 'Fix login')!.description ?? '', /^alpha · ⎇ main/);
});

test('typing filters repos by name and chats by name or branch', async (t) => {
  setup(t);
  const pick = await open();
  pick.__type('alp');
  assert.deepEqual(labels(pick).slice(0, 3), [REPOS, 'alpha', CHATS]);
  assert.ok(!labels(pick).includes('beta'));
  pick.__type('PARSER');
  assert.deepEqual(chatLabels(pick), ['Parser spike'], 'chat names match without case');
  assert.ok(!labels(pick).includes('alpha'), 'a chat hit is not a repo hit');
  pick.__type('main');
  assert.deepEqual(chatLabels(pick), ['Fix login', 'Parser spike'], 'the branch matches');
  assert.ok(pick.items.every((item) => item.kind === SEPARATOR || item.alwaysShow), 'the box filters itself, so every row stays');
});

test('empty groups show "No repo matches." / "No chat name matches."', async (t) => {
  setup(t);
  const pick = await open();
  pick.__type('zzz');
  assert.deepEqual(labels(pick), [REPOS, 'No repo matches.', CHATS, 'No chat name matches.', INSIDE, LATER, '----', footer(pick).label]);
  pick.__accept(pick.items.find((item) => item.label === 'No repo matches.'));
  assert.equal(pick.hidden, true, 'picking a placeholder row just closes the box');
});

test('picking a chat opens it; picking a repo reveals it', async (t) => {
  const { calls, workspacesView, login } = setup(t);
  let pick = await open();
  pick.__accept(pick.items.find((item) => item.label === 'Fix login'));
  assert.deepEqual(
    calls.map((call) => [call.id, ((call.args[0] as WorkspaceTreeItem).data as { id: string }).id]),
    [['pitwall.openChat', login.id]]
  );
  assert.equal(pick.hidden, true);

  pick = await open();
  pick.__accept(pick.items.find((item) => item.label === 'beta'));
  assert.deepEqual(workspacesView.reveals.map((reveal) => (reveal.item as WorkspaceTreeItem).label), ['beta']);
  assert.deepEqual(workspacesView.reveals[0].options, { select: true, focus: true, expand: true });
});

test('the footer starts Find Session with the typed text', async (t) => {
  const { calls } = setup(t);
  const pick = await open();
  pick.__type('the one about invoices');
  pick.__accept(footer(pick));
  assert.deepEqual(calls.map((call) => [call.id, call.args[0]]), [['pitwall.findSession', 'the one about invoices']]);
  assert.equal(pick.hidden, true);
});

test('Ctrl+Alt+R is bound to pitwall.search (Ctrl+Cmd+R on macOS) and the title bar shows the search icon', () => {
  const bound = (pkg.contributes.keybindings as { command: string; key: string; mac?: string; when?: string }[]).filter((entry) => entry.key === 'ctrl+alt+r');
  assert.deepEqual(bound.map((entry) => [entry.command, entry.mac, entry.when]), [['pitwall.search', 'ctrl+cmd+r', undefined]]);
  const command = (pkg.contributes.commands as { command: string; icon?: string }[]).find((entry) => entry.command === 'pitwall.search');
  assert.equal(command?.icon, '$(search)');
});

test('Enter picks the first result: a repo, else a chat, else the footer', async (t) => {
  const { calls, login } = setup(t);
  const pick = await open();
  assert.equal(pick.activeItems[0]?.label, 'alpha', 'with no text the first repo is active');
  pick.__type('login');
  assert.equal(pick.activeItems[0]?.label, 'Fix login', 'only a chat matches, so it is the default row, not "No repo matches."');
  pick.__accept(pick.activeItems[0]);
  assert.deepEqual(calls.map((call) => [call.id, ((call.args[0] as WorkspaceTreeItem).data as { id: string }).id]), [['pitwall.openChat', login.id]]);
  const again = await open();
  again.__type('zzz');
  assert.equal(again.activeItems[0], footer(again), 'nothing matches, so the footer is the default row');
});

test('no two consecutive rows are both separators, however the box is filtered', async (t) => {
  setup(t);
  const pick = await open();
  for (const text of ['', 'alp', 'login', 'zzz', 'main']) {
    pick.__type(text);
    pick.items.forEach((item, at) => {
      assert.ok(!(item.kind === SEPARATOR && pick.items[at + 1]?.kind === SEPARATOR), `"${text}": separators back to back at ${at}`);
    });
  }
});
