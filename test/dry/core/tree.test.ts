import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { WorkspaceTreeItem, WorkspacesTreeProvider, repoTooltip } from '../../../src/core/providers/WorkspacesTreeProvider';
import { HarnessRegistry } from '../../../src/core/harness/HarnessRegistry';
import { HarnessAdapter, SessionMetadata } from '../../../src/core/harness/types';
import { SessionStatus } from '../../../src/core/providers/sessionStatus';
import { ChatSession, Repository, RepositoryWorktrees, Worktree } from '../../../src/core/types';
import { disposeOperationLog } from '../../../src/core/services/OperationLog';
import { fakeAdapter, fakeNativeUi, makeStorage, memento, flush, stub, waitFor, worktreeRecord } from '../support';

beforeEach(() => stub.__reset());

const MINUTE = 60_000;
const terminals = { onTerminalStateChange: () => ({ dispose: () => undefined }), isActive: () => false };

function provider(
  t: { after(fn: () => void): void },
  storage: ReturnType<typeof makeStorage>,
  listWorktrees: (repo: Repository) => RepositoryWorktrees,
  adapters: HarnessAdapter[]
) {
  const tree = new WorkspacesTreeProvider(
    storage,
    {
      listRepositoryWorktrees: (_rootPath: string, repoId: string) =>
        listWorktrees(storage.getRepository(repoId)!),
      getAheadBehind: () => null,
    } as never,
    terminals as never,
    new HarnessRegistry(adapters),
    vscode.Uri.file('/extension')
  );
  t.after(() => tree.dispose());
  return tree;
}

/** A status source the test drives: each chat's status and when it entered it. */
function statusSource(initial: Record<string, [SessionStatus, number]> = {}) {
  const emitter = new vscode.EventEmitter<string[]>();
  const statuses = new Map(Object.entries(initial));
  return {
    statusOf: (chatId: string) => {
      const [status, statusSince] = statuses.get(chatId) ?? ['idle', 0];
      return { status, statusSince };
    },
    onDidChangeStatus: emitter.event,
    set(chatId: string, status: SessionStatus, statusSince: number) {
      statuses.set(chatId, [status, statusSince]);
      emitter.fire([chatId]);
    },
  };
}

/** Lines logged with console.log while the test runs. */
function captureLog(t: { after(fn: () => void): void }) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.log = original;
  });
  return lines;
}

/** One git worktree holding a Claude chat, an opencode chat, and a new chat. */
function sessionRows(t: { after(fn: () => void): void }) {
  const now = Date.now();
  const storage = makeStorage();
  const repo = storage.addRepository('demo', '/work/demo');
  const worktree = worktreeRecord({ repoId: repo.id, path: '/work/demo', branch: 'main' });
  const chat = (id: string, harness: ChatSession['harness'], sessionId: string | null, createdAt: number) => {
    const created = storage.createChat(worktree.id, harness, id);
    return storage.updateChat(created.id, { harnessSessionId: sessionId, createdAt })!;
  };
  const claude = chat('claude', 'claude', 'claude-1', 1);
  const opencode = chat('opencode', 'opencode', 'ses_2', 2);
  const fresh = chat('new', 'opencode', null, 3);
  storage.toggleStar(claude.id);

  let exported = false;
  const claudeUi = fakeNativeUi('Claude Code UI', { contextValueSuffix: 'ClaudeUi' });
  const adapters = [
    fakeAdapter('claude', {
      nativeUi: claudeUi.nativeUi,
      getSessionMetadata: async (): Promise<SessionMetadata> => ({
        lastActivity: now - 16 * MINUTE,
        preview: [{ text: 'claude prompt', timestamp: now - 16 * MINUTE }],
        lastReply: { text: 'claude reply', timestamp: now - 15 * MINUTE },
      }),
    }),
    // Like the opencode service: previews need an export, which metadata
    // includes once it is cached.
    fakeAdapter('opencode', {
      getSessionMetadata: async (): Promise<SessionMetadata> => ({
        lastActivity: now - 33 * MINUTE,
        preview: exported ? [{ text: 'opencode prompt', timestamp: null }] : [],
        model: 'provider/model',
        agent: 'build',
      }),
      getPreview: async () => {
        exported = true;
        return [{ text: 'opencode prompt', timestamp: null }];
      },
    }),
  ];
  const tree = provider(t, storage, () => ({ isGit: true, worktrees: [worktree] }), adapters);
  const rows = async () => {
    const [repoRow] = await tree.getChildren();
    const items = await tree.getChildren(repoRow);
    return Object.assign(new Map(items.map((item) => [item.label, item])), { order: items.map((item) => item.label) });
  };
  return { tree, rows, storage, claude, opencode, fresh, exported: () => exported };
}

const mark = (item: vscode.TreeItem) => ((item.iconPath as { light: vscode.Uri }).light.path.split('/').pop());
const tooltipText = (item: vscode.TreeItem) =>
  typeof item.tooltip === 'string' ? item.tooltip : (item.tooltip as vscode.MarkdownString | undefined)?.value ?? '';

test('session rows sit directly under the repo with branch, status word, time and the harness status dot', async (t) => {
  const { rows } = sessionRows(t);
  const items = await rows();
  assert.deepEqual(items.order, ['new', 'opencode', 'claude'], 'without a status source all are idle, newest first');
  assert.deepEqual(
    ['claude', 'opencode', 'new'].map((label) => `${items.get(label)!.description} | ${mark(items.get(label)!)} | ${items.get(label)!.contextValue}`),
    [
      '⎇ main  idle · 16m | claude-light-idle.svg | starredChatClaudeUi',
      '⎇ main  idle · 33m | opencode-light-idle.svg | chat',
      '⎇ main  new | opencode-light-new.svg | chat',
    ]
  );
});

test('an open chat, by terminal or native UI, keeps its running context and shows " · open"', async (t) => {
  const { tree, rows, claude } = sessionRows(t);
  tree.setChatOpenProvider((chat) => chat.id === claude.id);
  const row = (await rows()).get('claude')!;
  assert.equal(row.contextValue, 'runningStarredChatClaudeUi');
  assert.equal(mark(row), 'claude-light-finished.svg', 'without a status source, an open chat that is not working is finished');
  assert.match(String(row.description), / · open$/);

  tree.setTurnStateProvider(() => 'working');
  assert.equal(mark((await rows()).get('claude')!), 'claude-light-working.svg');
});

test('tooltips brief the last exchange; a lazy harness fetches its preview only on hover', async (t) => {
  const { tree, rows, exported } = sessionRows(t);
  const items = await rows();

  assert.match(tooltipText(items.get('claude')!), /Last exchange[\s\S]*claude prompt[\s\S]*claude reply/);
  assert.match(tooltipText(items.get('new')!), /No messages yet/);

  const opencode = items.get('opencode')!;
  assert.equal(opencode.tooltip, undefined, 'rendering does not export');
  assert.equal(exported(), false);
  await tree.resolveTreeItem(opencode, opencode as WorkspaceTreeItem);
  assert.ok(exported());
  assert.match(tooltipText(opencode), /opencode prompt[\s\S]*provider\/model · build/);
  assert.match(tooltipText(opencode), /Folder: \/work\/demo/, 'the hover-built tooltip keeps the folder line');
});

/** A git repo with a main worktree and one linked worktree, and three chats. */
function worktreeRepo(t: { after(fn: () => void): void }, options: { open?: string[] } = {}) {
  const now = Date.now();
  const storage = makeStorage();
  const repo = storage.addRepository('job-market', '/code/job-market');
  const main = worktreeRecord({ id: 'wt-main', repoId: repo.id, name: 'main', branch: 'main', path: '/code/job-market', isMain: true });
  const linked = worktreeRecord({
    id: 'wt-fiu',
    repoId: repo.id,
    name: 'feat/fiu-apply',
    branch: 'feat/fiu-apply',
    path: '/code/job-market-wt/fiu',
    isMain: false,
  });
  const apply = storage.createChat(main.id, 'claude', 'One-off apply', { harnessSessionId: 's-apply' });
  const networking = storage.createChat(main.id, 'claude', 'Job market networking', { harnessSessionId: 's-net' });
  const scroller = storage.createChat(linked.id, 'claude', 'LinkedIn job scroller', { harnessSessionId: 's-scroll' });
  const statuses = statusSource({
    [apply.id]: ['needs', now - 2 * MINUTE],
    [networking.id]: ['working', now - 30 * MINUTE],
    [scroller.id]: ['finished', now - 14 * MINUTE],
  });
  const tree = provider(t, storage, () => ({ isGit: true, worktrees: [main, linked] }), [fakeAdapter('claude')]);
  tree.setStatusSource(statuses);
  const open = new Set(options.open ?? []);
  tree.setChatOpenProvider((chat) => open.has(chat.name));
  const rows = async () => {
    const [repoRow] = await tree.getChildren();
    const items = await tree.getChildren(repoRow);
    return { repoRow, items, byName: new Map(items.map((item) => [item.label, item])) };
  };
  return { tree, storage, statuses, rows, apply, networking, scroller, main, linked, open };
}

test("a repo shows every worktree's sessions with ⎇ branch, and ⧉ only on non-main worktrees", async (t) => {
  const { rows } = worktreeRepo(t, { open: ['Job market networking'] });
  const { items } = await rows();
  assert.deepEqual(
    items.map((item) => `${item.label} | ${item.description}`),
    [
      'One-off apply | ⎇ main  needs you · 2m',
      'Job market networking | ⎇ main  working · now · open',
      'LinkedIn job scroller | ⎇ feat/fiu-apply ⧉  finished · 14m',
    ],
    'sessions rank needs you, working, finished'
  );
  assert.deepEqual(items.map(mark), ['claude-light-needs.svg', 'claude-light-working.svg', 'claude-light-finished.svg']);
  const withMark = items.filter((item) => String(item.description).includes('⧉'));
  assert.deepEqual(withMark.map((item) => item.label), ['LinkedIn job scroller'], '⧉ on 100% of worktree rows, 0% of main rows');
});

test("a plain-folder repo's rows leave out the branch", async (t) => {
  const storage = makeStorage();
  const repo = storage.addRepository('notes', '/work/notes');
  const folder = worktreeRecord({ id: 'wt-notes', repoId: repo.id, name: 'notes', path: '/work/notes' });
  const chat = storage.createChat(folder.id, 'claude', 'Folder session', { harnessSessionId: 's-folder' });
  const tree = provider(t, storage, () => ({ isGit: false, worktrees: [folder] }), [fakeAdapter('claude')]);
  tree.setStatusSource(statusSource({ [chat.id]: ['finished', Date.now() - 6 * MINUTE] }));
  const [repoRow] = await tree.getChildren();
  const [row] = await tree.getChildren(repoRow);
  assert.equal(row.description, 'finished · 6m');
  assert.match(tooltipText(row), /Folder: \/work\/notes/);
});

test('repo descriptions: "1 needs you · 2 open", "2 sessions", "1 session"', async (t) => {
  const busy = worktreeRepo(t, { open: ['Job market networking', 'LinkedIn job scroller'] });
  assert.equal((await busy.rows()).repoRow.description, '1 needs you · 2 open');

  const storage = makeStorage();
  const two = storage.addRepository('wynwood', '/work/wynwood');
  const one = storage.addRepository('apparae', '/work/apparae');
  const wt = (repo: Repository) => worktreeRecord({ id: `wt-${repo.name}`, repoId: repo.id, path: repo.rootPath, branch: 'main' });
  storage.createChat(`wt-${two.name}`, 'claude', 'Event landing page', { harnessSessionId: 'a' });
  storage.createChat(`wt-${two.name}`, 'claude', 'Ticket checkout bug', { harnessSessionId: 'b' });
  storage.createChat(`wt-${one.name}`, 'claude', 'Only one', { harnessSessionId: 'c' });
  const tree = provider(t, storage, (repo) => ({ isGit: true, worktrees: [wt(repo)] }), [fakeAdapter('claude')]);
  tree.setStatusSource(statusSource());
  const descriptions = new Map((await tree.getChildren()).map((row) => [row.label, row.description]));
  assert.equal(descriptions.get('wynwood'), '2 sessions');
  assert.equal(descriptions.get('apparae'), '1 session');
});

test('repo summary says "1 needs you" and "2 need you"', async (t) => {
  const { rows, statuses, networking } = worktreeRepo(t);
  assert.equal((await rows()).repoRow.description, '1 needs you');
  statuses.set(networking.id, 'needs', Date.now());
  assert.equal((await rows()).repoRow.description, '2 need you');
});

test('every session tooltip shows its folder', async (t) => {
  const { rows } = worktreeRepo(t);
  const { byName } = await rows();
  const apply = tooltipText(byName.get('One-off apply')!);
  assert.match(apply, /One-off apply[\s\S]*needs you · 2m[\s\S]*Folder: \/code\/job-market/);
  assert.doesNotMatch(apply, /Worktree:/, 'the main worktree has no ⧉ line');
  const scroller = tooltipText(byName.get('LinkedIn job scroller')!);
  assert.match(scroller, /Folder: \/code\/job-market-wt\/fiu/);
  assert.match(
    scroller,
    /Worktree: a separate folder, so it runs in its own window \(\/code\/job-market-wt\/fiu\)/,
    'the canvas ⧉ line'
  );
});

test('repo rows: name, summary, and the canvas tooltip with keys only for positions 1–9', async (t) => {
  const { rows } = worktreeRepo(t);
  const { repoRow } = await rows();
  assert.equal(repoRow.label, 'job-market');
  assert.equal(repoRow.iconPath, undefined, 'no repo icon (canvas row anatomy)');
  assert.equal(
    repoRow.tooltip,
    'job-market: Ctrl+Alt+1 jumps here, Ctrl+Alt+Shift+1 opens it in its own window. Right-click for more.'
  );
  assert.equal(repoTooltip('wynwood', 9), 'wynwood: Ctrl+Alt+9 jumps here, Ctrl+Alt+Shift+9 opens it in its own window. Right-click for more.');
  assert.equal(repoTooltip('gatherly', 10), 'gatherly: Right-click for more.');
});

test('repos rank by their most urgent session: needs you, finished, working, idle', async (t) => {
  const storage = makeStorage();
  const now = Date.now();
  const names = ['idle-repo', 'working-repo', 'finished-repo', 'needs-repo'];
  const statuses: Record<string, [SessionStatus, number]> = {};
  for (const name of names) {
    const repo = storage.addRepository(name, `/work/${name}`);
    const chat = storage.createChat(`wt-${repo.name}`, 'claude', `${name} chat`, { harnessSessionId: name });
    statuses[chat.id] = [name.split('-')[0] as SessionStatus, now];
  }
  const tree = provider(
    t,
    storage,
    (repo) => ({ isGit: true, worktrees: [worktreeRecord({ id: `wt-${repo.name}`, repoId: repo.id, path: repo.rootPath })] }),
    [fakeAdapter('claude')]
  );
  tree.setStatusSource(statusSource(statuses));
  assert.deepEqual((await tree.getChildren()).map((row) => row.label), ['needs-repo', 'finished-repo', 'working-repo', 'idle-repo']);
});

test('a tick with no status change does not reorder rows even when activity times change', async (t) => {
  const log = captureLog(t);
  // The order diagnostics go to the Pitwall Operations output channel.
  disposeOperationLog();
  t.after(disposeOperationLog);
  const operations = {
    filter: (keep: (line: string) => boolean) =>
      (stub.__outputChannels.find((channel: { name: string }) => channel.name === 'Pitwall Operations')?.lines ?? [])
        .map((line: string) => line.slice(line.indexOf('] ') + 2))
        .filter(keep),
  };
  const storage = makeStorage();
  const now = Date.now();
  const alpha = storage.addRepository('alpha', '/work/alpha');
  const beta = storage.addRepository('beta', '/work/beta');
  const a = storage.createChat(`wt-alpha`, 'claude', 'A chat', { harnessSessionId: 'a' });
  const b = storage.createChat(`wt-beta`, 'claude', 'B chat', { harnessSessionId: 'b' });
  let activity = now;
  const tree = provider(
    t,
    storage,
    (repo) => ({ isGit: true, worktrees: [worktreeRecord({ id: `wt-${repo.name}`, repoId: repo.id, path: repo.rootPath })] }),
    [fakeAdapter('claude', { getSessionMetadata: async () => ({ lastActivity: activity, preview: [] }) })]
  );
  const statuses = statusSource({ [a.id]: ['working', now - 10 * MINUTE], [b.id]: ['working', now - 5 * MINUTE] });
  tree.setStatusSource(statuses);
  const order = async () => (await tree.getChildren()).map((row) => row.label);

  assert.deepEqual(await order(), ['beta', 'alpha'], 'newest statusSince first');
  const orderLines = () => operations.filter((line) => line.startsWith('[Pitwall] order '));
  assert.deepEqual(orderLines(), [`[Pitwall] order ${beta.id} ${alpha.id}`], 'one re-sort for the first render');

  // Ticks: activity moves, rows re-render, statuses stay.
  for (let tick = 0; tick < 15; tick++) {
    activity += 4_000;
    tree.softRefresh();
    assert.deepEqual(await order(), ['beta', 'alpha']);
  }
  assert.equal(orderLines().length, 1, 'no re-sort without a status change');

  statuses.set(a.id, 'needs', Date.now());
  assert.deepEqual(await order(), ['alpha', 'beta'], 'a status change re-sorts');
  assert.deepEqual(orderLines().at(-1), `[Pitwall] order ${alpha.id} ${beta.id}`);
  assert.equal(orderLines().length, 2);

  storage.createChat('wt-beta', 'claude', 'Another', { harnessSessionId: 'c' });
  await order();
  assert.equal(orderLines().length, 3, 'a row added re-sorts');
  assert.equal(operations.filter((line) => line === '[Pitwall] first render').length, 1, 'first render is logged once');
  assert.ok(!log.includes('[Pitwall] first render'), 'in the channel, not console.log');
});

test('the activity badge counts needs-you sessions and hides at 0', async (t) => {
  const { tree, statuses, apply, networking } = worktreeRepo(t);
  const view = vscode.window.createTreeView('pitwall.workspacesView', { treeDataProvider: tree }) as unknown as {
    badge?: { value: number; tooltip: string };
    description?: string;
  };
  tree.bindView(view as never);
  assert.equal(view.description, 'sorted by who needs you');
  assert.deepEqual(view.badge, { value: 1, tooltip: '1 session needs you' });
  statuses.set(networking.id, 'needs', Date.now());
  assert.deepEqual(view.badge, { value: 2, tooltip: '2 sessions need you' });
  statuses.set(apply.id, 'idle', Date.now());
  statuses.set(networking.id, 'working', Date.now());
  assert.equal(view.badge, undefined, 'hidden at 0');
});

test('a window redraws stars, names and dismissals written by another window when it gains focus and on the 60 s scan', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const shared = memento();
  const windowA = makeStorage(shared);
  const windowB = makeStorage(shared);
  const keep = windowA.addRepository('keep', '/work/keep');
  const gone = windowA.addRepository('gone', '/work/gone');
  const chat = windowA.createChat('wt-keep', 'claude', 'Before', { harnessSessionId: 'k' });
  const tree = provider(
    t,
    windowB,
    (repo) => ({ isGit: true, worktrees: [worktreeRecord({ id: `wt-${repo.name}`, repoId: repo.id, path: repo.rootPath })] }),
    [fakeAdapter('claude')]
  );
  let redraws = 0;
  tree.onDidChangeTreeData(() => redraws++);
  const snapshot = async () => {
    const repos = await tree.getChildren();
    const keepRow = repos.find((row) => row.label === 'keep')!;
    const [chatRow] = await tree.getChildren(keepRow);
    return { repos: repos.map((row) => row.label), chat: `${chatRow.label} ${chatRow.contextValue}` };
  };
  assert.deepEqual(await snapshot(), { repos: ['keep', 'gone'], chat: 'Before chat' });

  windowA.toggleStar(chat.id);
  windowA.updateChat(chat.id, { name: 'After', customName: true });
  void windowA.setDismissed(gone.rootPath, Date.now());
  windowA.removeRepository(gone.id);

  stub.window.__fireWindowState(true);
  t.mock.timers.tick(1_000);
  assert.equal(redraws, 1, 'gaining focus redraws');
  const after = await snapshot();
  assert.deepEqual(after.repos, ['keep']);
  assert.equal(after.chat, 'After starredChat');

  stub.window.__fireWindowState(false);
  t.mock.timers.tick(1_000);
  assert.equal(redraws, 1, 'losing focus does not');

  windowA.toggleStar(chat.id);
  t.mock.timers.tick(58_000);
  assert.equal(redraws, 1, 'nothing before the scan');
  t.mock.timers.tick(1_000); // the 60 s scan
  t.mock.timers.tick(1_000); // its debounced redraw
  assert.equal(redraws, 2, 'the 60 s scan redraws');
  assert.equal((await snapshot()).chat, 'After chat');
  assert.ok(keep);
});

test('worktree lookups list each repository at most once', (t) => {
  const storage = makeStorage();
  storage.addRepository('a', '/work/a');
  storage.addRepository('b', '/work/b');
  const listed: string[] = [];
  const tree = provider(t, storage, (repo) => {
    listed.push(repo.name);
    return { isGit: true, worktrees: [worktreeRecord({ id: `wt-${repo.name}`, repoId: repo.id, path: repo.rootPath })] };
  }, [fakeAdapter('claude')]);

  assert.equal(tree.getWorktreeById('wt-b')?.path, '/work/b');
  assert.equal(tree.getWorktreeById('wt-b')?.path, '/work/b');
  assert.equal(tree.findWorktreeByPath('/work/a')?.id, 'wt-a');
  assert.deepEqual(listed, ['a', 'b']);
});

test('a repo row stands for its main worktree; a plain folder follows git init and removal through its watcher', async (t) => {
  const storage = makeStorage();
  const folder = storage.addRepository('notes', '/work/notes');
  storage.addRepository('empty', '/work/empty');
  let isGit = false;
  const worktreeOf = (repo: Repository): Worktree =>
    worktreeRecord({ id: `wt-${repo.name}`, repoId: repo.id, name: isGit ? 'main' : repo.name, branch: isGit ? 'main' : undefined, path: repo.rootPath });
  const tree = provider(t, storage, (repo) => ({ isGit, worktrees: [worktreeOf(repo)] }), [fakeAdapter('claude')]);
  const session = storage.createChat('wt-notes', 'claude', 'Folder session', { harnessSessionId: 'claude-folder' });
  const rootRow = async () => (await tree.getChildren()).find((row) => row.label === 'notes')!;
  const fireGitDir = (event: '__fireCreate' | '__fireDelete') => {
    for (const watcher of [...stub.__fileWatchers]) {
      if (!watcher.disposed && watcher.pattern.base === folder.rootPath) watcher[event]();
    }
  };

  const rows = await tree.getChildren();
  const notes = rows.find((row) => row.label === 'notes')!;
  const empty = rows.find((row) => row.label === 'empty')!;
  assert.equal(notes.contextValue, 'folderRepository');
  assert.equal(notes.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  assert.equal(empty.collapsibleState, vscode.TreeItemCollapsibleState.None, 'nothing to expand');
  const [chatRow] = await tree.getChildren(notes);
  assert.equal(chatRow.data.id, session.id);
  assert.match(String(chatRow.description), /^idle · /, 'a plain folder has no branch');
  assert.equal(tree.getParent(chatRow)?.id, notes.id, 'reveal goes through the repo row');
  assert.equal(tree.getWorktreeForItem(notes)?.id, 'wt-notes');

  isGit = true;
  fireGitDir('__fireCreate');
  await waitFor(async () => (await rootRow()).contextValue === 'repository', 'the git upgrade');
  assert.equal(tree.getParent(chatRow)?.itemType, 'repository', 'reveal still goes through the repo row');
  assert.equal(tree.getWorktreeForItem(await rootRow())?.id, 'wt-notes', 'a git repo row stands for its main worktree');
  const [gitChat] = await tree.getChildren(await rootRow());
  assert.deepEqual([gitChat.data.id, String(gitChat.description).startsWith('⎇ main  ')], [session.id, true], 'the chat stays bound and gains its branch');

  isGit = false;
  fireGitDir('__fireDelete');
  await waitFor(async () => (await rootRow()).contextValue === 'folderRepository', 'the downgrade');
  assert.equal(tree.getParent(chatRow)?.itemType, 'repository');
});

test('whenSettled waits for the render that follows a refresh', async (t) => {
  const storage = makeStorage();
  const repo = storage.addRepository('demo', '/work/demo');
  const tree = provider(t, storage, () => ({ isGit: false, worktrees: [worktreeRecord({ repoId: repo.id, path: '/work/demo' })] }), []);
  await tree.getChildren();
  await tree.whenSettled();
  tree.refresh();
  let settled = false;
  const waiting = tree.whenSettled().then(() => {
    settled = true;
  });
  await flush();
  assert.equal(settled, false, 'still pending until the tree renders');
  await tree.getChildren();
  await waiting;
  assert.equal(settled, true);
});

test('only needs-you rows carry the Needs marker that shows the row bell', async (t) => {
  const { rows, statuses, networking, open } = worktreeRepo(t, { open: ['One-off apply'] });
  const values = async () => Object.fromEntries((await rows()).items.map((item) => [item.label, item.contextValue]));
  assert.deepEqual(await values(), {
    'One-off apply': 'runningChatNeeds',
    'Job market networking': 'chat',
    'LinkedIn job scroller': 'chat',
  });
  statuses.set(networking.id, 'needs', Date.now());
  open.clear();
  assert.equal((await values())['Job market networking'], 'chatNeeds');
});
