/**
 * The outside-terminal guard's decision (Q28, QA #52 C1): a live Claude panel
 * whose parent is this extension host is this window's own and opens here;
 * another panel or a terminal blocks. The parent lookup is async, times out,
 * and on failure falls back to opening here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outsideProcessOf } from '../../../src/core/windows/outsideProcess';
import { parentPidOf } from '../../../src/core/utils/parentPid';

const HOST = 5000;

test("a panel whose parent is this extension host is this window's own: not outside", async () => {
  assert.equal(await outsideProcessOf({ pid: 9, panel: true }, { hostPid: HOST, parentPidOf: async () => HOST }), undefined);
});

test('a panel with another parent is a window Pitwall cannot see; a terminal never asks for the parent', async () => {
  assert.deepEqual(await outsideProcessOf({ pid: 9, panel: true }, { hostPid: HOST, parentPidOf: async () => 1234 }), { pid: 9, panel: true });
  let asked = 0;
  const terminal = await outsideProcessOf({ pid: 8, panel: false }, { hostPid: HOST, parentPidOf: async () => void asked++ });
  assert.deepEqual(terminal, { pid: 8, panel: false });
  assert.equal(asked, 0);
  assert.equal(await outsideProcessOf(undefined, { hostPid: HOST, parentPidOf: async () => 1 }), undefined);
});

test('a failed parent lookup opens here instead of blocking', async () => {
  assert.equal(await outsideProcessOf({ pid: 9, panel: true }, { hostPid: HOST, parentPidOf: async () => undefined }), undefined);
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
