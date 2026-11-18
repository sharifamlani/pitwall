import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { writeJsonAtomic } from '../windows/HandoffInbox';

/** The clipboard file in global storage, shared by every Pitwall window (Q9). */
export const CLIPBOARD_FILE = 'pitwall-clipboard.json';
/** Another window's write is read this long after the file stops changing. */
const WATCH_DEBOUNCE_MS = 50;

/** What the FILES clipboard holds: one path, whether it was cut, and when (docs/privacy.md). */
export interface ClipboardEntry {
  path: string;
  cut: boolean;
  at: number;
}

function parseEntry(data: unknown): ClipboardEntry | undefined {
  const entry = data as Partial<Record<keyof ClipboardEntry, unknown>> | null;
  if (!entry || typeof entry.path !== 'string' || !entry.path || typeof entry.cut !== 'boolean') {
    return undefined;
  }
  return { path: entry.path, cut: entry.cut, at: typeof entry.at === 'number' ? entry.at : 0 };
}

/**
 * One FILES clipboard for every window (Q9): a copy or cut in one window is
 * pasted in any other. It lives in `<globalStorage>/pitwall-clipboard.json`,
 * written to `.tmp` and renamed, so a reader never sees half a file. Without
 * a storage folder (no global storage) it is this window's alone, in memory.
 */
export class SharedClipboard implements vscode.Disposable {
  private readonly file: string | undefined;
  private memory: ClipboardEntry | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires after a set or clear in this window, and (while `watch()`ing) in any other. */
  readonly onDidChange: vscode.Event<void> = this.changed.event;

  constructor(
    private readonly dir: string | undefined,
    private readonly clock: () => number = Date.now
  ) {
    this.file = dir ? path.join(dir, CLIPBOARD_FILE) : undefined;
  }

  async set(filePath: string, cut: boolean): Promise<void> {
    const entry: ClipboardEntry = { path: filePath, cut, at: this.clock() };
    if (this.file) {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      await writeJsonAtomic(this.file, entry);
    } else {
      this.memory = entry;
    }
    this.changed.fire();
  }

  async get(): Promise<ClipboardEntry | undefined> {
    if (!this.file) {
      return this.memory;
    }
    try {
      return parseEntry(JSON.parse(await fs.promises.readFile(this.file, 'utf8')));
    } catch {
      return undefined;
    }
  }

  async clear(): Promise<void> {
    if (this.file) {
      await fs.promises.rm(this.file, { force: true });
    } else {
      this.memory = undefined;
    }
    this.changed.fire();
  }

  /** Fire `onDidChange` when another window changes the clipboard file. */
  watch(): vscode.Disposable {
    if (!this.dir) {
      return { dispose: () => undefined };
    }
    let watcher: fs.FSWatcher | undefined;
    let pending: NodeJS.Timeout | undefined;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      watcher = fs.watch(this.dir, (_event, name) => {
        // Some platforms give no name; then any change in the folder may be ours.
        if (name && String(name) !== CLIPBOARD_FILE) {
          return;
        }
        clearTimeout(pending);
        pending = setTimeout(() => this.changed.fire(), WATCH_DEBOUNCE_MS);
      });
      watcher.on('error', () => watcher?.close());
    } catch {
      // No file events: this window sees other windows' copies at its next paste.
    }
    return {
      dispose: () => {
        clearTimeout(pending);
        watcher?.close();
      },
    };
  }

  dispose(): void {
    this.changed.dispose();
  }
}
