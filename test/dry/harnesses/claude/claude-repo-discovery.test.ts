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
import { DiscoveryCounts } from '../../../../src/core/harness/types';
import { claudeProfile } from './claudeFixture';

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
  return { profile, transcript, queued, user, discovery: () => new ClaudeRepoDiscovery(profile.projects) };
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
