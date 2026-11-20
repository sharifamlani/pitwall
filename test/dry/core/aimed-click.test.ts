/**
 * The slot rule behind "the aimed row wins" (D21): a click redirects only to
 * the row that sat in the clicked slot before the move, and opens the
 * clicked row whenever that is unsure. It never picks a third row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  AIM_WINDOW_MS,
  AimedClicks,
  DOUBLE_CLICK_MS,
  HEARTBEAT_MS,
  HEARTBEAT_STALE_MS,
  KEYBOARD_SELECTION_MS,
  aimedRowId,
  type Heartbeat,
} from '../../../src/core/providers/aimedClick';

type Row = { id: string };

/**
 * A test clock with the heartbeat under its control. `advance` lets time pass
 * with the extension host idle (the heartbeat ticks every HEARTBEAT_MS);
 * `stall` lets it pass with the host held (no tick).
 */
function fakeTime(start = 1_000) {
  let now = start;
  let beat: (() => void) | undefined;
  let running = 0;
  const heartbeat: Heartbeat = (fn) => {
    beat = fn;
    running += 1;
    return () => {
      running -= 1;
      beat = undefined;
    };
  };
  return {
    clock: () => now,
    heartbeat,
    running: () => running,
    advance(ms: number) {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + HEARTBEAT_MS);
        beat?.();
      }
    },
    stall(ms: number) {
      now += ms;
    },
  };
}

/** Clicks with an applied-selection log, after a move from `before` to `after`. */
function moved(time: ReturnType<typeof fakeTime>, before: string[], after: string[]) {
  const clicks = new AimedClicks<Row>(time.clock, time.heartbeat);
  const applied: string[][] = [];
  const apply = ({ selection }: { selection: readonly Row[] }) => applied.push(selection.map((row) => row.id));
  clicks.willRedraw(before, false, ['r']);
  clicks.fetched('r', true, () => after);
  return { clicks, applied, apply };
}

/** A click lands on `clicked` and is redirected; Pitwall then reveals and selects the aimed row. */
function redirectedClick(clicks: AimedClicks<Row>, layout: string[], clicked: string, apply: (event: { selection: readonly Row[] }) => void) {
  clicks.select([{ id: clicked }], layout, apply);
  const click = clicks.claim(clicked);
  assert.ok(click, 'the click is redirected');
  clicks.redirected(click);
  clicks.expectSelection(click.aimed);
  clicks.select([{ id: click.aimed }], layout, apply);
  return click.aimed;
}

test('the aimed row is the one the clicked slot held before the move', () => {
  assert.equal(aimedRowId(['r', 'a', 'b', 'c'], ['r', 'b', 'a', 'c'], 'b'), 'a', 'two rows swapped');
  assert.equal(aimedRowId(['r', 'a', 'b'], ['r', 'n', 'a', 'b'], 'a'), 'b', 'a new row shifted the rest down');
  assert.equal(aimedRowId(['r', 'a', 'b'], ['r', 'n', 'a', 'b'], 'n'), 'a', 'a click on the new row is aimed at the old one');
});

test('a list that got shorter never redirects (it may have scrolled up under the pointer)', () => {
  assert.equal(aimedRowId(['r', 'a', 'b', 'c'], ['r', 'b', 'c'], 'c'), undefined);
  assert.equal(aimedRowId(['r', 'a', 'b', 'c', 'd'], ['r', 'b', 'd', 'c'], 'd'), undefined, 'even a row that moved');
});

// QA #80 F1 (zz80-probe.test.ts): keyboard moves follow the focused row by id, not by slot.
test('Up then Enter 120 ms later on a focused row that just moved never opens a third chat', () => {
  let now = 1_000;
  const clicks = new AimedClicks<{ id: string }>(() => now);
  const applied: string[][] = [];
  const apply = ({ selection }: { selection: readonly { id: string }[] }) => applied.push(selection.map((row) => row.id));
  // The user has a selected (and focused) by keyboard.
  clicks.select([{ id: 'a' }], ['r', 'a', 'b', 'c', 'd'], apply);
  // a's chat finishes and re-sorts to the bottom; focus and selection follow a by id.
  const before = ['r', 'a', 'b', 'c', 'd'];
  const after = ['r', 'b', 'c', 'd', 'a'];
  now += 50;
  clicks.willRedraw(before, false, ['r']);
  clicks.fetched('r', true, () => after);
  // 300 ms later the user presses Up (the list selects d, the row above a now), then Enter 120 ms later.
  now += 300;
  clicks.select([{ id: 'd' }], after, apply);
  now += 120;
  const held = clicks.claim('d');
  // The keyboard aimed at d (above a in the new order) or r (above a in the old order); never c.
  assert.ok(!held || held.aimed === 'd' || held.aimed === 'r', `a third chat opened: ${held?.aimed}`);
  assert.deepEqual(applied.at(-1), ['d'], 'the selection is applied as it was');
  clicks.dispose();
});

test("a double-click's second click on the row just redirected goes to the same aimed row", () => {
  const time = fakeTime();
  const { clicks, applied, apply } = moved(time, ['r', 'a', 'b'], ['r', 'b', 'a']);
  // The redirect reveals a (which forgets the order); the second click lands on b again.
  assert.equal(redirectedClick(clicks, ['r', 'b', 'a'], 'b', apply), 'a');
  time.advance(200);
  clicks.select([{ id: 'b' }], ['r', 'b', 'a'], apply);
  assert.equal(clicks.claim('b')?.aimed, 'a', 'a new selection of b');
  assert.ok(!applied.some(([id]) => id === 'b'), "b's selection is held for the redirect, never applied");
  time.advance(100);
  assert.equal(clicks.claim('b')?.aimed, 'a', 'b still selected: the command alone');
  time.advance(DOUBLE_CLICK_MS);
  assert.equal(clicks.claim('b'), undefined, 'a later click is a click of its own');
  clicks.dispose();
});

// QA #80 round 3 G1 (zz80b-probe.test.ts), adapted to a clock whose heartbeat ticks while time passes.
test('after a redirect, an arrow onto the landed-on row then Enter opens that row, not the aimed one (QA #80 G1)', async () => {
  const time = fakeTime();
  const before = ['r', 'a', 'b', 'c'];
  const after = ['r', 'c', 'a', 'b'];
  const { clicks, applied, apply } = moved(time, before, after);
  // A click lands on c (slot 1) 200 ms after the move: redirected to a, which Pitwall selects.
  time.advance(200);
  assert.equal(redirectedClick(clicks, after, 'c', apply), 'a');
  // 150 ms later the user presses Up: the list selects c (above a now). Its pairing window passes unclaimed.
  time.advance(150);
  clicks.select([{ id: 'c' }], after, apply);
  await sleep(80);
  time.advance(80);
  assert.deepEqual(applied.at(-1), ['c'], "the keyboard's selection is applied as it is");
  // Enter 120 ms later, on c, which the keyboard chose.
  time.advance(120);
  const enter = clicks.claim('c');
  assert.equal(enter, undefined, `Enter on c opened ${enter?.aimed}`);
  clicks.dispose();
});

test('after a redirect, any row the user selects ends the double-click: a click back on the landed-on row opens it (QA #80 G1)', () => {
  const time = fakeTime();
  const after = ['r', 'c', 'a', 'b'];
  const { clicks, apply } = moved(time, ['r', 'a', 'b', 'c'], after);
  time.advance(100);
  assert.equal(redirectedClick(clicks, after, 'c', apply), 'a');
  // The user selects b (applied at once: the reveal forgot the old order), then clicks c.
  time.advance(100);
  clicks.select([{ id: 'b' }], after, apply);
  time.advance(100);
  clicks.select([{ id: 'c' }], after, apply);
  assert.equal(clicks.claim('c'), undefined, 'the click on c opens c');
  clicks.dispose();
});

test('a held selection whose command comes too late spends the double-click (QA #80 G1)', () => {
  const time = fakeTime();
  const after = ['r', 'c', 'a', 'b'];
  const { clicks, apply } = moved(time, ['r', 'a', 'b', 'c'], after);
  assert.equal(redirectedClick(clicks, after, 'c', apply), 'a');
  time.advance(100);
  clicks.select([{ id: 'c' }], after, apply); // held as a possible second click
  time.advance(60); // Enter, not a click
  assert.equal(clicks.claim('c'), undefined, 'the late command opens c');
  time.advance(60);
  assert.equal(clicks.claim('c'), undefined, 'and so does the next Enter');
  clicks.dispose();
});

// QA #80 round 3 G2 (zz80b-probe.test.ts): the default timer heartbeat, a clock that jumps with no tick.
test('arrow then Enter that a held extension host handles back to back never pair as a click (QA #80 G2)', () => {
  let now = 1_000;
  const before = ['r', 'a', 'b', 'c', 'd'];
  const after = ['r', 'b', 'c', 'd', 'a'];
  const clicks = new AimedClicks<Row>(() => now);
  const applied: string[][] = [];
  const apply = ({ selection }: { selection: readonly Row[] }) => applied.push(selection.map((row) => row.id));
  clicks.select([{ id: 'a' }], before, apply);
  clicks.willRedraw(before, false, ['r']);
  clicks.fetched('r', true, () => after);
  // The host is busy for 400 ms; the user pressed Up (selects d) at +100 and Enter at +250. Both are handled at +400, 1 ms apart.
  now += 400;
  clicks.select([{ id: 'd' }], after, apply);
  assert.deepEqual(applied.at(-1), ['d'], 'the selection is applied at once, not held as a possible click');
  now += 1;
  const held = clicks.claim('d');
  assert.ok(!held || held.aimed === 'd' || held.aimed === 'r', `a third chat opened: ${held?.aimed}`);
  clicks.dispose();
});

test('a stale heartbeat stops a redirect at the selection and at the command; a fresh one allows it (QA #80 G2)', () => {
  const time = fakeTime();
  const before = ['r', 'a', 'b', 'c'];
  const after = ['r', 'c', 'a', 'b'];
  const { clicks, apply } = moved(time, before, after);
  // A real click while the host is idle: redirected.
  time.advance(HEARTBEAT_STALE_MS * 2);
  assert.equal(redirectedClick(clicks, after, 'c', apply), 'a');
  // The host is held just past the stale limit; then the second click's command (c still selected) arrives.
  time.stall(HEARTBEAT_STALE_MS + 1);
  assert.equal(clicks.claim('c'), undefined, 'the command after a stall opens the clicked row');
  clicks.dispose();

  // A selection handled right after a stall is applied as it is, never held.
  const again = moved(time, before, after);
  time.stall(HEARTBEAT_STALE_MS + 1);
  again.clicks.select([{ id: 'c' }], after, again.apply);
  assert.deepEqual(again.applied.at(-1), ['c']);
  assert.equal(again.clicks.claim('c'), undefined);
  again.clicks.dispose();
});

test('the aim window closes at AIM_WINDOW_MS, even while the heartbeat is still fresh', () => {
  const time = fakeTime();
  const { clicks, apply } = moved(time, ['r', 'a', 'b'], ['r', 'b', 'a']);
  time.advance(AIM_WINDOW_MS - HEARTBEAT_MS);
  clicks.select([{ id: 'b' }], ['r', 'b', 'a'], apply);
  assert.equal(clicks.claim('b')?.aimed, 'a', 'inside the window: aimed');
  clicks.select([{ id: 'r' }], ['r', 'b', 'a'], apply);
  // Just past the window the heartbeat has just ticked, so the host is not held: only the window check stops the redirect.
  time.advance(HEARTBEAT_MS + 1);
  clicks.select([{ id: 'b' }], ['r', 'b', 'a'], apply);
  assert.equal(clicks.claim('b'), undefined, 'past the window: the clicked row');
  clicks.dispose();
});

test('the heartbeat runs only while an aim or double-click window is open, and stops on dispose', () => {
  const time = fakeTime();
  const clicks = new AimedClicks<Row>(time.clock, time.heartbeat);
  const apply = () => undefined;
  assert.equal(time.running(), 0, 'idle: no timer');
  clicks.willRedraw(['r', 'a', 'b'], false, ['r']);
  clicks.fetched('r', true, () => ['r', 'b', 'a']);
  assert.equal(time.running(), 1, 'a move opens the aim window: the heartbeat starts');
  time.advance(AIM_WINDOW_MS + HEARTBEAT_MS);
  assert.equal(time.running(), 0, 'the aim window closed: the heartbeat stopped');
  // A redirect keeps it running for the double-click window.
  clicks.willRedraw(['r', 'b', 'a'], false, ['r']);
  clicks.fetched('r', true, () => ['r', 'a', 'b']);
  redirectedClick(clicks, ['r', 'a', 'b'], 'a', apply);
  assert.equal(time.running(), 1, 'the double-click window keeps it running after the reveal forgot the order');
  time.advance(DOUBLE_CLICK_MS + HEARTBEAT_MS);
  assert.equal(time.running(), 0, 'the double-click window closed: stopped');
  // Disposed with a window open: stopped.
  clicks.willRedraw(['r', 'a', 'b'], false, ['r']);
  clicks.fetched('r', true, () => ['r', 'b', 'a']);
  assert.equal(time.running(), 1);
  clicks.dispose();
  assert.equal(time.running(), 0, 'dispose stops the heartbeat');
});

test('a click opens the clicked row when the slot is unsure or nothing moved there', () => {
  assert.equal(aimedRowId(['r', 'a', 'b'], ['r', 'a', 'b'], 'a'), undefined, 'the row did not move');
  assert.equal(aimedRowId(['r', 'a'], ['r', 'b', 'a'], 'a'), undefined, 'the old slot held nothing');
  assert.equal(aimedRowId(['r', 'a', 'b'], ['r', 'b'], 'b'), undefined, 'the row aimed at is gone');
  assert.equal(aimedRowId(['r', 'a', 'b'], ['r', 'b', 'n'], 'b'), undefined, 'the row aimed at is gone, a new one came');
  assert.ok(KEYBOARD_SELECTION_MS >= AIM_WINDOW_MS, 'a keyboard move outlasts any aim window still open');
  assert.equal(aimedRowId(['r', 'a', 'b'], ['r', 'b', 'a'], 'x'), undefined, 'the clicked row is not shown');
});

test('a redraw still on its way, a user collapse or an expansion forgets the old order', () => {
  let now = 1_000;
  const clicks = new AimedClicks<{ id: string }>(() => now);
  const before = ['r', 'a', 'b'];
  const after = ['r', 'b', 'a'];
  const opened: string[][] = [];
  const apply = ({ selection }: { selection: readonly { id: string }[] }) => opened.push(selection.map((row) => row.id));
  const move = () => {
    clicks.willRedraw(before, false, ['r']);
    clicks.fetched('r', true, () => after);
  };

  // The move lands: a click on b is held and claimed as aimed at a.
  move();
  clicks.select([{ id: 'b' }], after, apply);
  assert.equal(clicks.claim('b')?.aimed, 'a');

  // A redraw on its way: the screen is changing, so the click is plain.
  clicks.select([{ id: 'r' }], after, apply);
  move();
  clicks.willRedraw(after, false, ['r']);
  clicks.select([{ id: 'b' }], after, apply);
  assert.equal(clicks.claim('b'), undefined);
  clicks.fetched('r', true, () => after);

  // The user collapses a repo: forgotten.
  move();
  clicks.forget();
  clicks.select([{ id: 'a' }], after, apply);
  clicks.select([{ id: 'b' }], after, apply);
  assert.equal(clicks.claim('b'), undefined);

  // The user expands a repo (the editor asks on its own): forgotten.
  move();
  clicks.fetched('other', false, () => after);
  clicks.select([{ id: 'a' }], after, apply);
  clicks.select([{ id: 'b' }], after, apply);
  assert.equal(clicks.claim('b'), undefined);

  // The window closes AIM_WINDOW_MS after the rows reached the screen.
  move();
  clicks.select([{ id: 'a' }], after, apply);
  now += AIM_WINDOW_MS + 1;
  clicks.select([{ id: 'b' }], after, apply);
  assert.equal(clicks.claim('b'), undefined);
  clicks.dispose();
});
