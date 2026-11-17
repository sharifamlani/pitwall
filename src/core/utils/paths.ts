import * as fs from 'fs';
import * as path from 'path';
import { BoundedCache } from './boundedCache';

/**
 * Successful realpath lookups. Paths rarely change while the extension runs;
 * the bound keeps a long session's distinct session cwds from growing it.
 */
const realpathCache = new BoundedCache<string, string>(2_000);

/**
 * Resolve a path and follow symlinks when possible.
 * Successes are memoized because opencode filtering calls this per session.
 */
export function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  const cached = realpathCache.get(resolved);
  if (cached) {
    return cached;
  }

  try {
    const real = fs.realpathSync(resolved).normalize('NFC');
    realpathCache.set(resolved, real);
    return real;
  } catch {
    return resolved.normalize('NFC');
  }
}

/**
 * One comparable spelling of a path. Windows paths are case-insensitive and
 * the editor, git and the OS disagree on drive-letter case, separators and
 * 8.3 short names, so there they compare as lower-case native real paths
 * (as `samePath` does). POSIX paths stay case-sensitive.
 */
function containmentKey(value: string): string {
  return process.platform === 'win32'
    ? comparablePath(value).normalize('NFC').toLowerCase()
    : canonicalPath(value);
}

/** True when `candidate` is `root` or a subdirectory of it. */
export function isWithin(candidate: string, root: string): boolean {
  const normalizedCandidate = containmentKey(candidate);
  const normalizedRoot = containmentKey(root);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep)
  );
}

/** True when `candidate` is strictly below `root` (the root itself is not). */
export function isStrictlyWithin(candidate: string, root: string): boolean {
  return isWithin(candidate, root) && containmentKey(candidate) !== containmentKey(root);
}

/**
 * The deepest root that contains `target`, so a session in a nested worktree
 * maps to that worktree rather than to the repository around it.
 */
export function deepestContainingRoot<T extends { path: string }>(
  roots: readonly T[],
  target: string
): T | undefined {
  let best: T | undefined;
  for (const root of roots) {
    if (isWithin(target, root.path) && (!best || root.path.length > best.path.length)) {
      best = root;
    }
  }
  return best;
}

/** One native spelling of a path: on Windows `C:/a/b` becomes `C:\a\b`. */
export function nativePath(value: string): string {
  return path.normalize(value);
}

/** Successful native realpath lookups, keyed by resolved path (failures are not cached). */
const nativeRealpathCache = new BoundedCache<string, string>(2_000);

/**
 * The one spelling a workspace root is stored under, whether it is a git
 * repository or a plain folder, added by hand or discovered. On Windows that
 * is the file system's own native spelling (upper-case drive letter, real
 * case, backslashes), so a folder picked as `c:\x` and git's `C:/x` store
 * alike. Elsewhere it is `canonicalPath`.
 */
export function canonicalRoot(value: string): string {
  if (process.platform !== 'win32') {
    return canonicalPath(value);
  }
  const real = comparablePath(value).normalize('NFC');
  return /^[a-z]:/.test(real) ? real[0].toUpperCase() + real.slice(1) : real;
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  const cached = nativeRealpathCache.get(resolved);
  if (cached) {
    return cached;
  }
  try {
    const real = fs.realpathSync.native(resolved);
    nativeRealpathCache.set(resolved, real);
    return real;
  } catch {
    return resolved;
  }
}

/**
 * True when two spellings name the same folder. Windows paths are
 * case-insensitive and the editor, git and the OS disagree on drive-letter
 * case, separators and 8.3 short names, so they compare as native real paths.
 */
export function samePath(a: string, b: string): boolean {
  if (process.platform === 'win32') {
    return comparablePath(a).toLowerCase() === comparablePath(b).toLowerCase();
  }
  return canonicalPath(a) === canonicalPath(b);
}
