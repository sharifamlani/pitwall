import * as vscode from 'vscode';
import { ChatSession, Repository } from '../types';
import { FileTreeItem } from '../providers/FilesTreeProvider';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from '../providers/WorkspacesTreeProvider';
import { commandRegistrar } from './common';

export interface NavigationDeps {
  workspacesProvider: Pick<WorkspacesTreeProvider, 'repoRowAt' | 'chatRowsOf' | 'getWorktreeById' | 'repositoryFor'>;
  workspacesTreeView: Pick<vscode.TreeView<WorkspaceTreeItem>, 'selection' | 'reveal' | 'onDidChangeSelection'>;
  filesTreeView: Pick<vscode.TreeView<FileTreeItem>, 'visible'>;
}

/** How long a keyboard move waits for the list to report the row it landed on. */
const LANDING_TIMEOUT_MS = 500;

/** Gives the Pitwall list keyboard focus. */
const FOCUS_LIST = 'pitwall.workspacesView.focus';
/** A chat opened by a list key may take focus a moment after the select returns. */
const REFOCUS_DELAY_MS = 300;

/** Reveal, expand, select and focus a row. */
const REVEAL_ROW = { select: true, focus: true, expand: true } as const;

/**
 * The global hotkeys and the list keyboard (rows 3.7, 3.8). Ctrl+Alt+1–9 and a
 * repo pick jump to the nth repo in inbox order and, pressed again, open its
 * next chat (P11); Ctrl+Alt+Shift+1–9 and Ctrl+Alt+O open a repo's folder in a
 * window of its own (P12); Ctrl+↓/↑ move through the list and open the row
 * they land on (P20).
 */
export function registerNavigationCommands(context: vscode.ExtensionContext, deps: NavigationDeps): void {
  const { workspacesProvider, workspacesTreeView, filesTreeView } = deps;
  const register = commandRegistrar(context);
  const run = (command: string, ...args: unknown[]) => vscode.commands.executeCommand(command, ...args);

  /** The repo a row belongs to: a repo row itself, a session row's repo. */
  const repoOfRow = (row: WorkspaceTreeItem | undefined): Repository | undefined => {
    if (row?.itemType === 'repository') {
      return row.data as Repository;
    }
    if (row?.itemType === 'chat') {
      const worktree = workspacesProvider.getWorktreeById((row.data as ChatSession).worktreeId);
      return worktree && workspacesProvider.repositoryFor(worktree)?.repo;
    }
    return undefined;
  };

  /** The chat each repo's key last opened, so repeating the key walks its sessions. */
  const lastOpened = new Map<string, string>();

  /** Reveal a repo row; pressed again on the repo it already shows, open its next chat. */
  const goToRepoRow = async (row: WorkspaceTreeItem | undefined): Promise<void> => {
    const repo = repoOfRow(row);
    if (!row || !repo) {
      return;
    }
    const [selected] = workspacesTreeView.selection;
    if (repoOfRow(selected)?.id !== repo.id) {
      await workspacesTreeView.reveal(row, REVEAL_ROW);
      return;
    }
    // Pressed again on the repo it already shows: open its next chat.
    const chats = workspacesProvider.chatRowsOf(repo);
    if (chats.length === 0) {
      return;
    }
    const current = selected.itemType === 'chat' ? (selected.data as ChatSession).id : lastOpened.get(repo.id);
    const at = chats.findIndex((chat) => (chat.data as ChatSession).id === current);
    const next = chats[(at + 1) % chats.length];
    lastOpened.set(repo.id, (next.data as ChatSession).id);
    await run('pitwall.openChat', next);
  };

  const goToRepo = (position: number) => () => goToRepoRow(workspacesProvider.repoRowAt(position));

  // Internal: the search box's repo pick behaves exactly like the hotkey (row 3.9).
  register('pitwall.goToRepoRow', goToRepoRow);

  const openWindow = async (repo: Repository | undefined): Promise<void> => {
    if (repo) {
      await run('vscode.openFolder', vscode.Uri.file(repo.rootPath), { forceNewWindow: true });
    }
  };

  for (let position = 1; position <= 9; position++) {
    register(`pitwall.goToRepo${position}`, goToRepo(position));
    register(`pitwall.openRepoWindow${position}`, () => openWindow(repoOfRow(workspacesProvider.repoRowAt(position))));
  }

  register('pitwall.openCurrentRepoWindow', async () => {
    const repo = repoOfRow(workspacesTreeView.selection[0]);
    if (!repo) {
      vscode.window.showInformationMessage('Select a repo or a session in Pitwall first.');
      return;
    }
    await openWindow(repo);
  });

  // Ctrl+Alt+0 and its older alias Ctrl+Alt+N (P10).
  register('pitwall.openLongestWaiting', () => run('pitwall.openNextSessionNeedingYou'));

  // FILES: a visible panel is hidden through the view's own Hide action; a
  // hidden one is shown by focusing it, which also opens a closed sidebar.
  register('pitwall.toggleFiles', () =>
    run(filesTreeView.visible ? 'pitwall.filesView.removeView' : 'pitwall.filesView.focus')
  );

  /**
   * Move the list focus one row and select it. The workbench's select opens a
   * session row through its own click command; a repo row has none, so it is
   * expanded and selected here (P20).
   */
  const moveAndOpen = (move: 'list.focusDown' | 'list.focusUp') => async (): Promise<void> => {
    let subscription: vscode.Disposable | undefined;
    let timer: NodeJS.Timeout | undefined;
    const landed = new Promise<WorkspaceTreeItem | undefined>((resolve) => {
      subscription = workspacesTreeView.onDidChangeSelection((event) => resolve(event.selection[0]));
      timer = setTimeout(() => resolve(undefined), LANDING_TIMEOUT_MS);
    });
    try {
      await run(move);
      await run('list.select');
      const row = await landed;
      if (row?.itemType === 'repository') {
        await workspacesTreeView.reveal(row, REVEAL_ROW);
      } else if (row) {
        // Opening a chat moves keyboard focus into it; the next Ctrl+↓ has to
        // reach the list again (D37). The open may finish after select
        // returns, so focus is taken back once more shortly after.
        await run(FOCUS_LIST);
        const again = setTimeout(() => void run(FOCUS_LIST), REFOCUS_DELAY_MS);
        again.unref?.();
      }
    } finally {
      subscription?.dispose();
      clearTimeout(timer);
    }
  };
  register('pitwall.list.moveDownAndOpen', moveAndOpen('list.focusDown'));
  register('pitwall.list.moveUpAndOpen', moveAndOpen('list.focusUp'));
}
