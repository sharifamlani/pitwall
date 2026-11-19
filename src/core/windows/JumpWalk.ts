import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** A walk ends this long after its last jump (Q40). */
export const WALK_EXPIRES_MS = 10 * 60_000;
/** The walk's state file under global storage: `v`, `ids`, `last`, `at` and nothing else. */
export const JUMP_FILE = 'pitwall-jump.json';

interface WalkState {
  v: 1;
  /** The needs-you chat ids in the list's order, as the walk saw them. */
  ids: string[];
  /** The chat the last jump went to. */
  last: string;
  /** When the last jump happened. */
  at: number;
}

/**
 * The walk behind `Next ▸` (Q40): after a jump from the list or Ctrl+Alt+0,
 * each press opens the next needs-you session in the list's order after the
 * last one jumped to. A jump changes windows, so the state is one small file
 * every window reads (`<dir>/pitwall-jump.json`); it holds chat ids and a
 * time. It may lag a list change by one tick.
 */
export class JumpWalk {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  /** The file text the last read or write saw, to tell another window's change. */
  private seen: string | undefined;
  private readonly file: string;

  constructor(
    dir: string,
    private readonly clock: () => number = Date.now
  ) {
    this.file = path.join(dir, JUMP_FILE);
  }

  /** Begin a walk at a chat the user just jumped to. */
  async start(order: string[], current: string): Promise<void> {
    const ids = order.includes(current) ? [...order] : [current, ...order];
    await this.write({ v: 1, ids, last: current, at: this.clock() });
  }

  /** Whether a walk is running: its file is there, valid, and under 10 min old. */
  async active(): Promise<boolean> {
    return (await this.read()) !== undefined;
  }

  /**
   * The chat `next` would open, without moving: the first listed after the
   * last one jumped to, in the walk's order, then any that began waiting
   * since. `skip` holds the chat in front of the pressing window (QA C3).
   */
  async peek(order: readonly string[], skip: ReadonlySet<string> = new Set()): Promise<string | undefined> {
    const state = await this.read();
    return state && pick(state, order, skip);
  }

  /** Move to the next chat and return it; the walk ends, returning undefined, when none is left. */
  async next(order: readonly string[], skip: ReadonlySet<string> = new Set()): Promise<string | undefined> {
    const state = await this.read();
    if (!state) {
      return undefined;
    }
    const target = pick(state, order, skip);
    if (!target) {
      await this.end();
      return undefined;
    }
    const ids = [...state.ids, ...order.filter((id) => !state.ids.includes(id))];
    await this.write({ v: 1, ids, last: target, at: this.clock() });
    return target;
  }

  async end(): Promise<void> {
    await fs.promises.rm(this.file, { force: true }).catch(() => undefined);
    this.changed(undefined);
  }

  /** Look at the file once; fires `onDidChange` when it differs from what this window last saw, or the walk expired. */
  async poll(): Promise<void> {
    const state = await this.read();
    this.changed(state ? JSON.stringify(state) : undefined);
  }

  private async read(): Promise<WalkState | undefined> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.file, 'utf-8');
    } catch {
      return undefined;
    }
    let state: WalkState | undefined;
    try {
      state = parse(JSON.parse(text));
    } catch {
      state = undefined;
    }
    return state && this.clock() - state.at < WALK_EXPIRES_MS ? state : undefined;
  }

  private async write(state: WalkState): Promise<void> {
    const text = JSON.stringify(state);
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      await fs.promises.writeFile(temp, text);
      await fs.promises.rename(temp, this.file);
    } catch (error) {
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
      console.error('[Pitwall] Could not write the jump walk:', error);
      return;
    }
    this.changed(text);
  }

  private changed(text: string | undefined): void {
    if (text !== this.seen) {
      this.seen = text;
      this.emitter.fire();
    }
  }
}

function pick(state: WalkState, order: readonly string[], skip: ReadonlySet<string>): string | undefined {
  const at = state.ids.indexOf(state.last);
  const later = [...state.ids.slice(at + 1), ...order.filter((id) => !state.ids.includes(id))];
  return later.find((id) => id !== state.last && order.includes(id) && !skip.has(id));
}

function parse(value: unknown): WalkState | undefined {
  const state = value as Partial<WalkState> | null;
  return state?.v === 1 &&
    Array.isArray(state.ids) &&
    state.ids.every((id) => typeof id === 'string') &&
    typeof state.last === 'string' &&
    typeof state.at === 'number'
    ? { v: 1, ids: state.ids, last: state.last, at: state.at }
    : undefined;
}
