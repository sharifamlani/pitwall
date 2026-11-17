import { HarnessIconState, HarnessLiveState } from '../harness/types';

/** The four row statuses (D17, row 3.3). */
export type SessionStatus = 'needs' | 'working' | 'finished' | 'idle';

/** The words a row shows for each status (canvas copy). */
export const STATUS_WORDS: Readonly<Record<SessionStatus, string>> = {
  needs: 'needs you',
  working: 'working',
  finished: 'finished',
  idle: 'idle',
};

type StatusState = Pick<HarnessLiveState, 'turnState' | 'turnEndedAt' | 'liveStatus' | 'waitingFor' | 'statusUpdatedAt'>;

/**
 * When the session's last turn ended, if it has: the transcript's turn end,
 * or, when the live status says idle but the transcript tail looks mid-turn
 * (a denied prompt leaves an unanswered tool call, O1), the time the status
 * last changed.
 */
export function lastTurnEnd(live: StatusState | undefined): number | undefined {
  if (!live) {
    return undefined;
  }
  if (live.turnState === 'done') {
    return typeof live.turnEndedAt === 'number' ? live.turnEndedAt : undefined;
  }
  return live.liveStatus === 'idle' ? live.statusUpdatedAt : undefined;
}

export interface SessionStatusInput {
  /** The latest known live or turn state; undefined when nothing is known. */
  live?: StatusState;
  /** The chat is on the needs-you list (open chats, R36). */
  needsYou: boolean;
  /** The chat's "seen" baseline (P16); a turn that ended after it is finished. */
  seenAt?: number;
}

/**
 * One chat's status:
 * - needs: listed as needing you, or the harness says it is waiting;
 * - working: the process is busy, or, when no live status covers the
 *   session, the transcript is mid-turn;
 * - finished: the last turn ended after the chat was last seen;
 * - idle: anything else.
 *
 * A live status, when present, wins over the transcript for working or not
 * (O1): a denied prompt leaves the transcript looking mid-turn while the
 * process is idle.
 *
 * Without a baseline a turn is never finished: storage gives every chat one
 * (P16), so a missing one means "not listed yet", not "never seen".
 */
export function sessionStatus({ live, needsYou, seenAt }: SessionStatusInput): SessionStatus {
  if (needsYou || live?.liveStatus === 'waiting' || live?.waitingFor) {
    return 'needs';
  }
  const working = live?.liveStatus ? live.liveStatus === 'busy' : live?.turnState === 'working';
  if (working) {
    return 'working';
  }
  const endedAt = lastTurnEnd(live);
  if (endedAt !== undefined && seenAt !== undefined && endedAt > seenAt) {
    return 'finished';
  }
  return 'idle';
}

/** The status dot for a row. A chat its harness has not linked yet keeps the hollow "new" ring. */
export function statusIconState(status: SessionStatus, linked: boolean): HarnessIconState {
  if (status === 'idle' && !linked) {
    return 'new';
  }
  return status;
}
