import * as vscode from 'vscode';

/** The repo menu's item, and the button of the "couldn't reach" warning (I2). */
export const OPEN_ITS_WINDOW = 'Open its window';

/**
 * Bring a folder's window forward, or open one when none exists (S1). The
 * one call the repo menu's "Open its window" and the router's handoff both
 * make, so the two can never drift apart (live I2).
 */
export function raiseFolderWindow(folder: string): Thenable<unknown> {
  return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });
}

/**
 * Bring this window forward after a pop-up click it handled (v0.6.0): the
 * handoff's own call on this window's folder. Only for a window showing
 * exactly one folder and no workspace file; from any other window openFolder
 * would open a new window rather than raise this one, so nothing is done.
 */
export async function raiseThisWindow(
  workspace: { folders: readonly string[]; workspaceFile: string | undefined } = {
    folders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    workspaceFile: vscode.workspace.workspaceFile?.fsPath,
  }
): Promise<void> {
  if (workspace.folders.length === 1 && workspace.workspaceFile === undefined) {
    await raiseFolderWindow(workspace.folders[0]);
  }
}
