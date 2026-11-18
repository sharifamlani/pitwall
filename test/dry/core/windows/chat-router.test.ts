/**
 * The chat router (rows 4.2, 4.6, 4.8; Q1, Q2, Q16, Q17, Q23): clicking a chat
 * opens it in its launch folder's window. A chat whose folder is this window's
 * opens here; any other is handed off through the inbox and its window raised
 * with `vscode.openFolder`. Real temp dirs, real transcripts read by the real
 * Claude harness, and a real inbox shared by a sender and a claimer.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatRouter, ROUTER_TIMING } from '../../../../src/core/windows/ChatRouter';
import { EXPIRE_MS, HandoffInbox, HandoffRequest, WARN_MS } from '../../../../src/core/windows/HandoffInbox';
import { ownsFolder } from '../../../../src/core/windows/WindowRegistry';
import { HarnessRegistry } from '../../../../src/core/harness/HarnessRegistry';
import { ClaudeHarness } from '../../../../src/harnesses/claude/ClaudeHarness';
import { registerRepositoryCommands } from '../../../../src/core/commands/repository';
import { WorkspaceTreeItem } from '../../../../src/core/providers/WorkspacesTreeProvider';
import { ChatSession, Worktree } from '../../../../src/core/types';
import { samePath } from '../../../../src/core/utils/paths';
import { claudeProfile } from '../../harnesses/claude/claudeFixture';
import { assertNoLongBlock, makeStorage, runCommand, shownMessages, stub, tempDir, waitFor, worktreeRecord } from '../../support';

beforeEach(() => stub.__reset());

const ID = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222',
  c: '33333333-3333-4333-8333-333333333333',
  t18: '44444444-4444-4444-8444-444444444444',
  t18b: '99999999-9999-4999-8999-999999999999',
  t17: '55555555-5555-4555-8555-555555555555',
  other: '66666666-6666-4666-8666-666666666666',
  gone: '77777777-7777-4777-8777-777777777777',
  sdk: '88888888-8888-4888-8888-888888888888',
};

/** Short timings so the 20 s warning and 120 s expiry run in milliseconds. */
const FAST = { warnMs: 150, coldWarnMs: 150, expireMs: 400, pollMs: 10, servicesWaitMs: 300 };
const GONE = (folder: string) => `That chat's folder is gone: ${folder}`;
const UNREACHED = (repo: string) => `Pitwall couldn't reach the ${repo} window. Click the chat again.`;

/**
 * Repo `demo` (main folder + a worktree nested under `.claude/worktrees`, as
 * Claude Code makes them) and repo `other`, all real folders, with a Claude
 * profile whose transcripts the tests write raw.
 */
function world(t: { after(fn: () => void): void }) {
  const profile = claudeProfile(t);
  const scratch = tempDir(t, 'pitwall-t3-');
  const main = path.join(scratch, 'demo');
  const wt = path.join(main, '.claude', 'worktrees', 'feat');
  const other = path.join(scratch, 'other');
  for (const dir of [main, wt, other]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const storage = makeStorage();
  const demoRepo = storage.addRepository('demo', main);
  const otherRepo = storage.addRepository('other', other);
  const mainWt = worktreeRecord({ id: 'wt-main', repoId: demoRepo.id, name: 'demo', path: main, branch: 'main' });
  const featWt = worktreeRecord({ id: 'wt-feat', repoId: demoRepo.id, name: 'feat', path: wt, branch: 'feat', isMain: false });
  const otherWt = worktreeRecord({ id: 'wt-other', repoId: otherRepo.id, name: 'other', path: other, branch: 'main' });
  const goneWt = worktreeRecord({ id: 'wt-gone', repoId: demoRepo.id, name: 'gone', path: path.join(scratch, 'deleted-worktree'), isMain: false });
  const worktrees: Worktree[] = [mainWt, featWt, otherWt, goneWt];

  /** Write a transcript under the project folder Claude uses for `projectCwd`. */
  const transcript = (projectCwd: string, sessionId: string, lines: (object | string)[]): string => {
    const dir = profile.projectDir(projectCwd);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line)) + '\n').join(''));
    return file;
  };
  const queued = () => ({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date().toISOString() });
  /** A user turn in `cwd`, started from Claude's panel (Q23: the panel can resume it). */
  const turn = (sessionId: string, cwd: string, entrypoint = 'claude-vscode') => ({
    type: 'user',
    cwd,
    sessionId,
    entrypoint,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'hi' },
  });
  const chat = (name: string, sessionId: string, worktree: Worktree): ChatSession =>
    storage.createChat(worktree.id, 'claude', name, { harnessSessionId: sessionId });
  return { profile, scratch, main, wt, other, storage, mainWt, featWt, otherWt, goneWt, worktrees, transcript, queued, turn, chat };
}

type World = ReturnType<typeof world>;

/** A window on `folder` (undefined: an empty window): its inbox and router, and what it did. */
function windowOn(
  t: { after(fn: () => void): void },
  w: World,
  dir: string,
  folder: () => string | undefined,
  options: {
    pid: number;
    claims?: string;
    timing?: typeof FAST;
    /** When the window services are up; always, unless a test says otherwise. */
    servicesUp?: () => boolean;
    /** The folders the registry has a live window on (Q26); none by default. */
    windowsAt?: string[];
    openHere?: (chat: ChatSession, worktree: Worktree) => Promise<boolean | 'terminal'>;
    /** Whether a chat's tab or terminal is open in this window; never, by default. */
    isOpenHere?: (chat: ChatSession) => boolean;
    /** Other windows' open sessions, as the registry's heartbeats list them. */
    openIn?: { folder: string; sessionIds: string[]; pid?: number }[];
    /** The pid of a live process outside Pitwall running a session (a terminal the user started), if any. */
    outsideTerminal?: (sessionId: string) => number | { pid: number; panel: boolean } | undefined;
    /** Record the serial opens the router asks the tab tracker for. */
    serial?: ({ ids: string[]; results?: unknown[] }[] & { recordResults?: boolean });
    /** Record the side-by-side splits the router asks for. */
    splits?: string[][];
  }
) {
  const logs: string[] = [];
  const routeLog: string[] = [];
  const inbox = new HandoffInbox(dir, { pid: options.pid, folder: options.claims }, Date.now, (line) => logs.push(line));
  const registry = {
    windowsFor: async (target: string) =>
      (options.windowsAt ?? []).filter((folder) => samePath(folder, target)).map((folder, index) => ({ pid: 9000 + index, folder, beatAt: Date.now(), openSessionIds: [] })),
  };
  const registryWithOpen = {
    ...registry,
    windows: async () => (options.openIn ?? []).map((entry, index) => ({ pid: entry.pid ?? 8000 + index, folder: entry.folder, beatAt: Date.now(), openSessionIds: entry.sessionIds })),
  };
  const opened: { chat: string; path: string; worktreeId: string }[] = [];
  const started: string[] = [];
  const router = new ChatRouter({
    services: () => ((options.servicesUp?.() ?? true) ? { inbox, registry: registryWithOpen } : undefined),
    windowFolder: folder,
    harnessRegistry: new HarnessRegistry([new ClaudeHarness()]),
    worktreeOf: async (chat) => w.worktrees.find((worktree) => worktree.id === chat.worktreeId),
    rootsOf: (worktree) => w.worktrees.filter((candidate) => candidate.repoId === worktree.repoId).map((candidate) => candidate.path),
    repoName: (target) => (target.startsWith(w.other) ? 'other' : 'demo'),
    isOpenHere: (chat) => options.isOpenHere?.(chat) ?? false,
    log: (line) => routeLog.push(line),
    chatForSession: (sessionId) => w.storage.getChats().find((chat) => chat.harnessSessionId === sessionId),
    openHere: async (chat, worktree) => {
      opened.push({ chat: chat.name, path: worktree.path, worktreeId: worktree.id });
      return options.openHere ? options.openHere(chat, worktree) : true;
    },
    startNew: async (target) => {
      started.push(target);
      return true;
    },
    timing: options.timing ?? FAST,
    outsideTerminal: options.outsideTerminal
      ? async (sessionId: string) => {
          const found = options.outsideTerminal!(sessionId);
          return typeof found === 'number' ? { pid: found } : found;
        }
      : undefined,
    openSerially: options.serial
      ? async (ids: string[], open: (id: string) => Promise<unknown>) => {
          const entry: { ids: string[]; results?: unknown[] } = { ids: [...ids] };
          options.serial!.push(entry);
          const results: unknown[] = [];
          for (const id of ids) {
            results.push(await open(id));
          }
          if (options.serial!.recordResults) {
            entry.results = results;
          }
        }
      : undefined,
    sideBySide: options.splits ? async (ids: string[]) => void options.splits!.push([...ids]) : undefined,
  });
  t.after(() => router.dispose());
  return { inbox, router, logs, routeLog, opened, started };
}

/** Records `vscode.openFolder` calls. */
function openFolderCalls() {
  const calls: { path: string; forceNewWindow?: boolean }[] = [];
  vscode.commands.registerCommand('vscode.openFolder', (uri: vscode.Uri, options?: { forceNewWindow?: boolean }) => {
    calls.push({ path: uri.fsPath, forceNewWindow: options?.forceNewWindow });
  });
  return calls;
}

/** The request files waiting in `folder`'s inbox. */
function requestsFor(inbox: HandoffInbox, dir: string, folder: string): HandoffRequest[] {
  const folderDir = path.join(dir, 'pitwall-handoff', inbox.folderKey(folder));
  if (!fs.existsSync(folderDir)) {
    return [];
  }
  return fs
    .readdirSync(folderDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(folderDir, name), 'utf8')) as HandoffRequest);
}

function filesIn(inbox: HandoffInbox, dir: string, folder: string): string[] {
  const folderDir = path.join(dir, 'pitwall-handoff', inbox.folderKey(folder));
  return fs.existsSync(folderDir) ? fs.readdirSync(folderDir) : [];
}

const warnings = (text: string) => shownMessages().filter((message) => message === text);

test('the router waits 20 s for a done{ok} and expires an unclaimed request at 120 s (Q16)', () => {
  assert.deepEqual([ROUTER_TIMING.warnMs, ROUTER_TIMING.expireMs], [WARN_MS, EXPIRE_MS]);
  assert.equal(ROUTER_TIMING.coldWarnMs, 60_000, 'a cold open warns at 60 s (Q26)');
  assert.deepEqual([WARN_MS, EXPIRE_MS], [20_000, 120_000]);
});

test('same-folder chat opens here without writing a request', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  const here = windowOn(t, w, dir, () => w.main, { pid: 1001, claims: w.main });

  const result = await here.router.route({ kind: 'open', chats: [w.chat('Here', ID.a, w.mainWt)] });

  assert.equal(result, 'here');
  assert.deepEqual(here.opened.map((entry) => [entry.chat, entry.path]), [['Here', w.main]]);
  assert.deepEqual(filesIn(here.inbox, dir, w.main), [], 'no request file');
  assert.deepEqual(calls, [], 'no window is raised');
});

test('other-folder chat writes one request and calls vscode.openFolder with forceNewWindow', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other });

  const result = await sender.router.route({ kind: 'open', chats: [w.chat('Elsewhere', ID.a, w.mainWt)] });

  assert.equal(result, 'routed');
  const requests = requestsFor(sender.inbox, dir, w.main);
  assert.equal(requests.length, 1);
  assert.deepEqual([requests[0].kind, requests[0].sessionIds, requests[0].folder], ['open', [ID.a], w.main]);
  assert.deepEqual(calls, [{ path: w.main, forceNewWindow: true }]);
  assert.deepEqual(sender.opened, [], 'nothing opens in the sending window');
});

test('launch folder skips leading entries with no cwd', async (t) => {
  const w = world(t);
  w.transcript(w.main, ID.a, [w.queued(), w.queued(), { type: 'summary', summary: 'no cwd here' }, w.turn(ID.a, w.main)]);
  const { router } = windowOn(t, w, tempDir(t), () => undefined, { pid: 1001 });
  assert.equal(await router.launchFolder(w.chat('Queued first', ID.a, w.mainWt)), w.main);
});

test('launch folder finds a cwd after a first line over 64 KB', async (t) => {
  const w = world(t);
  w.transcript(w.main, ID.a, [{ type: 'summary', summary: 'x'.repeat(100 * 1024) }, w.turn(ID.a, w.main)]);
  const { router } = windowOn(t, w, tempDir(t), () => undefined, { pid: 1001 });
  assert.equal(await router.launchFolder(w.chat('Long head', ID.a, w.mainWt)), w.main);
});

test('a chat moved into a worktree by EnterWorktree (early cwd = main, filed under the worktree) routes to the worktree window', async (t) => {
  // T18 (live c7c894db): EnterWorktree moves the transcript into the worktree's
  // project folder, and its early entries keep the main folder's cwd. The folder
  // the transcript is filed under decides, since Claude's panel resumes it from
  // there; the first cwd is only the candidate. Pitwall lists it under main.
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  w.transcript(w.wt, ID.t18, [w.turn(ID.t18, w.main), w.turn(ID.t18, w.main), w.turn(ID.t18, w.wt), w.turn(ID.t18, w.wt)]);
  const chat = w.chat('Entered a worktree', ID.t18, w.mainWt);
  const mainWindow = windowOn(t, w, dir, () => w.main, { pid: 1001, claims: w.main });

  assert.equal(await mainWindow.router.launchFolder(chat), w.wt);
  assert.equal(await mainWindow.router.route({ kind: 'open', chats: [chat] }), 'routed');
  assert.deepEqual(requestsFor(mainWindow.inbox, dir, w.wt).map((request) => request.sessionIds), [[ID.t18]]);
  assert.deepEqual(calls, [{ path: w.wt, forceNewWindow: true }]);
  assert.deepEqual(mainWindow.opened, [], 'not opened in the main window, where the panel would open it blank');
});

test('a plain cd chat (all cwd = main, filed under main) routes to the main window', async (t) => {
  // T18b (live ba8b7179): a Bash `cd` into the worktree moves neither the cwd nor the transcript.
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  w.transcript(w.main, ID.t18b, [w.turn(ID.t18b, w.main), w.turn(ID.t18b, w.main), w.turn(ID.t18b, w.main)]);
  const chat = w.chat('cd into a worktree', ID.t18b, w.mainWt);
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other });

  assert.equal(await sender.router.launchFolder(chat), w.main);
  assert.equal(await sender.router.route({ kind: 'open', chats: [chat] }), 'routed');
  assert.deepEqual(requestsFor(sender.inbox, dir, w.main).map((request) => request.sessionIds), [[ID.t18b]]);
  assert.deepEqual(requestsFor(sender.inbox, dir, w.wt), []);
  assert.deepEqual(calls, [{ path: w.main, forceNewWindow: true }]);
});

test("a first cwd that doesn't match the transcript's project folder falls back to the matching repo or worktree", async (t) => {
  const w = world(t);
  // A fork: its first entry carries the parent's cwd (main), but Claude stored
  // it under the worktree's project folder, which is where its panel resumes it.
  w.transcript(w.wt, ID.a, [w.turn(ID.a, w.main), w.turn(ID.a, w.wt)]);
  // A resume from a folder that is not one of the repo's: the main folder's project wins.
  const elsewhere = path.join(w.scratch, 'elsewhere');
  fs.mkdirSync(elsewhere);
  w.transcript(w.main, ID.b, [w.turn(ID.b, elsewhere)]);
  const { router } = windowOn(t, w, tempDir(t), () => undefined, { pid: 1001 });

  assert.equal(await router.launchFolder(w.chat('Fork', ID.a, w.featWt)), w.wt);
  assert.equal(await router.launchFolder(w.chat('Resumed elsewhere', ID.b, w.mainWt)), w.main);
});

test('worktree chat routes to the worktree folder', async (t) => {
  // T17: a chat started in a worktree opens in that worktree's own window.
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  w.transcript(w.wt, ID.t17, [w.turn(ID.t17, w.wt)]);
  const mainWindow = windowOn(t, w, dir, () => w.main, { pid: 1001, claims: w.main });

  const result = await mainWindow.router.route({ kind: 'open', chats: [w.chat('In the worktree', ID.t17, w.featWt)] });

  assert.equal(result, 'routed');
  assert.deepEqual(requestsFor(mainWindow.inbox, dir, w.wt).map((request) => request.sessionIds), [[ID.t17]]);
  assert.deepEqual(calls, [{ path: w.wt, forceNewWindow: true }]);
  assert.deepEqual(mainWindow.opened, []);
});

test('a T18 chat claimed in the worktree window opens there (availability checked against the launch folder)', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  openFolderCalls();
  // Listed under main (its first cwd), filed under the worktree (EnterWorktree).
  w.transcript(w.wt, ID.t18, [w.turn(ID.t18, w.main), w.turn(ID.t18, w.wt)]);
  const chat = w.chat('Entered a worktree', ID.t18, w.mainWt);
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other });
  const wtWindow = windowOn(t, w, dir, () => w.wt, { pid: 1002, claims: w.wt });

  assert.equal(await sender.router.route({ kind: 'open', chats: [chat] }), 'routed');
  assert.deepEqual(requestsFor(sender.inbox, dir, w.wt).map((request) => request.sessionIds), [[ID.t18]], 'sent to the worktree, where it is filed');
  await wtWindow.router.runClaimed(await wtWindow.inbox.claimAll());

  // Availability is checked against the launch folder (the worktree), never the main folder it is listed under.
  assert.deepEqual(wtWindow.opened, [{ chat: 'Entered a worktree', path: w.wt, worktreeId: 'wt-main' }]);
  assert.ok(wtWindow.logs.some((line) => /^\[Pitwall\] handoff opened [0-9a-f]{8} after \d+ ms$/.test(line)), wtWindow.logs.join('\n'));

  // And clicked in the worktree window itself, it opens there with no handoff.
  assert.equal(await wtWindow.router.route({ kind: 'open', chats: [chat] }), 'here');
  assert.deepEqual(wtWindow.opened.at(-1), { chat: 'Entered a worktree', path: w.wt, worktreeId: 'wt-main' });
});

test('missing folder shows "That chat\'s folder is gone: {path}" and opens no window', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other });

  const result = await sender.router.route({ kind: 'open', chats: [w.chat('Deleted worktree', ID.gone, w.goneWt)] });

  assert.equal(result, 'gone');
  assert.deepEqual(warnings(GONE(w.goneWt.path)), [GONE(w.goneWt.path)]);
  assert.deepEqual(calls, [], 'no window opens');
  assert.deepEqual(filesIn(sender.inbox, dir, w.goneWt.path), [], 'no request');
  assert.deepEqual(sender.opened, []);
});

test('no done{ok} within 20 s warns once with "Pitwall couldn\'t reach the {repo} window. Click the chat again."', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other });

  await sender.router.route({ kind: 'open', chats: [w.chat('Nobody home', ID.a, w.mainWt)] });
  // (No registry window here: a cold open, whose wait FAST sets equal to the warm one.)
  assert.deepEqual(warnings(UNREACHED('demo')), [], 'no warning before the wait ends');
  await waitFor(() => warnings(UNREACHED('demo')).length > 0, 'the warning');
  // Past the expiry: the unclaimed request is expired, and the warning was not repeated.
  await waitFor(() => filesIn(sender.inbox, dir, w.main).some((name) => name.endsWith('.expired')), 'the expiry');
  await new Promise((resolve) => setTimeout(resolve, FAST.pollMs * 5));
  assert.equal(warnings(UNREACHED('demo')).length, 1, 'warned once');
  assert.ok(sender.logs.some((line) => /^\[Pitwall\] handoff expired [0-9a-f]{8}$/.test(line)), sender.logs.join('\n'));
});

test('a claim whose open fails still warns the sender', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  const slowWarn = { ...FAST, warnMs: 60_000, expireMs: 120_000 };
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other, timing: slowWarn });
  const mainWindow = windowOn(t, w, dir, () => w.main, { pid: 1002, claims: w.main, openHere: async () => false });

  await sender.router.route({ kind: 'open', chats: [w.chat('Refused', ID.a, w.mainWt)] });
  await mainWindow.router.runClaimed(await mainWindow.inbox.claimAll());

  assert.ok(mainWindow.logs.some((line) => /^\[Pitwall\] handoff failed [0-9a-f]{8} /.test(line)), mainWindow.logs.join('\n'));
  await waitFor(() => warnings(UNREACHED('demo')).length > 0, 'the warning after a failed open, long before the 20 s wait');
  assert.equal(warnings(UNREACHED('demo')).length, 1);
});

test('a second route for the same chat while pending writes no second file and calls openFolder again', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  const chat = w.chat('Double click', ID.a, w.mainWt);
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other });

  await sender.router.route({ kind: 'open', chats: [chat] });
  await sender.router.route({ kind: 'open', chats: [chat] });

  assert.equal(requestsFor(sender.inbox, dir, w.main).length, 1, 'one request file');
  assert.deepEqual(calls, [
    { path: w.main, forceNewWindow: true },
    { path: w.main, forceNewWindow: true },
  ]);
});

test('"+" twice on a slow-starting window starts one chat', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other });

  await sender.router.route({ kind: 'new', chats: [], folder: w.main });
  await sender.router.route({ kind: 'new', chats: [], folder: w.main });
  assert.equal(calls.length, 2, 'each click raises the window');

  // The window finally starts and claims what is waiting.
  const mainWindow = windowOn(t, w, dir, () => w.main, { pid: 1002, claims: w.main });
  await mainWindow.router.runClaimed(await mainWindow.inbox.claimAll());
  assert.deepEqual(mainWindow.started, [w.main], 'one new chat');
  assert.deepEqual(sender.started, [], 'none in the sending window');
});

// Live E4 at e9a4807: two fast "+" clicks logged two "handoff sent" lines in
// the same millisecond, because both passed the file check before either
// request file existed. No await between the two calls here.
test('two "+" clicks in the same tick send one request', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  openFolderCalls();
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other });

  await Promise.all([
    sender.router.route({ kind: 'new', chats: [], folder: w.main }),
    sender.router.route({ kind: 'new', chats: [], folder: w.main }),
  ]);

  assert.equal(requestsFor(sender.inbox, dir, w.main).length, 1, 'one request file');
  assert.equal(sender.logs.filter((line) => line.startsWith('[Pitwall] handoff sent ')).length, 1);
  const mainWindow = windowOn(t, w, dir, () => w.main, { pid: 1002, claims: w.main });
  await mainWindow.router.runClaimed(await mainWindow.inbox.claimAll());
  assert.deepEqual(mainWindow.started, [w.main], 'one new chat');
});

// Two DIFFERENT routes (so not joined as one) that hand off the same chat to
// the same folder: only the sent-request set keeps them to one request.
test('a multi-chat open and a single open of one of its chats in the same tick send one request for it', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  w.transcript(w.other, ID.other, [w.turn(ID.other, w.other)]);
  const remote = w.chat('Remote', ID.a, w.mainWt);
  const local = w.chat('Local', ID.other, w.otherWt);
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other });
  // Hold each file check until both hand-offs could reach it (200 ms at most),
  // so the two always race on a file neither has written yet.
  const pending = sender.inbox.pending.bind(sender.inbox);
  let entered = 0;
  sender.inbox.pending = async (...args: Parameters<HandoffInbox['pending']>) => {
    entered += 1;
    const deadline = Date.now() + 200;
    while (entered < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return pending(...args);
  };

  await Promise.all([
    sender.router.route({ kind: 'open', chats: [remote, local] }),
    sender.router.route({ kind: 'open', chats: [remote] }),
  ]);

  assert.deepEqual(requestsFor(sender.inbox, dir, w.main).map((request) => request.sessionIds), [[ID.a]], 'one request for the remote chat');
  assert.equal(sender.logs.filter((line) => line.startsWith('[Pitwall] handoff sent ')).length, 1);
  assert.deepEqual(sender.opened.map((entry) => entry.chat), ['Local'], 'the local chat opens here once');
});

// The in-flight layer alone: a same-tick double click on a chat of this
// window joins the first route, so the chat opens here once.
test('two same-tick opens of a chat of this window open it once', async (t) => {
  const w = world(t);
  openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  const chat = w.chat('Local double click', ID.a, w.mainWt);
  const here = windowOn(t, w, tempDir(t), () => w.main, { pid: 1001, claims: w.main });

  const results = await Promise.all([
    here.router.route({ kind: 'open', chats: [chat] }),
    here.router.route({ kind: 'open', chats: [chat] }),
  ]);

  assert.deepEqual(results, ['here', 'here']);
  assert.deepEqual(here.opened.map((entry) => entry.chat), ['Local double click'], 'opened once');
});

test('two route calls for the same chat in the same tick send one request', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  const chat = w.chat('Double click', ID.a, w.mainWt);
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other });

  const results = await Promise.all([
    sender.router.route({ kind: 'open', chats: [chat] }),
    sender.router.route({ kind: 'open', chats: [chat] }),
  ]);

  assert.deepEqual(results, ['routed', 'routed']);
  assert.equal(requestsFor(sender.inbox, dir, w.main).length, 1, 'one request file');
  assert.equal(sender.logs.filter((line) => line.startsWith('[Pitwall] handoff sent ')).length, 1);
});

test('"+" on another repo sends kind new to that repo', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other });

  assert.equal(await sender.router.route({ kind: 'new', chats: [], folder: w.main }), 'routed');
  const [request] = requestsFor(sender.inbox, dir, w.main);
  assert.deepEqual([request.kind, request.sessionIds, request.folder], ['new', [], w.main]);
  assert.deepEqual(calls, [{ path: w.main, forceNewWindow: true }]);

  // "+" on this window's own repo starts the chat here.
  assert.equal(await sender.router.route({ kind: 'new', chats: [], folder: w.other }), 'here');
  assert.deepEqual(sender.started, [w.other]);
  assert.deepEqual(requestsFor(sender.inbox, dir, w.other), []);
});

test('an empty window routes every chat', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  w.transcript(w.other, ID.other, [w.turn(ID.other, w.other)]);
  const empty = windowOn(t, w, dir, () => undefined, { pid: 1001 });

  assert.equal(await empty.router.route({ kind: 'open', chats: [w.chat('Demo chat', ID.a, w.mainWt)] }), 'routed');
  assert.equal(await empty.router.route({ kind: 'open', chats: [w.chat('Other chat', ID.other, w.otherWt)] }), 'routed');

  assert.deepEqual(empty.opened, []);
  assert.equal(requestsFor(empty.inbox, dir, w.main).length, 1);
  assert.equal(requestsFor(empty.inbox, dir, w.other).length, 1);
  assert.deepEqual(calls.map((call) => call.path), [w.main, w.other]);
  assert.deepEqual(await empty.inbox.claimAll(), [], 'an empty window claims nothing');
});

test('a multi-root window opens its own first-folder chats locally and routes others', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  stub.workspace.workspaceFolders = [{ uri: { fsPath: w.main } }, { uri: { fsPath: w.other } }];
  assert.equal(ownsFolder(), undefined, 'a multi-root window owns no folder, so it claims nothing (Q17)');
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  w.transcript(w.other, ID.other, [w.turn(ID.other, w.other)]);
  const multi = windowOn(t, w, dir, () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, { pid: 1001, claims: ownsFolder() });

  assert.equal(await multi.router.route({ kind: 'open', chats: [w.chat('First folder', ID.a, w.mainWt)] }), 'here');
  assert.equal(await multi.router.route({ kind: 'open', chats: [w.chat('Second folder', ID.other, w.otherWt)] }), 'routed');

  assert.deepEqual(multi.opened.map((entry) => entry.chat), ['First folder']);
  assert.deepEqual(calls.map((call) => call.path), [w.other]);
  assert.equal(requestsFor(multi.inbox, dir, w.other).length, 1);
});

test('runClaimed opens chats one at a time in request order and logs handoff opened', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  openFolderCalls();
  for (const id of [ID.a, ID.b, ID.c]) {
    w.transcript(w.main, id, [w.turn(id, w.main)]);
  }
  const events: string[] = [];
  // A freshly opened window may not have started Claude's extension yet (S2b).
  const extensions = vscode.extensions as unknown as { getExtension: (id: string) => unknown };
  const getExtension = extensions.getExtension;
  extensions.getExtension = (id: string) =>
    id === 'anthropic.claude-code' ? { id, isActive: false, activate: async () => void events.push('activate claude') } : getExtension(id);
  t.after(() => {
    extensions.getExtension = getExtension;
  });
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other });
  const mainWindow = windowOn(t, w, dir, () => w.main, {
    pid: 1002,
    claims: w.main,
    openHere: async (chat) => {
      events.push(`start ${chat.name}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
      events.push(`end ${chat.name}`);
      return true;
    },
  });

  await sender.router.route({ kind: 'open', chats: [w.chat('A', ID.a, w.mainWt)] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await sender.router.route({ kind: 'openAll', chats: [w.chat('B', ID.b, w.mainWt), w.chat('C', ID.c, w.mainWt)] });
  const claimed = await mainWindow.inbox.claimAll();
  claimed.sort((x, y) => x.at - y.at);
  await mainWindow.router.runClaimed(claimed);

  assert.deepEqual(events, ['activate claude', 'start A', 'end A', 'start B', 'end B', 'start C', 'end C']);
  const opened = mainWindow.logs.filter((line) => line.startsWith('[Pitwall] handoff opened '));
  assert.deepEqual(
    opened.map((line) => line.split(' ')[3]),
    claimed.map((request) => request.nonce.slice(0, 8)),
    'one "handoff opened" per request, in order'
  );
  for (const request of claimed) {
    assert.deepEqual(await sender.inbox.outcome(w.main, request.nonce), { ok: true });
  }
});

test('an sdk-cli chat from another folder routes to its window and opens in a terminal there', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  w.transcript(w.main, ID.sdk, [w.turn(ID.sdk, w.main, 'sdk-cli')]);
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other });
  const target = windowOn(t, w, dir, () => w.main, { pid: 1002, claims: w.main });

  assert.equal(await sender.router.route({ kind: 'open', chats: [w.chat('From claude -p', ID.sdk, w.mainWt)] }), 'routed');
  assert.deepEqual(sender.opened, [], 'nothing opens in the sending window');
  assert.deepEqual(calls.map((call) => call.path), [w.main]);
  assert.deepEqual(requestsFor(sender.inbox, dir, w.main).map((request) => request.sessionIds), [[ID.sdk]]);

  // The target window opens it locally; the chat commands' local open sends an
  // sdk-cli chat to a terminal there (Q23, unit-tested in the chat commands).
  await target.router.runClaimed(await target.inbox.claimAll());
  assert.deepEqual(target.opened.map((entry) => [entry.chat, entry.path]), [['From claude -p', w.main]]);
});

// E10 (live): a chat filed under the worktree's project folder opened in the
// main window with no route line. The decision comes first, and is logged.
test("a chat filed under the worktree's project dir whose stored worktree is main routes to the worktree window", async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  const wtDir = `${w.main}-wt`;
  fs.mkdirSync(wtDir);
  w.transcript(wtDir, ID.t18, [w.turn(ID.t18, w.main), w.turn(ID.t18, wtDir)]);
  const chat = w.chat('T18 one', ID.t18, w.mainWt);
  const mainWindow = windowOn(t, w, dir, () => w.main, { pid: 1001, claims: w.main, isOpenHere: () => false });

  assert.equal(await mainWindow.router.route({ kind: 'open', chats: [chat] }), 'routed');
  assert.deepEqual(calls.map((call) => call.path), [wtDir]);
  assert.deepEqual(mainWindow.opened, []);
  assert.deepEqual(mainWindow.routeLog, [`[Pitwall] route ${ID.t18.slice(0, 8)} → ${wtDir} (handoff)`]);
});

test('an exited EnterWorktree chat (filed under main, last cwd = the worktree) routes to the main window', async (t) => {
  const w = world(t);
  const calls = openFolderCalls();
  const wtDir = `${w.main}-wt`;
  fs.mkdirSync(wtDir);
  // After /exit Claude files the transcript under main again.
  w.transcript(w.main, ID.t18, [w.turn(ID.t18, w.main), w.turn(ID.t18, wtDir)]);
  const chat = w.chat('T18 exited', ID.t18, w.mainWt);
  const mainWindow = windowOn(t, w, tempDir(t), () => w.main, { pid: 1001, claims: w.main });

  assert.equal(await mainWindow.router.route({ kind: 'open', chats: [chat] }), 'here');
  assert.deepEqual(mainWindow.opened.map((entry) => entry.path), [w.main]);
  assert.deepEqual(calls, []);
  assert.deepEqual(mainWindow.routeLog, [`[Pitwall] route ${ID.t18.slice(0, 8)} → here (same-folder)`]);
});

test('a chat whose tab is open here reveals here even when its transcript is now filed under another folder', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  const wtDir = `${w.main}-wt`;
  fs.mkdirSync(wtDir);
  w.transcript(wtDir, ID.t18, [w.turn(ID.t18, w.main), w.turn(ID.t18, wtDir)]);
  const chat = w.chat('T18 one', ID.t18, w.mainWt);
  const mainWindow = windowOn(t, w, dir, () => w.main, { pid: 1001, claims: w.main, isOpenHere: () => true });

  assert.equal(await mainWindow.router.route({ kind: 'open', chats: [chat] }), 'here');
  assert.deepEqual(mainWindow.opened.map((entry) => entry.path), [w.main], 'revealed in this window, never a second process');
  assert.deepEqual(calls, []);
  assert.deepEqual(filesIn(mainWindow.inbox, dir, wtDir), []);
  assert.deepEqual(mainWindow.routeLog, [`[Pitwall] route ${ID.t18.slice(0, 8)} → here (open-here)`]);
});

// isOpenHere is true for a live Pitwall terminal as well as a bound UI tab.
test("a chat whose Pitwall terminal is live here reveals it here even when its transcript is filed under another folder", async (t) => {
  const w = world(t);
  const calls = openFolderCalls();
  const wtDir = `${w.main}-wt`;
  fs.mkdirSync(wtDir);
  w.transcript(wtDir, ID.t18, [w.turn(ID.t18, w.main), w.turn(ID.t18, wtDir)]);
  const chat = w.chat('T18 terminal', ID.t18, w.mainWt);
  const live = new Set([chat.id]);
  const mainWindow = windowOn(t, w, tempDir(t), () => w.main, { pid: 1001, claims: w.main, isOpenHere: (c) => live.has(c.id) });

  assert.equal(await mainWindow.router.route({ kind: 'open', chats: [chat] }), 'here');
  assert.deepEqual(mainWindow.opened.map((entry) => entry.chat), ['T18 terminal']);
  assert.deepEqual(calls, []);
});

test('a chat open in another window routes to that window, not its launch folder', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  const chat = w.chat('Open there', ID.a, w.mainWt);
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other, openIn: [{ folder: w.wt, sessionIds: [ID.a] }] });

  assert.equal(await sender.router.route({ kind: 'open', chats: [chat] }), 'routed');
  assert.deepEqual(calls.map((call) => call.path), [w.wt]);
  assert.deepEqual(requestsFor(sender.inbox, dir, w.wt).map((request) => request.sessionIds), [[ID.a]]);
  assert.deepEqual(filesIn(sender.inbox, dir, w.main), []);
  assert.deepEqual(sender.opened, []);
  assert.deepEqual(sender.routeLog, [`[Pitwall] route ${ID.a.slice(0, 8)} → ${w.wt} (open-there)`]);
});

test("a chat with no transcript yet opens here, in its row's own window, and logs no-transcript", async (t) => {
  const w = world(t);
  const here = windowOn(t, w, tempDir(t), () => w.main, { pid: 1001, claims: w.main });
  const chat = w.storage.createChat(w.mainWt.id, 'claude', 'Fresh', {});

  await here.router.route({ kind: 'open', chats: [chat] });
  assert.deepEqual(here.routeLog, [`[Pitwall] route ${chat.id.slice(0, 8)} → here (no-transcript)`]);
});

test('a bound tab here reveals locally only when this window is the launch folder', async (t) => {
  const w = world(t);
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  const here = windowOn(t, w, tempDir(t), () => w.main, { pid: 1001, claims: w.main, isOpenHere: () => true });

  assert.equal(await here.router.route({ kind: 'open', chats: [w.chat('Tab here', ID.a, w.mainWt)] }), 'here');
  assert.deepEqual(here.opened.map((entry) => entry.path), [w.main]);
  assert.deepEqual(here.routeLog, [`[Pitwall] route ${ID.a.slice(0, 8)} → here (open-here)`]);
});

test('every routing decision logs one route line', async (t) => {
  const w = world(t);
  openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  w.transcript(w.other, ID.b, [w.turn(ID.b, w.other)]);
  const missing = path.join(w.scratch, 'deleted-worktree');
  w.transcript(missing, ID.gone, [w.turn(ID.gone, missing)]);
  const id8 = (id: string) => id.slice(0, 8);

  const here = windowOn(t, w, tempDir(t), () => w.main, { pid: 1001, claims: w.main });
  await here.router.route({ kind: 'open', chats: [w.chat('Same', ID.a, w.mainWt)] });
  await here.router.route({ kind: 'open', chats: [w.chat('Other', ID.b, w.otherWt)] });
  await here.router.route({ kind: 'open', chats: [w.chat('Gone', ID.gone, w.goneWt)] });
  assert.deepEqual(here.routeLog, [
    `[Pitwall] route ${id8(ID.a)} → here (same-folder)`,
    `[Pitwall] route ${id8(ID.b)} → ${w.other} (handoff)`,
    `[Pitwall] route ${id8(ID.gone)} → ${missing} (gone)`,
  ]);

  const early = windowOn(t, w, tempDir(t), () => w.other, { pid: 1002, claims: w.other, servicesUp: () => false, timing: { ...FAST, servicesWaitMs: 20 } });
  await early.router.route({ kind: 'open', chats: [w.chat('Early', ID.a, w.mainWt)] });
  assert.deepEqual(early.routeLog, [`[Pitwall] route ${id8(ID.a)} → ${w.main} (no-services)`]);
});

test('launch folder reads a 1 MB head with no cwd without holding the event loop', async (t) => {
  const w = world(t);
  const big = Array.from({ length: 64 }, () => ({ type: 'summary', summary: 'y'.repeat(16 * 1024) }));
  // Filed under a folder none of the repo's folders encode to, so the whole
  // 1 MB head is read looking for a cwd that does.
  w.transcript(path.join(w.scratch, 'not-a-root'), ID.a, [...big, w.turn(ID.a, w.wt)]);
  const { router } = windowOn(t, w, tempDir(t), () => undefined, { pid: 1001 });
  const chat = w.chat('Huge head', ID.a, w.mainWt);
  await assertNoLongBlock(
    async () => {
      // No cwd within 1 MB and no matching root: the chat's own worktree.
      assert.equal(await router.launchFolder(chat), w.main);
    },
    50,
    { runs: 3, label: 'launchFolder' }
  );
});

test('"Open its window" and "Bring its window forward" raise the repo\'s main folder with openFolder', async (t) => {
  const w = world(t);
  const calls = openFolderCalls();
  const context = { subscriptions: [] as vscode.Disposable[] };
  registerRepositoryCommands(context as never, {
    storageService: w.storage,
    gitService: {} as never,
    harnessRegistry: new HarnessRegistry([]),
    forgetWorktrees: () => undefined,
    refreshTree: () => undefined,
  });
  t.after(() => context.subscriptions.forEach((entry) => entry.dispose()));
  const repo = w.storage.getRepositories().find((candidate) => candidate.name === 'demo')!;
  const row = new WorkspaceTreeItem('demo', 1, 'repository', repo, 'repository');

  await runCommand('pitwall.openItsWindow', row);
  await runCommand('pitwall.bringItsWindowForward', row);
  assert.deepEqual(calls, [
    { path: w.main, forceNewWindow: true },
    { path: w.main, forceNewWindow: true },
  ]);
});

test('a chat moved into a worktree after its first click routes to the worktree on the next click', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  const first = w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  const chat = w.chat('Moves later', ID.a, w.mainWt);
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other });

  assert.equal(await sender.router.route({ kind: 'open', chats: [chat] }), 'routed');
  assert.deepEqual(calls.map((call) => call.path), [w.main]);

  // EnterWorktree: Claude moves the transcript into the worktree's project folder.
  fs.rmSync(first);
  w.transcript(w.wt, ID.a, [w.turn(ID.a, w.main), w.turn(ID.a, w.wt)]);

  assert.equal(await sender.router.route({ kind: 'open', chats: [chat] }), 'routed');
  assert.deepEqual(calls.map((call) => call.path), [w.main, w.wt], 'the second click goes to the worktree');
  assert.deepEqual(requestsFor(sender.inbox, dir, w.wt).map((request) => request.sessionIds), [[ID.a]]);
});

test('a click before window services start waits for them, else warns and opens no window', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  const chat = w.chat('Clicked early', ID.a, w.mainWt);

  // The services come up 100 ms after the click: the click waits, then hands off.
  let up = false;
  // Its request stays unclaimed here, so its own 20 s warning must not fire during the test.
  const early = windowOn(t, w, dir, () => w.other, {
    pid: 1001,
    claims: w.other,
    servicesUp: () => up,
    timing: { ...FAST, warnMs: 60_000, coldWarnMs: 60_000, expireMs: 120_000 },
  });
  const timer = setTimeout(() => (up = true), 100);
  t.after(() => clearTimeout(timer));
  assert.equal(await early.router.route({ kind: 'open', chats: [chat] }), 'routed');
  assert.equal(requestsFor(early.inbox, dir, w.main).length, 1, 'the request is written once they are up');
  assert.deepEqual(calls.map((call) => call.path), [w.main]);

  // They never come up: warn (§3f) and raise no window, which would come up empty.
  const dir2 = tempDir(t);
  const never = windowOn(t, w, dir2, () => w.other, { pid: 1002, claims: w.other, servicesUp: () => false });
  await never.router.route({ kind: 'open', chats: [chat] });
  assert.deepEqual(warnings(UNREACHED('demo')), [UNREACHED('demo')]);
  assert.deepEqual(calls.map((call) => call.path), [w.main], 'no second openFolder');
  assert.equal(requestsFor(never.inbox, dir2, w.main).length, 0);
});

// E10 (T3 live, c7c894db): an EnterWorktree chat whose transcript moved to the
// worktree's project folder opened locally in the main window. Its worktree
// is a sibling (`demo-wt`), whose project folder name starts with main's
// encoding plus "-", and the repo's listing did not name it yet.
test("a chat whose transcript moved to the worktree's project dir (stored worktree still main) routes to the worktree window", async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  const sibling = `${w.main}-wt`;
  fs.mkdirSync(sibling);
  w.transcript(sibling, ID.t18, [w.turn(ID.t18, w.main), w.turn(ID.t18, w.main), w.turn(ID.t18, sibling)]);
  const chat = w.chat('Entered a sibling worktree', ID.t18, w.mainWt);
  const mainWindow = windowOn(t, w, dir, () => w.main, { pid: 1001, claims: w.main });

  assert.ok(!w.worktrees.some((worktree) => worktree.path === sibling), 'the listing does not know the worktree');
  assert.equal(await mainWindow.router.launchFolder(chat), sibling);
  assert.equal(await mainWindow.router.route({ kind: 'open', chats: [chat] }), 'routed');
  assert.deepEqual(calls.map((call) => call.path), [sibling]);
  assert.deepEqual(mainWindow.opened, [], 'not opened in the main window');
});

// Q26: a new Cursor window takes 22–30 s on Sharif's machine before Pitwall
// activates there, so a cold open waits 60 s before warning; a window that
// already exists keeps 20 s.
test('a cold open (no window for the folder yet) warns at 60 s, not 20 s', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  const sender = windowOn(t, w, dir, () => w.other, {
    pid: 1001,
    claims: w.other,
    timing: { ...FAST, warnMs: 50, coldWarnMs: 800, expireMs: 5_000 },
  });

  await sender.router.route({ kind: 'open', chats: [w.chat('Cold', ID.a, w.mainWt)] });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(warnings(UNREACHED('demo')), [], 'no warning at the warm wait');
  await waitFor(() => warnings(UNREACHED('demo')).length > 0, 'the warning at the cold wait', 3_000);
  assert.equal(warnings(UNREACHED('demo')).length, 1);
});

test('a request to an existing window warns at 20 s', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  const sender = windowOn(t, w, dir, () => w.other, {
    pid: 1001,
    claims: w.other,
    windowsAt: [w.main],
    timing: { ...FAST, warnMs: 50, coldWarnMs: 60_000, expireMs: 120_000 },
  });

  await sender.router.route({ kind: 'open', chats: [w.chat('Warm', ID.a, w.mainWt)] });
  await waitFor(() => warnings(UNREACHED('demo')).length > 0, 'the warning at the warm wait', 3_000);
  assert.equal(warnings(UNREACHED('demo')).length, 1);
});

// ---- T8 (live I2): a handoff to a recently closed folder whose window never came up ----

test('I2: the router raises a window with the same call as "Open its window", and retries a cold open after 45 s', () => {
  assert.equal(ROUTER_TIMING.retryOpenMs, 45_000, 'never below 45 s: Cursor takes 22-30 s to start a window here');
  assert.ok(ROUTER_TIMING.retryOpenMs < ROUTER_TIMING.coldWarnMs, 'the retry comes before the warning');
});

test('I2: no window registers for the folder: the open is retried once, then one "couldn\'t reach" toast whose "Open its window" raises it', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  const sender = windowOn(t, w, dir, () => w.other, {
    pid: 1001,
    claims: w.other,
    timing: { ...FAST, warnMs: 50, coldWarnMs: 700, retryOpenMs: 250, expireMs: 5_000 } as typeof FAST,
  });
  stub.__warningResponses.push('Open its window');

  await sender.router.route({ kind: 'open', chats: [w.chat('Closed window', ID.a, w.mainWt)] });
  assert.equal(calls.length, 1);
  await waitFor(() => calls.length === 2, 'the retry', 3_000);
  assert.deepEqual(warnings(UNREACHED('demo')), [], 'no toast before the cold wait');
  assert.deepEqual(calls[1], { path: w.main, forceNewWindow: true }, 'the same call again');
  await waitFor(() => warnings(UNREACHED('demo')).length > 0, 'the toast', 3_000);
  const toast = stub.__messages.find((args) => args[0] === UNREACHED('demo'))!;
  assert.deepEqual(toast.slice(1), ['Open its window'], 'with an "Open its window" button');
  await waitFor(() => calls.length === 3, 'the button raising the window', 3_000);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(warnings(UNREACHED('demo')).length, 1, 'the toast fires exactly once');
  assert.equal(calls.length, 3, 'one retry, one button press, nothing more');
});

test('I2: the retried window gets its own start time: a window that registers after the old cold-warn time earns no toast', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  const windowsAt: string[] = [];
  const sender = windowOn(t, w, dir, () => w.other, {
    pid: 1001,
    claims: w.other,
    windowsAt,
    // Production shape: retry 45 s, old toast 60 s (15 s later), expiry 120 s. Here 300 / 400 / 5000.
    timing: { ...FAST, warnMs: 50, coldWarnMs: 400, retryOpenMs: 300, expireMs: 5_000 } as typeof FAST,
  });
  let up = false;
  const outcome = sender.inbox.outcome.bind(sender.inbox);
  sender.inbox.outcome = async (...args: Parameters<HandoffInbox['outcome']>) => (up ? { ok: true } : outcome(...args));

  await sender.router.route({ kind: 'open', chats: [w.chat('Slow window', ID.a, w.mainWt)] });
  await waitFor(() => calls.length === 2, 'the retry', 3_000);
  const retriedAt = Date.now();
  // The retried window starts after the old warn time (coldWarnMs 400 from the request, ~100 ms after the retry), before retriedAt + 300.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(Date.now() - retriedAt < 300);
  windowsAt.push(w.main);
  up = true;
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(warnings(UNREACHED('demo')), [], 'no unreached toast: the retried window was still starting');
});

test('I2: a window that registers for the folder in time gets no retry', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  const sender = windowOn(t, w, dir, () => w.other, {
    pid: 1001,
    claims: w.other,
    windowsAt: [w.main],
    timing: { ...FAST, warnMs: 5_000, coldWarnMs: 5_000, retryOpenMs: 100, expireMs: 10_000 } as typeof FAST,
  });
  await sender.router.route({ kind: 'open', chats: [w.chat('Up', ID.a, w.mainWt)] });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(calls.length, 1, 'raised once only');
});

// The flake behind "a click before window services start…": a router disposed
// while its outcome read was in flight still warned once the read returned
// (in production, a closing window could show a stray warning).
test('a disposed router never warns, even with an outcome read in flight', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  const sender = windowOn(t, w, dir, () => w.other, {
    pid: 1001,
    claims: w.other,
    // Past the wait on the first read, so a read that returns would warn.
    timing: { ...FAST, warnMs: 0, coldWarnMs: 0, expireMs: 60_000 },
  });
  let release: () => void = () => undefined;
  let reading = false;
  sender.inbox.outcome = () => {
    reading = true;
    return new Promise((resolve) => (release = () => resolve(undefined)));
  };

  await sender.router.route({ kind: 'open', chats: [w.chat('Closing window', ID.a, w.mainWt)] });
  await waitFor(() => reading, 'the outcome read to start');
  sender.router.dispose();
  release();
  await new Promise((resolve) => setTimeout(resolve, FAST.pollMs * 5));
  assert.deepEqual(warnings(UNREACHED('demo')), [], 'no warning after dispose');
});

// The exact-root step decides alone when the transcript's cwd names the same
// folder in another spelling: the window's folder is the repo's own spelling.
test("a cwd that spells the repo's folder differently resolves to the repo's own spelling", async (t) => {
  const w = world(t);
  const spelled = `${w.main}${path.sep}`;
  w.transcript(w.main, ID.a, [w.turn(ID.a, spelled)]);
  const { router } = windowOn(t, w, tempDir(t), () => undefined, { pid: 1001 });
  assert.equal(await router.launchFolder(w.chat('Trailing slash', ID.a, w.mainWt)), w.main);
});

// ---- Phase 4 Task 4: serial opens, side by side, the outside-terminal guard (rows 4.3, 4.4; Q28) ----

const OUTSIDE = (pid: number) => `That chat is already running in another terminal (pid ${pid}). Switch to it there.`;

test("a chat live in an outside terminal (a live ~/.claude/sessions pid Pitwall doesn't own) is not opened again: Pitwall warns instead", async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  w.transcript(w.other, ID.b, [w.turn(ID.b, w.other)]);
  const here = windowOn(t, w, dir, () => w.main, { pid: 1001, claims: w.main, outsideTerminal: (id) => (id === ID.a || id === ID.b ? 4321 : undefined) });

  assert.equal(await here.router.route({ kind: 'open', chats: [w.chat('Same folder', ID.a, w.mainWt)] }), 'gone');
  assert.deepEqual(here.opened, [], 'nothing opened here');
  assert.deepEqual(warnings(OUTSIDE(4321)), [OUTSIDE(4321)]);
  assert.deepEqual(here.routeLog, [`[Pitwall] route ${ID.a.slice(0, 8)} → elsewhere (outside-terminal)`]);

  // Another folder's chat is not handed to its window either: that would start a second process.
  assert.equal(await here.router.route({ kind: 'open', chats: [w.chat('Other folder', ID.b, w.otherWt)] }), 'gone');
  assert.deepEqual(calls, [], 'no window raised');
  assert.deepEqual(requestsFor(here.inbox, dir, w.other), []);
});

test('the outside-terminal guard leaves alone a chat Pitwall owns: open here, open in another window, or a chat with no process', async (t) => {
  const w = world(t);
  const calls = openFolderCalls();
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  w.transcript(w.main, ID.b, [w.turn(ID.b, w.main)]);
  w.transcript(w.main, ID.c, [w.turn(ID.c, w.main)]);
  const live = (id: string) => (id === ID.a || id === ID.b ? 4321 : undefined);
  const here = windowOn(t, w, tempDir(t), () => w.main, {
    pid: 1001,
    claims: w.main,
    outsideTerminal: live,
    isOpenHere: (chat) => chat.name === 'Tab here',
    openIn: [{ folder: w.other, sessionIds: [ID.b] }],
  });
  await here.router.route({ kind: 'open', chats: [w.chat('Tab here', ID.a, w.mainWt)] });
  assert.deepEqual(here.opened.map((entry) => entry.chat), ['Tab here'], 'a panel chat of this window has a live pid and still reveals');
  await here.router.route({ kind: 'open', chats: [w.chat('There', ID.b, w.mainWt)] });
  assert.deepEqual(calls.map((call) => call.path), [w.other], 'a panel chat of another Pitwall window routes to it (open-there)');
  await here.router.route({ kind: 'open', chats: [w.chat('Free', ID.c, w.mainWt)] });
  assert.deepEqual(here.opened.map((entry) => entry.chat), ['Tab here', 'Free']);
  assert.deepEqual(shownMessages().filter((message) => message.includes('another terminal')), []);
});

test('the Claude harness reports a live pid from ~/.claude/sessions *.json and never opens a .key file', async (t) => {
  const dir = tempDir(t, 't4-sessions-');
  const { ClaudeSessionsFile, localPidDomain } = await import('../../../../src/harnesses/claude/ClaudeSessionsFile');
  fs.writeFileSync(
    path.join(dir, `${process.pid}.json`),
    JSON.stringify({ sessionId: ID.a, pid: process.pid, pidDomain: await localPidDomain(), status: 'idle', statusUpdatedAt: 1, cwd: 'C:/x' })
  );
  fs.writeFileSync(path.join(dir, 'abc.key'), 'TOP SECRET');
  fs.mkdirSync(path.join(dir, 'dir.key'));
  const read: string[] = [];
  const realRead = fs.promises.readFile;
  (fs.promises as { readFile: unknown }).readFile = (file: unknown, ...rest: unknown[]) => {
    read.push(String(file));
    return (realRead as (...a: unknown[]) => Promise<unknown>)(file, ...rest);
  };
  t.after(() => ((fs.promises as { readFile: unknown }).readFile = realRead));
  const harness = new ClaudeHarness({ sessionsFile: new ClaudeSessionsFile({ dir: () => dir }) } as never);
  assert.deepEqual(await harness.liveProcessOf?.(ID.a), { pid: process.pid, panel: false });
  assert.equal(await harness.liveProcessOf?.(ID.b), undefined);
  const inSessions = read.filter((file) => path.resolve(file).startsWith(dir));
  assert.ok(inSessions.length > 0 && inSessions.every((file) => file.endsWith('.json')), `only .json files are opened: ${inSessions.join(', ')}`);
});

test("openAll opens this window's chats through the tab tracker one at a time; a single open does not", async (t) => {
  const w = world(t);
  for (const id of [ID.a, ID.b, ID.c]) {
    w.transcript(w.main, id, [w.turn(id, w.main)]);
  }
  const serial: { ids: string[] }[] = [];
  const here = windowOn(t, w, tempDir(t), () => w.main, { pid: 1001, claims: w.main, serial });
  const chats = [w.chat('A', ID.a, w.mainWt), w.chat('B', ID.b, w.mainWt), w.chat('C', ID.c, w.mainWt)];

  await here.router.route({ kind: 'openAll', chats });
  assert.deepEqual(serial, [{ ids: [ID.a, ID.b, ID.c] }]);
  assert.deepEqual(here.opened.map((entry) => entry.chat), ['A', 'B', 'C']);

  await here.router.route({ kind: 'open', chats: [chats[0]] });
  assert.equal(serial.length, 1, 'a click on one chat keeps the single-open path');
});

test('a claimed openAll opens through the tab tracker, and a claimed sideBySide splits what it opened', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  openFolderCalls();
  for (const id of [ID.a, ID.b]) {
    w.transcript(w.main, id, [w.turn(id, w.main)]);
  }
  const serial: { ids: string[] }[] = [];
  const splits: string[][] = [];
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other });
  const mainWindow = windowOn(t, w, dir, () => w.main, { pid: 1002, claims: w.main, serial, splits });
  const chats = [w.chat('A', ID.a, w.mainWt), w.chat('B', ID.b, w.mainWt)];

  await sender.router.route({ kind: 'openAll', chats });
  await mainWindow.router.runClaimed(await mainWindow.inbox.claimAll());
  assert.deepEqual(serial, [{ ids: [ID.a, ID.b] }]);
  assert.deepEqual(splits, [], 'openAll does not split');

  await sender.router.route({ kind: 'sideBySide', chats });
  await mainWindow.router.runClaimed(await mainWindow.inbox.claimAll());
  assert.deepEqual(splits, [[ID.a, ID.b]], 'the claiming window splits the chats it just revealed, in order');
});

test('a local sideBySide reveals the chats and splits them in this window', async (t) => {
  const w = world(t);
  for (const id of [ID.a, ID.b]) {
    w.transcript(w.main, id, [w.turn(id, w.main)]);
  }
  const splits: string[][] = [];
  const here = windowOn(t, w, tempDir(t), () => w.main, { pid: 1001, claims: w.main, isOpenHere: () => true, splits, serial: [] });
  const chats = [w.chat('A', ID.a, w.mainWt), w.chat('B', ID.b, w.mainWt)];
  assert.equal(await here.router.route({ kind: 'sideBySide', chats }), 'here');
  assert.deepEqual(splits, [[ID.a, ID.b]]);
});

test('"+" logs one [Pitwall] route line for new-chat routing', async (t) => {
  const w = world(t);
  openFolderCalls();
  const sender = windowOn(t, w, tempDir(t), () => w.other, { pid: 1001, claims: w.other });

  await sender.router.route({ kind: 'new', chats: [], folder: w.main });
  assert.deepEqual(sender.routeLog, [`[Pitwall] route new → ${w.main} (handoff)`]);
  await sender.router.route({ kind: 'new', chats: [], folder: w.other });
  assert.deepEqual(sender.routeLog.slice(1), [`[Pitwall] route new → here (same-folder)`]);
  const missing = path.join(w.scratch, 'deleted-worktree');
  await sender.router.route({ kind: 'new', chats: [], folder: missing });
  assert.deepEqual(sender.routeLog.slice(2), [`[Pitwall] route new → ${missing} (gone)`]);
});

test("open-here opens against this window's folder, even when the row is stored under another folder", async (t) => {
  const w = world(t);
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  // The window is on the worktree; the row is stored under the main worktree; its tab is open here.
  const wtWindow = windowOn(t, w, tempDir(t), () => w.wt, { pid: 1001, claims: w.wt, isOpenHere: () => true });
  assert.equal(await wtWindow.router.route({ kind: 'open', chats: [w.chat('Stored on main', ID.a, w.mainWt)] }), 'here');
  assert.deepEqual(wtWindow.opened.map((entry) => entry.path), [w.wt], 'availability is checked against this window, not the stored row');
  assert.deepEqual(wtWindow.routeLog, [`[Pitwall] route ${ID.a.slice(0, 8)} → here (open-here)`]);
});

// ---- Round 1 (QA #52): C1, C3 ----

test('a chat in a Claude panel of a window Pitwall cannot see gets the window-or-terminal copy', async (t) => {
  const w = world(t);
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  const here = windowOn(t, w, tempDir(t), () => w.main, { pid: 1001, claims: w.main, outsideTerminal: () => ({ pid: 777, panel: true }) });
  assert.equal(await here.router.route({ kind: 'open', chats: [w.chat('Panel elsewhere', ID.a, w.mainWt)] }), 'gone');
  assert.deepEqual(here.opened, []);
  assert.equal(warnings('That chat is already running in another window or terminal (pid 777). Switch to it there.').length, 1);
  assert.deepEqual(shownMessages().filter((message) => message.includes('another terminal')), []);
});

test("a chat in this window's own panel (the guard finds no outsider) opens here and warns nothing", async (t) => {
  const w = world(t);
  w.transcript(w.main, ID.a, [w.turn(ID.a, w.main)]);
  const here = windowOn(t, w, tempDir(t), () => w.main, { pid: 1001, claims: w.main, outsideTerminal: () => undefined });
  assert.equal(await here.router.route({ kind: 'open', chats: [w.chat('Own panel', ID.a, w.mainWt)] }), 'here');
  assert.deepEqual(here.opened.map((entry) => entry.chat), ['Own panel']);
  assert.deepEqual(shownMessages(), []);
});

test('openAll with a terminal chat skips the tab wait for it, and a claimed one still reports ok', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  openFolderCalls();
  for (const id of [ID.a, ID.b]) {
    w.transcript(w.main, id, [w.turn(id, w.main)]);
  }
  const serial = Object.assign([] as { ids: string[]; results?: unknown[] }[], { recordResults: true });
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other });
  const mainWindow = windowOn(t, w, dir, () => w.main, {
    pid: 1002,
    claims: w.main,
    serial,
    openHere: async (chat) => (chat.name === 'Terminal one' ? 'terminal' : true),
  });
  await sender.router.route({ kind: 'openAll', chats: [w.chat('Terminal one', ID.a, w.mainWt), w.chat('Tab one', ID.b, w.mainWt)] });
  const [request] = await mainWindow.inbox.claimAll();
  await mainWindow.router.runClaimed([request]);
  assert.deepEqual(serial[0].results, [false, true], 'a terminal open resolves false: no 5 s wait');
  assert.deepEqual(await sender.inbox.outcome(w.main, request.nonce), { ok: true }, 'and it is not a failure');
});

test('the Claude harness marks a claude-vscode entry as a panel', async (t) => {
  const dir = tempDir(t, 't4-entry-');
  const { ClaudeSessionsFile, localPidDomain } = await import('../../../../src/harnesses/claude/ClaudeSessionsFile');
  const domain = await localPidDomain();
  const entry = (sessionId: string, entrypoint: string) =>
    fs.writeFileSync(
      path.join(dir, `${sessionId.slice(0, 4)}.json`),
      JSON.stringify({ sessionId, pid: process.pid, pidDomain: domain, status: 'idle', statusUpdatedAt: 1, cwd: 'C:/x', entrypoint })
    );
  entry(ID.a, 'claude-vscode');
  entry(ID.b, 'cli');
  const harness = new ClaudeHarness({ sessionsFile: new ClaudeSessionsFile({ dir: () => dir }) } as never);
  assert.deepEqual(await harness.liveProcessOf?.(ID.a), { pid: process.pid, panel: true });
  assert.deepEqual(await harness.liveProcessOf?.(ID.b), { pid: process.pid, panel: false });
});

// ---- Round 1 (tester T1) ----

test('a no-transcript chat whose row folder is not this window never starts here', async (t) => {
  const w = world(t);
  const calls = openFolderCalls();
  const here = windowOn(t, w, tempDir(t), () => w.other, { pid: 1001, claims: w.other });
  const chat = w.storage.createChat(w.mainWt.id, 'claude', 'New Session', { pendingUiLaunch: true });

  assert.equal(await here.router.route({ kind: 'openAll', chats: [chat] }), 'gone');
  assert.deepEqual(here.opened, [], 'nothing opened in this window');
  assert.deepEqual(calls, [], 'and no window raised for a chat with nothing to open');
  assert.deepEqual(here.routeLog, [`[Pitwall] route ${chat.id.slice(0, 8)} → ${w.main} (no-transcript-elsewhere)`]);
});
