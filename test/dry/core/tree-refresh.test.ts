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
import { CHILDREN_AWAIT_TIMEOUT_MS, WorkspaceTreeItem, WorkspacesTreeProvider } from '../../../src/core/providers/WorkspacesTreeProvider';
import { registerNavigationCommands } from '../../../src/core/commands/navigation';
import { HarnessRegistry } from '../../../src/core/harness/HarnessRegistry';
import { SessionStatus } from '../../../src/core/providers/sessionStatus';
import { ChatSession, Repository } from '../../../src/core/types';
import type { OpenSource } from '../../../src/core/windows/openSource';
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
  /** Each session's last reply, shown only in its row's tooltip. */
  const replies = new Map<string, { text: string; timestamp: null }>();
  const metadataGate: { current?: Deferred; calls: number } = { calls: 0 };
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
    new HarnessRegistry([
      fakeAdapter('claude', {
        getSessionMetadata: async (sessionId: string) => {
          // A gate set by a test holds every read made while it is set.
          const held = metadataGate.current;
          if (held) {
            metadataGate.calls += 1;
            await held.promise;
          }
          return { lastActivity: since, preview: [], lastReply: replies.get(sessionId) ?? null };
        },
      }),
    ]),
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
  /** What each open said asked for it (the `via=` of its route line), in order. */
  const sources: (OpenSource | undefined)[] = [];
  const registrations = [
    vscode.commands.registerCommand('pitwall.openChat', (item?: WorkspaceTreeItem, source?: OpenSource) => {
      opened.push((item?.data as ChatSession | undefined)?.id ?? 'none');
      sources.push(source);
    }),
    vscode.commands.registerCommand('pitwall.openRepoChats', (item?: WorkspaceTreeItem, source?: OpenSource) => {
      openedRepos.push((item?.data as Repository | undefined)?.id ?? 'none');
      sources.push(source);
    }),
  ];
  t.after(() => registrations.forEach((registration) => registration.dispose()));

  const treeView = vscode.window.createTreeView('pitwall.workspacesView', { treeDataProvider: tree });
  // As extension.ts wires it.
  const collapses = treeView.onDidCollapseElement(({ element }) => tree.onRowCollapsed(element));
  t.after(() => collapses.dispose());
  const view = treeView as unknown as FakeTreeView;
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
  return { tree, view, storage, chats, repos: repoList, setStatus, opened, openedRepos, sources, fires, replies, metadataGate };
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** The provider's private state a test inspects (the editor-side view of it is in the stub). */
function internals(tree: WorkspacesTreeProvider) {
  return tree as unknown as { flushing: boolean; renderedChildren: Map<string, unknown> };
}

/** The row the editor holds at the top of the top repo, and its chat. */
function topChat(view: FakeTreeView, chats: ChatSession[]) {
  const repoRow = view.__rowOf(view.__childIds()[0]!) as WorkspaceTreeItem;
  const rowId = view.__childIds(repoRow)[0]!;
  return { repoRow, rowId, chat: chats.find((candidate) => `chat-${candidate.id}` === rowId)! };
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

/** What a row shows besides its description, for "only the description changed". */
function otherText(row: WorkspaceTreeItem) {
  return JSON.stringify([row.label, tooltipText(row), row.contextValue, row.collapsibleState, row.iconPath]);
}

function tooltipText(row: WorkspaceTreeItem): string | undefined {
  return typeof row.tooltip === 'string' ? row.tooltip : row.tooltip?.value;
}

test('a repo the user collapsed never holds a reveal, and expanding it later fires no stale reveal (QA #74 F1)', async (t) => {
  const { tree, view, storage, repos, fires } = await ownerList(t);
  const repoRow = view.__rowOf(`repository-${repos[0].id}`) as WorkspaceTreeItem;
  view.__collapse(repoRow);
  // A chat is added under the collapsed repo: only the repo row's summary changes.
  const added = storage.createChat(`wt-${repos[0].name}`, 'claude', 'added chat', { harnessSessionId: 'added' });
  tree.softRefresh();
  let reveals = 0;
  const started = Date.now();
  const revealing = tree.revealWhenSettled(async () => {
    reveals += 1;
  });
  await waitFor(() => reveals > 0, 'the reveal');
  await revealing;
  assert.ok(Date.now() - started < CHILDREN_AWAIT_TIMEOUT_MS, `revealed in ${Date.now() - started} ms, before the backstop`);
  assert.deepEqual(([] as unknown[]).concat(fires[0]), [repoRow], 'the collapsed repo row alone is refreshed');
  assert.match(String(repoRow.description), /^7 sessions$/, 'the held repo row shows its new summary');

  await view.__expand(repoRow);
  await sleep(400);
  assert.equal(reveals, 1, 'expanding the repo fired no second reveal');
  assert.ok(view.__childIds(repoRow).includes(`chat-${added.id}`), 'the expanded repo shows the new chat');
  assert.deepEqual(view.treeErrors, []);
});

test('a collapse the extension never hears of holds a reveal only until the backstop (QA #74 F1)', async (t) => {
  const { tree, view, storage, repos, fires } = await ownerList(t);
  const repoRow = view.__rowOf(`repository-${repos[0].id}`) as WorkspaceTreeItem;
  view.__collapse(repoRow, { report: false });
  storage.createChat(`wt-${repos[0].name}`, 'claude', 'added chat', { harnessSessionId: 'added' });
  tree.softRefresh();
  await waitFor(() => fires.length > 0, 'the refresh');
  let reveals = 0;
  const started = Date.now();
  void tree.revealWhenSettled(async () => {
    reveals += 1;
  });
  await sleep(300);
  assert.equal(reveals, 0, 'still waiting for session rows the editor will never fetch');
  await waitFor(() => reveals > 0, 'the reveal after the backstop', CHILDREN_AWAIT_TIMEOUT_MS + 2_000);
  assert.ok(Date.now() - started < CHILDREN_AWAIT_TIMEOUT_MS + 1_000, `revealed after ${Date.now() - started} ms`);

  await view.__expand(repoRow);
  await sleep(400);
  assert.equal(reveals, 1, 'expanding the repo fired no second reveal');
});

test("a chat opened in another window refreshes its repo row, though only the repo's summary changes", async (t) => {
  const { tree, view, chats, fires } = await ownerList(t);
  const { repoRow, rowId, chat } = topChat(view, chats);
  const before = otherText(repoRow);
  tree.setWindows([{ folder: '/elsewhere', openSessionIds: [chat.harnessSessionId!] }]);
  await waitFor(() => fires.length > 0, 'a refresh');
  await sleep(400);
  assert.equal(view.fullRefreshes, 0);
  assert.equal(view.ignoredRefreshes, 0);
  // The repo row's refresh redraws its session rows too.
  assert.deepEqual(([] as unknown[]).concat(...fires), [repoRow]);
  assert.match(String(repoRow.description), /^1 open$/);
  assert.equal(otherText(repoRow), before, "nothing but the repo row's description changed");
  assert.match(String((view.__rowOf(rowId) as WorkspaceTreeItem).description), / · open$/, 'the chat row shows " · open"');
});

test("a chat's status time moving refreshes its row, though its label, menu and icon stay", async (t) => {
  const { view, chats, setStatus, fires } = await ownerList(t);
  const { rowId, chat } = topChat(view, chats);
  setStatus(chat, 'finished', Date.now() - 2 * HOUR);
  await waitFor(() => fires.length > 0, 'the first refresh');
  await sleep(600);
  const chatRow = view.__rowOf(rowId) as WorkspaceTreeItem;
  assert.match(String(chatRow.description), /finished · 2h/);
  const shape = (row: WorkspaceTreeItem) => JSON.stringify([row.label, row.contextValue, row.collapsibleState, row.iconPath]);
  const before = shape(chatRow);
  fires.length = 0;
  // Finished again just now: same status, place and icon; only "2h" becomes "now" (description and tooltip).
  setStatus(chat, 'finished');
  await waitFor(() => fires.length > 0, 'a refresh');
  await sleep(400);
  assert.equal(view.ignoredRefreshes, 0);
  assert.deepEqual(([] as unknown[]).concat(...fires), [chatRow], 'that row alone');
  assert.doesNotMatch(String(chatRow.description), /2h/);
  assert.equal(shape(chatRow), before, 'label, menu, collapse state and icon are unchanged');
});

test('a new last reply refreshes its row, though only its tooltip changes', async (t) => {
  const { tree, view, chats, fires, replies } = await ownerList(t);
  const { rowId, chat } = topChat(view, chats);
  const chatRow = view.__rowOf(rowId) as WorkspaceTreeItem;
  const description = chatRow.description;
  replies.set(chat.harnessSessionId!, { text: 'All tests pass.', timestamp: null });
  tree.softRefresh();
  await waitFor(() => fires.length > 0, 'a refresh');
  await sleep(400);
  assert.deepEqual(([] as unknown[]).concat(...fires), [chatRow]);
  assert.equal(chatRow.description, description);
  assert.match(tooltipText(chatRow) ?? '', /All tests pass\./);
});

test('drawing a row again reuses its click command (VS Code throws on a second registration)', async (t) => {
  const { tree, view, chats, repos, opened } = await ownerList(t);
  // ownerList drew every row once; the editor and search draw them again.
  await view.__render();
  for (const repo of repos) {
    await tree.sessionRowsOfRepoRow(view.__rowOf(`repository-${repo.id}`) as WorkspaceTreeItem);
  }
  const rowCommands = (await vscode.commands.getCommands()).filter((id) => id.startsWith('_pitwall.row.'));
  assert.equal(rowCommands.length, repos.length + chats.length, 'one command per row');
  await view.__click({ id: `chat-${chats[2].id}` });
  assert.deepEqual(opened, [chats[2].id]);
});

test('rows the editor takes while a pass draws are compared in a new pass, not the rows it held before', async (t) => {
  const { view, chats, setStatus, metadataGate } = await ownerList(t);
  const { repoRow, chat } = topChat(view, chats);
  const gate = deferred();
  metadataGate.current = gate;
  setStatus(chat, 'needs'); // the repo row's summary becomes "1 needs you"
  await waitFor(() => metadataGate.calls > 0, 'the pass reading metadata');
  metadataGate.current = undefined;
  // The workbench renders the list again meanwhile (it was shown again).
  await view.__render();
  assert.notEqual(view.__rowOf(repoRow.id!), repoRow, 'the editor holds new row objects');
  gate.resolve();
  await sleep(800);
  assert.equal(view.ignoredRefreshes, 0, 'no refresh named a row the editor no longer holds');
  assert.match(String((view.__rowOf(repoRow.id!) as WorkspaceTreeItem).description), /needs you/);
});

test('session rows answered after a full refresh overtook them are never compared against', async (t) => {
  const { tree, view, chats, setStatus, metadataGate, fires } = await ownerList(t);
  const { repoRow, rowId, chat } = topChat(view, chats);
  const gate = deferred();
  metadataGate.current = gate;
  // The editor asks for a repo's session rows, and a full refresh overtakes the answer.
  const overtaken = tree.getChildren(repoRow);
  await waitFor(() => metadataGate.calls > 0, 'the answer reading metadata');
  metadataGate.current = undefined;
  tree.refresh();
  await waitFor(() => view.fullRefreshes > 0, 'the full refresh');
  await tree.whenSettled();
  await waitFor(() => internals(tree).renderedChildren.size === 3, 'the expanded repos rendered again');
  gate.resolve();
  await overtaken;
  fires.length = 0;
  setStatus(chat, 'working'); // the row's text changes; its place and its repo row's text do not
  await waitFor(() => fires.length > 0, 'a refresh');
  await sleep(400);
  assert.equal(view.ignoredRefreshes, 0, 'every refreshed row is one the editor holds');
  assert.match(String((view.__rowOf(rowId) as WorkspaceTreeItem).description), /working/);
});

test("a chat moving up inside its repo makes a reveal wait for that repo's new session rows", async (t) => {
  const { tree, view, chats, setStatus, fires } = await ownerList(t);
  view.__renderDelayMs = 150;
  const repoRow = view.__rowOf(view.__childIds()[0]!) as WorkspaceTreeItem;
  const lastId = view.__childIds(repoRow).at(-1)!;
  const chat = chats.find((candidate) => `chat-${candidate.id}` === lastId)!;
  const descriptionBefore = repoRow.description;
  setStatus(chat, 'working'); // working sits above idle inside a repo; the repo's summary stays
  let settled = false;
  const waiting = tree.whenSettled().then(() => {
    settled = true;
  });
  await waitFor(() => fires.length > 0, 'the refresh');
  assert.equal(view.fullRefreshes, 0);
  assert.deepEqual(([] as unknown[]).concat(fires[0]), [repoRow], 'the repo row is refreshed to redraw its rows');
  assert.equal(repoRow.description, descriptionBefore, "the repo row's own text did not change");
  await sleep(50);
  assert.equal(settled, false, 'not settled before the editor asks for the moved rows');
  await waiting;
  assert.equal(view.__childIds(repoRow)[0], lastId, 'settled once the editor holds the new order');
});

test("a removed chat's click command is disposed once the editor's rows no longer show it (QA #74 F5)", async (t) => {
  const { tree, view, storage, chats, repos } = await ownerList(t);
  const removed = chats[3];
  const kept = chats[4];
  const repoRow = view.__rowOf(`repository-${repos.find((repo) => `wt-${repo.name}` === removed.worktreeId)!.id}`);
  const command = `_pitwall.row.chat-${removed.id}`;
  assert.ok((await vscode.commands.getCommands()).includes(command));
  storage.deleteChats([removed.id]);
  tree.softRefresh();
  await tree.whenSettled();
  await waitFor(async () => !(await vscode.commands.getCommands()).includes(command), 'the command disposed');
  assert.ok((await vscode.commands.getCommands()).includes(`_pitwall.row.chat-${kept.id}`), 'other rows keep theirs');
  assert.ok(!view.__childIds(repoRow).includes(`chat-${removed.id}`), 'the editor no longer shows the removed row');
});

// ---- 0.6.0 gate (unrequested opens): every row open says what asked for it ----

const chatRow = (chat: ChatSession) => `chat-${chat.id}`;
const repoRowId = (repo: Repository) => `repository-${repo.id}`;

/** Chat r.c of the fixture: repo0..repo2, each expanded with chat r.0..r.5 (newest first). */
const at = (chats: ChatSession[], r: number, c: number) => chats.find((chat) => chat.name === `chat ${r}.${c}`)!;

/** Wire the selection as extension.ts does: its selection handler notes the selection first. */
function wireSelection(t: { after(fn: () => void): void }, tree: WorkspacesTreeProvider, view: FakeTreeView): void {
  view.__revealSelects = true;
  const subscription = (view as unknown as vscode.TreeView<WorkspaceTreeItem>).onDidChangeSelection(({ selection }) =>
    tree.noteSelection(selection)
  );
  t.after(() => subscription.dispose());
}

/**
 * The navigation commands as extension.ts registers them. `list.select`
 * acts like the workbench's: it selects the row the list focus is on
 * (`landOn`) and runs that row's command.
 */
function wireKeys(t: { after(fn: () => void): void }, tree: WorkspacesTreeProvider, view: FakeTreeView) {
  const context = { subscriptions: [] as { dispose(): void }[] };
  registerNavigationCommands(context as never, {
    workspacesProvider: tree,
    workspacesTreeView: view as never,
    filesTreeView: { visible: false } as never,
  });
  const keys = { landOn: '' };
  context.subscriptions.push(
    vscode.commands.registerCommand('list.focusDown', () => undefined),
    vscode.commands.registerCommand('list.select', () => {
      view.__select([view.__rowOf(keys.landOn)]);
      void view.__click({ id: keys.landOn });
    })
  );
  t.after(() => context.subscriptions.forEach((entry) => entry.dispose()));
  return keys;
}

/** `selected=new+<ms>ms` with the ms read out, or the detail as it is. */
const shape = (source: OpenSource | undefined) =>
  source && { via: source.via, detail: source.detail?.replace(/selected=new\+\d+ms/, 'selected=new+Nms') };

test('a row open carries its via: a click selected=new, Enter selected=already, a repo click, a Ctrl+Down move (0.6.0 gate)', async (t) => {
  const { tree, view, chats, repos, sources } = await ownerList(t);
  wireSelection(t, tree, view);
  const keys = wireKeys(t, tree, view);
  // A pointer click: the workbench selects the row, then runs its command at once.
  await view.__mouseClick({ id: chatRow(at(chats, 1, 2)) });
  // Enter on the row already selected: the command alone.
  await view.__click({ id: chatRow(at(chats, 1, 2)) });
  // A click on a repo row.
  await view.__mouseClick({ id: repoRowId(repos[2]) });
  // Ctrl+Down: list.select selects the row the focus landed on and runs its command.
  keys.landOn = chatRow(at(chats, 2, 3));
  await vscode.commands.executeCommand('pitwall.list.moveDownAndOpen');
  await waitFor(() => sources.length === 4, 'the four opens');
  assert.deepEqual(sources.map(shape), [
    { via: 'row-click', detail: 'selected=new+Nms' },
    { via: 'row-click', detail: 'selected=already' },
    { via: 'repo-click', detail: 'selected=new+Nms' },
    { via: 'keyboard-move', detail: 'selected=new+Nms' },
  ]);
});
