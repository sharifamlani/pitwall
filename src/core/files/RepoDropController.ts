import * as path from 'path';
import * as vscode from 'vscode';
import { FILES_MIME, FILES_TREE_MIME, FILES_VIEW_ID } from '../providers/FilesTreeProvider';
import { logOperation } from '../services/OperationLog';
import { isWithin, samePath } from '../utils/paths';
import type { WorkspaceTreeItem } from '../providers/WorkspacesTreeProvider';
import { RepoRef, copyIntoRepo } from './copyInto';

/** A FILES row's tree handle (`1/file:<path>`, its id under the handle prefix) back to its path. */
const ROW_HANDLE = /^\d+\/file:(.+)$/;

/** An item's value, parsed when it arrived as a JSON string. */
function parsed(item: vscode.DataTransferItem | undefined): unknown {
  let value: unknown = item?.value;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value;
}

/** Paths from a list of paths, FILES rows, or FILES row handles; anything else is dropped. */
function pathsIn(list: unknown): string[] {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((entry) => (typeof entry === 'string' ? entry : (entry as { uri?: { fsPath?: unknown } })?.uri?.fsPath))
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .map((entry) => ROW_HANDLE.exec(entry)?.[1] ?? entry)
    .filter((entry) => path.isAbsolute(entry));
}

/**
 * The dragged paths: FILES' own list, else the FILES tree's drag (the
 * workbench's `{ id, itemHandles }`, or the rows themselves within the
 * view). A drag from another tree carries nothing.
 */
function draggedPaths(dataTransfer: vscode.DataTransfer): string[] {
  const own = pathsIn(parsed(dataTransfer.get(FILES_MIME)));
  if (own.length > 0) {
    return own;
  }
  const tree = parsed(dataTransfer.get(FILES_TREE_MIME));
  if (Array.isArray(tree)) {
    return pathsIn(tree);
  }
  const source = tree as { id?: unknown; itemHandles?: unknown } | undefined;
  return typeof source?.id === 'string' && source.id.toLowerCase() === FILES_VIEW_ID.toLowerCase() ? pathsIn(source.itemHandles) : [];
}

/**
 * Drops of FILES rows on a repo row copy each file into that repo's root
 * (row 4.7). Only FILES' own mimes are accepted, never Explorer's
 * `text/uri-list` (Q20). The repo list itself drags nothing.
 */
export class RepoDropController implements vscode.TreeDragAndDropController<WorkspaceTreeItem> {
  readonly dropMimeTypes = [FILES_MIME, FILES_TREE_MIME];
  readonly dragMimeTypes: string[] = [];

  constructor(
    private readonly repoOf: (filePath: string) => RepoRef | undefined,
    /** The deepest sidebar root (main folder or worktree) holding a path. */
    private readonly deepestRootOf: (filePath: string) => string | undefined = (filePath) => repoOf(filePath)?.rootPath
  ) {}

  async handleDrop(
    target: WorkspaceTreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
    _token?: vscode.CancellationToken
  ): Promise<void> {
    if (target?.itemType !== 'repository') {
      return;
    }
    const repo = target.data as RepoRef;
    const dragged = draggedPaths(dataTransfer);
    logOperation(`[Pitwall] drop on ${repo.name}: ${dragged.length} file(s)`);
    for (const src of dragged) {
      const from = this.repoOf(src);
      // Q25: "already there" only when the file sits in the repo's main
      // folder itself; a file from one of its worktrees is another folder,
      // so it is copied into the main folder like any other drop.
      const root = this.deepestRootOf(src) ?? (isWithin(src, repo.rootPath) ? repo.rootPath : undefined);
      if (root !== undefined && samePath(root, repo.rootPath)) {
        vscode.window.showInformationMessage(`That file is already in ${repo.name}. Drop it on a different repo to copy it there.`);
        continue;
      }
      await copyIntoRepo({ name: repo.name, rootPath: repo.rootPath }, src, from?.name ?? path.basename(path.dirname(src)));
    }
  }
}
