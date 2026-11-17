import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitService, worktreeId } from '../../../src/core/services/GitService';
import { tempDir } from '../support';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
}

function makeRepo(t: { after(fn: () => void): void }): { scratch: string; root: string } {
  const scratch = tempDir(t, 'pitwall-git-');
  const root = path.join(scratch, 'repo');
  fs.mkdirSync(root);
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Pitwall Test');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return { scratch, root };
}

const service = new GitService();
const describeChanges = (changes: { status: string; path: string; additions: number; deletions: number }[]) =>
  changes.map((c) => `${c.status} ${c.path} +${c.additions}-${c.deletions}`).sort();

test('a plain folder is its own worktree and keeps its id through git init', (t) => {
  const scratch = tempDir(t, 'pitwall-roots-');
  const folder = path.join(scratch, 'notes');
  fs.mkdirSync(folder);

  const before = service.listRepositoryWorktrees(folder, 'repo-notes');
  assert.equal(before.isGit, false);
  assert.deepEqual(
    before.worktrees.map(({ path: p, name, isMain }) => ({ p, name, isMain })),
    [{ p: folder, name: 'notes', isMain: true }]
  );

  git(folder, 'init', '-q');
  const after = service.listRepositoryWorktrees(folder, 'repo-notes');
  assert.equal(after.isGit, true);
  assert.equal(after.worktrees[0].id, before.worktrees[0].id, 'chats stay bound across git init');

  // Git answers from a subdirectory with the ancestor's worktrees; that folder
  // is still its own plain root.
  const nested = path.join(folder, 'nested');
  fs.mkdirSync(nested);
  const nestedRoot = service.listRepositoryWorktrees(nested, 'repo-nested');
  assert.equal(nestedRoot.isGit, false);
  assert.equal(nestedRoot.worktrees[0].path, nested);

  const bare = path.join(scratch, 'bare.git');
  git(scratch, 'init', '-q', '--bare', bare);
  assert.deepEqual(service.listRepositoryWorktrees(bare, 'repo-bare'), { isGit: true, worktrees: [] });
});

test('the asynchronous worktree listing gives what the synchronous one does, without blocking', async (t) => {
  const { scratch, root } = makeRepo(t);
  const linked = path.join(scratch, 'repo-feature');
  git(root, 'worktree', 'add', '-q', '-b', 'feature', linked);
  const folder = path.join(scratch, 'notes');
  fs.mkdirSync(folder);
  const bare = path.join(scratch, 'bare.git');
  git(scratch, 'init', '-q', '--bare', bare);
  const missing = path.join(scratch, 'gone');

  for (const [rootPath, repoId] of [
    [root, 'repo-git'],
    [folder, 'repo-notes'],
    [bare, 'repo-bare'],
    [missing, 'repo-gone'],
  ]) {
    const pending = service.listRepositoryWorktreesAsync(rootPath, repoId);
    assert.ok(pending instanceof Promise, 'a promise, so the caller never waits on git');
    assert.deepEqual(await pending, service.listRepositoryWorktrees(rootPath, repoId), rootPath);
  }
});

test('change lists classify every status, including renames and non-ASCII names', (t) => {
  const { root } = makeRepo(t);
  const write = (name: string, content: string | Buffer) => fs.writeFileSync(path.join(root, name), content);
  write('old.txt', 'rename me\n');
  write('gone.txt', 'x\n');
  write('café.txt', 'é\n');
  write('bin.dat', Buffer.from([0, 1, 2]));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'more');

  write('tracked.txt', 'original\nchanged\n');
  write('café.txt', 'é\né\n');
  fs.rmSync(path.join(root, 'gone.txt'));
  git(root, 'mv', 'old.txt', 'new.txt');
  write('staged-new.txt', 'n\n');
  write('bin.dat', Buffer.from([9]));
  git(root, 'add', 'staged-new.txt', 'bin.dat');
  write('untracked.txt', 'u\n');

  assert.deepEqual(describeChanges(service.getStagedChanges(root)), [
    'added new.txt +1-0',
    'added staged-new.txt +1-0',
    'deleted old.txt +0-1',
    'modified bin.dat +0-0',
  ]);
  assert.deepEqual(describeChanges(service.getUnstagedChanges(root)), [
    'added untracked.txt +0-0',
    'deleted gone.txt +0-1',
    'modified café.txt +1-0',
    'modified tracked.txt +1-0',
  ]);
});

test('discard restores a tracked file from the index and refuses paths outside the repository', (t) => {
  const { scratch, root } = makeRepo(t);
  const outside = path.join(scratch, 'outside.txt');
  fs.writeFileSync(outside, 'keep me\n');
  assert.equal(service.discardFile(root, '../outside.txt'), false);
  assert.equal(fs.readFileSync(outside, 'utf-8'), 'keep me\n');

  fs.writeFileSync(path.join(root, 'tracked.txt'), 'changed\n');
  assert.equal(service.discardFile(root, 'tracked.txt'), true);
  assert.equal(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf-8'), 'original\n');
});

test('copying uncommitted work carries binary edits and unusual untracked names, never overwriting', (t) => {
  const { scratch, root } = makeRepo(t);
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2]));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'binary');
  const copy = path.join(scratch, 'copy');
  assert.ok(service.createWorktreeWithNewBranch(root, 'copy', copy));

  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([9, 9]));
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\nedited\n');
  fs.mkdirSync(path.join(root, 'new dir'));
  fs.writeFileSync(path.join(root, 'new dir', 'café notes.txt'), 'untracked\n');
  fs.writeFileSync(path.join(copy, 'clash.txt'), 'destination wins\n');
  fs.writeFileSync(path.join(root, 'clash.txt'), 'source\n');

  assert.equal(service.copyUncommittedChanges(root, copy), true);
  assert.deepEqual([...fs.readFileSync(path.join(copy, 'bin.dat'))], [9, 9]);
  assert.equal(fs.readFileSync(path.join(copy, 'tracked.txt'), 'utf-8'), 'original\nedited\n');
  assert.equal(fs.readFileSync(path.join(copy, 'new dir', 'café notes.txt'), 'utf-8'), 'untracked\n');
  assert.equal(fs.readFileSync(path.join(copy, 'clash.txt'), 'utf-8'), 'destination wins\n');
});

test('the discard summary counts tracked changes and lists exactly what git clean deletes', (t) => {
  const { root } = makeRepo(t);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'changed\n');
  git(root, 'mv', 'tracked.txt', 'moved.txt');
  fs.mkdirSync(path.join(root, 'build output'));
  fs.writeFileSync(path.join(root, 'build output', 'a.o'), '');
  // NTFS forbids `"` in file names.
  const quotedName = process.platform === 'win32' ? [] : ['notes "draft".txt'];
  for (const name of quotedName) fs.writeFileSync(path.join(root, name), '');
  assert.deepEqual(service.getDiscardSummary(root), {
    tracked: 1,
    untracked: ['build output/', ...quotedName],
  });
});

test('force removal only accepts a registered worktree', (t) => {
  const { scratch, root } = makeRepo(t);
  // The guard is private because it backs the one Node directory deletion in
  // the extension; reaching it through `removeWorktree` needs a corrupt
  // worktree, so the test calls it directly.
  const isSafe = (target: string) =>
    (service as unknown as { isSafeWorktreePath(repo: string, wt: string): boolean })
      .isSafeWorktreePath(root, target);

  for (const refused of [root, path.parse(root).root, os.homedir(), scratch, path.join(scratch, 'not-a-worktree')]) {
    assert.equal(isSafe(refused), false, refused);
  }
  const worktree = path.join(scratch, 'worktree');
  assert.ok(service.createWorktreeWithNewBranch(root, 'safety-branch', worktree));
  assert.equal(isSafe(worktree), true);
});

test('worktree paths from git use native separators and keep their ids', (t) => {
  const { scratch, root } = makeRepo(t);
  git(root, 'worktree', 'add', '-q', '-b', 'linked', path.join(scratch, 'linked'));
  const service = new GitService();
  const paths = service.listWorktrees(root, 'repo-1').map((w) => w.path);
  assert.deepEqual(paths, [root, path.join(scratch, 'linked')]);
  for (const p of paths) {
    assert.equal(p, path.normalize(p));
  }
  assert.equal(worktreeId('repo-1', root.replace(/[\\]/g, '/')), worktreeId('repo-1', root));
});
