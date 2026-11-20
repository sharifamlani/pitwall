import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { ChatSession } from '../types';
import type { PopupKey } from '../notify/PopupLedger';
import { popupCopy, ToastPayload } from '../notify/toastXml';
import { AUMID } from '../notify/WindowsToast';
import { isOpenableSessionId, openUri } from '../notify/PopupUriHandler';
import type { OpenSource } from '../windows/openSource';

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
  /** The repo's sidebar name, the Windows pop-up's title (§3a). Default: the context's first part. */
  repo?: string;
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
  /**
   * True when this window's active tab may be this chat's own and simply not
   * bound yet: a native-UI tab of its harness with no session, in its
   * folder, while the chat has no bound tab (a brand-new chat being watched,
   * PR #73). Counts as in front while the window is focused.
   */
  unboundFront?: (chat: ChatSession) => boolean;
  /** True when the chat is on the sidebar list (Q31). Default: always. */
  isListed?: (chatId: string) => boolean;
  /** The Operations log. Lines carry an id8 and a reason, never a title or a path. */
  log?: (line: string) => void;
  /**
   * The Windows pop-up host (row 5.2), on Windows only. When it shows the
   * pop-up, that replaces the in-window message; when it fails, the in-window
   * message shows instead, once (Q35).
   */
  toast?: {
    show(p: ToastPayload): Promise<'shown' | 'failed'>;
    /** Get the host ready now, so the next pop-up doesn't wait for it to start. */
    warm?(): void;
  };
  /** Whether a kind's pop-up plays a sound (the sound switches, Q41). Default: silent. */
  sound?: (kind: 'needs' | 'finished') => boolean;
  /** The platform the macOS banner checks. Default: this one. (Tests.) */
  platform?: NodeJS.Platform;
  /** Runs one AppleScript for the macOS banner. Default: `/usr/bin/osascript`. (Tests.) */
  osascript?: (script: string) => void;
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
    route: (request: { kind: 'open'; chats: ChatSession[] }, options: { source: OpenSource }) => Promise<string>;
    activateLocal: (chat: ChatSession) => void;
  }
): Promise<void> {
  const where = await deps.route({ kind: 'open', chats: [chat] }, { source: { via: 'notification' } });
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
 * toast keeps the action. On Windows the pop-up host (`WindowsToast`) shows
 * an OS pop-up under Pitwall's own sender instead, and the in-window message
 * is its fallback (Q35).
 */
export class NotificationService {
  private readonly loggedSkips = new Set<string>();
  /** Windows pop-ups still being handed to the host. */
  private readonly deliveries = new Set<Promise<void>>();

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
    if (
      target.inFront ||
      (windowFocused && (this.isChatVisible(target.chat.id) || this.options.unboundFront?.(target.chat))) ||
      this.options.frontAnywhere?.(target.sessionId)
    ) {
      return this.skip(popKind, target, 'front');
    }
    if (this.options.ledger && !(await this.options.ledger.claim({ sessionId: target.sessionId, kind: popKind, at }))) {
      return this.skip(popKind, target, 'locked');
    }

    // On Windows the pop-up replaces the in-window message (Q35). Its link carries a UUID only (Q37),
    // so a session ID it can't carry keeps the in-window message, whose Open works for any chat.
    const toast = this.options.toast;
    if (toast && isOpenableSessionId(target.sessionId)) {
      // Delivered in the background: a slow host (up to 10 s) never holds up the attention tick.
      const delivery = this.deliverToast(toast, popKind, target, at, windowFocused, config);
      this.deliveries.add(delivery);
      void delivery.finally(() => this.deliveries.delete(delivery));
      return 'shown';
    }
    this.showInWindow(kind, target, at, windowFocused, config);
    return 'shown';
  }

  /**
   * A pop-up may follow soon (a chat is at work): get the Windows pop-up host
   * ready, so the pop-up doesn't wait 0.6–1.3 s for PowerShell to start (PR
   * #76 live gate). Judges nothing and shows nothing.
   */
  prepare(): void {
    this.options.toast?.warm?.();
  }

  /** Resolves once every Windows pop-up handed to the host so far has shown or fallen back. */
  async whenDelivered(): Promise<void> {
    while (this.deliveries.size > 0) {
      await Promise.all([...this.deliveries]);
    }
  }

  /** The Windows pop-up; on failure, the in-window message once instead (Q35). */
  private async deliverToast(
    toast: NonNullable<NotificationOptions['toast']>,
    popKind: 'needs' | 'finished',
    target: PopupTarget,
    at: number,
    windowFocused: boolean,
    config: vscode.WorkspaceConfiguration
  ): Promise<void> {
    const repo = target.repo || target.context.split(' · ')[0] || target.chat.name;
    const copy = popupCopy(popKind, { repo, chat: target.chat.name, waitingFor: target.detail });
    const sound = this.options.sound?.(popKind) ?? false;
    const payload: ToastPayload = {
      aumid: AUMID,
      ...copy,
      sound,
      openUri: openUri(target.sessionId),
      tag: `${id8(target.sessionId)}-${popKind}`,
    };
    const result = await toast.show(payload).catch(() => 'failed' as const);
    if (result === 'shown') {
      this.options.log?.(
        `[Pitwall] popup ${popKind} ${id8(target.sessionId)} shown lag=${Math.max(0, Date.now() - at)} sound=${sound ? 'on' : 'off'} via=toast`
      );
      return;
    }
    this.showInWindow(popKind === 'finished' ? 'finished' : 'needs-input', target, at, windowFocused, config);
  }

  /** The in-window message with its Open button (and the macOS banner), then its `shown` line. */
  private showInWindow(
    kind: AttentionKind,
    target: PopupTarget,
    at: number,
    windowFocused: boolean,
    config: vscode.WorkspaceConfiguration
  ): void {
    const popKind = kind === 'finished' ? 'finished' : 'needs';
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

    // Only the macOS banner can play a sound here; the in-window message is silent.
    const wantsSound = this.options.sound?.(popKind) ?? false;
    const sound = !windowFocused && this.showNativeBanner(title, target, detail, config, wantsSound) && wantsSound;
    this.options.log?.(
      `[Pitwall] popup ${popKind} ${id8(target.sessionId)} shown lag=${Math.max(0, Date.now() - at)} sound=${sound ? 'on' : 'off'} via=in-window`
    );
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

  /**
   * "Pitwall: test sound" from the bell's Test sound button (§3d, QA N3): one
   * pop-up with sound, whatever the switches say. Windows shows it through the
   * pop-up host; elsewhere the in-window message (and on macOS the banner with
   * "Glass") stands in.
   */
  async testSound(): Promise<void> {
    const toast = this.options.toast;
    if (toast) {
      const payload: ToastPayload = {
        aumid: AUMID,
        title: 'Pitwall: test sound',
        body: 'This is how a pop-up sounds.',
        sound: true,
        noLaunch: true,
        tag: 'pitwall-test',
      };
      if ((await toast.show(payload).catch(() => 'failed' as const)) === 'shown') {
        this.options.log?.('[Pitwall] popup test shown sound=on');
        return;
      }
    }
    void vscode.window.showInformationMessage('Pitwall: test sound');
    const played = this.runBanner('Pitwall: test sound', 'Pitwall', '', true);
    this.options.log?.(`[Pitwall] popup test shown sound=${played ? 'on' : 'off'}`);
  }

  /** The macOS banner, when it is on; true when it was shown (it plays "Glass" only when `withSound`). */
  private showNativeBanner(
    title: string,
    target: NotificationTarget,
    detail: string | undefined,
    config: vscode.WorkspaceConfiguration,
    withSound: boolean
  ): boolean {
    if (!config.get<boolean>('notifications.nativeBanner', true)) {
      return false;
    }

    return this.runBanner(detail ? `${target.chat.name}: ${detail}` : title, 'Pitwall', target.context, withSound);
  }

  /** Run the macOS banner's AppleScript; false on any other platform. */
  private runBanner(body: string, heading: string, subtitle: string, withSound: boolean): boolean {
    if ((this.options.platform ?? process.platform) !== 'darwin') {
      return false;
    }
    const script =
      `display notification "${escapeAppleScript(body)}" ` +
      `with title "${escapeAppleScript(heading)}"` +
      (subtitle ? ` subtitle "${escapeAppleScript(subtitle)}"` : '') +
      (withSound ? ' sound name "Glass"' : '');
    if (this.options.osascript) {
      this.options.osascript(script);
      return true;
    }
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
