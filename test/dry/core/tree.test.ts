import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { WorkspaceTreeItem, WorkspacesTreeProvider, repoTooltip } from '../../../src/core/providers/WorkspacesTreeProvider';
import { HarnessRegistry } from '../../../src/core/harness/HarnessRegistry';
import { HarnessAdapter, SessionMetadata } from '../../../src/core/harness/types';
import { SessionStatus } from '../../../src/core/providers/sessionStatus';
import { ChatSession, Repository, RepositoryWorktrees, Worktree } from '../../../src/core/types';
import { disposeOperationLog } from '../../../src/core/services/OperationLog';
import { claudeUiSurfaces } from '../../../src/harnesses/claude/claudeUi';
import { fakeAdapter, fakeNativeUi, fakeWorktreeListing, makeStorage, memento, flush, stub, waitFor, worktreeRecord } from '../support';

beforeEach(() => stub.__reset());

const MINUTE = 60_000;
const terminals = { onTerminalStateChange: () => ({ dispose: () => undefined }), isActive: () => false };

function provider(
  t: { after(fn: () => void): void },
  storage: ReturnType<typeof makeStorage>,
  listWorktrees: (repo: Repository) => RepositoryWorktrees,
  adapters: HarnessAdapter[],
  { stored = true }: { stored?: boolean } = {}
) {
  // As on a reload: each stored repo's last listing is stored, so rows draw
  // from it at once while git lists again in the background.
  for (const repo of stored ? storage.getRepositories() : []) {
    storage.saveWorktreeSnapshot(repo.id, listWorktrees(repo));
  }
  const tree = new WorkspacesTreeProvider(
    storage,
    {
      ...fakeWorktreeListing((_rootPath: string, repoId: string) => listWorktrees(storage.getRepository(repoId)!)),
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
      '★ ⎇ main  idle · 16m | claude-light-idle.svg | starredChatClaudeUi',
      '⎇ main  idle · 33m | opencode-light-idle.svg | chat',
      '⎇ main  new | opencode-light-new.svg | chat',
    ]
  );
});

test('a starred chat shows ★ on its row and unstarring removes it', async (t) => {
  const { rows, storage, claude } = sessionRows(t);
  const description = async (label: string) => String((await rows()).get(label)!.description);

  assert.match(await description('claude'), /^★ /);
  assert.doesNotMatch(await description('opencode'), /★/, 'an unstarred chat has no mark');

  storage.toggleStar(claude.id);
  assert.doesNotMatch(await description('claude'), /★/, 'unstarring removes it');
  storage.toggleStar(claude.id);
  assert.match(await description('claude'), /^★ /, 'starring again brings it back');
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

test("closing a bound Claude tab clears isOpen and the row's open marker", async (t) => {
  const { tree, rows } = sessionRows(t);
  const surfaces = claudeUiSurfaces();
  t.after(() => surfaces.dispose());
  tree.setChatOpenProvider((chat) => Boolean(chat.harnessSessionId && surfaces.isOpen(chat.harnessSessionId)));
  const description = async () => String((await rows()).get('claude')!.description);
  const panelTab = () => ({ label: 'claude', input: new vscode.TabInputWebview('mainThreadWebview-claudeVSCodePanel'), isActive: true });
  const group: { isActive: boolean; viewColumn: number; activeTab: unknown; tabs: unknown[] } = { isActive: true, viewColumn: 1, activeTab: undefined, tabs: [] };
  stub.window.tabGroups.all = [group];

  // Open in Claude Code UI: the expectation binds the tab the command opened.
  surfaces.expect('claude-1', 'claude');
  const opened = panelTab();
  group.tabs = [opened];
  group.activeTab = opened;
  stub.window.__fireTabsChanged({ opened: [opened] });
  assert.ok(surfaces.isOpen('claude-1'));
  assert.match(await description(), / · open$/);

  // A group added or removed elsewhere rebuilds every Tab object.
  const rebuilt = panelTab();
  group.tabs = [rebuilt];
  group.activeTab = rebuilt;
  stub.window.__fireTabGroupsChanged();
  assert.ok(surfaces.isOpen('claude-1'), 'the binding follows the rebuilt tab');

  // The user closes the tab; VS Code names the rebuilt object.
  group.tabs = [];
  group.activeTab = undefined;
  stub.window.__fireTabsChanged({ closed: [rebuilt] });
  assert.equal(surfaces.isOpen('claude-1'), false);
  assert.doesNotMatch(await description(), / · open/);
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
  // Binding never waits on git; the badge follows once the worktrees are listed.
  await waitFor(() => view.badge, 'the badge');
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

test('worktree lookups never wait on git and list each repository at most once', async (t) => {
  const storage = makeStorage();
  storage.addRepository('a', '/work/a');
  storage.addRepository('b', '/work/b');
  const listed: string[] = [];
  const tree = provider(t, storage, (repo) => {
    listed.push(repo.name);
    return { isGit: true, worktrees: [worktreeRecord({ id: `wt-${repo.name}`, repoId: repo.id, path: repo.rootPath })] };
  }, [fakeAdapter('claude')], { stored: false });

  // Nothing listed or stored yet: the root stands in as a plain folder, and
  // the lookup starts the listing instead of waiting for it.
  assert.equal(tree.getWorktreeById('wt-b'), undefined);
  assert.equal(tree.findWorktreeByPath('/work/a')?.isMain, true);
  // The listing starts in the background once the first render is out.
  await tree.getChildren();
  await waitFor(() => tree.getWorktreeById('wt-b'), 'the background listing');
  assert.equal(tree.getWorktreeById('wt-b')?.path, '/work/b');
  assert.equal(tree.getWorktreeById('wt-b')?.path, '/work/b');
  assert.equal(tree.findWorktreeByPath('/work/a')?.id, 'wt-a');
  assert.deepEqual(listed.sort(), ['a', 'b']);
});

test('the first rows come from the stored worktree listing while git lists again; a change redraws', async (t) => {
  const storage = makeStorage();
  const repo = storage.addRepository('app', '/work/app');
  const main = worktreeRecord({ id: 'wt-main', repoId: repo.id, name: 'main', branch: 'main', path: '/work/app' });
  const linked = worktreeRecord({ id: 'wt-fiu', repoId: repo.id, name: 'feat/fiu', branch: 'feat/fiu', path: '/work/app-fiu', isMain: false });
  storage.saveWorktreeSnapshot(repo.id, { isGit: true, worktrees: [main, linked] });
  storage.createChat(linked.id, 'claude', 'Worktree chat', { harnessSessionId: 'fiu' });
  let answer: ((listing: RepositoryWorktrees) => void) | undefined;
  const tree = new WorkspacesTreeProvider(
    storage,
    {
      listRepositoryWorktreesAsync: () => new Promise<RepositoryWorktrees>((resolve) => (answer = resolve)),
      getAheadBehind: () => null,
    } as never,
    terminals as never,
    new HarnessRegistry([fakeAdapter('claude')]),
    vscode.Uri.file('/extension')
  );
  t.after(() => tree.dispose());
  const changes: unknown[] = [];
  tree.onDidChangeTreeData((change) => changes.push(change));

  const [first] = await tree.getChildren();
  assert.equal(first.description, '1 session', 'drawn at once from the snapshot, git still running');
  assert.equal(tree.getWorktreeById('wt-fiu')?.branch, 'feat/fiu', 'lookups answer from it too');

  // The linked worktree was removed since the last start.
  await waitFor(() => answer, 'the listing in the background');
  answer!({ isGit: true, worktrees: [main] });
  await waitFor(() => changes.length > 0, 'a redraw once git answers');
  const [second] = await tree.getChildren();
  assert.equal(second.description, '0 sessions');
  assert.deepEqual(storage.getWorktreeSnapshot(repo.id), { isGit: true, worktrees: [main] }, 'kept for the next start');
});

/** A tree whose git listings wait until the test answers each one, in the order they were asked. */
function heldListings(t: { after(fn: () => void): void }, storage: ReturnType<typeof makeStorage>) {
  const calls: { repoId: string; urgent: boolean; answer: (listing: RepositoryWorktrees) => void }[] = [];
  const expedited: string[] = [];
  const tree = new WorkspacesTreeProvider(
    storage,
    {
      listRepositoryWorktreesAsync: (_rootPath: string, repoId: string, options: { urgent?: boolean } = {}) =>
        new Promise<RepositoryWorktrees>((answer) => calls.push({ repoId, urgent: options.urgent === true, answer })),
      expediteWorktreeListing: (_rootPath: string, repoId: string) => expedited.push(repoId),
      getAheadBehind: () => null,
    } as never,
    terminals as never,
    new HarnessRegistry([fakeAdapter('claude')]),
    vscode.Uri.file('/extension')
  );
  t.after(() => tree.dispose());
  const changes: unknown[] = [];
  tree.onDidChangeTreeData((change) => changes.push(change));
  return { tree, calls, changes, expedited };
}

/** A git repository's listing: its main worktree and the linked ones. */
function gitListing(...worktrees: Worktree[]): RepositoryWorktrees {
  return { isGit: true, worktrees };
}

test('with no stored listing and git still listing, the first render shows every stored repo at once (E16)', async (t) => {
  const storage = makeStorage();
  const app = storage.addRepository('app', '/work/app');
  storage.addRepository('notes', '/work/notes');
  const linked = worktreeRecord({ id: 'wt-fiu', repoId: app.id, name: 'feat/fiu', branch: 'feat/fiu', path: '/work/app-fiu', isMain: false });
  storage.createChat(linked.id, 'claude', 'Worktree chat', { harnessSessionId: 'fiu' });
  const { tree, calls, changes } = heldListings(t, storage);
  // Activation reads the rows (the badge, lookups) before the workbench asks.
  assert.equal(tree.getWorktreeById('wt-fiu'), undefined);
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(calls.length, 0, 'no git starts before the first render is out');

  const first = await Promise.race([
    tree.getChildren(),
    new Promise<'waiting on git'>((resolve) => setTimeout(() => resolve('waiting on git'), 500)),
  ]);
  assert.notEqual(first, 'waiting on git', 'the first render never waits for a git listing');
  assert.deepEqual(
    (first as WorkspaceTreeItem[]).map((row) => row.label).sort(),
    ['app', 'notes'],
    'every stored repo, each root standing in as its main worktree'
  );

  // The listings land: the chat on the linked worktree joins its repo's row.
  await waitFor(() => calls.length === 2, 'both listings in the background');
  const main = worktreeRecord({ id: 'wt-app', repoId: app.id, path: '/work/app' });
  calls.find((call) => call.repoId === app.id)!.answer(gitListing(main, linked));
  await waitFor(() => changes.length > 0, 'a redraw once git answers');
  const rows = await tree.getChildren();
  assert.equal(rows.find((row) => row.label === 'app')?.description, '1 session');
});

test("a lookup that misses before a repository's first listing waits for it, ahead of the queue (B1)", async (t) => {
  const storage = makeStorage();
  const app = storage.addRepository('app', '/work/app');
  const main = worktreeRecord({ id: 'wt-app', repoId: app.id, path: '/work/app' });
  const linked = worktreeRecord({ id: 'wt-fiu', repoId: app.id, name: 'feat/fiu', path: '/work/app-fiu', isMain: false });
  const { tree, calls, expedited } = heldListings(t, storage);

  await tree.getChildren();
  await waitFor(() => calls.length === 1, 'the background listing, after the first render');
  assert.equal(tree.getWorktreeById('wt-fiu'), undefined, 'the stand-in knows only the main worktree');
  const lookup = tree.getWorktreeByIdAsync('wt-fiu');
  // The lookup hurries the background listing ahead of the queue.
  await waitFor(() => expedited.includes(app.id), 'the lookup to hurry the listing ahead of the queue');
  assert.equal(calls.length, 1, 'one listing serves both');
  calls.forEach((call) => call.answer(gitListing(main, linked)));
  assert.equal((await lookup)?.path, '/work/app-fiu', 'the miss is answered from the listing');

  const asked = calls.length;
  assert.equal(await tree.getWorktreeByIdAsync('wt-gone'), undefined, 'a worktree that no listing has is not found');
  assert.equal(calls.length, asked, 'without listing a listed repository again');
  assert.equal((await tree.findWorktreeByPathAsync('/work/app-fiu'))?.id, 'wt-fiu', 'paths resolve the same way');
});

test('a lookup before the first render lists at once, urgently, instead of waiting for it', async (t) => {
  const storage = makeStorage();
  const app = storage.addRepository('app', '/work/app');
  const linked = worktreeRecord({ id: 'wt-fiu', repoId: app.id, path: '/work/app-fiu', isMain: false });
  const { tree, calls } = heldListings(t, storage);

  const lookup = tree.getWorktreeByIdAsync('wt-fiu');
  await waitFor(() => calls.length === 1, 'a listing for the lookup');
  assert.equal(calls[0].urgent, true, 'urgent: someone waits on it');
  calls[0].answer(gitListing(worktreeRecord({ id: 'wt-app', repoId: app.id, path: '/work/app' }), linked));
  assert.equal((await lookup)?.id, 'wt-fiu');
});

test('a listing that started before a hard refresh never overwrites the one after it', async (t) => {
  const storage = makeStorage();
  const app = storage.addRepository('app', '/work/app');
  const main = worktreeRecord({ id: 'wt-app', repoId: app.id, path: '/work/app' });
  const linked = worktreeRecord({ id: 'wt-fiu', repoId: app.id, name: 'feat/fiu', path: '/work/app-fiu', isMain: false });
  storage.createChat(linked.id, 'claude', 'Worktree chat', { harnessSessionId: 'fiu' });
  const { tree, calls, changes } = heldListings(t, storage);

  await tree.getChildren();
  await waitFor(() => calls.length === 1, 'listing A');
  const listingA = calls[0];

  // The linked worktree is removed, then the list is refreshed: listing B.
  tree.refresh();
  await waitFor(() => changes.length > 0, 'the hard refresh');
  await tree.getChildren();
  await waitFor(() => calls.length === 2, 'listing B');
  calls[1].answer(gitListing(main));
  await waitFor(() => storage.getWorktreeSnapshot(app.id), 'listing B to land');

  // A, which still saw the linked worktree, answers last.
  listingA.answer(gitListing(main, linked));
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(tree.getWorktreeById('wt-fiu'), undefined, 'the removed worktree stays gone');
  assert.deepEqual(storage.getWorktreeSnapshot(app.id), gitListing(main), 'the stored listing is B');
  const [row] = await tree.getChildren();
  assert.equal(row.description, '0 sessions', 'the rows show B');
});

test('a chat lookup that races a hard refresh still finds its worktree', async (t) => {
  const storage = makeStorage();
  const app = storage.addRepository('app', '/work/app');
  const main = worktreeRecord({ id: 'wt-app', repoId: app.id, path: '/work/app' });
  const linked = worktreeRecord({ id: 'wt-fiu', repoId: app.id, name: 'feat/fiu', path: '/work/app-fiu', isMain: false });
  const { tree, calls, changes } = heldListings(t, storage);

  const lookup = tree.getWorktreeByIdAsync('wt-fiu');
  await waitFor(() => calls.length === 1, 'listing A, for the lookup');
  // A hard refresh lands while A is in flight, so A's answer is discarded.
  tree.refresh();
  await waitFor(() => changes.length > 0, 'the hard refresh');
  calls[0].answer(gitListing(main, linked));

  await waitFor(() => calls.length === 2, 'the lookup to list again');
  calls[1].answer(gitListing(main, linked));
  assert.equal((await lookup)?.id, 'wt-fiu', 'found, not "Could not find worktree"');
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

/** Repo `demo` with a main folder and a worktree, one chat on each; no chat is open in this window. */
function windowedRepo(t: { after(fn: () => void): void }) {
  const storage = makeStorage();
  const repo = storage.addRepository('demo', '/work/demo');
  const main = worktreeRecord({ id: 'wt-main', repoId: repo.id, path: '/work/demo', branch: 'main' });
  const feat = worktreeRecord({ id: 'wt-feat', repoId: repo.id, name: 'feat', path: '/work/demo-feat', branch: 'feat', isMain: false });
  storage.createChat(main.id, 'claude', 'On main', { harnessSessionId: 'claude-main' });
  storage.createChat(feat.id, 'claude', 'On feat', { harnessSessionId: 'claude-feat' });
  const tree = provider(t, storage, () => ({ isGit: true, worktrees: [main, feat] }), [fakeAdapter('claude')]);
  tree.setStatusSource(statusSource());
  const window = (folder: string | undefined, openSessionIds: string[] = []) => ({ folder, openSessionIds });
  const repoRow = async () => (await tree.getChildren())[0];
  const chatRows = async () => new Map((await tree.getChildren(await repoRow())).map((row) => [row.label, row]));
  return { tree, window, repoRow, chatRows };
}

test('repo description adds " · 2 windows" only when k > 1', async (t) => {
  const { tree, window, repoRow } = windowedRepo(t);
  assert.equal((await repoRow()).description, '2 sessions', 'no windows');

  tree.setWindows([window('/work/demo')]);
  assert.equal((await repoRow()).description, '2 sessions', 'one window: nothing added');
  assert.equal((await repoRow()).contextValue, 'repository.hasWindow', 'its main folder has a window');

  // The worktree's window counts; another repo's, a multi-root (no folder) and an empty window don't (Q17).
  tree.setWindows([window('/work/demo'), window('/work/demo-feat'), window('/work/other'), window(undefined)]);
  assert.equal((await repoRow()).description, '2 sessions · 2 windows');

  tree.setWindows([window('/work/demo-feat')]);
  const row = await repoRow();
  assert.equal(row.description, '2 sessions');
  assert.equal(row.contextValue, 'repository', 'a worktree window alone is not the repo window');
});

test('" · open" counts tabs in other windows', async (t) => {
  const { tree, window, repoRow, chatRows } = windowedRepo(t);
  tree.setWindows([window('/work/other', ['claude-feat'])]);

  const rows = await chatRows();
  assert.match(String(rows.get('On feat')!.description), / · open$/, 'open as a tab in another window');
  assert.doesNotMatch(String(rows.get('On main')!.description), / · open/);
  assert.equal(rows.get('On feat')!.contextValue, 'chat', 'no running context: its terminal or tab is not in this window');
  assert.equal((await repoRow()).description, '1 open');

  // Open here and elsewhere counts once.
  tree.setChatOpenProvider((chat) => chat.harnessSessionId === 'claude-feat');
  assert.equal((await repoRow()).description, '1 open');
});

test('no git watcher is made before the first render, even when a refresh lands first; they appear after it (E16)', async (t) => {
  const storage = makeStorage();
  storage.addRepository('app', '/work/app');
  storage.addRepository('notes', '/work/notes');
  const { tree, changes } = heldListings(t, storage);
  const watchers = () => stub.__fileWatchers.filter((watcher) => !watcher.disposed).length;

  // A refresh before the first render (a focus change, a scan) runs the debounced path that keeps the watchers in step.
  tree.refresh();
  await waitFor(() => changes.length > 0, 'the refresh to fire');
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(watchers(), 0, 'no watcher before the first render: the window start does nothing per repo (E16)');

  await tree.getChildren();
  await waitFor(() => watchers() === 6, 'the watchers once the rows are out');
  assert.equal(watchers(), 6, 'three per repo');
});
