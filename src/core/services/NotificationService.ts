import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { ChatSession } from '../types';
import type { PopupKey } from '../notify/PopupLedger';

export type AttentionKind = 'finished' | 'needs-input';

export interface NotificationTarget {
  chat: ChatSession;
  /** "repo · worktree", shown in the banner and appended to the toast. */
  context: string;
  /** Extra line from the harness, e.g. its raw waiting reason. */
  detail?: string;
}

/** One transition's pop-up: what to show, and what the judge needs (Q32). */
export interface PopupTarget extends NotificationTarget {
  /** The chat's native session ID: the lock key and the "in front anywhere" lookup. */
  sessionId: string;
  /** `statusUpdatedAt` (needs; else the transcript time) or the turn end (finished). Undefined: no stamp, no pop-up. */
  at: number | undefined;
  /** The wait was already there at activation or reload (R45). */
  preExisting?: boolean;
  /** In front of the user in this window since the wait began (the attention service's own history). */
  inFront?: boolean;
}

/** What one judgement did (Q32). */
export type NotifyResult =
  | 'shown'
  | 'skipped-locked'
  | 'skipped-front'
  | 'skipped-pre-existing'
  | 'skipped-disabled'
  | 'skipped-no-stamp'
  | 'skipped-unlisted';

/**
 * Results that use up the wait or turn: shown here, shown by another window
 * (locked), seen in front somewhere, or there before activation. The rest
 * (disabled, no stamp, unlisted) keep it, so it pops once that changes.
 */
export const USES_UP: ReadonlySet<NotifyResult> = new Set<NotifyResult>(['shown', 'skipped-locked', 'skipped-front', 'skipped-pre-existing']);

export interface NotificationOptions {
  /** The shared pop-up locks; without one this window always wins (a single window). */
  ledger?: { claim(key: PopupKey): Promise<boolean> };
  /** True when any window has this session in front and focused (the registry, Q33). */
  frontAnywhere?: (sessionId: string) => boolean;
  /** True when the chat is on the sidebar list (Q31). Default: always. */
  isListed?: (chatId: string) => boolean;
  /** The Operations log. Lines carry an id8 and a reason, never a title or a path. */
  log?: (line: string) => void;
}

/** Escape text for an AppleScript double-quoted string literal. */
export function escapeAppleScript(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ');
}

/**
 * The in-window message's "Open" (Q35): through the router like every other
 * open (D35), so a chat of another folder opens in that folder's window. When
 * the router did not hand it off ('here', 'gone', or Task 3's 'outside' per
 * Q48), the chat is marked seen and its row selected here.
 */
export async function openFromPopup(
  chat: ChatSession,
  deps: {
    route: (request: { kind: 'open'; chats: ChatSession[] }) => Promise<string>;
    activateLocal: (chat: ChatSession) => void;
  }
): Promise<void> {
  const where = await deps.route({ kind: 'open', chats: [chat] });
  if (where !== 'routed') {
    deps.activateLocal(chat);
  }
}

/** Skip lines remembered per window before the memory is cleared (one line per transition and reason). */
const MAX_LOGGED_SKIPS = 500;

/**
 * Judges and delivers attention pop-ups.
 *
 * The judgement order (row 5.1): the kind is enabled → the chat is listed →
 * the transition has a stamp → it is not pre-existing (R45) → the chat is not
 * in front of a focused window anywhere → this window wins the lock. Only
 * then is anything shown.
 *
 * VS Code has no OS-notification API: `showInformationMessage` renders inside
 * the window (and in the notification center) and can carry a button. On macOS
 * we additionally shell out to `osascript` so a finished session is visible
 * when VS Code is behind another app. The banner cannot be clicked, so the
 * toast keeps the action. (The Windows pop-up arrives in Task 3.)
 */
export class NotificationService {
  private readonly loggedSkips = new Set<string>();

  constructor(
    private readonly onOpenChat: (chatId: string) => void,
    /** True when this chat's terminal or tab is the one the user is looking at. */
    private readonly isChatVisible: (chatId: string) => boolean,
    private readonly options: NotificationOptions = {}
  ) {}

  /** Judge one transition's pop-up, claim it, then show it. */
  async notify(kind: AttentionKind, target: PopupTarget): Promise<NotifyResult> {
    const popKind = kind === 'finished' ? 'finished' : 'needs';
    const config = vscode.workspace.getConfiguration('pitwall');
    const toggle = kind === 'finished' ? 'notifications.onTurnEnd' : 'notifications.onNeedsInput';
    if (!config.get<boolean>('notifications.enabled', true) || !config.get<boolean>(toggle, true)) {
      return this.skip(popKind, target, 'disabled');
    }
    if (this.options.isListed && !this.options.isListed(target.chat.id)) {
      return this.skip(popKind, target, 'unlisted');
    }
    // Never 0 and never this window's clock: no stamp, no pop-up (Q32).
    const at = target.at !== undefined && Number.isFinite(target.at) ? Math.floor(target.at) : 0;
    if (at <= 0) {
      return this.skip(popKind, target, 'no-stamp');
    }
    if (target.preExisting) {
      return this.skip(popKind, target, 'pre-existing');
    }
    const windowFocused = vscode.window.state.focused;
    // Never interrupt someone who is already looking at this session, here or in another window (Q33).
    if (target.inFront || (windowFocused && this.isChatVisible(target.chat.id)) || this.options.frontAnywhere?.(target.sessionId)) {
      return this.skip(popKind, target, 'front');
    }
    if (this.options.ledger && !(await this.options.ledger.claim({ sessionId: target.sessionId, kind: popKind, at }))) {
      return this.skip(popKind, target, 'locked');
    }

    const name = target.chat.name;
    const title = kind === 'finished' ? `${name} finished` : `${name} needs your input`;
    const context = target.context ? ` (${target.context})` : '';
    const detail = target.detail?.trim();
    const message = detail ? `${title}${context} — ${detail}` : `${title}${context}`;

    void vscode.window.showInformationMessage(message, 'Open').then((choice) => {
      if (choice === 'Open') {
        this.onOpenChat(target.chat.id);
      }
    });

    const sound = !windowFocused && this.showNativeBanner(title, target, detail, config);
    this.options.log?.(
      `[Pitwall] popup ${popKind} ${id8(target.sessionId)} shown lag=${Math.max(0, Date.now() - at)} sound=${sound ? 'on' : 'off'} via=in-window`
    );
    return 'shown';
  }

  /** Log a skip once per transition and reason (a held-back pop-up is re-judged every tick). */
  private skip(kind: 'needs' | 'finished', target: PopupTarget, reason: string): NotifyResult {
    const key = `${target.sessionId}.${kind}.${target.at ?? 'none'}.${reason}`;
    if (!this.loggedSkips.has(key)) {
      if (this.loggedSkips.size >= MAX_LOGGED_SKIPS) {
        this.loggedSkips.clear();
      }
      this.loggedSkips.add(key);
      this.options.log?.(`[Pitwall] popup ${kind} ${id8(target.sessionId)} skipped ${reason}`);
    }
    return `skipped-${reason}` as NotifyResult;
  }

  /** The macOS banner, when it is on; true when it played its sound. */
  private showNativeBanner(
    title: string,
    target: NotificationTarget,
    detail: string | undefined,
    config: vscode.WorkspaceConfiguration
  ): boolean {
    if (process.platform !== 'darwin') {
      return false;
    }
    if (!config.get<boolean>('notifications.nativeBanner', true)) {
      return false;
    }

    const body = detail ? `${target.chat.name}: ${detail}` : title;
    const subtitle = target.context;
    const script =
      `display notification "${escapeAppleScript(body)}" ` +
      `with title "Pitwall"` +
      (subtitle ? ` subtitle "${escapeAppleScript(subtitle)}"` : '') +
      ` sound name "Glass"`;

    execFile('/usr/bin/osascript', ['-e', script], (error) => {
      if (error) {
        console.error('[Pitwall] Native notification failed:', error.message);
      }
    });
    return true;
  }
}

/** The first 8 characters of a session ID, as every log line names a session. */
function id8(sessionId: string): string {
  return sessionId.slice(0, 8);
}
