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
