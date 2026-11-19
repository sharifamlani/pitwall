import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { notificationState } from './notificationState';

/**
 * First-run check (row 5.5, Q42): once per profile, on Windows, after the first
 * render, warn if Windows would hide Pitwall's pop-ups. Read-only: it offers
 * the Windows settings page and never changes a setting.
 */
export const NOTIFY_CHECK_KEY = 'pitwall.notifyCheckDone';
export const NOTIFY_CHECK_LOCK = 'pitwall-notify-check.lock';
/** What the file holds once the check was claimed: the once-asked marker. An empty file is only a lock. */
const DONE = 'done';
/** An empty lock (no marker) this old is a crashed window's; it is replaced. */
const STALE_LOCK_MS = 60_000;

export const TEXT_TOASTS_OFF = "Windows notifications are off, so Pitwall's pop-ups can't show.";
export const TEXT_APP_OFF = "Pitwall's pop-ups are turned off in Windows settings.";
export const TEXT_FOCUS_ON = "Focus assist is on, so Windows hides Pitwall's pop-ups.";
export const TEXT_ALL_ON = 'Windows pop-ups are on.';
export const TEXT_UNKNOWN = "Pitwall couldn't tell whether Windows hides its pop-ups.";
export const OPEN_NOTIFICATIONS = 'Open notification settings';
export const OPEN_FOCUS = 'Open Focus assist settings';
export const NOT_NOW = 'Not now';

interface MementoLike {
  get<T>(key: string, fallback?: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * The automatic check after activation's registration. A registration that did
 * not return 'ok' (a slow first start timing out) must not use up the one
 * check: it is deferred, the marker stays unclaimed, and the next activation
 * (which registers again) runs it.
 */
export async function runAfterRegistration(
  registration: Promise<'ok' | 'failed'>,
  check: Pick<FirstRunCheck, 'run'>,
  log?: (line: string) => void
): Promise<'shown' | 'quiet' | 'skipped' | 'deferred'> {
  if ((await registration) !== 'ok') {
    log?.('[Pitwall] notify-check deferred register-failed');
    return 'deferred';
  }
  return check.run();
}

export class FirstRunCheck {
  constructor(
    private readonly state: MementoLike,
    private readonly lockDir: string,
    private readonly read: typeof notificationState = notificationState,
    private readonly options: { platform?: NodeJS.Platform; log?: (line: string) => void } = {}
  ) {}

  async run(opts: { force: boolean } = { force: false }): Promise<'shown' | 'quiet' | 'skipped'> {
    if ((this.options.platform ?? process.platform) !== 'win32') {
      return 'skipped';
    }
    if (!opts.force && !(await this.claim())) {
      return 'skipped';
    }
    const s = await this.read();
    this.options.log?.(`[Pitwall] notify-check toasts=${s.toasts} app=${s.app} focus=${s.focus}`);
    let text: string | undefined;
    let button = OPEN_NOTIFICATIONS;
    let page = 'ms-settings:notifications';
    if (s.toasts === 'off') {
      text = TEXT_TOASTS_OFF;
    } else if (s.app === 'off') {
      text = TEXT_APP_OFF;
    } else if (s.focus === 'priority' || s.focus === 'alarms') {
      text = TEXT_FOCUS_ON;
      button = OPEN_FOCUS;
      page = 'ms-settings:quiethours';
    }
    if (!text) {
      if (opts.force) {
        const allOn = s.toasts === 'on' && s.app === 'on' && s.focus === 'off';
        await vscode.window.showInformationMessage(allOn ? TEXT_ALL_ON : TEXT_UNKNOWN);
      }
      return 'quiet';
    }
    const choice = await vscode.window.showWarningMessage(text, button, NOT_NOW);
    if (choice === button) {
      await vscode.env.openExternal(vscode.Uri.parse(page));
    }
    return 'shown';
  }

  /** Once per profile: the flag, and a `wx` lock so two windows starting together don't both ask. */
  private async claim(): Promise<boolean> {
    if (this.state.get<boolean>(NOTIFY_CHECK_KEY, false)) {
      return false;
    }
    const lock = path.join(this.lockDir, NOTIFY_CHECK_LOCK);
    try {
      await fs.promises.mkdir(this.lockDir, { recursive: true });
      if (!(await this.take(lock))) {
        return false;
      }
    } catch {
      return false;
    }
    // The file stays: once it holds DONE it is the durable "already asked" marker, whatever
    // globalState has synced to this window yet (staggered starts).
    const markDone = () => fs.promises.writeFile(lock, DONE).catch(() => undefined);
    if (this.state.get<boolean>(NOTIFY_CHECK_KEY, false)) {
      await markDone();
      return false;
    }
    await this.state.update(NOTIFY_CHECK_KEY, true);
    await markDone();
    return true;
  }

  private async take(lock: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.promises.writeFile(lock, '', { flag: 'wx' });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        if ((await fs.promises.readFile(lock, 'utf8').catch(() => '')) === DONE) {
          return false;
        }
        const age = await fs.promises.stat(lock).then(
          (st) => Date.now() - st.mtimeMs,
          () => 0
        );
        if (age < STALE_LOCK_MS) {
          return false;
        }
        await fs.promises.rm(lock, { force: true });
      }
    }
    return false;
  }
}
