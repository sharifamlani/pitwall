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

export interface SessionStatusInput {
  /** The latest known live or turn state; undefined when nothing is known. */
  live?: Pick<HarnessLiveState, 'turnState' | 'turnEndedAt' | 'liveStatus' | 'waitingFor'>;
  /** The chat is on the needs-you list (open chats, R36). */
  needsYou: boolean;
  /** The chat's "seen" baseline (P16); a turn that ended after it is finished. */
  seenAt?: number;
}

/**
 * One chat's status:
 * - needs: listed as needing you, or the harness says it is waiting;
 * - working: the process is busy, or the transcript is mid-turn;
 * - finished: the turn ended after the chat was last seen;
 * - idle: anything else.
 *
 * Without a baseline a turn is never finished: storage gives every chat one
 * (P16), so a missing one means "not listed yet", not "never seen".
 */
export function sessionStatus({ live, needsYou, seenAt }: SessionStatusInput): SessionStatus {
  if (needsYou || live?.liveStatus === 'waiting' || live?.waitingFor) {
    return 'needs';
  }
  if (live?.liveStatus === 'busy' || live?.turnState === 'working') {
    return 'working';
  }
  if (
    live?.turnState === 'done' &&
    typeof live.turnEndedAt === 'number' &&
    seenAt !== undefined &&
    live.turnEndedAt > seenAt
  ) {
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
