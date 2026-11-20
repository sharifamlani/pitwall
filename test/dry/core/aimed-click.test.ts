/**
 * The slot rule behind "the aimed row wins" (D21): a click redirects only to
 * the row that sat in the clicked slot before the move, and opens the
 * clicked row whenever that is unsure. It never picks a third row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIM_WINDOW_MS, AimedClicks, aimedRowId } from '../../../src/core/providers/aimedClick';

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
  let now = 1_000;
  const clicks = new AimedClicks<{ id: string }>(() => now);
  const apply = () => undefined;
  clicks.willRedraw(['r', 'a', 'b'], false, ['r']);
  clicks.fetched('r', true, () => ['r', 'b', 'a']);
  clicks.select([{ id: 'b' }], ['r', 'b', 'a'], apply);
  const first = clicks.claim('b')!;
  assert.equal(first.aimed, 'a');
  clicks.redirected(first);
  // The redirect reveals a (which forgets the order); the second click lands on b again.
  clicks.expectSelection('a');
  clicks.select([{ id: 'a' }], ['r', 'b', 'a'], apply);
  now += 200;
  clicks.select([{ id: 'b' }], ['r', 'b', 'a'], apply);
  assert.equal(clicks.claim('b')?.aimed, 'a', 'a new selection of b');
  now += 100;
  assert.equal(clicks.claim('b')?.aimed, 'a', 'b still selected: the command alone');
  now += 500;
  assert.equal(clicks.claim('b'), undefined, 'a later click is a click of its own');
  clicks.dispose();
});

test('a click opens the clicked row when the slot is unsure or nothing moved there', () => {
  assert.equal(aimedRowId(['r', 'a', 'b'], ['r', 'a', 'b'], 'a'), undefined, 'the row did not move');
  assert.equal(aimedRowId(['r', 'a'], ['r', 'b', 'a'], 'a'), undefined, 'the old slot held nothing');
  assert.equal(aimedRowId(['r', 'a', 'b'], ['r', 'b'], 'b'), undefined, 'the row aimed at is gone');
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
