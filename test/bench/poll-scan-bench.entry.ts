import { monitorEventLoopDelay, performance } from 'perf_hooks';
import { ClaudeSessionService } from '../../src/harnesses/claude/ClaudeSessionService';
import { ClaudeRepoDiscovery } from '../../src/harnesses/claude/ClaudeRepoDiscovery';
import { ClaudeSessionsFile } from '../../src/harnesses/claude/ClaudeSessionsFile';

export { ClaudeSessionService };

/** What the stand-in status polls saw while some work ran. */
export interface PollStats {
  /** Wall time of the work the polls ran beside. */
  workMs: number;
  polls: number;
  maxPollMs: number;
  p95PollMs: number;
  /** Polls that took 500 ms or more (the gate). */
  slowPolls: number;
  /** The longest the event loop was held at once meanwhile. */
  maxLoopDelayMs: number;
}

/**
 * One status poll's file work for a window with `sessionIds` open, as
 * `ClaudeHarness.getLiveStates` does it: the sessions folder read, then each
 * chat's transcript path and tail reading, all at once.
 */
export function makePoll(service: ClaudeSessionService, sessionsDir: string, sessionIds: readonly string[]): () => Promise<void> {
  const file = new ClaudeSessionsFile({ dir: () => sessionsDir, isAlive: () => true, pidDomain: async () => 'bench' });
  return async () => {
    await file.snapshot();
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        const transcript = service.getSessionFilePath(sessionId, 30_000);
        if (transcript) {
          await service.readTurnState(transcript);
        }
      })
    );
  };
}

/** Run `poll` every `everyMs` while `work` runs; how long each took. */
export async function pollsDuring(poll: () => Promise<void>, work: () => Promise<unknown>, everyMs = 250): Promise<PollStats> {
  // A settled window's poll has found its transcripts before: the first poll's path lookups are not the scan's doing.
  await poll();
  const times: number[] = [];
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let running = true;
  const poller = (async () => {
    while (running) {
      const begun = performance.now();
      await poll();
      times.push(performance.now() - begun);
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
  })();
  const start = performance.now();
  await work();
  const workMs = performance.now() - start;
  running = false;
  await poller;
  delay.disable();
  const sorted = [...times].sort((a, b) => a - b);
  return {
    workMs,
    polls: times.length,
    maxPollMs: sorted[sorted.length - 1] ?? 0,
    p95PollMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    slowPolls: times.filter((ms) => ms >= 500).length,
    maxLoopDelayMs: delay.max / 1e6,
  };
}

/** One import-scan listing: every repository at once, as `SessionImportService.listRepositorySessions` lists them. */
export function scan(service: ClaudeSessionService, repos: readonly string[]): Promise<number> {
  return Promise.all(repos.map((repo) => service.findSessionsForRepository(repo, [repo]))).then((lists) =>
    lists.reduce((sum, list) => sum + list.length, 0)
  );
}

/** One discovery pass over the profile, as `RepoDiscoveryService` runs it. */
export function discovery(projectsDir: string, service: ClaudeSessionService): () => Promise<number> {
  const discoverer = new ClaudeRepoDiscovery(projectsDir, service);
  return async () => (await discoverer.discoverRecentFolders(Date.now() - 14 * 24 * 60 * 60 * 1000)).length;
}

/** A fresh service (one window's caches), reading CLAUDE_CONFIG_DIR now. */
export function newService(): ClaudeSessionService {
  return new ClaudeSessionService();
}
