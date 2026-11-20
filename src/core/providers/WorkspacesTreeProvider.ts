import * as vscode from 'vscode';
import * as path from 'path';
import { Repository, RepositoryWorktrees, Worktree, ChatSession, TreeItemType } from '../types';
import { StorageService } from '../services/StorageService';
import { GitService, worktreeId } from '../services/GitService';
import { TerminalManager } from '../services/TerminalManager';
import { HarnessRegistry } from '../harness/HarnessRegistry';
import { harnessIconPath } from '../harness/treeIcons';
import { chatNativeSessionIds } from '../harness/sessionUtils';
import { HarnessAdapter, SessionMetadata, TurnState } from '../harness/types';
import { formatRelativeTime } from '../utils/text';
import { debounce } from '../utils/debounce';
import { deepestContainingRoot, samePath } from '../utils/paths';
import { logOperation } from '../services/OperationLog';
import { ChatTooltipHeader, chatTooltip } from './chatTooltip';
import { STATUS_WORDS, SessionStatus, statusIconState } from './sessionStatus';
import { orderRows, rankRepo, rankSession, repoStatus } from './inboxOrder';
import { AimedClicks } from './aimedClick';

const REFRESH_DEBOUNCE_MS = 300;
/**
 * Every redraw request inside this window joins one pass, which then fires
 * at most one tree change. The window opens with the first request and is
 * never pushed back, so a list whose chats change status all the time still
 * redraws every 300 ms instead of never.
 */
export const REFRESH_COALESCE_MS = 300;
/**
 * The longest a reveal waits for the editor to ask again for a refreshed
 * repo row's session rows. The editor never asks for a collapsed row's
 * children, so a collapse it did not report would otherwise hold every
 * reveal until the user expanded that repo again.
 */
export const CHILDREN_AWAIT_TIMEOUT_MS = 1500;
const ROW_COMMAND_PREFIX = '_pitwall.row.';
/**
 * Before a repository's first listing this session, a background listing
 * may reuse one the session scan made this recently (and vice versa).
 */
const RECENT_LISTING_MS = 15_000;
/**
 * Background listings start after the list's first render; while the list
 * stays hidden, after this long anyway.
 */
const HIDDEN_LIST_LISTING_MS = 3_000;
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

  /**
   * Take a newer drawing of the same row. An element refresh must name the
   * object the editor already holds, so a changed row is updated in place.
   */
  assign(from: WorkspaceTreeItem): void {
    Object.assign(this, {
      label: from.label,
      description: from.description,
      tooltip: from.tooltip,
      tooltipHeader: from.tooltipHeader,
      iconPath: from.iconPath,
      contextValue: from.contextValue,
      collapsibleState: from.collapsibleState,
      command: from.command,
      data: from.data,
    });
  }
}

/**
 * The command a row's click and Enter run: one id per row, with no
 * arguments. The editor turns a tree command that has arguments into a
 * cached id and drops that id when the row is refreshed, so a click on a
 * row drawn before a refresh ran nothing ("Actual command not found,
 * wanted to execute pitwall.openChat /4105"). A command with no arguments
 * is passed through as is and works from any drawing of the row. The
 * leading underscore keeps it out of the keyboard-shortcuts list.
 */
export function rowCommandId(rowId: string): string {
  return `${ROW_COMMAND_PREFIX}${rowId}`;
}

/** What a row shows: two drawings with the same key look the same. */
export function rowKey(item: vscode.TreeItem): string {
  const tooltip = typeof item.tooltip === 'string' ? item.tooltip : item.tooltip?.value;
  const label = typeof item.label === 'string' ? item.label : item.label?.label;
  return JSON.stringify([label, item.description, tooltip, item.contextValue, item.collapsibleState, iconKey(item.iconPath)]);
}

function iconKey(icon: vscode.TreeItem['iconPath']): string | undefined {
  if (!icon) {
    return undefined;
  }
  if (icon instanceof vscode.ThemeIcon) {
    return `theme:${icon.id}`;
  }
  if (typeof icon === 'object' && 'light' in icon) {
    return `${String(icon.light)}|${String(icon.dark)}`;
  }
  return String(icon);
}

/** A row as last handed to the editor: the object it holds and what it showed then. */
interface RenderedRow {
  item: WorkspaceTreeItem;
  key: string;
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

/** What the tree needs from one window in the registry (ADR 0020): its folder and the chats it has open. */
export interface WindowView {
  folder: string | undefined;
  openSessionIds: readonly string[];
}

/**
 * The repo row's context value: `.hasWindow` flips its menu to "Bring its
 * window forward" (§3b), and `.sideBySide` (with a window, and 2+ of its
 * chats open there) adds "Show its open chats side by side" (Q15).
 */
export function repoContextValue(isGit: boolean, hasWindow: boolean, canSplit = false): string {
  return `${isGit ? 'repository' : 'folderRepository'}${hasWindow ? '.hasWindow' : ''}${hasWindow && canSplit ? '.sideBySide' : ''}`;
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
 *
 * A redraw request never refreshes the whole list by itself. Each pass
 * compares the rows it would draw with the rows the editor holds: nothing
 * changed fires nothing; changed rows in the same places are refreshed one
 * by one; only repo rows added, removed or moved refresh the whole list.
 */
export class WorkspacesTreeProvider implements vscode.TreeDataProvider<WorkspaceTreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<WorkspaceTreeItem[] | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  /** The repo rows the editor holds, in order; unset from a full refresh until it asks for them again. */
  private renderedRoots: RenderedRow[] | undefined;
  /** The session rows the editor holds, by their repo row's id; only expanded repos have any. */
  private readonly renderedChildren = new Map<string, RenderedRow[]>();
  /** A full refresh fired and the editor has not asked for the repo rows since. */
  private fullRefreshOutstanding = false;
  /** Bumped by every full refresh. */
  private fullRefreshEpoch = 0;
  /** Session-row requests from the editor still being answered. */
  private childRendersInFlight = 0;
  /**
   * Expanded repo rows refreshed by a pass, until the editor asks for their
   * session rows again: a reveal waits for those, as it waits for the render
   * after a full refresh.
   */
  private readonly childrenAwaited = new Set<string>();
  /** Bumped by every redraw request, so a pass settles waiters only when none came in during it. */
  private requestGeneration = 0;
  private flushTimer: NodeJS.Timeout | undefined;
  private flushing = false;
  private flushAgain = false;
  /** A full refresh was held for a reveal (L1). */
  private heldFull = false;
  /** Gives up waiting on `childrenAwaited` (see `CHILDREN_AWAIT_TIMEOUT_MS`). */
  private childrenAwaitTimer: NodeJS.Timeout | undefined;
  /** Row click commands, by command id (see `rowCommandId`). */
  private readonly rowCommands = new Map<string, vscode.Disposable>();
  /** The on-screen order before the latest move, for a click aimed at it (D21, see `aimedClick.ts`). */
  private readonly clicks = new AimedClicks<WorkspaceTreeItem>();
  /** Selects a row in the tree view; set by `bindSelection`. */
  private selectRow: ((row: WorkspaceTreeItem) => void) | undefined;

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
  /**
   * Settles when background listings may start: after the first render, in
   * a task of its own so the rows reach the workbench first. Starting git
   * costs the extension host a moment per process (much more on a slow
   * Windows machine), so none starts before the rows are out (E16).
   */
  private readonly backgroundListingsMayStart: Promise<void>;
  private hiddenListTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  private turnStateProvider: (chatId: string) => TurnState | undefined = () => undefined;
  private needsYouProvider: (chatId: string) => boolean = () => false;
  private chatOpenProvider: (chat: ChatSession) => boolean;
  private statusSource: StatusSource | undefined;
  private statusSubscription: vscode.Disposable | undefined;
  private view: Pick<vscode.TreeView<WorkspaceTreeItem>, 'description' | 'badge'> | undefined;
  /** Every live Pitwall window, from the registry; empty until it reports. */
  private windows: readonly WindowView[] = [];
  /** Sessions open as a tab in any window (Q12). */
  private openAnywhere = new Set<string>();

  /** Inbox order, recomputed only on a status change or a row added or removed (P6). */
  private sortDirty = true;
  private membershipKey: string | undefined;
  private repoOrder: string[] = [];
  private readonly sessionOrder = new Map<string, string[]>();
  private firstRenderLogged = false;

  private repoWatchers: vscode.Disposable[] = [];
  /** Set after the first render; until then no repo watcher is made. */
  private watchersMayStart = false;
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
    this.backgroundListingsMayStart = new Promise<void>((resolve) => {
      this.hiddenListTimer = setTimeout(resolve, HIDDEN_LIST_LISTING_MS);
      void this.whenSettled().then(() => setImmediate(resolve));
    }).then(() => clearTimeout(this.hiddenListTimer));
    // The git watchers (three per repo) are made once the rows are out, not
    // during activation: a window's start does nothing per repo before its
    // first render (E16, I3).
    void this.backgroundListingsMayStart.then(() => {
      this.watchersMayStart = true;
      if (!this.disposed) {
        this.updateRepoWatchers(true);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.scanTimer);
    clearTimeout(this.hiddenListTimer);
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    clearTimeout(this.childrenAwaitTimer);
    this.childrenAwaitTimer = undefined;
    this.onGitChange.cancel();
    this.clicks.dispose();
    this.statusSubscription?.dispose();
    for (const disposable of [...this.disposables, ...this.repoWatchers, ...this.rowCommands.values()]) {
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

  /**
   * The tree view's selection, through the aimed-row rule (D21): a mouse
   * click that lands on a row which has just moved opens the row that sat in
   * that slot before the move, and that row is the one selected. Every other
   * selection reaches `apply` as the view reported it (a possible click is
   * held for at most `CLICK_PAIR_MS` first).
   */
  bindSelection(
    view: Pick<vscode.TreeView<WorkspaceTreeItem>, 'reveal' | 'onDidChangeSelection'>,
    apply: (event: { selection: readonly WorkspaceTreeItem[] }) => void
  ): vscode.Disposable {
    this.selectRow = (row) => {
      this.clicks.expectSelection(row.id!);
      void this.revealWhenSettled(() => view.reveal(row, { select: true, focus: false }));
    };
    return view.onDidChangeSelection(({ selection }) => this.clicks.select(selection, this.screenLayout(), apply));
  }

  /** Pitwall is about to select this row itself (a reveal): its selection is never taken for a click. */
  expectSelection(rowId: string | undefined): void {
    if (rowId) {
      this.clicks.expectSelection(rowId);
    }
  }

  /** A keyboard move is about to select and open a row: never taken for a click. */
  expectKeyboardSelection(): void {
    this.clicks.expectKeyboardSelection();
  }

  /**
   * The rows the screen shows, top to bottom: each repo row, then the session
   * rows of each expanded one (a collapsed repo's take no slot). Undefined
   * while a redraw is on its way to the editor, when the screen may show
   * rows the provider no longer holds.
   */
  private screenLayout(): string[] | undefined {
    if (!this.renderedRoots || this.fullRefreshOutstanding || this.childrenAwaited.size > 0) {
      return undefined;
    }
    const ids: string[] = [];
    for (const root of this.renderedRoots) {
      ids.push(root.item.id!);
      for (const child of this.renderedChildren.get(root.item.id!) ?? []) {
        ids.push(child.item.id!);
      }
    }
    return ids;
  }

  /** The row object the editor holds for an id. */
  private heldRow(rowId: string): WorkspaceTreeItem | undefined {
    for (const rows of [this.renderedRoots ?? [], ...this.renderedChildren.values()]) {
      const found = rows.find((row) => row.item.id === rowId);
      if (found) {
        return found.item;
      }
    }
    return undefined;
  }

  /** Live turn state for the legacy marks, used only without a status source. */
  setTurnStateProvider(provider: (chatId: string) => TurnState | undefined): void {
    this.turnStateProvider = provider;
  }

  /** Whether a chat is waiting on the user, used only without a status source. */
  setNeedsYouProvider(provider: (chatId: string) => boolean): void {
    this.needsYouProvider = provider;
  }

  /**
   * The live windows from the registry: a repo row counts its single-folder
   * windows (` · {k} windows`, Q17), flips its menu when its main folder has
   * one, and ` · open` covers tabs in any window (Q12).
   */
  setWindows(windows: readonly WindowView[]): void {
    this.windows = windows;
    this.openAnywhere = new Set(windows.flatMap((window) => window.openSessionIds));
    this.softRefresh();
  }

  /** Open in this window (a terminal or a tab) or as a tab in any other (Q12). */
  isOpenAnywhere(chat: ChatSession): boolean {
    return this.chatOpenProvider(chat) || chatNativeSessionIds(chat).some((id) => this.openAnywhere.has(id));
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
   * fails. A row refresh clears that row's children the same way, so it is
   * held too. When the last reveal ends, a held full refresh fires once; a
   * held row refresh runs as a new pass.
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
        if (this.heldFull) {
          this.heldFull = false;
          this.fireFull();
        } else {
          this.scheduleFlush();
        }
      }
    }
  }

  /**
   * Fire a full refresh now, or, while a reveal is in flight, once it ends.
   * The editor drops every row it holds, so nothing is compared against
   * until it asks for the rows again.
   */
  private fireFull(): void {
    this.renderPending = true;
    if (this.revealsInFlight > 0) {
      this.refreshHeld = true;
      this.heldFull = true;
      return;
    }
    // What the screen shows until the editor has the new rows, and which rows it will ask for.
    this.clicks.willRedraw(this.screenLayout(), true, new Set([...this.renderedChildren.keys(), ...this.childrenAwaited]));
    this.fullRefreshOutstanding = true;
    this.fullRefreshEpoch += 1;
    this.renderedRoots = undefined;
    this.renderedChildren.clear();
    this.childrenAwaited.clear();
    clearTimeout(this.childrenAwaitTimer);
    this.childrenAwaitTimer = undefined;
    this.changeEmitter.fire(undefined);
  }

  /** Re-render and re-list worktrees: always a full refresh. */
  refresh(): void {
    this.renderPending = true;
    this.pendingCacheClear = true;
    this.requestGeneration += 1;
    this.scheduleFlush();
  }

  /** Re-render rows from storage, keeping the worktree cache: only what changed is refreshed. */
  softRefresh(): void {
    this.renderPending = true;
    this.requestGeneration += 1;
    this.scheduleFlush();
  }

  /** Join the pass already waiting, or open a new window (`REFRESH_COALESCE_MS`). */
  private scheduleFlush(): void {
    if (this.disposed) {
      return;
    }
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, REFRESH_COALESCE_MS);
  }

  private async flush(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.flushing = true;
    const generation = this.requestGeneration;
    let completed = false;
    try {
      let full = false;
      if (this.pendingCacheClear) {
        // The old listings still answer lookups; the next render lists again.
        this.pendingCacheClear = false;
        this.listed.clear();
        this.listingGeneration += 1;
        full = true;
      }
      this.updateRepoWatchers();
      completed = await this.applyChanges(full);
    } catch (error) {
      console.error('[Pitwall] Could not redraw the Repos list:', error);
    } finally {
      this.flushing = false;
      if (this.flushAgain) {
        this.flushAgain = false;
        this.scheduleFlush();
      } else if (completed && generation === this.requestGeneration && this.childrenAwaited.size === 0 && this.isQuiet()) {
        // The editor's rows are up to date without a render from it.
        this.settle();
      }
    }
  }

  /**
   * One pass: fire the smallest change that brings the editor's rows up to
   * date. Returns true when it compared and fired at most row refreshes;
   * false when it fired a full refresh, was held, or must run again.
   */
  private async applyChanges(full: boolean): Promise<boolean> {
    if (this.revealsInFlight > 0) {
      this.refreshHeld = true;
      this.heldFull ||= full;
      return false;
    }
    const rendered = this.renderedRoots;
    if (full || !rendered) {
      // A full refresh already on its way reads the state when the editor asks.
      if (full || !this.fullRefreshOutstanding) {
        this.fireFull();
      }
      return false;
    }
    const roots = this.rootRows();
    if (roots.length !== rendered.length || roots.some((row, index) => row.id !== rendered[index].item.id)) {
      this.fireFull();
      return false;
    }

    // The expanded repos' session rows, drawn again.
    const byWorktree = this.chatsByWorktree();
    const wanted = new Map<string, WorkspaceTreeItem[]>();
    const childrenBefore = new Map(this.renderedChildren);
    for (const rowId of childrenBefore.keys()) {
      const root = rendered.find((row) => row.item.id === rowId);
      const repo = root && this.storageService.getRepository((root.item.data as Repository).id);
      if (repo) {
        wanted.set(rowId, await this.sessionRowsOf(this.repoEntry(repo, byWorktree)));
      }
    }
    // The editor asked for rows while this pass drew: compare against those in a new pass.
    const stale =
      this.disposed ||
      this.renderedRoots !== rendered ||
      this.fullRefreshOutstanding ||
      this.childRendersInFlight > 0 ||
      [...childrenBefore].some(([rowId, held]) => this.renderedChildren.get(rowId) !== held);
    if (stale) {
      this.flushAgain = true;
      return false;
    }
    if (this.revealsInFlight > 0) {
      this.refreshHeld = true;
      return false;
    }

    const changed: WorkspaceTreeItem[] = [];
    // What the screen shows before this pass, for a click aimed at it.
    const layout = this.screenLayout();
    roots.forEach((row, index) => {
      const held = rendered[index];
      const key = rowKey(row);
      if (key !== held.key) {
        held.item.assign(row);
        held.key = key;
        changed.push(held.item);
        // A repo row's refresh redraws its session rows too.
        if (this.renderedChildren.has(row.id!)) {
          this.clicks.willRedraw(layout, false, [row.id!]);
          this.renderedChildren.delete(row.id!);
          this.childrenAwaited.add(row.id!);
        }
      }
    });
    for (const [rowId, rows] of wanted) {
      const held = this.renderedChildren.get(rowId);
      if (!held) {
        continue;
      }
      const repoRow = rendered.find((row) => row.item.id === rowId)!;
      if (rows.length !== held.length || rows.some((row, index) => row.id !== held[index].item.id)) {
        // Rows added, removed or moved under this repo: refresh the repo row.
        changed.push(repoRow.item);
        this.clicks.willRedraw(layout, false, [rowId]);
        this.renderedChildren.delete(rowId);
        this.childrenAwaited.add(rowId);
        continue;
      }
      rows.forEach((row, index) => {
        const key = rowKey(row);
        if (key !== held[index].key) {
          held[index].item.assign(row);
          held[index].key = key;
          changed.push(held[index].item);
        }
      });
    }
    if (changed.length > 0) {
      this.changeEmitter.fire(changed);
    }
    if (this.childrenAwaited.size > 0) {
      this.armChildrenAwaitTimer();
    }
    return true;
  }

  /**
   * Stop waiting for the session rows of repos the editor has not asked
   * about within `CHILDREN_AWAIT_TIMEOUT_MS`. Armed once and never pushed
   * back, so a list that keeps changing cannot hold reveals forever.
   */
  private armChildrenAwaitTimer(): void {
    if (this.childrenAwaitTimer || this.disposed) {
      return;
    }
    this.childrenAwaitTimer = setTimeout(() => {
      this.childrenAwaitTimer = undefined;
      if (this.childrenAwaited.size === 0) {
        return;
      }
      this.childrenAwaited.clear();
      // Rows the editor never asked for: what the screen shows is unsure.
      this.clicks.forget();
      if (this.isQuiet()) {
        this.settle();
      }
    }, CHILDREN_AWAIT_TIMEOUT_MS);
  }

  /**
   * The user collapsed a row (`TreeView.onDidCollapseElement`). The editor
   * keeps no session rows under a collapsed repo and never asks for them on
   * a refresh, so they are neither compared against nor waited for until the
   * repo is expanded again, when the editor asks for them afresh.
   */
  onRowCollapsed(item: WorkspaceTreeItem): void {
    if (item.itemType !== 'repository' || !item.id) {
      return;
    }
    this.renderedChildren.delete(item.id);
    // The user changed what the list shows: a click now aims at the rows as they are.
    this.clicks.forget();
    if (this.stopAwaiting(item.id) && this.renderPending && this.isQuiet()) {
      this.settle();
    }
  }

  /** Stop waiting for one repo row's session rows; true when that was the last one awaited. */
  private stopAwaiting(rowId: string): boolean {
    if (!this.childrenAwaited.delete(rowId) || this.childrenAwaited.size > 0) {
      return false;
    }
    clearTimeout(this.childrenAwaitTimer);
    this.childrenAwaitTimer = undefined;
    return true;
  }

  /** No redraw waiting, running, held or on its way to the editor. */
  private isQuiet(): boolean {
    return !this.flushTimer && !this.flushing && !this.refreshHeld && !this.fullRefreshOutstanding;
  }

  /** Resolve every `whenSettled` waiter. */
  private settle(): void {
    this.renderPending = false;
    this.pruneRowCommands();
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  /**
   * Dispose the click commands of rows whose chat or repo is gone. Runs only
   * once the editor's rows are up to date, so no row it still shows loses
   * its command.
   */
  private pruneRowCommands(): void {
    const shown = new Set<string | undefined>((this.renderedRoots ?? []).map((row) => row.item.id));
    for (const rows of this.renderedChildren.values()) {
      rows.forEach((row) => shown.add(row.item.id));
    }
    for (const [command, registration] of this.rowCommands) {
      const rowId = command.slice(ROW_COMMAND_PREFIX.length);
      if (!shown.has(rowId) && !this.rowExists(rowId)) {
        registration.dispose();
        this.rowCommands.delete(command);
      }
    }
  }

  /** Whether the chat or repo a row id names is still stored. */
  private rowExists(rowId: string): boolean {
    if (rowId.startsWith('chat-')) {
      return this.storageService.getChat(rowId.slice('chat-'.length)) !== undefined;
    }
    if (rowId.startsWith('repository-')) {
      return this.storageService.getRepository(rowId.slice('repository-'.length)) !== undefined;
    }
    return true;
  }

  /** A row's click command (see `rowCommandId`), registered the first time the row is drawn. */
  private rowCommand(rowId: string, title: string, run: () => Thenable<unknown> | undefined): vscode.Command {
    const command = rowCommandId(rowId);
    if (!this.rowCommands.has(command) && !this.disposed) {
      this.rowCommands.set(command, vscode.commands.registerCommand(command, run));
    }
    return { command, title };
  }

  /**
   * A row's click or Enter. A mouse click that newly selected a row which has
   * just moved opens the row that sat in its slot before the move (D21); that
   * row is selected and applied instead. Anything else runs the row's own action.
   */
  private clickRow(rowId: string, open: () => Thenable<unknown> | undefined): Thenable<unknown> | undefined {
    const held = this.clicks.claim(rowId);
    if (!held) {
      return open();
    }
    const aimed = this.heldRow(held.aimed);
    if (!aimed) {
      held.apply({ selection: held.selection });
      return open();
    }
    logOperation(`[Pitwall] click landed on ${rowId} just after a re-sort; opening ${held.aimed}, the row it was aimed at`);
    held.apply({ selection: [aimed] });
    this.selectRow?.(aimed);
    return aimed.itemType === 'chat'
      ? this.openChatRow((aimed.data as ChatSession).id)
      : this.openRepoRow((aimed.data as Repository).id);
  }

  /** A chat row's click: open the chat as stored now; a chat removed since does nothing. */
  private openChatRow(chatId: string): Thenable<unknown> | undefined {
    const chat = this.storageService.getChat(chatId);
    if (!chat || !this.harnessRegistry.has(chat.harness)) {
      return undefined;
    }
    return vscode.commands.executeCommand('pitwall.openChat', this.getChatTreeItem(chat));
  }

  /** A repo row's click: open its chats as stored now; a repo removed since does nothing. */
  private openRepoRow(repoId: string): Thenable<unknown> | undefined {
    const repo = this.storageService.getRepository(repoId);
    if (!repo) {
      return undefined;
    }
    return vscode.commands.executeCommand(
      'pitwall.openRepoChats',
      this.repositoryItem(repo, vscode.TreeItemCollapsibleState.Collapsed)
    );
  }

  /**
   * Watch each root's HEADs (branch switches) and `.git` itself (`git init`
   * or its removal). Rebuilt only when the set of roots changes, or when
   * `.git` appears or disappears, since the HEAD patterns need it to exist.
   */
  private updateRepoWatchers(force = false): void {
    if (!this.watchersMayStart) {
      return;
    }
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
      // What the editor holds from now on; its old session rows are gone.
      this.renderedRoots = rows.map((item) => ({ item, key: rowKey(item) }));
      this.renderedChildren.clear();
      this.fullRefreshOutstanding = false;
      this.clicks.fetched(undefined, false, () => this.screenLayout());
      this.settle();
      if (!this.firstRenderLogged) {
        this.firstRenderLogged = true;
        logOperation('[Pitwall] first render');
      }
      return rows;
    }
    if (element.itemType === 'repository') {
      this.childRendersInFlight += 1;
      const epoch = this.fullRefreshEpoch;
      try {
        const rows = await this.sessionRowsOfRepoRow(element);
        // An answer a full refresh overtook is one the editor drops.
        if (element.id && epoch === this.fullRefreshEpoch) {
          this.renderedChildren.set(element.id, rows.map((item) => ({ item, key: rowKey(item) })));
          const redrawn = this.childrenAwaited.has(element.id);
          const settled = this.stopAwaiting(element.id);
          this.clicks.fetched(element.id, redrawn, () => this.screenLayout());
          if (settled && this.isQuiet()) {
            this.settle();
          }
        }
        return rows;
      } finally {
        this.childRendersInFlight -= 1;
      }
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

  /**
   * A repo row's session rows as the list draws them, for a caller that is
   * not the editor (search): the editor's own rows are left as they are.
   */
  async sessionRowsOfRepoRow(repoRow: WorkspaceTreeItem): Promise<WorkspaceTreeItem[]> {
    const repo = repoRow.data as Repository;
    await this.awaitRelistings([repo]);
    return this.sessionRowsOf(this.repoEntry(repo, this.chatsByWorktree()));
  }

  private sessionRowsOf(entry: RepoEntry): Promise<WorkspaceTreeItem[]> {
    return this.sessionRows(entry, this.orderedSessions(entry));
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
    const windows = this.windows.filter((window) => window.folder !== undefined && samePath(window.folder, repo.rootPath));
    const open = new Set(windows.flatMap((window) => window.openSessionIds));
    const canSplit =
      windows.length > 0 &&
      this.mainChatsOf(repo).filter((chat) => chatNativeSessionIds(chat).some((id) => open.has(id))).length >= 2;
    return new WorkspaceTreeItem(repo.name, state, 'repository', repo, repoContextValue(isGit, windows.length > 0, canSplit));
  }

  /**
   * A repo's main-folder sidebar chats, newest first (Q5). Worktree chats are
   * not here: a repo click leaves them to their own windows.
   */
  mainChatsOf(repo: Repository): ChatSession[] {
    return this.repoEntry(repo, this.chatsByWorktree())
      // A chat still starting (no session id yet) has no transcript to open.
      .sessions.filter((session) => session.worktree.isMain && session.chat.harnessSessionId && !session.chat.pendingUiLaunch)
      .map((session) => session.chat)
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
  }

  /** How many single-folder windows show the repo's main folder or one of its worktrees. */
  private windowCount(repo: Repository): number {
    const roots = [repo.rootPath, ...this.getRepoWorktrees(repo).worktrees.map((worktree) => worktree.path)];
    return this.windows.filter((window) => window.folder !== undefined && roots.some((root) => samePath(root, window.folder!))).length;
  }

  private repositoryRow(entry: RepoEntry, position: number): WorkspaceTreeItem {
    const { repo, sessions } = entry;
    const item = this.repositoryItem(
      repo,
      sessions.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    const needs = sessions.filter((session) => session.status === 'needs').length;
    const open = sessions.filter((session) => this.isOpenAnywhere(session.chat)).length;
    const windows = this.windows.length > 0 ? this.windowCount(repo) : 0;
    item.description = `${repoSummary(needs, open, sessions.length)}${windows > 1 ? ` · ${windows} windows` : ''}`;
    item.tooltip = repoTooltip(repo.name, position);
    // A click or Enter opens the repo's chats as tabs (rows 4.3, 4.4); the twistie only expands.
    // Through the row's own argument-free command, so a refresh cannot drop the click.
    item.command = this.rowCommand(item.id!, 'Open Chats', () => this.clickRow(item.id!, () => this.openRepoRow(repo.id)));
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

  /**
   * Queue a background listing. It starts once the first render is out (see
   * `backgroundListingsMayStart`), never inside activation or the caller.
   */
  private listInBackground(repo: Repository): void {
    if (this.listingQueued.has(repo.id) || this.listings.get(repo.id)?.generation === this.listingGeneration) {
      return;
    }
    this.listingQueued.add(repo.id);
    void this.backgroundListingsMayStart.then(() =>
      setImmediate(() => {
        this.listingQueued.delete(repo.id);
        if (!this.disposed && !this.listed.has(repo.id)) {
          void this.listWorktrees(repo, false);
        }
      })
    );
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
      // Starring lives in the right-click menu, so the row carries the mark.
      const star = starredIds.has(chat.id) ? '★ ' : '';
      item.description = `${star}${branch}${statusLine}${this.isOpenAnywhere(chat) ? ' · open' : ''}`;

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
      // Through the row's own argument-free command, so a refresh cannot drop the click.
      item.command = this.rowCommand(item.id!, 'Open Chat', () => this.clickRow(item.id!, () => this.openChatRow(chat.id)));
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

  /**
   * A chat's worktree without waiting on git: the one the listings (or the
   * stored snapshots) already know, else the one a stored repo's id and
   * `folder` derive (a worktree's id is derived from both), so a window a
   * handoff started in a linked worktree opens its chats without a listing.
   */
  worktreeWithoutGit(worktreeIdOfChat: string, folder: string): Worktree | undefined {
    const known = this.getWorktreeById(worktreeIdOfChat);
    if (known) {
      return known;
    }
    const repo = this.storageService.getRepositories().find((candidate) => worktreeId(candidate.id, folder) === worktreeIdOfChat);
    return repo
      ? { id: worktreeIdOfChat, repoId: repo.id, name: path.basename(folder), path: folder, isMain: samePath(repo.rootPath, folder) }
      : undefined;
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

  /**
   * The repo whose worktree holds `filePath` (the deepest worktree wins, so a
   * nested repo beats the one around it), for FILES messages.
   */
  repoContaining(filePath: string): Repository | undefined {
    return this.deepestRootContaining(filePath)?.repo;
  }

  /** The folders a worktree's repo owns: its main folder and every worktree, never waiting on git. */
  rootsOf(worktree: Worktree): string[] {
    const repo = this.storageService.getRepository(worktree.repoId);
    if (!repo) {
      return [worktree.path];
    }
    return [repo.rootPath, ...this.getRepoWorktrees(repo).worktrees.map((candidate) => candidate.path)];
  }

  /** The deepest root holding `filePath`: a repo's main folder or one of its worktrees (Q25). */
  deepestRootContaining(filePath: string): { path: string; repo: Repository } | undefined {
    const roots = this.storageService
      .getRepositories()
      .flatMap((repo) => [{ path: repo.rootPath, repo }, ...this.getRepoWorktrees(repo).worktrees.map((worktree) => ({ path: worktree.path, repo }))]);
    return deepestContainingRoot(roots, filePath);
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
    // Never start git inside the caller's task, which may be activation; a
    // lookup that is not urgent waits until the first render is out.
    await (urgent ? new Promise((resolve) => setImmediate(resolve)) : this.backgroundListingsMayStart);
    // A hard refresh mid-flight discards the listing it waited on, leaving
    // the repository unlisted: look again, as `whenListed` does.
    for (let round = 0; round < 5 && !this.disposed; round++) {
      const pending = this.storageService.getRepositories().filter((repo) => !this.listed.has(repo.id));
      if (pending.length === 0) {
        break;
      }
      await Promise.all(pending.map((repo) => this.listWorktrees(repo, urgent)));
      const listed = this.findWorktree(predicate);
      if (listed) {
        return listed;
      }
    }
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
