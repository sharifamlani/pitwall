/**
 * Repos found from the agents' sessions, and dismissed by right-click
 * (row 3.1, ADR 0019, rulings P1, P2, P3, P13, P17). The harness boundary is
 * faked with the folders a pass would report; git and storage are real.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import pkg from '../../../package.json';
import { activate } from '../../../src/extension';
import { GitService } from '../../../src/core/services/GitService';
import { RepoDiscoveryService } from '../../../src/core/services/RepoDiscoveryService';
import { registerRepositoryCommands } from '../../../src/core/commands/repository';
import { DiscoveredFolder } from '../../../src/core/harness/types';
import { Repository } from '../../../src/core/types';
import { claudeProfile, entry } from '../harnesses/claude/claudeFixture';
import { fakeAdapter, flush, makeStorage, memento, runCommand, shownMessages, stub, tempDir, waitFor } from '../support';

beforeEach(() => stub.__reset());

const DAY = 24 * 60 * 60 * 1000;

const dismissedMessage = (name: string) =>
  `Dismissed ${name} from Pitwall. Nothing changed on disk: the repo, its files and its chats are untouched. It comes back if you add it with the folder icon, or when a new Claude Code session starts in it.`;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' });
}

/** A git repository with one commit, so worktrees can branch from it. */
function makeRepo(parent: string, name: string): string {
  const repo = path.join(parent, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  return repo;
}

/** One window: storage over `globalState`, a discovery service, and the repository commands. */
function setup(t: { after(fn: () => void): void }, globalState = memento()) {
  const storage = makeStorage(globalState);
  const gitService = new GitService();
  const folders: DiscoveredFolder[] = [];
  const adapter = fakeAdapter('claude', {
    discoverRecentFolders: async (sinceMs) => folders.filter((folder) => folder.lastActivity >= sinceMs),
  });
  const service = new RepoDiscoveryService(storage, gitService, () => [adapter], {
    enabled: () => true,
    retentionDays: () => 14,
  });
  t.after(() => service.dispose());
  registerRepositoryCommands({ subscriptions: [] } as never, {
    storageService: storage,
    gitService,
    forgetWorktrees: () => undefined,
    refreshTree: () => undefined,
  });
  return {
    storage,
    gitService,
    service,
    /** A session in `cwd` that started at `startedAt` and was last written now. */
    session(cwd: string, startedAt = Date.now()) {
      folders.push({ cwd, firstEntryAt: startedAt, lastActivity: Date.now() });
    },
    roots: () => storage.getRepositories().map((repo) => repo.rootPath),
    async dismiss(rootPath: string) {
      const repo = storage.getRepositories().find((candidate) => candidate.rootPath === rootPath) as Repository;
      await runCommand('pitwall.dismissRepository', { itemType: 'repository', data: repo });
    },
  };
}

test('a worktree cwd maps to its main repo root', async (t) => {
  const scratch = tempDir(t);
  const repo = makeRepo(scratch, 'app');
  const linked = path.join(scratch, 'app-feature');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
  fs.mkdirSync(path.join(repo, 'src'));
  const f = setup(t);
  f.session(linked);
  f.session(path.join(repo, 'src'));

  assert.equal(await f.gitService.getMainRepoRoot(linked), repo, 'the git common dir names the main worktree');
  assert.equal(await f.gitService.getMainRepoRoot(path.join(repo, 'src')), repo);
  const { added } = await f.service.scan();

  assert.deepEqual(added, [repo]);
  const [stored] = f.storage.getRepositories();
  assert.deepEqual(
    { name: stored.name, rootPath: stored.rootPath, origin: stored.origin },
    { name: 'app', rootPath: repo, origin: 'discovered' }
  );
  assert.equal(f.storage.getRepositories().length, 1, 'the worktree is not a repo of its own');
});

test('a missing cwd is skipped', async (t) => {
  const scratch = tempDir(t);
  const f = setup(t);
  f.session(path.join(scratch, 'deleted-since'));

  assert.deepEqual(await f.service.scan(), { added: [], skipped: 1 });
  assert.deepEqual(f.roots(), []);
});

test('a non-git cwd becomes a folder repository', async (t) => {
  const plain = path.join(tempDir(t), 'notes');
  fs.mkdirSync(plain);
  const f = setup(t);
  f.session(plain);

  assert.equal(await f.gitService.getMainRepoRoot(plain), null);
  assert.deepEqual((await f.service.scan()).added, [plain]);
  assert.deepEqual(f.roots(), [plain]);
  assert.equal(f.gitService.listRepositoryWorktrees(plain, f.storage.getRepositories()[0].id).isGit, false);
});

test('two concurrent scans store one repository per root, case-insensitive on Windows', async (t) => {
  const scratch = tempDir(t);
  const repo = makeRepo(scratch, 'shared');
  fs.mkdirSync(path.join(repo, 'sub'));
  const shared = memento();
  const windowA = setup(t, shared);
  const windowB = setup(t, shared);
  const spellings = [repo, path.join(repo, 'sub'), `${repo}${path.sep}`];
  if (process.platform === 'win32') {
    spellings.push(repo.toUpperCase(), repo[0].toLowerCase() + repo.slice(1).replace(/\\/g, '/'));
  }
  for (const spelling of spellings) {
    windowA.session(spelling);
    windowB.session(spelling);
  }

  await Promise.all([windowA.service.scan(), windowB.service.scan(), windowA.service.scan(), windowB.service.scan()]);

  assert.equal(windowA.storage.getRepositories().length, 1, 'window A');
  assert.equal(windowB.storage.getRepositories().length, 1, 'window B');
  const reloaded = makeStorage(shared).getRepositories();
  assert.equal(reloaded.length, 1, 'one stored record after a reload');
  assert.equal(reloaded[0].name, 'shared');
});

test('a dismissed repo stays hidden after reload', async (t) => {
  const repo = makeRepo(tempDir(t), 'job-market');
  const shared = memento();
  const f = setup(t, shared);
  f.session(repo, Date.now() - 60_000);
  await f.service.scan();
  assert.deepEqual(f.roots(), [repo]);

  await f.dismiss(repo);
  assert.deepEqual(f.roots(), []);
  assert.equal(shownMessages().at(-1), dismissedMessage('job-market'));
  assert.equal(Object.keys(f.storage.getDismissedRepos()).length, 1);

  // A reload: new storage and a new service over the same stored state.
  const reloaded = setup(t, shared);
  reloaded.session(repo, Date.now() - 60_000);
  assert.deepEqual((await reloaded.service.scan()).added, []);
  assert.deepEqual(reloaded.roots(), []);
});

test('a dismissed repo returns when a session starts in it after the dismissal', async (t) => {
  const repo = makeRepo(tempDir(t), 'job-market');
  const f = setup(t);
  f.session(repo, Date.now() - 60_000);
  await f.service.scan();
  await f.dismiss(repo);

  f.session(repo, Date.now() + 1_000);
  assert.deepEqual((await f.service.scan()).added, [repo]);
  assert.deepEqual(f.roots(), [repo]);
  assert.deepEqual(f.storage.getDismissedRepos(), {}, 'the dismissal is cleared');
});

test('an older session still active does not bring a dismissed repo back', async (t) => {
  const repo = makeRepo(tempDir(t), 'job-market');
  const f = setup(t);
  const startedBefore = Date.now() - 60 * 60 * 1000;
  f.session(repo, startedBefore);
  await f.service.scan();
  await f.dismiss(repo);

  // The same long-running session writes again after the dismissal.
  f.session(repo, startedBefore);
  assert.deepEqual((await f.service.scan()).added, []);
  assert.deepEqual(f.roots(), []);
  assert.equal(Object.keys(f.storage.getDismissedRepos()).length, 1);
});

test('adding a dismissed repo by hand clears the dismissal', async (t) => {
  const repo = makeRepo(tempDir(t), 'job-market');
  const f = setup(t);
  f.session(repo, Date.now() - 60_000);
  await f.service.scan();
  await f.dismiss(repo);

  stub.__openDialogResponses.push([{ fsPath: repo }]);
  await runCommand('pitwall.addRepository');

  assert.deepEqual(f.storage.getDismissedRepos(), {});
  assert.deepEqual(f.roots(), [repo]);
  assert.deepEqual((await f.service.scan()).added, [], 'discovery finds it already listed');
  assert.equal(f.storage.getRepositories().length, 1);
});

test('a returned repo gets its chats back', async (t) => {
  const profile = claudeProfile(t);
  const repo = makeRepo(profile.root, 'lab');
  const iso = (ms: number) => new Date(ms).toISOString();
  profile.write('s1', repo, [entry.user('first task', iso(Date.now() - 60_000)), entry.assistant('done')]);

  const globalState = memento();
  const workspaceState = memento();
  const context = {
    subscriptions: [] as { dispose(): unknown }[],
    globalState,
    workspaceState,
    extensionUri: vscode.Uri.file('/extension'),
    extension: { id: 'sharifamlani.pitwall' },
  };
  t.after(() => context.subscriptions.forEach((subscription) => subscription.dispose()));
  await activate(context as never);
  const stored = () => makeStorage(globalState, workspaceState);
  const sessionIds = () =>
    stored()
      .getChats()
      .map((chat) => chat.harnessSessionId)
      .sort()
      .join(',');

  // Nothing is discovered before the list first renders.
  await flush();
  assert.deepEqual(stored().getRepositories(), []);
  stub.__treeViews.find((view) => view.id === 'pitwall.workspacesView')!.__setVisible(true);
  await waitFor(() => sessionIds() === 's1', 'the discovered repo with its session', 10_000);
  const [lab] = stored().getRepositories();
  assert.equal(lab.origin, 'discovered');

  await runCommand('pitwall.dismissRepository', { itemType: 'repository', data: lab });
  assert.deepEqual(stored().getRepositories(), []);
  assert.deepEqual(stored().getChats(), []);
  assert.deepEqual([...stored().getRemovedSessionKeys()], [], 'no tombstone keeps the sessions out');
  assert.equal(shownMessages().at(-1), dismissedMessage('lab'));

  // A new session starts there; the window gains focus.
  profile.write('s2', repo, [entry.user('second task', iso(Date.now() + 1_000)), entry.assistant('done')]);
  stub.window.__fireWindowState(true);
  await waitFor(() => sessionIds() === 's1,s2', 'the repo back with both chats', 10_000);
});

test('discovery never runs before the first render and its failure is logged, not thrown', async (t) => {
  const storage = makeStorage();
  let calls = 0;
  const adapter = fakeAdapter('claude', {
    discoverRecentFolders: async () => {
      calls++;
      throw new Error('projects folder locked');
    },
  });
  const service = new RepoDiscoveryService(storage, new GitService(), () => [adapter], {
    enabled: () => true,
    retentionDays: () => 14,
  });
  t.after(() => service.dispose());
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  t.after(() => (console.error = original));
  let rendered!: () => void;
  const firstRender = new Promise<void>((resolve) => (rendered = resolve));

  assert.equal(service.start(firstRender), undefined, 'start returns at once; activation never waits');
  await flush();
  await flush();
  stub.window.__fireWindowState(true);
  await flush();
  assert.equal(calls, 0, 'no pass before the first render, even on focus');

  rendered();
  await waitFor(() => errors.length > 0, 'the logged failure');
  assert.equal(calls, 1);
  assert.match(String(errors[0][0]), /\[Pitwall\] discovery/);
  assert.deepEqual(await service.scan(), { added: [], skipped: 0 }, 'a failing pass resolves');
});

test('the manifest: 14-day retention, discovery on by default, Dismiss replaces Remove on repo rows', () => {
  type Setting = { default?: unknown; markdownDescription?: string; order?: number };
  const sections = pkg.contributes.configuration as unknown as { properties: Record<string, Setting> }[];
  const settings: Record<string, Setting> = Object.assign({}, ...sections.map((section) => section.properties));
  assert.equal(settings['pitwall.autoImport.retentionDays'].default, 14);
  assert.equal(settings['pitwall.discovery.enabled'].default, true);

  const commands = pkg.contributes.commands as { command: string; title: string }[];
  assert.equal(commands.find((c) => c.command === 'pitwall.dismissRepository')?.title, 'Dismiss from Pitwall');
  assert.ok(commands.some((c) => c.command === 'pitwall.removeRepository'), 'Remove stays a palette command');

  const repoRow = ((pkg.contributes.menus as Record<string, { command?: string; when?: string }[]>)['view/item/context'] ?? []).filter(
    (item) => item.when?.includes('pitwall.workspacesView') && /repository\|folderRepository/.test(item.when)
  );
  assert.ok(repoRow.some((item) => item.command === 'pitwall.dismissRepository'), 'Dismiss on repo rows');
  assert.ok(!repoRow.some((item) => item.command === 'pitwall.removeRepository'), 'Remove is off repo rows');
});
