import * as vscode from 'vscode';
import { ChatSession, Repository } from '../types';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from '../providers/WorkspacesTreeProvider';
import { commandRegistrar } from './common';

export interface SearchDeps {
  workspacesProvider: Pick<WorkspacesTreeProvider, 'repoRowAt' | 'sessionRowsOfRepoRow'>;
  /**
   * Whether picking this chat opens it in this window; its meta then ends
   * "· this window", otherwise "· its own window" (row 4.8). Without it, no
   * window is named.
   */
  opensHere?: (chat: ChatSession) => boolean;
}

const PLACEHOLDER = 'Search repos, chats, and what was said in them  (Ctrl+Alt+R)';
const FOOTER_LABEL = "$(sparkle) Can't find it? Describe it and let an agent search your chats";
const FOOTER_DESCRIPTION = "Agntree's Find Session";

type SearchPick = vscode.QuickPickItem & { action?: () => Thenable<unknown> | void };

const separator = (label: string): SearchPick => ({ label, kind: vscode.QuickPickItemKind.Separator });
/** A row that only closes the box: a group's "nothing here" line. */
const note = (label: string): SearchPick => ({ label, alwaysShow: true });

/** The row's description names its branch as "⎇ branch"; a detached or plain-folder row has none. */
const branchOf = (row: WorkspaceTreeItem): string => /⎇\s*(\S+)/.exec(String(row.description ?? ''))?.[1] ?? '';

const matches = (query: string, ...fields: string[]): boolean => {
  const needle = query.trim().toLowerCase();
  return !needle || fields.some((field) => field.toLowerCase().includes(needle));
};

/**
 * The search box (row 3.9, §3e): Ctrl+Alt+R opens one quick pick over the
 * repos and chats in inbox order. A repo pick behaves like its hotkey, a chat
 * pick opens the chat, and the footer hands the typed text to Find Session.
 * The box filters itself so each group can say "No … matches.".
 */
export function registerSearchCommands(context: vscode.ExtensionContext, deps: SearchDeps): void {
  const { workspacesProvider, opensHere } = deps;
  /** "· this window" or "· its own window": where picking the chat opens it. */
  const windowMeta = (chat: ChatSession): string =>
    opensHere ? (opensHere(chat) ? ' · this window' : ' · its own window') : '';
  const register = commandRegistrar(context);
  const run = (command: string, ...args: unknown[]) => vscode.commands.executeCommand(command, ...args);

  const repoRows = (): WorkspaceTreeItem[] => {
    const rows: WorkspaceTreeItem[] = [];
    for (let position = 1; ; position++) {
      const row = workspacesProvider.repoRowAt(position);
      if (!row) {
        return rows;
      }
      rows.push(row);
    }
  };

  /** Every repo row with its session rows, as the list shows them now. */
  const snapshot = async (): Promise<{ repoRow: WorkspaceTreeItem; chatRows: WorkspaceTreeItem[] }[]> =>
    Promise.all(
      repoRows().map(async (repoRow) => ({
        repoRow,
        chatRows: (await workspacesProvider.sessionRowsOfRepoRow(repoRow)).filter((row) => row.itemType === 'chat'),
      }))
    );

  const build = (rows: Awaited<ReturnType<typeof snapshot>>, query: string): SearchPick[] => {
    const repoPicks: SearchPick[] = [];
    const chatPicks: SearchPick[] = [];
    for (const { repoRow, chatRows } of rows) {
      const repo = repoRow.data as Repository;
      if (matches(query, repo.name)) {
        repoPicks.push({
          label: repo.name,
          description: `${chatRows.length} ${chatRows.length === 1 ? 'session' : 'sessions'}`,
          alwaysShow: true,
          action: () => run('pitwall.goToRepoRow', repoRow),
        });
      }
      for (const chatRow of chatRows) {
        const name = String(chatRow.label);
        if (matches(query, name, branchOf(chatRow))) {
          chatPicks.push({
            label: name,
            description: `${repo.name} · ${chatRow.description ?? ''}`.trim() + windowMeta(chatRow.data as ChatSession),
            alwaysShow: true,
            action: () => run('pitwall.openChat', chatRow),
          });
        }
      }
    }
    return [
      separator('REPOS'),
      ...(repoPicks.length > 0 ? repoPicks : [note('No repo matches.')]),
      separator('CHATS · by name or branch'),
      ...(chatPicks.length > 0 ? chatPicks : [note('No chat name matches.')]),
      separator('INSIDE CHATS'),
      note('later: instant text search (roadmap)'),
      separator(''),
      {
        label: FOOTER_LABEL,
        description: FOOTER_DESCRIPTION,
        alwaysShow: true,
        action: () => run('pitwall.findSession', query),
      },
    ];
  };

  register('pitwall.search', async () => {
    const rows = await snapshot();
    const pick = vscode.window.createQuickPick<SearchPick>();
    pick.placeholder = PLACEHOLDER;
    pick.matchOnDescription = true;
    // The box orders and filters itself; VS Code's own sort drops the separators.
    (pick as vscode.QuickPick<SearchPick> & { sortByLabel?: boolean }).sortByLabel = false;
    /** Show the rows and make Enter pick the first real result, never a note. */
    const show = (query: string) => {
      pick.items = build(rows, query);
      const first = pick.items.find((item) => item.action);
      pick.activeItems = first ? [first] : [];
    };
    show('');
    const listeners = [
      pick.onDidChangeValue(show),
      pick.onDidAccept(() => {
        const [chosen] = pick.selectedItems.length > 0 ? pick.selectedItems : pick.activeItems;
        const action = chosen?.action;
        pick.hide();
        if (action) {
          void action();
        }
      }),
      pick.onDidHide(() => {
        listeners.forEach((listener) => listener.dispose());
        pick.dispose();
      }),
    ];
    pick.show();
  });
}
