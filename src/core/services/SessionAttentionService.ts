import * as vscode from 'vscode';
import { ChatSession, Worktree } from '../types';
import {
  HarnessAdapter,
  HarnessLiveState,
  HarnessSession,
  TurnState,
} from '../harness/types';
import { HarnessRegistry } from '../harness/HarnessRegistry';
import { SessionStatus, lastTurnEnd, sessionStatus } from '../providers/sessionStatus';
import { NotificationService } from './NotificationService';
import { StorageService } from './StorageService';

/** A row's status and when it entered it (P6: the in-group sort key). */
export interface ChatStatus {
  status: SessionStatus;
  statusSince: number;
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

/**
 * Watches sessions with an open terminal or native-UI tab and notifies when
 * one stops working: a finished turn (every harness) or a session waiting on
 * the user.
 *
 * It also keeps every chat's row status (row 3.3). Two kinds of state, kept
 * apart (QA S6): toast state (the needs-you list, waits, cooldowns) covers
 * open chats only and is dropped when a chat closes (P5); row state covers
 * every chat and survives a close. The tick polls open chats plus the
 * sessions the harness's live record lists (a closed chat still running
 * somewhere); every other chat's turn state comes from the discovery scan
 * (`noteSessions`), so a tick never reads the transcripts of quiet chats
 * (QA S5, E18).
 *
 * Harness behavior stays behind the adapter. Harnesses with a cheap live-state
 * query expose `getLiveStates`; the rest fall back to discovery.
 */
export class SessionAttentionService {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  /** Latest known state per chat, for its row; kept when a chat closes. */
  private readonly rowState = new Map<string, RowState>();
  /** Each chat's row status and when it entered it. */
  private readonly rowStatus = new Map<string, ChatStatus>();
  /** Chats the last tick polled; the scan does not overwrite their fresher state. */
  private polledChats = new Set<string>();
  /**
   * Closed chats last seen waiting through the live record. When one is
   * reopened, its wait predates the reopen and never toasts (R45, QA S6).
   */
  private readonly closedWaits = new Set<string>();
  /** The seen time this service wrote per chat, ahead of the storage echo. */
  private readonly seenWritten = new Map<string, number>();
  /** The turn end each chat's last seen write was for: one write per finished turn (QA S4). */
  private readonly seenTurn = new Map<string, number>();
  private readonly statusEmitter = new vscode.EventEmitter<string[]>();
  /** Fires with the chats whose row status changed, and only those. */
  readonly onDidChangeStatus = this.statusEmitter.event;

  /**
   * Last turn-end timestamp we acted on, per chat; null while working. Presence
   * also means the chat has been seen, so a new one is seeded silently.
   */
  private readonly lastTurn = new Map<string, number | null>();
  /** When the last needs-input toast was actually shown, per chat. */
  private readonly lastNeedsInputAt = new Map<string, number>();
  /** Last waiting reason per chat, so a repeat is not treated as new. */
  private readonly lastWaitingFor = new Map<string, string>();
  /** When each chat's current wait was first seen; gone when the wait ends. */
  private readonly waitingSince = new Map<string, number>();
  /**
   * Chats whose current wait may still toast: it began after activation
   * while the user was looking elsewhere, has not toasted, and has not been
   * in front of the user since. A wait first seen in front of the user, or
   * already there at activation, is left to the row and the list.
   */
  private readonly toastableWaits = new Set<string>();
  /**
   * Per chat, when the last agents sample without a wait was taken (the
   * start of the call behind it). A wait first sighted later began somewhere
   * between this time and its sighting.
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

  /**
   * Latest turn state per chat with an open terminal. The tree reads this to
   * choose between the animated working mark and the green dot; notification
   * bookkeeping stays separate so a redraw never re-arms an alert.
   */
  private readonly turnStates = new Map<string, TurnState>();

  /**
   * Open chats that need the user, with the time each first did. A finished
   * turn is listed once, when it ends unseen, until the user visits the chat,
   * the agent works again, or the chat closes. A wait is re-judged on every
   * tick: listed whenever the chat is not in front, under the time the wait
   * was first seen, until the wait ends. The map is bounded by the open chats.
   */
  private readonly needsYouSince = new Map<string, number>();

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
    /**
     * Whether the chat's tab is the active tab, with or without window focus.
     * A turn that ends under it is seen at once, as selecting the tab counts
     * as a visit without focus (E6, P16). Defaults to being in front.
     */
    private readonly isChatTabActive: (chatId: string) => boolean = isChatVisible
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

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.statusEmitter.dispose();
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

  /** Open chats that need the user, longest-waiting first. */
  sessionsNeedingYou(): string[] {
    return [...this.needsYouSince].sort(([, a], [, b]) => a - b).map(([chatId]) => chatId);
  }

  /**
   * Whether the chat's row shows the needs-you mark: it is listed and its
   * agent is waiting on the user. A turn that merely finished unseen keeps
   * the finished mark.
   */
  needsYou(chatId: string): boolean {
    return this.needsYouSince.has(chatId) && this.waitingSince.has(chatId);
  }

  /**
   * The user is looking at this chat (opened, selected or focused). A
   * finished turn no longer needs them, and its row turns idle: the chat's
   * seen time is stored, once per finished turn. A wait is listed again on
   * the next tick the chat is not in front.
   */
  markSeen(chatId: string): void {
    const listed = this.needsYouSince.delete(chatId);
    const chats = this.storage.getChats();
    const chat = chats.find((entry) => entry.id === chatId);
    if (chat) {
      this.markFinishedSeen(chat, Date.now());
    }
    this.recomputeStatuses(chats);
    if (listed) {
      this.onTurnStateChanged();
    }
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
   * Re-judge every chat's row status and announce the ones that changed. A
   * chat entering a status gets the best known time for it: the wait's
   * start, the turn's end, or now.
   */
  private recomputeStatuses(chats: readonly ChatSession[], silent = false): void {
    const now = Date.now();
    const changed: string[] = [];
    const present = new Set<string>();
    for (const chat of chats) {
      present.add(chat.id);
      const state = this.rowState.get(chat.id);
      const status = sessionStatus({ live: state, needsYou: this.needsYou(chat.id), seenAt: this.seenAtOf(chat) });
      const previous = this.rowStatus.get(chat.id);
      if (previous?.status === status) {
        continue;
      }
      this.rowStatus.set(chat.id, { status, statusSince: statusSince(status, state, chat, now, previous === undefined) });
      changed.push(chat.id);
    }
    for (const chatId of [...this.rowStatus.keys()]) {
      if (!present.has(chatId)) {
        this.rowStatus.delete(chatId);
        this.rowState.delete(chatId);
        this.closedWaits.delete(chatId);
        this.seenWritten.delete(chatId);
        this.seenTurn.delete(chatId);
      }
    }
    if (changed.length > 0 && !silent) {
      this.statusEmitter.fire(changed);
    }
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

  private flagNeedsYou(chatId: string): void {
    if (!this.needsYouSince.has(chatId) && !this.isChatVisible(chatId)) {
      this.needsYouSince.set(chatId, Date.now());
    }
  }

  /** Run one attention check immediately. */
  async poll(prime = false): Promise<void> {
    if (this.ticking) {
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
  }

  private activeChats(): ChatSession[] {
    return this.storage.getChats().filter((chat) => this.isChatOpen(chat));
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

    // Forget chats whose terminal is gone; if one comes back it is seeded
    // again instead of notifying about history.
    for (const chatId of this.lastTurn.keys()) {
      if (!activeIds.has(chatId)) {
        this.lastTurn.delete(chatId);
        this.lastNeedsInputAt.delete(chatId);
        this.lastWaitingFor.delete(chatId);
        this.waitingSince.delete(chatId);
        this.toastableWaits.delete(chatId);
        this.lastClearAt.delete(chatId);
        this.waitStartAt.delete(chatId);
        this.needsYouSince.delete(chatId);
        if (this.turnStates.delete(chatId)) {
          turnStatesChanged = true;
        }
      }
    }

    // Closed chats whose session the harness's live record lists are polled
    // for their rows only; every other closed chat waits for the scan.
    const liveIds = await this.liveSessionIds(allChats, activeIds);
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
        const live = chat.harnessSessionId
          ? states.get(chat.harnessSessionId)
          : undefined;
        if (!live) {
          continue;
        }
        polled.add(chat.id);
        this.rowState.set(chat.id, live);
        if (!activeIds.has(chat.id)) {
          // Row state only: toasts stay limited to open chats (P5).
          if (live.waitingFor) {
            this.closedWaits.add(chat.id);
          } else {
            this.closedWaits.delete(chat.id);
          }
          continue;
        }

        const { turnState, turnEndedAt, waitingFor, observedAt, writtenAt } = live;

        if (this.turnStates.get(chat.id) !== turnState) {
          this.turnStates.set(chat.id, turnState);
          turnStatesChanged = true;
        }

        this.updateNeedsInput(chat, waitingFor, prime, observedAt, writtenAt);

        const done = turnState === 'done';
        const endedAt = done ? turnEndedAt ?? -1 : null;

        if (!this.lastTurn.has(chat.id)) {
          this.lastTurn.set(chat.id, endedAt);
          continue;
        }

        if (!done) {
          // A new turn started (or is still running); the next turn end is a
          // fresh notification.
          this.lastTurn.set(chat.id, null);
          if (!waitingFor) {
            this.needsYouSince.delete(chat.id);
          }
          continue;
        }

        if (this.lastTurn.get(chat.id) === endedAt) {
          continue;
        }
        this.lastTurn.set(chat.id, endedAt);
        if (!prime) {
          this.flagNeedsYou(chat.id);
        }

        // Needs-you takes precedence: when the turn ended at a prompt, the
        // user already gets the more useful notification.
        if (!prime && !waitingFor) {
          this.notifications.notify('finished', {
            chat,
            context: this.contextFor(chat),
          });
        }
      }
    }

    // A chat this tick did not poll has nothing running behind it now.
    for (const [chatId, state] of this.rowState) {
      if (!polled.has(chatId) && (state.liveStatus || state.waitingFor || state.turnState === 'working')) {
        this.rowState.set(chatId, settled(state));
        this.closedWaits.delete(chatId);
      }
    }
    this.polledChats = polled;

    // A finished turn under the active tab, or in front of the user, is seen
    // as it lands (QA S4, E6).
    const now = Date.now();
    for (const chat of chats) {
      if (this.isChatVisible(chat.id) || this.isChatTabActive(chat.id)) {
        this.markFinishedSeen(chat, now);
        if (!this.waitingSince.has(chat.id)) {
          // Seen, so it is no longer owed a look; a wait stays listed.
          this.needsYouSince.delete(chat.id);
        }
      }
    }
    this.recomputeStatuses(allChats);

    if (turnStatesChanged || this.rowMarkKey() !== rowMarksBefore) {
      this.onTurnStateChanged();
    }
  }

  /**
   * Native sessions each harness's live record lists, by harness. Asked only
   * for harnesses with a closed chat: open chats are polled anyway.
   */
  private async liveSessionIds(chats: readonly ChatSession[], openIds: ReadonlySet<string>): Promise<Map<string, Set<string>>> {
    const harnesses = new Set(
      chats.filter((chat) => chat.harnessSessionId && !openIds.has(chat.id)).map((chat) => chat.harness)
    );
    const result = new Map<string, Set<string>>();
    await Promise.all(
      [...harnesses].map(async (harness) => {
        let adapter: HarnessAdapter;
        try {
          adapter = this.registry.get(harness);
        } catch {
          return;
        }
        if (!adapter.liveSessionIds) {
          return;
        }
        try {
          const ids = await adapter.liveSessionIds();
          if (ids) {
            result.set(harness, ids);
          }
        } catch (error) {
          console.error(`[Pitwall] Could not list live ${harness} sessions:`, error);
        }
      })
    );
    return result;
  }

  /** The needs-you rows, as a comparable key. */
  private rowMarkKey(): string {
    return [...this.needsYouSince.keys()].filter((chatId) => this.needsYou(chatId)).sort().join(',');
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

  private updateNeedsInput(
    chat: ChatSession,
    waitingFor: string | undefined,
    prime: boolean,
    observedAt: number | undefined,
    writtenAt: number | undefined
  ): void {
    if (!waitingFor) {
      // The wait ended: it leaves the list, and the next wait is new.
      this.lastClearAt.set(chat.id, observedAt ?? Date.now());
      this.waitStartAt.delete(chat.id);
      this.lastWaitingFor.delete(chat.id);
      this.toastableWaits.delete(chat.id);
      this.closedWaits.delete(chat.id);
      if (this.waitingSince.delete(chat.id)) {
        this.needsYouSince.delete(chat.id);
      }
      return;
    }

    const now = Date.now();
    const visible = this.isChatVisible(chat.id);
    const previous = this.lastWaitingFor.get(chat.id);
    this.lastWaitingFor.set(chat.id, waitingFor);
    const since = this.waitingSince.get(chat.id) ?? now;
    this.waitingSince.set(chat.id, since);

    // Re-judged every tick, including the first pass after activation: a
    // waiting chat is listed whenever it is not in front.
    if (visible) {
      this.needsYouSince.delete(chat.id);
    } else if (!this.needsYouSince.has(chat.id)) {
      this.needsYouSince.set(chat.id, since);
    }

    // A wait starts on the first tick that sees its reason, so a changed
    // reason is a new wait. Each wait toasts at most once: only if it began
    // unseen after activation (judged over the whole window in which it could
    // have started), and never once it has toasted or been seen.
    if (waitingFor !== previous && !prime) {
      // R45: a wait may toast only if it cannot predate activation: this
      // session saw the chat without a wait since it started, or the chat was
      // launched after it started. Otherwise it is pre-existing (a reload):
      // marked and listed, never toasted. The transcript time only narrows
      // the window from that floor, it never makes a wait eligible.
      // A wait the live record already showed while the chat was closed
      // predates this open: pre-existing, like a wait at activation (QA S6).
      const seenWhileClosed = this.closedWaits.delete(chat.id);
      const clear = this.lastClearAt.get(chat.id);
      const launched = chat.createdAt >= this.activatedAt ? chat.createdAt : undefined;
      const floor = seenWhileClosed ? undefined : clear ?? launched;
      if (floor === undefined) {
        this.toastableWaits.delete(chat.id);
        this.waitStartAt.delete(chat.id);
      } else {
        this.toastableWaits.add(chat.id);
        this.waitStartAt.set(chat.id, Math.max(floor, writtenAt ?? -Infinity));
      }
    }
    if (prime || visible || !this.beganUnseen(chat.id)) {
      this.toastableWaits.delete(chat.id);
    }
    // A toast held back by the settings does not start the cooldown, so it
    // fires on the first tick the settings allow it.
    if (
      !this.toastableWaits.has(chat.id) ||
      !shouldNotifyNeedsInput(previous, waitingFor, this.lastNeedsInputAt.get(chat.id), now)
    ) {
      return;
    }
    const shown = this.notifications.notify('needs-input', {
      chat,
      context: this.contextFor(chat),
      detail: waitingFor,
    });
    if (shown) {
      this.lastNeedsInputAt.set(chat.id, now);
      this.toastableWaits.delete(chat.id);
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

  private contextFor(chat: ChatSession): string {
    const worktree = this.getWorktree(chat.worktreeId);
    if (!worktree) {
      return '';
    }
    const repo = this.storage.getRepository(worktree.repoId);
    return [repo?.name, worktree.name].filter(Boolean).join(' · ');
  }
}
