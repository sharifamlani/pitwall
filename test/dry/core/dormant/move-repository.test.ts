/**
 * Dormant (P18): inbox order replaced the manual repo order in Phase 3, so
 * Move Up / Move Down are no longer contributed or registered. The command
 * code is parked in `registerMoveRepositoryCommands`; this test returns to
 * `workspace-roots.test.ts` if manual order comes back.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { registerMoveRepositoryCommands } from '../../../../src/core/commands/repository';
import { makeStorage, runCommand, shownMessages, stub } from '../../support';

beforeEach(() => stub.__reset());

test('Move Up and Move Down reorder roots; a refused move explains itself without a refresh', async () => {
  const storage = makeStorage();
  let refreshes = 0;
  registerMoveRepositoryCommands({ subscriptions: [] } as never, { storageService: storage, refreshTree: () => refreshes++ });
  const roots = () => storage.getRepositories().map((repo) => repo.name);
  const first = storage.addRepository('first', '/first');
  storage.addRepository('second', '/second');
  const row = { itemType: 'repository', data: first };

  await runCommand('pitwall.moveRepositoryDown', row);
  assert.deepEqual(roots(), ['second', 'first']);
  await runCommand('pitwall.moveRepositoryUp', row);
  assert.deepEqual(roots(), ['first', 'second']);
  assert.equal(refreshes, 2);

  await runCommand('pitwall.moveRepositoryUp', row);
  assert.equal(refreshes, 2);
  assert.equal(shownMessages().at(-1), '"first" is already at the top.');
});
