import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  ClaudeSessionsFile,
  localPidDomain,
} from '../../../../src/harnesses/claude/ClaudeSessionsFile';
import { tempDir } from '../../support';

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
