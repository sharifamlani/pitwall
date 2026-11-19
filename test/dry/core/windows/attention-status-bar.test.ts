/**
 * The bottom-bar counts and Next ▸ (row 5.4, Q38, Q40): three left items
 * after `repo · ⎇ branch`, each hidden at 0, the same numbers in every window.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { AttentionStatusBar } from '../../../../src/core/windows/AttentionStatusBar';
import { JumpWalk } from '../../../../src/core/windows/JumpWalk';
import { assertNoLongBlock, stub, tempDir, waitFor } from '../../support';

beforeEach(() => stub.__reset());

interface Item {
  alignment: number;
  priority?: number;
  text: string;
  tooltip?: string;
  command?: unknown;
  shown: boolean;
  disposed: boolean;
}

function setup(t: { after(fn: () => void): void }, order: string[] = []) {
  const emitter = new vscode.EventEmitter<void>();
  const state = { counts: { needs: 0, working: 0, finished: 0 }, order };
  const walk = new JumpWalk(tempDir(t));
  const bar = new AttentionStatusBar({ counts: () => state.counts, onDidChange: emitter.event, order: () => state.order }, walk);
  t.after(() => bar.dispose());
  const items = () => stub.__statusBarItems as unknown as Item[];
  const byText = (text: string) => items().find((item) => item.shown && item.text.includes(text));
  const shownTexts = () => items().filter((item) => item.shown).map((item) => item.text);
  return { emitter, state, walk, bar, items, byText, shownTexts };
}

test('three items show "{n} need you", "{n} working", "{n} finished" and hide at 0', (t) => {
  const f = setup(t);
  f.bar.refresh();
  assert.deepEqual(f.shownTexts(), [], 'all counts 0: nothing shows (Q38)');

  f.state.counts = { needs: 2, working: 1, finished: 3 };
  f.bar.refresh();
  assert.deepEqual(f.shownTexts(), ['$(bell) 2 need you', '$(circle-filled) 1 working', '$(circle-filled) 3 finished']);
  for (const item of f.items()) {
    assert.equal(item.alignment, 1, 'left aligned');
    assert.ok((item.priority ?? 100) < 100, 'after the repo item (priority 100)');
  }

  f.state.counts = { needs: 0, working: 1, finished: 0 };
  f.bar.refresh();
  assert.deepEqual(f.shownTexts(), ['$(circle-filled) 1 working'], 'each hides on its own at 0');
});

test('tooltips and click commands name the list each item opens', (t) => {
  const f = setup(t);
  f.state.counts = { needs: 2, working: 1, finished: 3 };
  f.bar.refresh();
  const needs = f.byText('need you')!;
  assert.equal(needs.tooltip, '2 sessions need you. Click to list them.');
  assert.deepEqual(needs.command, { command: 'pitwall.showStatusList', title: 'List the sessions that need you', arguments: ['needs'] });
  assert.equal((f.byText('working')!.command as { arguments: string[] }).arguments[0], 'working');
  assert.equal((f.byText('finished')!.command as { arguments: string[] }).arguments[0], 'finished');
  f.state.counts = { needs: 1, working: 0, finished: 0 };
  f.bar.refresh();
  assert.equal(needs.tooltip, '1 session needs you. Click to list it.');
});

test('counts redraw within one status change', async (t) => {
  const f = setup(t);
  f.bar.refresh();
  await assertNoLongBlock(
    async () => {
      f.state.counts = { needs: 1, working: 0, finished: 0 };
      f.emitter.fire();
      assert.deepEqual(f.shownTexts(), ['$(bell) 1 need you'], 'redrawn by the change itself, no tick between');
      f.state.counts = { needs: 0, working: 0, finished: 0 };
      f.emitter.fire();
      assert.deepEqual(f.shownTexts(), []);
    },
    50,
    { runs: 3 }
  );
});

test('Next ▸ shows after a jump while another session waits, and hides when none does or the walk ends', async (t) => {
  const f = setup(t, ['a', 'b']);
  f.state.counts = { needs: 2, working: 0, finished: 0 };
  f.bar.refresh();
  assert.equal(f.byText('Next'), undefined, 'no walk, no Next ▸');

  await f.walk.start(['a', 'b'], 'a');
  await waitFor(() => f.byText('Next ▸'), 'Next ▸ appears after a jump');
  const next = f.byText('Next ▸')!;
  assert.equal(next.tooltip, 'Go to the next session that needs you');
  assert.equal(next.command, 'pitwall.jumpNext');
  assert.ok(f.items().indexOf(next) > f.items().indexOf(f.byText('need you')!), 'it follows the counts');

  f.state.order = ['a'];
  f.state.counts = { needs: 1, working: 0, finished: 0 };
  f.emitter.fire();
  await waitFor(() => !f.byText('Next ▸'), 'only the chat just jumped to is left');

  f.state.order = ['a', 'b'];
  f.state.counts = { needs: 2, working: 0, finished: 0 };
  f.emitter.fire();
  await waitFor(() => f.byText('Next ▸'), 'another waits again');
  await f.walk.end();
  await waitFor(() => !f.byText('Next ▸'), 'the walk ended');
});

test('dispose removes every item', (t) => {
  const f = setup(t);
  f.state.counts = { needs: 1, working: 1, finished: 1 };
  f.bar.refresh();
  f.bar.dispose();
  assert.ok(f.items().every((item) => item.disposed));
});
