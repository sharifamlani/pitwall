import { monitorEventLoopDelay, performance } from 'perf_hooks';
import { ClaudeSessionService } from '../../src/harnesses/claude/ClaudeSessionService';
import { readTurnStateTail } from '../../src/harnesses/claude/ClaudeTurnState';

export interface ScanPass {
  /** Wall time of the pass. */
  ms: number;
  /** Main-thread CPU (user + system) during the pass, in ms. */
  cpuMs: number;
  /** The longest the event loop was held at once (a status poll waits at least this long). */
  maxLoopDelayMs: number;
  /** The 99th percentile of event-loop delay. */
  p99LoopDelayMs: number;
  /** The latest a 100 ms timer fired: how late a poll scheduled during the pass would start. */
  maxTimerLateMs: number;
  /** The slowest stand-in status poll during the pass: a stat and a tail read of a live transcript, every 250 ms. */
  maxPollMs: number;
  /** How many stand-in polls ran. */
  polls: number;
  sessions: number;
}

/**
 * One import-scan listing: every repository at once, as
 * `SessionImportService.listRepositorySessions` lists them, through the same
 * `ClaudeSessionService` the extension uses. `service` carries its caches
 * from pass to pass, as one window does.
 */
export async function scanPass(service: ClaudeSessionService, repos: readonly string[], liveTranscript: string): Promise<ScanPass> {
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let maxTimerLateMs = 0;
  let expected = performance.now() + 100;
  const timer = setInterval(() => {
    const now = performance.now();
    maxTimerLateMs = Math.max(maxTimerLateMs, now - expected);
    expected = now + 100;
  }, 100);
  // The status poll's file work for one chat: what waits behind the scan's reads in libuv's thread pool.
  let maxPollMs = 0;
  let polls = 0;
  let scanning = true;
  const poller = (async () => {
    while (scanning) {
      const begun = performance.now();
      await readTurnStateTail(liveTranscript);
      maxPollMs = Math.max(maxPollMs, performance.now() - begun);
      polls++;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  })();
  const cpu = process.cpuUsage();
  const start = performance.now();
  const listings = await Promise.all(repos.map((repo) => service.findSessionsForRepository(repo, [repo])));
  const ms = performance.now() - start;
  const used = process.cpuUsage(cpu);
  scanning = false;
  await poller;
  clearInterval(timer);
  delay.disable();
  return {
    ms,
    cpuMs: (used.user + used.system) / 1000,
    maxLoopDelayMs: delay.max / 1e6,
    p99LoopDelayMs: delay.percentile(99) / 1e6,
    maxTimerLateMs,
    maxPollMs,
    polls,
    sessions: listings.reduce((sum, listing) => sum + listing.length, 0),
  };
}

/** A fresh service (one window's first scan), reading CLAUDE_CONFIG_DIR now. */
export function newService(): ClaudeSessionService {
  return new ClaudeSessionService();
}
