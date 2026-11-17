import { SessionStatus } from './sessionStatus';

/**
 * Inbox order (D21, row 3.4): position is urgency. A repo with a finished
 * session outranks one that is only working, because the finished one is
 * waiting for a look; inside a repo, running work sits above results.
 */
const REPO_RANK: Readonly<Record<SessionStatus, number>> = { needs: 0, finished: 1, working: 2, idle: 3 };
const SESSION_RANK: Readonly<Record<SessionStatus, number>> = { needs: 0, working: 1, finished: 2, idle: 3 };

export function rankRepo(status: SessionStatus): number {
  return REPO_RANK[status];
}

export function rankSession(status: SessionStatus): number {
  return SESSION_RANK[status];
}

export interface OrderedRow {
  id: string;
  status: SessionStatus;
  /** When the row entered its current status (P6), not its last activity. */
  statusSince: number;
  title: string;
}

/**
 * Rows by rank, then the newest `statusSince` first, then title. Returns a
 * new array. Ties on title (same name, same instant) keep the input order,
 * so the result is stable.
 */
export function orderRows<T extends OrderedRow>(rows: readonly T[], rank: (status: SessionStatus) => number): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        rank(a.row.status) - rank(b.row.status) ||
        b.row.statusSince - a.row.statusSince ||
        compareTitles(a.row.title, b.row.title) ||
        a.index - b.index
    )
    .map(({ row }) => row);
}

/** Case-insensitive first, then by code unit, so the order never depends on the input order. */
function compareTitles(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * A repo's place in the inbox: its most urgent session by repo rank, and the
 * newest time a session entered that status. A repo with no sessions is idle.
 */
export function repoStatus(
  sessions: readonly { status: SessionStatus; statusSince: number }[]
): { status: SessionStatus; statusSince: number } {
  let best: { status: SessionStatus; statusSince: number } = { status: 'idle', statusSince: 0 };
  let found = false;
  for (const session of sessions) {
    if (!found || rankRepo(session.status) < rankRepo(best.status)) {
      best = { status: session.status, statusSince: session.statusSince };
      found = true;
    } else if (session.status === best.status && session.statusSince > best.statusSince) {
      best = { status: best.status, statusSince: session.statusSince };
    }
  }
  return best;
}
