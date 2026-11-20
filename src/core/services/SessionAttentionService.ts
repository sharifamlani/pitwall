import * as vscode from 'vscode';
import { ChatSession, Worktree } from '../types';
import {
  HarnessAdapter,
  HarnessLiveState,
  HarnessSession,
  TurnState,
} from '../harness/types';
import { HarnessRegistry } from '../harness/HarnessRegistry';
import { chatNativeSessionIds } from '../harness/sessionUtils';
import { SessionStatus, lastTurnEnd, sessionStatus } from '../providers/sessionStatus';
import { NotificationService, NotifyResult, USES_UP } from './NotificationService';
import { StorageService } from './StorageService';

/** A row's status and when it entered it (P6: the in-group sort key). */
export interface ChatStatus {
  status: SessionStatus;
  statusSince: number;
}

/**
 * One row-status change of a listed chat (row 5.1). Every window computes the
 * same transitions from the same sessions file; the pop-up lock (Q32) lets
 * exactly one of them speak.
 */
export interface StatusTransition {
  chatId: string;
  sessionId: string;
  from: SessionStatus;
  to: SessionStatus;
  /**
   * When it happened by the harness's own clock: `statusUpdatedAt` (or the
   * transcript time) for needs and working, the turn end for finished. A
   * transition with no such stamp (a row turning idle because you opened it,
   * a transcript-only harness) carries the detection time instead; the pop-up
   * lock never uses this field, so that fallback can't become a lock key.
   */
  at: number;
  /** When the sample that showed it was taken. */
  observedAt: number;
  /** The raw waiting reason, on a transition to needs. */
  waitingFor?: string;
}

export interface AttentionOptions {
  /** The Operations log (`[Pitwall] status <id8> <from>→<to> lag=<ms>`). */
  log?: (line: string) => void;
  /**
   * Live sessions no listed chat holds (a new chat, or a repo Pitwall doesn't
   * list yet), as each one's turn starts (Q31). The answer names the
   * sessions that had nothing to import yet: they are asked about again,
   * with backoff (UNLISTED_RETRY_MS), up to UNLISTED_MAX_ASKS times per turn.
   * Any other session, or no answer, is asked about once per window.
   */
  onUnlistedLive?: (sessionIds: string[]) => void | readonly string[] | PromiseLike<void | readonly string[]>;
}

/**
 * The waits between asks about one unlisted live session whose transcript
 * had nothing to import yet: Claude marks a turn busy before it writes the
 * prompt to the transcript, so the first ask can come too early (12f645db).
 */
export const UNLISTED_RETRY_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];
/** Asks about one unlisted session per turn: about 31 s of tries, then none until its next turn starts. */
export const UNLISTED_MAX_ASKS = UNLISTED_RETRY_MS.length + 1;

/** One unlisted live session's asks (new-chat pickup). */
interface UnlistedAsk {
  /** Asks in the current turn. */
  asks: number;
  /** The next ask may go out. */
  due: boolean;
  /** An ask's answer is pending. */
  inFlight: boolean;
  /** Answered for good (listed, removed, or no answer): never asked again in this window. */
  settled: boolean;
  /** Its turn was under way at the last look; a new turn re-arms the asks. */
  underWay: boolean;
  /** A new turn started while an ask was in flight: its answer re-arms the asks. */
  resetPending?: boolean;
  /** The backoff before the next ask. */
  timer?: NodeJS.Timeout;
}

const IDLE: ChatStatus = { status: 'idle', statusSince: 0 };

type RowState = Pick<HarnessLiveState, 'turnState' | 'turnEndedAt' | 'liveStatus' | 'waitingFor' | 'writtenAt' | 'observedAt' | 'statusUpdatedAt'>;

/**
 * A row state with nothing running behind it: no process status, no wait,
 * and a turn that was mid-way is over (its process is gone, or the state
 * came from a transcript scan, which cannot tell).
 */
function settled(state: RowState): RowState {
  return {
    turnState: state.turnState === 'working' ? 'done' : state.turnState,
    turnEndedAt: lastTurnEnd(state) ?? state.turnEndedAt,
  };
}

/** Whether the harness says the session is waiting on the user. */
function isWaiting(state: RowState | undefined): boolean {
  return state?.liveStatus === 'waiting' || Boolean(state?.waitingFor);
}

/** A wait's stamp (Q32): the live record's `statusUpdatedAt`, else the transcript time; undefined when neither is known. */
function waitStamp(state: RowState | undefined): number | undefined {
  if (state?.liveStatus === 'waiting' && state.statusUpdatedAt && state.statusUpdatedAt > 0) {
    return state.statusUpdatedAt;
  }
  return state?.writtenAt && state.writtenAt > 0 ? state.writtenAt : undefined;
}

/**
 * When a row entered its status. A wait starts at the harness's own wait
 * time, a finished turn at its end. A chat judged for the first time that is
 * idle sorts by its last turn end or last use; any other entry is "now".
 */
function statusSince(status: SessionStatus, state: RowState | undefined, chat: ChatSession, now: number, first: boolean): number {
  switch (status) {
    case 'needs':
      return state?.writtenAt ?? (first ? state?.observedAt : undefined) ?? now;
    case 'finished':
      return lastTurnEnd(state) ?? now;
    case 'working':
      return now;
    case 'idle':
      return first ? state?.turnEndedAt ?? chat.lastAccessedAt ?? chat.createdAt : now;
  }
}

const TICK_MS = 4_000;
export const NEEDS_INPUT_COOLDOWN_MS = 60_000;

/**
 * A changed reason is news immediately; a toast retried under the same reason
 * (one the settings held back) waits out the cooldown since the chat's last
 * toast. Each wait still toasts at most once.
 */
export function shouldNotifyNeedsInput(
  previous: string | undefined,
  waitingFor: string,
  lastNotifiedAt: number | undefined,
  now: number
): boolean {
  return (
    waitingFor !== previous ||
    now - (lastNotifiedAt ?? 0) >= NEEDS_INPUT_COOLDOWN_MS
  );
}

interface WorktreeGroup {
  adapter: HarnessAdapter;
  path: string;
  chats: ChatSession[];
}

/** A wait still to be judged for a pop-up. */
interface PendingWait {
  /** It may predate activation (R45): judged once, never shown. */
  preExisting: boolean;
  /** The reason the last judgement saw, for the cooldown; undefined before the first. */
  triedReason?: string;
}

/**
 * Every listed chat's status, its transitions, and the pop-ups they earn
 * (rows 3.3 and 5.1).
 *
 * The tick polls the open chats plus every closed chat whose session the
 * harness's live record lists (Claude: `~/.claude/sessions`); every other
 * chat's turn state comes from the discovery scan (`noteSessions`), so a tick
 * never reads the transcripts of quiet chats (QA S5, E18). A change to the
 * live record re-polls within 150 ms (`watchLive`); the 4 s tick is the
 * backstop.
 *
 * Each row-status change after the first pass is a `StatusTransition`,
 * logged with its lag. Pop-ups are judged for every chat in the sidebar list
 * (Q31), open or not:
 * - needs you: a wait that began after activation (R45), judged once, and
 *   held back only while the settings are off, the chat isn't listed or the
 *   wait has no stamp (Q32);
 * - finished: a turn that ended after a working (or idle) row, never after a
 *   wait (which already spoke) and never for a process that died mid-turn
 *   (Q30).
 * `NotificationService` makes the call; this service decides what is news.
 *
 * Needs-you is the live wait itself (Q30): the row, the list and the counts
 * show a waiting chat whether or not it is in front. Only the pop-up looks
 * at what is in front.
 *
 * Harness behavior stays behind the adapter. Harnesses with a cheap live-state
 * query expose `getLiveStates`; the rest fall back to discovery.
 */
export class SessionAttentionService {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  /** A poll asked for while one was running runs right after it. */
  private pollQueued = false;

  /** Latest known state per chat, for its row; kept when a chat closes. */
  private readonly rowState = new Map<string, RowState>();
  /** Each chat's row status and when it entered it. */
  private readonly rowStatus = new Map<string, ChatStatus>();
  /** Chats whose row status was last judged from a known state, not a placeholder drawn before any state arrived. */
  private readonly judgedWithState = new Set<string>();
  /** Chats the last tick polled; the scan does not overwrite their fresher state. */
  private polledChats = new Set<string>();
  /** The seen time this service wrote per chat, ahead of the storage echo. */
  private readonly seenWritten = new Map<string, number>();
  /** The turn end each chat's last seen write was for: one write per finished turn (QA S4). */
  private readonly seenTurn = new Map<string, number>();
  private readonly statusEmitter = new vscode.EventEmitter<string[]>();
  /** Fires with the chats whose row status changed, and only those. */
  readonly onDidChangeStatus = this.statusEmitter.event;
  private readonly transitionEmitter = new vscode.EventEmitter<StatusTransition>();
  /** Fires once per row-status change of a listed chat, after the first pass. */
  readonly onDidTransition = this.transitionEmitter.event;

  /** When the last needs-input toast was actually shown, per chat. */
  private readonly lastNeedsInputAt = new Map<string, number>();
  /** The current wait's reason per chat; gone when the wait ends. */
  private readonly lastWaitingFor = new Map<string, string>();
  /** Waits that may still pop, by chat. A wait leaves once it is used up or ends. */
  private readonly pendingWaits = new Map<string, PendingWait>();
  /** Finished turns that may still pop, by chat, with the turn end. */
  private readonly pendingFinished = new Map<string, number>();
  /** The turn end each chat's finished status was last judged for. */
  private readonly judgedTurnEnd = new Map<string, number>();
  /**
   * Per chat, when the last sample without a wait was taken (the start of
   * the call behind it). A wait first sighted later began somewhere between
   * this time and its sighting.
   */
  private readonly lastClearAt = new Map<string, number>();
  /**
   * Per chat, the earliest time the current wait may have begun, fixed at
   * its first sighting; see beganUnseen.
   */
  private readonly waitStartAt = new Map<string, number>();
  /** When this service started: waits that may predate it are pre-existing (R45). */
  private readonly activatedAt = Date.now();
  /** Per chat, the last time it was seen in front of the user. */
  private readonly lastFrontAt = new Map<string, number>();
  /** Chats in front at the last look, so leaving is stamped when it is noticed. */
  private readonly frontChats = new Set<string>();
  /** Unlisted live sessions this window already asked discovery about (Q31, N5). */
  private readonly askedUnlisted = new Set<string>();
  /** Each unlisted live session's asks: retried while its transcript had nothing to import (new-chat pickup). */
  private readonly unlistedAsks = new Map<string, UnlistedAsk>();
  private disposed = false;
  /** The first pass after activation has run: a chat first judged after it joined the list later. */
  private primed = false;
  /**
   * Chats that joined the list after the first pass (a new chat, an import).
   * They start idle like the row drawn for them, so their first real status
   * is a transition: a new chat's first turn logs idle→working.
   */
  private readonly joinedLate = new Set<string>();

  /**
   * Latest turn state per chat with an open terminal. The tree reads this to
   * choose between the animated working mark and the green dot; notification
   * bookkeeping stays separate so a redraw never re-arms an alert.
   */
  private readonly turnStates = new Map<string, TurnState>();

  constructor(
    private readonly storage: StorageService,
    private readonly registry: HarnessRegistry,
    private readonly notifications: NotificationService,
    private readonly getWorktree: (id: string) => Worktree | undefined,
    /** Called when any chat's turn state or needs-you state changes (redraw row marks). */
    private readonly onTurnStateChanged: () => void,
    /**
     * Whether a chat is open in a terminal or a native-UI tab. UI sessions
     * write the same transcripts, so they need the same turn-state polling.
     */
    private readonly isChatOpen: (chat: ChatSession) => boolean,
    /** Whether the user is looking at this chat right now. */
    private readonly isChatVisible: (chatId: string) => boolean = () => false,
    private readonly options: AttentionOptions = {}
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    // Seed the baseline first so sessions that finished before the extension
    // started never produce a notification.
    void this.poll(true);
    this.timer = setInterval(() => void this.poll(), TICK_MS);
  }

  /**
   * Re-poll soon after any harness's live record changes (Claude: a `*.json`
   * event in `~/.claude/sessions`, 150 ms after the burst). Started after the
   * list's first render; disposing stops every watcher.
   */
  watchLive(): vscode.Disposable {
    const watchers = this.adapters().flatMap((adapter) => (adapter.watchLive ? [adapter.watchLive(() => void this.poll())] : []));
    return { dispose: () => watchers.forEach((watcher) => watcher.dispose()) };
  }

  /**
   * Whether this window still tracks the session as live with no row (it was
   * asked about and has neither ended nor been listed since). The unlisted-
   * live handler drops a session waiting for discovery once this is false.
   */
  isUnlistedLive(sessionId: string): boolean {
    for (const key of this.unlistedAsks.keys()) {
      if (key.endsWith(`\u0000${sessionId}`)) {
        return true;
      }
    }
    return false;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const ask of this.unlistedAsks.values()) {
      clearTimeout(ask.timer);
    }
    this.unlistedAsks.clear();
    this.statusEmitter.dispose();
    this.transitionEmitter.dispose();
  }

  /**
   * A chat's row status and when it entered it. A chat not judged yet is
   * judged now, without an event: the caller is already drawing it.
   */
  statusOf(chatId: string): ChatStatus {
    const known = this.rowStatus.get(chatId);
    if (known) {
      return known;
    }
    this.recomputeStatuses(this.storage.getChats(), true);
    return this.rowStatus.get(chatId) ?? IDLE;
  }

  /**
   * Turn states from the discovery scan, for the chats the tick does not
   * poll. Nothing runs behind them, so a mid-turn transcript counts as over.
   */
  noteSessions(sessions: readonly HarnessSession[]): void {
    const byKey = new Map<string, HarnessSession>();
    for (const session of sessions) {
      byKey.set(`${session.harness}\u0000${session.sessionId}`, session);
    }
    const chats = this.storage.getChats();
    for (const chat of chats) {
      if (!chat.harnessSessionId || this.polledChats.has(chat.id)) {
        continue;
      }
      const session = byKey.get(`${chat.harness}\u0000${chat.harnessSessionId}`);
      if (!session?.turnState) {
        continue;
      }
      this.rowState.set(chat.id, settled({ turnState: session.turnState, turnEndedAt: session.turnEndedAt ?? null }));
    }
    this.recomputeStatuses(chats);
  }

  /** Turn state reported by the harness, or undefined when it cannot tell. */
  getTurnState(chatId: string): TurnState | undefined {
    return this.turnStates.get(chatId);
  }

  /** Every listed chat that is waiting on the user, in front or not (Q30), oldest wait first. */
  sessionsNeedingYou(): string[] {
    return this.needsYouOrder().map((entry) => entry.chatId);
  }

  /** Every listed waiting chat with the time its wait began, oldest first (Q39's order). */
  needsYouOrder(): Array<{ chatId: string; since: number }> {
    return this.storage
      .getChats()
      .flatMap((chat) => {
        const status = this.rowStatus.get(chat.id);
        return status?.status === 'needs' ? [{ chatId: chat.id, since: status.statusSince }] : [];
      })
      .sort((a, b) => a.since - b.since || (a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0));
  }

  /** Every listed chat whose row has this status, with when it entered it (the jump list, Q38). Oldest first. */
  chatsWithStatus(wanted: 'needs' | 'working' | 'finished'): Array<{ chatId: string; since: number }> {
    return this.storage
      .getChats()
      .flatMap((chat) => {
        const status = this.rowStatus.get(chat.id);
        return status?.status === wanted ? [{ chatId: chat.id, since: status.statusSince }] : [];
      })
      .sort((a, b) => a.since - b.since || (a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0));
  }

  /** The raw reason a waiting chat is waiting, e.g. "permission prompt"; undefined when it is not waiting. */
  waitingForOf(chatId: string): string | undefined {
    const state = this.rowState.get(chatId);
    return isWaiting(state) ? state?.waitingFor || 'input needed' : undefined;
  }

  /** How many rows of the sidebar list need you, are working, and finished (Q38). Every window counts the same rows. */
  counts(): { needs: number; working: number; finished: number } {
    const counts = { needs: 0, working: 0, finished: 0 };
    for (const chat of this.storage.getChats()) {
      const status = this.rowStatus.get(chat.id)?.status;
      if (status === 'needs' || status === 'working' || status === 'finished') {
        counts[status]++;
      }
    }
    return counts;
  }

  /** Every listed session's row status, by native session ID (the state dump, GT). */
  statuses(): Record<string, SessionStatus> {
    const statuses: Record<string, SessionStatus> = {};
    for (const chat of this.storage.getChats()) {
      if (chat.harnessSessionId) {
        statuses[chat.harnessSessionId] = this.rowStatus.get(chat.id)?.status ?? 'idle';
      }
    }
    return statuses;
  }

  /** Whether the chat's row shows the needs-you mark: its agent is waiting on the user (Q30). */
  needsYou(chatId: string): boolean {
    return isWaiting(this.rowState.get(chatId));
  }

  /**
   * The user is looking at this chat (opened, selected or focused). A
   * finished turn no longer needs them, and its row turns idle: the chat's
   * seen time is stored, once per finished turn. A wait stays a wait until
   * the agent moves on.
   */
  markSeen(chatId: string): void {
    const chats = this.storage.getChats();
    const chat = chats.find((entry) => entry.id === chatId);
    if (chat) {
      this.markFinishedSeen(chat, Date.now());
    }
    this.recomputeStatuses(chats);
  }

  /** The chat's seen baseline, with this window's own unechoed write. */
  private seenAtOf(chat: ChatSession): number | undefined {
    const written = this.seenWritten.get(chat.id);
    if (written === undefined) {
      return chat.seenAt;
    }
    return chat.seenAt === undefined ? written : Math.max(chat.seenAt, written);
  }

  /** Store a seen time for a chat whose turn ended unseen; at most one write per finished turn. */
  private markFinishedSeen(chat: ChatSession, now: number): void {
    const state = this.rowState.get(chat.id);
    const endedAt = lastTurnEnd(state);
    const working = state?.liveStatus ? state.liveStatus !== 'idle' : state?.turnState === 'working';
    if (endedAt === undefined || working) {
      return;
    }
    const seenAt = this.seenAtOf(chat);
    if (seenAt === undefined || endedAt <= seenAt || this.seenTurn.get(chat.id) === endedAt) {
      return;
    }
    const at = Math.max(now, endedAt);
    this.seenTurn.set(chat.id, endedAt);
    this.seenWritten.set(chat.id, at);
    Promise.resolve(this.storage.markChatSeen(chat.id, at)).catch((error) =>
      console.error('[Pitwall] Could not store a chat as seen:', error)
    );
  }

  /**
   * Re-judge every chat's row status, announce the ones that changed, and
   * log each transition. A chat entering a status gets the best known time
   * for it: the wait's start, the turn's end, or now. The first pass after
   * activation (`priming`), and a row's first judgement, are no transitions.
   */
  private recomputeStatuses(chats: readonly ChatSession[], silent = false, priming = false): void {
    const now = Date.now();
    const changed: string[] = [];
    const transitions: StatusTransition[] = [];
    const present = new Set<string>();
    for (const chat of chats) {
      present.add(chat.id);
      const state = this.rowState.get(chat.id);
      const status = sessionStatus({ live: state, needsYou: this.needsYou(chat.id), seenAt: this.seenAtOf(chat) });
      const known = this.rowStatus.get(chat.id);
      if (known === undefined && this.primed && !priming) {
        this.joinedLate.add(chat.id);
      }
      const joinedLate = this.joinedLate.has(chat.id);
      // A chat that joined the list after the first pass was idle before it.
      const previous = known ?? (joinedLate ? IDLE : undefined);
      // A change from a placeholder (drawn before any state arrived) or in the
      // first pass is not news; a late-joining chat's placeholder is its idle start.
      const real = previous !== undefined && (this.judgedWithState.has(chat.id) || joinedLate) && !priming;
      if (state) {
        this.judgedWithState.add(chat.id);
      }
      this.noteTurnEnd(chat.id, status, state, real ? previous : undefined);
      if (known?.status === status) {
        continue;
      }
      this.rowStatus.set(chat.id, { status, statusSince: statusSince(status, state, chat, now, known === undefined) });
      changed.push(chat.id);
      if (real && previous.status !== status && chat.harnessSessionId) {
        transitions.push(this.transitionOf(chat.id, chat.harnessSessionId, previous.status, status, state, now));
      }
    }
    if (priming) {
      this.primed = true;
    }
    for (const chatId of [...this.rowStatus.keys()]) {
      if (!present.has(chatId)) {
        this.forget(chatId);
      }
    }
    if (changed.length > 0 && !silent) {
      this.statusEmitter.fire(changed);
    }
    for (const transition of transitions) {
      this.options.log?.(
        `[Pitwall] status ${transition.sessionId.slice(0, 8)} ${transition.from}→${transition.to} lag=${Math.max(0, now - transition.at)}`
      );
      this.transitionEmitter.fire(transition);
    }
  }

  /** Drop everything kept for a chat that left the list. */
  private forget(chatId: string): void {
    this.rowStatus.delete(chatId);
    this.rowState.delete(chatId);
    this.judgedWithState.delete(chatId);
    this.joinedLate.delete(chatId);
    this.seenWritten.delete(chatId);
    this.seenTurn.delete(chatId);
    this.pendingWaits.delete(chatId);
    this.pendingFinished.delete(chatId);
    this.judgedTurnEnd.delete(chatId);
    this.lastWaitingFor.delete(chatId);
    this.lastNeedsInputAt.delete(chatId);
    this.lastClearAt.delete(chatId);
    this.waitStartAt.delete(chatId);
  }

  /**
   * A finished row whose turn end is new may pop (Q30): after a working row
   * (busy → idle), after an idle row (a turn that ran between two looks), or
   * after a finished one whose turn end moved on. Never after a wait, which
   * already spoke, and never in the first pass or on a row's first judgement.
   */
  private noteTurnEnd(chatId: string, status: SessionStatus, state: RowState | undefined, previous: ChatStatus | undefined): void {
    if (status !== 'finished') {
      return;
    }
    const endedAt = lastTurnEnd(state);
    if (endedAt === undefined || this.judgedTurnEnd.get(chatId) === endedAt) {
      return;
    }
    this.judgedTurnEnd.set(chatId, endedAt);
    if (previous && previous.status !== 'needs') {
      this.pendingFinished.set(chatId, endedAt);
    }
  }

  private transitionOf(chatId: string, sessionId: string, from: SessionStatus, to: SessionStatus, state: RowState | undefined, now: number): StatusTransition {
    const observedAt = state?.observedAt ?? now;
    const stamp =
      to === 'needs'
        ? waitStamp(state)
        : to === 'finished'
          ? lastTurnEnd(state)
          : to === 'working' || from !== 'finished'
            ? state?.statusUpdatedAt
            : undefined; // finished → idle: you opened it, just now
    const waitingFor = to === 'needs' ? state?.waitingFor : undefined;
    return {
      chatId,
      sessionId,
      from,
      to,
      at: stamp !== undefined && stamp > 0 ? stamp : now,
      observedAt,
      ...(waitingFor ? { waitingFor } : {}),
    };
  }

  /**
   * Record which open chat is in front. Called on every tick and on tab,
   * terminal and window-focus events; it only records, it never polls. A
   * chat that was in front at the previous look is stamped too, so the time
   * it left counts as seen even when only the next look notices.
   */
  noteFront(): void {
    const now = Date.now();
    for (const chat of this.activeChats()) {
      const inFront = this.isChatVisible(chat.id);
      if (inFront || this.frontChats.has(chat.id)) {
        this.lastFrontAt.set(chat.id, now);
      }
      if (inFront) {
        this.frontChats.add(chat.id);
      } else {
        this.frontChats.delete(chat.id);
      }
    }
  }

  /**
   * Whether the chat's current wait began unseen: the chat was not in front
   * at any time between the wait's start and now. In words, the toast is
   * held back only if the user had the chat in front after the prompt
   * appeared. Judging at the sighting alone is wrong, because a sighting can
   * lag the wait by a cache cycle, a tick and a call (about 14 s).
   *
   * The start is max(transcript mtime at the first sighting, start of the
   * last call that found no wait). Claude writes the tool call just before a
   * prompt shows, so the mtime is the closest known time the prompt
   * appeared; the max means it can only narrow the window, never widen it.
   * Without a transcript time the window opens at the last no-wait call.
   *
   * Known drift, both small: a look within the transcript-write jitter
   * (between the tool-call write and the prompt) holds the toast back, and a
   * metadata write after the tool call makes the start later than the true
   * one, so at worst a toast still fires for a look in those few hundred ms.
   * The mark and the list are unaffected either way.
   */
  private beganUnseen(chatId: string): boolean {
    const front = this.lastFrontAt.get(chatId);
    if (front === undefined) {
      return true;
    }
    const start = this.waitStartAt.get(chatId);
    return start !== undefined && front < start;
  }

  /** Run one attention check now; one asked for during a check runs right after it. */
  async poll(prime = false): Promise<void> {
    if (this.ticking) {
      this.pollQueued = true;
      return;
    }
    this.ticking = true;
    try {
      await this.checkTurns(prime);
    } catch (error) {
      console.error('[Pitwall] Attention check failed:', error);
    } finally {
      this.ticking = false;
    }
    if (this.pollQueued) {
      this.pollQueued = false;
      await this.poll();
    }
  }

  private activeChats(): ChatSession[] {
    return this.storage.getChats().filter((chat) => this.isChatOpen(chat));
  }

  /** Every adapter: the registry's, or (a registry without `all`) those the chats name. */
  private adapters(chats: readonly ChatSession[] = this.storage.getChats()): HarnessAdapter[] {
    const registry = this.registry as Partial<HarnessRegistry>;
    if (typeof registry.all === 'function') {
      return [...registry.all()];
    }
    const adapters = new Map<string, HarnessAdapter>();
    for (const chat of chats) {
      try {
        adapters.set(chat.harness, this.registry.get(chat.harness));
      } catch {
        // Unknown harness.
      }
    }
    return [...adapters.values()];
  }

  private async checkTurns(prime: boolean): Promise<void> {
    const allChats = this.storage.getChats();
    const chats = allChats.filter((chat) => this.isChatOpen(chat));
    const activeIds = new Set(chats.map((chat) => chat.id));
    let turnStatesChanged = false;
    const rowMarksBefore = this.rowMarkKey();
    this.noteFront();
    for (const chatId of [...this.lastFrontAt.keys()]) {
      if (!activeIds.has(chatId)) {
        this.lastFrontAt.delete(chatId);
        this.frontChats.delete(chatId);
      }
    }
    // The tree's working mark covers open chats only.
    for (const chatId of [...this.turnStates.keys()]) {
      if (!activeIds.has(chatId)) {
        this.turnStates.delete(chatId);
        turnStatesChanged = true;
      }
    }

    // Closed chats whose session the harness's live record lists are polled
    // too, for their rows and pop-ups; every other closed chat waits for the scan.
    const liveIds = await this.liveSessionIds(allChats);
    // Discovery's own first pass covers whatever runs at activation.
    if (!prime) {
      await this.askAboutUnlisted(liveIds, allChats);
    }
    const closedLive = allChats.filter(
      (chat) => !activeIds.has(chat.id) && chat.harnessSessionId && liveIds.get(chat.harness)?.has(chat.harnessSessionId)
    );

    // Worktrees are independent, so poll them concurrently; one slow or failing
    // harness must not delay the rest.
    const groups = [...this.groupByWorktree([...chats, ...closedLive]).values()];
    const results = await Promise.all(
      groups.map(async (group) => ({
        group,
        states: await this.readLiveStates(group),
      }))
    );

    // The calls take time; look again before judging what they report.
    this.noteFront();

    const polled = new Set<string>();
    for (const { group, states } of results) {
      if (!states) {
        // A failed read keeps what the rows last showed.
        group.chats.forEach((chat) => polled.add(chat.id));
        continue;
      }
      for (const chat of group.chats) {
        const live = chat.harnessSessionId ? states.get(chat.harnessSessionId) : undefined;
        if (!live) {
          continue;
        }
        polled.add(chat.id);
        // A process that died mid-turn leaves a transcript that looks mid-turn: idle, never working or finished (Q30).
        const state: RowState = live.running === false ? { ...settled(live), ...(live.observedAt ? { observedAt: live.observedAt } : {}) } : live;
        this.rowState.set(chat.id, state);
        if (activeIds.has(chat.id) && this.turnStates.get(chat.id) !== state.turnState) {
          this.turnStates.set(chat.id, state.turnState);
          turnStatesChanged = true;
        }
        this.trackWait(chat, state, prime);
      }
    }

    // A chat this tick did not poll has nothing running behind it now.
    for (const [chatId, state] of this.rowState) {
      if (!polled.has(chatId) && (state.liveStatus || state.waitingFor || state.turnState === 'working')) {
        this.rowState.set(chatId, settled(state));
      }
    }
    for (const chatId of [...this.lastWaitingFor.keys()]) {
      if (!polled.has(chatId)) {
        this.endWait(chatId, undefined);
      }
    }
    this.polledChats = polled;

    // A finished turn in front of the user is seen as it lands (QA S4).
    const now = Date.now();
    for (const chat of chats) {
      if (this.isChatVisible(chat.id)) {
        this.markFinishedSeen(chat, now);
      }
    }
    this.recomputeStatuses(allChats, false, prime);
    await this.judgePopups(allChats, activeIds);

    if (turnStatesChanged || this.rowMarkKey() !== rowMarksBefore) {
      this.onTurnStateChanged();
    }
  }

  /**
   * Live sessions each harness's live record lists, by harness. Every
   * harness that has one is asked: the closed chats among them are polled,
   * and the unlisted ones ask discovery for a refresh (Q31).
   */
  private async liveSessionIds(chats: readonly ChatSession[]): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    await Promise.all(
      this.adapters(chats).map(async (adapter) => {
        if (!adapter.liveSessionIds) {
          return;
        }
        try {
          const ids = await adapter.liveSessionIds();
          if (ids) {
            result.set(adapter.id, ids);
          }
        } catch (error) {
          console.error(`[Pitwall] Could not list live ${adapter.id} sessions:`, error);
        }
      })
    );
    return result;
  }

  /**
   * Ask about each live session no listed chat holds (Q31), as soon as its
   * turn is under way. A session's live record appears when its process
   * starts, but its transcript, which the import reads, only with the first
   * prompt (S7), and Claude marks the turn busy before it writes that
   * prompt. A single ask could come too early and be spent, and a window
   * whose list stays hidden runs no ordinary scans, so the chat was never
   * listed (12f645db). So a session the answer says had nothing to import
   * yet is asked again after a backoff, at most UNLISTED_MAX_ASKS times a
   * turn, and its next turn starts the tries over; any other answer (or
   * none) settles it for this window, once per session as before (N5).
   */
  private async askAboutUnlisted(liveIds: ReadonlyMap<string, ReadonlySet<string>>, chats: readonly ChatSession[]): Promise<void> {
    if (!this.options.onUnlistedLive) {
      return;
    }
    const listed = new Set(chats.flatMap((chat) => chatNativeSessionIds(chat).map((id) => `${chat.harness}\u0000${id}`)));
    const adapters = new Map(this.adapters(chats).map((adapter) => [adapter.id as string, adapter]));
    const unlisted = new Set<string>();
    const fresh: Array<{ key: string; id: string; ask: UnlistedAsk }> = [];
    for (const [harness, ids] of liveIds) {
      const candidates = [...ids].filter((id) => {
        const key = `${harness}\u0000${id}`;
        if (listed.has(key)) {
          return false;
        }
        unlisted.add(key);
        return !this.unlistedAsks.get(key)?.settled && !(this.askedUnlisted.has(key) && !this.unlistedAsks.has(key));
      });
      if (candidates.length === 0) {
        continue;
      }
      const underWay = await this.underWay(adapters.get(harness));
      for (const id of candidates) {
        const key = `${harness}\u0000${id}`;
        const turnUnderWay = !underWay || underWay.has(id);
        let ask = this.unlistedAsks.get(key);
        if (!ask) {
          // Nothing to find before the first prompt writes the transcript.
          if (!turnUnderWay) {
            continue;
          }
          ask = { asks: 0, due: true, inFlight: false, settled: false, underWay: true };
          this.unlistedAsks.set(key, ask);
        } else if (turnUnderWay && !ask.underWay) {
          // A new turn of a session still unlisted: its tries start over
          // (once the ask in flight is answered, if one is).
          if (ask.inFlight) {
            ask.resetPending = true;
          } else {
            clearTimeout(ask.timer);
            ask.timer = undefined;
            ask.asks = 0;
            ask.due = true;
          }
        }
        ask.underWay = turnUnderWay;
        if (ask.due && !ask.inFlight && ask.asks < UNLISTED_MAX_ASKS) {
          ask.asks++;
          ask.due = false;
          ask.inFlight = true;
          this.askedUnlisted.add(key);
          fresh.push({ key, id, ask });
        }
      }
    }
    // A session that ended or got listed is done with.
    for (const [key, ask] of this.unlistedAsks) {
      if (!unlisted.has(key)) {
        clearTimeout(ask.timer);
        this.unlistedAsks.delete(key);
      }
    }
    if (fresh.length === 0) {
      return;
    }
    let answer: void | readonly string[] | PromiseLike<void | readonly string[]>;
    try {
      answer = this.options.onUnlistedLive(fresh.map((entry) => entry.id));
    } catch (error) {
      console.error('[Pitwall] Could not ask about unlisted sessions:', error);
      answer = undefined;
    }
    // The answer may take a read or a scan; the tick never waits for it.
    void Promise.resolve(answer).then(
      (retry) => this.noteUnlistedAnswer(fresh, new Set(retry ?? [])),
      (error) => {
        console.error('[Pitwall] Could not ask about unlisted sessions:', error);
        this.noteUnlistedAnswer(fresh, new Set());
      }
    );
  }

  /**
   * A session with nothing to import yet is asked about again after its
   * backoff, the timer polling at once, so a first turn is listed within
   * about a second of its transcript landing (target: 5 s). Every other
   * answer settles it for this window, as before (Q31, N5).
   */
  private noteUnlistedAnswer(asked: ReadonlyArray<{ key: string; id: string; ask: UnlistedAsk }>, retry: ReadonlySet<string>): void {
    for (const { key, id, ask } of asked) {
      ask.inFlight = false;
      if (this.disposed || this.unlistedAsks.get(key) !== ask) {
        continue;
      }
      if (!retry.has(id)) {
        ask.settled = true;
        continue;
      }
      if (ask.resetPending) {
        // A new turn started while this ask was out: start its tries over now.
        ask.resetPending = false;
        clearTimeout(ask.timer);
        ask.timer = undefined;
        ask.asks = 0;
        ask.due = true;
        void this.poll();
        continue;
      }
      if (ask.asks >= UNLISTED_MAX_ASKS) {
        continue; // spent until its next turn starts
      }
      clearTimeout(ask.timer);
      ask.timer = setTimeout(() => {
        ask.timer = undefined;
        ask.due = true;
        void this.poll();
      }, UNLISTED_RETRY_MS[Math.min(ask.asks, UNLISTED_RETRY_MS.length) - 1]);
      ask.timer.unref?.();
    }
  }

  /** The adapter's live sessions with a turn under way; undefined when it cannot tell. */
  private async underWay(adapter: HarnessAdapter | undefined): Promise<Set<string> | undefined> {
    if (!adapter?.liveSessionsUnderWay) {
      return undefined;
    }
    try {
      return await adapter.liveSessionsUnderWay();
    } catch (error) {
      console.error(`[Pitwall] Could not list ${adapter.id} sessions under way:`, error);
      return undefined;
    }
  }

  /** The needs-you rows, as a comparable key. */
  private rowMarkKey(): string {
    return [...this.rowState.keys()].filter((chatId) => this.needsYou(chatId)).sort().join(',');
  }

  /**
   * One shape for both sources: adapters with a cheap live-state query answer
   * directly, and discovery-based adapters convert their sessions here.
   */
  private async readLiveStates(
    group: WorktreeGroup
  ): Promise<Map<string, HarnessLiveState> | null> {
    try {
      if (group.adapter.getLiveStates) {
        const sessionIds = group.chats
          .map((chat) => chat.harnessSessionId)
          .filter((id): id is string => Boolean(id));
        return await group.adapter.getLiveStates(sessionIds, group.path);
      }

      const sessions = await group.adapter.listSessionsForWorktree(group.path);
      const states = new Map<string, HarnessLiveState>();
      for (const session of sessions) {
        if (!session.turnState) {
          continue;
        }
        states.set(session.sessionId, {
          turnState: session.turnState,
          turnEndedAt: session.turnEndedAt ?? null,
        });
      }
      return states;
    } catch (error) {
      console.error(
        `[Pitwall] Could not read ${group.adapter.id} sessions in ${group.path}:`,
        error
      );
      return null;
    }
  }

  /** The wait ended (or its chat is no longer polled): the next wait is new. */
  private endWait(chatId: string, observedAt: number | undefined): void {
    this.lastClearAt.set(chatId, observedAt ?? Date.now());
    this.waitStartAt.delete(chatId);
    this.lastWaitingFor.delete(chatId);
    this.pendingWaits.delete(chatId);
  }

  /**
   * Follow one polled chat's wait. A wait starts on the first tick that sees
   * its reason, so a changed reason is a new wait; a restamp of the same
   * reason is the same wait (Q32). R45: a wait may pop only if it cannot
   * predate activation: this service saw the chat without a wait since it
   * started, the chat was launched after it started, or the live record's
   * `statusUpdatedAt` dates the wait after it started. Otherwise it is
   * pre-existing (a reload): marked and listed, judged once, never shown. The
   * transcript time only narrows the window from that floor, it never makes
   * a wait eligible.
   */
  private trackWait(chat: ChatSession, state: RowState, prime: boolean): void {
    const waitingFor = state.waitingFor;
    if (!waitingFor) {
      this.endWait(chat.id, state.observedAt);
      return;
    }
    const previous = this.lastWaitingFor.get(chat.id);
    this.lastWaitingFor.set(chat.id, waitingFor);
    if (waitingFor === previous) {
      return;
    }
    const clear = prime ? undefined : this.lastClearAt.get(chat.id);
    const launched = !prime && chat.createdAt >= this.activatedAt ? chat.createdAt : undefined;
    // The live record dates the wait's start, and a wait's stamp does not move
    // while it lasts: a stamp after activation is a wait that began after it,
    // even for a chat first seen at needs (a placeholder older than the window
    // that linked to a brand-new session, S7).
    const stamped =
      !prime && state.liveStatus === 'waiting' && state.statusUpdatedAt !== undefined && state.statusUpdatedAt >= this.activatedAt
        ? state.statusUpdatedAt
        : undefined;
    const floor = clear ?? launched ?? stamped;
    if (floor === undefined) {
      this.waitStartAt.delete(chat.id);
      this.pendingWaits.set(chat.id, { preExisting: true });
    } else {
      this.waitStartAt.set(chat.id, Math.max(floor, state.writtenAt ?? -Infinity));
      this.pendingWaits.set(chat.id, { preExisting: false });
    }
  }

  /**
   * Judge every pending wait and finished turn (row 5.1's order lives in
   * `NotificationService.notify`). A result that uses it up (shown, locked,
   * in front, pre-existing) ends it; the rest keep it for the next tick.
   */
  private async judgePopups(chats: readonly ChatSession[], openIds: ReadonlySet<string>): Promise<void> {
    const byId = new Map(chats.map((chat) => [chat.id, chat]));
    const now = Date.now();
    const jobs: Promise<void>[] = [];
    for (const [chatId, wait] of this.pendingWaits) {
      const chat = byId.get(chatId);
      const state = this.rowState.get(chatId);
      const waitingFor = state?.waitingFor;
      if (!chat?.harnessSessionId || !waitingFor) {
        this.pendingWaits.delete(chatId);
        continue;
      }
      // A retry under the same reason waits out the cooldown since the chat's last toast.
      if (!shouldNotifyNeedsInput(wait.triedReason, waitingFor, this.lastNeedsInputAt.get(chatId), now)) {
        continue;
      }
      wait.triedReason = waitingFor;
      const inFront = (openIds.has(chatId) && this.isChatVisible(chatId)) || !this.beganUnseen(chatId);
      jobs.push(
        this.judge('needs-input', chat, {
          detail: waitingFor,
          at: waitStamp(state),
          preExisting: wait.preExisting,
          inFront,
        }).then((result) => {
          if (result === 'shown') {
            this.lastNeedsInputAt.set(chatId, now);
          }
          // A judgement that threw is not retried every tick.
          if ((!result || USES_UP.has(result)) && this.pendingWaits.get(chatId) === wait) {
            this.pendingWaits.delete(chatId);
          }
        })
      );
    }
    for (const [chatId, endedAt] of this.pendingFinished) {
      const chat = byId.get(chatId);
      if (!chat?.harnessSessionId || this.rowStatus.get(chatId)?.status !== 'finished') {
        this.pendingFinished.delete(chatId);
        continue;
      }
      jobs.push(
        this.judge('finished', chat, { at: endedAt, inFront: openIds.has(chatId) && this.isChatVisible(chatId) }).then((result) => {
          if ((!result || USES_UP.has(result)) && this.pendingFinished.get(chatId) === endedAt) {
            this.pendingFinished.delete(chatId);
          }
        })
      );
    }
    await Promise.all(jobs);
  }

  private async judge(
    kind: 'needs-input' | 'finished',
    chat: ChatSession,
    target: { detail?: string; at: number | undefined; preExisting?: boolean; inFront: boolean }
  ): Promise<NotifyResult | undefined> {
    try {
      return await this.notifications.notify(kind, {
        chat,
        context: this.contextFor(chat),
        repo: this.repoFor(chat),
        sessionId: chat.harnessSessionId!,
        ...target,
      });
    } catch (error) {
      console.error('[Pitwall] Pop-up failed:', error);
      return undefined;
    }
  }

  private groupByWorktree(chats: ChatSession[]): Map<string, WorktreeGroup> {
    const groups = new Map<string, WorktreeGroup>();

    for (const chat of chats) {
      if (!chat.harnessSessionId) {
        continue;
      }
      const worktree = this.getWorktree(chat.worktreeId);
      if (!worktree) {
        continue;
      }

      const key = `${chat.harness}\u0000${worktree.path}`;
      const existing = groups.get(key);
      if (existing) {
        existing.chats.push(chat);
        continue;
      }

      try {
        groups.set(key, {
          adapter: this.registry.get(chat.harness),
          path: worktree.path,
          chats: [chat],
        });
      } catch {
        // Unknown harness; nothing to poll.
      }
    }

    return groups;
  }

  /** The repo's sidebar name, the Windows pop-up's title (§3a). */
  private repoFor(chat: ChatSession): string | undefined {
    const worktree = this.getWorktree(chat.worktreeId);
    return worktree ? this.storage.getRepository(worktree.repoId)?.name : undefined;
  }

  private contextFor(chat: ChatSession): string {
    const worktree = this.getWorktree(chat.worktreeId);
    if (!worktree) {
      return '';
    }
    const repo = this.storage.getRepository(worktree.repoId);
    return [repo?.name, worktree.name].filter(Boolean).join(' · ');
  }
}
