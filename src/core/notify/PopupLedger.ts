import * as fs from 'fs';
import * as path from 'path';

/** The pop-up lock folder under global storage (Q32). */
export const POPUPS_DIR = 'pitwall-popups';
/** A lock is swept this long after it was made: a reload inside it can't re-pop (Q34). */
export const LOCK_TTL_MS = 10 * 60_000;

/** One transition's pop-up: a session, a kind and the stamp that dates it. */
export interface PopupKey {
  sessionId: string;
  kind: 'needs' | 'finished';
  /** `statusUpdatedAt` (needs) or the turn end (finished): a positive integer, never 0 and never the observing window's clock. */
  at: number;
}

/** Every harness's session IDs (UUIDs, opencode's `ses_…`), and never a path separator. */
const SESSION_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const LOCK_NAME = /^[A-Za-z0-9_.-]{1,128}\.(needs|finished)\.[1-9]\d*\.lock$/;

/**
 * Exactly one window shows each pop-up (Q32). Every Pitwall window sees the
 * same transition, and each tries to create one empty lock file for it,
 * `<dir>/<sessionId>.<kind>.<at>.lock`, with `wx` (exclusive create). Only the
 * window that creates it shows the pop-up; the others lose the claim. The
 * folder is the extension's shared global storage, so this holds across
 * windows and across a reload of one window.
 *
 * Lock files are empty: their names hold only a session ID, a kind and a
 * timestamp. They are swept 10 minutes after they were made.
 */
export class PopupLedger {
  constructor(
    private readonly dir: string,
    private readonly clock: () => number = Date.now,
    /** The Operations log: `[Pitwall] popup lock failed <code>` (QA N2). */
    private readonly log?: (line: string) => void
  ) {}

  /**
   * True when this window made the lock (show the pop-up), false when another
   * window, or this one before a reload, already did. A key with no usable
   * stamp or a malformed session ID is a caller bug and throws: a missing
   * stamp must never become a `.0` lock.
   *
   * Any other file-system failure (the folder can't be written) answers true:
   * a pop-up that may show twice beats one that never shows. It is logged to
   * the Operations channel with its error code (never the path).
   */
  async claim(key: PopupKey): Promise<boolean> {
    if (!SESSION_ID.test(key.sessionId)) {
      throw new Error('PopupLedger: the session ID is not an ID');
    }
    if (!Number.isInteger(key.at) || key.at <= 0) {
      throw new Error('PopupLedger: a pop-up needs a positive integer stamp');
    }
    if (key.kind !== 'needs' && key.kind !== 'finished') {
      throw new Error('PopupLedger: unknown kind');
    }
    const file = path.join(this.dir, `${key.sessionId}.${key.kind}.${key.at}.lock`);
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      const handle = await fs.promises.open(file, 'wx');
      await handle.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      const code = (error as NodeJS.ErrnoException).code;
      this.log?.(`[Pitwall] popup lock failed ${code && /^[A-Z0-9_]+$/.test(code) ? code : 'unknown'}`);
      console.error('[Pitwall] pop-up lock failed; showing the pop-up anyway:', (error as Error).message);
      return true;
    }
  }

  /** Delete lock files made more than 10 minutes ago. Other files are left alone; a missing folder is fine. */
  async sweep(): Promise<void> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return;
    }
    const cutoff = this.clock() - LOCK_TTL_MS;
    await Promise.all(
      names
        .filter((name) => LOCK_NAME.test(name))
        .map(async (name) => {
          const file = path.join(this.dir, name);
          try {
            const { mtimeMs } = await fs.promises.stat(file);
            if (mtimeMs <= cutoff) {
              await fs.promises.rm(file, { force: true });
            }
          } catch {
            // Gone already, or swept by another window.
          }
        })
    );
  }
}
