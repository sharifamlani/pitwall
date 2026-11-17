/**
 * Inbox order (row 3.4, D21, P6): position is urgency. Repos and sessions rank
 * differently, and inside a rank the row that entered its status last is first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderRows, rankRepo, rankSession, repoStatus } from '../../../src/core/providers/inboxOrder';
import { SessionStatus } from '../../../src/core/providers/sessionStatus';

const row = (id: string, status: SessionStatus, statusSince: number, title = id) => ({ id, status, statusSince, title });

test('repos rank needs you, finished, working, idle; sessions rank needs you, working, finished, idle; newest statusSince first', () => {
  const statuses: SessionStatus[] = ['idle', 'working', 'finished', 'needs'];
  assert.deepEqual([...statuses].sort((a, b) => rankRepo(a) - rankRepo(b)), ['needs', 'finished', 'working', 'idle']);
  assert.deepEqual([...statuses].sort((a, b) => rankSession(a) - rankSession(b)), ['needs', 'working', 'finished', 'idle']);

  const rows = [
    row('idle-old', 'idle', 10),
    row('working', 'working', 50),
    row('finished-old', 'finished', 20),
    row('needs-old', 'needs', 30),
    row('finished-new', 'finished', 90),
    row('needs-new', 'needs', 80),
    row('idle-new', 'idle', 70),
  ];
  assert.deepEqual(
    orderRows(rows, rankRepo).map((entry) => entry.id),
    ['needs-new', 'needs-old', 'finished-new', 'finished-old', 'working', 'idle-new', 'idle-old']
  );
  assert.deepEqual(
    orderRows(rows, rankSession).map((entry) => entry.id),
    ['needs-new', 'needs-old', 'working', 'finished-new', 'finished-old', 'idle-new', 'idle-old']
  );
  assert.deepEqual(rows.map((entry) => entry.id)[0], 'idle-old', 'the input is not reordered in place');
});

test('two rows entering the same status at the same time tie-break by title, stable', () => {
  const rows = [row('b', 'working', 5, 'Beta'), row('a', 'working', 5, 'Alpha'), row('c', 'working', 5, 'alpha')];
  assert.deepEqual(orderRows(rows, rankSession).map((entry) => entry.id), ['a', 'c', 'b']);
  assert.deepEqual(orderRows([...rows].reverse(), rankSession).map((entry) => entry.id), ['a', 'c', 'b']);
});

test("a repo takes its most urgent session's status, and the newest time in that status", () => {
  assert.deepEqual(repoStatus([]), { status: 'idle', statusSince: 0 });
  assert.deepEqual(
    repoStatus([
      { status: 'working', statusSince: 100 },
      { status: 'finished', statusSince: 40 },
      { status: 'finished', statusSince: 60 },
      { status: 'idle', statusSince: 500 },
    ]),
    { status: 'finished', statusSince: 60 },
    'finished outranks working for a repo'
  );
});
