/**
 * Row clicks and list refreshes (0.6.0 RC: "I click a chat and it doesn't
 * come up"). The editor hands a row's command to the workbench as a cache id
 * when it has arguments, and disposes that id when the row is refreshed; a
 * click on a row drawn before the refresh then runs a disposed id ("Actual
 * command not found, wanted to execute pitwall.openChat /4105") and nothing
 * opens. The stub tree view models that converter (see `vscode-stub.js`).
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from '../../../src/core/providers/WorkspacesTreeProvider';
import { HarnessRegistry } from '../../../src/core/harness/HarnessRegistry';
import { SessionStatus } from '../../../src/core/providers/sessionStatus';
import { ChatSession, Repository } from '../../../src/core/types';
import { FakeTreeView, fakeAdapter, fakeWorktreeListing, makeStorage, stub, waitFor, worktreeRecord } from '../support';

beforeEach(() => stub.__reset());

const HOUR = 60 * 60_000;
const terminals = { onTerminalStateChange: () => ({ dispose: () => undefined }), isActive: () => false };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The owner's kind of list: `repos` repos with `perRepo` chats each, every
 * chat idle since hours ago (so no row text moves with the clock), drawn in
 * a visible tree view with every repo expanded, and the row commands
 * recorded instead of opening anything.
 */
async function ownerList(t: { after(fn: () => void): void }, repos = 3, perRepo = 6) {
  stub.__setTreeViewsVisible(true);
  const storage = makeStorage();
  const statuses = new Map<string, [SessionStatus, number]>();
  const statusEmitter = new vscode.EventEmitter<string[]>();
  const chats: ChatSession[] = [];
  const repoList: Repository[] = [];
  const since = Date.now() - 3 * HOUR;
  for (let r = 0; r < repos; r++) {
    const repo = storage.addRepository(`repo${r}`, `/work/repo${r}`);
    repoList.push(repo);
    for (let c = 0; c < perRepo; c++) {
      const chat = storage.createChat(`wt-repo${r}`, 'claude', `chat ${r}.${c}`, { harnessSessionId: `s-${r}-${c}` });
      chats.push(chat);
      statuses.set(chat.id, ['idle', since - c * 1000]);
    }
  }
  const listing = (repoId: string) => {
    const repo = storage.getRepository(repoId)!;
    return { isGit: true, worktrees: [worktreeRecord({ id: `wt-${repo.name}`, repoId, path: repo.rootPath, branch: 'main' })] };
  };
  for (const repo of repoList) {
    storage.saveWorktreeSnapshot(repo.id, listing(repo.id));
  }
  const tree = new WorkspacesTreeProvider(
    storage,
    { ...fakeWorktreeListing((_root: string, repoId: string) => listing(repoId)), getAheadBehind: () => null } as never,
    terminals as never,
    new HarnessRegistry([fakeAdapter('claude', { getSessionMetadata: async () => ({ lastActivity: since, preview: [] }) })]),
    vscode.Uri.file('/extension')
  );
  t.after(() => tree.dispose());
  tree.setStatusSource({
    statusOf: (chatId) => {
      const [status, statusSince] = statuses.get(chatId) ?? ['idle', 0];
      return { status, statusSince };
    },
    onDidChangeStatus: statusEmitter.event,
  });
  const setStatus = (chat: ChatSession, status: SessionStatus, at = Date.now()) => {
    statuses.set(chat.id, [status, at]);
    statusEmitter.fire([chat.id]);
  };

  const opened: string[] = [];
  const openedRepos: string[] = [];
  const registrations = [
    vscode.commands.registerCommand('pitwall.openChat', (item?: WorkspaceTreeItem) => {
      opened.push((item?.data as ChatSession | undefined)?.id ?? 'none');
    }),
    vscode.commands.registerCommand('pitwall.openRepoChats', (item?: WorkspaceTreeItem) => {
      openedRepos.push((item?.data as Repository | undefined)?.id ?? 'none');
    }),
  ];
  t.after(() => registrations.forEach((registration) => registration.dispose()));

  const view = vscode.window.createTreeView('pitwall.workspacesView', { treeDataProvider: tree }) as unknown as FakeTreeView;
  const roots = (await waitFor(
    async () => {
      const rows = (await view.__render()) as WorkspaceTreeItem[] | undefined;
      return rows && rows.length === repos ? rows : undefined;
    },
    'the first render'
  )) as WorkspaceTreeItem[];
  for (const row of roots) {
    await view.__expand(row);
  }
  // Background listings land and settle before any test counts refreshes.
  await sleep(450);
  const fires: unknown[] = [];
  tree.onDidChangeTreeData((change) => fires.push(change));
  view.fullRefreshes = 0;
  view.elementRefreshes = 0;
  view.ignoredRefreshes = 0;
  return { tree, view, storage, chats, repos: repoList, setStatus, opened, openedRepos, fires };
}

test('a chat row drawn before a full refresh still opens its chat when clicked in the gap', async (t) => {
  const { tree, view, chats, repos, opened, openedRepos } = await ownerList(t);
  view.__renderDelayMs = 250; // the refresh is on its way to the workbench
  tree.refresh(); // a hard refresh: always a full one
  await waitFor(() => view.fullRefreshes > 0, 'the full refresh');

  // The workbench still shows the rows it drew before; the user clicks them.
  await view.__click({ id: `chat-${chats[4].id}` });
  await view.__click({ id: `repository-${repos[1].id}` });
  assert.deepEqual(view.treeErrors, [], 'no click ran a disposed command');
  assert.deepEqual(opened, [chats[4].id], 'the clicked chat opened');
  assert.deepEqual(openedRepos, [repos[1].id], 'the clicked repo opened its chats');
});

test('an unchanged status or order tick fires no tree refresh at all', async (t) => {
  const { tree, view, chats, setStatus, fires } = await ownerList(t);
  // The 60 s scan, a focus change, the registry, a turn-mark tick and a
  // status event whose status did not change: nothing visible changed.
  tree.softRefresh();
  tree.setWindows([]);
  tree.softRefresh();
  setStatus(chats[0], 'idle', Date.now() - 3 * HOUR);
  await sleep(700);
  assert.equal(fires.length, 0, `no refresh fired, got ${fires.length}`);
  assert.equal(view.fullRefreshes, 0);
});

test('a single status change refreshes that row alone, never the whole list', async (t) => {
  const { view, chats, setStatus, fires } = await ownerList(t);
  // The first chat of the first repo starts working. It already heads its
  // repo, which already heads the list, and the repo's summary ("6
  // sessions") stays: only that row's text and dot change.
  const topRepo = view.__rowOf(view.__childIds()[0]!);
  const topRowId = view.__childIds(topRepo)[0]!;
  const chat = chats.find((candidate) => `chat-${candidate.id}` === topRowId)!;
  const rendered = view.__rowOf(topRowId) as WorkspaceTreeItem;
  setStatus(chat, 'working');
  await waitFor(() => fires.length > 0, 'a refresh');
  await sleep(400);
  assert.equal(view.fullRefreshes, 0, 'no full refresh');
  assert.equal(view.ignoredRefreshes, 0, 'every refreshed row is one the editor holds');
  assert.equal(fires.length, 1, 'one refresh');
  assert.ok(fires[0] !== undefined, 'element-level, not the whole tree');
  assert.deepEqual(([] as unknown[]).concat(fires[0]), [rendered], 'that row alone, as the object the editor holds');
  assert.match(String(rendered.description), /working/, 'the row shows the new status');
});

test('a burst of status changes inside the coalescing window fires one refresh', async (t) => {
  const { view, chats, setStatus, fires } = await ownerList(t);
  // Ten changes well inside one window (a timer-based spacing stretches past
  // 300 ms on a loaded machine, which is then two windows, rightly two refreshes).
  for (let i = 0; i < 10; i++) {
    setStatus(chats[(i * 7) % chats.length], i % 2 ? 'working' : 'finished');
    await new Promise((resolve) => setImmediate(resolve));
  }
  await waitFor(() => fires.length > 0, 'a refresh');
  await sleep(600);
  assert.equal(fires.length, 1, `one refresh for the burst, got ${fires.length}`);
  assert.equal(view.ignoredRefreshes, 0);
});

test('owner-like load: 20 rapid row clicks while 18 chats keep changing status all open the clicked chat', async (t) => {
  const { view, chats, setStatus, opened } = await ownerList(t);
  // Statuses change every 400 ms (slower than the old 300 ms debounce, which
  // otherwise never fired under churn), and each refresh takes 150 ms to
  // reach the workbench: the gaps the owner's clicks fell into.
  view.__renderDelayMs = 150;
  const statuses: SessionStatus[] = ['working', 'finished', 'needs', 'idle'];
  const expected: string[] = [];
  let churn = 0;
  const churner = setInterval(() => {
    churn += 1;
    setStatus(chats[(churn * 5) % chats.length], statuses[churn % statuses.length]);
  }, 400);
  t.after(() => clearInterval(churner));
  for (let click = 0; click < 20; click++) {
    const chat = chats[(click * 11) % chats.length];
    expected.push(chat.id);
    await view.__click({ id: `chat-${chat.id}` });
    await sleep(60);
  }
  clearInterval(churner);
  assert.deepEqual(
    view.treeErrors.filter((line) => line.startsWith('Actual command not found')),
    [],
    'no click hit a disposed command'
  );
  assert.deepEqual(opened, expected, '20/20 clicks opened the chat clicked');
});

test("a reveal after a chat is added waits until the editor has its repo's new session rows (L1)", async (t) => {
  const { tree, view, storage, repos, fires } = await ownerList(t);
  view.__renderDelayMs = 150;
  const repoRowId = `repository-${repos[0].id}`;
  const added = storage.createChat(`wt-${repos[0].name}`, 'claude', 'added chat', { harnessSessionId: 'added' });
  tree.softRefresh();
  let settled = false;
  const waiting = tree.whenSettled().then(() => {
    settled = true;
  });
  await waitFor(() => fires.length > 0, 'the refresh');
  assert.equal(view.fullRefreshes, 0, 'a row added under a repo refreshes that repo row, not the list');
  assert.deepEqual(([] as unknown[]).concat(fires[0]), [view.__rowOf(repoRowId)]);
  await sleep(50);
  assert.equal(settled, false, 'not settled before the editor asks for the new rows');
  await waiting;
  assert.ok(view.__childIds(view.__rowOf(repoRowId)).includes(`chat-${added.id}`), 'settled once the editor holds the new row');
});
