/**
 * The extension's answer to "a live session no row holds" (Q31, new-chat
 * pickup, PR #73): the targeted import, the retry answer, discovery for a
 * new repo (never on a timer), and the full-refresh fallback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUnlistedLiveHandler } from '../../../src/core/services/unlistedLive';
import type { LiveImportResult } from '../../../src/core/services/SessionImportService';

function wiring(answers: Array<(ids: readonly string[]) => LiveImportResult>, started = true) {
  const calls = { imports: [] as string[][], discovery: 0, refresh: 0, polls: 0, deferred: 0 };
  let scansStarted = started;
  const handler = createUnlistedLiveHandler({
    scansStarted: () => scansStarted,
    deferUntilScans: () => calls.deferred++,
    importLive: async (ids) => {
      calls.imports.push([...ids]);
      const next = answers.shift();
      return next ? next(ids) : { retry: [], unplaced: [], unsupported: [] };
    },
    wakeDiscovery: () => calls.discovery++,
    fullRefresh: () => calls.refresh++,
    pollAttention: () => calls.polls++,
  });
  return { handler, calls, start: () => (scansStarted = true) };
}

const none: LiveImportResult = { retry: [], unplaced: [], unsupported: [] };

test('before the first scans start, an ask is kept for them and answered "ask again"', async () => {
  const { handler, calls } = wiring([], false);
  assert.deepEqual(await handler.ask(['s-1']), ['s-1']);
  assert.deepEqual([calls.deferred, calls.imports.length], [1, 0], 'kept; nothing imported early (E16/I3)');
});

test('a session with nothing to import yet is answered "ask again"; one listed polls attention at once', async () => {
  const { handler, calls } = wiring([() => ({ ...none, retry: ['s-1'] }), () => none]);
  assert.deepEqual(await handler.ask(['s-1']), ['s-1'], 'the attention service retries it with backoff');
  assert.equal(calls.polls, 0);
  assert.deepEqual(await handler.ask(['s-1']), [], 'listed: settled');
  assert.equal(calls.polls, 1, 'its turn is tracked from now, not the next tick');
  assert.deepEqual([calls.discovery, calls.refresh], [0, 0], 'no discovery pass and no full scan for a session in a listed repo');
});

test('a session in an unlisted folder wakes discovery once, is never retried on a timer, and is imported again when discovery adds repos', async () => {
  const { handler, calls } = wiring([
    () => ({ ...none, unplaced: ['s-new-repo'] }),
    () => ({ ...none, unplaced: ['s-new-repo'] }),
    () => none,
  ]);
  assert.deepEqual(await handler.ask(['s-new-repo']), [], 'not retried: each retry would parse its whole transcript again');
  assert.equal(calls.discovery, 1);
  await handler.ask(['s-new-repo']);
  assert.equal(calls.discovery, 1, 'once per session per window');
  await handler.onReposAdded();
  assert.deepEqual(calls.imports.at(-1), ['s-new-repo'], 'discovery added repos: imported again');
  assert.equal(calls.polls, 1, 'and tracked at once');
  await handler.onReposAdded();
  assert.equal(calls.imports.length, 3, 'nothing left to import');
});

test('an adapter that cannot read one session falls back to discovery and one full import scan', async () => {
  const { handler, calls } = wiring([() => ({ ...none, unsupported: ['s-1'] })]);
  assert.deepEqual(await handler.ask(['s-1']), []);
  assert.deepEqual([calls.discovery, calls.refresh], [1, 1]);
});
