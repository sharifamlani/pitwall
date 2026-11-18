import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FilesTreeProvider, FileTreeItem } from '../../../src/core/providers/FilesTreeProvider';
import { registerFileCommands } from '../../../src/core/commands/files';
import { runCommand, shown, stub, tempDir, worktreeRecord } from '../support';

test('All Files lists folders first in natural order, hides build and VCS output, and keys rows by path', async (t) => {
  const root = tempDir(t);
  for (const dir of ['src', 'node_modules', '.git']) {
    fs.mkdirSync(path.join(root, dir));
  }
  for (const file of ['src/a.ts', 'file10.txt', 'file2.txt', 'README.md', 'node_modules/x.js']) {
    fs.writeFileSync(path.join(root, file), '');
  }
  const files = new FilesTreeProvider();
  t.after(() => files.dispose());

  assert.deepEqual(await files.getChildren(), [], 'no folder: no rows, so the view shows its welcome text');

  files.setActiveWorktree(worktreeRecord({ path: root }));
  const top = (await files.getChildren()) as FileTreeItem[];
  assert.deepEqual(top.map((item) => item.label), ['src', 'file2.txt', 'file10.txt', 'README.md']);
  assert.ok(top.every((item) => item.id === `file:${item.uri.fsPath}`), 'stable ids keep folders expanded');

  const src = top[0];
  assert.equal(src.contextValue, 'folder');
  const [nested] = (await files.getChildren(src)) as FileTreeItem[];
  assert.equal(nested.tooltip, path.join('src', 'a.ts'), 'rows tooltip their worktree-relative path');
});

/** Registers the Files commands over a real temp worktree with `README.md` and `src/`. */
function filesSetup(t: { after(fn: () => void): void }) {
  stub.__reset();
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, 'README.md'), 'hi');
  fs.mkdirSync(path.join(root, 'src'));
  const files = new FilesTreeProvider();
  t.after(() => files.dispose());
  files.setActiveWorktree(worktreeRecord({ path: root }));
  const context = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;
  registerFileCommands(context, files, () => undefined);
  const opener = vscode.commands.registerCommand('vscode.open', () => undefined);
  t.after(() => opener.dispose());
  t.after(() => context.subscriptions.forEach((d) => d.dispose()));
  /** A row as the editor spells it: on Windows the drive letter is lower case. */
  const row = (rel: string, type: vscode.FileType) => {
    const full = path.join(root, rel);
    const editorSpelling = process.platform === 'win32' ? full[0].toLowerCase() + full.slice(1) : full;
    return new FileTreeItem(vscode.Uri.file(editorSpelling), type, root);
  };
  return { root, files, row };
}

test('new file with a file selected creates it next to that file, not inside it', async (t) => {
  const { root, row } = filesSetup(t);
  stub.__inputResponses.push('notes.txt');
  await runCommand('pitwall.files.newFile', row('README.md', vscode.FileType.File));
  assert.equal(shown('outside the active worktree'), false);
  assert.ok(fs.existsSync(path.join(root, 'notes.txt')), 'created beside README.md');

  stub.__inputResponses.push('more');
  await runCommand('pitwall.files.newFolder', row('src', vscode.FileType.Directory));
  assert.ok(fs.statSync(path.join(root, 'src', 'more')).isDirectory(), 'a folder selection is the parent');
});

test('rename, delete and paste accept a selected row whose fsPath has a lower-case drive', async (t) => {
  const { root, row } = filesSetup(t);

  stub.__inputResponses.push('GUIDE.md');
  await runCommand('pitwall.files.rename', row('README.md', vscode.FileType.File));
  assert.equal(shown('Refusing'), false);
  assert.ok(fs.existsSync(path.join(root, 'GUIDE.md')));

  await runCommand('pitwall.files.copy', row('GUIDE.md', vscode.FileType.File));
  await runCommand('pitwall.files.paste', row('src', vscode.FileType.Directory));
  assert.equal(shown('Refusing'), false);
  assert.ok(fs.existsSync(path.join(root, 'src', 'GUIDE.md')));

  stub.__warningResponses.push('Move to Trash');
  await runCommand('pitwall.files.delete', row('GUIDE.md', vscode.FileType.File));
  assert.equal(shown('Refusing'), false);
  assert.equal(fs.existsSync(path.join(root, 'GUIDE.md')), false);

  // A folder still cannot be pasted into itself, however the drive is spelled.
  await runCommand('pitwall.files.copy', row('src', vscode.FileType.Directory));
  await runCommand('pitwall.files.paste', row('src', vscode.FileType.Directory));
  assert.ok(shown('Cannot paste a folder into itself'));
});
