import * as vscode from 'vscode';
import * as path from 'path';
import { Repository, RepositoryWorktrees, Worktree, ChatSession, TreeItemType } from '../types';
import { StorageService } from '../services/StorageService';
import { GitService, worktreeId } from '../services/GitService';
import { TerminalManager } from '../services/TerminalManager';
import { HarnessRegistry } from '../harness/HarnessRegistry';
import { harnessIconPath } from '../harness/treeIcons';
import { HarnessAdapter, SessionMetadata, TurnState } from '../harness/types';
import { formatRelativeTime } from '../utils/text';
import { debounce } from '../utils/debounce';
import { samePath } from '../utils/paths';
import { logOperation } from '../services/OperationLog';
import { ChatTooltipHeader, chatTooltip } from './chatTooltip';
import { STATUS_WORDS, SessionStatus, statusIconState } from './sessionStatus';
import { orderRows, rankRepo, rankSession, repoStatus } from './inboxOrder';

const REFRESH_DEBOUNCE_MS = 300;
/**
 * Before a repository's first listing this session, a background listing
 * may reuse one the session scan made this recently (and vice versa).
 */
const RECENT_LISTING_MS = 15_000;
/**
 * Another window's stars, names and dismissals reach this window's rows on
 * this cadence at the latest; gaining focus redraws at once (P23).
 */
const SCAN_REDRAW_MS = 60_000;

/** The list's header description (P21). */
export const LIST_DESCRIPTION = 'sorted by who needs you';

export class WorkspaceTreeItem extends vscode.TreeItem {
  /** The status, time and folder lines a hover-built tooltip starts with. */
  tooltipHeader?: ChatTooltipHeader;

  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: TreeItemType,
    public readonly data: Repository | Worktree | ChatSession,
    public readonly contextValue: string
  ) {
    super(label, collapsibleState);
    // Stable across refreshes, so selection, expansion, and reveal survive.
    this.id = `${itemType}-${data.id}`;
  }
}

/** Where row statuses come from: the attention service in the extension. */
export interface StatusSource {
  statusOf(chatId: string): { status: SessionStatus; statusSince: number };
  readonly onDidChangeStatus: vscode.Event<string[]>;
}

/** The canvas repo tooltip; positions 10+ have no key of their own (§3b). */
export function repoTooltip(name: string, position: number): string {
  return position >= 1 && position <= 9
    ? `${name}: Ctrl+Alt+${position} jumps here, Ctrl+Alt+Shift+${position} opens it in its own window. Right-click for more.`
    : `${name}: Right-click for more.`;
}

/**
 * A repo row's summary (§3a): "{k} needs you" / "{k} need you" and "{n} open",
 * each left out at 0; with both 0, "{m} sessions" ("1 session").
 */
export function repoSummary(needs: number, open: number, sessions: number): string {
  const parts = [needs > 0 ? `${needs} ${needs === 1 ? 'needs' : 'need'} you` : '', open > 0 ? `${open} open` : ''];
  const summary = parts.filter(Boolean).join(' · ');
  return summary || `${sessions} ${sessions === 1 ? 'session' : 'sessions'}`;
}

/** One session row before it is drawn. */
interface SessionEntry {
  chat: ChatSession;
  worktree: Worktree;
  status: SessionStatus;
  statusSince: number;
}

/** A repo and its sessions from all of its worktrees. */
interface RepoEntry {
  repo: Repository;
  isGit: boolean;
  sessions: SessionEntry[];
}

/**
 * The Repos view (rows 3.2-3.4): every repo, and under it the sessions from
 * all of its worktrees, in inbox order. The worktree level is gone from the
 * view only (P8): chats keep their worktree, which gives each row its branch,
 * its ⧉ mark and the folder FILES follows.
 *
 * The order changes only when a status changes or a row is added or removed
 * (P6); a redraw in between keeps the rows where they are and refreshes only
 * their text.
 */
export class WorkspacesTreeProvider implements vscode.TreeDataProvider<WorkspaceTreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  /** Each repository's latest worktree listing this session, by repository id. */
  private readonly worktreeCache = new Map<string, RepositoryWorktrees>();
  /** Repositories listed since the last hard refresh; a render after one waits to list again any it has listed before. */
  private readonly listed = new Set<string>();
  /** Worktree listings in flight, by repository id, with the refresh generation each started in. */
  private readonly listings = new Map<string, { generation: number; done: Promise<void> }>();
  /** Bumped by a hard refresh, so a listing that started before it is not taken as current. */
  private listingGeneration = 0;
  /** What rows were drawn from before a repository's first listing: its stored snapshot or a plain folder. */
  private readonly standIns = new Map<string, RepositoryWorktrees>();
  /** Repositories with a background listing queued, by id. */
  private readonly listingQueued = new Set<string>();
  private disposed = false;

  private turnStateProvider: (chatId: string) => TurnState | undefined = () => undefined;
  private needsYouProvider: (chatId: string) => boolean = () => false;
  private chatOpenProvider: (chat: ChatSession) => boolean;
  private statusSource: StatusSource | undefined;
  private statusSubscription: vscode.Disposable | undefined;
  private view: Pick<vscode.TreeView<WorkspaceTreeItem>, 'description' | 'badge'> | undefined;

  /** Inbox order, recomputed only on a status change or a row added or removed (P6). */
  private sortDirty = true;
  private membershipKey: string | undefined;
  private repoOrder: string[] = [];
  private readonly sessionOrder = new Map<string, string[]>();
  private firstRenderLogged = false;

  private repoWatchers: vscode.Disposable[] = [];
  private watchedRepoIds = '';
  private pendingCacheClear = false;
  /** True from a refresh until the next top-level render; nothing has rendered yet at construction. */
  private renderPending = true;
  private settleWaiters: Array<() => void> = [];
  /** Reveals the workbench is still carrying out, and whether a refresh waits for them (L1). */
  private revealsInFlight = 0;
  private refreshHeld = false;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly scanTimer: NodeJS.Timeout;

  private readonly scheduledRefresh = debounce(() => {
    if (this.pendingCacheClear) {
      // The old listings still answer lookups; the next render lists again.
      this.pendingCacheClear = false;
      this.listed.clear();
      this.listingGeneration += 1;
    }
    this.updateRepoWatchers();
    this.fireChange();
  }, REFRESH_DEBOUNCE_MS);

  /** A branch switch, `git init`, or `.git` removal changes worktrees and branches. */
  private readonly onGitChange = debounce(() => {
    this.refresh();
  }, REFRESH_DEBOUNCE_MS);

  constructor(
    private readonly storageService: StorageService,
    private readonly gitService: GitService,
    terminalManager: TerminalManager,
    private readonly harnessRegistry: HarnessRegistry,
    private readonly extensionUri: vscode.Uri
  ) {
    this.chatOpenProvider = (chat) => terminalManager.isActive(chat.id);
    // A terminal opening or closing only changes its row's mark.
    this.disposables.push(terminalManager.onTerminalStateChange(() => this.softRefresh()));
    // globalState has no cross-window change event: redraw from storage when
    // the window gains focus and on each scan (P23).
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          this.softRefresh();
        }
      })
    );
    this.scanTimer = setInterval(() => this.softRefresh(), SCAN_REDRAW_MS);
    this.scanTimer.unref?.();
    this.updateRepoWatchers();
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.scanTimer);
    this.scheduledRefresh.cancel();
    this.onGitChange.cancel();
    this.statusSubscription?.dispose();
    for (const disposable of [...this.disposables, ...this.repoWatchers]) {
      disposable.dispose();
    }
    this.changeEmitter.dispose();
  }

  /**
   * Row statuses and their change events. Without one (older tests), an open
   * chat shows working or finished from its turn state, as before Phase 3.
   */
  setStatusSource(source: StatusSource): void {
    this.statusSubscription?.dispose();
    this.statusSource = source;
    this.sortDirty = true;
    this.statusSubscription = source.onDidChangeStatus(() => {
      this.sortDirty = true;
      this.updateBadge();
      this.softRefresh();
    });
    this.updateBadge();
  }

  /** The tree view this provider fills: its header description and needs-you badge. */
  bindView(view: Pick<vscode.TreeView<WorkspaceTreeItem>, 'description' | 'badge'>): void {
    this.view = view;
    view.description = LIST_DESCRIPTION;
    this.updateBadge();
  }

  /** Live turn state for the legacy marks, used only without a status source. */
  setTurnStateProvider(provider: (chatId: string) => TurnState | undefined): void {
    this.turnStateProvider = provider;
  }

  /** Whether a chat is waiting on the user, used only without a status source. */
  setNeedsYouProvider(provider: (chatId: string) => boolean): void {
    this.needsYouProvider = provider;
  }

  /** The one "is this chat open" predicate: a live terminal or a mapped native-UI tab. */
  setChatOpenProvider(provider: (chat: ChatSession) => boolean): void {
    this.chatOpenProvider = provider;
  }

  /**
   * Resolves after the first `getChildren(undefined)` that completes after the
   * latest `refresh()` or `softRefresh()`, and at once when no render is
   * pending. Reveals wait on this so they never name a row not yet rendered.
   */
  whenSettled(): Promise<void> {
    if (!this.renderPending) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.settleWaiters.push(resolve));
  }

  /**
   * Reveal a row once the rows have rendered after the latest refresh, and
   * hold every refresh until the workbench has finished the reveal (L1). A
   * full refresh makes the extension host forget every row; the workbench
   * expands a reveal's parent rows after the extension host resolved them,
   * so a refresh landing in between makes it ask for a row that no longer
   * exists ("No tree item with id '1/repository-…' found.") and the reveal
   * fails. A held refresh fires once, when the last reveal ends.
   */
  async revealWhenSettled(reveal: () => Thenable<unknown>): Promise<void> {
    await this.whenSettled();
    this.revealsInFlight += 1;
    try {
      await reveal();
    } catch {
      // Best effort: a row that cannot be revealed is not an error.
    } finally {
      this.revealsInFlight -= 1;
      if (this.revealsInFlight === 0 && this.refreshHeld) {
        this.refreshHeld = false;
        this.changeEmitter.fire();
      }
    }
  }

  /** Fire a full refresh now, or, while a reveal is in flight, once it ends. */
  private fireChange(): void {
    this.renderPending = true;
    if (this.revealsInFlight > 0) {
      this.refreshHeld = true;
      return;
    }
    this.changeEmitter.fire();
  }

  /** Re-render and re-list worktrees (debounced). */
  refresh(): void {
    this.renderPending = true;
    this.pendingCacheClear = true;
    this.scheduledRefresh();
  }

  /** Re-render rows from storage, keeping the worktree cache. */
  softRefresh(): void {
    this.renderPending = true;
    this.scheduledRefresh();
  }

  /**
   * Watch each root's HEADs (branch switches) and `.git` itself (`git init`
   * or its removal). Rebuilt only when the set of roots changes, or when
   * `.git` appears or disappears, since the HEAD patterns need it to exist.
   */
  private updateRepoWatchers(force = false): void {
    const repositories = this.storageService.getRepositories();
    const ids = repositories.map((r) => r.id).sort().join(',');
    if (!force && ids === this.watchedRepoIds) {
      return;
    }
    this.watchedRepoIds = ids;
    this.repoWatchers.forEach((watcher) => watcher.dispose());
    this.repoWatchers = [];

    const watch = (base: string, pattern: string, events: ('change' | 'create' | 'delete')[], onEvent: () => void) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, pattern));
      if (events.includes('change')) watcher.onDidChange(onEvent);
      if (events.includes('create')) watcher.onDidCreate(onEvent);
      if (events.includes('delete')) watcher.onDidDelete(onEvent);
      this.repoWatchers.push(watcher);
    };
    for (const repo of repositories) {
      const gitDir = path.join(repo.rootPath, '.git');
      watch(gitDir, 'HEAD', ['change', 'create'], this.onGitChange);
      watch(gitDir, 'worktrees/*/HEAD', ['change', 'create'], this.onGitChange);
      watch(repo.rootPath, '.git', ['create', 'delete'], () => {
        this.updateRepoWatchers(true);
        this.onGitChange();
      });
    }
  }

  getTreeItem(element: WorkspaceTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Fill a chat tooltip on hover. Only rows whose harness builds previews from
   * an expensive export arrive here without one; the adapter caches the
   * export, so hovering again is cheap and a later render picks up new turns.
   */
  async resolveTreeItem(item: vscode.TreeItem, element: WorkspaceTreeItem): Promise<vscode.TreeItem> {
    if (element.itemType !== 'chat' || item.tooltip !== undefined) {
      return item;
    }
    const chat = element.data as ChatSession;
    if (!this.harnessRegistry.has(chat.harness)) {
      return item;
    }
    const adapter = this.harnessRegistry.get(chat.harness);
    let meta: SessionMetadata | null = null;
    if (chat.harnessSessionId) {
      await adapter.getPreview(chat.harnessSessionId, 3).catch(() => undefined);
      meta = await adapter
        .getSessionMetadata(chat.harnessSessionId, this.getWorktreeById(chat.worktreeId)?.path)
        .catch(() => null);
    }
    item.tooltip = chatTooltip(chat, adapter.displayName, meta, element.tooltipHeader);
    return item;
  }

  /** Required by `TreeView.reveal()`: a session's parent is its repo row. */
  getParent(element: WorkspaceTreeItem): WorkspaceTreeItem | undefined {
    if (element.itemType === 'chat') {
      const worktree = this.getWorktreeById((element.data as ChatSession).worktreeId);
      return worktree ? this.getTreeItemForWorktree(worktree) : undefined;
    }
    if (element.itemType === 'worktree') {
      const repo = this.storageService.getRepository((element.data as Worktree).repoId);
      return repo ? this.repositoryItem(repo, vscode.TreeItemCollapsibleState.Expanded) : undefined;
    }
    return undefined;
  }

  async getChildren(element?: WorkspaceTreeItem): Promise<WorkspaceTreeItem[]> {
    if (!element) {
      await this.awaitRelistings(this.storageService.getRepositories());
      const rows = this.rootRows();
      this.renderPending = false;
      const waiters = this.settleWaiters;
      this.settleWaiters = [];
      waiters.forEach((resolve) => resolve());
      if (!this.firstRenderLogged) {
        this.firstRenderLogged = true;
        logOperation('[Pitwall] first render');
      }
      return rows;
    }
    if (element.itemType === 'repository') {
      await this.awaitRelistings([element.data as Repository]);
      const entry = this.repoEntry(element.data as Repository, this.chatsByWorktree());
      return this.sessionRows(entry, this.orderedSessions(entry));
    }
    if (element.itemType === 'worktree') {
      // Not in the view since Phase 3 (P8); kept for callers that hold a worktree.
      const worktree = element.data as Worktree;
      const repo = this.storageService.getRepository(worktree.repoId);
      if (!repo) {
        return [];
      }
      await this.awaitRelistings([repo]);
      const entry = this.repoEntry(repo, this.chatsByWorktree());
      const sessions = this.orderedSessions(entry).filter((session) => session.worktree.id === worktree.id);
      return this.sessionRows(entry, sessions);
    }
    return [];
  }

  private rootRows(): WorkspaceTreeItem[] {
    const byWorktree = this.chatsByWorktree();
    const entries = this.storageService.getRepositories().map((repo) => this.repoEntry(repo, byWorktree));
    const key = entries
      .map((entry) => `${entry.repo.id}:${entry.sessions.map((session) => session.chat.id).sort().join(',')}`)
      .sort()
      .join('|');
    if (this.sortDirty || key !== this.membershipKey) {
      this.sortDirty = false;
      this.membershipKey = key;
      this.resort(entries);
    }
    const byId = new Map(entries.map((entry) => [entry.repo.id, entry]));
    const ordered = this.repoOrder.flatMap((id) => byId.get(id) ?? []);
    this.updateBadge(entries);
    return ordered.map((entry, index) => this.repositoryRow(entry, index + 1));
  }

  /** Recompute the inbox order and log it (E7). */
  private resort(entries: RepoEntry[]): void {
    this.sessionOrder.clear();
    for (const entry of entries) {
      this.sessionOrder.set(entry.repo.id, this.sortSessions(entry).map((session) => session.chat.id));
    }
    this.repoOrder = orderRows(
      entries.map((entry) => ({ id: entry.repo.id, title: entry.repo.name, ...repoStatus(entry.sessions) })),
      rankRepo
    ).map((row) => row.id);
    logOperation(`[Pitwall] order ${this.repoOrder.join(' ')}`);
  }

  private sortSessions(entry: RepoEntry): SessionEntry[] {
    const byId = new Map(entry.sessions.map((session) => [session.chat.id, session]));
    return orderRows(
      entry.sessions.map((session) => ({
        id: session.chat.id,
        status: session.status,
        statusSince: session.statusSince,
        title: session.chat.name,
      })),
      rankSession
    ).map((row) => byId.get(row.id)!);
  }

  /**
   * A repo's sessions in the order the last re-sort gave them. A session the
   * last re-sort did not see (added since) gets this repo sorted now; the
   * next top-level render then re-sorts and logs.
   */
  private orderedSessions(entry: RepoEntry): SessionEntry[] {
    const order = this.sessionOrder.get(entry.repo.id);
    const byId = new Map(entry.sessions.map((session) => [session.chat.id, session]));
    if (!order || order.length !== byId.size || order.some((id) => !byId.has(id))) {
      const sorted = this.sortSessions(entry);
      this.sessionOrder.set(entry.repo.id, sorted.map((session) => session.chat.id));
      return sorted;
    }
    return order.map((id) => byId.get(id)!);
  }

  /** Every stored chat by worktree id, read once per render. */
  private chatsByWorktree(): Map<string, ChatSession[]> {
    const byWorktree = new Map<string, ChatSession[]>();
    for (const chat of this.storageService.getChats()) {
      // A chat whose harness this build has switched off stays stored but has
      // no row: its adapter is not registered.
      if (!this.harnessRegistry.has(chat.harness)) {
        continue;
      }
      const list = byWorktree.get(chat.worktreeId);
      if (list) {
        list.push(chat);
      } else {
        byWorktree.set(chat.worktreeId, [chat]);
      }
    }
    return byWorktree;
  }

  private repoEntry(repo: Repository, byWorktree: Map<string, ChatSession[]>): RepoEntry {
    const { isGit, worktrees } = this.getRepoWorktrees(repo);
    const sessions: SessionEntry[] = [];
    for (const worktree of worktrees) {
      for (const chat of byWorktree.get(worktree.id) ?? []) {
        sessions.push({ chat, worktree, ...this.statusOf(chat) });
      }
    }
    return { repo, isGit, sessions };
  }

  private statusOf(chat: ChatSession): { status: SessionStatus; statusSince: number } {
    if (this.statusSource) {
      return this.statusSource.statusOf(chat.id);
    }
    const status: SessionStatus = this.needsYouProvider(chat.id)
      ? 'needs'
      : !this.chatOpenProvider(chat)
        ? 'idle'
        : this.turnStateProvider(chat.id) === 'working'
          ? 'working'
          : 'finished';
    return { status, statusSince: chat.createdAt };
  }

  /** The needs-you count on the view (canvas "+1 on the sidebar badge"), hidden at 0. */
  private updateBadge(entries?: RepoEntry[]): void {
    if (!this.view) {
      return;
    }
    let all = entries;
    if (!all) {
      const byWorktree = this.chatsByWorktree();
      all = this.storageService.getRepositories().map((repo) => this.repoEntry(repo, byWorktree));
    }
    const count = all.reduce((sum, entry) => sum + entry.sessions.filter((session) => session.status === 'needs').length, 0);
    this.view.badge =
      count > 0 ? { value: count, tooltip: count === 1 ? '1 session needs you' : `${count} sessions need you` } : undefined;
  }

  private repositoryItem(repo: Repository, state: vscode.TreeItemCollapsibleState): WorkspaceTreeItem {
    const { isGit } = this.getRepoWorktrees(repo);
    return new WorkspaceTreeItem(repo.name, state, 'repository', repo, isGit ? 'repository' : 'folderRepository');
  }

  private repositoryRow(entry: RepoEntry, position: number): WorkspaceTreeItem {
    const { repo, sessions } = entry;
    const item = this.repositoryItem(
      repo,
      sessions.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    const needs = sessions.filter((session) => session.status === 'needs').length;
    const open = sessions.filter((session) => this.chatOpenProvider(session.chat)).length;
    item.description = repoSummary(needs, open, sessions.length);
    item.tooltip = repoTooltip(repo.name, position);
    return item;
  }

  /**
   * A repository's worktrees and git state, never waiting on git (E16): the
   * latest listing, else the stored snapshot, else the root as a plain
   * folder. A repository not listed since the last hard refresh is listed
   * in the background; a listing that differs from what was drawn redraws.
   */
  private getRepoWorktrees(repo: Repository): RepositoryWorktrees {
    if (!this.listed.has(repo.id)) {
      this.listInBackground(repo);
    }
    const cached = this.worktreeCache.get(repo.id);
    if (cached) {
      return cached;
    }
    let standIn = this.standIns.get(repo.id);
    if (!standIn) {
      standIn = this.storageService.getWorktreeSnapshot(repo.id) ?? plainFolder(repo);
      this.standIns.set(repo.id, standIn);
    }
    return standIn;
  }

  /**
   * List a repository's worktrees without blocking; one listing per
   * repository and refresh at a time. A caller that waits on the answer asks
   * for an urgent one, which also hurries one already waiting for its turn;
   * a background one takes its turn and, before the repository's first
   * listing, may reuse the session scan's.
   */
  private listWorktrees(repo: Repository, urgent: boolean): Promise<void> {
    const generation = this.listingGeneration;
    const inFlight = this.listings.get(repo.id);
    if (inFlight?.generation === generation) {
      if (urgent) {
        this.gitService.expediteWorktreeListing(repo.rootPath, repo.id);
      }
      return inFlight.done;
    }
    const options = urgent || this.worktreeCache.has(repo.id) ? { urgent } : { maxAgeMs: RECENT_LISTING_MS };
    const done = this.gitService.listRepositoryWorktreesAsync(repo.rootPath, repo.id, options).then((listing) => {
      if (this.listings.get(repo.id)?.done === done) {
        this.listings.delete(repo.id);
      }
      if (this.disposed || generation !== this.listingGeneration) {
        return;
      }
      this.worktreeCache.set(repo.id, listing);
      this.listed.add(repo.id);
      this.storageService.saveWorktreeSnapshot(repo.id, listing);
      const standIn = this.standIns.get(repo.id);
      this.standIns.delete(repo.id);
      if (standIn && JSON.stringify(standIn) !== JSON.stringify(listing)) {
        // The badge shows whether or not the rows redraw.
        this.updateBadge();
        this.softRefresh();
      }
    });
    this.listings.set(repo.id, { generation, done });
    return done;
  }

  /**
   * Resolves once every stored repository has been listed since the last
   * hard refresh, listing any that is not yet. Rows drawn after it come from
   * git, not a stand-in.
   */
  async whenListed(): Promise<void> {
    for (let round = 0; round < 5 && !this.disposed; round++) {
      const pending = this.storageService.getRepositories().filter((repo) => !this.listed.has(repo.id));
      if (pending.length === 0) {
        return;
      }
      await Promise.all(pending.map((repo) => this.listWorktrees(repo, false)));
    }
  }

  /** Queue a background listing; it starts after the caller returns, never inside activation. */
  private listInBackground(repo: Repository): void {
    if (this.listingQueued.has(repo.id) || this.listings.get(repo.id)?.generation === this.listingGeneration) {
      return;
    }
    this.listingQueued.add(repo.id);
    setImmediate(() => {
      this.listingQueued.delete(repo.id);
      if (!this.disposed && !this.listed.has(repo.id)) {
        void this.listWorktrees(repo, false);
      }
    });
  }

  /**
   * Before a render that follows a hard refresh: list again, and wait for,
   * each of these repositories listed earlier this session, so a worktree
   * added or removed shows. A repository not listed yet this session never
   * waits (E16): it is drawn from its stored snapshot, or as a plain folder,
   * and listed in the background, and the rows follow when git answers.
   */
  private async awaitRelistings(repositories: Repository[]): Promise<void> {
    const relist = repositories.filter((repo) => !this.listed.has(repo.id) && this.worktreeCache.has(repo.id));
    await Promise.all(relist.map((repo) => this.listWorktrees(repo, true)));
  }

  private async sessionRows(entry: RepoEntry, sessions: SessionEntry[]): Promise<WorkspaceTreeItem[]> {
    const starredIds = this.storageService.getStarredChatIds();

    // Adapters answer from their caches; a lazy-preview harness leaves the
    // preview empty until resolveTreeItem asks for it on hover.
    const metadata = new Map<string, SessionMetadata | null>(
      await Promise.all(
        sessions.map(async ({ chat, worktree }): Promise<[string, SessionMetadata | null]> => [
          chat.id,
          chat.harnessSessionId
            ? await this.harnessRegistry
                .get(chat.harness)
                .getSessionMetadata(chat.harnessSessionId, worktree.path)
                .catch(() => null)
            : null,
        ])
      )
    );

    return sessions.map((session) => {
      const { chat, worktree, status } = session;
      const isOpen = this.chatOpenProvider(chat);
      const meta = metadata.get(chat.id) ?? null;
      const adapter = this.harnessRegistry.get(chat.harness);
      const item = new WorkspaceTreeItem(
        chat.name,
        vscode.TreeItemCollapsibleState.None,
        'chat',
        chat,
        chatContextValue(adapter, isOpen, starredIds.has(chat.id), status === 'needs')
      );
      item.iconPath = harnessIconPath(this.extensionUri, adapter, statusIconState(status, Boolean(chat.harnessSessionId)));

      const statusLine = sessionStatusLine(session, meta);
      // ⎇ branch (P7): the worktree's live branch, or its short sha / folder
      // name when detached. A plain folder has none. ⧉ marks a worktree that
      // is not the repo's main one.
      const branch = entry.isGit ? `⎇ ${worktree.branch ?? worktree.name}${worktree.isMain ? '' : ' ⧉'}  ` : '';
      item.description = `${branch}${statusLine}${isOpen ? ' · open' : ''}`;

      item.tooltipHeader = {
        status: statusLine,
        folder: worktree.path,
        worktree: entry.isGit && !worktree.isMain ? worktree.path : undefined,
      };
      // A lazy-preview harness needs an export for the last exchange; leave
      // the tooltip unset so only the hovered row pays for it.
      const needsPreview =
        meta !== null && meta.preview.length === 0 && adapter.capabilities.preview === 'lazy';
      if (!needsPreview) {
        item.tooltip = chatTooltip(chat, adapter.displayName, meta, item.tooltipHeader);
      }
      item.command = { command: 'pitwall.openChat', title: 'Open Chat', arguments: [item] };
      return item;
    });
  }

  /** The repo row at a 1-based position in inbox order (the number its tooltip names). */
  repoRowAt(position: number): WorkspaceTreeItem | undefined {
    return this.rootRows()[position - 1];
  }

  /** A repo's session rows in the order its row lists them. */
  chatRowsOf(repo: Repository): WorkspaceTreeItem[] {
    const entry = this.repoEntry(repo, this.chatsByWorktree());
    return this.orderedSessions(entry).map((session) => this.getChatTreeItem(session.chat));
  }

  /** A minimal chat row for `reveal()`. */
  getChatTreeItem(chat: ChatSession): WorkspaceTreeItem {
    return new WorkspaceTreeItem(
      chat.name,
      vscode.TreeItemCollapsibleState.None,
      'chat',
      chat,
      chatContextValue(
        this.harnessRegistry.has(chat.harness) ? this.harnessRegistry.get(chat.harness) : undefined,
        this.chatOpenProvider(chat),
        this.storageService.isStarred(chat.id)
      )
    );
  }

  /** The row that stands for a worktree: its repo's row (P8). */
  getTreeItemForWorktree(worktree: Worktree): WorkspaceTreeItem {
    const repo = this.storageService.getRepository(worktree.repoId);
    return repo
      ? this.repositoryItem(repo, vscode.TreeItemCollapsibleState.Expanded)
      : new WorkspaceTreeItem(worktree.name, vscode.TreeItemCollapsibleState.Expanded, 'worktree', worktree, 'worktree');
  }

  getWorktreeById(worktreeId: string): Worktree | undefined {
    return this.findWorktree((worktree) => worktree.id === worktreeId);
  }

  findWorktreeByPath(targetPath: string): Worktree | undefined {
    return this.findWorktree((worktree) => samePath(worktree.path, targetPath));
  }

  /**
   * `getWorktreeById` for a caller that can wait: a miss before every
   * repository's listing has landed waits for those listings (B1). Until
   * then a repository without a stored snapshot knows only its main
   * worktree, so a chat on a linked one would not be found.
   */
  getWorktreeByIdAsync(worktreeId: string, options: { urgent?: boolean } = {}): Promise<Worktree | undefined> {
    return this.findWorktreeAsync((worktree) => worktree.id === worktreeId, options);
  }

  /** `findWorktreeByPath` for a caller that can wait (see `getWorktreeByIdAsync`). */
  findWorktreeByPathAsync(targetPath: string, options: { urgent?: boolean } = {}): Promise<Worktree | undefined> {
    return this.findWorktreeAsync((worktree) => samePath(worktree.path, targetPath), options);
  }

  isGitRepo(repo: Repository): boolean {
    return this.getRepoWorktrees(repo).isGit;
  }

  /** Whether a worktree is git-backed; a plain folder's own worktree is not. */
  isGitWorktree(worktree: Worktree): boolean {
    const repo = this.storageService.getRepository(worktree.repoId);
    return repo ? this.getRepoWorktrees(repo).isGit : this.gitService.isGitRepository(worktree.path);
  }

  /**
   * The worktree a row's actions apply to: a repo row stands for its main
   * worktree (a plain folder's single one), a worktree item for itself.
   */
  getWorktreeForItem(item?: WorkspaceTreeItem): Worktree | undefined {
    if (item?.itemType === 'worktree') {
      return item.data as Worktree;
    }
    if (item?.itemType === 'repository') {
      const { worktrees } = this.getRepoWorktrees(item.data as Repository);
      return worktrees.find((worktree) => worktree.isMain) ?? worktrees[0];
    }
    return undefined;
  }

  /** Whether a worktree belongs to a git repository (for the FILES header). */
  repositoryFor(worktree: Worktree): { repo: Repository; isGit: boolean } | undefined {
    const repo = this.storageService.getRepository(worktree.repoId);
    return repo ? { repo, isGit: this.getRepoWorktrees(repo).isGit } : undefined;
  }

  /**
   * Search every repository's worktrees as `getRepoWorktrees` gives them, so
   * a lookup never waits on git; a repository not listed yet is listed in
   * the background.
   */
  private findWorktree(predicate: (worktree: Worktree) => boolean): Worktree | undefined {
    for (const repo of this.storageService.getRepositories()) {
      const found = this.getRepoWorktrees(repo).worktrees.find(predicate);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /**
   * `findWorktree`, and on a miss wait for the listings of the repositories
   * not listed since the last hard refresh, then look again. A chat names
   * only its worktree's id, which does not say which repository owns it, so
   * every such repository is waited on; each is listed at most once. An
   * urgent lookup (a click) starts git at once, ahead of the queue.
   */
  private async findWorktreeAsync(
    predicate: (worktree: Worktree) => boolean,
    { urgent = true }: { urgent?: boolean } = {}
  ): Promise<Worktree | undefined> {
    const found = this.findWorktree(predicate);
    if (found) {
      return found;
    }
    // Never start git inside the caller's task, which may be activation.
    await new Promise((resolve) => setImmediate(resolve));
    const pending = this.storageService.getRepositories().filter((repo) => !this.listed.has(repo.id));
    if (pending.length === 0) {
      return this.findWorktree(predicate);
    }
    await Promise.all(pending.map((repo) => this.listWorktrees(repo, urgent)));
    return this.findWorktree(predicate);
  }
}

/** A root as a plain folder: its own single worktree, with the id git's main worktree would have. */
function plainFolder(repo: Repository): RepositoryWorktrees {
  return {
    isGit: false,
    worktrees: [
      { id: worktreeId(repo.id, repo.rootPath), repoId: repo.id, name: path.basename(repo.rootPath), path: repo.rootPath, isMain: true },
    ],
  };
}

/**
 * The row's status and time: "needs you · 2m", "working · now",
 * "finished · 14m", "idle · 1h", or "new" for a chat its harness has not
 * linked yet. Needs and finished count from when the row entered the status;
 * idle shows the last activity.
 */
function sessionStatusLine(session: SessionEntry, meta: SessionMetadata | null): string {
  const { chat, status, statusSince } = session;
  if (!chat.harnessSessionId) {
    return 'new';
  }
  const ago =
    status === 'working'
      ? 'now'
      : formatRelativeTime(status === 'idle' ? meta?.lastActivity ?? chat.lastAccessedAt : statusSince, { short: true });
  return `${STATUS_WORDS[status]} · ${ago}`;
}

/**
 * The context value names the row state for menus; an adapter with a native
 * UI appends its own suffix so that UI's entry targets only its rows. A row
 * that needs you carries `Needs` before that suffix, which shows its bell.
 */
function chatContextValue(
  adapter: HarnessAdapter | undefined,
  isOpen: boolean,
  isStarred: boolean,
  needsYou = false
): string {
  const base = isOpen ? (isStarred ? 'runningStarredChat' : 'runningChat') : isStarred ? 'starredChat' : 'chat';
  return `${base}${needsYou ? 'Needs' : ''}${adapter?.nativeUi?.contextValueSuffix ?? ''}`;
}
