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
 * Claude's panel resumes it from; the transcript's cwds are only candidates.
 *
 * 1. A root (the repo's main folder or a worktree) whose encoding is the
 *    project folder's name.
 * 2. Else a cwd in the transcript's head (read line by line, up to 1 MB) whose
 *    encoding is that name. EnterWorktree (T18) moves the transcript into the
 *    worktree's project folder while its early entries keep main's cwd, so
 *    the later cwd names the worktree, even one the repo's listing doesn't
 *    have yet (E10: a sibling `…-wt` worktree).
 * 3. Else (a project folder name Claude shortened with a hash, or no such
 *    cwd), the first cwd when the project folder confirms it as a prefix,
 *    mapped to its root, unless a longer root claims the folder; otherwise
 *    the root with the longest matching encoding. A prefix match is never
 *    enough on its own when an exact one exists: `…-demo-wt` starts with
 *    `…-demo` plus "-".
 *
 * A plain `cd` (T18b) moves neither the cwd nor the transcript, so main
 * stays. Undefined when nothing matches.
 */
export async function readLaunchFolder(transcriptPath: string, roots: readonly string[]): Promise<string | undefined> {
  const projectDir = path.basename(path.dirname(transcriptPath));
  const encoded = new Map<string, string>();
  const encode = (folder: string): string => {
    let value = encoded.get(folder);
    if (value === undefined) {
      value = encodeClaudeProjectPath(folder);
      encoded.set(folder, value);
    }
    return value;
  };

  const exactRoot = roots.find((root) => sameDirName(encode(root), projectDir));
  if (exactRoot) {
    return exactRoot;
  }

  let first: string | undefined;
  let exactCwd: string | undefined;
  try {
    await scanJsonlLines(
      transcriptPath,
      (line) => {
        const entry = parseJsonLine(line) as { cwd?: unknown } | undefined;
        if (!entry || typeof entry !== 'object' || typeof entry.cwd !== 'string' || !entry.cwd) {
          return false;
        }
        first ??= entry.cwd;
        if (sameDirName(encode(entry.cwd), projectDir)) {
          exactCwd = entry.cwd;
          return true;
        }
        return false;
      },
      { maxBytes: LAUNCH_HEAD_MAX_BYTES }
    );
  } catch {
    // An unreadable transcript leaves only the roots to go on.
  }
  if (exactCwd) {
    return exactCwd;
  }

  const rootOf = (folder: string): string => deepestContainingRoot(roots.map((root) => ({ path: root })), folder)?.path ?? folder;
  const owner = roots
    .filter((root) => claudeProjectDirMatches(encode(root), projectDir))
    .sort((a, b) => encode(b).length - encode(a).length)[0];
  if (first && claudeProjectDirMatches(encode(first), projectDir) && (!owner || isWithin(first, owner))) {
    return rootOf(first);
  }
  return owner;
}
