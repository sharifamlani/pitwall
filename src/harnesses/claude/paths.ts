import { canonicalPath } from '../../core/utils/paths';

/**
 * Claude Code encodes a project path by replacing every character outside
 * `[A-Za-z0-9]` with `-`. It encodes the physical cwd, so resolve symlinks and
 * normalize Unicode first; otherwise a worktree opened through a symlink is
 * stored under a different project directory.
 */
export function encodeClaudeProjectPath(projectPath: string): string {
  return canonicalPath(projectPath).replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Claude truncates a project directory name to 200 characters plus a short
 * hash when the encoded path is longer, and the hash is not reproducible.
 * A worktree root also owns the directories of sessions started in its
 * subdirectories, which encode as `<root>-<subdir>`.
 */
export function claudeProjectDirMatches(
  encodedPath: string,
  dirName: string
): boolean {
  if (encodedPath.length <= 200) {
    return (
      dirName === encodedPath || dirName.startsWith(`${encodedPath}-`)
    );
  }
  return dirName.startsWith(`${encodedPath.slice(0, 200)}-`);
}
