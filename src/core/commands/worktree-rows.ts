import * as vscode from 'vscode';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from '../providers/WorkspacesTreeProvider';
import { commandRegistrar } from './common';

export interface WorktreeRowCommandDeps {
  workspacesProvider: Pick<WorkspacesTreeProvider, 'getWorktreeForItem'>;
  switchWorkspaceFolder: (folderPath: string) => void;
}

/**
 * The small actions on a worktree row: open in a new window, copy the path,
 * open a terminal there, and switch the window to it. Split out of
 * worktree.ts when ROADMAP row 3.6 parked the worktree create/delete/merge/rebase
 * commands (ruling P9); these four stay live.
 */
export function registerWorktreeRowCommands(context: vscode.ExtensionContext, deps: WorktreeRowCommandDeps): void {
  const { workspacesProvider } = deps;
  const register = commandRegistrar(context);

  register('pitwall.openInNewWindow', async (item?: WorkspaceTreeItem) => {
    const worktree = workspacesProvider.getWorktreeForItem(item);
    if (worktree) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktree.path), {
        forceNewWindow: true,
      });
    }
  });

  register('pitwall.copyWorktreePath', async (item?: WorkspaceTreeItem) => {
    const worktree = workspacesProvider.getWorktreeForItem(item);
    if (worktree) {
      await vscode.env.clipboard.writeText(worktree.path);
      vscode.window.showInformationMessage(`Copied path: ${worktree.path}`);
    }
  });

  register('pitwall.openTerminalAtWorktree', (item?: WorkspaceTreeItem) => {
    const worktree = workspacesProvider.getWorktreeForItem(item);
    if (worktree) {
      const terminal = vscode.window.createTerminal({ name: `Terminal: ${worktree.name}`, cwd: worktree.path });
      terminal.show();
    }
  });

  register('pitwall.switchToWorkspace', (item?: WorkspaceTreeItem) => {
    const worktree = workspacesProvider.getWorktreeForItem(item);
    if (worktree) {
      deps.switchWorkspaceFolder(worktree.path);
    }
  });
}
