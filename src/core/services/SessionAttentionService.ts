import { ChatSession, Worktree } from '../types';
import {
  HarnessAdapter,
  HarnessLiveState,
  TurnState,
} from '../harness/types';
import { HarnessRegistry } from '../harness/HarnessRegistry';
import { NotificationService } from './NotificationService';
import { StorageService } from './StorageService';

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
 * Harness behavior stays behind the adapter. Harnesses with a cheap live-state
 * query expose `getLiveStates`; the rest fall back to discovery.
 */
export class SessionAttentionService {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

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
    private readonly isChatVisible: (chatId: string) => boolean = () => false
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
   * The user is looking at this chat. A finished turn no longer needs them;
   * a wait is listed again on the next tick the chat is not in front.
   */
  markSeen(chatId: string): void {
    if (this.needsYouSince.delete(chatId)) {
      this.onTurnStateChanged();
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
    const chats = this.activeChats();
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

    // Worktrees are independent, so poll them concurrently; one slow or failing
    // harness must not delay the rest.
    const groups = [...this.groupByWorktree(chats).values()];
    const results = await Promise.all(
      groups.map(async (group) => ({
        group,
        states: await this.readLiveStates(group),
      }))
    );

    // The calls take time; look again before judging what they report.
    this.noteFront();

    for (const { group, states } of results) {
      if (!states) {
        continue;
      }

      for (const chat of group.chats) {
        const live = chat.harnessSessionId
          ? states.get(chat.harnessSessionId)
          : undefined;
        if (!live) {
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

    if (turnStatesChanged || this.rowMarkKey() !== rowMarksBefore) {
      this.onTurnStateChanged();
    }
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
      this.toastableWaits.add(chat.id);
      const clear = this.lastClearAt.get(chat.id);
      const start = Math.max(clear ?? -Infinity, writtenAt ?? -Infinity);
      if (start === -Infinity) {
        this.waitStartAt.delete(chat.id);
      } else {
        this.waitStartAt.set(chat.id, start);
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
