import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeSessionService } from '../../../../src/harnesses/claude/ClaudeSessionService';
import { ClaudeAgentsService } from '../../../../src/harnesses/claude/ClaudeAgentsService';
import { ClaudeHarness } from '../../../../src/harnesses/claude/ClaudeHarness';
import { ClaudeSessionsFile } from '../../../../src/harnesses/claude/ClaudeSessionsFile';
import { claudeProfile, entry } from './claudeFixture';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('a transcript is resumable only once it holds conversation', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const service = new ClaudeSessionService();

  const file = profile.write(SESSION_ID, repo, []);
  assert.equal(await service.isSessionResumable(SESSION_ID), false, 'empty');
  fs.writeFileSync(file, `${JSON.stringify(entry.summary('Only a title'))}\n`);
  assert.equal(await service.isSessionResumable(SESSION_ID), false, 'title only');
  profile.write(SESSION_ID, repo, [entry.user('Please fix the tests')]);
  assert.equal(await service.isSessionResumable(SESSION_ID), true);
});

test('a session is named by its harness title, then a summary, then its first prompt', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const service = new ClaudeSessionService();
  const summary = async () => (await service.getSessionById(SESSION_ID))?.summary;

  profile.write(SESSION_ID, repo, [entry.user('Please fix the tests'), entry.assistant('done')]);
  assert.equal(await summary(), 'Please fix the tests');
  profile.write(SESSION_ID, repo, [entry.user('Please fix the tests'), entry.summary('A summary')]);
  assert.equal(await summary(), 'A summary');
  profile.write(SESSION_ID, repo, [entry.user('Please fix the tests'), entry.aiTitle('Test suite audit'), entry.summary('An older summary')]);
  assert.equal(await summary(), 'Test suite audit');
});

test('names and previews come only from prompts the user typed', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  profile.write(SESSION_ID, repo, [
    entry.injected('Base directory for this skill: /tmp/skills'),
    entry.user('Fix the flaky login test'),
    entry.compactSummary('This session is being continued from a previous conversation.'),
  ]);
  const harness = new ClaudeHarness();

  const [listed] = await harness.listSessionsForWorktree(repo);
  assert.equal(listed.summary, 'Fix the flaky login test');
  assert.deepEqual((await harness.getPreview(SESSION_ID)).map((m) => m.text), ['Fix the flaky login test']);
});

test('metadata stays lean: activity, the last exchange, and capped previews only', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  profile.write(SESSION_ID, repo, [
    entry.user('First', '2026-01-01T00:00:00.000Z'),
    entry.assistant('One', 'end_turn', '2026-01-01T00:00:01.000Z'),
    entry.user('Second', '2026-01-01T00:00:02.000Z'),
    entry.assistant('Two', 'end_turn', '2026-01-01T00:00:03.000Z'),
  ]);
  const harness = new ClaudeHarness();

  const meta = await harness.getSessionMetadata(SESSION_ID);
  assert.equal(meta?.lastActivity, Date.parse('2026-01-01T00:00:02.000Z'));
  assert.equal(meta?.lastReply?.text, 'Two');
  assert.deepEqual([meta?.messageCount, meta?.model], [undefined, undefined]);
  assert.deepEqual((await harness.getPreview(SESSION_ID, 1)).map((m) => m.text), ['Second']);

  const [listed] = await harness.listSessionsForWorktree(repo);
  assert.deepEqual([listed.gitBranch, listed.messageCount], [null, 0]);
});

test('launch commands choose, resume, and fork session IDs with quoted values', () => {
  const harness = new ClaudeHarness();
  const launch = (options: object) => harness.buildLaunchCommand({ worktreePath: '/repo', ...options });

  assert.equal(launch({}), 'claude');
  assert.equal(launch({ newSessionId: 'id with space' }), "claude --session-id 'id with space'");
  assert.equal(launch({ sessionId: SESSION_ID }), `claude --resume ${SESSION_ID}`);
  assert.equal(
    launch({ forkFromSessionId: SESSION_ID, newSessionId: 'fork-id' }),
    `claude --resume ${SESSION_ID} --fork-session --session-id fork-id`
  );
  assert.throws(() => launch({ forkFromSessionId: SESSION_ID }), 'a fork without a chosen ID fails visibly');
});

test('forks choose a fresh ID, and a worktree fork validates its source first', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  profile.write(SESSION_ID, repo, [entry.user('Please fix the tests')]);
  const harness = new ClaudeHarness();

  const same = await harness.forkSession(SESSION_ID);
  const other = await harness.prepareForkToNewWorktree(SESSION_ID, repo, profile.dir('fork-target'));
  assert.ok(same.kind === 'terminal' && UUID.test(same.pendingSessionId));
  assert.ok(other.kind === 'terminal' && UUID.test(other.pendingSessionId));
  assert.notEqual(same.pendingSessionId, other.pendingSessionId);

  await assert.rejects(
    harness.prepareForkToNewWorktree('00000000-0000-0000-0000-000000000000', repo, profile.dir('missing')),
    /no longer exists/
  );
});

test('a transcript written within the same millisecond as the agents call keeps its waiting reason', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  profile.write(SESSION_ID, repo, [entry.user('Go'), entry.assistant('Done', 'end_turn', '2026-01-01T00:00:03.000Z')]);
  const callStart = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => callStart);
  const sessionService = new ClaudeSessionService();
  // mtimeMs has sub-millisecond precision: the write lands fractionally after the call's integer start.
  sessionService.transcriptWrittenAt = async () => callStart + 0.5;
  const harness = new ClaudeHarness({
    sessionService,
    agentsService: new ClaudeAgentsService({
      command: () => 'fake-claude',
      enabled: () => true,
      exec: async () => JSON.stringify([{ sessionId: SESSION_ID, status: 'waiting', waitingFor: 'permission prompt' }]),
    }),
  });
  const live = await harness.getLiveStates([SESSION_ID]);
  assert.equal(live.get(SESSION_ID)?.waitingFor, 'permission prompt');
  assert.equal(live.get(SESSION_ID)?.writtenAt, callStart);
});

test('live states come from the transcript tail plus the waiting reason from claude agents', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const transcript = profile.write(SESSION_ID, repo, [entry.user('Go'), entry.assistant('Done', 'end_turn', '2026-01-01T00:00:03.000Z')]);
  let agentCalls = 0;
  const harness = new ClaudeHarness({
    agentsService: new ClaudeAgentsService({
      command: () => 'fake-claude',
      enabled: () => true,
      exec: async () => {
        agentCalls++;
        return JSON.stringify([{ sessionId: SESSION_ID, status: 'waiting', waitingFor: 'permission prompt' }]);
      },
    }),
  });

  // Pin the transcript time in the past so the test never races the clock.
  const past = new Date(Date.now() - 5000);
  fs.utimesSync(transcript, past, past);
  const before = Date.now();
  const live = await harness.getLiveStates([SESSION_ID, 'missing-id']);
  const { observedAt, writtenAt, ...state } = live.get(SESSION_ID)!;
  assert.deepEqual(state, {
    turnState: 'done',
    turnEndedAt: Date.parse('2026-01-01T00:00:03.000Z'),
    waitingFor: 'permission prompt',
    liveStatus: 'waiting',
  }, 'a transcript written before the agents call keeps its waiting reason');
  assert.ok(observedAt! >= before && observedAt! <= Date.now(), 'stamped with the agents call start');
  assert.ok(writtenAt! > 0 && writtenAt! <= observedAt!, 'the transcript time comes with the waiting reason');
  assert.ok(!live.has('missing-id'), 'a missing transcript is omitted');

  assert.equal((await harness.getLiveStates([])).size, 0);
  assert.equal(agentCalls, 1, 'no session IDs means no agents call');
});

test('a relocated entry moves the session to its new cwd', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const moved = profile.dir('moved');
  profile.write(SESSION_ID, repo, [entry.user('Go'), { type: 'relocated', relocatedCwd: moved }]);
  assert.equal((await new ClaudeSessionService().getSessionById(SESSION_ID))?.cwd, moved);
});

// ---------------------------------------------------------------------------
// Live status from ~/.claude/sessions (ADR 0018), with `claude agents` as the
// per-session fallback.
// ---------------------------------------------------------------------------

const DOMAIN = 'test:pitwall-domain';

function writeSessionFile(dir: string, record: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${record.pid}.json`), JSON.stringify({ cwd: '/work/demo', pidDomain: DOMAIN, ...record }));
}

/** A harness over a synthetic transcript, a sessions folder, and a fake `claude agents` that counts its calls. */
function liveHarness(
  t: Parameters<typeof claudeProfile>[0],
  options: { agents?: object[]; transcriptWrittenAt?: number | null; sessionIds?: string[] } = {}
) {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  for (const sessionId of options.sessionIds ?? [SESSION_ID]) {
    profile.write(sessionId, repo, [entry.user('Go'), entry.assistant('Done', 'end_turn', '2026-01-01T00:00:03.000Z')]);
  }
  const sessionsDir = path.join(profile.root, 'sessions');
  const sessionService = new ClaudeSessionService();
  const stats: string[] = [];
  if (options.transcriptWrittenAt !== undefined) {
    sessionService.transcriptWrittenAt = async (filePath: string) => {
      stats.push(filePath);
      return options.transcriptWrittenAt ?? null;
    };
  }
  let agentCalls = 0;
  let clockOffset = 0;
  const harness = new ClaudeHarness({
    sessionService,
    sessionsFile: new ClaudeSessionsFile({ dir: () => sessionsDir, isAlive: () => true, pidDomain: async () => DOMAIN }),
    agentsService: new ClaudeAgentsService({
      command: () => 'fake-claude',
      enabled: () => true,
      now: () => Date.now() + clockOffset,
      exec: async () => {
        agentCalls++;
        return JSON.stringify(options.agents ?? []);
      },
    }),
  });
  return {
    harness,
    sessionsDir,
    stats,
    agentCalls: () => agentCalls,
    /** Ages the agents cache past its 10 s TTL, so the next tick that needs the CLI calls it. */
    expireAgentsCache: () => {
      clockOffset += 20_000;
    },
  };
}

test('getLiveStates takes waitingFor from the sessions file and falls back to claude agents when it is unavailable', async (t) => {
  const { harness, sessionsDir, agentCalls, expireAgentsCache } = liveHarness(t, {
    agents: [{ sessionId: SESSION_ID, status: 'waiting', waitingFor: 'agents reason' }],
    transcriptWrittenAt: 0,
  });
  writeSessionFile(sessionsDir, { pid: 4242, sessionId: SESSION_ID, status: 'waiting', waitingFor: 'file reason', statusUpdatedAt: 1_000 });

  const before = Date.now();
  const fromFile = (await harness.getLiveStates([SESSION_ID])).get(SESSION_ID)!;
  assert.equal(fromFile.waitingFor, 'file reason');
  assert.equal(fromFile.liveStatus, 'waiting');
  assert.ok(fromFile.observedAt! >= before && fromFile.observedAt! <= Date.now(), 'observedAt is the read time');
  assert.equal(agentCalls(), 0, 'no CLI call while the file answers');

  expireAgentsCache();
  writeSessionFile(sessionsDir, { pid: 4242, sessionId: SESSION_ID, status: 'busy', statusUpdatedAt: 2_000 });
  const busy = (await harness.getLiveStates([SESSION_ID])).get(SESSION_ID)!;
  assert.equal(busy.waitingFor, undefined, 'the file is current truth: busy clears the wait');
  assert.equal(busy.liveStatus, 'busy');
  assert.equal(agentCalls(), 0);

  expireAgentsCache();
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  const fallback = (await harness.getLiveStates([SESSION_ID])).get(SESSION_ID)!;
  assert.equal(fallback.waitingFor, 'agents reason');
  assert.equal(fallback.liveStatus, 'waiting');
  assert.equal(agentCalls(), 1, 'a missing folder falls back to claude agents');
});

test('a session absent from an available sessions folder is not live and costs no CLI call', async (t) => {
  const OTHER = '99999999-2222-3333-4444-555555555555';
  const { harness, sessionsDir, agentCalls, expireAgentsCache } = liveHarness(t, {
    sessionIds: [SESSION_ID, OTHER],
    agents: [{ sessionId: OTHER, status: 'waiting' }],
  });
  writeSessionFile(sessionsDir, { pid: 4242, sessionId: SESSION_ID, status: 'idle', statusUpdatedAt: 1_000 });
  for (const tick of [1, 2]) {
    const live = await harness.getLiveStates([SESSION_ID, OTHER]);
    assert.equal(live.get(SESSION_ID)?.liveStatus, 'idle');
    assert.ok(live.has(OTHER), 'its transcript state is still reported');
    assert.equal(live.get(OTHER)?.waitingFor, undefined, `tick ${tick}: the agents answer is not used`);
    assert.equal(live.get(OTHER)?.liveStatus, undefined);
    expireAgentsCache();
  }
  assert.equal(agentCalls(), 0);
});

test('a transcript write after statusUpdatedAt while the file still says waiting keeps the wait', async (t) => {
  const statusUpdatedAt = Date.now() - 5_000;
  // The transcript was written after the status changed, and even after this read starts.
  const { harness, sessionsDir, stats } = liveHarness(t, { transcriptWrittenAt: Date.now() + 60_000 });
  writeSessionFile(sessionsDir, { pid: 4242, sessionId: SESSION_ID, status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt });
  const live = (await harness.getLiveStates([SESSION_ID])).get(SESSION_ID)!;
  assert.equal(live.waitingFor, 'permission prompt');
  assert.equal(live.writtenAt, statusUpdatedAt);
  assert.deepEqual(stats, [], 'a file sample needs no transcript stat');
});

test('writtenAt of a waiting session is its statusUpdatedAt', async (t) => {
  const { harness, sessionsDir } = liveHarness(t, { transcriptWrittenAt: 1 });
  writeSessionFile(sessionsDir, { pid: 4242, sessionId: SESSION_ID, status: 'waiting', statusUpdatedAt: 1_700_000_000_321 });
  const live = (await harness.getLiveStates([SESSION_ID])).get(SESSION_ID)!;
  assert.equal(live.writtenAt, 1_700_000_000_321);
  assert.equal(live.waitingFor, 'input needed');

  writeSessionFile(sessionsDir, { pid: 4242, sessionId: SESSION_ID, status: 'busy', statusUpdatedAt: 1_700_000_000_999 });
  assert.equal((await harness.getLiveStates([SESSION_ID])).get(SESSION_ID)!.writtenAt, undefined, 'only a wait has a start');
});

test('fallback samples keep the R40 drop; same-ms counts as before', async (t) => {
  const callStart = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => callStart);
  const agents = [{ sessionId: SESSION_ID, status: 'waiting', waitingFor: 'permission prompt' }];

  // The folder is available, but this session's file has a status Pitwall does not know.
  const later = liveHarness(t, { agents, transcriptWrittenAt: callStart + 1 });
  writeSessionFile(later.sessionsDir, { pid: 4242, sessionId: SESSION_ID, status: 'compacting', statusUpdatedAt: 1 });
  writeSessionFile(later.sessionsDir, { pid: 4343, sessionId: 'someone-else', status: 'busy', statusUpdatedAt: 1 });
  const dropped = (await later.harness.getLiveStates([SESSION_ID])).get(SESSION_ID)!;
  assert.equal(later.agentCalls(), 1, 'an unknown status falls back to claude agents for that session');
  assert.equal(dropped.waitingFor, undefined, 'a transcript written after the agents call drops the cached wait');
  assert.equal(dropped.liveStatus, undefined);

  const sameMs = liveHarness(t, { agents, transcriptWrittenAt: callStart + 0.5 });
  writeSessionFile(sameMs.sessionsDir, { pid: 4242, sessionId: SESSION_ID, status: 'compacting', statusUpdatedAt: 1 });
  writeSessionFile(sameMs.sessionsDir, { pid: 4343, sessionId: 'someone-else', status: 'busy', statusUpdatedAt: 1 });
  const kept = (await sameMs.harness.getLiveStates([SESSION_ID])).get(SESSION_ID)!;
  assert.equal(kept.waitingFor, 'permission prompt');
  assert.equal(kept.writtenAt, callStart);
  assert.equal(kept.observedAt, callStart, 'a fallback sample keeps the agents call start');
});

test('a torn sessions file sends sessions it does not list to claude agents', async (t) => {
  const { harness, sessionsDir, agentCalls } = liveHarness(t, {
    agents: [{ sessionId: SESSION_ID, status: 'waiting', waitingFor: 'permission prompt' }],
    transcriptWrittenAt: 0,
  });
  writeSessionFile(sessionsDir, { pid: 4343, sessionId: 'someone-else', status: 'busy', statusUpdatedAt: 1 });
  fs.writeFileSync(path.join(sessionsDir, '4242.json'), `{"pid": 4242, "sessionId": "${SESSION_ID.slice(0, 8)}`);
  const live = (await harness.getLiveStates([SESSION_ID])).get(SESSION_ID)!;
  assert.equal(agentCalls(), 1);
  assert.equal(live.waitingFor, 'permission prompt', 'a half-written file never clears a wait by itself');
});

test('a torn read that hides a session waiting on the previous tick keeps its previous file state for one tick (R45 residual)', async (t) => {
  // claude agents knows nothing here (as with pitwall.notifications.onNeedsInput off).
  const { harness, sessionsDir, agentCalls, expireAgentsCache } = liveHarness(t, { agents: [], transcriptWrittenAt: 0 });
  writeSessionFile(sessionsDir, { pid: 4343, sessionId: 'someone-else', status: 'busy', statusUpdatedAt: 1 });
  writeSessionFile(sessionsDir, { pid: 4242, sessionId: SESSION_ID, status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: 1_000 });
  assert.equal((await harness.getLiveStates([SESSION_ID])).get(SESSION_ID)!.waitingFor, 'permission prompt');

  fs.writeFileSync(path.join(sessionsDir, '4242.json'), `{"pid": 4242, "sessionId": "${SESSION_ID.slice(0, 8)}`);
  const carried = (await harness.getLiveStates([SESSION_ID])).get(SESSION_ID)!;
  assert.equal(carried.waitingFor, 'permission prompt', 'the wait survives one torn read');
  assert.equal(carried.writtenAt, 1_000, 'with its original start');
  assert.equal(carried.liveStatus, 'waiting');
  assert.equal(agentCalls(), 0, 'no CLI call for a carried state');

  expireAgentsCache();
  const second = (await harness.getLiveStates([SESSION_ID])).get(SESSION_ID)!;
  assert.equal(second.waitingFor, undefined, 'only one tick: a second torn read falls back as before');
  assert.equal(agentCalls(), 1);
});

test('liveSessionIds lists the live sessions in the sessions file, and the tick that follows reuses that read', async (t) => {
  const { harness, sessionsDir } = liveHarness(t, { transcriptWrittenAt: 0 });
  writeSessionFile(sessionsDir, { pid: 4242, sessionId: SESSION_ID, status: 'busy', statusUpdatedAt: 1 });
  writeSessionFile(sessionsDir, { pid: 4343, sessionId: 'unknown-status', status: 'compacting', statusUpdatedAt: 1 });
  assert.deepEqual([...(await harness.liveSessionIds())!].sort(), [SESSION_ID, 'unknown-status'].sort());

  const reads: string[] = [];
  t.mock.method(fs.promises, 'readFile', async (file: unknown) => {
    reads.push(String(file));
    return fs.readFileSync(String(file), 'utf8');
  });
  await harness.liveSessionIds();
  await Promise.all([harness.getLiveStates([SESSION_ID]), harness.getLiveStates([SESSION_ID])]);
  assert.equal(reads.filter((file) => file.endsWith('.json')).length, 2, 'one folder read (two files) per tick');
});
