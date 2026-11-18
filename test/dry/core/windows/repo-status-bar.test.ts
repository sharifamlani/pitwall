import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GitService } from '../../../../src/core/services/GitService';
import { RepoStatusBar } from '../../../../src/core/windows/RepoStatusBar';
import { stub, tempDir, waitFor, assertNoLongBlock } from '../../support';

beforeEach(() => stub.__reset());

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' }).toString();

/** A real repo `<scratch>/job-market` on `main` with one commit. */
function makeRepo(t: { after(fn: () => void): void }) {
  const scratch = tempDir(t);
  const repo = path.join(scratch, 'job-market');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'one');
  return { scratch, repo };
}

const item = () => stub.__statusBarItems.at(-1)!;

test('main folder shows "$(repo) {repo} · ⎇ {branch}"', async (t) => {
  const { repo } = makeRepo(t);
  const bar = new RepoStatusBar(repo, new GitService());
  await bar.refresh();
  assert.equal(item().text, '$(repo) job-market · ⎇ main');
  assert.equal(item().alignment, 1, 'left aligned');
  assert.equal(item().shown, true);
  bar.dispose();
  assert.equal(item().disposed, true);
});

test('worktree folder adds " ⧉" and shows its own branch', async (t) => {
  const { scratch, repo } = makeRepo(t);
  const wt = path.join(scratch, 'job-market-wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/wt', wt);
  const bar = new RepoStatusBar(wt, new GitService());
  await bar.refresh();
  assert.equal(item().text, '$(repo) job-market · ⎇ feat/wt ⧉');
  bar.dispose();
});

test('worktree status bar watches the gitdir HEAD', async (t) => {
  const { scratch, repo } = makeRepo(t);
  const wt = path.join(scratch, 'job-market-wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/wt', wt);
  assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), '.git is a file in a worktree');
  const bar = new RepoStatusBar(wt, new GitService());
  await bar.refresh();

  const watcher = stub.__fileWatchers.find((w) => !w.disposed && w.pattern.pattern === 'HEAD');
  assert.ok(watcher, 'a HEAD watcher exists');
  assert.equal(
    fs.realpathSync(watcher.pattern.base),
    fs.realpathSync(path.join(repo, '.git', 'worktrees', 'job-market-wt'))
  );

  git(wt, 'switch', '-q', '-c', 'other');
  watcher.__fireChange();
  await waitFor(() => item().text.endsWith('⎇ other ⧉'), 'the change listener to refresh', 1000);
  assert.equal(item().text, '$(repo) job-market · ⎇ other ⧉');
  bar.dispose();
  assert.ok(watcher.disposed, 'dispose stops the watcher');
});

test('tooltip is the folder path', async (t) => {
  const { repo } = makeRepo(t);
  const bar = new RepoStatusBar(repo, new GitService());
  await bar.refresh();
  assert.equal(item().tooltip, repo);
  bar.dispose();
});

test('hidden in an empty window and outside git', async (t) => {
  const empty = new RepoStatusBar(undefined, new GitService());
  await empty.refresh();
  assert.equal(item().shown, false);
  empty.dispose();

  const plain = tempDir(t);
  const bar = new RepoStatusBar(plain, new GitService());
  await bar.refresh();
  assert.equal(item().shown, false);
  bar.dispose();
});

test('click runs pitwall.workspacesView.focus', async (t) => {
  const { repo } = makeRepo(t);
  const bar = new RepoStatusBar(repo, new GitService());
  await bar.refresh();
  assert.equal(item().command, 'pitwall.workspacesView.focus');
  bar.dispose();
});

test('a detached HEAD shows the short sha', async (t) => {
  const { repo } = makeRepo(t);
  git(repo, 'checkout', '-q', '--detach');
  const sha = git(repo, 'rev-parse', '--short', 'HEAD').trim();
  const bar = new RepoStatusBar(repo, new GitService());
  await bar.refresh();
  assert.equal(item().text, `$(repo) job-market · ⎇ ${sha}`);
  bar.dispose();
});

test('a create event on HEAD (git renames HEAD.lock over it) refreshes the text', async (t) => {
  const { repo } = makeRepo(t);
  const bar = new RepoStatusBar(repo, new GitService());
  await bar.refresh();
  const watcher = stub.__fileWatchers.find((w) => !w.disposed && w.pattern.pattern === 'HEAD');
  assert.ok(watcher);
  git(repo, 'switch', '-q', '-c', 'created');
  watcher.__fireCreate();
  await waitFor(() => item().text.endsWith('⎇ created'), 'the create listener to refresh', 1000);
  bar.dispose();
});

test('locating the repo does not block the event loop', async (t) => {
  const { repo } = makeRepo(t);
  // A synchronous git call holds the loop for its whole run (36-100 ms). The
  // gap is used because a blocked wait on a child burns almost no CPU. 30 ms
  // clears the ~16 ms Windows timer tick on a loaded runner; sync is 36+ ms.
  // Best of 3: a real block shows on every run, a load spike rarely does.
  await assertNoLongBlock(
    async () => {
      const bar = new RepoStatusBar(repo, new GitService());
      await bar.refresh();
      assert.equal(item().text, '$(repo) job-market · ⎇ main');
      bar.dispose();
    },
    30,
    { label: 'locating the repo' }
  );
});
