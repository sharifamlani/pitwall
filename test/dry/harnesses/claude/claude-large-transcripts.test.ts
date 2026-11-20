/**
 * Large live transcripts (0.6.0 walk, discovery on): the owner's agent
 * sessions run to hundreds of MB and are written all the time. Neither the
 * attention tick's tail read nor the import's parse may re-read one whole on
 * each write.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { readTurnStateTail } from '../../../../src/harnesses/claude/ClaudeTurnState';
import { ClaudeSessionService } from '../../../../src/harnesses/claude/ClaudeSessionService';
import { claudeProfile, entry } from './claudeFixture';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';

/** Counts the bytes read through `fs.promises.open` handles while `fn` runs. */
async function bytesReadBy(fn: () => Promise<unknown>): Promise<number> {
  const open = fs.promises.open;
  let bytes = 0;
  fs.promises.open = (async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle) as (...readArgs: unknown[]) => Promise<{ bytesRead: number }>;
    (handle as unknown as { read: unknown }).read = async (...readArgs: unknown[]) => {
      const result = await read(...readArgs);
      bytes += result.bytesRead;
      return result;
    };
    return handle;
  }) as typeof open;
  try {
    await fn();
  } finally {
    fs.promises.open = open;
  }
  return bytes;
}

/** `mb` MB of finished turns, as current Claude writes them: no `turn_duration`. */
function bulk(cwd: string, mb: number): string {
  const pair =
    `${JSON.stringify({ cwd, sessionId: SESSION_ID, ...entry.user('step') })}\n` +
    `${JSON.stringify({ cwd, sessionId: SESSION_ID, ...entry.assistant('x'.repeat(4_000)) })}\n`;
  return pair.repeat(Math.ceil((mb * 1024 * 1024) / pair.length));
}

test('a finished turn with no turn_duration is read from the tail, not the whole transcript', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const file = profile.write(SESSION_ID, repo, []);
  fs.writeFileSync(file, bulk(repo, 32));
  const endedAt = '2026-11-19T10:00:00.000Z';
  fs.appendFileSync(file, `${JSON.stringify({ cwd: repo, sessionId: SESSION_ID, ...entry.assistant('done', 'end_turn', endedAt) })}\n`);
  // A live session keeps appending metadata after its turn.
  fs.appendFileSync(file, `${JSON.stringify({ type: 'queue-operation', sessionId: SESSION_ID })}\n`);

  let reading: Awaited<ReturnType<typeof readTurnStateTail>> = null;
  const bytes = await bytesReadBy(async () => {
    reading = await readTurnStateTail(file);
  });
  assert.deepEqual(reading, { turnState: 'done', turnEndedAt: Date.parse(endedAt) });
  assert.ok(bytes < 1024 * 1024, `read ${bytes} bytes of a 32 MB transcript`);
});

test("an earlier turn's turn_duration does not decide the latest turn, in the tail read and the parse alike", async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const endedAt = '2026-11-19T10:00:05.000Z';
  const file = profile.write(SESSION_ID, repo, [
    entry.user('first', '2026-11-19T10:00:00.000Z'),
    entry.assistant('first done', 'end_turn', '2026-11-19T10:00:01.000Z'),
    // A background agent was still running when the first turn ended.
    { type: 'system', subtype: 'turn_duration', pendingBackgroundAgentCount: 1 },
    // Its result arrives as a new turn, which ends without a turn_duration.
    entry.user('agent finished', '2026-11-19T10:00:04.000Z'),
    entry.assistant('second done', 'end_turn', endedAt),
  ]);
  const expected = { turnState: 'done', turnEndedAt: Date.parse(endedAt) };
  assert.deepEqual(await readTurnStateTail(file), expected, 'tail');
  const [session] = await new ClaudeSessionService().findSessionsForWorktree(repo);
  assert.deepEqual({ turnState: session.turnState, turnEndedAt: session.turnEndedAt }, expected, 'parser');
});

test('a grown transcript is parsed from where the last parse ended, and reads like a fresh parse', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const file = profile.write(SESSION_ID, repo, [entry.user('Fix the tests')]);
  fs.appendFileSync(file, bulk(repo, 8));
  const service = new ClaudeSessionService();
  const firstBytes = await bytesReadBy(() => service.findSessionsForWorktree(repo));
  assert.ok(firstBytes >= 8 * 1024 * 1024, 'the first parse reads the whole file');

  // A line larger than a read chunk, cut across chunks, with multi-byte text.
  const long = `é${'ü'.repeat(1024 * 1024)}`;
  fs.appendFileSync(
    file,
    [entry.user('Now the docs'), entry.assistant(long), entry.customTitle('Docs pass')]
      .map((value) => `${JSON.stringify({ cwd: repo, sessionId: SESSION_ID, ...value })}\n`)
      .join('')
  );
  let resumed: Awaited<ReturnType<ClaudeSessionService['findSessionsForWorktree']>> = [];
  const resumedBytes = await bytesReadBy(async () => {
    resumed = await service.findSessionsForWorktree(repo);
  });
  assert.ok(resumedBytes < 4 * 1024 * 1024, `the resumed parse read ${resumedBytes} bytes, not the whole file again`);
  const [fresh] = await new ClaudeSessionService().findSessionsForWorktree(repo);
  assert.deepEqual(resumed[0], fresh, 'resumed and fresh parses agree');
  assert.equal(fresh.summary, 'Docs pass');
  assert.equal(fresh.lastReply?.text, long);
  assert.deepEqual(fresh.recentUserPrompts.map((prompt) => prompt.text), ['step', 'step', 'Now the docs']);
});

test('a line still being written is read once it is complete, and a rewritten transcript is parsed again', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const file = profile.write(SESSION_ID, repo, [entry.user('First ask')]);
  const service = new ClaudeSessionService();
  const parse = async () => (await service.findSessionsForWorktree(repo))[0];

  const line = JSON.stringify({ cwd: repo, sessionId: SESSION_ID, ...entry.user('Second ask') });
  fs.appendFileSync(file, line.slice(0, 20));
  assert.equal((await parse()).lastAsk?.text, 'First ask', 'half a line is not a fact');
  fs.appendFileSync(file, `${line.slice(20)}\n`);
  assert.equal((await parse()).lastAsk?.text, 'Second ask', 'the completed line is read');

  // The same path, new content (shorter, then same length): parsed from the start.
  fs.writeFileSync(file, `${JSON.stringify({ cwd: repo, sessionId: SESSION_ID, ...entry.user('Other') })}\n`);
  assert.deepEqual((await parse()).recentUserPrompts.map((prompt) => prompt.text), ['Other']);
  const sameLength = fs.readFileSync(file, 'utf8').replace('Other', 'Again');
  fs.writeFileSync(file, sameLength);
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
  assert.deepEqual((await parse()).recentUserPrompts.map((prompt) => prompt.text), ['Again']);
});
