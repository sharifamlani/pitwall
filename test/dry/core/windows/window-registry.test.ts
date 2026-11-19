/**
 * The window registry (row 4.2): every window beats its folder and open chats
 * into `<globalStorage>/pitwall-windows/<pid>.json`, and reads the others'.
 * Real temp dirs and an injected clock; the pids are real processes.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { stub, tempDir, waitFor } from '../../support';
import { STALE_MS, WindowRegistry, ownsFolder } from '../../../../src/core/windows/WindowRegistry';
import { HandoffInbox } from '../../../../src/core/windows/HandoffInbox';
import { startWindowRegistry, startWindowServices } from '../../../../src/core/windows/startWindowServices';

beforeEach(() => stub.__reset());

/** A pid that belonged to a process which has already exited. */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ['-e', '']).pid;
  assert.ok(pid, 'the child process started');
  return pid;
}

/** Spellings of one real folder that the editor, git and the OS each might use. */
function spellings(folder: string): string[] {
  const variants = [folder, folder + path.sep, folder.split(path.sep).join('/') + '/'];
  if (process.platform === 'win32') {
    const flipped = folder[0] === folder[0].toUpperCase() ? folder[0].toLowerCase() : folder[0].toUpperCase();
    variants.push(flipped + folder.slice(1).toLowerCase(), '\\\\?\\' + folder);
  }
  return variants;
}

function fakeClock(start = 1_700_000_000_000) {
  const clock = { now: start, read: () => clock.now };
  return clock;
}

test('a window appears after one beat and disappears 45 s after its last beat', async (t) => {
  const dir = tempDir(t);
  const clock = fakeClock();
  const observer = new WindowRegistry(dir, { pid: process.pid, folder: undefined }, clock.read);
  const other = new WindowRegistry(dir, { pid: process.ppid, folder: tempDir(t) }, clock.read);

  assert.deepEqual(await observer.windows(), []);
  await other.beat(['5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f']);
  const seen = await observer.windows();
  assert.deepEqual(
    seen.map((w) => [w.pid, w.openSessionIds]),
    [[process.ppid, ['5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f']]]
  );

  clock.now += STALE_MS - 1;
  assert.equal((await observer.windows()).length, 1, 'still live 1 ms before 45 s');
  clock.now += 1;
  assert.deepEqual(await observer.windows(), [], 'stale 45 s after its last beat');
});

test('a dead pid is stale at once', async (t) => {
  const dir = tempDir(t);
  const clock = fakeClock();
  const observer = new WindowRegistry(dir, { pid: process.pid, folder: undefined }, clock.read);
  await new WindowRegistry(dir, { pid: deadPid(), folder: tempDir(t) }, clock.read).beat([]);
  await new WindowRegistry(dir, { pid: process.ppid, folder: tempDir(t) }, clock.read).beat([]);

  assert.deepEqual((await observer.windows()).map((w) => w.pid), [process.ppid]);
});

test('dispose deletes the window\'s own file', async (t) => {
  const dir = tempDir(t);
  const registry = new WindowRegistry(dir, { pid: process.pid, folder: tempDir(t) });
  const own = path.join(dir, 'pitwall-windows', `${process.pid}.json`);
  const started = registry.start();
  await waitFor(() => fs.existsSync(own), 'the first beat');

  started.dispose();
  assert.equal(fs.existsSync(own), false);
  await registry.beat(['5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f']);
  assert.equal(fs.existsSync(own), false, 'a beat after dispose writes nothing');
});

test('a beat with no change fires no onDidChange', async (t) => {
  const dir = tempDir(t);
  const clock = fakeClock();
  const registry = new WindowRegistry(dir, { pid: process.pid, folder: tempDir(t) }, clock.read);
  let fired = 0;
  registry.onDidChange(() => fired++);

  await registry.beat(['5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f']);
  assert.equal(fired, 1, 'the window appeared');
  clock.now += 15_000;
  await registry.beat(['5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f']);
  assert.equal(fired, 1, 'only beatAt moved');
  await registry.beat(['5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', '6a1d4e5f-2b3c-4d4e-9f0a-1b2c3d4e5f60']);
  assert.equal(fired, 2, 'its open chats changed');

  // Another window going stale is a change too.
  await new WindowRegistry(dir, { pid: process.ppid, folder: undefined }, clock.read).beat([]);
  await registry.refresh();
  assert.equal(fired, 3, 'another window appeared');
  clock.now += STALE_MS;
  await registry.beat(['5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', '6a1d4e5f-2b3c-4d4e-9f0a-1b2c3d4e5f60']);
  assert.equal(fired, 4, 'the other window went stale');
});

test('windowsFor matches C:\\Code\\Lab and c:/code/lab/ as one folder', async (t) => {
  const dir = tempDir(t);
  const folder = tempDir(t, 'pitwall-Lab-');
  const variants = spellings(folder);
  const registry = new WindowRegistry(dir, { pid: process.pid, folder: variants.at(-1) }, fakeClock().read);
  await registry.beat([]);

  for (const variant of variants) {
    assert.deepEqual((await registry.windowsFor(variant)).map((w) => w.pid), [process.pid], variant);
  }
  assert.deepEqual(await registry.windowsFor(tempDir(t)), [], 'another folder has no window');
});

test('openSessionIds unions every live window', async (t) => {
  const dir = tempDir(t);
  const clock = fakeClock();
  const a = '5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
  const b = '6a1d4e5f-2b3c-4d4e-9f0a-1b2c3d4e5f60';
  const c = '7b2e5f60-3c4d-4e5f-8a1b-2c3d4e5f6071';
  const registry = new WindowRegistry(dir, { pid: process.pid, folder: tempDir(t) }, clock.read);
  await registry.beat([a, b]);
  await new WindowRegistry(dir, { pid: process.ppid, folder: tempDir(t) }, clock.read).beat([b, c]);
  await new WindowRegistry(dir, { pid: deadPid(), folder: tempDir(t) }, clock.read).beat(['8c3f6071-4d5e-4f60-9b2c-3d4e5f607182']);

  assert.deepEqual([...(await registry.openSessionIds())].sort(), [a, b, c]);
});

test('window services start in the background, beat, log the registry, and stop on dispose', async (t) => {
  const storage = path.join(tempDir(t), 'globalStorage');
  const lab = tempDir(t);
  stub.workspace.workspaceFolders = [{ uri: { fsPath: lab } }];
  const lines: string[] = [];
  const context = { subscriptions: [] as { dispose(): unknown }[], globalStorageUri: vscode.Uri.file(storage) };
  t.after(() => context.subscriptions.forEach((subscription) => subscription.dispose()));

  const services = startWindowServices(context as never, (line) => lines.push(line));
  assert.ok(services, 'started');
  const own = path.join(storage, 'pitwall-windows', `${process.pid}.json`);
  await waitFor(() => lines.includes('[Pitwall] window registry 1 windows'), 'the registry log line');
  assert.deepEqual(JSON.parse(fs.readFileSync(own, 'utf8')).folder, lab);
  assert.equal(fs.existsSync(path.join(storage, 'pitwall-handoff', services.inbox.folderKey(lab))), true, 'its inbox folder');

  // A claimed request fails cleanly until a window can open handed-off chats (Task 3).
  const sender = new HandoffInbox(storage, { pid: process.pid, folder: undefined });
  const nonce = await sender.send(lab, { kind: 'open', sessionIds: ['5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f'] });
  await waitFor(() => sender.outcome(lab, nonce), 'the outcome', 20_000);
  assert.equal((await sender.outcome(lab, nonce))?.ok, false);

  context.subscriptions.forEach((subscription) => subscription.dispose());
  assert.equal(fs.existsSync(own), false, 'disposing deletes the record');
  assert.equal(startWindowServices({ subscriptions: [] } as never, (line) => lines.push(line)), undefined, 'no global storage');
});

test('a multi-root window owns no folder', (t) => {
  const one = tempDir(t);
  const two = tempDir(t);
  const folder = (fsPath: string) => ({ uri: { fsPath } });

  assert.equal(ownsFolder(), undefined, 'an empty window');
  stub.workspace.workspaceFolders = [folder(one)];
  assert.equal(ownsFolder(), one, 'a single-folder window');
  stub.workspace.workspaceFolders = [folder(one), folder(two)];
  assert.equal(ownsFolder(), undefined, 'two folders');
  stub.workspace.workspaceFolders = [folder(one)];
  stub.workspace.workspaceFile = { fsPath: path.join(two, 'lab.code-workspace') };
  assert.equal(ownsFolder(), undefined, 'a .code-workspace window with one folder');
});

test('a window registers at activation, before its window services (E6): a sender sees it while it is still starting', async (t) => {
  const storage = path.join(tempDir(t), 'globalStorage');
  const lab = tempDir(t);
  stub.workspace.workspaceFolders = [{ uri: { fsPath: lab } }];
  const context = { subscriptions: [] as { dispose(): unknown }[], globalStorageUri: vscode.Uri.file(storage) };
  t.after(() => context.subscriptions.forEach((subscription) => subscription.dispose()));

  const early = startWindowRegistry(context as never);
  assert.ok(early, 'registered');
  const sender = new WindowRegistry(storage, { pid: process.ppid, folder: undefined });
  await waitFor(async () => (await sender.windowsFor(lab)).length === 1, 'the window in the registry, with no window services started');
  assert.equal(fs.existsSync(path.join(storage, 'pitwall-handoff')), false, 'no inbox yet: the window services have not started');

  // The services then reuse that registry: still one record, and one dispose removes it.
  const services = startWindowServices(context as never, () => undefined, undefined, early);
  assert.equal(services?.registry, early);
  assert.equal((await sender.windowsFor(lab)).length, 1);
  context.subscriptions.forEach((subscription) => subscription.dispose());
  assert.equal((await sender.windowsFor(lab)).length, 0, 'disposing removes the record');
  assert.equal(startWindowRegistry({ subscriptions: [] } as never), undefined, 'no global storage');
});

const A = '5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const B = '6a1d4e5f-2b3c-4d4e-9f0a-1b2c3d4e5f60';

test('front and focused round-trip through the record', async (t) => {
  const dir = tempDir(t);
  const clock = fakeClock();
  const self = new WindowRegistry(dir, { pid: process.pid, folder: tempDir(t) }, clock.read);
  const observer = new WindowRegistry(dir, { pid: process.ppid, folder: undefined }, clock.read);

  await self.beat({ openSessionIds: [A, B], front: B, focused: true });
  const [record] = (await observer.windows()).filter((w) => w.pid === process.pid);
  assert.deepEqual([record.openSessionIds, record.front, record.focused], [[A, B], B, true]);
  const own = path.join(dir, 'pitwall-windows', `${process.pid}.json`);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(own, 'utf8'))).sort(), ['beatAt', 'focused', 'folder', 'front', 'openSessionIds', 'pid']);

  await self.beat({ openSessionIds: [A, B], focused: false });
  const [after] = (await observer.windows()).filter((w) => w.pid === process.pid);
  assert.deepEqual([after.front, after.focused], [undefined, false], 'no chat in front, window blurred');

  // A record from a Phase 4 build (no front, no focused) still parses.
  fs.writeFileSync(own, JSON.stringify({ pid: process.pid, folder: null, beatAt: clock.now, openSessionIds: [A] }));
  const [old] = (await observer.windows()).filter((w) => w.pid === process.pid);
  assert.deepEqual([old.front, old.focused], [undefined, false]);
});

test('a focus change alone does not fire onDidChange', async (t) => {
  const dir = tempDir(t);
  const registry = new WindowRegistry(dir, { pid: process.pid, folder: tempDir(t) }, fakeClock().read);
  let fired = 0;
  registry.onDidChange(() => fired++);
  await registry.beat({ openSessionIds: [A, B], front: A, focused: true });
  assert.equal(fired, 1, 'the window appeared');
  await registry.beat({ openSessionIds: [A, B], front: B, focused: true });
  await registry.beat({ openSessionIds: [A, B], front: B, focused: false });
  await registry.beat({ openSessionIds: [A, B], focused: false });
  assert.equal(fired, 1, 'front and focused are outside the change signature');
  await registry.beat({ openSessionIds: [A], focused: false });
  assert.equal(fired, 2, 'an open-chats change still fires');
});

test('frontAnywhere answers synchronously from the cached snapshot', async (t) => {
  const dir = tempDir(t);
  const clock = fakeClock();
  const here = new WindowRegistry(dir, { pid: process.pid, folder: tempDir(t) }, clock.read);
  const other = new WindowRegistry(dir, { pid: process.ppid, folder: tempDir(t) }, clock.read);
  assert.equal(here.frontAnywhere(A), false, 'nothing read yet');

  await other.beat({ openSessionIds: [A], front: A, focused: true });
  await here.refresh();
  const result = here.frontAnywhere(A);
  assert.equal(typeof result, 'boolean', 'a plain value, not a promise');
  assert.equal(result, true, 'in front of a focused window');
  assert.equal(here.frontAnywhere(B), false);

  await other.beat({ openSessionIds: [A], front: A, focused: false });
  await here.refresh();
  assert.equal(here.frontAnywhere(A), false, 'in front of a window that lost focus does not count');

  // The cache answers without touching the disk.
  await other.beat({ openSessionIds: [A], front: A, focused: true });
  await here.refresh();
  fs.rmSync(path.join(dir, 'pitwall-windows'), { recursive: true, force: true });
  assert.equal(here.frontAnywhere(A), true, 'from the snapshot the last refresh cached');
});

test("a stale record's front is ignored", async (t) => {
  const dir = tempDir(t);
  const clock = fakeClock();
  const here = new WindowRegistry(dir, { pid: process.pid, folder: tempDir(t) }, clock.read);
  await new WindowRegistry(dir, { pid: process.ppid, folder: tempDir(t) }, clock.read).beat({ openSessionIds: [A], front: A, focused: true });
  await here.refresh();
  assert.equal(here.frontAnywhere(A), true);
  clock.now += STALE_MS;
  assert.equal(here.frontAnywhere(A), false, 'stale 45 s after its beat, even before the next refresh');
  await new WindowRegistry(dir, { pid: deadPid(), folder: tempDir(t) }, clock.read).beat({ openSessionIds: [B], front: B, focused: true });
  await here.refresh();
  assert.equal(here.frontAnywhere(B), false, 'a dead pid never counts');
});

test('the early registry entry is disposed when window services fail to start', async (t) => {
  const storage = path.join(tempDir(t), 'globalStorage');
  const lab = tempDir(t);
  stub.workspace.workspaceFolders = [{ uri: { fsPath: lab } }];
  const context = { subscriptions: [] as { dispose(): unknown }[], globalStorageUri: vscode.Uri.file(storage) };
  t.after(() => context.subscriptions.forEach((subscription) => subscription.dispose()));
  const early = startWindowRegistry(context as never);
  assert.ok(early);
  const own = path.join(storage, 'pitwall-windows', `${process.pid}.json`);
  await waitFor(() => fs.existsSync(own), 'the early beat');

  // The services' own storage is unusable (a file where the folder should be): they fail to start.
  const blocked = path.join(tempDir(t), 'not-a-folder');
  fs.writeFileSync(blocked, '');
  const lines: string[] = [];
  const failing = { subscriptions: context.subscriptions, globalStorageUri: vscode.Uri.file(path.join(blocked, 'globalStorage')) };
  assert.equal(startWindowServices(failing as never, (line) => lines.push(line), undefined, early), undefined);
  assert.ok(lines.some((line) => line.startsWith('[Pitwall] window services did not start')), lines.join('\n'));
  assert.equal(fs.existsSync(own), false, 'the early record is gone, so no sender waits on a window that cannot claim');
  await early.beat({ openSessionIds: [A], focused: true });
  assert.equal(fs.existsSync(own), false, 'and it beats no more');
});

test('activation registers the window before the first render: extension.ts calls startWindowRegistry and hands it on (E6)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
  const early = source.indexOf('const earlyRegistry = startWindowRegistry(context)');
  assert.ok(early > 0, 'the registry is started in activate');
  assert.ok(early < source.indexOf('afterFirstRender(() => {'), 'before any work is scheduled for after the first render');
  assert.ok(/startWindowServices\([^;]*earlyRegistry\)/.test(source), 'and the window services reuse it');
});
