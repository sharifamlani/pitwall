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
