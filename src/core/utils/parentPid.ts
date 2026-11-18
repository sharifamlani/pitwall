import { execFile } from 'child_process';

type Exec = (file: string, args: string[], options: { timeout: number | undefined }) => Promise<string>;

export interface ParentPidOptions {
  /** Defaults to 2 s: the lookup must never hold up a click for long. */
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
  const timeout = options.timeoutMs ?? 2_000;
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
