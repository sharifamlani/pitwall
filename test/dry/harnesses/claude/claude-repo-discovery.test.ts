/**
 * Which folders Claude Code sessions ran in, read from the heads of the
 * transcripts under `projects/` (ADR 0019). Transcripts are written raw here:
 * real heads start with `queue-operation` entries that carry no cwd.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeRepoDiscovery } from '../../../../src/harnesses/claude/ClaudeRepoDiscovery';
import { ClaudeHarness } from '../../../../src/harnesses/claude/ClaudeHarness';
import { ClaudeSessionService } from '../../../../src/harnesses/claude/ClaudeSessionService';
import { DiscoveryCounts } from '../../../../src/core/harness/types';
import { claudeProfile } from './claudeFixture';
import { watchEventLoopBlocks } from '../../support';

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

function setup(t: { after(fn: () => void): void }) {
  const profile = claudeProfile(t);
  /** Write raw lines into a project dir; the file's mtime is `ageMs` ago. */
  const transcript = (project: string, sessionId: string, lines: (object | string)[], ageMs = 0): string => {
    const dir = path.join(profile.projects, project);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line)) + '\n').join(''));
    const seconds = (Date.now() - ageMs) / 1000;
    fs.utimesSync(file, seconds, seconds);
    return file;
  };
  const queued = (timestamp: number) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(timestamp) });
  const user = (cwd: string, timestamp: number) => ({
    type: 'user',
    cwd,
    sessionId: 's',
    timestamp: iso(timestamp),
    message: { role: 'user', content: 'hi' },
  });
  return { profile, transcript, queued, user, discovery: () => new ClaudeRepoDiscovery(profile.projects, new ClaudeSessionService()) };
}

test('lists folders whose transcripts changed in the window, with cwd and first entry time', async (t) => {
  const { profile, transcript, queued, user, discovery } = setup(t);
  const alpha = profile.dir('alpha');
  const beta = profile.dir('beta');
  const startedAt = Date.now() - 2 * 60 * 60 * 1000;
  transcript('alpha', 'a1', [queued(startedAt), queued(startedAt + 5), user(alpha, startedAt + 10)], 60_000);
  transcript('beta', 'b1', [user(beta, startedAt + 20)], 30_000);

  const folders = await discovery().discoverRecentFolders(Date.now() - 14 * DAY);

  const byCwd = new Map(folders.map((folder) => [folder.cwd, folder]));
  assert.deepEqual([...byCwd.keys()].sort(), [alpha, beta].sort());
  assert.equal(byCwd.get(alpha)!.firstEntryAt, startedAt, 'the first entry, a queue-operation, dates the session');
  assert.equal(byCwd.get(beta)!.firstEntryAt, startedAt + 20);
  assert.ok(Math.abs(byCwd.get(alpha)!.lastActivity - (Date.now() - 60_000)) < 2_000, 'last activity is the mtime');

  // The harness offers the same through the adapter.
  const viaHarness = await new ClaudeHarness().discoverRecentFolders(Date.now() - 14 * DAY);
  assert.deepEqual(viaHarness.map((folder) => folder.cwd).sort(), [alpha, beta].sort());
});

test('a transcript without cwd, unreadable or malformed is skipped', async (t) => {
  const { profile, transcript, queued, user, discovery } = setup(t);
  const good = profile.dir('good');
  transcript('good', 'ok', [user(good, Date.now() - 1_000)]);
  transcript('nocwd', 'n1', [queued(Date.now() - 1_000), { type: 'summary', summary: 'x' }]);
  transcript('broken', 'm1', ['{"type":"user","cwd":', 'not json at all']);
  // A directory with a transcript's name cannot be read as one.
  fs.mkdirSync(path.join(profile.projects, 'odd', 'dir.jsonl'), { recursive: true });
  // Subagent transcripts and a stray file at the top level are not sessions.
  transcript('good', 'agent-x', [user(profile.dir('agent-only'), Date.now())]);
  fs.writeFileSync(path.join(profile.projects, 'stray.jsonl'), JSON.stringify(user(profile.dir('stray'), Date.now())));

  const counts: DiscoveryCounts = { skipped: 0 };
  const folders = await discovery().discoverRecentFolders(Date.now() - DAY, counts);

  assert.deepEqual(folders.map((folder) => folder.cwd), [good]);
  assert.equal(counts.skipped, 3, 'no cwd, malformed, unreadable');
});

test('a 15-day-old transcript is not listed', async (t) => {
  const { profile, transcript, user, discovery } = setup(t);
  const ages: Record<string, number> = { day1: 1 * DAY, day13: 13 * DAY, day15: 15 * DAY };
  for (const [name, age] of Object.entries(ages)) {
    transcript(name, name, [user(profile.dir(name), Date.now() - age)], age);
  }

  const folders = await discovery().discoverRecentFolders(Date.now() - 14 * DAY);

  assert.deepEqual(folders.map((folder) => path.basename(folder.cwd)).sort(), ['day1', 'day13']);
});

test('the cwd comes from the first entry that has one, past a first line over 64 KB', async (t) => {
  const { profile, transcript, queued, user, discovery } = setup(t);
  const repo = profile.dir('repo');
  const later = profile.dir('later');
  const startedAt = Date.now() - 5_000;
  const attachment = { type: 'attachment', timestamp: iso(startedAt + 1), content: 'x'.repeat(100 * 1024) };
  transcript('repo', 'big', [queued(startedAt), attachment, user(repo, startedAt + 2), user(later, startedAt + 3)]);

  const folders = await discovery().discoverRecentFolders(Date.now() - DAY);

  assert.deepEqual(folders, [{ cwd: repo, firstEntryAt: startedAt, lastActivity: folders[0]?.lastActivity }]);
  assert.ok(folders[0].lastActivity > 0);
});

test('a cwd past the first megabyte is not looked for, and the file counts as skipped', async (t) => {
  const { profile, transcript, queued, user, discovery } = setup(t);
  const filler = Array.from({ length: 12 }, (_, i) => ({ ...queued(Date.now() - 1_000), pad: `${i}`.padEnd(100 * 1024, 'x') }));
  transcript('deep', 'deep', [...filler, user(profile.dir('deep'), Date.now())]);

  const counts: DiscoveryCounts = { skipped: 0 };
  assert.deepEqual(await discovery().discoverRecentFolders(Date.now() - DAY, counts), []);
  assert.equal(counts.skipped, 1);
});

/**
 * A transcript shaped like Claude Code's, about `bytes` long: prompts,
 * tool calls, long tool results and replies, one turn a minute up to `lastAt`.
 */
function realisticTranscript(cwd: string, sessionId: string, bytes: number, lastAt: number): string {
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(60);
  const turns: string[][] = [];
  let size = 0;
  for (let turn = 0; size < bytes; turn++) {
    const lines = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: `Prompt ${turn}` }] } },
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${turn}`, name: 'Read', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${turn}`, content: filler.repeat(1 + (turn % 6)) }] } },
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `Reply ${turn}` }] } },
    ].map((line) => JSON.stringify({ cwd, sessionId, ...line }));
    size += lines.reduce((sum, line) => sum + line.length + 1, 0);
    turns.push(lines);
  }
  // Timestamps run up to `lastAt`, one turn a minute.
  return turns
    .flatMap((lines, turn) => {
      const at = iso(lastAt - (turns.length - 1 - turn) * 60_000);
      return lines.map((line) => line.replace(/^\{/, `{"timestamp":"${at}",`));
    })
    .map((line) => `${line}\n`)
    .join('');
}

/** A profile like the E16 one: 20 repos, 140 transcripts of about 20 KB, and 3 of 16 MB. */
function e16Profile(t: { after(fn: () => void): void }) {
  const { profile } = setup(t);
  const repos = Array.from({ length: 20 }, (_, i) => profile.dir(`repo-${String(i).padStart(2, '0')}`));
  let n = 0;
  const write = (cwd: string, bytes: number) => {
    const sessionId = `${String(n++).padStart(8, '0')}-e16`;
    const dir = profile.projectDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), realisticTranscript(cwd, sessionId, bytes, Date.now() - n * 60_000));
  };
  for (let i = 0; i < 140; i++) write(repos[i % repos.length], 20_000);
  for (let i = 0; i < 3; i++) write(repos[i], 16 * 1024 * 1024);
  return { profile, repos };
}

/** Calls made through `fs` to read transcripts, while `run` runs. */
async function transcriptReads(t: { after(fn: () => void): void }, run: () => Promise<unknown>) {
  const nodeFs = require('fs') as typeof fs;
  const reads: { whole: string[]; opened: string[] } = { whole: [], opened: [] };
  const { readFile, open } = nodeFs.promises;
  const { createReadStream, readFileSync } = nodeFs;
  const isTranscript = (file: unknown) => String(file).endsWith('.jsonl');
  const promises = nodeFs.promises as unknown as Record<string, unknown>;
  const sync = nodeFs as unknown as Record<string, unknown>;
  const restore = () => {
    Object.assign(promises, { readFile, open });
    Object.assign(sync, { createReadStream, readFileSync });
  };
  t.after(restore);
  promises.readFile = (file: unknown, ...rest: unknown[]) => {
    if (isTranscript(file)) reads.whole.push(String(file));
    return (readFile as (...args: unknown[]) => unknown)(file, ...rest);
  };
  sync.readFileSync = (file: unknown, ...rest: unknown[]) => {
    if (isTranscript(file)) reads.whole.push(String(file));
    return (readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  };
  promises.open = (file: unknown, ...rest: unknown[]) => {
    if (isTranscript(file)) reads.opened.push(String(file));
    return (open as (...args: unknown[]) => unknown)(file, ...rest);
  };
  sync.createReadStream = (file: unknown, ...rest: unknown[]) => {
    if (isTranscript(file)) reads.opened.push(String(file));
    return (createReadStream as (...args: unknown[]) => unknown)(file, ...rest);
  };
  try {
    await run();
  } finally {
    restore();
  }
  return reads;
}

test('discovery does not block the host for more than 50 ms at a time', async (t) => {
  const { profile, repos } = e16Profile(t);
  const blocks = watchEventLoopBlocks();
  t.after(() => blocks.stop());
  const folders = await new ClaudeRepoDiscovery(profile.projects, new ClaudeSessionService()).discoverRecentFolders(Date.now() - 14 * DAY);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const { maxBlockMs, maxGapMs } = blocks.stop();

  assert.deepEqual(folders.map((folder) => folder.cwd).sort(), [...repos].sort(), 'every repo is found');
  assert.ok(
    maxBlockMs <= 50,
    `discovery blocked the extension host for ${maxBlockMs.toFixed(0)} ms at once (longest gap ${maxGapMs.toFixed(0)} ms)`
  );
});

test('discovery never reads a whole transcript', async (t) => {
  const { profile, repos } = e16Profile(t);
  let found: string[] = [];
  const reads = await transcriptReads(t, async () => {
    const folders = await new ClaudeRepoDiscovery(profile.projects, new ClaudeSessionService()).discoverRecentFolders(Date.now() - 14 * DAY);
    found = folders.map((folder) => folder.cwd);
  });

  assert.deepEqual(found.sort(), [...repos].sort());
  assert.deepEqual(reads.whole, [], 'only heads and tails are read');
});

test('a second pass over 600 unchanged transcripts opens none of them', async (t) => {
  const { profile, user } = setup(t);
  // More transcripts than the session cache holds (500): 14 days of a busy profile.
  for (let i = 0; i < 600; i++) {
    const cwd = profile.dir(`r${i % 30}`);
    const dir = profile.projectDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `s${i}.jsonl`), `${JSON.stringify(user(cwd, Date.now() - i * 60_000))}\n`);
  }
  const discovery = new ClaudeRepoDiscovery(profile.projects, new ClaudeSessionService());
  assert.equal((await discovery.discoverRecentFolders(Date.now() - 14 * DAY)).length, 30);

  const reads = await transcriptReads(t, () => discovery.discoverRecentFolders(Date.now() - 14 * DAY));

  assert.deepEqual(reads.whole, [], 'nothing is read in full');
  assert.equal(reads.opened.length, 0, 'every transcript is answered from the first pass');
});

test("discovery's clock is the last user entry, as import's is, even with later replies", async (t) => {
  const { profile, transcript, user, discovery } = setup(t);
  const quiet = profile.dir('quiet');
  const live = profile.dir('live');
  const reply = (cwd: string, timestamp: number) => ({
    type: 'assistant',
    cwd,
    timestamp: iso(timestamp),
    message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(40 * 1024) }] },
  });
  // The last user entry is 20 days old; replies after it do not date the session.
  transcript('quiet', 'q1', [user(quiet, Date.now() - 20 * DAY), reply(quiet, Date.now() - 2 * DAY), reply(quiet, Date.now() - DAY)], DAY);
  // A recent user entry behind 200 KB of replies still counts.
  const replies = Array.from({ length: 5 }, () => reply(live, Date.now() - DAY));
  transcript('live', 'l1', [user(live, Date.now() - 30 * DAY), user(live, Date.now() - 3 * DAY), ...replies], DAY);

  const folders = await discovery().discoverRecentFolders(Date.now() - 14 * DAY);

  assert.deepEqual(folders.map((folder) => folder.cwd), [live]);
});

test('a repo whose newest transcript has no message in the last 14 days is not discovered', async (t) => {
  const { profile, transcript, user, discovery } = setup(t);
  const stale = profile.dir('stale');
  const live = profile.dir('live');
  // Touched (mtime) 1 day ago, but the last message is 31 days old.
  transcript('stale', 's1', [user(stale, Date.now() - 31 * DAY)], DAY);
  transcript('live', 'l1', [user(live, Date.now() - 2 * DAY)], DAY);

  const folders = await discovery().discoverRecentFolders(Date.now() - 14 * DAY);

  assert.deepEqual(folders.map((folder) => folder.cwd), [live]);
});
