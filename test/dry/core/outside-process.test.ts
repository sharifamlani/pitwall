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
  assert.equal(await lookup(42), 420);
  assert.equal(await lookup(42), 420);
  assert.deepEqual(asked, [42], 'the second call never reached the OS');
  // Two clicks at once share one lookup.
  assert.deepEqual(await Promise.all([lookup(7), lookup(7)]), [70, 70]);
  assert.deepEqual(asked, [42, 7]);
  // A timed-out lookup is not remembered as "no parent".
  assert.equal(await lookup(13), undefined);
  fail = false;
  assert.equal(await lookup(13), 130);
  assert.deepEqual(asked, [42, 7, 13, 13]);
});
