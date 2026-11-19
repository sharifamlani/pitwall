/**
 * The walk behind Next ▸ (row 5.4, Q40): state in one file every window
 * reads; it ends after 10 min or when the list empties.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { JUMP_FILE, JumpWalk, WALK_EXPIRES_MS } from '../../../../src/core/windows/JumpWalk';
import { stub, tempDir } from '../../support';

beforeEach(() => stub.__reset());

test('two JumpWalk instances on one dir agree on next', async (t) => {
  const dir = tempDir(t);
  const a = new JumpWalk(dir);
  const b = new JumpWalk(dir);
  await a.start(['x', 'y', 'z'], 'x');
  assert.equal(await b.active(), true, 'the other window sees the walk');
  assert.equal(await b.next(['x', 'y', 'z']), 'y');
  assert.equal(await a.next(['x', 'y', 'z']), 'z', "the first window continues from the other one's jump");
  assert.equal(await b.next(['x', 'y', 'z']), undefined, 'nothing after z');
  assert.equal(await a.active(), false, 'and the walk ended for both');
});

test('the file holds only v, ids, last and at', async (t) => {
  const dir = tempDir(t);
  await new JumpWalk(dir, () => 5_000).start(['x', 'y'], 'x');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, JUMP_FILE), 'utf-8')), { v: 1, ids: ['x', 'y'], last: 'x', at: 5_000 });
});

test('the walk ends after 10 min or when the list empties', async (t) => {
  const dir = tempDir(t);
  let now = 1_000_000;
  const walk = new JumpWalk(dir, () => now);
  await walk.start(['x', 'y'], 'x');
  now += WALK_EXPIRES_MS - 1;
  assert.equal(await walk.active(), true, 'just under 10 min');
  now += 1;
  assert.equal(await walk.active(), false, '10 min after the jump');
  assert.equal(await walk.next(['x', 'y']), undefined, 'an expired walk goes nowhere');

  await walk.start(['x', 'y'], 'x');
  assert.equal(await walk.next([]), undefined, 'the list emptied');
  assert.equal(await walk.active(), false, 'the walk ended with it');
});

test('each jump restarts the 10 min, a later waiter is visited, and the skip set holds back the chat in front', async (t) => {
  const dir = tempDir(t);
  let now = 1_000_000;
  const walk = new JumpWalk(dir, () => now);
  await walk.start(['x', 'y', 'z'], 'x');
  now += WALK_EXPIRES_MS - 1;
  assert.equal(await walk.next(['x', 'y', 'z'], new Set(['y'])), 'z', 'y is in front here, so z');
  now += WALK_EXPIRES_MS - 1;
  assert.equal(await walk.active(), true, 'the jump restarted the clock');
  assert.equal(await walk.peek(['x', 'y', 'z', 'n']), 'n', 'a newcomer comes after the rest');
  assert.equal(await walk.next(['x', 'n']), 'n');
  assert.equal(await walk.next(['x']), undefined, 'x was the first stop, never repeated');
});

test("onDidChange fires on a start, on another window's change seen by poll, and on an end", async (t) => {
  const dir = tempDir(t);
  const a = new JumpWalk(dir);
  const b = new JumpWalk(dir);
  let fired = 0;
  b.onDidChange(() => fired++);
  await b.poll();
  assert.equal(fired, 0, 'nothing there, nothing new');
  await a.start(['x', 'y'], 'x');
  await b.poll();
  assert.equal(fired, 1);
  await b.poll();
  assert.equal(fired, 1, 'no change, no event');
  await a.end();
  await b.poll();
  assert.equal(fired, 2);
});

test('the dump script reads the walk file and fails on a key outside v, ids, last, at', async (t) => {
  const dir = tempDir(t);
  await new JumpWalk(dir).start(['5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', 'b'], 'b');
  const script = path.resolve(__dirname, '..', '..', '..', 'scripts', 'dump-pitwall-windows.mjs');
  const run = () => spawnSync(process.execPath, [script, '--dir', dir, '--check-privacy'], { encoding: 'utf8' });
  const ok = run();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /jump walk: 2 ids/);
  assert.match(ok.stdout, /privacy ok: 1 files checked/);
  const file = path.join(dir, JUMP_FILE);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf-8')), title: 'a chat title' }));
  const leak = run();
  assert.equal(leak.status, 1, leak.stdout);
  assert.match(leak.stdout, /keys outside the jump allow-list: title/);
});
