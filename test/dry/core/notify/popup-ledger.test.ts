/**
 * The pop-up ledger (Q32): exactly one window shows each pop-up, the first to
 * create `<dir>/<sessionId>.<kind>.<at>.lock` with `wx`. Real temp dirs; the
 * race runs in two real child processes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { LOCK_TTL_MS, PopupLedger } from '../../../../src/core/notify/PopupLedger';
import { tempDir } from '../../support';

const SESSION = '5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

// Child mode: this same bundle, run with PITWALL_LEDGER_CHILD, claims one key at
// a shared start time and prints whether it won. No tests register in it.
const child = process.env.PITWALL_LEDGER_CHILD;
if (child) {
  const { dir, at, startAt } = JSON.parse(child) as { dir: string; at: number; startAt: number };
  const go = () =>
    void new PopupLedger(dir).claim({ sessionId: SESSION, kind: 'needs', at }).then((won) => {
      process.stdout.write(won ? 'won' : 'lost');
      process.exit(0);
    });
  setTimeout(go, Math.max(0, startAt - Date.now()));
} else {
  test('the first claim of a key wins and the second loses', async (t) => {
    const dir = path.join(tempDir(t), 'pitwall-popups');
    const ledger = new PopupLedger(dir);
    const key = { sessionId: SESSION, kind: 'needs' as const, at: 1_800_000_000_123 };
    assert.equal(await ledger.claim(key), true, 'first');
    assert.equal(await ledger.claim(key), false, 'second');
    assert.equal(await ledger.claim({ ...key, kind: 'finished' }), true, 'another kind is another key');
    assert.equal(await ledger.claim({ ...key, at: key.at + 1 }), true, 'another stamp is another key');
    const names = fs.readdirSync(dir).sort();
    assert.deepEqual(names, [
      `${SESSION}.finished.1800000000123.lock`,
      `${SESSION}.needs.1800000000123.lock`,
      `${SESSION}.needs.1800000000124.lock`,
    ]);
    assert.ok(names.every((name) => fs.statSync(path.join(dir, name)).size === 0), 'lock files are empty');
  });

  test('a stamp that is missing, zero or not an integer, or a session ID that is not an ID, never makes a lock', async (t) => {
    const dir = path.join(tempDir(t), 'pitwall-popups');
    const ledger = new PopupLedger(dir);
    for (const at of [0, -5, Number.NaN, 1.5, undefined as unknown as number]) {
      await assert.rejects(ledger.claim({ sessionId: SESSION, kind: 'needs', at }), /stamp/, String(at));
    }
    await assert.rejects(ledger.claim({ sessionId: '../escape', kind: 'needs', at: 5 }), /session/);
    await assert.rejects(ledger.claim({ sessionId: 'a\\b', kind: 'needs', at: 5 }), /session/);
    assert.equal(await ledger.claim({ sessionId: 'ses_01JABCdef', kind: 'finished', at: 5 }), true, "opencode's IDs are IDs too");
    fs.rmSync(path.join(dir, 'ses_01JABCdef.finished.5.lock'));
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], 'no .0 (or any) lock was written');
  });

  test('a lock error other than EEXIST logs popup lock failed with its code', async (t) => {
    // The lock folder's parent is a file: creating the folder fails (ENOTDIR or ENOENT), never with EEXIST.
    const blocker = path.join(tempDir(t), 'not-a-folder');
    fs.writeFileSync(blocker, '');
    const log: string[] = [];
    const ledger = new PopupLedger(path.join(blocker, 'pitwall-popups'), Date.now, (line) => log.push(line));
    assert.equal(await ledger.claim({ sessionId: SESSION, kind: 'needs', at: 7 }), true, 'a pop-up that may show twice beats one that never shows');
    assert.equal(log.length, 1);
    assert.match(log[0], /^\[Pitwall\] popup lock failed [A-Z]+$/);
    assert.ok(!log[0].endsWith('EEXIST'));

    // A lost claim (EEXIST) logs nothing here: the judge logs "skipped locked".
    const dir = path.join(tempDir(t), 'pitwall-popups');
    const quiet: string[] = [];
    const ok = new PopupLedger(dir, Date.now, (line) => quiet.push(line));
    await ok.claim({ sessionId: SESSION, kind: 'needs', at: 7 });
    assert.equal(await ok.claim({ sessionId: SESSION, kind: 'needs', at: 7 }), false);
    assert.deepEqual(quiet, []);
  });

  test('two processes claiming one transition: exactly one wins', async (t) => {
    const dir = path.join(tempDir(t), 'pitwall-popups');
    for (let round = 0; round < 5; round++) {
      const startAt = Date.now() + 400;
      const env = { ...process.env, PITWALL_LEDGER_CHILD: JSON.stringify({ dir, at: 1_800_000_000_000 + round, startAt }) };
      const run = () =>
        new Promise<string>((resolve, reject) => {
          const proc = spawn(process.execPath, [__filename], { env });
          let out = '';
          proc.stdout.on('data', (chunk) => (out += chunk));
          proc.on('error', reject);
          proc.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`child exited ${code}`))));
        });
      const results = await Promise.all([run(), run()]);
      assert.deepEqual(results.sort(), ['lost', 'won'], `round ${round}`);
    }
  });

  test('locks older than 10 min are swept', async (t) => {
    const dir = path.join(tempDir(t), 'pitwall-popups');
    // Locks age by when they were made (their mtime), never by their stamp.
    let now = Date.now();
    const ledger = new PopupLedger(dir, () => now);
    await ledger.claim({ sessionId: SESSION, kind: 'needs', at: 1 });
    await ledger.claim({ sessionId: SESSION, kind: 'finished', at: 2 });
    fs.writeFileSync(path.join(dir, 'not-a-lock.txt'), '');
    const made = new Date(now - LOCK_TTL_MS + 1_000);
    fs.utimesSync(path.join(dir, `${SESSION}.needs.1.lock`), made, made);
    fs.utimesSync(path.join(dir, 'not-a-lock.txt'), new Date(0), new Date(0));
    await ledger.sweep();
    assert.equal(fs.readdirSync(dir).length, 3, 'nothing is 10 min old yet');

    now += 2_000;
    await ledger.sweep();
    assert.deepEqual(fs.readdirSync(dir).sort(), [`${SESSION}.finished.2.lock`, 'not-a-lock.txt'], 'the old lock is gone; other files are left alone');
    assert.equal(LOCK_TTL_MS, 10 * 60_000);
    await new PopupLedger(path.join(dir, 'missing')).sweep();
  });

  test("a reload in the same window can't re-claim a transition", async (t) => {
    const dir = path.join(tempDir(t), 'pitwall-popups');
    const key = { sessionId: SESSION, kind: 'finished' as const, at: 1_800_000_000_777 };
    assert.equal(await new PopupLedger(dir).claim(key), true, 'before the reload');
    // The reloaded window builds a new ledger (and sweeps on activation) over the same folder.
    const reloaded = new PopupLedger(dir);
    await reloaded.sweep();
    assert.equal(await reloaded.claim(key), false, 'after the reload, within 10 min');
  });
}
