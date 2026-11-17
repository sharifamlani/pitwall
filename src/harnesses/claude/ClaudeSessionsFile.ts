import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeConfigDir } from './claudeConfig';

/** The process status Claude Code writes for a running session. */
export type ClaudeLiveStatus = 'busy' | 'waiting' | 'idle';

const LIVE_STATUSES: ReadonlySet<string> = new Set<ClaudeLiveStatus>(['busy', 'waiting', 'idle']);

/** The fields Pitwall reads from one `~/.claude/sessions/<pid>.json`. */
export interface ClaudeSessionFileState {
  status: ClaudeLiveStatus;
  /** Raw waiting reason; "input needed" when Claude reports waiting without one. Only set while waiting. */
  waitingFor?: string;
  statusUpdatedAt: number;
  pid: number;
  cwd: string;
}

/** One read of the sessions folder. */
export interface ClaudeSessionsSnapshot {
  /** False when no file counts (missing or empty folder, or nothing live with a known status). */
  available: boolean;
  /** When this read started. The files are read fresh, so this is the sample time. */
  observedAt: number;
  states: Map<string, ClaudeSessionFileState>;
  /** Live sessions on this machine whose status Pitwall does not know; they fall back to `claude agents`. */
  unknownStatus: Set<string>;
  /** A `.json` file could not be read or parsed (for example, caught mid-write). */
  partial: boolean;
}

export interface ClaudeSessionsFileOptions {
  /** The sessions folder. Defaults to `<Claude config dir>/sessions`, resolved on every read. */
  dir?: () => string;
  /** Whether a pid on this machine is running. Defaults to {@link isPidAlive}. */
  isAlive?: (pid: number) => boolean;
  /** This machine's pid domain. Defaults to {@link localPidDomain}. */
  pidDomain?: () => Promise<string | undefined>;
  now?: () => number;
}

/**
 * Signal 0 checks a pid without touching the process. EPERM means it exists
 * but belongs to someone else, so it is alive; ESRCH (or anything else) means
 * it is gone. A reused pid reads as alive: a known limit (ADR 0018).
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * The `pidDomain` Claude Code stamps on each sessions file: the space in which
 * its pid means something. A file from another domain (WSL, a container,
 * another machine sharing the folder) names a pid this process cannot check.
 * Mirrors Claude Code 2.1.326: `win32:<hostname>` on Windows,
 * `linux:<machine-id>:<pid namespace>` on Linux, the platform elsewhere. A
 * mismatch only costs the fallback to `claude agents`, never a wrong status.
 */
export async function localPidDomain(): Promise<string> {
  if (process.platform === 'win32') {
    return `win32:${os.hostname().toLowerCase()}`;
  }
  if (process.platform !== 'linux') {
    return process.platform;
  }
  const [machineId, pidNamespace] = await Promise.all([
    fs.promises.readFile('/etc/machine-id', 'utf8').then((text) => text.trim(), () => ''),
    fs.promises.readlink('/proc/self/ns/pid').catch(() => ''),
  ]);
  return `linux:${machineId}:${pidNamespace}`;
}

type Parsed =
  | { kind: 'malformed' }
  | { kind: 'record'; sessionId: string; pid: number; pidDomain?: string; status?: string; waitingFor?: string; statusUpdatedAt: number; cwd: string };

function parseSessionFile(text: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'malformed' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'malformed' };
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.sessionId !== 'string' || !record.sessionId) {
    return { kind: 'malformed' };
  }
  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 1) {
    return { kind: 'malformed' };
  }
  return {
    kind: 'record',
    sessionId: record.sessionId,
    pid: record.pid,
    pidDomain: typeof record.pidDomain === 'string' ? record.pidDomain : undefined,
    status: typeof record.status === 'string' ? record.status : undefined,
    waitingFor: typeof record.waitingFor === 'string' ? record.waitingFor.trim() : undefined,
    statusUpdatedAt: typeof record.statusUpdatedAt === 'number' ? record.statusUpdatedAt : 0,
    cwd: typeof record.cwd === 'string' ? record.cwd : '',
  };
}

/**
 * Live session status from `~/.claude/sessions/<pid>.json`, which Claude Code
 * keeps current for every running session, CLI or panel (ADR 0018).
 *
 * Privacy: only `*.json` files are opened. The folder also holds `.key`
 * files; their names are skipped by the listing filter and they are never
 * opened, read or stat-ed. Nothing from a file is logged.
 */
export class ClaudeSessionsFile {
  private readonly dir: () => string;
  private readonly isAlive: (pid: number) => boolean;
  private readonly pidDomain: () => Promise<string | undefined>;
  private readonly now: () => number;
  private localDomain: Promise<string | undefined> | undefined;
  private inFlight: Promise<ClaudeSessionsSnapshot> | undefined;

  constructor(options: ClaudeSessionsFileOptions = {}) {
    this.dir = options.dir ?? (() => path.join(claudeConfigDir(), 'sessions'));
    this.isAlive = options.isAlive ?? isPidAlive;
    this.pidDomain = options.pidDomain ?? localPidDomain;
    this.now = options.now ?? (() => Date.now());
  }

  /** Reads the folder fresh. Concurrent callers (one per worktree group in a tick) share one read. */
  snapshot(): Promise<ClaudeSessionsSnapshot> {
    if (!this.inFlight) {
      this.inFlight = this.read().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  private async read(): Promise<ClaudeSessionsSnapshot> {
    const observedAt = this.now();
    const snapshot: ClaudeSessionsSnapshot = {
      available: false,
      observedAt,
      states: new Map(),
      unknownStatus: new Set(),
      partial: false,
    };

    const dir = this.dir();
    let names: string[];
    try {
      // One small listing per tick, read synchronously: a missing folder (an
      // older CLI) then costs no I/O round trip before the fallback, so the
      // tick lands when it did before this source existed. Only the `.json`
      // reads below are asynchronous.
      names = fs.readdirSync(dir);
    } catch {
      return snapshot;
    }
    const files = names.filter((name) => name.endsWith('.json'));
    if (files.length === 0) {
      return snapshot;
    }

    const domain = await this.domain();
    const parsed = await Promise.all(
      files.map(async (name): Promise<Parsed> => {
        try {
          return parseSessionFile(await fs.promises.readFile(path.join(dir, name), 'utf8'));
        } catch {
          return { kind: 'malformed' };
        }
      })
    );

    const unknown = new Set<string>();
    for (const entry of parsed) {
      if (entry.kind === 'malformed') {
        snapshot.partial = true;
        continue;
      }
      // A pid from another domain cannot be checked here, so it never counts.
      if (domain === undefined || entry.pidDomain !== domain) {
        continue;
      }
      if (!this.isAlive(entry.pid)) {
        continue;
      }
      if (!entry.status || !LIVE_STATUSES.has(entry.status)) {
        unknown.add(entry.sessionId);
        continue;
      }
      const status = entry.status as ClaudeLiveStatus;
      const existing = snapshot.states.get(entry.sessionId);
      if (existing && existing.statusUpdatedAt >= entry.statusUpdatedAt) {
        continue;
      }
      snapshot.states.set(entry.sessionId, {
        status,
        ...(status === 'waiting' ? { waitingFor: entry.waitingFor || 'input needed' } : {}),
        statusUpdatedAt: entry.statusUpdatedAt,
        pid: entry.pid,
        cwd: entry.cwd,
      });
    }
    for (const sessionId of unknown) {
      if (!snapshot.states.has(sessionId)) {
        snapshot.unknownStatus.add(sessionId);
      }
    }
    snapshot.available = snapshot.states.size > 0;
    return snapshot;
  }

  private domain(): Promise<string | undefined> {
    this.localDomain ??= this.pidDomain().catch(() => undefined);
    return this.localDomain;
  }
}
