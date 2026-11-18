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
import { claudeProfile } from '../../harnesses/claude/claudeFixture';
import { assertNoLongBlock, makeStorage, runCommand, shownMessages, stub, tempDir, waitFor, worktreeRecord } from '../../support';

beforeEach(() => stub.__reset());

const ID = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222',
  c: '33333333-3333-4333-8333-333333333333',
  t18: '44444444-4444-4444-8444-444444444444',
  t17: '55555555-5555-4555-8555-555555555555',
  other: '66666666-6666-4666-8666-666666666666',
  gone: '77777777-7777-4777-8777-777777777777',
  sdk: '88888888-8888-4888-8888-888888888888',
};

/** Short timings so the 20 s warning and 120 s expiry run in milliseconds. */
const FAST = { warnMs: 150, expireMs: 400, pollMs: 10 };
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
  options: { pid: number; claims?: string; timing?: typeof FAST; openHere?: (chat: ChatSession, worktree: Worktree) => Promise<boolean> }
) {
  const logs: string[] = [];
  const inbox = new HandoffInbox(dir, { pid: options.pid, folder: options.claims }, Date.now, (line) => logs.push(line));
  const opened: { chat: string; path: string; worktreeId: string }[] = [];
  const started: string[] = [];
  const router = new ChatRouter({
    services: () => ({ inbox }),
    windowFolder: folder,
    harnessRegistry: new HarnessRegistry([new ClaudeHarness()]),
    worktreeOf: async (chat) => w.worktrees.find((worktree) => worktree.id === chat.worktreeId),
    rootsOf: (worktree) => w.worktrees.filter((candidate) => candidate.repoId === worktree.repoId).map((candidate) => candidate.path),
    repoName: (target) => (target.startsWith(w.other) ? 'other' : 'demo'),
    isOpenHere: () => false,
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
  });
  t.after(() => router.dispose());
  return { inbox, router, logs, opened, started };
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

test('launch folder is the first cwd, not the latest', async (t) => {
  // T18: the chat started in the main folder and later moved into a worktree,
  // so Pitwall lists it under the worktree; Claude's panel resumes it from main.
  const w = world(t);
  w.transcript(w.main, ID.t18, [w.turn(ID.t18, w.main), w.turn(ID.t18, w.wt), w.turn(ID.t18, w.wt)]);
  const { router } = windowOn(t, w, tempDir(t), () => undefined, { pid: 1001 });
  assert.equal(await router.launchFolder(w.chat('Moved into a worktree', ID.t18, w.featWt)), w.main);
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

test('a T18 chat claimed in the main window opens there', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  openFolderCalls();
  w.transcript(w.main, ID.t18, [w.turn(ID.t18, w.main), w.turn(ID.t18, w.wt)]);
  const chat = w.chat('Moved into a worktree', ID.t18, w.featWt);
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other });
  const mainWindow = windowOn(t, w, dir, () => w.main, { pid: 1002, claims: w.main });

  assert.equal(await sender.router.route({ kind: 'open', chats: [chat] }), 'routed');
  assert.deepEqual(requestsFor(sender.inbox, dir, w.main).map((request) => request.sessionIds), [[ID.t18]], 'sent to the main folder, not the worktree');
  await mainWindow.router.runClaimed(await mainWindow.inbox.claimAll());

  // Availability is checked against the launch folder (main), never the worktree it moved into.
  assert.deepEqual(mainWindow.opened, [{ chat: 'Moved into a worktree', path: w.main, worktreeId: 'wt-feat' }]);
  assert.ok(mainWindow.logs.some((line) => /^\[Pitwall\] handoff opened [0-9a-f]{8} after \d+ ms$/.test(line)), mainWindow.logs.join('\n'));

  // And clicked in the main window itself, it opens there with no handoff.
  const result = await mainWindow.router.route({ kind: 'open', chats: [chat] });
  assert.equal(result, 'here');
  assert.deepEqual(mainWindow.opened.at(-1), { chat: 'Moved into a worktree', path: w.main, worktreeId: 'wt-feat' });
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
  const getExtension = stub.extensions.getExtension;
  (stub.extensions as { getExtension: unknown }).getExtension = (id: string) =>
    id === 'anthropic.claude-code' ? { id, isActive: false, activate: async () => void events.push('activate claude') } : getExtension(id);
  t.after(() => {
    (stub.extensions as { getExtension: unknown }).getExtension = getExtension;
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

test('an sdk-cli chat is never routed for a UI open; it opens here (Q23)', async (t) => {
  const w = world(t);
  const dir = tempDir(t);
  const calls = openFolderCalls();
  w.transcript(w.main, ID.sdk, [w.turn(ID.sdk, w.main, 'sdk-cli')]);
  const sender = windowOn(t, w, dir, () => w.other, { pid: 1001, claims: w.other });

  assert.equal(await sender.router.route({ kind: 'open', chats: [w.chat('From claude -p', ID.sdk, w.mainWt)] }), 'here');
  assert.deepEqual(sender.opened.map((entry) => entry.chat), ['From claude -p']);
  assert.deepEqual(calls, []);
});

test('launch folder reads a 1 MB head with no cwd without holding the event loop', async (t) => {
  const w = world(t);
  const big = Array.from({ length: 64 }, () => ({ type: 'summary', summary: 'y'.repeat(16 * 1024) }));
  w.transcript(w.main, ID.a, [...big, w.turn(ID.a, w.wt)]);
  const { router } = windowOn(t, w, tempDir(t), () => undefined, { pid: 1001 });
  const chat = w.chat('Huge head', ID.a, w.mainWt);
  await assertNoLongBlock(
    async () => {
      router.forgetLaunchFolders();
      // No cwd within 1 MB: the project folder's repo wins.
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
