import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  ClaudeSessionsFile,
  localPidDomain,
  WATCH_DEBOUNCE_MS,
  WATCH_MAX_WAIT_MS,
} from '../../../../src/harnesses/claude/ClaudeSessionsFile';
import { tempDir, waitFor } from '../../support';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DOMAIN = 'test:pitwall-domain';

/** Writes `<pid>.json` the way Claude Code does, with only the fields Pitwall reads plus a few it must ignore. */
function writeSession(dir: string, record: Record<string, unknown>, name = `${record.pid}.json`): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    JSON.stringify({
      cwd: '/work/demo',
      pidDomain: DOMAIN,
      kind: 'interactive',
      entrypoint: 'cli',
      procStart: '1234',
      ...record,
    })
  );
  return file;
}

function sessionsFile(dir: string, alive: Set<number> | ((pid: number) => boolean) = () => true) {
  const isAlive = typeof alive === 'function' ? alive : (pid: number) => alive.has(pid);
  return new ClaudeSessionsFile({ dir: () => dir, isAlive, pidDomain: async () => DOMAIN });
}

/** Records every path handed to the fs calls that open, read or stat a file. */
function spyOnFileAccess(t: { mock: { method: (obj: object, name: string, impl: (...args: unknown[]) => unknown) => unknown } }): string[] {
  const touched: string[] = [];
  const wrap = (obj: Record<string, unknown>, name: string) => {
    const original = obj[name] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof original !== 'function') {
      return;
    }
    t.mock.method(obj, name, function (this: unknown, ...args: unknown[]) {
      touched.push(String(args[0]));
      return original.apply(this, args);
    });
  };
  // The real module object: the bundled `import * as fs` is a getter wrapper that cannot be mocked.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realFs = require('fs') as typeof fs;
  const promises = realFs.promises as unknown as Record<string, unknown>;
  for (const name of ['readFile', 'open', 'stat', 'lstat', 'access', 'readdir', 'opendir']) {
    wrap(promises, name);
  }
  const sync = realFs as unknown as Record<string, unknown>;
  for (const name of ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'existsSync', 'accessSync', 'createReadStream', 'readFile', 'open', 'stat', 'lstat']) {
    wrap(sync, name);
  }
  return touched;
}

test('reads status, waitingFor and pid from each .json and never opens .key files', async (t) => {
  const dir = path.join(tempDir(t), 'sessions');
  const json = writeSession(dir, {
    pid: 4242,
    sessionId: 'session-a',
    status: 'waiting',
    waitingFor: 'permission prompt',
    statusUpdatedAt: 1_800_000_000_123,
    cwd: '/work/demo',
  });
  writeSession(dir, { pid: 4343, sessionId: 'session-b', status: 'busy', statusUpdatedAt: 1_800_000_000_000 });
  // The real folder keeps a key file beside each session file.
  const key = path.join(dir, '4242.0123456789abcdef.key');
  fs.writeFileSync(key, 'not for pitwall');

  const touched = spyOnFileAccess(t);
  const before = Date.now();
  const snapshot = await sessionsFile(dir).snapshot();

  assert.equal(snapshot.available, true);
  assert.ok(snapshot.observedAt >= before && snapshot.observedAt <= Date.now(), 'stamped with the read time');
  assert.deepEqual(snapshot.states.get('session-a'), {
    status: 'waiting',
    waitingFor: 'permission prompt',
    statusUpdatedAt: 1_800_000_000_123,
    pid: 4242,
    cwd: '/work/demo',
    entrypoint: 'cli',
  });
  assert.deepEqual(snapshot.states.get('session-b')?.status, 'busy');
  assert.equal(snapshot.states.get('session-b')?.waitingFor, undefined, 'only a waiting session has a reason');
  assert.ok(touched.some((p) => path.resolve(p) === path.resolve(json)), 'the session file was read');
  assert.deepEqual(touched.filter((p) => p.endsWith('.key')), [], 'no fs call ever names a .key file');
});

test('a waiting session without a reason still gets one', async (t) => {
  const dir = path.join(tempDir(t), 'sessions');
  writeSession(dir, { pid: 11, sessionId: 's', status: 'waiting', statusUpdatedAt: 5 });
  assert.equal((await sessionsFile(dir).snapshot()).states.get('s')?.waitingFor, 'input needed');
});

test('a file whose pid is not alive is dropped', async (t) => {
  const dir = path.join(tempDir(t), 'sessions');
  writeSession(dir, { pid: 100, sessionId: 'alive', status: 'busy', statusUpdatedAt: 1 });
  writeSession(dir, { pid: 200, sessionId: 'crashed', status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: 1 });
  const snapshot = await sessionsFile(dir, new Set([100])).snapshot();
  assert.deepEqual([...snapshot.states.keys()], ['alive']);
  assert.equal(snapshot.unknownStatus.has('crashed'), false);

  const none = await sessionsFile(dir, new Set()).snapshot();
  assert.equal(none.available, false, 'no live file means the folder does not count');
});

test('a missing or empty folder reports available: false', async (t) => {
  const root = tempDir(t);
  const missing = await sessionsFile(path.join(root, 'nope')).snapshot();
  assert.equal(missing.available, false);
  assert.equal(missing.states.size, 0);

  const empty = path.join(root, 'sessions');
  fs.mkdirSync(empty);
  fs.writeFileSync(path.join(empty, '9.0123abcd.key'), 'x');
  assert.equal((await sessionsFile(empty).snapshot()).available, false, 'a folder holding only key files is empty');
});

test('a malformed file is skipped, the rest still read', async (t) => {
  const dir = path.join(tempDir(t), 'sessions');
  writeSession(dir, { pid: 1001, sessionId: 'good', status: 'idle', statusUpdatedAt: 1 });
  fs.writeFileSync(path.join(dir, '1002.json'), '{"pid": 1002, "sessionId": "torn", "sta');
  fs.writeFileSync(path.join(dir, '1003.json'), '[1, 2, 3]');
  writeSession(dir, { pid: 'not-a-pid', sessionId: 'bad-pid', status: 'busy', statusUpdatedAt: 1 }, '1004.json');
  const snapshot = await sessionsFile(dir).snapshot();
  assert.equal(snapshot.available, true);
  assert.deepEqual([...snapshot.states.keys()], ['good']);
  assert.equal(snapshot.partial, true, 'an unreadable file makes the snapshot partial');
});

test('a session has ended only when an earlier read saw it live and a complete read no longer does (P2 K4)', async (t) => {
  const dir = path.join(tempDir(t), 'sessions');
  const alive = new Set([4242, 4343]);
  const file = writeSession(dir, { pid: 4242, sessionId: 'lab-notes', status: 'idle', statusUpdatedAt: 1 });
  writeSession(dir, { pid: 4343, sessionId: 'other', status: 'busy', statusUpdatedAt: 1 });
  const sessions = sessionsFile(dir, alive);

  assert.equal(await sessions.ended('lab-notes'), false, 'live');
  assert.equal(await sessions.ended('no-record'), false, 'never seen live (an agent that writes no record) is never called ended');

  // /exit: the process is gone; its file may linger a moment, then goes.
  alive.delete(4242);
  assert.equal(await sessions.ended('lab-notes'), true, 'the dead pid no longer counts');
  fs.rmSync(file);
  assert.equal(await sessions.ended('lab-notes'), true);

  // A torn file proves nothing: the session could be in it.
  const torn = path.join(dir, '5000.json');
  fs.writeFileSync(torn, '{"pid": 5000, "sessionId": "lab-no');
  assert.equal(await sessions.ended('lab-notes'), false, 'a partial read never proves a session ended');
  fs.rmSync(torn);

  // Resumed again: live once more.
  alive.add(4242);
  writeSession(dir, { pid: 4242, sessionId: 'lab-notes', status: 'busy', statusUpdatedAt: 2 });
  assert.equal(await sessions.ended('lab-notes'), false);
});

test('after /clear the same process runs on under a new session id: the old id never reads as ended while that pid lives (QA on #75)', async (t) => {
  const dir = path.join(tempDir(t), 'sessions');
  const alive = new Set([4242]);
  writeSession(dir, { pid: 4242, sessionId: 'lab-notes', status: 'idle', statusUpdatedAt: 1 });
  const sessions = sessionsFile(dir, alive);
  assert.equal(await sessions.ended('lab-notes'), false, 'live');

  // /clear: Claude rewrites its own <pid>.json with the new session id.
  writeSession(dir, { pid: 4242, sessionId: 'after-clear', status: 'idle', statusUpdatedAt: 2 });
  assert.equal(await sessions.ended('lab-notes'), false, 'pid 4242 still runs: a click must never treat its terminal as a dead shell');
  // Under a status this build doesn't know, still the same live process.
  writeSession(dir, { pid: 4242, sessionId: 'after-clear', status: 'compacting', statusUpdatedAt: 3 });
  assert.equal(await sessions.ended('lab-notes'), false);

  // That process exits: now the session it ran is provably gone.
  alive.delete(4242);
  assert.equal(await sessions.ended('lab-notes'), true);

  // Its pid is reused by another live record: "not ended", the safe direction.
  alive.add(4242);
  writeSession(dir, { pid: 4242, sessionId: 'someone-else', status: 'busy', statusUpdatedAt: 4 });
  assert.equal(await sessions.ended('lab-notes'), false);
});

test('a session seen live only under an unknown status reads as ended once its process is gone (QA R4 on #75)', async (t) => {
  const dir = path.join(tempDir(t), 'sessions');
  const alive = new Set([62]);
  writeSession(dir, { pid: 62, sessionId: 'odd-only', status: 'compacting', statusUpdatedAt: 1 });
  const sessions = sessionsFile(dir, alive);
  assert.equal(await sessions.ended('odd-only'), false, 'live, status unknown to this build');
  alive.delete(62);
  assert.equal(await sessions.ended('odd-only'), true, 'its pid is gone from a complete read');
});

test('an unknown status or an unreadable pid domain never reads as ended', async (t) => {
  const dir = path.join(tempDir(t), 'sessions');
  writeSession(dir, { pid: 61, sessionId: 'odd', status: 'idle', statusUpdatedAt: 1 });
  const sessions = sessionsFile(dir);
  assert.equal(await sessions.ended('odd'), false);
  // Still running, under a status this build doesn't know.
  writeSession(dir, { pid: 61, sessionId: 'odd', status: 'compacting', statusUpdatedAt: 2 });
  assert.equal(await sessions.ended('odd'), false, 'live with an unknown status');

  // This machine's pid domain can't be read: no pid can be checked, so it never sees a
  // session live, and never calls one ended.
  const blind = new ClaudeSessionsFile({ dir: () => dir, isAlive: () => true, pidDomain: async () => undefined });
  writeSession(dir, { pid: 61, sessionId: 'odd', status: 'idle', statusUpdatedAt: 3 });
  assert.equal(await blind.ended('odd'), false);
  fs.rmSync(path.join(dir, '61.json'));
  assert.equal(await blind.ended('odd'), false);
});

test('a file from another pidDomain is ignored', async (t) => {
  const dir = path.join(tempDir(t), 'sessions');
  writeSession(dir, { pid: 1, sessionId: 'pid-one', status: 'busy', statusUpdatedAt: 1 }, '1.json');
  writeSession(dir, { pid: 300, sessionId: 'here', status: 'busy', statusUpdatedAt: 1 });
  writeSession(dir, { pid: 301, sessionId: 'container', status: 'waiting', statusUpdatedAt: 1, pidDomain: 'linux:abc:pid:[4026531836]' });
  writeSession(dir, { pid: 302, sessionId: 'old-cli', status: 'busy', statusUpdatedAt: 1, pidDomain: undefined });
  const checked: number[] = [];
  const snapshot = await sessionsFile(dir, (pid) => {
    checked.push(pid);
    return true;
  }).snapshot();
  assert.deepEqual([...snapshot.states.keys()], ['here']);
  assert.deepEqual(checked, [300], 'a foreign pid is never checked against this machine');
});

test('EPERM from the pid check counts as alive', async (t) => {
  const dir = path.join(tempDir(t), 'sessions');
  writeSession(dir, { pid: 500, sessionId: 'protected', status: 'busy', statusUpdatedAt: 1 });
  writeSession(dir, { pid: 501, sessionId: 'gone', status: 'busy', statusUpdatedAt: 1 });
  writeSession(dir, { pid: 502, sessionId: 'running', status: 'busy', statusUpdatedAt: 1 });
  const fail = (code: string) => {
    throw Object.assign(new Error(code), { code });
  };
  const signals: unknown[] = [];
  t.mock.method(process, 'kill', (pid: number, signal: unknown) => {
    signals.push(signal);
    if (pid === 500) fail('EPERM');
    if (pid === 501) fail('ESRCH');
    return true;
  });
  // The default pid check: no isAlive option.
  const snapshot = await new ClaudeSessionsFile({ dir: () => dir, pidDomain: async () => DOMAIN }).snapshot();
  assert.deepEqual([...snapshot.states.keys()].sort(), ['protected', 'running']);
  assert.ok(signals.every((signal) => signal === 0), 'the check sends signal 0 only');
});

test('an unknown status value falls back to claude agents for that session', async (t) => {
  const dir = path.join(tempDir(t), 'sessions');
  writeSession(dir, { pid: 600, sessionId: 'known', status: 'busy', statusUpdatedAt: 1 });
  writeSession(dir, { pid: 601, sessionId: 'future', status: 'compacting', statusUpdatedAt: 1 });
  writeSession(dir, { pid: 602, sessionId: 'no-status', statusUpdatedAt: 1 });
  const snapshot = await sessionsFile(dir).snapshot();
  assert.deepEqual([...snapshot.states.keys()], ['known']);
  assert.deepEqual([...snapshot.unknownStatus].sort(), ['future', 'no-status']);

  const onlyUnknown = path.join(tempDir(t), 'sessions');
  writeSession(onlyUnknown, { pid: 700, sessionId: 'future', status: 'compacting', statusUpdatedAt: 1 });
  assert.equal((await sessionsFile(onlyUnknown).snapshot()).available, false, 'only counted statuses make the folder available');
});

test('two files for one sessionId: the newest statusUpdatedAt wins', async (t) => {
  const dir = path.join(tempDir(t), 'sessions');
  writeSession(dir, { pid: 800, sessionId: 'dup', status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: 2_000 });
  writeSession(dir, { pid: 801, sessionId: 'dup', status: 'busy', statusUpdatedAt: 3_000 });
  writeSession(dir, { pid: 802, sessionId: 'dup', status: 'idle', statusUpdatedAt: 1_000 });
  const snapshot = await sessionsFile(dir).snapshot();
  assert.deepEqual(snapshot.states.get('dup'), { status: 'busy', statusUpdatedAt: 3_000, pid: 801, cwd: '/work/demo', entrypoint: 'cli' });
});

test('concurrent snapshots share one folder read', async (t) => {
  const dir = path.join(tempDir(t), 'sessions');
  writeSession(dir, { pid: 900, sessionId: 's', status: 'busy', statusUpdatedAt: 1 });
  const touched = spyOnFileAccess(t);
  const file = sessionsFile(dir);
  const [a, b] = await Promise.all([file.snapshot(), file.snapshot()]);
  assert.equal(a, b);
  assert.equal(touched.filter((p) => p.endsWith('900.json')).length, 1);
  await file.snapshot();
  assert.equal(touched.filter((p) => p.endsWith('900.json')).length, 2, 'a later tick reads fresh');
});

test('this machine\'s pidDomain matches what Claude Code writes', async () => {
  const domain = await localPidDomain();
  if (process.platform === 'win32') {
    assert.equal(domain, `win32:${require('os').hostname().toLowerCase()}`);
  } else {
    assert.ok(domain.startsWith(`${process.platform}`), domain);
  }
});

test('the probe prints only the allowed fields, drops dead pids and never touches .key files', async (t) => {
  const root = tempDir(t);
  const dir = path.join(root, 'sessions');
  const domain = await localPidDomain();
  writeSession(dir, {
    pid: process.pid,
    sessionId: 'live-session',
    status: 'waiting',
    waitingFor: 'SECRET-REASON',
    statusUpdatedAt: 1_800_000_000_555,
    cwd: '/SECRET/CWD',
    pidDomain: domain,
  });
  writeSession(dir, { pid: 99_999_999, sessionId: 'dead-session', status: 'busy', statusUpdatedAt: 1, pidDomain: domain });
  writeSession(dir, { pid: process.pid, sessionId: 'foreign-session', status: 'busy', statusUpdatedAt: 1, pidDomain: 'elsewhere' }, 'foreign.json');
  fs.writeFileSync(path.join(dir, `${process.pid}.0123456789abcdef.key`), 'SECRET-KEY');
  // Any fs call naming a .key file kills the probe with exit code 97.
  const guard = path.join(root, 'guard.cjs');
  fs.writeFileSync(
    guard,
    `const fs = require('fs');
const check = (p) => { if (String(p).endsWith('.key')) { process.stderr.write('touched a key file\\n'); process.exit(97); } };
const wrap = (obj, names) => { for (const name of names) { const original = obj[name]; if (typeof original !== 'function') continue; obj[name] = function (p, ...rest) { check(p); return original.call(this, p, ...rest); }; } };
wrap(fs, ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'existsSync', 'accessSync', 'createReadStream', 'readFile', 'open', 'stat', 'lstat', 'access']);
wrap(fs.promises, ['readFile', 'open', 'stat', 'lstat', 'access']);
`
  );
  const result = spawnSync(process.execPath, ['-r', guard, path.join(ROOT, 'scripts', 'probe-claude-sessions.mjs'), '--dir', dir], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.ok(lines.includes(`live-session waiting ${process.pid} 1800000000555`), result.stdout);
  assert.ok(lines.includes('dead-session dropped (pid not alive)'), result.stdout);
  assert.ok(!result.stdout.includes('foreign-session busy'), 'another pidDomain is not listed as live');
  assert.ok(!/SECRET/.test(result.stdout + result.stderr), 'no other field is printed');
});

/** Wait `ms` of real time. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('watch fires once per burst of .json writes within 150 ms', async (t) => {
  const dir = path.join(tempDir(t), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  let fired = 0;
  const watching = sessionsFile(dir).watch(() => fired++);
  t.after(() => watching.dispose());
  await sleep(50);

  // A burst: several writes, each well inside 150 ms of the last.
  for (let i = 0; i < 5; i++) {
    writeSession(dir, { pid: 1000 + i, sessionId: `s-${i}`, status: 'busy', statusUpdatedAt: i });
    await sleep(20);
  }
  assert.equal(fired, 0, 'nothing fires while the burst is still going');
  await waitFor(() => fired > 0, 'the debounced change', 2_000);
  await sleep(300);
  assert.equal(fired, 1, 'one change for the whole burst');

  // A second burst after a quiet gap is a second change.
  writeSession(dir, { pid: 1000, sessionId: 's-0', status: 'idle', statusUpdatedAt: 99 });
  await waitFor(() => fired === 2, 'the second burst', 2_000);
  watching.dispose();
});

test('a steady stream of watch events re-polls within 500 ms', async (t) => {
  assert.equal(WATCH_DEBOUNCE_MS, 150);
  assert.equal(WATCH_MAX_WAIT_MS, 500);
  const dir = path.join(tempDir(t), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const fires: number[] = [];
  const watching = sessionsFile(dir).watch(() => fires.push(Date.now()));
  t.after(() => watching.dispose());
  await sleep(50);

  // A write every 50 ms for 1.6 s: a plain 150 ms debounce would not fire until the stream stopped.
  const start = Date.now();
  for (let i = 0; Date.now() - start < 1_600; i++) {
    writeSession(dir, { pid: 2000, sessionId: 's-stream', status: 'busy', statusUpdatedAt: i });
    await sleep(50);
  }
  const during = fires.filter((at) => at < start + 1_600);
  assert.ok(during.length >= 2, `re-polled ${during.length} times while the stream ran`);
  // The first re-poll comes within the max wait, plus slack for the watcher's own delivery.
  assert.ok(during[0] - start <= 500 + 250, `first re-poll after ${during[0] - start} ms`);
  watching.dispose();
});

test('a .key file event never fires and a .key file is never opened', async (t) => {
  const dir = path.join(tempDir(t), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const touched = spyOnFileAccess(t);
  let fired = 0;
  const watching = sessionsFile(dir).watch(() => fired++);
  t.after(() => watching.dispose());
  await sleep(50);

  fs.writeFileSync(path.join(dir, '4242.0123456789abcdef.key'), 'not for pitwall');
  fs.appendFileSync(path.join(dir, '4242.0123456789abcdef.key'), ' still not');
  await sleep(400);
  assert.equal(fired, 0, 'a .key write is not a sessions change');
  assert.deepEqual(touched.filter((p) => p.endsWith('.key')), [], 'no fs call ever names a .key file');

  writeSession(dir, { pid: 4242, sessionId: 's', status: 'busy', statusUpdatedAt: 1 });
  await waitFor(() => fired === 1, 'the .json change', 2_000);
  watching.dispose();
});

test('watch survives the folder being created after start', async (t) => {
  const dir = path.join(tempDir(t), 'sessions');
  let fired = 0;
  const file = new ClaudeSessionsFile({ dir: () => dir, isAlive: () => true, pidDomain: async () => DOMAIN, rewatchMs: 50 });
  const watching = file.watch(() => fired++);
  t.after(() => watching.dispose());
  await sleep(120);

  // An older CLI, or a first run: the folder appears later.
  writeSession(dir, { pid: 77, sessionId: 's', status: 'busy', statusUpdatedAt: 1 });
  await sleep(200);
  writeSession(dir, { pid: 77, sessionId: 's', status: 'idle', statusUpdatedAt: 2 });
  await waitFor(() => fired > 0, 'a change once the folder exists', 3_000);
  watching.dispose();
  const after = fired;
  writeSession(dir, { pid: 77, sessionId: 's', status: 'busy', statusUpdatedAt: 3 });
  await sleep(300);
  assert.equal(fired, after, 'nothing fires after dispose');
});

test('the S2 recorder writes one line per change with only t, sid8, status, waitingFor and statusUpdatedAt, and never touches .key files', async (t) => {
  const root = tempDir(t);
  const dir = path.join(root, 'sessions');
  const domain = await localPidDomain();
  const file = writeSession(dir, {
    pid: process.pid,
    sessionId: 'abcdef12-0000-4000-8000-000000000001',
    status: 'busy',
    statusUpdatedAt: 1_800_000_000_001,
    cwd: '/SECRET/CWD',
    pidDomain: domain,
  });
  fs.writeFileSync(path.join(dir, `${process.pid}.0123456789abcdef.key`), 'SECRET-KEY');
  const guard = path.join(root, 'guard.cjs');
  fs.writeFileSync(
    guard,
    `const fs = require('fs');
const check = (p) => { if (String(p).endsWith('.key')) { process.stderr.write('touched a key file\\n'); process.exit(97); } };
const wrap = (obj, names) => { for (const name of names) { const original = obj[name]; if (typeof original !== 'function') continue; obj[name] = function (p, ...rest) { check(p); return original.call(this, p, ...rest); }; } };
wrap(fs, ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'existsSync', 'accessSync', 'createReadStream', 'readFile', 'open', 'stat', 'lstat', 'access']);
wrap(fs.promises, ['readFile', 'open', 'stat', 'lstat', 'access']);
`
  );
  const out = path.join(root, 'truth.jsonl');
  const { spawn } = await import('child_process');
  const child = spawn(process.execPath, ['-r', guard, path.join(ROOT, 'scripts', 'watch-sessions.mjs'), '--dir', dir, '--out', out, '--duration', '1500']);
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  // Wait for the first sample, then turn the session into a wait.
  for (let i = 0; i < 100 && !(fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('busy')); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  fs.writeFileSync(
    file,
    JSON.stringify({ pid: process.pid, sessionId: 'abcdef12-0000-4000-8000-000000000001', pidDomain: domain, cwd: '/SECRET/CWD', status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: 1_800_000_000_002 })
  );
  assert.equal(await exited, 0, stderr);
  const lines = fs.readFileSync(out, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    lines.map(({ sid8, status, waitingFor, statusUpdatedAt }) => ({ sid8, status, waitingFor, statusUpdatedAt })),
    [
      { sid8: 'abcdef12', status: 'busy', waitingFor: null, statusUpdatedAt: 1_800_000_000_001 },
      { sid8: 'abcdef12', status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: 1_800_000_000_002 },
    ]
  );
  assert.ok(lines.every((line) => Object.keys(line).sort().join() === 'sid8,status,statusUpdatedAt,t,waitingFor'), 'only the five fields');
  assert.ok(!/SECRET/.test(fs.readFileSync(out, 'utf8') + stderr), 'no cwd or key content');
});
