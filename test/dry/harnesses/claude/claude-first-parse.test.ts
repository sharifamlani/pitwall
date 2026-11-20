/**
 * A window's first parse of each transcript (PR #76 live gate: every window
 * parsed all of the owner's 3.4 GB at startup, holding the extension host at
 * 1–2.3 cores for 40–85 s while status polls took up to 5 s).
 *
 * A skimmed first parse decodes only the lines that can still change the
 * session and must give exactly what a whole parse gives. One parse per file
 * runs at a time, and a scan parses at most two files at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { ClaudeSessionService } from '../../../../src/harnesses/claude/ClaudeSessionService';
import { claudeProfile, entry } from './claudeFixture';

const ID = '22222222-3333-4444-8555-666666666666';
let clock = Date.UTC(2026, 10, 20, 8, 0, 0);
const at = () => new Date((clock += 1_000)).toISOString();

/** One tool call and its large result, as Claude writes them. */
function toolPair(n: number, bytes = 40_000): object[] {
  const id = `toolu_${n}`;
  return [
    { type: 'assistant', timestamp: at(), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `src/f${n}.ts` } }] } },
    { type: 'user', timestamp: at(), message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'x'.repeat(bytes) }] }, toolUseResult: { content: 'y'.repeat(bytes) } },
  ];
}

/** A finished turn: a typed prompt, `tools` calls, a reply, a turn_duration. */
function turn(prompt: string, tools: number, reply: string): object[] {
  return [
    entry.user(prompt, at()),
    ...Array.from({ length: tools }, (_, i) => toolPair(i)).flat(),
    entry.assistant(reply, 'end_turn', at()),
    { type: 'system', subtype: 'turn_duration', durationMs: 1000, timestamp: at() },
  ];
}

/** Whole and skimmed parses of the same file, side by side. */
async function bothParses(t: { after(fn: () => void): void }, entries: object[], write?: (file: string) => void) {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const file = profile.write(ID, repo, entries);
  write?.(file);
  const whole = await new ClaudeSessionService({ skimMinBytes: Infinity }).getSessionById(ID);
  const skimmed = await new ClaudeSessionService({ skimMinBytes: 0 }).getSessionById(ID);
  return { whole, skimmed, repo, file };
}

const VARIANTS: Record<string, () => object[]> = {
  'finished turns with large tool results': () => [...turn('first ask', 6, 'one'), ...turn('second ask', 6, 'two'), ...turn('third ask', 6, 'three')],
  'titles and a summary in the middle; an empty custom title keeps the previous one': () => [
    ...turn('ask a', 4, 'a'),
    entry.aiTitle('Generated name'),
    ...turn('ask b', 4, 'b'),
    entry.customTitle('My rename'),
    entry.summary('A summary'),
    ...turn('ask c', 4, 'c'),
    entry.customTitle('  '),
    ...turn('ask d', 4, 'd'),
  ],
  'a relocation in the middle': () => [...turn('ask a', 4, 'a'), { type: 'relocated', relocatedCwd: 'C:\\moved\\repo' }, ...turn('ask b', 4, 'b')],
  'the last reply long before a turn still at work': () => [...turn('ask a', 2, 'the last words'), entry.user('keep going', at()), ...Array.from({ length: 40 }, (_, i) => toolPair(i)).flat()],
  'sidechain traffic after the last main-chain entry': () => [
    ...turn('ask a', 4, 'a'),
    ...Array.from({ length: 10 }, () => ({ ...entry.assistant('sub', 'end_turn', at()), isSidechain: true })),
    ...Array.from({ length: 10 }, () => ({ ...entry.user('sub ask', at()), isSidechain: true })),
  ],
  'an interrupt ends the turn': () => [...turn('ask a', 4, 'a'), entry.user('stop that', at()), ...toolPair(1), entry.user('[Request interrupted by user]', at())],
  'background agents still pending after the last reply': () => [
    ...turn('ask a', 4, 'a'),
    entry.user('ask b', at()),
    ...toolPair(9),
    entry.assistant('started agents', 'end_turn', at()),
    { type: 'system', subtype: 'turn_duration', pendingBackgroundAgentCount: 2, timestamp: at() },
  ],
  'one typed prompt at the start, then injected context, a compaction and slash commands': () => [
    entry.user('the only real ask', at()),
    ...Array.from({ length: 12 }, (_, i) => toolPair(i)).flat(),
    entry.injected('<system-reminder>skill text</system-reminder>', at()),
    entry.compactSummary('This session is being continued...', at()),
    entry.user('/model', at()),
    entry.user('<command-name>/compact</command-name>', at()),
    entry.assistant('ok', 'end_turn', at()),
  ],
  'a prompt that quotes "type":"user" and "tool_use_id", and a reply whose tool input nests "type":"user"': () => [
    ...turn('ask a', 4, 'a'),
    entry.user('why does {"type":"user","tool_use_id":"x"} parse?', at()),
    ...toolPair(3),
    {
      type: 'assistant',
      timestamp: at(),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'here is a fixture' }, { type: 'tool_use', id: 'toolu_n', name: 'Write', input: { entries: [{ type: 'user' }, { type: 'custom-title' }] } }] },
    },
    ...Array.from({ length: 6 }, (_, i) => toolPair(20 + i)).flat(),
  ],
  'the cwd and entrypoint arrive late; queue operations first': () => [
    ...Array.from({ length: 30 }, () => ({ type: 'queue-operation', operation: 'enqueue', timestamp: at(), cwd: undefined, padding: 'q'.repeat(30_000) })),
    { ...entry.user('ask a', at()), entrypoint: 'cli' },
    ...toolPair(1),
    entry.assistant('a', 'end_turn', at()),
    { ...entry.user('ask b', at()), entrypoint: 'claude-vscode' },
    ...Array.from({ length: 8 }, (_, i) => toolPair(i)).flat(),
    entry.assistant('b', 'end_turn', at()),
  ],
  'metadata only, no conversation': () => Array.from({ length: 60 }, () => ({ type: 'file-history-snapshot', snapshot: { files: 'f'.repeat(30_000) } })),
};

for (const [name, entries] of Object.entries(VARIANTS)) {
  test(`a skimmed first parse equals a whole parse: ${name}`, async (t) => {
    const { whole, skimmed } = await bothParses(t, entries());
    assert.deepEqual(skimmed, whole);
  });
}

test('a skimmed first parse equals a whole parse with a partial last line, then without', async (t) => {
  const base = turn('ask a', 8, 'a');
  // A write in progress: not JSON yet, so neither parse counts it.
  const partial = await bothParses(t, base, (file) => fs.appendFileSync(file, '{"type":"assistant","message":{"content":[{"type":"te'));
  assert.deepEqual(partial.skimmed, partial.whole);
  // A complete last entry without its newline counts in both.
  const complete = await bothParses(t, base, (file) =>
    fs.appendFileSync(file, JSON.stringify({ cwd: 'C:\\x', sessionId: ID, ...entry.assistant('late reply', 'end_turn', at()) }))
  );
  assert.deepEqual(complete.skimmed, complete.whole);
  assert.equal(complete.skimmed?.lastReply?.text, 'late reply');
});

test('a transcript not written as compact JSON is parsed whole, with the same result', async (t) => {
  const { whole, skimmed } = await bothParses(t, [], (file) => {
    const spaced = [...turn('ask a', 6, 'a'), entry.customTitle('Named'), ...turn('ask b', 6, 'b')]
      .map((value) => JSON.stringify({ cwd: 'C:\\repo', sessionId: ID, ...value }).replace(/":"/g, '": "').replace(/","/g, '", "'))
      .join('\n');
    fs.writeFileSync(file, `${spaced}\n`);
  });
  assert.equal(skimmed?.summary, 'Named');
  assert.deepEqual(skimmed, whole);
});

test('a skimmed first parse decodes a small share of a large transcript', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const entries = [...turn('ask a', 60, 'a'), entry.customTitle('Kept'), ...turn('ask b', 60, 'b')];
  const file = profile.write(ID, repo, entries);
  const size = fs.statSync(file).size;
  const parse = JSON.parse;
  let decoded = 0;
  JSON.parse = ((text: string, ...rest: unknown[]) => {
    decoded += text.length;
    return (parse as (...args: unknown[]) => unknown)(text, ...rest);
  }) as typeof JSON.parse;
  let session;
  try {
    session = await new ClaudeSessionService({ skimMinBytes: 0 }).getSessionById(ID);
  } finally {
    JSON.parse = parse;
  }
  assert.equal(session?.summary, 'Kept');
  assert.equal(session?.lastReply?.text, 'b');
  assert.ok(size > 9_000_000, `fixture is ${size} bytes`);
  assert.ok(decoded < size * 0.05, `decoded ${decoded} of ${size} bytes`);
});

/** Counts `fs.promises.open` calls on paths ending in `.jsonl`, and the most open at once. */
async function opensDuring<T>(fn: () => Promise<T>): Promise<{ result: T; opens: number; maxOpen: number }> {
  const open = fs.promises.open;
  let opens = 0;
  let current = 0;
  let maxOpen = 0;
  fs.promises.open = (async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (!String(args[0]).endsWith('.jsonl')) {
      return handle;
    }
    opens++;
    current++;
    maxOpen = Math.max(maxOpen, current);
    const close = handle.close.bind(handle);
    (handle as unknown as { close: unknown }).close = async () => {
      current--;
      return close();
    };
    return handle;
  }) as typeof open;
  try {
    return { result: await fn(), opens, maxOpen };
  } finally {
    fs.promises.open = open;
  }
}

test('callers asking about one transcript at once share one parse (QA on #76)', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  profile.write(ID, repo, [...turn('ask a', 80, 'a'), ...turn('ask b', 80, 'b')]);
  const service = new ClaudeSessionService({ skimMinBytes: Infinity });
  const { result, opens } = await opensDuring(() =>
    Promise.all([service.getSessionById(ID), service.getSessionById(ID), service.isSessionResumable(ID), service.getSessionPreview(ID)])
  );
  assert.equal(opens, 1, 'one parse, not one per caller');
  assert.equal(result[0]?.lastReply?.text, 'b');
  assert.deepEqual(result[1], result[0]);
  assert.equal(result[2], true);
});

test('a caller that comes while a parse runs, after the file grew, resumes from that parse', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const file = profile.write(ID, repo, turn('ask a', 80, 'a'));
  const size = fs.statSync(file).size;
  const service = new ClaudeSessionService({ skimMinBytes: Infinity });
  // Bytes read per opened handle, in the order the parses opened them.
  const open = fs.promises.open;
  const handles: number[] = [];
  let firstOpened!: () => void;
  const opened = new Promise<void>((resolve) => (firstOpened = resolve));
  fs.promises.open = (async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const index = handles.push(0) - 1;
    const read = handle.read.bind(handle) as (...readArgs: unknown[]) => Promise<{ bytesRead: number }>;
    (handle as unknown as { read: unknown }).read = async (...readArgs: unknown[]) => {
      const out = await read(...readArgs);
      handles[index] += out.bytesRead;
      return out;
    };
    firstOpened();
    return handle;
  }) as typeof open;
  let second;
  try {
    const first = service.getSessionById(ID);
    // The first parse has its size; the file grows while it reads.
    await opened;
    fs.appendFileSync(file, turn('ask b', 1, 'b').map((value) => `${JSON.stringify({ cwd: repo, sessionId: ID, ...value })}\n`).join(''));
    second = await service.getSessionById(ID);
    assert.equal((await first)?.lastReply?.text, 'a', 'the first parse read the file as it was');
  } finally {
    fs.promises.open = open;
  }
  assert.equal(second?.lastReply?.text, 'b', 'the grown file is read to its end');
  assert.equal(handles.length, 2, 'two parses, one after the other');
  assert.ok(handles[0] >= size, 'the first read the whole file');
  assert.ok(handles[1] < size / 2, `the second read ${handles[1]} bytes of ${size}: it resumed, it did not start over`);
});

test('a scan parses at most two transcripts at once, and lists them all', async (t) => {
  const profile = claudeProfile(t);
  const repos = Array.from({ length: 8 }, (_, i) => profile.dir(`repo-${i}`));
  repos.forEach((repo, i) => {
    for (let n = 0; n < 2; n++) {
      profile.write(`3333333${i}-0000-4000-8000-00000000000${n}`, repo, turn(`ask ${i}.${n}`, 30, 'done'));
    }
  });
  const service = new ClaudeSessionService();
  const { result, maxOpen } = await opensDuring(() => Promise.all(repos.map((repo) => service.findSessionsForRepository(repo, [repo]))));
  assert.deepEqual(
    result.map((sessions) => sessions.length),
    repos.map(() => 2)
  );
  assert.ok(maxOpen <= 2, `${maxOpen} transcripts open at once`);
  assert.ok(maxOpen >= 1);
});
