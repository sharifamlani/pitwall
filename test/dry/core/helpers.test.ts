import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextForkName } from '../../../src/core/utils/text';
import * as path from 'path';
import { deepestContainingRoot, samePath } from '../../../src/core/utils/paths';
import { JsonSchema, validateJson } from '../../../src/core/utils/jsonSchema';
import { quoteForCmd } from '../../../src/core/harness/cli';
import {
  findClaimableSession,
  lastExchange,
  selectHarnessIconState,
  SESSION_CREATED_SLACK_MS,
} from '../../../src/core/harness/sessionUtils';
import { chatRecord, sessionRecord, tempDir } from '../support';

test('fork names number siblings and nest forks of forks', () => {
  const cases: [string, string[], string][] = [
    ['Fix icons', [], 'Fix icons (1)'],
    ['Fix icons', ['Other', 'Fix icons (1)', 'Fix icons (2)'], 'Fix icons (3)'],
    ['Fix icons (1)', [], 'Fix icons (1) (1)'],
    ['Fix icons (1)', ['Fix icons (1) (1)'], 'Fix icons (1) (2)'],
    ['   ', [], 'Session (1)'],
  ];
  for (const [source, existing, expected] of cases) {
    assert.equal(nextForkName(source, existing), expected, `fork of "${source}"`);
  }
});

test('row icon: no live surface is closed or new; a live one shows working or done', () => {
  const linked = { harnessSessionId: 'abc' };
  const cases: [Partial<Parameters<typeof chatRecord>[0]>, boolean, 'working' | 'done' | undefined, string, boolean?][] = [
    [linked, false, undefined, 'idle'],
    [{ ...linked, status: 'active' }, false, undefined, 'idle'], // stale status after a restart
    [linked, false, 'working', 'idle'], // a closed terminal outranks a working turn
    [{}, false, undefined, 'new'],
    [{}, true, undefined, 'finished'], // no turn state yet keeps the dot (no flash)
    [{}, true, 'working', 'working'],
    [{ status: 'closed' }, true, 'done', 'finished'],
    [linked, true, 'working', 'needs', true], // waiting on the user outranks the turn
    [linked, true, undefined, 'needs', true],
    [linked, false, 'working', 'idle', true], // a closed terminal outranks a wait
  ];
  for (const [chat, open, turn, expected, needsYou] of cases) {
    assert.equal(
      selectHarnessIconState(chatRecord(chat), open, turn, needsYou),
      expected,
      JSON.stringify({ chat, open, turn, needsYou })
    );
  }
});

test('the last exchange hides a reply older than the last ask', () => {
  const ask = { text: 'second question', timestamp: 200 };
  const oldReply = { text: 'answer to the first', timestamp: 100 };
  const newReply = { text: 'answer to the second', timestamp: 300 };

  const pending = lastExchange({ lastActivity: 200, preview: [ask], lastReply: oldReply });
  assert.deepEqual(pending, { lastAsk: ask, lastReply: null });

  const answered = lastExchange({ lastActivity: 300, preview: [ask], lastReply: newReply });
  assert.deepEqual(answered, { lastAsk: ask, lastReply: newReply });
});

test('a launch claims the oldest unseen session created after it', () => {
  const launchedAt = 1_000_000;
  const at = (ms: number) => ({ lastUpdated: new Date(ms) });
  const sessions = [
    sessionRecord('codex', 'before-launch', at(launchedAt - SESSION_CREATED_SLACK_MS - 1)),
    sessionRecord('codex', 'known', at(launchedAt + 10)),
    sessionRecord('codex', 'second', at(launchedAt + 50)),
    sessionRecord('codex', 'first', at(launchedAt + 20)),
  ];
  const claimed = findClaimableSession(sessions, launchedAt, (id) => id === 'known');
  assert.equal(claimed?.sessionId, 'first');
  assert.equal(findClaimableSession(sessions.slice(0, 1), launchedAt), undefined);
});

test('a session maps to the deepest root that contains its cwd', () => {
  const roots = [
    { id: 'repo', path: '/work/repo' },
    { id: 'nested', path: '/work/repo/wt/feature' },
  ];
  assert.equal(deepestContainingRoot(roots, '/work/repo/wt/feature/src')?.id, 'nested');
  assert.equal(deepestContainingRoot(roots, '/work/repo/src')?.id, 'repo');
  assert.equal(deepestContainingRoot(roots, '/work/repo-other'), undefined, 'a shared prefix is not containment');
});

test('a value is checked against every schema keyword, and each problem names its path', () => {
  const schema: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['answer', 'matches'],
    properties: {
      answer: { type: 'string' },
      matches: {
        type: 'array',
        maxItems: 1,
        items: { type: 'object', required: ['harness'], properties: { harness: { type: 'string', enum: ['claude'] } } },
      },
    },
  };

  assert.deepEqual(validateJson({ answer: 'Found it.', matches: [{ harness: 'claude', note: 'kept' }] }, schema), []);
  assert.deepEqual(
    validateJson({ matches: [{ harness: 'codex' }, 'two', { constructor: 1 }], answer: 1, extra: true }, schema),
    [
      'matches must have at most 1 item',
      'matches[0].harness must be one of "claude"',
      'matches[1] must be an object',
      'matches[2].harness is missing',
      'answer must be a string',
      'extra is not allowed',
    ]
  );
  assert.deepEqual(validateJson({ answer: 'x', matches: {} }, schema), ['matches must be an array']);
  assert.deepEqual(validateJson(null, schema), ['the value must be an object']);
});

test('arguments are quoted for cmd.exe, and what it cannot carry is refused', () => {
  assert.equal(quoteForCmd('--add-dir'), '--add-dir');
  assert.equal(quoteForCmd('C:\\Users\\John Smith\\.claude\\projects'), '"C:\\Users\\John Smith\\.claude\\projects"');
  assert.equal(quoteForCmd('haiku & calc'), '"haiku & calc"');
  assert.throws(() => quoteForCmd('50%off'), /cannot pass/);
  assert.throws(() => quoteForCmd('a"b'), /cannot pass/);
});

test('samePath matches one folder however the editor or git spells it', (t) => {
  const dir = tempDir(t);
  if (process.platform === 'win32') {
    assert.equal(samePath(dir[0].toLowerCase() + dir.slice(1), dir.replace(/[\\]/g, '/')), true);
  } else {
    assert.equal(samePath(dir, dir + '/'), true);
    assert.equal(samePath(dir, dir.toUpperCase()), false);
  }
  assert.equal(samePath(dir, path.join(dir, 'x')), false);
});
