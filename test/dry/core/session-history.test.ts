/**
 * The repo row's session history quick pick (row 3.5, plan §3f): chats in the
 * sidebar, then older ones that are not, newest first. Picking an older one
 * brings it back as an idle row and opens it. The harness boundary is faked
 * with the sessions a listing would return; storage is real.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { registerRepositoryCommands } from '../../../src/core/commands/repository';
import { HarnessRegistry } from '../../../src/core/harness/HarnessRegistry';
import { HarnessSession } from '../../../src/core/harness/types';
import { sessionStatus } from '../../../src/core/providers/sessionStatus';
import { ChatSession } from '../../../src/core/types';
import { fakeAdapter, makeStorage, runCommand, sessionRecord, stub, worktreeRecord } from '../support';

beforeEach(() => stub.__reset());

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

interface Row {
  label: string;
  description?: string;
  kind?: number;
  chat?: ChatSession;
  session?: HarnessSession;
}

function setup(t: { after(fn: () => void): void }) {
  const storage = makeStorage();
  const repo = storage.addRepository('job-market', '/work/job-market');
  const main = worktreeRecord({ id: 'wt-main', repoId: repo.id, name: 'main', path: '/work/job-market', branch: 'main' });
  const sessions: HarnessSession[] = [];
  const registry = new HarnessRegistry([
    fakeAdapter('claude', { listSessionsForRepository: async () => sessions, listSessionsForWorktree: async () => sessions }),
  ]);
  registerRepositoryCommands({ subscriptions: [] } as never, {
    storageService: storage,
    gitService: { listRepositoryWorktrees: () => ({ isGit: true, worktrees: [main] }) } as never,
    harnessRegistry: registry,
    forgetWorktrees: () => undefined,
    refreshTree: () => undefined,
  });
  const opened: string[] = [];
  vscode.commands.registerCommand('pitwall.openChat', (item: { data: ChatSession }) => {
    opened.push(item.data.id);
  });

  /** A native session in the repo's main worktree, last active `ageMs` ago. */
  const session = (sessionId: string, summary: string, ageMs: number, gitBranch = 'main') => {
    const record = sessionRecord('claude', sessionId, {
      cwd: main.path,
      summary,
      gitBranch,
      lastUpdated: new Date(Date.now() - ageMs),
      turnState: 'done',
      turnEndedAt: Date.now() - ageMs,
    });
    sessions.push(record);
    return record;
  };
  /** The quick pick the command shows, answered by `choose`. */
  const history = async (choose: (rows: Row[]) => Row | undefined = () => undefined) => {
    let rows: Row[] = [];
    let placeHolder = '';
    stub.__setQuickPickHandler((items: Row[], options: { placeHolder?: string }) => {
      rows = items;
      placeHolder = options?.placeHolder ?? '';
      return choose(items);
    });
    t.after(() => stub.__setQuickPickHandler(null));
    await runCommand('pitwall.sessionHistory', { itemType: 'repository', data: repo });
    return { rows, placeHolder };
  };
  return { storage, repo, main, session, history, opened };
}

test('history lists sidebar chats then older chats, newest first, with the canvas labels', async (t) => {
  const f = setup(t);
  // In the sidebar: chats from 2m, 3h and 40 days ago; age never moves a sidebar chat to OLDER.
  f.storage.createChat(f.main.id, 'claude', 'Older sidebar chat', { harnessSessionId: 's-sidebar-old' });
  f.storage.createChat(f.main.id, 'claude', 'One-off apply', { harnessSessionId: 's-sidebar' });
  f.session('s-sidebar-old', 'Older sidebar chat', 3 * 60 * MINUTE);
  f.storage.createChat(f.main.id, 'claude', 'Ancient sidebar chat', { harnessSessionId: 's-sidebar-ancient' });
  f.session('s-sidebar-ancient', 'Ancient sidebar chat', 40 * DAY);
  f.session('s-sidebar', 'One-off apply', 2 * MINUTE);
  // Not in the sidebar: two native sessions, oldest first on purpose.
  f.session('s-old-b', 'Parser spike (earlier)', 30 * DAY, 'feat/early');
  f.session('s-old-a', 'Resume parser spike', 23 * DAY, 'feat/parse');

  const { rows, placeHolder } = await f.history();

  assert.equal(placeHolder, "Filter job-market's session history");
  assert.deepEqual(
    rows.map((row) => `${row.kind === vscode.QuickPickItemKind.Separator ? '--' : ''}${row.label}${row.description ? ` | ${row.description}` : ''}`),
    [
      '--IN THE SIDEBAR (LAST 14 DAYS)',
      'One-off apply | ⎇ main · 2m',
      'Older sidebar chat | ⎇ main · 3h',
      'Ancient sidebar chat | ⎇ main · 40d',
      '--OLDER · not in the sidebar; pick one to bring it back',
      'Resume parser spike | ⎇ feat/parse · 23d',
      'Parser spike (earlier) | ⎇ feat/early · 30d',
    ]
  );
});

test('history says "None." and "No older chats." for empty groups', async (t) => {
  const { rows } = await setup(t).history();
  assert.deepEqual(
    rows.map((row) => row.label),
    ['IN THE SIDEBAR (LAST 14 DAYS)', 'None.', 'OLDER · not in the sidebar; pick one to bring it back', 'No older chats.']
  );
});

test('picking an older chat imports it and it shows as idle', async (t) => {
  const f = setup(t);
  const older = f.session('s-old', 'Resume parser spike', 23 * DAY, 'feat/parse');

  await f.history((rows) => rows.find((row) => row.session?.sessionId === 's-old'));

  const [chat] = f.storage.getChatsByWorktree(f.main.id);
  assert.equal(chat?.harnessSessionId, 's-old', 'the native session is now a sidebar chat');
  assert.equal(chat.name, 'Resume parser spike', 'named from its summary, like any import');
  assert.deepEqual(f.opened, [chat.id], 'and it opens');
  assert.ok(typeof chat.seenAt === 'number', 'it has a seen baseline (P16)');
  assert.equal(
    sessionStatus({
      live: { turnState: 'done', turnEndedAt: older.lastUpdated?.getTime() ?? null },
      needsYou: false,
      seenAt: chat.seenAt,
    }),
    'idle',
    'its old turn is not "finished"'
  );

  // Picking a chat already in the sidebar only opens it.
  await f.history((rows) => rows.find((row) => row.chat?.id === chat.id));
  assert.equal(f.storage.getChatsByWorktree(f.main.id).length, 1, 'no second copy');
  assert.deepEqual(f.opened, [chat.id, chat.id]);
});

test('a chat shows the same age in session history and on its row', async (t) => {
  const f = setup(t);
  // The row's idle age is the last message (lastActivity); the file's mtime
  // (lastUpdated) is later, as when something touched the transcript.
  f.storage.createChat(f.main.id, 'claude', 'Stale mtime', { harnessSessionId: 's-mtime' });
  f.session('s-mtime', 'Stale mtime', 6 * 60 * MINUTE).lastActivity = Date.now() - 8 * 60 * MINUTE;
  f.session('s-older', 'Older chat', 6 * 60 * MINUTE).lastActivity = Date.now() - 8 * 60 * MINUTE;

  const { rows } = await f.history();

  const text = rows.map((row) => `${row.label} | ${row.description ?? ''}`);
  assert.ok(text.includes('Stale mtime | ⎇ main · 8h'), `sidebar chat, got ${text.join(' ; ')}`);
  assert.ok(text.includes('Older chat | ⎇ main · 8h'), `older chat, got ${text.join(' ; ')}`);
});
