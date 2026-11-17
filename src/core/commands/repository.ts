import * as vscode from 'vscode';
import * as path from 'path';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { WorkspaceTreeItem } from '../providers/WorkspacesTreeProvider';
import { HarnessRegistry } from '../harness/HarnessRegistry';
import { HarnessSession } from '../harness/types';
import { harnessSessionKey, sessionDisplayName } from '../harness/sessionUtils';
import { ChatSession, HarnessId, Repository, Worktree } from '../types';
import { canonicalPath, canonicalRoot, samePath } from '../utils/paths';
import { formatRelativeTime } from '../utils/text';
import { commandRegistrar, importNativeSession, withProgress } from './common';

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
        repos.map((r) => ({ label: r.name, description: r.rootPath, repo: r })),
        { placeHolder: `Select repository to ${verb} from extension` }
      )
    )?.repo;
  };

  /** The repo row's "+" and its menu's first item: a Claude chat in the main worktree. */
  register('pitwall.newSessionInRepository', async (item?: WorkspaceTreeItem) => {
    const repo = await repositoryFor(item, 'start a session in');
    if (repo) {
      await vscode.commands.executeCommand('pitwall.newClaudeChat', repositoryRow(repo, item));
    }
  });

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
        return { chat, at: session?.lastUpdated?.getTime() ?? chat.lastAccessedAt, worktree };
      })
      .sort((a, b) => b.at - a.at);
    const recentSince = Date.now() - HISTORY_SIDEBAR_DAYS * 24 * 60 * 60 * 1000;
    const recent = inSidebar.filter((entry) => entry.at >= recentSince);
    const stale = inSidebar.filter((entry) => entry.at < recentSince);
    const chatRow = ({ chat, at, worktree }: (typeof inSidebar)[number]) => ({
      label: chat.name,
      description: `${branchPart(worktree.branch ?? worktree.name)}${formatRelativeTime(at, { short: true })}`,
      chat,
    });
    // Chats that fell out of the 14 days sit here too: picking one just opens it.
    const older = [
      ...native
        .filter((entry) => !imported.has(harnessSessionKey(entry.harness, entry.session.sessionId)))
        .map(({ harness, session }) => ({
          at: session.lastUpdated?.getTime() ?? 0,
          row: {
            label: sessionDisplayName(session),
            description: `${branchPart(session.gitBranch)}${session.lastUpdated ? formatRelativeTime(session.lastUpdated, { short: true }) : ''}`,
            harness,
            session,
          },
        })),
      ...stale.map((entry) => ({ at: entry.at, row: chatRow(entry) })),
    ]
      .sort((a, b) => b.at - a.at)
      .map((entry) => entry.row);

    const separator = (label: string) => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const picked = (await vscode.window.showQuickPick(
      [
        separator(`IN THE SIDEBAR (LAST ${HISTORY_SIDEBAR_DAYS} DAYS)`),
        ...(recent.length > 0 ? recent.map(chatRow) : [{ label: 'None.' }]),
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
