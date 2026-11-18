import * as path from 'path';
import * as vscode from 'vscode';
import { FILES_MIME } from '../providers/FilesTreeProvider';
import { isWithin, samePath } from '../utils/paths';
import type { WorkspaceTreeItem } from '../providers/WorkspacesTreeProvider';
import { RepoRef, copyIntoRepo } from './copyInto';

/** The dragged paths: our own list of strings, or the tree's FILES rows. */
async function draggedPaths(item: vscode.DataTransferItem | undefined): Promise<string[]> {
  if (!item) {
    return [];
  }
  let value: unknown = item.value;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry : (entry as { uri?: { fsPath?: unknown } })?.uri?.fsPath))
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/**
 * Drops of FILES rows on a repo row copy each file into that repo's root
 * (row 4.7). Only FILES' own mime is accepted, never Explorer's
 * `text/uri-list` (Q20). The repo list itself drags nothing.
 */
export class RepoDropController implements vscode.TreeDragAndDropController<WorkspaceTreeItem> {
  readonly dropMimeTypes = [FILES_MIME];
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
    for (const src of await draggedPaths(dataTransfer.get(FILES_MIME))) {
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
