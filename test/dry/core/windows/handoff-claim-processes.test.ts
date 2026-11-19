/**
 * Two windows on one folder, and a claim racing the sender's expiry (Review
 * Focus 1 and 2), across real `node` processes. Two claimers race for the
 * same 20 requests; then one claimer races one expirer for 20 requests sent
 * one at a time while both poll. Each request ends in exactly one state. The
 * test file is its own child: run with PITWALL_CLAIM_CHILD set, the bundle
 * claims or expires instead of registering tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HandoffInbox } from '../../../../src/core/windows/HandoffInbox';

const REQUESTS = 20;
/** The streaming race sends a request this often while both children poll. */
const SEND_EVERY_MS = 25;

interface ChildResult {
  pid: number;
  /** The nonces this child claimed, or expired. */
  nonces: string[];
}

/**
 * Child. `claim`: wait for the shared start time, then claim until the inbox
 * is empty twice in a row. `stream-claim` / `stream-expire`: poll until the
 * parent's stop file exists and a pass finds nothing; the expirer expires
 * every request it sees, as a sender whose 120 s ran out would, after a
 * random 0-2 ms so its rename lands on either side of the claimer's.
 */
async function runAsChild(): Promise<void> {
  const { PITWALL_CLAIM_DIR: dir, PITWALL_CLAIM_FOLDER: folder, PITWALL_CLAIM_START: start, PITWALL_CLAIM_CHILD: role } =
    process.env;
  const expiring = role === 'stream-expire';
  const streaming = role !== 'claim';
  const box = new HandoffInbox(dir!, { pid: process.pid, folder: expiring ? undefined : folder! });
  const inboxDir = path.join(dir!, 'pitwall-handoff', box.folderKey(folder!));
  const stopFile = path.join(dir!, 'stop');
  // Sleep until just before the shared start, then spin the last few ms so
  // both processes start in the same millisecond without burning a core each
  // (other test files measure event-loop gaps meanwhile).
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(start) - Date.now() - 20)));
  while (Date.now() < Number(start)) {
    // Spin.
  }
  const nonces: string[] = [];
  for (let empty = 0; ; ) {
    const stopping = streaming && fs.existsSync(stopFile);
    let found: number;
    if (expiring) {
      const pending = fs.readdirSync(inboxDir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
      found = pending.length;
      for (const nonce of pending) {
        const until = performance.now() + Math.random() * 2;
        while (performance.now() < until) {
          // Jitter, so neither side always renames first.
        }
        if (await box.expire(folder!, nonce)) nonces.push(nonce);
      }
    } else {
      const batch = (await box.claimAll()).map((request) => request.nonce);
      found = batch.length;
      nonces.push(...batch);
    }
    empty = found === 0 ? empty + 1 : 0;
    if (streaming ? stopping && found === 0 : empty >= 2) {
      break;
    }
    if (streaming && found === 0) {
      // Poll, don't spin, while waiting for the next request.
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  process.stdout.write(JSON.stringify({ pid: process.pid, nonces } satisfies ChildResult));
}

/** Children still running; a test that fails or times out kills its own, so the file never hangs. */
const running = new Set<ChildProcess>();

function runChild(env: Record<string, string>): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    child.on('exit', () => running.delete(child));
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`child exited ${code}: ${err}`));
        return;
      }
      try {
        resolve(JSON.parse(out) as ChildResult);
      } catch {
        reject(new Error(`child printed no result: ${out} ${err}`));
      }
    });
  });
}

/**
 * A temp directory removed when the test ends. Local rather than support's
 * `tempDir`, which pulls every harness into the bundle each child re-parses.
 */
function tempDir(t: { after(fn: () => void): void }): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-claim-')));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  return dir;
}

/**
 * Orders claims by when each request was sent, so a failure diff lines up with
 * `sent` (a nonce that was never sent sorts first and fails the comparison).
 */
const bySendOrder = (sent: string[]) => (a: string, b: string) => sent.indexOf(a) - sent.indexOf(b);

const sendOne = (sender: HandoffInbox, folder: string) =>
  sender.send(folder, { kind: 'open', sessionIds: ['5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f'] });

if (process.env.PITWALL_CLAIM_CHILD) {
  runAsChild().catch((error) => {
    process.stderr.write(String(error?.stack ?? error));
    process.exit(1);
  });
} else {
  test('2 processes × 20 requests: each claimed exactly once', { timeout: 10_000 }, async (t) => {
    t.after(() => running.forEach((child) => child.kill()));
    const dir = tempDir(t);
    const folder = tempDir(t);
    const sender = new HandoffInbox(dir, { pid: process.pid, folder: undefined });
    const sent: string[] = [];
    for (let i = 0; i < REQUESTS; i++) {
      sent.push(await sendOne(sender, folder));
    }
    const env = { PITWALL_CLAIM_DIR: dir, PITWALL_CLAIM_FOLDER: folder, PITWALL_CLAIM_START: String(Date.now() + 1_500) };
    const [first, second] = await Promise.all([
      runChild({ ...env, PITWALL_CLAIM_CHILD: 'claim' }),
      runChild({ ...env, PITWALL_CLAIM_CHILD: 'claim' }),
    ]);

    const all = [...first.nonces, ...second.nonces];
    assert.equal(all.length, REQUESTS, `claimed ${first.nonces.length} + ${second.nonces.length}`);
    assert.deepEqual([...all].sort(bySendOrder(sent)), sent, 'every request claimed exactly once');
    assert.deepEqual(first.nonces.filter((nonce) => second.nonces.includes(nonce)), [], 'no request claimed by both');
  });

  test('a claiming process and an expiring process × 20 requests: each ends claimed or expired, never both', { timeout: 10_000 }, async (t) => {
    t.after(() => running.forEach((child) => child.kill()));
    const dir = tempDir(t);
    const folder = tempDir(t);
    const sender = new HandoffInbox(dir, { pid: process.pid, folder: undefined });
    const inboxDir = path.join(dir, 'pitwall-handoff', sender.folderKey(folder));
    fs.mkdirSync(inboxDir, { recursive: true });
    const start = Date.now() + 1_500;
    const env = { PITWALL_CLAIM_DIR: dir, PITWALL_CLAIM_FOLDER: folder, PITWALL_CLAIM_START: String(start) };
    const children = Promise.all([
      runChild({ ...env, PITWALL_CLAIM_CHILD: 'stream-claim' }),
      runChild({ ...env, PITWALL_CLAIM_CHILD: 'stream-expire' }),
    ]);

    // Both children poll from `start`; each request appears while both are looking.
    await new Promise((resolve) => setTimeout(resolve, start - Date.now() + 100));
    const sent: string[] = [];
    for (let i = 0; i < REQUESTS; i++) {
      sent.push(await sendOne(sender, folder));
      await new Promise((resolve) => setTimeout(resolve, SEND_EVERY_MS));
    }
    fs.writeFileSync(path.join(dir, 'stop'), '');
    const [claimer, expirer] = await children;

    const claimed = claimer.nonces;
    const expired = expirer.nonces;
    assert.equal(claimed.length + expired.length, REQUESTS, `claimed ${claimed.length} + expired ${expired.length}`);
    assert.deepEqual(claimed.filter((nonce) => expired.includes(nonce)), [], 'no request both claimed and expired');
    assert.deepEqual([...claimed, ...expired].sort(bySendOrder(sent)), sent, 'every request claimed or expired');

    const files = new Set(fs.readdirSync(inboxDir));
    const wrong = sent.flatMap((nonce) => {
      const ends = [`${nonce}.claimed-${claimer.pid}`, `${nonce}.expired`].filter((name) => files.has(name));
      const expected = claimed.includes(nonce) ? `${nonce}.claimed-${claimer.pid}` : `${nonce}.expired`;
      return ends.length === 1 && ends[0] === expected ? [] : [{ nonce, ends, expected }];
    });
    assert.deepEqual(wrong, [], 'each request ends in exactly the state its winner reported');
    assert.equal(files.size, REQUESTS, `no request, lock or temp file left: ${[...files].join(', ')}`);
  });
}
