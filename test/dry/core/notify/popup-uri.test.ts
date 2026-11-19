/**
 * A pop-up click (Q37, Q48, D18): `<uriScheme>://sharifamlani.pitwall/open?session=<uuid>`
 * reaches `PopupUriHandler`, which accepts only path `/open` and one UUID that
 * Pitwall lists, then opens it through the Phase 4 router. Any local app or web
 * page can fire this URI, so everything else is rejected and opens nothing.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { openUri, parseOpenUri, PopupUriHandler, PopupUriDeps } from '../../../../src/core/notify/PopupUriHandler';
import { ChatRouter, RouteResult } from '../../../../src/core/windows/ChatRouter';
import { raiseThisWindow } from '../../../../src/core/windows/raiseWindow';
import { ChatSession } from '../../../../src/core/types';
import { chatRecord, flush, shownMessages, stub, worktreeRecord } from '../../support';

const SESSION = '5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const OTHER = '9a8b7c6d-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

beforeEach(() => stub.__reset());

function uri(query: string, pathValue = '/open', authority = 'sharifamlani.pitwall'): vscode.Uri {
  return vscode.Uri.from({ scheme: 'cursor', authority, path: pathValue, query });
}

const listed = chatRecord({ id: 'chat-a', name: 'Fix map', harnessSessionId: SESSION, worktreeId: 'wt-a' });

/** A handler over one listed chat, a router answering `answer`, and every call recorded. */
function handler(answer: RouteResult | (() => Promise<RouteResult>) = 'here', overrides: Partial<PopupUriDeps> = {}) {
  const routes: { kind: string; chats: ChatSession[] }[] = [];
  const seen: string[] = [];
  const log: string[] = [];
  const deps: PopupUriDeps = {
    chatForSession: (sessionId) => (sessionId === SESSION ? listed : undefined),
    route: async (request) => {
      routes.push(request);
      return typeof answer === 'function' ? answer() : answer;
    },
    activateLocal: (chat) => seen.push(chat.id),
    log: (line) => log.push(line),
    ...overrides,
  };
  return { handler: new PopupUriHandler(deps), routes, seen, log };
}

test("a listed session's open URI routes through ChatRouter once and logs popup click", async () => {
  const h = handler('routed');
  await h.handler.handleUri(uri(`session=${SESSION}`));
  assert.deepEqual(h.routes, [{ kind: 'open', chats: [listed] }], 'one route, kind open, never new and never a prompt');
  assert.deepEqual(h.log, ['[Pitwall] uri probe keys=session', '[Pitwall] popup click 5f0c3d4e']);
  assert.deepEqual(h.seen, [], 'routed: the window it lands in marks it seen');

  // The extension registers the handler (manifest onUri activates for it).
  const root = path.join(__dirname, '..', '..', '..');
  const source = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
  assert.match(source, /vscode\.window\.registerUriHandler\(\s*new PopupUriHandler\(/);
});

test('a non-UUID, an unknown UUID, another path or an extra prompt parameter is rejected and opens nothing', async () => {
  const cases: [vscode.Uri, string][] = [
    [uri('session=not-a-uuid'), 'not-uuid'],
    [uri(`session=${SESSION}x`), 'not-uuid'],
    [uri(`session=${OTHER}`), 'unknown'],
    [uri(`session=${SESSION}`, '/new'), 'path'],
    [uri(`session=${SESSION}`, '/open/extra'), 'path'],
    [uri(`session=${SESSION}&prompt=rm%20-rf`), 'param'],
    [uri(`prompt=hello&session=${SESSION}`), 'param'],
    [uri(`session=${SESSION}&session=${SESSION}`), 'session'],
    [uri(''), 'session'],
    [uri(`session=${SESSION}`, '/open', 'someone.else'), 'authority'],
  ];
  for (const [link, reason] of cases) {
    const h = handler('here');
    await h.handler.handleUri(link);
    assert.deepEqual(h.routes, [], `${link.toString()}: nothing routed`);
    assert.deepEqual(h.seen, [], `${link.toString()}: nothing marked`);
    assert.equal(h.log.at(-1), `[Pitwall] uri rejected ${reason}`, link.toString());
    assert.ok(!h.log.some((line) => line.includes('popup click')));
  }
  assert.deepEqual(shownMessages(), [], 'no warning, no prompt: a forged link is silent');

  // The probe line names keys only, never values, and a hostile key cannot forge a log line.
  const h = handler('here');
  await h.handler.handleUri(uri(`session=${SESSION}&windowId=secret-value&bad%0Akey=1`));
  assert.equal(h.log[0], '[Pitwall] uri probe keys=session,windowId,bad?key');
  assert.ok(!h.log.join('\n').includes('secret-value'));
});

test('the URI uses vscode.env.uriScheme', () => {
  (vscode.env as { uriScheme: string }).uriScheme = 'cursor';
  assert.equal(openUri(SESSION), `cursor://sharifamlani.pitwall/open?session=${SESSION}`);
  (vscode.env as { uriScheme: string }).uriScheme = 'vscode-insiders';
  assert.equal(openUri(SESSION), `vscode-insiders://sharifamlani.pitwall/open?session=${SESSION}`);
  assert.deepEqual(parseOpenUri(uri(`session=${SESSION}`)), { sessionId: SESSION });
  assert.deepEqual(parseOpenUri(uri(`session=${SESSION.toUpperCase()}`)), { sessionId: SESSION.toUpperCase() });
});

test('a click marks the chat seen after the route lands', async () => {
  let land: (result: RouteResult) => void = () => undefined;
  const h = handler(() => new Promise<RouteResult>((resolve) => (land = resolve)));
  const handled = h.handler.handleUri(uri(`session=${SESSION}`));
  await flush();
  assert.equal(h.routes.length, 1);
  assert.deepEqual(h.seen, [], 'not before the route lands');
  land('here');
  await handled;
  assert.deepEqual(h.seen, ['chat-a'], 'opened here: marked seen (finished turns idle, D18) and its row selected');

  const gone = handler('gone');
  await gone.handler.handleUri(uri(`session=${SESSION}`));
  assert.deepEqual(gone.seen, ['chat-a'], 'a gone folder still marks it seen');
});

test("a click on a chat live in a terminal Pitwall doesn't own shows the Q28 warning, logs popup click outside, opens nothing and marks the chat seen", async () => {
  const folder = path.join(path.sep, 'work', 'uj-lab-c');
  const worktree = worktreeRecord({ id: 'wt-a', path: folder });
  const opened: string[] = [];
  const routeLog: string[] = [];
  const router = new ChatRouter({
    services: () => undefined,
    windowFolder: () => path.join(path.sep, 'work', 'uj-lab-a'),
    harnessRegistry: { has: () => true, get: () => ({}) as never, all: () => [] },
    worktreeOf: async () => worktree,
    rootsOf: () => [folder],
    repoName: () => 'uj-lab-c',
    isOpenHere: () => false,
    chatForSession: () => listed,
    openHere: async (chat) => {
      opened.push(chat.id);
      return true;
    },
    startNew: async () => false,
    outsideTerminal: async (sessionId) => (sessionId === SESSION ? { pid: 4321 } : undefined),
    log: (line) => routeLog.push(line),
  });
  const h = handler('here', { route: (request) => router.route(request) });
  await h.handler.handleUri(uri(`session=${SESSION}`));
  router.dispose();

  assert.deepEqual(shownMessages(), ['That chat is already running in another terminal (pid 4321). Switch to it there.'], 'the Q28 warning, unchanged');
  assert.deepEqual(routeLog, ['[Pitwall] route 5f0c3d4e → elsewhere (outside-terminal)']);
  assert.deepEqual(opened, [], 'no second process');
  assert.deepEqual(h.log, ['[Pitwall] uri probe keys=session', '[Pitwall] popup click 5f0c3d4e outside']);
  assert.deepEqual(h.seen, ['chat-a'], 'marked seen, so finished → idle still happens (Q48)');
});

test('a query key Cursor adds (allow-listed after S4) is accepted; any other key is rejected', async () => {
  const allowed = handler('here', { allowKeys: new Set(['windowId']) });
  await allowed.handler.handleUri(uri(`session=${SESSION}&windowId=7`));
  assert.equal(allowed.routes.length, 1, 'an allow-listed key rides along');
  assert.equal(allowed.log.at(-1), '[Pitwall] popup click 5f0c3d4e');

  await allowed.handler.handleUri(uri(`session=${SESSION}&other=7`));
  assert.equal(allowed.routes.length, 1, 'a key not on the list is rejected');
  assert.equal(allowed.log.at(-1), '[Pitwall] uri rejected param');

  const strict = handler('here');
  await strict.handler.handleUri(uri(`session=${SESSION}&windowId=7`));
  assert.deepEqual(strict.routes, [], 'the list starts empty: only session');
  assert.equal(strict.log.at(-1), '[Pitwall] uri rejected param');
});

test('a pop-up click handled in this window raises this window; a routed one leaves raising to the handoff (v0.6.0)', async () => {
  for (const [answer, raises] of [['here', 1], ['outside', 1], ['gone', 1], ['routed', 0]] as const) {
    let raised = 0;
    const h = handler(answer, { raiseWindow: () => void raised++ });
    await h.handler.handleUri(uri(`session=${SESSION}`));
    assert.equal(raised, raises, `${answer}: raised ${raises}`);
  }
  // A rejected link raises nothing: any local app can fire it.
  let raised = 0;
  await handler('here', { raiseWindow: () => void raised++ }).handler.handleUri(uri(`session=${OTHER}`));
  assert.equal(raised, 0);
});

test("this window is raised with the handoff's own call on its folder, never from a multi-root, workspace-file or empty window", async () => {
  const calls: { path: string; forceNewWindow?: boolean }[] = [];
  vscode.commands.registerCommand('vscode.openFolder', (target: vscode.Uri, options?: { forceNewWindow?: boolean }) => {
    calls.push({ path: target.fsPath, forceNewWindow: options?.forceNewWindow });
  });
  const folder = path.join(path.sep, 'work', 'pitwall');
  await raiseThisWindow({ folders: [folder], workspaceFile: undefined });
  assert.deepEqual(calls, [{ path: vscode.Uri.file(folder).fsPath, forceNewWindow: true }]);
  await raiseThisWindow({ folders: [folder, path.join(path.sep, 'work', 'b')], workspaceFile: undefined });
  await raiseThisWindow({ folders: [folder], workspaceFile: path.join(path.sep, 'work', 'a.code-workspace') });
  await raiseThisWindow({ folders: [], workspaceFile: undefined });
  assert.equal(calls.length, 1, 'openFolder from those would open a new window instead of raising this one');
});
