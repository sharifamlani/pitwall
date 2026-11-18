import * as vscode from 'vscode';
import * as path from 'path';
import { FileTreeItem, FilesTreeProvider } from '../providers/FilesTreeProvider';
import { logOperation } from '../services/OperationLog';
import { isStrictlyWithin, isWithin, samePath } from '../utils/paths';
import { SharedClipboard } from '../files/SharedClipboard';
import { RepoRef, copyIntoRepo, landedMessage, uniqueDest } from '../files/copyInto';
import { offerGitignore } from '../files/envIgnoreCheck';

/** What the FILES clipboard commands need beyond the tree (row 4.7). */
export interface FileCommandDeps {
  /** The clipboard every window shares (Q9). Default: this window's alone, in memory. */
  clipboard?: SharedClipboard;
  /** The sidebar's repos, in list order. */
  repos?: () => RepoRef[];
  /** The sidebar repo a path belongs to. */
  repoOf?: (filePath: string) => RepoRef | undefined;
}

/** The status-bar line after a copy or cut (§3f), shown for 5 s. */
export function clipboardStatus(cut: boolean, file: string, repo: string): string {
  return cut
    ? `Cut ${file} (${repo}). Now click another repo: its window comes up and the cut waits on the clipboard (Pitwall keeps one clipboard across all its windows). Right-click in FILES → Paste, or press Ctrl+V.`
    : `Copied ${file} (${repo}). Now click another repo: its window comes up and the copy waits on the clipboard (Pitwall keeps one clipboard across all its windows). Right-click in FILES → Paste, or press Ctrl+V.`;
}

const CLIPBOARD_STATUS_MS = 5000;

/** Resolve a user-entered name, refusing anything that is not one segment. */
function validateName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) {
    return 'Name is required';
  }
  if (trimmed === '.' || trimmed === '..') {
    return 'Invalid name';
  }
  if (/[\\/]/.test(trimmed) || trimmed.includes('\0')) {
    return 'Name cannot contain path separators';
  }
  return undefined;
}

/** Create an empty file or folder through the shared guard/refresh flow. */
async function createEntry(
  filesProvider: FilesTreeProvider,
  kind: 'file' | 'folder',
  item?: FileTreeItem
): Promise<void> {
  const worktree = filesProvider.getActiveWorktree();
  if (!worktree) { return; }
  // A file row is not a parent: create beside it, in its folder.
  const parentPath = item
    ? ((item.fileType & vscode.FileType.Directory) !== 0 ? item.uri.fsPath : path.dirname(item.uri.fsPath))
    : worktree.path;
  if (!isWithin(parentPath, worktree.path)) {
    vscode.window.showErrorMessage(`Refusing to create a ${kind} outside the active worktree.`);
    logOperation(`Refused new ${kind} outside worktree: ${parentPath}`);
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: kind === 'file' ? 'File name' : 'Folder name',
    validateInput: validateName,
  });
  if (!name) { return; }

  const newUri = vscode.Uri.joinPath(vscode.Uri.file(parentPath), name);
  try {
    if (kind === 'folder') {
      await vscode.workspace.fs.createDirectory(newUri);
      logOperation(`Created folder: ${path.relative(worktree.path, newUri.fsPath)}`);
    } else {
      // writeFile truncates, so never touch an existing path.
      const exists = await vscode.workspace.fs.stat(newUri).then(
        () => true,
        () => false
      );
      if (exists) {
        vscode.window.showErrorMessage(`"${name}" already exists.`);
        logOperation(`Refused to overwrite existing file: ${newUri.fsPath}`);
        return;
      }
      await vscode.workspace.fs.writeFile(newUri, new Uint8Array());
      logOperation(`Created file: ${path.relative(worktree.path, newUri.fsPath)}`);
      filesProvider.refresh();
      vscode.commands.executeCommand('vscode.open', newUri);
      return;
    }
    filesProvider.refresh();
  } catch (err) {
    logOperation(`Create ${kind} failed: ${newUri.fsPath} (${String(err)})`);
    vscode.window.showErrorMessage(`Could not create ${kind}: ${err}`);
  }
}

export function registerFileCommands(
  context: vscode.ExtensionContext,
  filesProvider: FilesTreeProvider,
  /** The row selected in the All Files tree; a keybinding acts on it. */
  selectedRow: () => FileTreeItem | undefined,
  deps: FileCommandDeps = {}
): void {
  const clipboard = deps.clipboard ?? new SharedClipboard(undefined);
  const repos = deps.repos ?? (() => []);
  const repoOf = deps.repoOf ?? (() => undefined);
  /** The name of the repo holding `filePath`; outside every sidebar repo, its folder's name. */
  const repoNameOf = (filePath: string, fallbackFolder = path.dirname(filePath)): string =>
    repoOf(filePath)?.name ?? path.basename(fallbackFolder);
  // Paste is offered while anything is on the clipboard, in any window.
  const syncClipboardContext = () =>
    void clipboard
      .get()
      .then((entry) => vscode.commands.executeCommand('setContext', 'pitwall.hasFileClipboard', entry !== undefined));
  context.subscriptions.push(clipboard.onDidChange(syncClipboardContext));

  const putOnClipboard = async (item: FileTreeItem, cut: boolean): Promise<void> => {
    const root = filesProvider.getActiveWorktree()?.path;
    await clipboard.set(item.uri.fsPath, cut);
    const file = path.basename(item.uri.fsPath);
    vscode.window.setStatusBarMessage(clipboardStatus(cut, file, repoNameOf(item.uri.fsPath, root)), CLIPBOARD_STATUS_MS);
  };

  /** A command on a row: the clicked one, or the selected one for a keybinding. */
  const onRow = (id: string, handler: (item: FileTreeItem) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, (item?: FileTreeItem) => {
      const target = item ?? selectedRow();
      return target ? handler(target) : undefined;
    });

  context.subscriptions.push(
    vscode.commands.registerCommand('pitwall.files.search', () => {
      const worktree = filesProvider.getActiveWorktree();
      if (!worktree) { return; }
      vscode.commands.executeCommand('workbench.action.findInFiles', {
        filesToInclude: worktree.path,
      });
    }),

    vscode.commands.registerCommand('pitwall.files.refresh', () => {
      filesProvider.refresh();
    }),

    onRow('pitwall.files.openToSide', (item: FileTreeItem) => {
      vscode.commands.executeCommand('vscode.open', item.uri, vscode.ViewColumn.Beside);
    }),

    onRow('pitwall.files.revealInFinder', (item: FileTreeItem) => {
      vscode.commands.executeCommand('revealFileInOS', item.uri);
    }),

    onRow('pitwall.files.openInTerminal', (item: FileTreeItem) => {
      const isFolder = (item.fileType & vscode.FileType.Directory) !== 0;
      const cwd = isFolder ? item.uri.fsPath : path.dirname(item.uri.fsPath);
      vscode.window.createTerminal({ cwd }).show();
    }),

    onRow('pitwall.files.copyPath', (item: FileTreeItem) => {
      vscode.env.clipboard.writeText(item.uri.fsPath);
    }),

    onRow('pitwall.files.copyRelativePath', (item: FileTreeItem) => {
      const worktree = filesProvider.getActiveWorktree();
      if (!worktree) { return; }
      vscode.env.clipboard.writeText(path.relative(worktree.path, item.uri.fsPath));
    }),

    onRow('pitwall.files.rename', async (item: FileTreeItem) => {
      const worktree = filesProvider.getActiveWorktree();
      if (!worktree) { return; }
      if (!isStrictlyWithin(item.uri.fsPath, worktree.path)) {
        vscode.window.showErrorMessage('Refusing to rename a path outside the active worktree.');
        logOperation(`Refused rename outside worktree: ${item.uri.fsPath}`);
        return;
      }

      const oldName = path.basename(item.uri.fsPath);
      const isFolder = (item.fileType & vscode.FileType.Directory) !== 0;
      const dotIndex = oldName.lastIndexOf('.');
      const selectionEnd = (!isFolder && dotIndex > 0) ? dotIndex : oldName.length;

      const newName = await vscode.window.showInputBox({
        prompt: 'Enter new name',
        value: oldName,
        valueSelection: [0, selectionEnd],
        validateInput: validateName,
      });
      if (!newName || newName === oldName) { return; }

      const newUri = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(item.uri.fsPath)), newName);
      if (!isStrictlyWithin(newUri.fsPath, worktree.path)) {
        vscode.window.showErrorMessage('Refusing to rename to a path outside the active worktree.');
        logOperation(`Refused rename to outside worktree: ${newUri.fsPath}`);
        return;
      }

      try {
        await vscode.workspace.fs.rename(item.uri, newUri, { overwrite: false });
        logOperation(
          `Renamed ${path.relative(worktree.path, item.uri.fsPath)} -> ${newName}`
        );
        filesProvider.refresh();
      } catch (err) {
        logOperation(`Rename failed for ${item.uri.fsPath}: ${String(err)}`);
        vscode.window.showErrorMessage(`Rename failed: ${err}`);
      }
    }),

    onRow('pitwall.files.delete', async (item: FileTreeItem) => {
      const worktree = filesProvider.getActiveWorktree();
      if (!worktree) { return; }
      if (!isStrictlyWithin(item.uri.fsPath, worktree.path)) {
        vscode.window.showErrorMessage('Refusing to delete a path outside the active worktree.');
        logOperation(`Refused delete outside worktree: ${item.uri.fsPath}`);
        return;
      }

      const isFolder = (item.fileType & vscode.FileType.Directory) !== 0;
      const relativePath = path.relative(worktree.path, item.uri.fsPath);
      const answer = await vscode.window.showWarningMessage(
        `Move ${isFolder ? 'folder' : 'file'} "${relativePath}" to the Trash?`,
        { modal: true },
        'Move to Trash'
      );
      if (answer !== 'Move to Trash') { return; }
      try {
        await vscode.workspace.fs.delete(item.uri, { recursive: isFolder, useTrash: true });
        logOperation(`Moved to Trash: ${relativePath}`);
        filesProvider.refresh();
      } catch (err) {
        logOperation(`Delete failed for ${relativePath}: ${String(err)}`);
        vscode.window.showErrorMessage(`Delete failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand('pitwall.files.newFile', (item?: FileTreeItem) =>
      createEntry(filesProvider, 'file', item)
    ),

    vscode.commands.registerCommand('pitwall.files.newFolder', (item?: FileTreeItem) =>
      createEntry(filesProvider, 'folder', item)
    ),

    onRow('pitwall.files.copy', (item: FileTreeItem) => putOnClipboard(item, false)),

    onRow('pitwall.files.cut', (item: FileTreeItem) => putOnClipboard(item, true)),

    // Paste lands in this window's folder (Q8), whichever window copied or cut (Q9).
    vscode.commands.registerCommand('pitwall.files.paste', async (clicked?: FileTreeItem) => {
      const item = clicked ?? selectedRow();
      const entry = await clipboard.get();
      if (!entry) { return; }

      const root = filesProvider.getActiveWorktree()?.path;
      if (!root) { return; }

      // Resolve target directory: folder item → that folder, file item → its parent, no item → the window's folder
      const targetDir = item
        ? ((item.fileType & vscode.FileType.Directory) !== 0
            ? item.uri.fsPath
            : path.dirname(item.uri.fsPath))
        : root;

      const sourcePath = path.resolve(entry.path);
      const sourceUri = vscode.Uri.file(sourcePath);
      let sourceIsFolder = false;
      try {
        sourceIsFolder =
          ((await vscode.workspace.fs.stat(sourceUri)).type & vscode.FileType.Directory) !== 0;
      } catch {
        vscode.window.showWarningMessage('The item to paste no longer exists.');
        logOperation(`Paste source missing: ${sourcePath}`);
        await clipboard.clear();
        return;
      }

      // A folder cannot be pasted into itself or one of its descendants;
      // that would recurse forever or delete the source mid-copy.
      if (sourceIsFolder && isWithin(targetDir, sourcePath)) {
        vscode.window.showErrorMessage('Cannot paste a folder into itself.');
        logOperation(`Refused paste of ${sourcePath} into its own subtree: ${targetDir}`);
        return;
      }

      // Cutting into the same folder is a no-op, not a rename to "<name> copy".
      if (
        entry.cut &&
        samePath(path.dirname(sourcePath), targetDir)
      ) {
        vscode.window.showInformationMessage('The item is already in this folder.');
        return;
      }

      const name = path.basename(sourcePath);
      const fromRepo = repoNameOf(sourcePath);
      const dest = await uniqueDest(targetDir, name);
      const destUri = vscode.Uri.file(dest);
      try {
        if (entry.cut) {
          await vscode.workspace.fs.rename(sourceUri, destUri, { overwrite: false });
          await clipboard.clear();
          logOperation(`Moved ${sourcePath} -> ${dest}`);
        } else {
          await vscode.workspace.fs.copy(sourceUri, destUri, { overwrite: false });
          logOperation(`Copied ${sourcePath} -> ${dest}`);
        }
        filesProvider.refresh();
      } catch (err) {
        logOperation(`Paste failed: ${sourcePath} -> ${dest} (${String(err)})`);
        vscode.window.showErrorMessage(`Paste failed: ${err}`);
        return;
      }
      const winName = repoNameOf(root, root);
      vscode.window.showInformationMessage(
        landedMessage(entry.cut ? 'Moved' : 'Pasted', name, fromRepo, winName, targetDir, dest)
      );
      if (!sourceIsFolder) {
        await offerGitignore({ name: winName, rootPath: root }, name, dest);
      }
    }),

    // Copy to another repo (Pitwall): a quick pick of the other sidebar repos;
    // the file lands in the chosen repo's root (Q10).
    onRow('pitwall.files.copyToRepo', async (item: FileTreeItem) => {
      if ((item.fileType & vscode.FileType.Directory) !== 0) { return; }
      const src = item.uri.fsPath;
      const file = path.basename(src);
      const from = repoOf(src);
      const others = repos().filter((repo) => !(from && samePath(repo.rootPath, from.rootPath)) && !isWithin(src, repo.rootPath));
      const picked = await vscode.window.showQuickPick(
        others.map((repo) => ({ label: repo.name, detail: repo.rootPath, repo })),
        { placeHolder: `Copy ${file} to which repo?` }
      );
      if (!picked) { return; }
      await copyIntoRepo(picked.repo, src, from?.name ?? repoNameOf(src, filesProvider.getActiveWorktree()?.path));
    })
  );
}
