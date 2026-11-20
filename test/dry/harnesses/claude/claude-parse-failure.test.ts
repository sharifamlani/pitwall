/**
 * A transcript read that fails (the file busy for a moment, a read error)
 * must cost one retry, not a whole re-read. Before, a failed parse dropped
 * the transcript's resume point and was cached as "no session" until the file
 * next changed: the row's session vanished from the scan meanwhile, and the
 * next scan read the whole transcript again (hundreds of MB for the owner's
 * live chats), the kind of pass that took 15–27 s on the #79 gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { ClaudeSessionService } from '../../../../src/harnesses/claude/ClaudeSessionService';
import { claudeProfile, entry } from './claudeFixture';

const SESSION_ID = '11111111-2222-4333-8444-666666666666';

/** `mb` MB of finished turns. */
function bulk(cwd: string, mb: number): string {
  const pair =
    `${JSON.stringify({ cwd, sessionId: SESSION_ID, ...entry.user('step') })}\n` +
    `${JSON.stringify({ cwd, sessionId: SESSION_ID, ...entry.assistant('x'.repeat(4_000)) })}\n`;
  return pair.repeat(Math.ceil((mb * 1024 * 1024) / pair.length));
}

const lines = (cwd: string, values: object[]) => values.map((value) => `${JSON.stringify({ cwd, sessionId: SESSION_ID, ...value })}\n`).join('');

/**
 * While `fn` runs: counts the bytes read through `fs.promises.open` handles,
 * and fails the opens or reads `fail` picks (by how many reads came before).
 */
async function readsDuring(
  fn: () => Promise<unknown>,
  fail: { open?: boolean; afterReads?: number } = {}
): Promise<number> {
  const open = fs.promises.open;
  let bytes = 0;
  let reads = 0;
  fs.promises.open = (async (...args: Parameters<typeof open>) => {
    if (fail.open) {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    const handle = await open(...args);
    const read = handle.read.bind(handle) as (...readArgs: unknown[]) => Promise<{ bytesRead: number }>;
    (handle as unknown as { read: unknown }).read = async (...readArgs: unknown[]) => {
      if (fail.afterReads !== undefined && reads >= fail.afterReads) {
        throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
      }
      reads += 1;
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

test('a transcript that cannot be opened for a moment keeps its session listed, and the next scan reads only what was added', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const file = profile.write(SESSION_ID, repo, [entry.user('First ask')]);
  fs.appendFileSync(file, bulk(repo, 8));
  const service = new ClaudeSessionService();
  assert.equal((await service.findSessionsForWorktree(repo)).length, 1);

  fs.appendFileSync(file, lines(repo, [entry.user('Second ask'), entry.assistant('done')]));
  let during: Awaited<ReturnType<ClaudeSessionService['findSessionsForWorktree']>> = [];
  await readsDuring(async () => {
    during = await service.findSessionsForWorktree(repo);
  }, { open: true });
  assert.equal(during.length, 1, 'the scan that could not read the file still lists its session');
  assert.equal(during[0].lastAsk?.text, 'step', 'as last read');

  let after: Awaited<ReturnType<ClaudeSessionService['findSessionsForWorktree']>> = [];
  const bytes = await readsDuring(async () => {
    after = await service.findSessionsForWorktree(repo);
  });
  assert.equal(after.length, 1, 'the failure was not cached as "no session"');
  assert.equal(after[0].lastAsk?.text, 'Second ask');
  assert.ok(bytes < 1024 * 1024, `the next scan read ${bytes} bytes: it resumed, it did not read the 8 MB again`);
  const [fresh] = await new ClaudeSessionService().findSessionsForWorktree(repo);
  assert.deepEqual(after[0], fresh, 'and it reads like a fresh parse');
});

test('a read that fails partway through a grown transcript resumes from what it had read', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const file = profile.write(SESSION_ID, repo, [entry.user('First ask')]);
  fs.appendFileSync(file, bulk(repo, 8));
  const service = new ClaudeSessionService();
  await service.findSessionsForWorktree(repo);

  // 4 MB more: the resume reads it in 1 MB chunks, and the third read fails.
  fs.appendFileSync(file, bulk(repo, 4) + lines(repo, [entry.user('Last ask'), entry.assistant('all done')]));
  await readsDuring(() => service.findSessionsForWorktree(repo), { afterReads: 3 });

  let after: Awaited<ReturnType<ClaudeSessionService['findSessionsForWorktree']>> = [];
  const bytes = await readsDuring(async () => {
    after = await service.findSessionsForWorktree(repo);
  });
  assert.equal(after[0]?.lastAsk?.text, 'Last ask');
  assert.ok(bytes < 3.5 * 1024 * 1024, `the retry read ${bytes} bytes: it went on from the failed read, not from the start`);
  const [fresh] = await new ClaudeSessionService().findSessionsForWorktree(repo);
  assert.deepEqual(after[0], fresh, 'and it reads like a fresh parse');
});

test('a transcript that cannot be read at its first parse is tried again at the next scan', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  profile.write(SESSION_ID, repo, [entry.user('Only ask'), entry.assistant('done')]);
  const service = new ClaudeSessionService();
  let during: Awaited<ReturnType<ClaudeSessionService['findSessionsForWorktree']>> = [];
  await readsDuring(async () => {
    during = await service.findSessionsForWorktree(repo);
  }, { open: true });
  assert.equal(during.length, 0, 'nothing read yet, nothing to list');
  const [after] = await service.findSessionsForWorktree(repo);
  assert.equal(after?.lastAsk?.text, 'Only ask', 'the unchanged file is read once it can be');
});

test('a first parse that fails partway keeps what it read, and the next scan goes on from there', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const file = profile.write(SESSION_ID, repo, [entry.user('First ask')]);
  fs.appendFileSync(file, bulk(repo, 8) + lines(repo, [entry.user('Last ask'), entry.assistant('all done')]));
  // A whole-file first parse (no skim): 1 MB reads, and the fourth one fails.
  const service = new ClaudeSessionService({ skimMinBytes: Infinity });
  let during: Awaited<ReturnType<ClaudeSessionService['findSessionsForWorktree']>> = [];
  await readsDuring(async () => {
    during = await service.findSessionsForWorktree(repo);
  }, { afterReads: 3 });
  assert.equal(during.length, 0, 'nothing finished yet, nothing to list');

  let after: Awaited<ReturnType<ClaudeSessionService['findSessionsForWorktree']>> = [];
  const bytes = await readsDuring(async () => {
    after = await service.findSessionsForWorktree(repo);
  });
  assert.equal(after[0]?.lastAsk?.text, 'Last ask');
  assert.ok(bytes < 6 * 1024 * 1024, `the retry read ${bytes} bytes: it went on from the 3 MB read, not from the start`);
  const [fresh] = await new ClaudeSessionService().findSessionsForWorktree(repo);
  assert.deepEqual(after[0], fresh, 'and it reads like a fresh parse');
});

test('a failed read whose check fell behind a long line drops the resume point: a transcript replaced past it parses from the start', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const file = profile.write(SESSION_ID, repo, [entry.user('First ask')]);
  fs.appendFileSync(file, bulk(repo, 1));
  const service = new ClaudeSessionService();
  await service.findSessionsForWorktree(repo);
  const prefix = fs.readFileSync(file);
  const MB = 1024 * 1024;
  const longLine = (n: number) => `${JSON.stringify({ cwd: repo, sessionId: SESSION_ID, ...entry.assistant('x'.repeat(n)) })}\n`;
  // A line that ends 30 bytes into the resume's second 1 MB chunk, too early in
  // the chunk for the check to move with it; then a longer line past that chunk.
  const line = longLine(MB + 30 - Buffer.byteLength(longLine(0)));
  assert.equal(Buffer.byteLength(line), MB + 30);
  fs.appendFileSync(file, line + longLine(MB + 200_000) + lines(repo, [entry.user('Last ask')]));
  // The resume's third chunk read fails: its offset is past the line, its check still before it.
  await readsDuring(() => service.findSessionsForWorktree(repo), { afterReads: 3 });

  // Replaced: the same bytes up to the line's start, then different lines, longer than before.
  fs.writeFileSync(file, Buffer.concat([prefix, Buffer.from(lines(repo, [entry.user('Replaced ask')]) + longLine(3 * MB))]));
  const [after] = await service.findSessionsForWorktree(repo);
  const [fresh] = await new ClaudeSessionService().findSessionsForWorktree(repo);
  assert.equal(fresh?.lastAsk?.text, 'Replaced ask');
  assert.equal(after?.lastAsk?.text, 'Replaced ask', 'the parse resumed mid-file, past the replaced lines');
  assert.deepEqual(after, fresh, 'and it reads like a fresh parse');
});

/**
 * Two transcripts of the same length whose last line (so the 64 bytes a
 * resume checks) is the same, but whose first prompt differs: `same` resumes
 * on `original`'s progress only if that progress was wrongly kept.
 */
function lookalikes(cwd: string): { original: string; same: string } {
  const at = '2026-11-20T00:00:00.000Z';
  const last = lines(cwd, [entry.user('Shared last ask', at)]);
  return {
    original: lines(cwd, [entry.user('First ask', at), entry.assistant('a'.repeat(500), 'end_turn', at)]) + last,
    same: lines(cwd, [entry.user('Other ask', at), entry.assistant('b'.repeat(500), 'end_turn', at)]) + last,
  };
}

test('a rewritten transcript whose first read fails does not keep the old resume point', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const { original, same } = lookalikes(repo);
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(same));
  const file = profile.write(SESSION_ID, repo, [entry.user('Placeholder')]);
  fs.writeFileSync(file, original);
  const service = new ClaudeSessionService();
  await service.findSessionsForWorktree(repo);
  // Rewritten shorter, and its first read fails.
  fs.writeFileSync(file, lines(repo, [entry.user('Short')]));
  await readsDuring(() => service.findSessionsForWorktree(repo), { afterReads: 0 });
  // Rewritten again: the old check matches at the old offset, but the lines before it differ.
  fs.writeFileSync(file, same + lines(repo, [entry.user('Newest ask')]));
  const [after] = await service.findSessionsForWorktree(repo);
  const [fresh] = await new ClaudeSessionService().findSessionsForWorktree(repo);
  assert.equal(fresh?.summary, 'Other ask');
  assert.deepEqual(after, fresh, 'it resumed on the transcript it replaced');
});

test('a transcript emptied and then rewritten does not resume on its old parse', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const { original, same } = lookalikes(repo);
  const file = profile.write(SESSION_ID, repo, [entry.user('Placeholder')]);
  fs.writeFileSync(file, original);
  const service = new ClaudeSessionService();
  await service.findSessionsForWorktree(repo);
  fs.writeFileSync(file, '');
  await service.findSessionsForWorktree(repo);
  fs.writeFileSync(file, same + lines(repo, [entry.user('Newest ask')]));
  const [after] = await service.findSessionsForWorktree(repo);
  const [fresh] = await new ClaudeSessionService().findSessionsForWorktree(repo);
  assert.equal(fresh?.summary, 'Other ask');
  assert.deepEqual(after, fresh, 'it resumed on the emptied transcript');
});
