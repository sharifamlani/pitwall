/**
 * Tab adoption wiring (T8, live I1): which sessions a window's restored
 * Claude tabs are matched against. Only this window's folder's sessions,
 * by their agent title (the tab's title) or their row name, once the
 * folder's listing has landed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { claudeUiSurfaces } from '../../../../src/harnesses/claude/claudeUi';
import { startTabAdoption } from '../../../../src/core/windows/tabAdoption';
import type { ChatSession } from '../../../../src/core/types';
import type { HarnessSession } from '../../../../src/core/harness/types';
import { ClaudeHarness } from '../../../../src/harnesses/claude/ClaudeHarness';
import { claudeProfile, entry } from '../../harnesses/claude/claudeFixture';
import { HarnessRegistry } from '../../../../src/core/harness/HarnessRegistry';
import { SessionImportService } from '../../../../src/core/services/SessionImportService';
import { WorktreeCatalog } from '../../../../src/core/services/WorktreeCatalog';
import { unboundTabMayBeChat } from '../../../../src/core/services/chatVisibility';
import { fakeAdapter, makeStorage, sessionRecord, worktreeRecord } from '../../support';

const LAB_C = 'C:\\lab\\uj-lab-c';
const LAB_C_WT = 'C:\\lab\\uj-lab-c-wt';

/** Restored tabs, already in their group when the tracker starts (no open event). */
function restoredWindow(titles: string[]) {
  const tabs = titles.map((label) => ({ label, input: new vscode.TabInputWebview('mainThreadWebview-claudeVSCodePanel'), isActive: false }));
  const groups = [{ isActive: true, activeTab: tabs[tabs.length - 1], tabs }];
  const surfaces = claudeUiSurfaces({
    getTabGroups: () => groups as never,
    onDidChangeTabs: () => ({ dispose: () => undefined }),
    onDidChangeTabGroups: () => ({ dispose: () => undefined }),
    log: () => undefined,
  } as never);
  const bound = () => surfaces.describeTabs()[0].tabs.map((tab) => tab.sessionId);
  return { surfaces, bound };
}

const session = (sessionId: string, summary: string, cwd = LAB_C): HarnessSession =>
  ({ harness: 'claude', sessionId, cwd, summary, gitBranch: null, lastUpdated: null, lastActivity: null, messageCount: 1 }) as HarnessSession;

const chat = (harnessSessionId: string, name: string, worktreeId = 'wt-main'): ChatSession =>
  ({ id: `chat-${harnessSessionId}`, harness: 'claude', harnessSessionId, name, worktreeId }) as ChatSession;

test("a window's restored tabs bind to its folder's sessions by agent title once the listing lands (GT, R1)", async () => {
  const { surfaces, bound } = restoredWindow(['Lab C one', 'Lab C two']);
  let land: (sessions: HarnessSession[]) => void = () => undefined;
  const listing = new Promise<HarnessSession[]>((resolve) => (land = resolve));
  const adoption = startTabAdoption({
    folder: LAB_C,
    adapters: [{ id: 'claude', nativeUi: { surfaces } as never, listSessionsForWorktree: () => listing }],
    // The rows carry the first prompt, not Claude's title.
    chats: () => [chat('095a88d2', 'reply with exactly: lab c one'), chat('23c80023', 'reply with exactly: lab c two')],
    worktreePathOf: () => LAB_C,
  });
  assert.deepEqual(bound(), [undefined, undefined], 'nothing before the listing lands');
  land([session('095a88d2', 'Lab C one'), session('23c80023', 'Lab C two')]);
  await surfaces.adoptBeforeOpen(1_000);
  assert.deepEqual(bound(), ['095a88d2', '23c80023']);
  adoption.dispose();
  surfaces.dispose();
});

test("a panel tab titled with the session's custom title (the user's /rename in Claude) binds to that session (v0.6.0)", async (t) => {
  // Session b3778905: tab "Main" (its custom title), aiTitle and row name "Pitwall initial idea".
  const profile = claudeProfile(t);
  const folder = profile.dir('pitwall');
  const id = 'b3778905-8f98-43f8-94de-35553b9f2d2b';
  profile.write(id, folder, [entry.user('hi'), entry.aiTitle('Pitwall initial idea'), entry.customTitle('Main')]);
  const harness = new ClaudeHarness();
  const { surfaces, bound } = restoredWindow(['Main']);
  const adoption = startTabAdoption({
    folder,
    adapters: [{ id: 'claude', nativeUi: { surfaces } as never, listSessionsForWorktree: (target) => harness.listSessionsForWorktree(target) }],
    chats: () => [chat(id, 'Pitwall initial idea')],
    worktreePathOf: () => folder,
  });
  await surfaces.adoptBeforeOpen(1_000);
  assert.deepEqual(bound(), [id], 'the tab binds, so a click focuses it instead of reaching the live-process guard');
  adoption.dispose();
  surfaces.dispose();
});

test("another folder's session (a worktree's) with the same title is no candidate, and a title two of this folder's sessions share binds nothing (E5)", async () => {
  const { surfaces, bound } = restoredWindow(['E10b live', 'Claude in Chrome browser…']);
  const adoption = startTabAdoption({
    folder: LAB_C,
    adapters: [
      {
        id: 'claude',
        nativeUi: { surfaces } as never,
        listSessionsForWorktree: async () => [
          session('main-live', 'E10b live'),
          session('chrome-1', 'Claude in Chrome browser automation'),
          session('chrome-2', 'Claude in Chrome browser automation'),
        ],
      },
    ],
    chats: () => [chat('wt-live', 'E10b live', 'wt-wt')],
    worktreePathOf: (row) => (row.worktreeId === 'wt-wt' ? LAB_C_WT : LAB_C),
  });
  await surfaces.adoptBeforeOpen(1_000);
  assert.deepEqual(bound(), ['main-live', undefined], "the worktree's chat is not this window's; the shared title stays unknown");
  adoption.dispose();
  surfaces.dispose();
});

test('a title a later scan reports adopts its tab then', async () => {
  const { surfaces, bound } = restoredWindow(['Plus b']);
  const listed = new vscode.EventEmitter<HarnessSession[]>();
  const adoption = startTabAdoption({
    folder: LAB_C,
    adapters: [{ id: 'claude', nativeUi: { surfaces } as never, listSessionsForWorktree: async () => [] }],
    chats: () => [],
    worktreePathOf: () => undefined,
    onSessionsListed: listed.event,
  });
  await surfaces.adoptBeforeOpen(1_000);
  assert.deepEqual(bound(), [undefined]);
  listed.fire([session('27b31ca7', 'Plus b', LAB_C_WT)]);
  assert.deepEqual(bound(), [undefined], 'a session of another folder is ignored');
  listed.fire([session('27b31ca7', 'Plus b')]);
  assert.deepEqual(bound(), ['27b31ca7']);
  adoption.dispose();
  surfaces.dispose();
});

test('an empty window adopts nothing and lists nothing', () => {
  let listed = 0;
  const { surfaces } = restoredWindow(['Lab C one']);
  startTabAdoption({
    folder: undefined,
    adapters: [{ id: 'claude', nativeUi: { surfaces } as never, listSessionsForWorktree: async () => (listed++, []) }],
    chats: () => [],
    worktreePathOf: () => undefined,
  }).dispose();
  assert.equal(listed, 0);
  surfaces.dispose();
});

test("a brand-new chat's tab binds once importLive reads its session, and until then counts as in front as an unbound tab (QA on #73)", async (t) => {
  const { surfaces, bound } = restoredWindow(['Night ferry story']);
  const storage = makeStorage();
  const repo = storage.addRepository('uj-lab-c', LAB_C);
  const worktree = worktreeRecord({ id: 'wt-c', repoId: repo.id, path: LAB_C });
  const listed = new vscode.EventEmitter<HarnessSession[]>();
  const transcript = sessionRecord('claude', '12f645db', { cwd: LAB_C, summary: 'Night ferry story', lastActivity: Date.now() - 1_000 });
  const adapter = fakeAdapter('claude', {
    nativeUi: { surfaces } as never,
    getSession: async (sessionId: string) => (sessionId === '12f645db' ? transcript : null),
  });
  const importer = new SessionImportService(
    storage,
    new WorktreeCatalog(storage, {
      listRepositoryWorktrees: () => ({ isGit: true, worktrees: [worktree] }),
      listRepositoryWorktreesAsync: async () => ({ isGit: true, worktrees: [worktree] }),
    } as never),
    new HarnessRegistry([adapter]),
    { isVisible: () => false, onSessionsListed: (sessions) => listed.fire(sessions), readSettings: () => ({ enabled: true, retentionDays: 7 }) }
  );
  t.after(() => importer.dispose());
  const adoption = startTabAdoption({
    folder: LAB_C,
    adapters: [{ id: 'claude', nativeUi: { surfaces } as never, listSessionsForWorktree: async () => [] }],
    chats: () => storage.getChats(),
    worktreePathOf: (chat) => (chat.worktreeId === worktree.id ? LAB_C : undefined),
    onSessionsListed: listed.event,
  });
  await surfaces.adoptBeforeOpen(1_000);
  assert.equal(surfaces.activeTabUnbound(), true, 'the new tab is in front, bound to nothing');

  await importer.importLive(['12f645db']);
  const chat = storage.getChats().find((entry) => entry.harnessSessionId === '12f645db')!;
  assert.ok(chat, 'listed');
  assert.deepEqual(bound(), ['12f645db'], 'the tab binds to it at once');
  assert.equal(surfaces.activeTabUnbound(), false);
  assert.equal(unboundTabMayBeChat(chat, { adapters: () => [adapter], worktreePathOf: () => LAB_C, folders: () => [LAB_C] }), false, 'bound: the ordinary front check takes over');

  // Before a tab binds, a chat of this folder without a bound tab counts as possibly in front; one of another folder or harness never does.
  const fresh = restoredWindow(['Claude Code']);
  const freshAdapter = { ...adapter, nativeUi: { surfaces: fresh.surfaces } as never };
  const unbound = { adapters: () => [freshAdapter], worktreePathOf: () => LAB_C, folders: () => [LAB_C] };
  assert.equal(unboundTabMayBeChat(chat, unbound), true);
  assert.equal(unboundTabMayBeChat(chat, { ...unbound, worktreePathOf: () => LAB_C_WT }), false, "another folder's chat");
  assert.equal(unboundTabMayBeChat({ ...chat, harness: 'codex' } as ChatSession, unbound), false, "another harness's chat");
  adoption.dispose();
  surfaces.dispose();
  fresh.surfaces.dispose();
});
