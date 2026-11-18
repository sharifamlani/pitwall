/**
 * FILES across windows (Phase 4 row 4.7): FILES always shows this window's
 * folder (Q8), one clipboard serves every window (Q9), "Copy to another repo"
 * and dropping a FILES row on a repo row copy into that repo's root (Q10,
 * Q20), and a copied `.env` the target repo does not ignore gets an offer to
 * add it to that repo's .gitignore (Q11). Copy strings are §3e / §3f verbatim.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate } from '../../../src/extension';
import { Repository, STORAGE_KEYS } from '../../../src/core/types';
import { FILES_MIME, FilesDragController, FilesTreeProvider, FileTreeItem, clipboardBanner } from '../../../src/core/providers/FilesTreeProvider';
import { registerFileCommands } from '../../../src/core/commands/files';
import { SharedClipboard, CLIPBOARD_FILE } from '../../../src/core/files/SharedClipboard';
import { RepoDropController } from '../../../src/core/files/RepoDropController';
import { checkIgnored, isEnvLike } from '../../../src/core/files/envIgnoreCheck';
import { disposeOperationLog } from '../../../src/core/services/OperationLog';
import { memento, runCommand, setEnv, shown, shownMessages, stub, tempDir, waitFor, worktreeRecord } from '../support';

beforeEach(() => {
  stub.__reset();
  disposeOperationLog();
});

interface Repo {
  name: string;
  rootPath: string;
}

const statusMessages = () => (stub as unknown as { __statusBarMessages: { text: string; timeoutMs: number }[] }).__statusBarMessages;
const operationLines = (): string[] =>
  stub.__outputChannels.find((channel) => channel.name === 'Pitwall Operations')?.lines ?? [];
/** The buttons a warning containing `text` offered. */
const warningButtons = (text: string): unknown[] | undefined =>
  stub.__messages.find((args) => typeof args[0] === 'string' && (args[0] as string).includes(text))?.slice(1);

/** A repo folder named `name` under `scratch`, holding `files` (relative path → content). */
function makeRepo(scratch: string, name: string, files: Record<string, string> = {}, options: { git?: boolean } = {}): Repo {
  const rootPath = path.join(scratch, name);
  fs.mkdirSync(rootPath, { recursive: true });
  if (options.git) {
    execFileSync('git', ['init', '-q', rootPath]);
  }
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(rootPath, rel)), { recursive: true });
    fs.writeFileSync(path.join(rootPath, rel), content);
  }
  return { name, rootPath };
}

/**
 * FILES commands for a window whose folder is `windowRepo`, over a clipboard
 * shared through `clipboardDir`, with `repos` as the sidebar's repos.
 */
function filesWindow(t: { after(fn: () => void): void }, windowRepo: Repo, repos: Repo[], clipboardDir: string) {
  const files = new FilesTreeProvider();
  t.after(() => files.dispose());
  files.setActiveWorktree(worktreeRecord({ path: windowRepo.rootPath, name: windowRepo.name }));
  const clipboard = new SharedClipboard(clipboardDir);
  t.after(() => clipboard.dispose());
  const repoOf = (p: string) =>
    repos.filter((repo) => p.toLowerCase().startsWith(repo.rootPath.toLowerCase())).sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
  const context = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;
  registerFileCommands(context, files, () => undefined, { clipboard, repos: () => repos, repoOf });
  t.after(() => context.subscriptions.forEach((d) => d.dispose()));
  const row = (absPath: string) =>
    new FileTreeItem(vscode.Uri.file(absPath), fs.statSync(absPath).isDirectory() ? vscode.FileType.Directory : vscode.FileType.File, windowRepo.rootPath);
  return { files, clipboard, row, repoOf };
}

// ---- Q8: FILES is this window's folder ----

test("FILES shows this window's folder, not the clicked repo", async (t) => {
  stub.__setTreeViewsVisible(true);
  const scratch = tempDir(t);
  const jobMarket = makeRepo(scratch, 'job-market', { 'README.md': 'hi' });
  const wynwood = makeRepo(scratch, 'wynwood', { 'notes.md': 'n' });
  const repositories = [
    { id: 'repo-job', name: 'job-market', rootPath: jobMarket.rootPath },
    { id: 'repo-wyn', name: 'wynwood', rootPath: wynwood.rootPath },
  ] as Repository[];
  setEnv(t, { CLAUDE_CONFIG_DIR: tempDir(t, 'pitwall-claude-') });
  stub.workspace.workspaceFolders = [{ uri: vscode.Uri.file(jobMarket.rootPath) } as never];
  const globalState = memento();
  await globalState.update(STORAGE_KEYS.CHATS, []);
  await globalState.update(STORAGE_KEYS.REPOSITORIES, repositories);
  const context = {
    subscriptions: [] as { dispose(): unknown }[],
    globalState,
    workspaceState: memento(),
    extensionUri: vscode.Uri.file('/extension'),
    extension: { id: 'sharifamlani.pitwall' },
  };
  t.after(() => context.subscriptions.forEach((subscription) => subscription.dispose()));
  t.after(disposeOperationLog);
  await activate(context as never);

  const list = stub.__treeViews.find((view) => view.id === 'pitwall.workspacesView')!;
  const filesView = stub.__treeViews.find((view) => view.id === 'pitwall.filesView')!;
  const filesRows = async () => ((await filesView.options.treeDataProvider!.getChildren()) as vscode.TreeItem[]).map((row) => row.label);
  assert.equal(filesView.description, 'job-market');
  assert.equal(fs.realpathSync(filesView.message ?? ''), fs.realpathSync(jobMarket.rootPath));
  assert.deepEqual(await filesRows(), ['README.md']);

  const rows = list.options.treeDataProvider!;
  const repoRows = (await rows.getChildren()) as { label: string }[];
  const wynwoodRow = repoRows.find((row) => row.label === 'wynwood');
  assert.ok(wynwoodRow, 'the wynwood row is listed');
  list.__select([wynwoodRow]);
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(filesView.description, 'job-market', 'FILES stays on this window');
  assert.deepEqual(await filesRows(), ['README.md']);

  // The clipboard banner (§3e) replaces the path line while something is on the clipboard.
  const readme = ((await filesView.options.treeDataProvider!.getChildren()) as FileTreeItem[])[0];
  await runCommand('pitwall.files.copy', readme);
  await waitFor(() => filesView.message?.startsWith('On the clipboard'), 'the clipboard banner');
  assert.equal(filesView.message, 'On the clipboard: README.md from job-market. Right-click → Paste, or Ctrl+V, in any repo.');
  assert.equal(stub.__contextKeys.get('pitwall.hasFileClipboard'), true);
});

test('FILES is empty in an empty window', async (t) => {
  const files = new FilesTreeProvider();
  t.after(() => files.dispose());
  files.setActiveWorktree(undefined);
  assert.deepEqual(await files.getChildren(), [], 'no rows, so the view shows its welcome text');
});

test('banner text matches §3e', () => {
  assert.equal(
    clipboardBanner('notes.md', 'wynwood'),
    'On the clipboard: notes.md from wynwood. Right-click → Paste, or Ctrl+V, in any repo.'
  );
});

// ---- Q9: one clipboard for every window ----

test('copy in window A is visible to paste in window B', async (t) => {
  const dir = tempDir(t);
  const windowA = new SharedClipboard(dir);
  const windowB = new SharedClipboard(dir);
  t.after(() => {
    windowA.dispose();
    windowB.dispose();
  });
  let bHeard = 0;
  windowB.onDidChange(() => bHeard++);
  const watching = windowB.watch();
  t.after(() => watching.dispose());

  const file = path.join(dir, 'notes.md');
  await windowA.set(file, false);
  assert.deepEqual(
    { ...(await windowB.get()), at: 0 },
    { path: file, cut: false, at: 0 },
    'window B reads what window A copied'
  );
  const stored = JSON.parse(fs.readFileSync(path.join(dir, CLIPBOARD_FILE), 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['at', 'cut', 'path'], 'only the privacy-listed keys');
  assert.ok(!fs.existsSync(path.join(dir, `${CLIPBOARD_FILE}.tmp`)), 'written through a temp file and renamed');
  await waitFor(() => bHeard > 0, "window B's change event");

  await windowB.clear();
  assert.equal(await windowA.get(), undefined, 'a clear in one window empties every window');
});

test('cut then paste moves the file and clears the clipboard', async (t) => {
  const scratch = tempDir(t);
  const wynwood = makeRepo(scratch, 'wynwood', { 'notes.md': 'n' });
  const jobMarket = makeRepo(scratch, 'job-market');
  const clipboardDir = tempDir(t);
  // Window A (wynwood) cuts; window B (job-market) pastes.
  const a = filesWindow(t, wynwood, [jobMarket, wynwood], clipboardDir);
  await runCommand('pitwall.files.cut', a.row(path.join(wynwood.rootPath, 'notes.md')));
  assert.deepEqual(statusMessages().at(-1), {
    text: 'Cut notes.md (wynwood). Now click another repo: its window comes up and the cut waits on the clipboard (Pitwall keeps one clipboard across all its windows). Right-click in FILES → Paste, or press Ctrl+V.',
    timeoutMs: 5000,
  });

  a.files.dispose();
  const b = filesWindow(t, jobMarket, [jobMarket, wynwood], clipboardDir);
  await runCommand('pitwall.files.paste');
  assert.ok(fs.existsSync(path.join(jobMarket.rootPath, 'notes.md')), 'moved into the window folder');
  assert.equal(fs.existsSync(path.join(wynwood.rootPath, 'notes.md')), false, 'and gone from wynwood');
  assert.equal(await b.clipboard.get(), undefined, 'a cut clears the clipboard after the paste');
  assert.ok(shown(`Moved notes.md from wynwood into job-market (${jobMarket.rootPath}).`), shownMessages().join('\n'));
  assert.equal(shown('Refusing to paste outside the active worktree'), false, 'the old guard is gone');
});

test('paste after the source file is gone warns and clears the clipboard', async (t) => {
  const scratch = tempDir(t);
  const wynwood = makeRepo(scratch, 'wynwood', { 'notes.md': 'n' });
  const jobMarket = makeRepo(scratch, 'job-market');
  const w = filesWindow(t, jobMarket, [jobMarket, wynwood], tempDir(t));
  await w.clipboard.set(path.join(wynwood.rootPath, 'notes.md'), false);
  fs.rmSync(path.join(wynwood.rootPath, 'notes.md'));
  await runCommand('pitwall.files.paste');
  const warning = stub.__messages.find((args) => args[0] === 'The item to paste no longer exists.');
  assert.ok(warning, shownMessages().join('\n'));
  assert.equal(await w.clipboard.get(), undefined);
});

test('name clash saves as "{name} copy{.ext}"', async (t) => {
  const scratch = tempDir(t);
  const wynwood = makeRepo(scratch, 'wynwood', { 'notes.md': 'from wynwood' });
  const jobMarket = makeRepo(scratch, 'job-market', { 'notes.md': 'already here' });
  const w = filesWindow(t, jobMarket, [jobMarket, wynwood], tempDir(t));
  await runCommand('pitwall.files.copy', w.row(path.join(wynwood.rootPath, 'notes.md')));
  assert.equal(
    statusMessages().at(-1)?.text,
    'Copied notes.md (wynwood). Now click another repo: its window comes up and the copy waits on the clipboard (Pitwall keeps one clipboard across all its windows). Right-click in FILES → Paste, or press Ctrl+V.'
  );
  await runCommand('pitwall.files.paste');
  assert.equal(fs.readFileSync(path.join(jobMarket.rootPath, 'notes copy.md'), 'utf8'), 'from wynwood');
  assert.equal(fs.readFileSync(path.join(jobMarket.rootPath, 'notes.md'), 'utf8'), 'already here', 'never overwritten');
  assert.ok(
    shown(
      `Pasted notes.md from wynwood into job-market (${jobMarket.rootPath}). A file with that name was already there, so it was saved as 'notes copy.md'.`
    ),
    shownMessages().join('\n')
  );
  assert.ok(await w.clipboard.get(), 'a copy stays on the clipboard for the next paste');
});

// ---- Q10: Copy to another repo ----

test('Copy to another repo lists other repos only and copies into the chosen root', async (t) => {
  const scratch = tempDir(t);
  const jobMarket = makeRepo(scratch, 'job-market', { 'src/notes.md': 'n' });
  const wynwood = makeRepo(scratch, 'wynwood');
  const delphi = makeRepo(scratch, 'delphi');
  const w = filesWindow(t, jobMarket, [jobMarket, wynwood, delphi], tempDir(t));
  let offered: { label: string; detail?: string }[] = [];
  let placeHolder: string | undefined;
  stub.__setQuickPickHandler((items: unknown, options: unknown) => {
    offered = items as { label: string; detail?: string }[];
    placeHolder = (options as { placeHolder?: string }).placeHolder;
    return offered.find((item) => item.label === 'wynwood');
  });
  await runCommand('pitwall.files.copyToRepo', w.row(path.join(jobMarket.rootPath, 'src', 'notes.md')));
  assert.equal(placeHolder, 'Copy notes.md to which repo?');
  assert.deepEqual(
    offered.map(({ label, detail }) => ({ label, detail })),
    [
      { label: 'wynwood', detail: wynwood.rootPath },
      { label: 'delphi', detail: delphi.rootPath },
    ],
    'every other repo, never this one'
  );
  assert.ok(fs.existsSync(path.join(wynwood.rootPath, 'notes.md')), "copied into wynwood's root");
  assert.ok(fs.existsSync(path.join(jobMarket.rootPath, 'src', 'notes.md')), 'the source stays');
  assert.ok(shown(`Pasted notes.md from job-market into wynwood (${wynwood.rootPath}).`), shownMessages().join('\n'));
});

// ---- Drag a FILES row onto a repo row (Q20) ----

function repoRow(repo: Repo) {
  return { itemType: 'repository', data: { id: `repo-${repo.name}`, name: repo.name, rootPath: repo.rootPath } };
}

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as never;

test('dropping a FILES row on a repo row copies it there', async (t) => {
  const scratch = tempDir(t);
  const jobMarket = makeRepo(scratch, 'job-market', { 'notes.md': 'n' });
  const wynwood = makeRepo(scratch, 'wynwood');
  const w = filesWindow(t, jobMarket, [jobMarket, wynwood], tempDir(t));
  const drag = new FilesDragController();
  assert.deepEqual(drag.dragMimeTypes, [FILES_MIME]);
  assert.equal(FILES_MIME, 'application/vnd.code.tree.pitwall.filesview');
  const transfer = new vscode.DataTransfer();
  await drag.handleDrag([w.row(path.join(jobMarket.rootPath, 'notes.md'))], transfer, token);

  const drop = new RepoDropController(w.repoOf);
  await drop.handleDrop(repoRow(wynwood) as never, transfer, token);
  assert.ok(fs.existsSync(path.join(wynwood.rootPath, 'notes.md')), "copied into wynwood's root");
  assert.ok(shown(`Pasted notes.md from job-market into wynwood (${wynwood.rootPath}).`), shownMessages().join('\n'));
});

test('an Explorer text/uri-list drop is not accepted', async (t) => {
  const scratch = tempDir(t);
  const outside = makeRepo(scratch, 'outside', { 'secret.txt': 's' });
  const wynwood = makeRepo(scratch, 'wynwood');
  const drop = new RepoDropController(() => undefined);
  assert.deepEqual(drop.dropMimeTypes, ['application/vnd.code.tree.pitwall.filesview'], 'only FILES rows, not text/uri-list');
  const transfer = new vscode.DataTransfer();
  transfer.set('text/uri-list', new vscode.DataTransferItem(vscode.Uri.file(path.join(outside.rootPath, 'secret.txt')).toString()));
  await drop.handleDrop(repoRow(wynwood) as never, transfer, token);
  assert.deepEqual(fs.readdirSync(wynwood.rootPath), [], 'nothing copied');
});

test('dropping on the same repo shows "That file is already in {repo}. Drop it on a different repo to copy it there."', async (t) => {
  const scratch = tempDir(t);
  const jobMarket = makeRepo(scratch, 'job-market', { 'notes.md': 'n' });
  const w = filesWindow(t, jobMarket, [jobMarket], tempDir(t));
  const transfer = new vscode.DataTransfer();
  await new FilesDragController().handleDrag([w.row(path.join(jobMarket.rootPath, 'notes.md'))], transfer, token);
  await new RepoDropController(w.repoOf).handleDrop(repoRow(jobMarket) as never, transfer, token);
  assert.ok(shown('That file is already in job-market. Drop it on a different repo to copy it there.'), shownMessages().join('\n'));
  assert.deepEqual(fs.readdirSync(jobMarket.rootPath), ['notes.md'], 'no copy made');
});

// ---- Q11: the .gitignore offer ----

test('isEnvLike: .env, .env.local yes; .env.example, .env.sample, .env.template, env.txt no', () => {
  for (const name of ['.env', '.env.local', '.env.production']) assert.equal(isEnvLike(name), true, name);
  for (const name of ['.env.example', '.env.sample', '.env.template', 'env.txt', 'notes.env', '.envrc']) assert.equal(isEnvLike(name), false, name);
});

test('an un-ignored .env copy warns with Add to .gitignore and Not now; accepting appends "/{rel}" with forward slashes, adds a newline first when the file lacks one, and re-checks', async (t) => {
  const scratch = tempDir(t);
  const jobMarket = makeRepo(scratch, 'job-market', { '.env': 'KEY=1', '.env.local': 'KEY=2', 'config/keep.txt': '' });
  const wynwood = makeRepo(scratch, 'wynwood', { '.env': 'KEY=3', '.gitignore': 'node_modules' }, { git: true });
  const delphi = makeRepo(scratch, 'delphi', {}, { git: true });

  // 1. Copy to another repo: wynwood's .gitignore lacks a final newline.
  const w = filesWindow(t, jobMarket, [jobMarket, wynwood, delphi], tempDir(t));
  stub.__setQuickPickHandler((items: unknown) => (items as { label: string }[]).find((item) => item.label === 'wynwood'));
  stub.__warningResponses.push('Add to .gitignore');
  await runCommand('pitwall.files.copyToRepo', w.row(path.join(jobMarket.rootPath, '.env.local')));
  const warning = "⚠ wynwood's .gitignore does not cover .env.local, so it could get committed.";
  assert.deepEqual(warningButtons(warning), ['Add to .gitignore', 'Not now'], shownMessages().join('\n'));
  assert.equal(fs.readFileSync(path.join(wynwood.rootPath, '.gitignore'), 'utf8'), 'node_modules\n/.env.local\n', 'newline first, then /{rel}');
  assert.equal(await checkIgnored(wynwood.rootPath, '.env.local'), true, 'git now ignores it');
  assert.ok(shown("Added .env.local to wynwood's .gitignore."), 're-checked, then confirmed');

  // 2. "Not now" changes nothing; a .gitignore that is missing stays missing.
  stub.__setQuickPickHandler((items: unknown) => (items as { label: string }[]).find((item) => item.label === 'delphi'));
  stub.__warningResponses.push('Not now');
  await runCommand('pitwall.files.copyToRepo', w.row(path.join(jobMarket.rootPath, '.env')));
  assert.ok(shown("⚠ delphi's .gitignore does not cover .env, so it could get committed."));
  assert.equal(fs.existsSync(path.join(delphi.rootPath, '.gitignore')), false);

  // 3. A paste into a subfolder of a git window: the rule is /config/.env, and a missing .gitignore is created.
  const windowDelphi = filesWindow(t, delphi, [jobMarket, wynwood, delphi], tempDir(t));
  fs.mkdirSync(path.join(delphi.rootPath, 'config'));
  fs.writeFileSync(path.join(delphi.rootPath, 'config', 'keep.txt'), '');
  await runCommand('pitwall.files.copy', windowDelphi.row(path.join(wynwood.rootPath, '.env')));
  stub.__warningResponses.push('Add to .gitignore');
  await runCommand('pitwall.files.paste', windowDelphi.row(path.join(delphi.rootPath, 'config')));
  assert.ok(fs.existsSync(path.join(delphi.rootPath, 'config', '.env')));
  assert.equal(fs.readFileSync(path.join(delphi.rootPath, '.gitignore'), 'utf8'), '/config/.env\n', 'created, with forward slashes');
  assert.ok(shown("Added .env to delphi's .gitignore."));

  // 4. Already ignored (the clash name '.env copy.local' matches .env*): no offer.
  fs.appendFileSync(path.join(wynwood.rootPath, '.gitignore'), '.env*\n');
  const before = stub.__messages.length;
  stub.__setQuickPickHandler((items: unknown) => (items as { label: string }[]).find((item) => item.label === 'wynwood'));
  await runCommand('pitwall.files.copyToRepo', w.row(path.join(jobMarket.rootPath, '.env.local')));
  assert.ok(
    !stub.__messages.slice(before).some((args) => String(args[0]).includes('does not cover')),
    'an ignored copy gets no warning'
  );
});

test('git check-ignore exit 128 makes no offer and logs it', async (t) => {
  const scratch = tempDir(t);
  const jobMarket = makeRepo(scratch, 'job-market', { '.env': 'KEY=1' });
  const plain = makeRepo(scratch, 'plain'); // no git: check-ignore exits 128
  assert.equal(await checkIgnored(plain.rootPath, '.env'), 'error');
  const w = filesWindow(t, jobMarket, [jobMarket, plain], tempDir(t));
  stub.__setQuickPickHandler((items: unknown) => (items as { label: string }[])[0]);
  await runCommand('pitwall.files.copyToRepo', w.row(path.join(jobMarket.rootPath, '.env')));
  assert.ok(fs.existsSync(path.join(plain.rootPath, '.env')), 'the copy itself still happens');
  assert.equal(shown('does not cover'), false, 'no offer');
  assert.ok(
    operationLines().some((line) => line.includes('git check-ignore') && line.includes('.env')),
    `logged (lines: ${operationLines().join(' | ')})`
  );
});
