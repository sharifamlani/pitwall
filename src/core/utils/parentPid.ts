import { execFile } from 'child_process';
import { BoundedCache } from './boundedCache';

type Exec = (file: string, args: string[], options: { timeout: number | undefined }) => Promise<string>;

/**
 * The Windows lookup starts PowerShell for one CIM query: 1.4-1.6 s on an idle
 * machine (live, v0.6.0), so the old 2 s timed out under load and a panel of
 * this window read as "another window". A slow answer only delays a click on
 * a live chat, and each pid is asked once (`cachedParentPid`).
 */
export const PARENT_PID_TIMEOUT_MS = 6_000;

export interface ParentPidOptions {
  /** Defaults to `PARENT_PID_TIMEOUT_MS`. */
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  exec?: Exec;
}

const defaultExec: Exec = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: options.timeout, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  });

/**
 * The parent pid of a process, asked of the OS asynchronously (`ps` or a CIM
 * query) with a timeout, so the extension host is never blocked. Undefined on
 * any failure. Reads nothing but that one number.
 */
export async function parentPidOf(pid: number, options: ParentPidOptions = {}): Promise<number | undefined> {
  const exec = options.exec ?? defaultExec;
  const timeout = options.timeoutMs ?? PARENT_PID_TIMEOUT_MS;
  const win = (options.platform ?? process.platform) === 'win32';
  try {
    const out = win
      ? await exec(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}").ParentProcessId | ForEach-Object { "ParentProcessId=$_" }`],
          { timeout }
        )
      : await exec('ps', ['-o', 'ppid=', '-p', String(Math.trunc(pid))], { timeout });
    const match = win ? /ParentProcessId=(\d+)/.exec(out) : /^\s*(\d+)\s*$/.exec(out);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A parent lookup that asks the OS once per process: a process never changes
 * its parent. The OS reuses pids, so a process is its pid plus an `identity`
 * (its start time, else its session; QA #72): a new process on an old pid is
 * asked again, never given the old process's parent. A lookup with no
 * identity is never cached. Lookups for the same process at once share one
 * query. A failed, rejected or timed-out answer is not kept, so the next click
 * asks again. Bounded, so a long session's dead processes fall out.
 */
export function cachedParentPid(
  lookup: (pid: number) => Promise<number | undefined> = (pid) => parentPidOf(pid),
  limit = 64
): (pid: number, identity?: string) => Promise<number | undefined> {
  const cache = new BoundedCache<string, Promise<number | undefined>>(limit);
  return (pid, identity) => {
    const safe = (): Promise<number | undefined> => lookup(pid).catch(() => undefined);
    if (identity === undefined) {
      return safe();
    }
    const key = `${pid}|${identity}`;
    const known = cache.get(key);
    if (known) {
      return known;
    }
    const asked: Promise<number | undefined> = safe().then((parent) => {
      if (parent === undefined && cache.get(key) === asked) {
        cache.delete(key);
      }
      return parent;
    });
    cache.set(key, asked);
    return asked;
  };
}
