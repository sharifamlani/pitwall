/**
 * Who owns a session's live process (Q28, QA #52 C1, v0.6.0 own-window fork):
 * a live Claude panel whose parent is this extension host is this window's
 * own (`here`), which the router brings forward and never opens a second
 * time; another panel or a terminal is an outsider. The parent lookup is
 * async and times out; a failed lookup is never taken as "not live".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLiveProcess } from '../../../src/core/windows/outsideProcess';
import { cachedParentPid, parentPidOf } from '../../../src/core/utils/parentPid';

const HOST = 5000;

test("a panel whose parent is this extension host is this window's own: live here, never 'not live'", async () => {
  assert.deepEqual(await classifyLiveProcess({ pid: 9, panel: true }, { hostPid: HOST, parentPidOf: async () => HOST }), { pid: 9, panel: true, here: true });
  assert.deepEqual(await classifyLiveProcess({ pid: 9, panel: true, cwd: 'pitwall' }, { hostPid: HOST, parentPidOf: async () => HOST }), { pid: 9, panel: true, cwd: 'pitwall', here: true });
});

test('a panel with another parent is a window Pitwall cannot see; a terminal never asks for the parent', async () => {
  assert.deepEqual(await classifyLiveProcess({ pid: 9, panel: true }, { hostPid: HOST, parentPidOf: async () => 1234 }), { pid: 9, panel: true });
  let asked = 0;
  const terminal = await classifyLiveProcess({ pid: 8, panel: false }, { hostPid: HOST, parentPidOf: async () => void asked++ });
  assert.deepEqual(terminal, { pid: 8, panel: false });
  assert.equal(asked, 0);
  assert.equal(await classifyLiveProcess(undefined, { hostPid: HOST, parentPidOf: async () => 1 }), undefined);
});

test("the record's cwd passes through to the router, which routes a panel by it (W4(b))", async () => {
  assert.deepEqual(await classifyLiveProcess({ pid: 9, panel: true, cwd: 'uj-lab-b' }, { hostPid: HOST, parentPidOf: async () => 1234 }), { pid: 9, panel: true, cwd: 'uj-lab-b' });
  assert.deepEqual(await classifyLiveProcess({ pid: 8, panel: false, cwd: 'uj-lab-t' }, { hostPid: HOST, parentPidOf: async () => 1234 }), { pid: 8, panel: false, cwd: 'uj-lab-t' });
});

test("a failed parent lookup is a live process of unknown window: never 'not live', never 'here'", async () => {
  assert.deepEqual(await classifyLiveProcess({ pid: 9, panel: true }, { hostPid: HOST, parentPidOf: async () => undefined }), { pid: 9, panel: true });
});

test('parentPidOf reads the parent through an async exec with a timeout, and answers undefined on failure', async () => {
  const calls: { file: string; timeout: number | undefined }[] = [];
  const ok = await parentPidOf(42, {
    platform: 'linux',
    timeoutMs: 1500,
    exec: async (file, _args, options) => {
      calls.push({ file, timeout: options.timeout });
      return '  777\n';
    },
  });
  assert.equal(ok, 777);
  assert.deepEqual(calls, [{ file: 'ps', timeout: 1500 }]);
  const win = await parentPidOf(42, { platform: 'win32', exec: async () => 'ParentProcessId=321\r\n' });
  assert.equal(win, 321);
  assert.equal(await parentPidOf(42, { platform: 'linux', exec: async () => { throw new Error('timed out'); } }), undefined);
  assert.equal(await parentPidOf(42, { platform: 'linux', exec: async () => 'garbage' }), undefined);
});

test('the Windows lookup waits long enough for a loaded machine: 1.4-1.6 s idle must not time out', async () => {
  const timeouts: (number | undefined)[] = [];
  await parentPidOf(42, { platform: 'win32', exec: async (_file, _args, options) => (timeouts.push(options.timeout), 'ParentProcessId=1') });
  assert.ok((timeouts[0] ?? 0) >= 5_000, `timeout ${timeouts[0]} ms`);
});

test("a pid's parent is asked of the OS once: the second call is answered from the cache; a failure is asked again", async () => {
  const asked: number[] = [];
  let fail = true;
  const lookup = cachedParentPid(async (pid) => {
    asked.push(pid);
    if (pid === 13 && fail) {
      return undefined;
    }
    return pid * 10;
  });
  assert.equal(await lookup(42, 'p42'), 420);
  assert.equal(await lookup(42, 'p42'), 420);
  assert.deepEqual(asked, [42], 'the second call never reached the OS');
  // Two clicks at once share one lookup.
  assert.deepEqual(await Promise.all([lookup(7, 'p7'), lookup(7, 'p7')]), [70, 70]);
  assert.deepEqual(asked, [42, 7]);
  // A timed-out lookup is not remembered as "no parent".
  assert.equal(await lookup(13, 'p13'), undefined);
  fail = false;
  assert.equal(await lookup(13, 'p13'), 130);
  assert.deepEqual(asked, [42, 7, 13, 13]);
  // A process with nothing to name it by is never cached.
  await lookup(8);
  await lookup(8);
  assert.deepEqual(asked, [42, 7, 13, 13, 8, 8]);
});

test('a reused pid is a new process: the same pid with a new identity is asked of the OS again (QA #72)', async () => {
  const asked: number[] = [];
  let parent = HOST;
  const lookup = cachedParentPid(async (pid) => (asked.push(pid), parent));
  // This window's old panel ran at pid 9 ...
  assert.equal(await lookup(9, '1790000000000'), HOST);
  // ... exited, and another window's panel got pid 9.
  parent = 1234;
  assert.equal(await lookup(9, '1790000999000'), 1234, 'never the old answer for a new process');
  assert.equal(await lookup(9, '1790000999000'), 1234);
  assert.deepEqual(asked, [9, 9]);
});

test('classifyLiveProcess names the process by its start time, else its session, for the parent lookup', async () => {
  const identities: (string | undefined)[] = [];
  const deps = { hostPid: HOST, parentPidOf: async (_pid: number, identity?: string) => (identities.push(identity), HOST) };
  assert.deepEqual(await classifyLiveProcess({ pid: 9, panel: true, startedAt: 1790000000000, sessionId: 's1' }, deps), { pid: 9, panel: true, here: true });
  await classifyLiveProcess({ pid: 9, panel: true, sessionId: 's2' }, deps);
  assert.deepEqual(identities, ['1790000000000', 's2']);
});

test('a rejected lookup is not cached: the next call asks again (C2)', async () => {
  let calls = 0;
  const lookup = cachedParentPid(async () => {
    calls++;
    if (calls === 1) {
      throw new Error('powershell died');
    }
    return 77;
  });
  assert.equal(await lookup(5, 'a'), undefined);
  assert.equal(await lookup(5, 'a'), 77);
  assert.equal(await lookup(5, 'a'), 77);
  assert.equal(calls, 2);
});

test('the cache holds at most 64 processes: the oldest falls out and is asked again (C4)', async () => {
  const asked: number[] = [];
  const lookup = cachedParentPid(async (pid) => (asked.push(pid), 1));
  for (let pid = 1; pid <= 65; pid++) {
    await lookup(pid, 'x');
  }
  asked.length = 0;
  await lookup(2, 'x');
  await lookup(65, 'x');
  assert.deepEqual(asked, [], 'the newest 64 are still known');
  await lookup(1, 'x');
  assert.deepEqual(asked, [1], 'the 65th entry pushed the first out');
});
