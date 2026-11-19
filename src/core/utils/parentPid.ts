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
 * A parent lookup that asks the OS once per pid: a process never changes its
 * parent. Lookups for the same pid at once share one query. A failed or
 * timed-out answer is not kept, so the next click asks again. Bounded, so a
 * long session's dead pids fall out.
 */
export function cachedParentPid(
  lookup: (pid: number) => Promise<number | undefined> = (pid) => parentPidOf(pid),
  limit = 64
): (pid: number) => Promise<number | undefined> {
  const cache = new BoundedCache<number, Promise<number | undefined>>(limit);
  return (pid) => {
    const known = cache.get(pid);
    if (known) {
      return known;
    }
    const asked = lookup(pid).then(
      (parent) => {
        if (parent === undefined && cache.get(pid) === asked) {
          cache.delete(pid);
        }
        return parent;
      },
      () => {
        if (cache.get(pid) === asked) {
          cache.delete(pid);
        }
        return undefined;
      }
    );
    cache.set(pid, asked);
    return asked;
  };
}
