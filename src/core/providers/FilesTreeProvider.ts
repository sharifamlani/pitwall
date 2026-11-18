import * as vscode from 'vscode';
import * as path from 'path';
import { Worktree } from '../types';

const HIDDEN_NAMES = new Set(['.git', 'node_modules', '.DS_Store', '.next', 'dist', 'out', '.turbo']);

export class FileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly fileType: vscode.FileType,
    rootPath: string
  ) {
    const isDirectory = (fileType & vscode.FileType.Directory) !== 0;
    super(
      path.basename(uri.fsPath),
      isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    this.resourceUri = uri;
    // Stable id so file-watcher refreshes keep selection and expansion state.
    this.id = `file:${uri.fsPath}`;
    this.tooltip = path.relative(rootPath, uri.fsPath) || path.basename(uri.fsPath);
    this.contextValue = isDirectory ? 'folder' : 'file';
    if (!isDirectory) {
      this.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [uri],
      };
    }
  }
}

/**
 * The drag mime of FILES rows: their paths, as a JSON list. A repo row
 * accepts it and FILES' own tree mime only, never Explorer's `text/uri-list`
 * (Q20). It is Pitwall's own, not the tree's: across two views the workbench
 * puts the dragged rows' handles under the tree's mime ahead of anything the
 * extension put there, so paths set under it never arrived (live I4).
 */
export const FILES_MIME = 'application/vnd.pitwall.files';
/** The mime the workbench gives FILES rows' drags itself: `{ id, itemHandles }`, each handle `1/<the row's id>`. */
export const FILES_TREE_MIME = 'application/vnd.code.tree.pitwall.filesview';
/** The FILES view's id, as a tree drag names its source. */
export const FILES_VIEW_ID = 'pitwall.filesView';

/** The FILES banner while something is on the clipboard (§3e, canvas line 94). */
export function clipboardBanner(file: string, repo: string): string {
  return `On the clipboard: ${file} from ${repo}. Right-click → Paste, or Ctrl+V, in any repo.`;
}

/**
 * Drags FILES rows onto a repo row (row 4.7). Only file rows are carried, as
 * their paths; FILES itself accepts no drops.
 */
export class FilesDragController implements vscode.TreeDragAndDropController<vscode.TreeItem> {
  readonly dragMimeTypes = [FILES_MIME];
  readonly dropMimeTypes: string[] = [];

  handleDrag(source: readonly vscode.TreeItem[], dataTransfer: vscode.DataTransfer, _token?: vscode.CancellationToken): void {
    const paths = source
      .filter((item): item is FileTreeItem => item instanceof FileTreeItem && (item.fileType & vscode.FileType.Directory) === 0)
      .map((item) => item.uri.fsPath);
    if (paths.length > 0) {
      // A string: it crosses to the other view's drop unchanged.
      dataTransfer.set(FILES_MIME, new vscode.DataTransferItem(JSON.stringify(paths)));
    }
  }
}

/**
 * The All Files view: this window's folder (Q8), without build output and VCS
 * metadata. The extension refreshes it when the folder's files change.
 */
export class FilesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private activeWorktree: Worktree | undefined;

  /** Point FILES at this window's folder (Q8); undefined in an empty window. */
  setActiveWorktree(worktree: Worktree | undefined): void {
    this.activeWorktree = worktree;
    this.refresh();
  }

  getActiveWorktree(): Worktree | undefined {
    return this.activeWorktree;
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!this.activeWorktree) {
      // An empty window: no rows, so the view shows its welcome text.
      return [];
    }

    const rootPath = this.activeWorktree.path;
    const dirUri =
      element instanceof FileTreeItem ? element.uri : vscode.Uri.file(rootPath);

    try {
      const entries = await vscode.workspace.fs.readDirectory(dirUri);

      const filtered = entries.filter(([name]) => !HIDDEN_NAMES.has(name));
      // Directories first, then files — each group sorted naturally, so
      // `file2` comes before `file10` and case does not decide the order.
      filtered.sort(([nameA, typeA], [nameB, typeB]) => {
        const isDirA = (typeA & vscode.FileType.Directory) !== 0;
        const isDirB = (typeB & vscode.FileType.Directory) !== 0;
        if (isDirA !== isDirB) {
          return isDirA ? -1 : 1;
        }
        return nameA.localeCompare(nameB, undefined, {
          sensitivity: 'base',
          numeric: true,
        });
      });

      return filtered.map(([name, type]) =>
        new FileTreeItem(vscode.Uri.joinPath(dirUri, name), type, rootPath)
      );
    } catch {
      return [];
    }
  }
}
