/**
 * The host clock behind a row command's `lag=<ms>ms` (QA #82 D). Driven on a
 * fake timer and clock, so no real time passes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOST_TICK_MS, HostLag } from '../../../src/core/providers/hostLag';

/** A HostLag on a fake clock whose beat the test fires by hand. */
function fakeHostLag() {
  const clock = { now: 1_000_000 };
  const timer: { beat?: () => void; everyMs?: number; stopped: boolean } = { stopped: false };
  const lag = new HostLag(
    () => clock.now,
    (beat, everyMs) => {
      timer.beat = beat;
      timer.everyMs = everyMs;
      return () => {
        timer.stopped = true;
      };
    }
  );
  return { lag, clock, timer };
}

test('a tick that fires 26000 ms late shows the stall at once, though the tick itself is 0 ms old (timer-phase stall)', () => {
  const { lag, clock, timer } = fakeHostLag();
  // A 26 s block inside a timer callback: libuv fires the overdue tick before the queued input.
  clock.now += 26_000;
  timer.beat!();
  assert.equal(lag.lateMs(), 26_000 - HOST_TICK_MS);
});

test('no tick for 26000 ms reads the overdue part', () => {
  const { lag, clock } = fakeHostLag();
  clock.now += 26_000;
  assert.equal(lag.lateMs(), 26_000 - HOST_TICK_MS);
});

test('a prompt host reads 0', () => {
  const { lag, clock, timer } = fakeHostLag();
  assert.equal(timer.everyMs, HOST_TICK_MS, `the clock ticks every ${HOST_TICK_MS} ms`);
  for (let i = 0; i < 4; i++) {
    clock.now += HOST_TICK_MS;
    timer.beat!();
    assert.equal(lag.lateMs(), 0);
  }
  // Between ticks, inside the period: still 0.
  clock.now += HOST_TICK_MS - 1;
  assert.equal(lag.lateMs(), 0);
  // A late tick, then prompt ones again: the stall no longer shows.
  clock.now += 900;
  timer.beat!();
  clock.now += HOST_TICK_MS;
  timer.beat!();
  assert.equal(lag.lateMs(), 0);
});

test('dispose stops the timer', () => {
  const { lag, timer } = fakeHostLag();
  assert.equal(timer.stopped, false);
  lag.dispose();
  assert.equal(timer.stopped, true);
});
