/**
 * Two windows on one folder (Review Focus 2): two real `node` processes race
 * to claim the same 20 requests, and each request is claimed exactly once.
 * The test file is its own child: run with PITWALL_CLAIM_CHILD set, the bundle
 * claims instead of registering tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { HandoffInbox } from '../../../../src/core/windows/HandoffInbox';
import { tempDir } from '../../support';

const REQUESTS = 20;

/** Child: wait for the shared start time, then claim until the inbox is empty twice in a row. */
async function claimAsChild(): Promise<void> {
  const { PITWALL_CLAIM_DIR: dir, PITWALL_CLAIM_FOLDER: folder, PITWALL_CLAIM_START: start } = process.env;
  const box = new HandoffInbox(dir!, { pid: process.pid, folder: folder! });
  while (Date.now() < Number(start)) {
    // Busy-wait so both processes start claiming in the same millisecond.
  }
  const claimed: string[] = [];
  for (let empty = 0; empty < 2; ) {
    const batch = await box.claimAll();
    claimed.push(...batch.map((request) => request.nonce));
    empty = batch.length === 0 ? empty + 1 : 0;
  }
  process.stdout.write(JSON.stringify(claimed));
}

function runChild(env: Record<string, string>): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`claimer exited ${code}: ${err}`));
        return;
      }
      try {
        resolve(JSON.parse(out) as string[]);
      } catch {
        reject(new Error(`claimer printed no result: ${out} ${err}`));
      }
    });
  });
}

if (process.env.PITWALL_CLAIM_CHILD) {
  claimAsChild().catch((error) => {
    process.stderr.write(String(error?.stack ?? error));
    process.exit(1);
  });
} else {
  test('2 processes × 20 requests: each claimed exactly once', { timeout: 10_000 }, async (t) => {
    const dir = tempDir(t);
    const folder = tempDir(t);
    const sender = new HandoffInbox(dir, { pid: process.pid, folder: undefined });
    const sent: string[] = [];
    for (let i = 0; i < REQUESTS; i++) {
      sent.push(await sender.send(folder, { kind: 'open', sessionIds: ['5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f'] }));
    }

    const env = {
      PITWALL_CLAIM_CHILD: '1',
      PITWALL_CLAIM_DIR: dir,
      PITWALL_CLAIM_FOLDER: folder,
      PITWALL_CLAIM_START: String(Date.now() + 1_500),
    };
    const [first, second] = await Promise.all([runChild(env), runChild(env)]);

    const all = [...first, ...second];
    assert.equal(all.length, REQUESTS, `claimed ${first.length} + ${second.length}`);
    assert.deepEqual([...all].sort(), [...sent].sort(), 'every request claimed exactly once');
    assert.deepEqual(first.filter((nonce) => second.includes(nonce)), [], 'no request claimed by both');
  });
}
