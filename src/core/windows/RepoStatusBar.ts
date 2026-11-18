import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../services/GitService';
import { samePath } from '../utils/paths';

/** Where a click goes: Pitwall's own list. */
const FOCUS_COMMAND = 'pitwall.workspacesView.focus';
/** Short sha length for a detached HEAD, git's own default. */
const SHORT_SHA = 7;

interface RepoInfo {
  name: string;
  isWorktree: boolean;
  /** The folder's own git dir: `<repo>/.git`, or `<main>/.git/worktrees/<name>` for a worktree. */
  gitDir: string;
}

/**
 * The bottom-bar item `$(repo) {repo} · ⎇ {branch}` for this window's folder
 * (row 4.5, Q7), with ` ⧉` appended in a worktree. It reads the branch from
 * the git dir's HEAD file and watches that file, so a refresh never starts a
 * git process; git runs only to locate the repo, once. Pitwall writes no
 * settings, so this item is the whole display.
 */
export class RepoStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private watcher: vscode.FileSystemWatcher | undefined;
  private watchedGitDir: string | undefined;
  private info: RepoInfo | undefined;
  private disposed = false;

  constructor(
    private readonly folder: string | undefined,
    private readonly git: GitService
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = FOCUS_COMMAND;
  }

  /** Re-read the branch, and (re)locate the repo while it is unknown. */
  async refresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.folder) {
      this.item.hide();
      return;
    }
    this.info ??= await this.locate(this.folder);
    if (this.disposed) {
      return;
    }
    if (!this.info) {
      this.item.hide();
      return;
    }
    this.watch(this.info.gitDir);
    const branch = readBranch(this.info.gitDir);
    this.item.text = `$(repo) ${this.info.name} · ⎇ ${branch}${this.info.isWorktree ? ' ⧉' : ''}`;
    this.item.tooltip = this.folder;
    this.item.show();
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.dispose();
    this.watcher = undefined;
    this.item.dispose();
  }

  private async locate(folder: string): Promise<RepoInfo | undefined> {
    const top = this.git.getRepoRoot(folder);
    const main = top ? await this.git.getMainRepoRoot(folder) : null;
    if (!top || !main) {
      return undefined;
    }
    const gitDir = resolveGitDir(top);
    return gitDir ? { name: path.basename(main), isWorktree: !samePath(top, main), gitDir } : undefined;
  }

  /** Watch `<gitDir>/HEAD`: a worktree's lives under the main repo's `.git/worktrees/<name>`. */
  private watch(gitDir: string): void {
    if (this.watcher && this.watchedGitDir === gitDir) {
      return;
    }
    this.watcher?.dispose();
    this.watchedGitDir = gitDir;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(gitDir, 'HEAD'));
    const onEvent = () => void this.refresh();
    watcher.onDidChange(onEvent);
    watcher.onDidCreate(onEvent);
    this.watcher = watcher;
  }
}

/** `<top>/.git` when a folder; when a file (a worktree), the `gitdir:` path it holds. */
function resolveGitDir(top: string): string | undefined {
  const dotGit = path.join(top, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) {
      return dotGit;
    }
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf-8'));
    return match ? path.resolve(top, match[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** The branch in HEAD, or the short sha when detached. */
function readBranch(gitDir: string): string {
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1] : head.slice(0, SHORT_SHA);
  } catch {
    return '?';
  }
}
