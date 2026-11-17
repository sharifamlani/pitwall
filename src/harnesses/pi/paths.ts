import { canonicalPath } from '../../core/utils/paths';

/**
 * Pi stores a session under `--<cwd>--`, removing the leading separator and
 * replacing `/`, `\`, and `:` with `-`. It records the physical cwd, so
 * resolve symlinks first; otherwise a worktree opened through a symlink is
 * stored under a different directory.
 */
export function encodePiProjectDir(projectPath: string): string {
  const safe = canonicalPath(projectPath)
    .replace(/^[/\\]/, '')
    .replace(/[/\\:]/g, '-');
  return `--${safe}--`;
}

/**
 * Pi's encoding is lossy (`/x/repo-other` encodes like `/x/repo/other`), so
 * this is deliberately a superset: a worktree root also owns the directories
 * of sessions started in its subdirectories. Callers verify the parsed `cwd`.
 */
export function piProjectDirMatches(
  encodedPath: string,
  dirName: string
): boolean {
  return dirName === encodedPath || dirName.startsWith(encodedPath.slice(0, -1));
}
