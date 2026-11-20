/**
 * Status and pop-up lag with discovery's load (0.6.0 walk: 21 repos, ~158
 * sessions listed, 4.9–8.4 s lag with the view hidden against ≤ 1.3 s with
 * discovery off).
 *
 * Discovery lists the repos the owner's own agents run in, so the attention
 * tick polls their live sessions too. Those transcripts are hundreds of MB
 * and are written all the time. Current Claude transcripts carry no
 * `turn_duration` entry, and the tail reader used to widen its window to the
 * start of the file looking for one after a finished turn: every write meant
 * a whole-file read and parse, and the tick (so every chat's status and
 * pop-up) waited for it.
 *
 * This repro is the real Claude harness and attention service over a
 * generated profile: 21 repos, 160 listed sessions, 12 of them live, three
 * with large transcripts that keep being written while a test chat goes
 * working → needs you → working → finished. The lag is the one the
 * Operations log prints (`[Pitwall] status … lag=<ms>`). The owner's machine
 * had 18 live transcripts totalling 1.7 GB (675, 274, 262, 230, 108 MB, …).
 *
 * `PITWALL_LATENCY_BIG_MB` sets the large transcripts' sizes, comma-separated
 * (default `96,64,32`; the owner's load is `675,274,262,230,108`).
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeHarness } from '../../../../src/harnesses/claude/ClaudeHarness';
import { ClaudeSessionService } from '../../../../src/harnesses/claude/ClaudeSessionService';
import { ClaudeSessionsFile } from '../../../../src/harnesses/claude/ClaudeSessionsFile';
import { ClaudeAgentsService } from '../../../../src/harnesses/claude/ClaudeAgentsService';
import { HarnessRegistry } from '../../../../src/core/harness/HarnessRegistry';
import { SessionAttentionService } from '../../../../src/core/services/SessionAttentionService';
import { makeStorage, stub, watchEventLoopBlocks, worktreeRecord } from '../../support';
import { claudeProfile } from './claudeFixture';

beforeEach(() => stub.__reset());

const DOMAIN = 'test:pitwall-domain';
const REPOS = 21;
const SESSIONS = 160;
const LIVE = 12;
const BIG_MB = (process.env.PITWALL_LATENCY_BIG_MB || '96,64,32').split(',').map(Number);
/** The aim: discovery on matches discovery off (0.2–1.3 s in the walk). */
const LAG_LIMIT_MS = 1_500;

const sessionId = (i: number) => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const TEST_SESSION = 'aaaaaaaa-0000-4000-8000-0000000000aa';

const userEntry = (text: string) => ({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } });
const replyEntry = (text: string, stopReason: string | null = 'end_turn') => ({
  type: 'assistant',
  timestamp: new Date().toISOString(),
  message: { role: 'assistant', stop_reason: stopReason, content: [{ type: 'text', text }] },
});

/** A finished transcript of about `mb` MB, written the way current Claude writes it: no `turn_duration`. */
function writeLargeTranscript(file: string, cwd: string, id: string, mb: number): void {
  const pair =
    `${JSON.stringify({ cwd, sessionId: id, ...userEntry('step') })}\n` +
    `${JSON.stringify({ cwd, sessionId: id, ...replyEntry('x'.repeat(4_000)) })}\n`;
  const fd = fs.openSync(file, 'w');
  try {
    const chunk = pair.repeat(Math.max(1, Math.floor((1024 * 1024) / pair.length)));
    for (let i = 0; i < mb; i++) {
      fs.writeSync(fd, chunk);
    }
    fs.writeSync(fd, `${JSON.stringify({ cwd, sessionId: id, ...replyEntry('done') })}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

function discoveryLoad(t: Parameters<typeof claudeProfile>[0]) {
  const profile = claudeProfile(t);
  const sessionsDir = path.join(profile.root, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const repos = Array.from({ length: REPOS }, (_, i) => profile.dir(`repo-${i}`));
  const storage = makeStorage();
  const worktrees = new Map(repos.map((repo, i) => [`wt-${i}`, worktreeRecord({ id: `wt-${i}`, repoId: `repo-${i}`, path: repo })]));

  const transcripts = new Map<string, string>();
  for (let i = 0; i < SESSIONS; i++) {
    const repo = repos[i % REPOS];
    const id = sessionId(i);
    transcripts.set(id, profile.write(id, repo, [userEntry(`task ${i}`), replyEntry(`reply ${i}`)]));
    storage.createChat(`wt-${i % REPOS}`, 'claude', `Chat ${i}`, { harnessSessionId: id });
  }
  // The owner's agent sessions: large transcripts, live, written all the time.
  const bigIds = BIG_MB.map((_, i) => sessionId(i));
  BIG_MB.forEach((mb, i) => writeLargeTranscript(transcripts.get(bigIds[i])!, repos[i % REPOS], bigIds[i], mb));

  const liveFile = (pid: number, id: string, cwd: string, status: string, extra: object = {}) =>
    fs.writeFileSync(
      path.join(sessionsDir, `${pid}.json`),
      JSON.stringify({ pid, sessionId: id, cwd, pidDomain: DOMAIN, status, statusUpdatedAt: Date.now(), entrypoint: 'claude-vscode', ...extra })
    );
  for (let i = 0; i < LIVE; i++) {
    liveFile(1000 + i, sessionId(i), repos[i % REPOS], 'idle');
  }

  // The chat the walk drives, in a lab repo of its own.
  const lab = profile.dir('uj-lab-a');
  worktrees.set('wt-lab', worktreeRecord({ id: 'wt-lab', repoId: 'repo-lab', path: lab }));
  const testTranscript = profile.write(TEST_SESSION, lab, [userEntry('walk prompt')]);
  storage.createChat('wt-lab', 'claude', 'Walk chat', { harnessSessionId: TEST_SESSION });
  liveFile(4242, TEST_SESSION, lab, 'busy');

  const harness = new ClaudeHarness({
    sessionService: new ClaudeSessionService(),
    sessionsFile: new ClaudeSessionsFile({ dir: () => sessionsDir, isAlive: () => true, pidDomain: async () => DOMAIN }),
    agentsService: new ClaudeAgentsService({ command: () => 'fake-claude', enabled: () => false }),
  });
  const log: string[] = [];
  const popups: { kind: string; sessionId: string; at: number }[] = [];
  const service = new SessionAttentionService(
    storage,
    new HarnessRegistry([harness]),
    {
      notify: async (kind: string, target: { sessionId: string }) => {
        popups.push({ kind, sessionId: target.sessionId, at: Date.now() });
        return 'shown';
      },
    } as never,
    (id) => worktrees.get(id),
    () => undefined,
    () => false,
    () => false,
    { log: (line: string) => log.push(line) }
  );
  t.after(() => service.dispose());

  return {
    service,
    harness,
    repos,
    log,
    popups,
    /** Each large transcript gains a line, as a live agent's does many times a minute. */
    touchBig: () =>
      bigIds.forEach((id) =>
        fs.appendFileSync(transcripts.get(id)!, `${JSON.stringify({ type: 'queue-operation', sessionId: id, timestamp: new Date().toISOString() })}\n`)
      ),
    /** Another live session restamps its record, which wakes the watcher. */
    touchLive: (i: number) => liveFile(1000 + (i % LIVE), sessionId(i % LIVE), repos[i % LIVE % REPOS], 'idle'),
    setTest: (status: string, extra: object = {}) => liveFile(4242, TEST_SESSION, lab, status, extra),
    appendTest: (value: object) => fs.appendFileSync(testTranscript, `${JSON.stringify({ cwd: lab, sessionId: TEST_SESSION, ...value })}\n`),
  };
}

const lagOf = (log: string[], from: string, to: string): number | undefined => {
  const line = log.find((entry) => entry.startsWith(`[Pitwall] status ${TEST_SESSION.slice(0, 8)} ${from}→${to} `));
  const match = line?.match(/lag=(\d+)/);
  return match ? Number(match[1]) : undefined;
};

/**
 * The walk's steps on one load: working → needs you, back to work, then
 * finished, while the owner's agents keep writing. `beforeNeeds` starts other
 * work (the first import) just before the wait begins.
 */
async function walk(load: ReturnType<typeof discoveryLoad>, beforeNeeds: () => Promise<void> | void = () => undefined) {
  await load.service.poll(true);

  // The watcher re-polls on every live-record change; with the owner's agents
  // running, those come every few hundred ms, and the large transcripts grow
  // in between.
  let churning = true;
  let beat = 0;
  const churn = (async () => {
    while (churning) {
      load.touchBig();
      load.touchLive(beat++);
      void load.service.poll();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  })();
  const waitForLine = async (from: string, to: string, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs;
    while (lagOf(load.log, from, to) === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return lagOf(load.log, from, to);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 2_000));

  try {
    // Steady state: CPU the polling itself costs, as a share of one core.
    const cpuBefore = process.cpuUsage();
    const wallBefore = performance.now();
    await settle();
    const cpu = process.cpuUsage(cpuBefore);
    const cpuPercent = Math.round(((cpu.user + cpu.system) / 1000 / (performance.now() - wallBefore)) * 100);

    await beforeNeeds();
    // working → needs you: a permission prompt.
    load.setTest('waiting', { waitingFor: 'permission prompt' });
    void load.service.poll();
    const needsLag = await waitForLine('working', 'needs');
    const needsPopup = load.popups.find((popup) => popup.kind === 'needs-input' && popup.sessionId === TEST_SESSION);

    // Allowed: back to work, then the turn ends.
    load.appendTest(replyEntry('running the tool', 'tool_use'));
    load.setTest('busy');
    void load.service.poll();
    await waitForLine('needs', 'working');
    await settle();
    load.appendTest(replyEntry('all done'));
    load.setTest('idle');
    const finishedAt = Date.now();
    void load.service.poll();
    const finishedLag = await waitForLine('working', 'finished');
    const finishedPopup = load.popups.find((popup) => popup.kind === 'finished' && popup.sessionId === TEST_SESSION);
    return { cpuPercent, needsLag, needsPopup, finishedLag, finishedPopupLag: finishedPopup ? finishedPopup.at - finishedAt : undefined };
  } finally {
    churning = false;
    await churn;
  }
}

const LOAD = `${REPOS} repos, ${SESSIONS} sessions, ${LIVE} live, large live transcripts ${BIG_MB.join('/')} MB`;

test(`status and pop-ups stay within ${LAG_LIMIT_MS} ms, and polling under 50% of a core, at ${LOAD}`, async (t) => {
  const load = discoveryLoad(t);
  const result = await walk(load);
  console.log(
    `[latency] steady, ${LOAD}: poll CPU ${result.cpuPercent}% of a core, working→needs lag=${result.needsLag} ms, ` +
      `working→finished lag=${result.finishedLag} ms, finished pop-up ${result.finishedPopupLag} ms after the turn ended`
  );
  assert.ok(result.needsLag !== undefined && result.needsLag <= LAG_LIMIT_MS, `working→needs lag ${result.needsLag} ms > ${LAG_LIMIT_MS} ms`);
  assert.ok(result.finishedLag !== undefined && result.finishedLag <= LAG_LIMIT_MS, `working→finished lag ${result.finishedLag} ms > ${LAG_LIMIT_MS} ms`);
  assert.ok(result.needsPopup, 'the needs-you pop-up was judged');
  assert.ok(result.finishedPopupLag !== undefined && result.finishedPopupLag <= LAG_LIMIT_MS, 'the finished pop-up was judged in time');
  assert.ok(result.cpuPercent <= 50, `polling took ${result.cpuPercent}% of a core (gate ≤ 50%)`);
});

test(`a wait that begins during the first import of ${REPOS} discovered repos still shows within ${LAG_LIMIT_MS} ms`, async (t) => {
  const load = discoveryLoad(t);
  let importMs: number | undefined;
  let blocks: ReturnType<typeof watchEventLoopBlocks> | undefined;
  let maxBlockMs = 0;
  let imported: Promise<void> = Promise.resolve();
  const result = await walk(load, async () => {
    // The import's full scan: every discovered repo listed at once, nothing parsed yet.
    const started = performance.now();
    blocks = watchEventLoopBlocks();
    imported = Promise.all(load.repos.map((repo) => load.harness.listSessionsForRepository(repo, []))).then((lists) => {
      importMs = Math.round(performance.now() - started);
      maxBlockMs = Math.round(blocks!.stop().maxBlockMs);
      assert.equal(lists.flat().length, SESSIONS, 'every session listed');
    });
    // The wait begins while the import is under way.
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  await imported;
  console.log(
    `[latency] first import, ${LOAD}: import ${importMs} ms, longest event-loop block ${maxBlockMs} ms, ` +
      `working→needs lag=${result.needsLag} ms, working→finished lag=${result.finishedLag} ms`
  );
  assert.ok(result.needsLag !== undefined && result.needsLag <= LAG_LIMIT_MS, `working→needs lag ${result.needsLag} ms > ${LAG_LIMIT_MS} ms`);
  assert.ok(result.finishedLag !== undefined && result.finishedLag <= LAG_LIMIT_MS, `working→finished lag ${result.finishedLag} ms > ${LAG_LIMIT_MS} ms`);
  assert.ok(result.needsPopup, 'the needs-you pop-up was judged');
});
