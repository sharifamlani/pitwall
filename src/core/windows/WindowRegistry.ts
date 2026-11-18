import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { samePath } from '../utils/paths';
import { writeJsonAtomic } from './HandoffInbox';

/**
 * The window registry (ADR 0020). Every Pitwall window beats a small record
 * into `<globalStorage>/pitwall-windows/<pid>.json`: its folder and the chats
 * it has open as tabs. Every window reads the others' records, so a row can
 * say which repos have a window and which chats are open anywhere. Records
 * hold only a pid, a folder path, a timestamp and session ids.
 */

/** A window beats this often, and on every change. */
export const BEAT_MS = 15_000;
/** A window is stale this long after its last beat, or at once when its pid is dead. */
export const STALE_MS = 45_000;
/** The registry folder under global storage. */
export const WINDOWS_DIR = 'pitwall-windows';
/** Other windows' changes are read this long after their files stop changing. */
const REFRESH_DEBOUNCE_MS = 100;

export interface WindowRecord {
  pid: number;
  folder: string | undefined;
  beatAt: number;
  openSessionIds: string[];
}

/** The folder every window shares: the extension's global storage, created if missing. */
export function sharedDir(context: vscode.ExtensionContext): string {
  const dir = context.globalStorageUri.fsPath;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * This window's folder, only when it is a single-folder window (Q17). An
 * empty window, a multi-root window and a `.code-workspace` window own no
 * folder: they never claim a request or count as a repo's window.
 */
export function ownsFolder(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (vscode.workspace.workspaceFile !== undefined || !folders || folders.length !== 1) {
    return undefined;
  }
  return folders[0].uri.fsPath;
}

/** True while a process with this pid runs (EPERM: it runs as another user). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseRecord(data: unknown, pid: number): WindowRecord | undefined {
  const record = data as Partial<Record<keyof WindowRecord, unknown>> | null;
  if (
    !record ||
    record.pid !== pid ||
    typeof record.beatAt !== 'number' ||
    !Array.isArray(record.openSessionIds) ||
    !record.openSessionIds.every((id) => typeof id === 'string')
  ) {
    return undefined;
  }
  return {
    pid,
    folder: typeof record.folder === 'string' ? record.folder : undefined,
    beatAt: record.beatAt,
    openSessionIds: record.openSessionIds as string[],
  };
}

/** What `onDidChange` compares: every live window's pid, folder and open chats, never `beatAt`. */
function signatureOf(windows: readonly WindowRecord[]): string {
  return JSON.stringify(windows.map((w) => [w.pid, w.folder ?? null, [...w.openSessionIds].sort()]));
}

export class WindowRegistry {
  private readonly dir: string;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when a window appears, goes stale, or changes its folder or open chats; never for a beat alone. */
  readonly onDidChange: vscode.Event<void> = this.changed.event;
  private openIds: string[] = [];
  private signature = signatureOf([]);
  private disposed = false;
  /** Beats and refreshes run one at a time, so writes never share a temp file and comparisons never interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    dir: string,
    private readonly self: { pid: number; folder: string | undefined },
    private readonly clock: () => number = Date.now
  ) {
    this.dir = path.join(dir, WINDOWS_DIR);
  }

  private get ownFile(): string {
    return path.join(this.dir, `${this.self.pid}.json`);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Write this window's record with the chats it has open now, then refresh. */
  async beat(openSessionIds: string[]): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.openIds = [...openSessionIds];
    await this.enqueue(async () => {
      if (this.disposed) {
        return;
      }
      const record: WindowRecord = {
        pid: this.self.pid,
        folder: this.self.folder,
        beatAt: this.clock(),
        openSessionIds: this.openIds,
      };
      await fs.promises.mkdir(this.dir, { recursive: true });
      await writeJsonAtomic(this.ownFile, record);
      if (this.disposed) {
        fs.rmSync(this.ownFile, { force: true });
      }
    });
    await this.refresh();
  }

  /** Re-read every window and fire `onDidChange` if the set differs from the last read. */
  refresh(): Promise<void> {
    return this.enqueue(async () => {
      const signature = signatureOf(await this.windows());
      if (signature !== this.signature) {
        this.signature = signature;
        if (!this.disposed) {
          this.changed.fire();
        }
      }
    });
  }

  /** Every live window, this one included, by pid. Records of dead pids are deleted. */
  async windows(): Promise<WindowRecord[]> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return [];
    }
    const now = this.clock();
    const records = await Promise.all(
      names.map(async (name) => {
        const match = /^(\d+)\.json$/.exec(name);
        if (!match) {
          return undefined;
        }
        const pid = Number(match[1]);
        const file = path.join(this.dir, name);
        if (!isAlive(pid)) {
          await fs.promises.rm(file, { force: true }).catch(() => undefined);
          return undefined;
        }
        try {
          const record = parseRecord(JSON.parse(await fs.promises.readFile(file, 'utf8')), pid);
          return record && now - record.beatAt < STALE_MS ? record : undefined;
        } catch {
          return undefined;
        }
      })
    );
    return records.filter((record): record is WindowRecord => record !== undefined).sort((a, b) => a.pid - b.pid);
  }

  /** The live windows on `folder`, matched with `samePath`. */
  async windowsFor(folder: string): Promise<WindowRecord[]> {
    return (await this.windows()).filter((w) => w.folder !== undefined && samePath(w.folder, folder));
  }

  /** Every session open as a tab in any live window. */
  async openSessionIds(): Promise<Set<string>> {
    return new Set((await this.windows()).flatMap((w) => w.openSessionIds));
  }

  /**
   * Beat now and every 15 s, and refresh when another window's record changes.
   * Disposing stops both and deletes this window's record.
   */
  start(): vscode.Disposable {
    const beat = () => void this.beat(this.openIds).catch(() => undefined);
    beat();
    const timer = setInterval(beat, BEAT_MS);
    timer.unref?.();
    let watcher: fs.FSWatcher | undefined;
    let pending: NodeJS.Timeout | undefined;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      watcher = fs.watch(this.dir, () => {
        clearTimeout(pending);
        pending = setTimeout(() => void this.refresh().catch(() => undefined), REFRESH_DEBOUNCE_MS);
      });
      watcher.on('error', () => watcher?.close());
    } catch {
      // No file events: the 15 s beat still refreshes.
    }
    return {
      dispose: () => {
        this.disposed = true;
        clearInterval(timer);
        clearTimeout(pending);
        watcher?.close();
        try {
          fs.rmSync(this.ownFile, { force: true });
        } catch {
          // Already gone, or held open by a reader; it goes stale in 45 s.
        }
        this.changed.dispose();
      },
    };
  }
}
