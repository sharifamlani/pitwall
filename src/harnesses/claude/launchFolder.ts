import * as path from 'path';
import { deepestContainingRoot, isWithin } from '../../core/utils/paths';
import { parseJsonLine, scanJsonlLines } from '../../core/utils/jsonlTail';
import { claudeProjectDirMatches, encodeClaudeProjectPath } from './paths';

/** How far into a transcript the launch folder is looked for (Q2). */
export const LAUNCH_HEAD_MAX_BYTES = 1024 * 1024;

const sameDirName = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * A chat's launch folder (Q2): the folder its window is. The project folder
 * Claude filed the transcript under decides, because that is the folder
 * Claude's panel resumes it from; the first transcript entry with a `cwd`
 * (read line by line up to 1 MB) is only the candidate, kept when that
 * project folder confirms it.
 *
 * On a mismatch, or with no cwd in the head, the repo root or worktree whose
 * project folder holds the transcript wins: the longest matching encoding,
 * since a nested worktree's project folder also starts with its repo's. That
 * covers EnterWorktree (T18): Claude moves the transcript into the worktree's
 * project folder while its early entries keep the main folder's cwd, so the
 * worktree wins. A plain `cd` (T18b) moves neither, so main stays. Forks and
 * resumes carry another folder's cwd the same way. A cwd inside a root (a
 * session started in a subfolder) maps to that root. Undefined when nothing
 * matches.
 */
export async function readLaunchFolder(transcriptPath: string, roots: readonly string[]): Promise<string | undefined> {
  const projectDir = path.basename(path.dirname(transcriptPath));
  let first: string | undefined;
  try {
    await scanJsonlLines(
      transcriptPath,
      (line) => {
        const entry = parseJsonLine(line) as { cwd?: unknown } | undefined;
        if (entry && typeof entry === 'object' && typeof entry.cwd === 'string' && entry.cwd) {
          first = entry.cwd;
          return true;
        }
        return false;
      },
      { maxBytes: LAUNCH_HEAD_MAX_BYTES }
    );
  } catch {
    first = undefined;
  }

  const rootOf = (folder: string): string => deepestContainingRoot(roots.map((root) => ({ path: root })), folder)?.path ?? folder;
  if (first && sameDirName(encodeClaudeProjectPath(first), projectDir)) {
    return rootOf(first);
  }
  const owner = roots
    .map((root) => ({ root, encoded: encodeClaudeProjectPath(root) }))
    .filter(({ encoded }) => claudeProjectDirMatches(encoded, projectDir))
    .sort((a, b) => b.encoded.length - a.encoded.length)[0]?.root;
  if (first && claudeProjectDirMatches(encodeClaudeProjectPath(first), projectDir) && (!owner || isWithin(first, owner))) {
    return rootOf(first);
  }
  return owner;
}
