/** Worktree ownership compares paths the way Windows does: drive-letter case is not a difference. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { WorktreeCatalog } from '../../../src/core/services/WorktreeCatalog';

function catalogOf(paths: string[]): WorktreeCatalog {
  const worktrees = paths.map((p) => ({ path: p }));
  const storage = { getRepositories: () => [{ id: 'r', rootPath: paths[0] }] };
  const git = { listRepositoryWorktrees: () => ({ isGit: true, worktrees }) };
  return new WorktreeCatalog(storage as never, git as never);
}

/**
 * Run `body` as if on Windows, whatever the CI OS. samePath reads
 * process.platform, and containment splits on the path module's separator,
 * so on a POSIX host the `path` functions are swapped for `path.win32` too
 * (the bundle shares one `path` object with src). Both are put back.
 */
function asWindows(body: () => void) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  // The real module: esbuild's namespace for `import * as path` reads through to it, but is read-only.
  const mutablePath = require('path') as Record<string, unknown>;
  const savedPath = { ...mutablePath };
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
  if (path.sep !== '\\') {
    Object.assign(mutablePath, path.win32);
  }
  try {
    body();
  } finally {
    Object.assign(mutablePath, savedPath);
    Object.defineProperty(process, 'platform', original);
  }
}

test('a worktree owns its sessions when the caller spells the drive letter differently', () => {
  asWindows(() => {
    const catalog = catalogOf(['C:\\lab\\a', 'C:\\lab\\a\\wt']);
    assert.equal(catalog.owns('c:\\lab\\a', 'C:\\lab\\a\\wt\\x'), false, 'a session in the nested worktree belongs to it');
    assert.equal(catalog.owns('c:\\lab\\a', 'C:\\lab\\a\\x'), true, 'a session in the main folder belongs to the repo');
  });
});
