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
import { startWindowServices } from '../../../../src/core/windows/startWindowServices';

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
