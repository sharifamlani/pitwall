import * as vscode from 'vscode';
import * as path from 'path';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { WorkspaceTreeItem } from '../providers/WorkspacesTreeProvider';
import { HarnessRegistry } from '../harness/HarnessRegistry';
import { HarnessSession } from '../harness/types';
import { harnessSessionKey, sessionDisplayName } from '../harness/sessionUtils';
import { ChatSession, HarnessId, Repository, Worktree } from '../types';
import { canonicalPath, canonicalRoot, nativePath, samePath } from '../utils/paths';
import { formatRelativeTime } from '../utils/text';
import { commandRegistrar, importNativeSession, withProgress } from './common';
import type { ChatRouter } from '../windows/ChatRouter';
import { DumpDeps, writeDump } from '../windows/dumpState';
import { raiseFolderWindow } from '../windows/raiseWindow';
import { consumeKeepListFocus } from './navigation';

/** A repo click opens at most this many of its chats at once; the rest are one pick away (Q18). */
export const REPO_CLICK_CAP = 8;

/**
 * When a session was last active: the value a chat's row shows as its age
 * (`meta.lastActivity`), so history and the row agree. The transcript's
 * modified time is only the fallback.
 */
function sessionAgeAt(session: HarnessSession | undefined): number | undefined {
  return session?.lastActivity ?? session?.lastUpdated?.getTime();
}

/** The sidebar group of the history pick covers this many days (§3f). */
const HISTORY_SIDEBAR_DAYS = 14;

export interface RepositoryCommandDeps {
  storageService: StorageService;
  gitService: GitService;
  harnessRegistry: HarnessRegistry;
  /**
   * Remove a forgotten root's chats and clear the panels if they show it.
   * Their terminals close unless `closeTerminals` is false.
   */
  forgetWorktrees: (worktrees: Worktree[], options?: { closeTerminals?: boolean }) => void;
  refreshTree: () => void;
  /** The chat router, once built: "+" starts the chat in that repo's window (row 4.2). */
  router?: () => Pick<ChatRouter, 'route'> | undefined;
  /** The repo's main-folder sidebar chats, newest first; worktree chats are not in it (Q5). */
  mainChats?: (repo: Repository) => ChatSession[];
  /** This window's folder: `workspaceFolders[0]`. */
  windowFolder?: () => string | undefined;
  /** Whether the chat's terminal or tab is open in this window. */
  isChatOpen?: (chat: ChatSession) => boolean;
  /** The repo's main-folder chats open in its window, newest first (the side by side set). */
  openChatsOf?: (repo: Repository) => Promise<ChatSession[]>;
  /** Where `pitwall.dev.dumpState` writes, and what it reads. */
  dump?: DumpDeps;
  /** `pitwall.dev.traceTabs`: toggle the tab tracker's trace; returns whether it is now on. */
  traceTabs?: () => boolean;
}

/** Workspace-root commands: add, clone, dismiss, remove, refresh. */
export function registerRepositoryCommands(context: vscode.ExtensionContext, deps: RepositoryCommandDeps): void {
  const { storageService, gitService, harnessRegistry, refreshTree } = deps;
  const register = commandRegistrar(context);

  const pickFolder = async (openLabel: string, title: string): Promise<string | undefined> =>
    (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel, title }))?.[0]
      ?.fsPath;

  register('pitwall.addRepository', async () => {
    const picked = await pickFolder('Add', 'Select a Folder or Git Repository');
    if (!picked) {
      return;
    }
    // The physical path, so a folder opened through a symlink gets the same
    // identity git reports after `git init`.
    const folderPath = canonicalPath(picked);
    // `--show-toplevel` resolves a subdirectory to its repository root and
    // answers null for a plain folder.
    const repoRoot = gitService.getRepoRoot(folderPath);
    // A bare repository or a `.git` directory has no files to edit.
    if (!repoRoot && gitService.isGitRepository(folderPath)) {
      vscode.window.showErrorMessage(
        'That folder is a git directory, not a working tree. Select the project folder instead.'
      );
      return;
    }
    // One spelling per root, git repository or plain folder.
    const rootPath = canonicalRoot(repoRoot ?? folderPath);
    // Adding a dismissed root by hand brings it back for good (P2).
    if (Object.keys(storageService.getDismissedRepos()).some((dismissed) => samePath(dismissed, rootPath))) {
      await storageService.setDismissed(rootPath, null);
    }
    const repo = storageService.addRepository(path.basename(rootPath), rootPath);
    vscode.window.showInformationMessage(repoRoot ? `Added repository: ${repo.name}` : `Added folder: ${repo.name}`);
    refreshTree();
  });

  /** The row's repository, or one picked from a list when run from the palette. */
  const repositoryFor = async (item: WorkspaceTreeItem | undefined, verb: string): Promise<Repository | undefined> => {
    if (item?.itemType === 'repository') {
      return item.data as Repository;
    }
    const repos = storageService.getRepositories();
    if (repos.length === 0) {
      vscode.window.showInformationMessage(`No repositories to ${verb}.`);
      return undefined;
    }
    return (
      await vscode.window.showQuickPick(
        repos.map((r) => ({ label: r.name, description: nativePath(r.rootPath), repo: r })),
        { placeHolder: `Choose a repo to ${verb}${verb === 'remove' || verb === 'dismiss' ? ' from Pitwall' : ''}` }
      )
    )?.repo;
  };

  /**
   * The repo row's "+" and its menu's first item: a Claude chat in the main
   * worktree, in that repo's window (§3 state summary). With the router, a
   * repo of this window starts here and any other is handed to its window;
   * a second click while that window starts sends nothing new (Q16).
   */
  register('pitwall.newSessionInRepository', async (item?: WorkspaceTreeItem) => {
    const repo = await repositoryFor(item, 'start a session in');
    if (!repo) {
      return;
    }
    const router = deps.router?.();
    if (router) {
      await router.route({ kind: 'new', chats: [], folder: repo.rootPath });
      return;
    }
    await vscode.commands.executeCommand('pitwall.newClaudeChat', repositoryRow(repo, item));
  });

  /**
   * A repo row's click and Enter (rows 4.3, 4.4; Q5, Q18, Q22): open the
   * repo's main-folder sidebar chats as tabs in its window, the 8 most recent
   * and then a quick pick for the rest. Worktree chats are not opened. With
   * all of them already open in this window it reveals only the last-open
   * tab. A Ctrl+↓/↑ that landed on the row left its marker, which is read
   * first: a keyboard walk only expands the row.
   */
  register('pitwall.openRepoChats', async (item?: WorkspaceTreeItem) => {
    if (consumeKeepListFocus()) {
      return;
    }
    const repo = await repositoryFor(item, 'open the chats of');
    const router = deps.router?.();
    if (!repo || !router || !deps.mainChats) {
      return;
    }
    const chats = deps.mainChats(repo);
    if (chats.length === 0) {
      return;
    }
    const here = deps.windowFolder?.();
    if (here && samePath(here, repo.rootPath) && chats.every((chat) => deps.isChatOpen?.(chat))) {
      await router.route({ kind: 'open', chats: [chats[0]] });
      return;
    }
    // Oldest first, so the newest tab opens last and is the one in front.
    const batch = chats.slice(0, REPO_CLICK_CAP);
    await router.route({ kind: 'openAll', chats: [...batch].reverse() });
    const rest = chats.slice(REPO_CLICK_CAP);
    if (rest.length === 0) {
      return;
    }
    // Only once the whole batch has opened, and kept open when a Claude tab
    // that finishes loading takes focus (live F3: it closed itself 0.8 s in).
    const label = `Open the other ${rest.length} ${rest.length === 1 ? 'chat' : 'chats'}`;
    const picked = await vscode.window.showQuickPick([{ label }], {
      placeHolder: `${repo.name}: opened its ${batch.length} most recent chats`,
      ignoreFocusOut: true,
    });
    if (picked) {
      await router.route({ kind: 'openAll', chats: [...rest].reverse() });
    }
  });

  /** "Show its open chats side by side" (Q14, Q15): the one tab move Pitwall makes, on request. */
  register('pitwall.showRepoChatsSideBySide', async (item?: WorkspaceTreeItem) => {
    const repo = await repositoryFor(item, 'show side by side');
    const router = deps.router?.();
    if (!repo || !router) {
      return;
    }
    const open = (await deps.openChatsOf?.(repo)) ?? [];
    if (open.length < 2) {
      return;
    }
    await router.route({ kind: 'sideBySide', chats: open });
  });

  /**
   * Hidden: while on, every raw tab and tab-group event and each bind or
   * release decision goes to the Pitwall Operations output, so a live walk
   * shows the real event order. Off by default; nothing is saved.
   */
  register('pitwall.dev.traceTabs', () => {
    if (!deps.traceTabs) {
      return;
    }
    const on = deps.traceTabs();
    void vscode.window.showInformationMessage(`Pitwall: tab trace ${on ? 'on' : 'off'} (output: Pitwall Operations)`);
  });

  /** Hidden: writes this window's tab and repo state for `scripts/dump-tabs.mjs`. */
  register('pitwall.dev.dumpState', async () => {
    if (!deps.dump || !deps.mainChats) {
      return undefined;
    }
    const mainChats = deps.mainChats;
    return writeDump(
      deps.dump,
      storageService.getRepositories().map((repo) => ({
        repo,
        sidebarMainChatIds: mainChats(repo).flatMap((chat) => (chat.harnessSessionId ? [chat.harnessSessionId] : [])),
      }))
    );
  });

  /**
   * "Open its window" / "Bring its window forward" (§3b): one label shows,
   * flipped by the row's hasWindow context value. Both raise the repo's main
   * folder: `vscode.openFolder` with forceNewWindow brings an existing window
   * forward and opens one only when none exists (S1). No toast (Q6).
   */
  const raiseWindow = async (item?: WorkspaceTreeItem): Promise<void> => {
    const repo = await repositoryFor(item, 'open the window of');
    if (repo) {
      await raiseFolderWindow(repo.rootPath);
    }
  };
  register('pitwall.openItsWindow', raiseWindow);
  register('pitwall.bringItsWindowForward', raiseWindow);

  // The hover icons carry their own ids so their tooltips (a command's title)
  // can differ from the right-click menu's wording; same behavior.
  register('pitwall.newSessionInRepositoryInline', (item?: WorkspaceTreeItem) =>
    vscode.commands.executeCommand('pitwall.newSessionInRepository', item)
  );
  register('pitwall.sessionHistoryInline', (item?: WorkspaceTreeItem) =>
    vscode.commands.executeCommand('pitwall.sessionHistory', item)
  );

  register('pitwall.copyRepositoryPath', async (item?: WorkspaceTreeItem) => {
    const repo = await repositoryFor(item, 'copy the path of');
    if (repo) {
      await vscode.env.clipboard.writeText(repo.rootPath);
      vscode.window.showInformationMessage(`Copied path: ${repo.rootPath}`);
    }
  });

  register('pitwall.revealRepository', async (item?: WorkspaceTreeItem) => {
    const repo = await repositoryFor(item, 'reveal');
    if (repo) {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(repo.rootPath));
    }
  });

  /**
   * Session history (§3f): this repo's chats that are in the sidebar, then
   * the agents' older sessions that are not. Picking an older one brings it
   * back as an idle row and opens it.
   */
  register('pitwall.sessionHistory', async (item?: WorkspaceTreeItem) => {
    const repo = await repositoryFor(item, 'browse the history of');
    if (!repo) {
      return;
    }
    const { isGit, worktrees } = gitService.listRepositoryWorktrees(repo.rootPath, repo.id);
    const main = worktrees.find((worktree) => worktree.isMain) ?? worktrees[0];
    if (!main) {
      return;
    }
    const native = await listRepositorySessions(harnessRegistry, repo.rootPath, worktrees);
    const nativeByKey = new Map(
      native.map((entry) => [harnessSessionKey(entry.harness, entry.session.sessionId), entry.session])
    );
    const chats = worktrees.flatMap((worktree) => storageService.getChatsByWorktree(worktree.id));
    const imported = new Set(
      chats.flatMap((chat) => (chat.harnessSessionId ? [harnessSessionKey(chat.harness, chat.harnessSessionId)] : []))
    );

    const branchPart = (branch: string | null | undefined) => (isGit && branch ? `⎇ ${branch} · ` : '');
    const inSidebar = chats
      .map((chat) => {
        const session = chat.harnessSessionId
          ? nativeByKey.get(harnessSessionKey(chat.harness, chat.harnessSessionId))
          : undefined;
        const worktree = worktrees.find((candidate) => candidate.id === chat.worktreeId) ?? main;
        return { chat, at: sessionAgeAt(session) ?? chat.lastAccessedAt, worktree };
      })
      .sort((a, b) => b.at - a.at);
    const chatRow = ({ chat, at, worktree }: (typeof inSidebar)[number]) => ({
      label: chat.name,
      description: `${branchPart(worktree.branch ?? worktree.name)}${formatRelativeTime(at, { short: true })}`,
      chat,
    });
    // Every chat in the sidebar is in the first group, whatever its age; this
    // group holds only sessions that are not in it, so its header stays true.
    const older = native
      .filter((entry) => !imported.has(harnessSessionKey(entry.harness, entry.session.sessionId)))
      .sort((a, b) => (sessionAgeAt(b.session) ?? 0) - (sessionAgeAt(a.session) ?? 0))
      .map(({ harness, session }) => ({
        label: sessionDisplayName(session),
        description: `${branchPart(session.gitBranch)}${sessionAgeAt(session) ? formatRelativeTime(sessionAgeAt(session)!, { short: true }) : ''}`,
        harness,
        session,
      }));

    const separator = (label: string) => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const picked = (await vscode.window.showQuickPick(
      [
        separator(`IN THE SIDEBAR (LAST ${HISTORY_SIDEBAR_DAYS} DAYS)`),
        ...(inSidebar.length > 0 ? inSidebar.map(chatRow) : [{ label: 'None.' }]),
        separator('OLDER · not in the sidebar; pick one to bring it back'),
        ...(older.length > 0 ? older : [{ label: 'No older chats.' }]),
      ],
      { placeHolder: `Filter ${repo.name}'s session history`, matchOnDescription: true }
    )) as { chat?: ChatSession; harness?: HarnessId; session?: HarnessSession } | undefined;

    let chat = picked?.chat;
    if (!chat && picked?.harness && picked.session) {
      const worktree = worktrees.find((candidate) => samePath(candidate.path, picked.session!.cwd)) ?? main;
      chat = importNativeSession(storageService, worktree, picked.harness, picked.session);
      refreshTree();
    }
    if (chat) {
      await vscode.commands.executeCommand(
        'pitwall.openChat',
        new WorkspaceTreeItem(chat.name, vscode.TreeItemCollapsibleState.None, 'chat', chat, 'chat')
      );
    }
  });

  /**
   * Dismiss from Pitwall (§3c, §3d): the repo and its rows leave the list and
   * discovery skips it until a session starts there after now, or it is added
   * by hand (P2). Nothing on disk changes and running terminals stay open.
   * Its chats go without tombstones, so they import again when it returns.
   */
  register('pitwall.dismissRepository', async (item?: WorkspaceTreeItem) => {
    const repo = await repositoryFor(item, 'dismiss');
    if (!repo) {
      return;
    }
    await storageService.setDismissed(repo.rootPath, Date.now());
    deps.forgetWorktrees(gitService.listRepositoryWorktrees(repo.rootPath, repo.id).worktrees, { closeTerminals: false });
    storageService.removeRepository(repo.id);
    vscode.window.showInformationMessage(
      `Dismissed ${repo.name} from Pitwall. Nothing changed on disk: the repo, its files and its chats are untouched. It comes back if you add it with the folder icon, or when a new Claude Code session starts in it.`
    );
    refreshTree();
  });

  register('pitwall.removeRepository', async (item?: WorkspaceTreeItem) => {
    const repo = await repositoryFor(item, 'remove');
    if (!repo) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Remove "${repo.name}" from Pitwall?\n\nIts session rows leave the list, losing custom names and stars, and their terminals close. Your files, git repository, and the agents' conversations are NOT deleted; Import Sessions can bring the sessions back after you add it again.`,
      { modal: true },
      'Remove'
    );
    if (confirm !== 'Remove') {
      return;
    }
    // Discovery would otherwise add it straight back; like a dismissal, it
    // returns with a new session or when added by hand (ADR 0019).
    await storageService.setDismissed(repo.rootPath, Date.now());
    // Its chats would otherwise linger unseen and keep their sessions from
    // being imported when the folder is added again.
    deps.forgetWorktrees(gitService.listRepositoryWorktrees(repo.rootPath, repo.id).worktrees);
    storageService.removeRepository(repo.id);
    vscode.window.showInformationMessage(`Removed "${repo.name}" from Pitwall`);
    refreshTree();
  });

  register('pitwall.refreshWorkspaces', refreshTree);

  register('pitwall.cloneRepository', async () => {
    const input = await vscode.window.showInputBox({
      prompt: 'Enter GitHub repository URL',
      placeHolder: 'https://github.com/owner/repo or owner/repo',
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return 'Repository URL is required';
        }
        return trimmed.includes('github.com') || /^[\w-]+\/[\w.-]+$/.test(trimmed)
          ? undefined
          : 'Enter a valid GitHub URL or owner/repo format';
      },
    });
    if (!input) {
      return;
    }

    let url = input.trim();
    if (!url.includes('://')) {
      url = `https://github.com/${url}`;
    }
    if (!url.endsWith('.git')) {
      url = `${url}.git`;
    }
    const repoName = path.basename(url, '.git');
    if (!repoName || repoName === '.' || repoName === '..' || /[\\/]/.test(repoName)) {
      vscode.window.showErrorMessage('Could not determine a safe folder name from that URL.');
      return;
    }

    const parent = await pickFolder('Select Parent Folder', 'Select where to clone the repository');
    if (!parent) {
      return;
    }
    const clonePath = path.join(parent, repoName);
    const result = await withProgress(`Cloning ${repoName}...`, () => gitService.clone(url, clonePath));
    if (!result.success) {
      vscode.window.showErrorMessage(`Failed to clone repository: ${result.error}`);
      return;
    }
    const repo = storageService.addRepository(repoName, clonePath);
    vscode.window.showInformationMessage(`Cloned and added repository: ${repo.name}`);
    refreshTree();
  });
}

/** The row a repo command acts on: the one clicked, or a stand-in for the picked repository. */
function repositoryRow(repo: Repository, item?: WorkspaceTreeItem): WorkspaceTreeItem {
  return item?.itemType === 'repository'
    ? item
    : new WorkspaceTreeItem(repo.name, vscode.TreeItemCollapsibleState.Expanded, 'repository', repo, 'repository');
}

/**
 * Every installed agent's sessions for a repo and its worktrees. An agent
 * that fails to list is skipped so it cannot hide the others' history.
 */
async function listRepositorySessions(
  harnessRegistry: HarnessRegistry,
  repoRoot: string,
  worktrees: Worktree[]
): Promise<{ harness: HarnessId; session: HarnessSession }[]> {
  const adapters = await harnessRegistry.getInstalled();
  const listings = await Promise.all(
    adapters.map(async (adapter) => {
      try {
        const sessions = await adapter.listSessionsForRepository(
          repoRoot,
          worktrees.map((worktree) => worktree.path)
        );
        return sessions.map((session) => ({ harness: adapter.id, session }));
      } catch (error) {
        console.error(`Failed to list ${adapter.displayName} sessions for ${repoRoot}:`, error);
        return [];
      }
    })
  );
  return listings.flat();
}

/**
 * Dormant (P18): Move Up / Move Down. Inbox order replaced the manual repo
 * order in Phase 3, so nothing calls this and the manifest contributes
 * neither command. Restoring manual order means calling this from
 * `extension.ts`, re-adding the manifest entries, and moving
 * `test/dry/core/dormant/move-repository.test.ts` back.
 */
export function registerMoveRepositoryCommands(
  context: vscode.ExtensionContext,
  deps: Pick<RepositoryCommandDeps, 'storageService' | 'refreshTree'>
): void {
  const { storageService, refreshTree } = deps;
  const register = commandRegistrar(context);
  const moveRepository = (direction: 'up' | 'down') => (item?: WorkspaceTreeItem) => {
    if (item?.itemType !== 'repository') {
      return;
    }
    const repo = item.data as Repository;
    if (storageService.moveRepository(repo.id, direction)) {
      refreshTree();
    } else {
      vscode.window.showInformationMessage(`"${repo.name}" is already at the ${direction === 'up' ? 'top' : 'bottom'}.`);
    }
  };
  register('pitwall.moveRepositoryUp', moveRepository('up'));
  register('pitwall.moveRepositoryDown', moveRepository('down'));
}
