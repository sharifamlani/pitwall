/**
 * The jobs that can cost real CPU log their time to Pitwall Operations, so
 * the Tester can match an extension-host CPU spike to one of them (0.6.0
 * walk). Discovery's own lines are tested in repo-discovery.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessRegistry } from '../../../src/core/harness/HarnessRegistry';
import { HarnessLiveState } from '../../../src/core/harness/types';
import { SessionAttentionService } from '../../../src/core/services/SessionAttentionService';
import { SessionImportService } from '../../../src/core/services/SessionImportService';
import { WorktreeCatalog } from '../../../src/core/services/WorktreeCatalog';
import { Worktree } from '../../../src/core/types';
import { fakeAdapter, makeStorage, sessionRecord, waitFor, worktreeRecord } from '../support';

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

test('a status poll of 500 ms or more is logged with its time and the chats it read; a quick one is not', async (t) => {
  const quick = attention(0);
  t.after(() => quick.service.dispose());
  await quick.service.poll();
  assert.deepEqual(quick.log.filter((line) => line.includes('status poll')), []);

  const slow = attention(550);
  t.after(() => slow.service.dispose());
  await slow.service.poll();
  assert.equal(slow.log.length, 1);
  assert.match(slow.log[0], /^\[Pitwall\] status poll took \d{3,} ms \(1 chats read\)$/);
});

test('each full import scan logs its repos, sessions and time', async (t) => {
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
  assert.match(log[0], /^\[Pitwall\] import scan: 1 repos, 2 sessions, \d+ ms$/);
});
