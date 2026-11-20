/**
 * Status polls stalled 2.7–5.3 s in both windows at once, about 10 s after
 * Claude Code loaded or resumed a chat in one of them (0.6.0 RC live gate on
 * #78; uj-lab-a with 42 sessions and uj-lab-b, discovery on).
 *
 * Root cause, measured: a starting Claude process writes its
 * `~/.claude/sessions/<pid>.json` with no `status` field first, and adds the
 * status only once the chat is loaded. Resuming a 300 MB synthetic chat left
 * the record without a status for 2.8 s (scratch profile, Claude Code 2.1.x;
 * a fresh chat: 60 ms). Both windows' watchers wake on the new record within
 * 150 ms, the poll finds a live session whose status it does not know, and
 * falls back to `claude agents --json` for it. The poll awaited that child
 * process, whose time Pitwall does not control (0.5–1.2 s idle on the owner's
 * machine, a 5 s timeout: the 5.2 / 5.3 s stalls), so every other chat's
 * status and pop-up waited too.
 *
 * The repro is the real Claude harness and attention service over a
 * generated profile shaped like the walk: lab-a with 42 chats, lab-b with a
 * stopped chat whose tab is open, the owner's agents live. `claude agents`
 * is a stand-in that answers after CLI_MS.
 *
 * `PITWALL_STALL_RESUMED_MB` sets the resumed chat's transcript size
 * (default 64; the owner's largest live transcripts were 675, 274 and 262 MB).
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
import { makeStorage, stub, worktreeRecord } from '../../support';
import { claudeProfile, entry } from './claudeFixture';

beforeEach(() => stub.__reset());

const DOMAIN = 'test:pitwall-domain';
/** The gate: a settled status poll under 500 ms. */
const POLL_LIMIT_MS = 500;
/** How long the stand-in `claude agents --json` takes: the middle of the stalls the walk logged (2.7–5.3 s). */
const CLI_MS = 3_000;
const LAB_A_CHATS = 42;
const RESUMED_MB = Number(process.env.PITWALL_STALL_RESUMED_MB || 64);

const sessionId = (i: number) => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const RESUMED = 'bbbbbbbb-0000-4000-8000-0000000000bb';
/** One of the owner's agents, live in lab-a: it goes from busy to a permission prompt during the stall. */
const AGENT = sessionId(0);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A finished transcript of about `mb` MB, written as current Claude writes it. */
function writeLargeTranscript(file: string, cwd: string, id: string, mb: number): void {
  const pair =
    `${JSON.stringify({ cwd, sessionId: id, ...entry.user('step') })}\n` +
    `${JSON.stringify({ cwd, sessionId: id, ...entry.assistant('x'.repeat(4_000)) })}\n`;
  const fd = fs.openSync(file, 'w');
  try {
    const chunk = pair.repeat(Math.max(1, Math.floor((1024 * 1024) / pair.length)));
    for (let i = 0; i < mb; i++) {
      fs.writeSync(fd, chunk);
    }
    fs.writeSync(fd, `${JSON.stringify({ cwd, sessionId: id, ...entry.assistant('done') })}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

function walkLoad(t: Parameters<typeof claudeProfile>[0], agentsAnswer: object[]) {
  const profile = claudeProfile(t);
  const sessionsDir = path.join(profile.root, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const labA = profile.dir('uj-lab-a');
  const labB = profile.dir('uj-lab-b');
  const storage = makeStorage();
  const worktrees = new Map([
    ['wt-a', worktreeRecord({ id: 'wt-a', repoId: 'repo-a', path: labA })],
    ['wt-b', worktreeRecord({ id: 'wt-b', repoId: 'repo-b', path: labB })],
  ]);
  const open = new Set<string>();
  for (let i = 0; i < LAB_A_CHATS; i++) {
    profile.write(sessionId(i), labA, [entry.user(`task ${i}`), entry.assistant(`reply ${i}`)]);
    storage.createChat('wt-a', 'claude', `Chat ${i}`, { harnessSessionId: sessionId(i) });
  }
  // The stopped lab chat in window b, its tab open: the one the walk clicks.
  const resumedFile = profile.write(RESUMED, labB, [entry.user('earlier')]);
  writeLargeTranscript(resumedFile, labB, RESUMED, RESUMED_MB);
  const resumedChat = storage.createChat('wt-b', 'claude', 'Stopped lab chat', { harnessSessionId: RESUMED });
  open.add(resumedChat.id);
  const agentChat = storage.getChats().find((chat) => chat.harnessSessionId === AGENT)!;
  open.add(agentChat.id);

  const record = (pid: number, id: string, cwd: string, fields: object) =>
    fs.writeFileSync(
      path.join(sessionsDir, `${pid}.json`),
      JSON.stringify({ pid, sessionId: id, cwd, startedAt: Date.now(), pidDomain: DOMAIN, entrypoint: 'claude-vscode', ...fields })
    );
  // The owner's agents: live, with a status.
  for (let i = 0; i < 4; i++) {
    record(1000 + i, sessionId(i), labA, { status: i === 0 ? 'busy' : 'idle', statusUpdatedAt: Date.now() });
  }
  fs.appendFileSync(path.join(profile.projectDir(labA), `${AGENT}.jsonl`), `${JSON.stringify({ cwd: labA, sessionId: AGENT, ...entry.user('go on') })}\n`);

  let agentCalls = 0;
  const harness = new ClaudeHarness({
    sessionService: new ClaudeSessionService(),
    sessionsFile: new ClaudeSessionsFile({ dir: () => sessionsDir, isAlive: () => true, pidDomain: async () => DOMAIN }),
    agentsService: new ClaudeAgentsService({
      command: () => 'fake-claude',
      enabled: () => true,
      exec: async () => {
        agentCalls++;
        await sleep(CLI_MS);
        return JSON.stringify(agentsAnswer);
      },
    }),
  });
  const log: string[] = [];
  const service = new SessionAttentionService(
    storage,
    new HarnessRegistry([harness]),
    { notify: async () => 'shown' } as never,
    (id) => worktrees.get(id),
    () => undefined,
    (chat) => open.has(chat.id),
    () => false,
    { log: (line: string) => log.push(line) }
  );
  t.after(() => service.dispose());

  return {
    service,
    harness,
    log,
    agentCalls: () => agentCalls,
    /** Claude starts the resumed chat's process: the record lands first with no status (16 of its 19 fields). */
    startResumed: () => record(5555, RESUMED, labB, {}),
    /** The record caught mid-write. */
    tearResumed: () => fs.writeFileSync(path.join(sessionsDir, '5555.json'), `{"pid": 5555, "sessionId": "${RESUMED.slice(0, 8)}`),
    agentWaits: () => record(1000, AGENT, labA, { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: Date.now() }),
  };
}

const timed = async (run: () => Promise<void>) => {
  const started = performance.now();
  await run();
  return Math.round(performance.now() - started);
};

const statusLine = (log: string[], id: string, to: string) => log.find((line) => line.startsWith(`[Pitwall] status ${id.slice(0, 8)} `) && line.includes(`→${to} `));

test(`a chat whose process just started (record with no status yet) never holds the status poll for claude agents (gate < ${POLL_LIMIT_MS} ms)`, async (t) => {
  const load = walkLoad(t, [{ sessionId: RESUMED, status: 'idle' }]);
  await load.service.poll(true);
  await load.service.poll();

  load.startResumed();
  const pollMs = await timed(() => load.service.poll());
  console.log(`[stall] poll after a resumed chat's process started: ${pollMs} ms (claude agents takes ${CLI_MS} ms, resumed transcript ${RESUMED_MB} MB)`);
  assert.equal(load.agentCalls(), 1, 'the session with no status still asks claude agents');
  assert.ok(pollMs < POLL_LIMIT_MS, `the status poll took ${pollMs} ms waiting for claude agents (gate < ${POLL_LIMIT_MS} ms)`);
});

test(`a wait that begins while claude agents answers for a just-started chat shows within ${POLL_LIMIT_MS} ms`, async (t) => {
  const load = walkLoad(t, [{ sessionId: RESUMED, status: 'idle' }]);
  await load.service.poll(true);
  await load.service.poll();

  load.startResumed();
  void load.service.poll();
  await sleep(100);
  load.agentWaits();
  const started = Date.now();
  void load.service.poll();
  while (!statusLine(load.log, AGENT, 'needs') && Date.now() - started < CLI_MS * 3) {
    await sleep(10);
  }
  const shownMs = Date.now() - started;
  console.log(`[stall] another chat's wait during the claude agents call shown after ${shownMs} ms`);
  assert.ok(statusLine(load.log, AGENT, 'needs'), 'the wait was shown');
  assert.ok(shownMs < POLL_LIMIT_MS, `the wait showed ${shownMs} ms late, behind claude agents (gate < ${POLL_LIMIT_MS} ms)`);
});

test(`a torn record of a stopped open chat never holds the status poll for claude agents (gate < ${POLL_LIMIT_MS} ms)`, async (t) => {
  const load = walkLoad(t, [{ sessionId: RESUMED, status: 'idle' }]);
  await load.service.poll(true);
  await load.service.poll();

  load.tearResumed();
  const pollMs = await timed(() => load.service.poll());
  console.log(`[stall] poll with a torn record: ${pollMs} ms`);
  assert.equal(load.agentCalls(), 1, 'a session the torn read may hide still asks claude agents');
  assert.ok(pollMs < POLL_LIMIT_MS, `the status poll took ${pollMs} ms waiting for claude agents (gate < ${POLL_LIMIT_MS} ms)`);
});

test('the claude agents answer still reaches the row, re-polled the moment it lands (no wait for the 4 s tick)', async (t) => {
  // The resumed chat's process starts on a permission prompt Claude has not stamped into its record yet.
  const load = walkLoad(t, [{ sessionId: RESUMED, status: 'waiting', waitingFor: 'permission prompt' }]);
  const watching = load.service.watchLive();
  t.after(() => watching.dispose());
  await load.service.poll(true);
  await load.service.poll();

  const started = Date.now();
  load.startResumed();
  void load.service.poll();
  while (!statusLine(load.log, RESUMED, 'needs') && Date.now() - started < CLI_MS + 3_000) {
    await sleep(10);
  }
  const shownMs = Date.now() - started;
  console.log(`[stall] the claude agents answer reached the row ${shownMs} ms after the record appeared (the call takes ${CLI_MS} ms)`);
  assert.ok(statusLine(load.log, RESUMED, 'needs'), "claude agents' wait reached the row");
  assert.ok(shownMs < CLI_MS + POLL_LIMIT_MS, `the answer reached the row ${shownMs} ms after the record appeared`);
  assert.equal(load.agentCalls(), 1, 'one call, shared by the polls that needed it');
  const live = (await load.harness.getLiveStates([RESUMED])).get(RESUMED)!;
  assert.equal(live.liveStatus, 'waiting', 'the cached answer serves the next poll');
  assert.equal(live.waitingFor, 'permission prompt');
  assert.equal(load.agentCalls(), 1, 'still one call: the answer is cached');
});
