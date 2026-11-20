/**
 * The jobs that can cost real CPU log their time to Pitwall Operations, so
 * the Tester can match an extension-host CPU spike to one of them (0.6.0
 * walk). Discovery's own lines are tested in repo-discovery.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { HarnessRegistry } from '../../../src/core/harness/HarnessRegistry';
import { DiscoveredFolder, DiscoveryCounts, HarnessLiveState } from '../../../src/core/harness/types';
import { GitService } from '../../../src/core/services/GitService';
import { RepoDiscoveryService } from '../../../src/core/services/RepoDiscoveryService';
import { SessionAttentionService } from '../../../src/core/services/SessionAttentionService';
import { SessionImportService } from '../../../src/core/services/SessionImportService';
import { WorktreeCatalog } from '../../../src/core/services/WorktreeCatalog';
import { Worktree } from '../../../src/core/types';
import { fakeAdapter, makeStorage, sessionRecord, tempDir, waitFor, worktreeRecord } from '../support';

function attention(readMs: number) {
  const storage = makeStorage();
  const chat = storage.createChat('wt-1', 'claude', 'Chat', { harnessSessionId: 's1' });
  const adapter = fakeAdapter('claude', {
    liveSessionIds: async () => new Set(['s1']),
    getLiveStates: async () => {
      await new Promise((resolve) => setTimeout(resolve, readMs));
      return new Map<string, HarnessLiveState>([['s1', { turnState: 'working', turnEndedAt: null, liveStatus: 'busy' }]]);
    },
  });
  const log: string[] = [];
  const service = new SessionAttentionService(
    storage,
    new HarnessRegistry([adapter]),
    { notify: async () => 'shown' } as never,
    (id) => worktreeRecord({ id }),
    () => undefined,
    () => false,
    () => false,
    { log: (line) => log.push(line) }
  );
  return { chat, service, log };
}

test('a status poll of 500 ms or more is logged with its time, the chats it read and each step\'s time; a quick one is not', async (t) => {
  const quick = attention(0);
  t.after(() => quick.service.dispose());
  await quick.service.poll();
  assert.deepEqual(quick.log.filter((line) => line.includes('status poll')), []);

  const slow = attention(550);
  t.after(() => slow.service.dispose());
  await slow.service.poll();
  assert.equal(slow.log.length, 1);
  const line = slow.log[0].match(/^\[Pitwall\] status poll took \d{3,} ms \(1 chats read; live ids \d+ ms, unlisted \d+ ms, states (\d+) ms, judge \d+ ms; loop held \d+ ms, host CPU \d+ ms\)$/);
  assert.ok(line, slow.log[0]);
  assert.ok(Number(line[1]) >= 500, 'the slow step is named: the live-state reads');
});

test('the first full import scan logs its repos, sessions, time and each step\'s time; a later quick one does not', async (t) => {
  const storage = makeStorage();
  const repo = storage.addRepository('demo', '/work/demo');
  const worktree = worktreeRecord({ id: 'wt-main', repoId: repo.id, path: '/work/demo' });
  const listings = new Map<string, Worktree[]>([[repo.rootPath, [worktree]]]);
  const git = {
    listRepositoryWorktrees: (rootPath: string) => ({ isGit: true, worktrees: listings.get(rootPath) ?? [] }),
    listRepositoryWorktreesAsync: async (rootPath: string) => ({ isGit: true, worktrees: listings.get(rootPath) ?? [] }),
  };
  const sessions = [sessionRecord('claude', 's1', { cwd: worktree.path }), sessionRecord('claude', 's2', { cwd: worktree.path })];
  const registry = new HarnessRegistry([
    fakeAdapter('claude', { listSessionsForWorktree: async () => sessions, listSessionsForRepository: async () => sessions }),
  ]);
  const log: string[] = [];
  const service = new SessionImportService(storage, new WorktreeCatalog(storage, git as never), registry, {
    scanIntervalMs: 60_000,
    readSettings: () => ({ enabled: true, retentionDays: 7 }),
    log: (line) => log.push(line),
  });
  t.after(() => service.dispose());
  service.start();
  await waitFor(() => log.length > 0, 'the first full scan');
  assert.match(log[0], /^\[Pitwall\] import scan: 1 repos, 2 sessions, \d+ ms \(adapters \d+ ms, worktrees \d+ ms, listing \d+ ms; claude \d+ ms; host CPU \d+ ms\)$/);

  let listed = 0;
  registry.get('claude').listSessionsForRepository = async () => {
    listed++;
    return sessions;
  };
  service.wake();
  await waitFor(() => listed > 0, 'a second full scan');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(log.length, 1, 'a quick later scan is not logged');

  registry.get('claude').listSessionsForRepository = async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
    return sessions;
  };
  service.wake();
  await waitFor(() => log.length > 1, 'the slow scan logged', 5_000);
  const slow = log[1].match(/^\[Pitwall\] import scan: 1 repos, 2 sessions, \d{3,} ms \(adapters \d+ ms, worktrees \d+ ms, listing (\d+) ms; claude (\d+) ms; host CPU \d+ ms\)$/);
  assert.ok(slow, log[1]);
  assert.ok(Number(slow[1]) >= 500 && Number(slow[2]) >= 500, 'the slow step is named: the listing, by claude');
});

test('an import scan names what each adapter read meanwhile, from its counters', async (t) => {
  const storage = makeStorage();
  const repo = storage.addRepository('demo', '/work/demo');
  const worktree = worktreeRecord({ id: 'wt-main', repoId: repo.id, path: '/work/demo' });
  const git = {
    listRepositoryWorktrees: () => ({ isGit: true, worktrees: [worktree] }),
    listRepositoryWorktreesAsync: async () => ({ isGit: true, worktrees: [worktree] }),
  };
  const sessions = [sessionRecord('claude', 's1', { cwd: worktree.path })];
  const counters = { files: 10, firstParses: 0, firstParseBytes: 0, parseMs: 0 };
  const registry = new HarnessRegistry([
    fakeAdapter('claude', {
      listSessionsForRepository: async () => {
        counters.files += 3;
        counters.firstParses += 1;
        counters.firstParseBytes += 2 * 1048576;
        counters.parseMs += 40;
        return sessions;
      },
      readCounters: () => ({ ...counters }),
    }),
  ]);
  const log: string[] = [];
  const service = new SessionImportService(storage, new WorktreeCatalog(storage, git as never), registry, {
    scanIntervalMs: 60_000,
    readSettings: () => ({ enabled: true, retentionDays: 7 }),
    log: (line) => log.push(line),
  });
  t.after(() => service.dispose());
  service.start();
  await waitFor(() => log.length > 0, 'the first full scan');
  assert.match(log[0], /; claude \d+ ms \[files 3, firstParses 1, firstParse 2\.0 MB, parse 40 ms\]; host CPU \d+ ms\)$/);
});

test('discovery logs its first pass, then only a pass that adds a repo or takes 500 ms or more', async (t) => {
  const storage = makeStorage();
  const root = tempDir(t);
  const repos = ['a', 'b'].map((name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    return dir;
  });
  const folders: DiscoveredFolder[] = [{ cwd: repos[0], firstEntryAt: Date.now(), lastActivity: Date.now() }];
  let delayMs = 0;
  const adapter = fakeAdapter('claude', {
    discoverRecentFolders: async (_sinceMs: number, counts?: DiscoveryCounts) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (counts) counts.sessions = (counts.sessions ?? 0) + folders.length;
      return [...folders];
    },
  });
  const log: string[] = [];
  const service = new RepoDiscoveryService(storage, new GitService(), () => [adapter], {
    enabled: () => true,
    retentionDays: () => 14,
    log: (line) => log.push(line),
  });
  t.after(() => service.dispose());

  await service.scan();
  assert.equal(log.length, 2, 'the first pass logs its start and finish');
  assert.equal(log[0], '[Pitwall] discovery started');
  assert.match(log[1], /^\[Pitwall\] discovery finished: 1 repos \(1 new\), 1 sessions, 0 skipped, \d+ ms \(folders \d+ ms, roots \d+ ms; host CPU \d+ ms\)$/);

  await service.scan();
  assert.equal(log.length, 2, 'a quick pass that adds nothing is not logged');

  folders.push({ cwd: repos[1], firstEntryAt: Date.now(), lastActivity: Date.now() });
  await service.scan();
  assert.equal(log.length, 3, 'a pass that adds a repo logs its finish only');
  assert.match(log[2], /^\[Pitwall\] discovery finished: 2 repos \(1 new\), 2 sessions, 0 skipped, \d+ ms \(folders \d+ ms, roots \d+ ms; host CPU \d+ ms\)$/);

  delayMs = 550;
  await service.scan();
  assert.equal(log.length, 4, 'a slow pass is logged');
  const slow = log[3].match(/^\[Pitwall\] discovery finished: 2 repos \(0 new\), 2 sessions, 0 skipped, \d{3,} ms \(folders (\d+) ms, roots \d+ ms; host CPU \d+ ms\)$/);
  assert.ok(slow, log[3]);
  assert.ok(Number(slow[1]) >= 500, 'the slow step is named: the folders the adapters found');
});
