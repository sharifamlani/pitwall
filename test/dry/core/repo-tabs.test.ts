/**
 * A repo click opens its chats as tabs; "Show its open chats side by side"
 * (rows 4.3, 4.4, 4.9; Q5, Q14, Q15, Q18, Q22): the repo row's command opens
 * the repo's main-folder sidebar chats (at most 8, then a quick pick for the
 * rest), reveals only the last-open tab when they are already open here, and
 * the split puts up to 4 open tabs in a group each. `pitwall.dev.dumpState`
 * and `scripts/dump-tabs.mjs` give the evaluator the tab state as JSON.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerRepositoryCommands } from '../../../src/core/commands/repository';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from '../../../src/core/providers/WorkspacesTreeProvider';
import { HarnessRegistry } from '../../../src/core/harness/HarnessRegistry';
import { splitSideBySide, SIDE_BY_SIDE_MAX } from '../../../src/core/windows/sideBySide';
import { ChatSession, RepositoryWorktrees } from '../../../src/core/types';
import type { HandoffKind } from '../../../src/core/windows/HandoffInbox';
import { fakeAdapter, fakeWorktreeListing, makeStorage, runCommand, shownMessages, stub, tempDir, worktreeRecord } from '../support';

beforeEach(() => stub.__reset());

const ROOT = path.resolve(__dirname, '..', '..', '..');

/** Repo `demo` with a main folder and a worktree; `main` chats on main, `feat` on the worktree, newest first by name order. */
function repoWorld(t: { after(fn: () => void): void }, counts: { main: number; feat: number }) {
  const storage = makeStorage();
  const repo = storage.addRepository('demo', '/work/demo');
  const main = worktreeRecord({ id: 'wt-main', repoId: repo.id, name: 'demo', path: '/work/demo', branch: 'main' });
  const feat = worktreeRecord({ id: 'wt-feat', repoId: repo.id, name: 'feat', path: '/work/demo-feat', branch: 'feat', isMain: false });
  storage.saveWorktreeSnapshot(repo.id, { isGit: true, worktrees: [main, feat] });
  const base = Date.now();
  // m0 is the newest; creation order is shuffled against recency on purpose.
  const mainChats: ChatSession[] = Array.from({ length: counts.main }, (_, i) =>
    storage.createChat(main.id, 'claude', `m${i}`, { harnessSessionId: `sm${i}`, lastAccessedAt: base - i * 1000 })
  ).reverse();
  const featChats = Array.from({ length: counts.feat }, (_, i) =>
    storage.createChat(feat.id, 'claude', `f${i}`, { harnessSessionId: `sf${i}`, lastAccessedAt: base + 5000 + i })
  );
  const tree = new WorkspacesTreeProvider(
    storage,
    {
      ...fakeWorktreeListing((): RepositoryWorktrees => ({ isGit: true, worktrees: [main, feat] })),
      getAheadBehind: () => null,
    } as never,
    { onTerminalStateChange: () => ({ dispose: () => undefined }), isActive: () => false } as never,
    new HarnessRegistry([fakeAdapter('claude')]),
    vscode.Uri.file('/extension')
  );
  t.after(() => tree.dispose());
  tree.setStatusSource({
    statusOf: () => ({ status: 'idle', statusSince: 0 }),
    onDidChangeStatus: new vscode.EventEmitter<string[]>().event,
  });
  return { storage, repo, main, feat, mainChats, featChats, tree };
}

type RepoWorld = ReturnType<typeof repoWorld>;

/** The repo commands wired to a recording router. */
function commands(t: { after(fn: () => void): void }, w: RepoWorld, options: { windowFolder?: string; open?: Set<string>; dumpDir?: string; tabs?: () => unknown[] } = {}) {
  const routes: { kind: string; chats: string[] }[] = [];
  const router = {
    route: async (req: { kind: HandoffKind; chats: ChatSession[]; folder?: string }) => {
      routes.push({ kind: req.kind, chats: req.chats.map((chat) => chat.name) });
      return 'here' as const;
    },
  };
  const context = { subscriptions: [] as vscode.Disposable[] };
  registerRepositoryCommands(context as never, {
    storageService: w.storage,
    gitService: {} as never,
    harnessRegistry: new HarnessRegistry([]),
    forgetWorktrees: () => undefined,
    refreshTree: () => undefined,
    router: () => router,
    mainChats: (repo) => w.tree.mainChatsOf(repo),
    windowFolder: () => options.windowFolder,
    isChatOpen: (chat) => options.open?.has(chat.id) ?? false,
    openChatsOf: async (repo) => w.tree.mainChatsOf(repo).filter((chat) => options.open?.has(chat.id)),
    dump: options.dumpDir ? { dir: options.dumpDir, pid: 4242, tabs: () => (options.tabs?.() ?? []) as never, windowFolder: () => options.windowFolder } : undefined,
  });
  t.after(() => context.subscriptions.forEach((entry) => entry.dispose()));
  const row = new WorkspaceTreeItem('demo', 1, 'repository', w.repo, 'repository');
  return { routes, row };
}

test("repo click opens the repo's main-folder sidebar chats and no worktree chats", async (t) => {
  const w = repoWorld(t, { main: 3, feat: 2 });
  assert.deepEqual(w.tree.mainChatsOf(w.repo).map((chat) => chat.name), ['m0', 'm1', 'm2'], 'main folder only, newest first');
  const { routes, row } = commands(t, w);
  await runCommand('pitwall.openRepoChats', row);
  // Oldest first, so the newest tab opens last and stays in front.
  assert.deepEqual(routes, [{ kind: 'openAll', chats: ['m2', 'm1', 'm0'] }]);
  const [repoRow] = await w.tree.getChildren();
  assert.equal(repoRow.command?.command, 'pitwall.openRepoChats', 'the repo row runs it on click and Enter');
  assert.deepEqual(repoRow.command?.arguments, [repoRow]);
});

test('repo click opens at most the Q18 cap, newest first, and offers the rest', async (t) => {
  const w = repoWorld(t, { main: 11, feat: 0 });
  const { routes, row } = commands(t, w);
  stub.__quickPickResponses.push(undefined);
  await runCommand('pitwall.openRepoChats', row);
  assert.deepEqual(routes, [{ kind: 'openAll', chats: Array.from({ length: 8 }, (_, i) => `m${7 - i}`) }]);
  assert.deepEqual(
    (stub.__messages.at(-1)![0] as { label: string }[]).map((item) => item.label),
    ['Open the other 3 chats']
  );

  routes.length = 0;
  stub.__messages.length = 0;
  stub.__quickPickResponses.push({ label: 'Open the other 3 chats' });
  await runCommand('pitwall.openRepoChats', row);
  assert.deepEqual(
    routes.map((entry) => [entry.kind, entry.chats]),
    [
      ['openAll', Array.from({ length: 8 }, (_, i) => `m${7 - i}`)],
      ['openAll', ['m10', 'm9', 'm8']],
    ],
    'picking it opens the remaining chats'
  );
});

test('repo click in its own window with all chats open reveals only the last-open tab', async (t) => {
  const w = repoWorld(t, { main: 3, feat: 0 });
  const open = new Set(w.mainChats.map((chat) => chat.id));
  const { routes, row } = commands(t, w, { windowFolder: '/work/demo', open });
  await runCommand('pitwall.openRepoChats', row);
  assert.deepEqual(routes, [{ kind: 'open', chats: ['m0'] }], 'one reveal, no re-open of the others');

  routes.length = 0;
  open.delete(w.mainChats[0].id);
  await runCommand('pitwall.openRepoChats', row);
  assert.deepEqual(routes, [{ kind: 'openAll', chats: ['m2', 'm1', 'm0'] }], 'with one closed, it opens them all again');
});

test('a Ctrl+↓/↑ landing on a repo row only expands it (Q22)', async (t) => {
  const w = repoWorld(t, { main: 2, feat: 0 });
  const { routes, row } = commands(t, w);
  const { keepListFocusOnce } = await import('../../../src/core/commands/navigation');
  keepListFocusOnce();
  await runCommand('pitwall.openRepoChats', row);
  assert.deepEqual(routes, [], 'the marker the key left means a keyboard walk: nothing opens');
  await runCommand('pitwall.openRepoChats', row);
  assert.equal(routes.length, 1, 'a click after it opens as usual');
});

test('side by side splits up to 4 open tabs, one group each, and is hidden below 2', async (t) => {
  const exec: string[] = [];
  const reveal: string[] = [];
  const result = await splitSideBySide(['a', 'b', 'c', 'd', 'e', 'f'], {
    reveal: async (id) => void reveal.push(id),
    exec: async (command) => void exec.push(command),
  });
  assert.equal(SIDE_BY_SIDE_MAX, 4);
  assert.deepEqual(result, { panes: 4, stacked: 2 });
  assert.deepEqual(reveal, ['a', 'b', 'c', 'd', 'e', 'f'], 'each tab is brought to the front before it moves');
  const last = 'workbench.action.moveEditorToLastGroup';
  const right = 'workbench.action.moveEditorToRightGroup';
  assert.deepEqual(exec, [last, right, last, right, last, right, last, last], 'tabs 2–4 each open a new group; the rest join the last pane');
  assert.deepEqual(await splitSideBySide(['only'], { reveal: async () => undefined, exec: async () => undefined }), { panes: 0, stacked: 0 }, 'below 2 nothing moves');

  // The menu item shows only on a repo whose window has 2+ of its chats open.
  const w = repoWorld(t, { main: 3, feat: 0 });
  const chat = (name: string) => w.mainChats.find((candidate) => candidate.name === name)!;
  const open = (...chats: ChatSession[]) => ({ folder: '/work/demo', openSessionIds: chats.map((candidate) => candidate.harnessSessionId!) });
  const value = async () => (await w.tree.getChildren())[0].contextValue;
  w.tree.setWindows([open(chat('m0'))]);
  assert.equal(await value(), 'repository.hasWindow');
  w.tree.setWindows([open(chat('m0'), chat('m1'))]);
  assert.equal(await value(), 'repository.hasWindow.sideBySide');
  w.tree.setWindows([{ folder: '/work/demo', openSessionIds: ['sf0', 'sf1'] }]);
  assert.equal(await value(), 'repository.hasWindow', 'worktree chats do not count');

  const idOf = (name: string) => w.mainChats.find((chat) => chat.name === name)!.id;
  const { routes, row } = commands(t, w, { open: new Set([idOf('m0')]) });
  await runCommand('pitwall.showRepoChatsSideBySide', row);
  assert.deepEqual(routes, [], 'a command run on one open chat does nothing');
  const both = commands(t, w, { open: new Set([idOf('m0'), idOf('m1')]) });
  await runCommand('pitwall.showRepoChatsSideBySide', both.row);
  assert.deepEqual(both.routes, [{ kind: 'sideBySide', chats: ['m0', 'm1'] }]);
});

test('pitwall.dev.dumpState writes the tab and repo state, and scripts/dump-tabs.mjs prints it for one repo', async (t) => {
  const w = repoWorld(t, { main: 2, feat: 1 });
  const dir = tempDir(t, 't4-dump-');
  const tabs = [{ index: 0, isActive: true, tabs: [{ label: 'Claude Code', pinned: false, active: true, sessionId: 'sm0' }] }];
  commands(t, w, { windowFolder: '/work/demo', dumpDir: dir, tabs: () => tabs });
  await runCommand('pitwall.dev.dumpState');
  const file = path.join(dir, '4242.json');
  const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(dump).sort(), ['pid', 'repos', 'tabGroups', 'version', 'windowFolder']);
  assert.equal(dump.version, 1);
  assert.deepEqual(dump.tabGroups, tabs);
  assert.deepEqual(dump.repos, [{ name: 'demo', rootPath: '/work/demo', sidebarMainChatIds: ['sm0', 'sm1'] }]);

  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dump-tabs.mjs'), '--dir', dir, '--repo', 'demo'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    repo: 'demo',
    rootPath: '/work/demo',
    sidebarMainChatIds: ['sm0', 'sm1'],
    windows: [{ pid: 4242, windowFolder: '/work/demo', boundTabIds: ['sm0'], tabGroups: tabs }],
  });
  const missing = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dump-tabs.mjs'), '--dir', dir, '--repo', 'nope'], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0, 'an unknown repo exits non-zero');
  assert.deepEqual(shownMessages(), []);
});

test('pitwall.dev.dumpState is hidden from the palette', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const palette = pkg.contributes.menus.commandPalette as { command: string; when?: string }[];
  assert.ok(palette.some((entry) => entry.command === 'pitwall.dev.dumpState' && entry.when === 'false'));
  for (const id of ['pitwall.openRepoChats', 'pitwall.showRepoChatsSideBySide']) {
    assert.ok(palette.some((entry) => entry.command === id && entry.when === 'false'), `${id} is a row action`);
  }
});

test('a repo click skips pending rows with no session, and the quick pick count leaves them out', async (t) => {
  const w = repoWorld(t, { main: 10, feat: 0 });
  w.storage.createChat(w.main.id, 'claude', 'New Session', { pendingUiLaunch: true, lastAccessedAt: Date.now() + 100_000 });
  w.storage.createChat(w.main.id, 'claude', 'Blank', { lastAccessedAt: Date.now() + 100_000 });
  assert.equal(w.tree.mainChatsOf(w.repo).length, 10, 'only chats with a session id are in the batch');
  const { routes, row } = commands(t, w);
  stub.__quickPickResponses.push(undefined);
  await runCommand('pitwall.openRepoChats', row);
  assert.equal(routes[0].chats.length, 8);
  assert.ok(!routes[0].chats.includes('New Session') && !routes[0].chats.includes('Blank'));
  assert.deepEqual((stub.__messages.at(-1)![0] as { label: string }[]).map((item) => item.label), ['Open the other 2 chats']);
});
