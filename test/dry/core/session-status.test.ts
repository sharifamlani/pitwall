/**
 * The four row statuses (rows 3.3, P16): needs you, working, finished, idle,
 * from the live state, the needs-you list and the chat's "seen" baseline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_WORDS, sessionStatus, statusIconState } from '../../../src/core/providers/sessionStatus';
import { HarnessLiveState } from '../../../src/core/harness/types';

const done = (turnEndedAt: number, extra: Partial<HarnessLiveState> = {}): HarnessLiveState => ({
  turnState: 'done',
  turnEndedAt,
  ...extra,
});
const working = (extra: Partial<HarnessLiveState> = {}): HarnessLiveState => ({ turnState: 'working', turnEndedAt: null, ...extra });

test('sessionStatus covers the four statuses and the waiting/busy/turn combinations', () => {
  const cases: [string, Parameters<typeof sessionStatus>[0], string][] = [
    ['no live state at all', { needsYou: false, seenAt: 100 }, 'idle'],
    ['listed as needing you', { needsYou: true, seenAt: 100 }, 'needs'],
    ['the sessions file says waiting', { live: done(50, { liveStatus: 'waiting' }), needsYou: false, seenAt: 100 }, 'needs'],
    ['waiting while the transcript says working', { live: working({ liveStatus: 'waiting' }), needsYou: false, seenAt: 100 }, 'needs'],
    ['a waiting reason without a process status', { live: working({ waitingFor: 'permission prompt' }), needsYou: false, seenAt: 100 }, 'needs'],
    ['busy in the sessions file', { live: done(50, { liveStatus: 'busy' }), needsYou: false, seenAt: 100 }, 'working'],
    ['mid-turn by the transcript', { live: working(), needsYou: false, seenAt: 100 }, 'working'],
    ['busy and listed: needs wins', { live: working({ liveStatus: 'busy' }), needsYou: true, seenAt: 100 }, 'needs'],
    ['a turn that ended after the baseline', { live: done(200), needsYou: false, seenAt: 100 }, 'finished'],
    ['idle process, turn ended after the baseline', { live: done(200, { liveStatus: 'idle' }), needsYou: false, seenAt: 100 }, 'finished'],
    ['a turn that ended before the baseline', { live: done(50), needsYou: false, seenAt: 100 }, 'idle'],
    ['a turn that ended at the baseline', { live: done(100), needsYou: false, seenAt: 100 }, 'idle'],
    ['a turn end with no time', { live: { turnState: 'done', turnEndedAt: null }, needsYou: false, seenAt: 100 }, 'idle'],
    ['no baseline yet (P16): never finished', { live: done(200), needsYou: false }, 'idle'],
  ];
  for (const [what, input, expected] of cases) {
    assert.equal(sessionStatus(input), expected, what);
  }
});

test('finished turns idle once the chat is seen', () => {
  const live = done(1_000);
  assert.equal(sessionStatus({ live, needsYou: false, seenAt: 500 }), 'finished');
  assert.equal(sessionStatus({ live, needsYou: false, seenAt: 1_500 }), 'idle', 'seen after the turn ended');
  assert.equal(sessionStatus({ live: done(2_000), needsYou: false, seenAt: 1_500 }), 'finished', 'the next turn is news again');
});

test('the row words and dots are the D17 set; an unlinked chat keeps the new ring', () => {
  assert.deepEqual(STATUS_WORDS, { needs: 'needs you', working: 'working', finished: 'finished', idle: 'idle' });
  assert.equal(statusIconState('needs', true), 'needs');
  assert.equal(statusIconState('working', true), 'working');
  assert.equal(statusIconState('finished', true), 'finished');
  assert.equal(statusIconState('idle', true), 'idle');
  assert.equal(statusIconState('idle', false), 'new');
});
