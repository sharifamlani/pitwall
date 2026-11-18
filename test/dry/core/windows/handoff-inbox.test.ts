/**
 * The handoff inbox (Q1, Q16, Q17, Q19): a window that can't open a chat
 * itself writes a request into `<globalStorage>/pitwall-handoff/<folderKey>/`,
 * and the one single-folder window on that folder claims it by renaming it.
 * Real temp dirs and an injected clock.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { stub, tempDir, waitFor } from '../../support';
import { pathKey } from '../../../../src/core/utils/paths';
import {
  EXPIRE_MS,
  HandoffInbox,
  HandoffRequest,
  SWEEP_AGE_MS,
  renameRetrying,
} from '../../../../src/core/windows/HandoffInbox';
import { WindowRegistry, ownsFolder } from '../../../../src/core/windows/WindowRegistry';

beforeEach(() => stub.__reset());

const A = '5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const B = '6a1d4e5f-2b3c-4d4e-9f0a-1b2c3d4e5f60';

function fakeClock(start = 1_700_000_000_000) {
  const clock = { now: start, read: () => clock.now };
  return clock;
}

/** An inbox for a window on `folder` (or an empty window), with its log lines. */
function inbox(dir: string, folder: string | undefined, clock: { read: () => number }, pid = process.pid) {
  const lines: string[] = [];
  const box = new HandoffInbox(dir, { pid, folder }, clock.read, (line) => lines.push(line));
  return Object.assign(box, { lines });
}

/** The files in one folder's inbox. */
function inboxFiles(box: HandoffInbox, dir: string, folder: string): string[] {
  const folderDir = path.join(dir, 'pitwall-handoff', box.folderKey(folder));
  return fs.existsSync(folderDir) ? fs.readdirSync(folderDir).sort() : [];
}

test('pathKey gives one key for drive-case, trailing-slash, \\\\?\\ and forward-slash spellings of a real temp dir', (t) => {
  const folder = tempDir(t, 'pitwall-Lab-');
  const variants = [folder, folder + path.sep, folder.split(path.sep).join('/') + '/'];
  if (process.platform === 'win32') {
    const drive = folder[0] === folder[0].toUpperCase() ? folder[0].toLowerCase() : folder[0].toUpperCase();
    variants.push(drive + folder.slice(1), drive + folder.slice(1).toLowerCase(), '\\\\?\\' + folder, '\\\\?\\' + folder + '\\');
  }
  const box = new HandoffInbox(tempDir(t), { pid: process.pid, folder: undefined });
  const keys = new Set(variants.map((variant) => pathKey(variant)));
  assert.equal(keys.size, 1, [...keys].join(' | '));
  assert.equal(new Set(variants.map((variant) => box.folderKey(variant))).size, 1);
  assert.match(box.folderKey(folder), /^[0-9a-f]{16}$/);
  assert.notEqual(box.folderKey(tempDir(t)), box.folderKey(folder), 'another folder gets another key');
});

test('only the window whose folder matches claims a request', async (t) => {
  const dir = tempDir(t);
  const lab = tempDir(t);
  const other = tempDir(t);
  const clock = fakeClock();
  const sender = inbox(dir, undefined, clock);
  const nonce = await sender.send(lab, { kind: 'open', sessionIds: [A] });
  assert.ok(sender.lines.some((line) => line === `[Pitwall] handoff sent ${nonce.slice(0, 8)} → ${lab}`), sender.lines.join('\n'));

  assert.deepEqual(await inbox(dir, other, clock).claimAll(), [], 'another folder claims nothing');
  clock.now += 250;
  const claimer = inbox(dir, lab, clock);
  const claimed = await claimer.claimAll();
  assert.deepEqual(claimed, [{ v: 1, kind: 'open', sessionIds: [A], folder: lab, at: clock.now - 250, nonce }]);
  assert.ok(claimer.lines.includes(`[Pitwall] handoff claimed ${nonce.slice(0, 8)} after 250 ms`), claimer.lines.join('\n'));
  assert.deepEqual(inboxFiles(sender, dir, lab), [`${nonce}.claimed-${process.pid}`]);
  assert.deepEqual(await claimer.claimAll(), [], 'claimed once');
});

test('two concurrent claimAll calls return the request exactly once', async (t) => {
  const dir = tempDir(t);
  const lab = tempDir(t);
  const clock = fakeClock();
  const sender = inbox(dir, undefined, clock);
  for (let round = 0; round < 20; round++) {
    const nonce = await sender.send(lab, { kind: 'open', sessionIds: [A] });
    const results = await Promise.all([inbox(dir, lab, clock, 1001).claimAll(), inbox(dir, lab, clock, 1002).claimAll()]);
    assert.deepEqual(results.flat().map((request) => request.nonce), [nonce], `round ${round}`);
  }
});

test('claim and expire racing on one request: exactly one wins', async (t) => {
  const dir = tempDir(t);
  const lab = tempDir(t);
  const clock = fakeClock();
  const sender = inbox(dir, undefined, clock);
  const claimer = inbox(dir, lab, clock);
  for (let round = 0; round < 20; round++) {
    const nonce = await sender.send(lab, { kind: 'new', sessionIds: [] });
    const [claimed, expired] = await Promise.all([claimer.claimAll(), sender.expire(lab, nonce)]);
    assert.equal(claimed.length + (expired ? 1 : 0), 1, `round ${round}: claimed ${claimed.length}, expired ${expired}`);
    const files = inboxFiles(sender, dir, lab).filter((file) => file.startsWith(nonce));
    assert.deepEqual(files, [expired ? `${nonce}.expired` : `${nonce}.claimed-${process.pid}`]);
  }
});

test('a request for a folder that never opens is expired by the sender', async (t) => {
  const dir = tempDir(t);
  const lab = tempDir(t);
  const clock = fakeClock();
  const sender = inbox(dir, undefined, clock);
  const nonce = await sender.send(lab, { kind: 'open', sessionIds: [A] });
  clock.now += EXPIRE_MS;

  assert.equal(await sender.expire(lab, nonce), true);
  assert.ok(sender.lines.includes(`[Pitwall] handoff expired ${nonce.slice(0, 8)}`), sender.lines.join('\n'));
  assert.deepEqual(inboxFiles(sender, dir, lab), [`${nonce}.expired`]);
  assert.equal(await sender.expire(lab, nonce), false, 'nothing left to expire');
  assert.deepEqual(await inbox(dir, lab, clock).claimAll(), [], 'a window that opens later claims nothing');
});

test('an empty window claims nothing', async (t) => {
  const dir = tempDir(t);
  const lab = tempDir(t);
  const clock = fakeClock();
  const nonce = await inbox(dir, undefined, clock).send(lab, { kind: 'open', sessionIds: [A] });
  const empty = new HandoffInbox(dir, { pid: process.pid, folder: ownsFolder() }, clock.read);

  assert.deepEqual(await empty.claimAll(), []);
  assert.deepEqual(inboxFiles(empty, dir, lab), [`${nonce}.json`]);
});

test('a multi-root window whose first folder matches does not claim', async (t) => {
  const dir = tempDir(t);
  const lab = tempDir(t);
  const clock = fakeClock();
  const nonce = await inbox(dir, undefined, clock).send(lab, { kind: 'open', sessionIds: [A] });
  stub.workspace.workspaceFolders = [{ uri: { fsPath: lab } }, { uri: { fsPath: tempDir(t) } }];
  const multiRoot = new HandoffInbox(dir, { pid: process.pid, folder: ownsFolder() }, clock.read);

  assert.deepEqual(await multiRoot.claimAll(), []);
  stub.workspace.workspaceFolders = [{ uri: { fsPath: lab } }];
  stub.workspace.workspaceFile = { fsPath: path.join(lab, 'lab.code-workspace') };
  const workspaceFile = new HandoffInbox(dir, { pid: process.pid, folder: ownsFolder() }, clock.read);
  assert.deepEqual(await workspaceFile.claimAll(), []);
  assert.deepEqual(inboxFiles(multiRoot, dir, lab), [`${nonce}.json`]);
});

test('complete writes an outcome the sender reads', async (t) => {
  const dir = tempDir(t);
  const lab = tempDir(t);
  const clock = fakeClock();
  const sender = inbox(dir, undefined, clock);
  const claimer = inbox(dir, lab, clock);
  const opened = await sender.send(lab, { kind: 'open', sessionIds: [A] });
  const refused = await sender.send(lab, { kind: 'open', sessionIds: [B] });
  assert.equal(await sender.outcome(lab, opened), undefined, 'no outcome before a claim');

  assert.equal((await claimer.claimAll()).length, 2);
  clock.now += 900;
  await claimer.complete(opened, { ok: true });
  await claimer.complete(refused, { ok: false, error: 'Claude Code is not active' });

  assert.deepEqual(await sender.outcome(lab, opened), { ok: true });
  assert.deepEqual(await sender.outcome(lab, refused), { ok: false, error: 'Claude Code is not active' });
  assert.ok(inboxFiles(sender, dir, lab).includes(`${opened}.done-${process.pid}`));
  assert.ok(claimer.lines.includes(`[Pitwall] handoff opened ${opened.slice(0, 8)} after 900 ms`), claimer.lines.join('\n'));
  assert.ok(claimer.lines.includes(`[Pitwall] handoff failed ${refused.slice(0, 8)} Claude Code is not active`), claimer.lines.join('\n'));
});

test('old claimed, done, expired and tmp files are swept after 10 min, and requests after 120 s', async (t) => {
  const dir = tempDir(t);
  const lab = tempDir(t);
  const other = tempDir(t);
  const clock = fakeClock(Date.now());
  const sender = inbox(dir, undefined, clock);
  const claimer = inbox(dir, lab, clock);
  const claimed = await sender.send(lab, { kind: 'open', sessionIds: [A] });
  await claimer.claimAll();
  await claimer.complete(claimed, { ok: true });
  const expired = await sender.send(lab, { kind: 'open', sessionIds: [B] });
  await sender.expire(lab, expired);
  const pending = await sender.send(other, { kind: 'new', sessionIds: [] });
  const otherDir = path.join(dir, 'pitwall-handoff', sender.folderKey(other));
  fs.writeFileSync(path.join(otherDir, 'b1d2c3e4-0000-4000-8000-000000000000.tmp'), '{');

  clock.now += EXPIRE_MS - 1_000;
  await sender.sweep();
  assert.equal(inboxFiles(sender, dir, lab).length, 3, 'nothing is old yet');
  assert.equal(inboxFiles(sender, dir, other).length, 2);

  clock.now += 2_000;
  await sender.sweep();
  assert.deepEqual(inboxFiles(sender, dir, other), ['b1d2c3e4-0000-4000-8000-000000000000.tmp'], `${pending}.json is past 120 s`);
  assert.equal(inboxFiles(sender, dir, lab).length, 3, 'claimed, done and expired stay for 10 min');

  clock.now += SWEEP_AGE_MS;
  await sender.sweep();
  assert.deepEqual(inboxFiles(sender, dir, lab), []);
  assert.deepEqual(inboxFiles(sender, dir, other), []);
});

test('a request whose sender died is not opened by a window that arrives after 120 s', async (t) => {
  const dir = tempDir(t);
  const lab = tempDir(t);
  const clock = fakeClock();
  const nonce = await inbox(dir, undefined, clock).send(lab, { kind: 'new', sessionIds: [] });
  clock.now += EXPIRE_MS + 1;
  const late = inbox(dir, lab, clock);

  assert.deepEqual(await late.claimAll(), []);
  assert.ok(late.lines.includes(`[Pitwall] handoff expired ${nonce.slice(0, 8)}`), late.lines.join('\n'));
  assert.deepEqual(inboxFiles(late, dir, lab), [`${nonce}.expired`]);
});

test('a malformed request is deleted and ignored', async (t) => {
  const dir = tempDir(t);
  const lab = tempDir(t);
  const clock = fakeClock();
  const claimer = inbox(dir, lab, clock);
  const folderDir = path.join(dir, 'pitwall-handoff', claimer.folderKey(lab));
  fs.mkdirSync(folderDir, { recursive: true });
  const good: HandoffRequest = { v: 1, kind: 'open', sessionIds: [A], folder: lab, at: clock.now, nonce: '' };
  const bad: Record<string, unknown>[] = [
    { ...good, v: 2 },
    { ...good, kind: 'deleteEverything' },
    { ...good, sessionIds: ['--help'] },
    { ...good, sessionIds: A },
    { ...good, folder: tempDir(t) },
    { ...good, at: 'soon' },
  ];
  const nonces = bad.map((request, index) => {
    const nonce = `0000000${index}-0000-4000-8000-000000000000`;
    fs.writeFileSync(path.join(folderDir, `${nonce}.json`), JSON.stringify({ ...request, nonce }));
    return nonce;
  });
  fs.writeFileSync(path.join(folderDir, 'c0ffee00-0000-4000-8000-000000000000.json'), 'not json');
  fs.writeFileSync(
    path.join(folderDir, 'c0ffee01-0000-4000-8000-000000000000.json'),
    JSON.stringify({ ...good, nonce: 'c0ffee99-0000-4000-8000-000000000000' })
  );

  assert.deepEqual(await claimer.claimAll(), []);
  assert.deepEqual(fs.readdirSync(folderDir), [], `deleted: ${nonces.join(', ')}`);
});

test('rename retries EPERM once and succeeds', async (t) => {
  const dir = tempDir(t);
  const from = path.join(dir, 'a.json');
  const to = path.join(dir, 'b.json');
  fs.writeFileSync(from, '{}');
  let calls = 0;
  const flaky = async (src: string, dest: string) => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    await fs.promises.rename(src, dest);
  };

  assert.equal(await renameRetrying(from, to, flaky), 'ok');
  assert.equal(calls, 2);
  assert.ok(fs.existsSync(to));
  assert.equal(await renameRetrying(from, to), 'lost', 'ENOENT means another window won');

  let busy = 0;
  const alwaysBusy = async () => {
    busy++;
    throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
  };
  await assert.rejects(renameRetrying(to, from, alwaysBusy), /EBUSY/);
  assert.equal(busy, 4, 'one try and 3 retries');
});

test('pending finds an open request for the same folder, kind and ids', async (t) => {
  const dir = tempDir(t);
  const lab = tempDir(t);
  const clock = fakeClock();
  const sender = inbox(dir, undefined, clock);
  const nonce = await sender.send(lab, { kind: 'openAll', sessionIds: [A, B] });

  assert.equal(await sender.pending(lab + path.sep, 'openAll', [B, A]), nonce, 'same ids in another order');
  assert.equal(await sender.pending(lab, 'open', [A, B]), undefined, 'another kind');
  assert.equal(await sender.pending(lab, 'openAll', [A]), undefined, 'other ids');
  assert.equal(await sender.pending(tempDir(t), 'openAll', [A, B]), undefined, 'another folder');
  clock.now += EXPIRE_MS;
  assert.equal(await sender.pending(lab, 'openAll', [A, B]), undefined, 'past 120 s it is no longer pending');
  clock.now -= EXPIRE_MS;
  await inbox(dir, lab, clock).claimAll();
  assert.equal(await sender.pending(lab, 'openAll', [A, B]), undefined, 'claimed');
});

test('watch creates a missing folder and the beat backstop claims without an fs event', async (t) => {
  const dir = tempDir(t);
  const lab = tempDir(t);
  const clock = fakeClock(Date.now());
  const claimer = inbox(dir, lab, clock);
  const folderDir = path.join(dir, 'pitwall-handoff', claimer.folderKey(lab));
  const received: HandoffRequest[][] = [];
  const watching = claimer.watch((requests) => received.push(requests), { backstopMs: 20, watchFs: false });
  t.after(() => watching.dispose());
  assert.ok(fs.existsSync(folderDir), 'watch created the inbox folder');
  await new Promise((resolve) => setTimeout(resolve, 50)); // its activation claim finds nothing

  const nonce = await inbox(dir, undefined, clock).send(lab, { kind: 'open', sessionIds: [A] });
  await waitFor(() => received.length > 0, 'the backstop claim');
  assert.deepEqual(received.flat().map((request) => request.nonce), [nonce]);

  watching.dispose();

  // With no backstop and no fs events, window focus claims.
  const focusOnly = claimer.watch((requests) => received.push(requests), { backstopMs: Infinity, watchFs: false });
  t.after(() => focusOnly.dispose());
  await new Promise((resolve) => setTimeout(resolve, 50)); // its activation claim finds nothing
  const second = await inbox(dir, undefined, clock).send(lab, { kind: 'open', sessionIds: [B] });
  stub.window.__fireWindowState(false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received.flat().length, 1, 'losing focus claims nothing');
  stub.window.__fireWindowState(true);
  await waitFor(() => received.flat().some((request) => request.nonce === second), 'the focus claim');
});

test('the dump script finds only allowed keys in the files the inbox and registry write (E17)', async (t) => {
  const dir = tempDir(t);
  const lab = tempDir(t);
  const clock = fakeClock(Date.now());
  await new WindowRegistry(dir, { pid: process.pid, folder: lab }, clock.read).beat([A]);
  const sender = inbox(dir, undefined, clock);
  const claimer = inbox(dir, lab, clock);
  const opened = await sender.send(lab, { kind: 'open', sessionIds: [A] });
  await claimer.claimAll();
  await claimer.complete(opened, { ok: false, error: 'Claude Code is not active' });
  const expired = await sender.send(lab, { kind: 'new', sessionIds: [] });
  await sender.expire(lab, expired);
  await sender.send(lab, { kind: 'openAll', sessionIds: [A, B] });

  // The bundle runs from test/dry/.build, so the repo root is three levels up.
  const script = path.resolve(__dirname, '..', '..', '..', 'scripts', 'dump-pitwall-windows.mjs');
  const run = (...args: string[]) => spawnSync(process.execPath, [script, '--dir', dir, ...args], { encoding: 'utf8' });
  const ok = run('--check-privacy');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /privacy ok: 5 files checked/);
  assert.match(ok.stdout, new RegExp(`${process.pid} .+ open=1`));
  assert.match(ok.stdout, /pending [0-9a-f]{8} openAll/);
  assert.match(ok.stdout, new RegExp(`claimed by ${process.pid} ${opened.slice(0, 8)} open .+ -> failed: Claude Code is not active`));
  assert.match(ok.stdout, new RegExp(`expired ${expired.slice(0, 8)} new`));

  const folderDir = path.join(dir, 'pitwall-handoff', sender.folderKey(lab));
  fs.writeFileSync(path.join(folderDir, `${opened}.done-1`), JSON.stringify({ ok: true, at: 1, text: 'a transcript line' }));
  const leak = run('--check-privacy');
  assert.equal(leak.status, 1, leak.stdout);
  assert.match(leak.stdout, /keys outside the outcome allow-list: text/);
});
