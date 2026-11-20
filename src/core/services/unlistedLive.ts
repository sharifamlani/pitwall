import { LiveImportResult } from './SessionImportService';

/** What the answer to "a live session no row holds" uses (Q31, new-chat pickup). */
export interface UnlistedLiveDeps {
  /** The importer's and discovery's first passes have started (after the first render and the first claim, E16/I3). */
  scansStarted(): boolean;
  /** Keep the ask for the first passes, which run it once when they start. */
  deferUntilScans(): void;
  /** List live sessions, each read by itself (`SessionImportService.importLive`). */
  importLive(sessionIds: readonly string[]): Promise<LiveImportResult>;
  /** One discovery pass (a new repo). */
  wakeDiscovery(): void;
  /** One full import scan, list hidden or not (`SessionImportService.refresh`). */
  fullRefresh(): void;
  /** Re-poll the attention service, so a chat just listed is tracked at once. */
  pollAttention(): void;
  /** The session is still live and no row holds it (the attention service's view). */
  stillUnlisted(sessionId: string): boolean;
}

/** Sessions in unlisted folders kept for discovery's next added repo; a bound on a window's memory. */
const MAX_UNPLACED = 50;

/**
 * The attention service's `onUnlistedLive` answer, and its follow-up when
 * discovery adds repos.
 *
 * - Before the first passes start, the ask is kept for them and the sessions
 *   are answered "ask again".
 * - Otherwise each session's own transcript is imported (`importLive`). One
 *   with nothing to import yet is answered "ask again", so the attention
 *   service retries it with backoff.
 * - One in a folder no listed repo holds wakes discovery once per window
 *   and is not retried on a timer: a full transcript parse each time would
 *   block the extension host (QA on #73). It is imported again when
 *   discovery adds repos (`onReposAdded`), unless it ended or was listed
 *   some other way (a full scan) by then: those are dropped, so they hold
 *   no place under the bound and are never read again.
 * - An adapter that can't read one session gets the full import scan.
 */
export function createUnlistedLiveHandler(deps: UnlistedLiveDeps) {
  /** Sessions that already woke discovery: once each per window (Q31, N5). */
  const discoveryAsked = new Set<string>();
  /** Live sessions placed in no listed repo, waiting for discovery to add theirs. */
  const unplaced = new Set<string>();

  /** Drop the sessions that ended or got listed some other way. */
  const prune = (): void => {
    for (const id of unplaced) {
      if (!deps.stillUnlisted(id)) {
        unplaced.delete(id);
      }
    }
  };

  const importNow = async (sessionIds: readonly string[]): Promise<LiveImportResult> => {
    const result = await deps.importLive(sessionIds);
    for (const id of sessionIds) {
      unplaced.delete(id);
    }
    prune();
    for (const id of result.unplaced) {
      if (unplaced.size < MAX_UNPLACED) {
        unplaced.add(id);
      }
    }
    const settledHere = sessionIds.length - result.retry.length - result.unplaced.length - result.unsupported.length;
    if (settledHere > 0) {
      // Something was listed (or settled): track its turn now, not on the next tick.
      deps.pollAttention();
    }
    return result;
  };

  return {
    async ask(sessionIds: string[]): Promise<readonly string[]> {
      if (!deps.scansStarted()) {
        deps.deferUntilScans();
        return sessionIds;
      }
      const result = await importNow(sessionIds);
      const newRepos = result.unplaced.filter((id) => !discoveryAsked.has(id));
      newRepos.forEach((id) => discoveryAsked.add(id));
      if (result.unsupported.length > 0 || newRepos.length > 0) {
        deps.wakeDiscovery();
      }
      if (result.unsupported.length > 0) {
        deps.fullRefresh();
      }
      return result.retry;
    },

    /** Discovery added repos: the live sessions it may have placed are imported now. */
    async onReposAdded(): Promise<void> {
      prune();
      if (unplaced.size > 0) {
        await importNow([...unplaced]);
      }
    },
  };
}
