/** Worktree ownership compares paths the way Windows does: drive-letter case is not a difference. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorktreeCatalog } from '../../../src/core/services/WorktreeCatalog';

function catalogOf(paths: string[]): WorktreeCatalog {
  const worktrees = paths.map((p) => ({ path: p }));
  const storage = { getRepositories: () => [{ id: 'r', rootPath: paths[0] }] };
  const git = { listRepositoryWorktrees: () => ({ isGit: true, worktrees }) };
  return new WorktreeCatalog(storage as never, git as never);
}

/** Run `body` as if on Windows, whatever the CI OS: samePath reads process.platform. */
function asWindows(body: () => void) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    body();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

test('a worktree owns its sessions when the caller spells the drive letter differently', () => {
  asWindows(() => {
    const catalog = catalogOf(['C:\\lab\\a']);
    assert.equal(catalog.owns('c:\\lab\\a', 'C:\\lab\\a\\sub'), true);
  });
});
