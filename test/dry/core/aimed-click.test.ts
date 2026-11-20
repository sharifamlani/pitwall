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
