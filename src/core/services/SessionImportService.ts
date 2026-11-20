import * as vscode from 'vscode';
import { ChatSession, HarnessId, Worktree } from '../types';
import { HarnessRegistry } from '../harness/HarnessRegistry';
import { HarnessAdapter, HarnessSession } from '../harness/types';
import {
  DEFAULT_CHAT_NAME,
  findClaimableSession,
  hasDefaultName,
  harnessSessionKey,
  snapshotSessionIds,
} from '../harness/sessionUtils';
import { deepestContainingRoot, samePath } from '../utils/paths';
import { truncateName } from '../utils/text';
import { Scope, WorktreeCatalog } from './WorktreeCatalog';
import { StorageService, importedChatId } from './StorageService';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A new UI placeholder links quickly; after this it moves to the slow scan. */
const HOT_WINDOW_MS = 5 * 60 * 1000;
/** A placeholder that never gets a session stops being polled after this. */
const PENDING_LINK_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The 60 s discovery scan: it also refreshes closed chats' row status (QA S5). */
const DEFAULT_SCAN_INTERVAL_MS = 60 * 1000;
const DEFAULT_HOT_SCAN_INTERVAL_MS = 3_000;
const MAX_IMPORTS_PER_SCAN = 50;
/**
 * Listing worktrees costs one synchronous `git` call per repository, and the
 * hot scan runs every few seconds. Sessions created inside this window are
 * imported by the next scan.
 */

export interface SessionImportSettings {
  enabled: boolean;
  retentionDays: number;
}

export interface SessionImportEvent {
  imported: number;
  linked: number;
  renamed: number;
  /** Rows moved to the worktree that owns their session. */
  relocated: number;
  removed: string[];
}

export interface SessionImportServiceOptions {
  scanIntervalMs?: number;
  hotScanIntervalMs?: number;
  /** A live terminal or open native-UI tab must not be pruned. */
  isChatOpen?: (chat: ChatSession) => boolean;
  /**
   * Whether anyone can see the rows right now. The slow discovery pass is
   * skipped while the tree is hidden, so an idle window spawns no harness
   * processes; a launch that is still linking always scans.
   */
  isVisible?: () => boolean;
  onChatsChanged?: (event: SessionImportEvent) => void;
  /**
   * Every session a full scan listed, with its turn state. Rows of chats the
   * attention tick does not poll take their status from this (QA S5).
   */
  onSessionsListed?: (sessions: HarnessSession[]) => void;
  /** Settings are read per scan so a change applies without a reload. */
  readSettings?: () => SessionImportSettings;
}

/** What `importLive` did with each live session it was asked about. */
export interface LiveImportResult {
  /** Nothing to import yet (no transcript, or no line that places it): worth asking again. */
  retry: string[];
  /** Placed in a folder no listed repository holds: discovery's to find. */
  unplaced: string[];
  /** No installed adapter reads one session by itself: only a full scan can list it. */
  unsupported: string[];
}

interface PendingUiExpectation {
  harness: HarnessId;
  worktreePath: string;
  since: number;
  knownSessionIds: Set<string>;
  bindSurface: boolean;
}

interface ChatIndex {
  byId: Map<string, ChatSession>;
  linked: Map<HarnessId, Set<string>>;
  pending: Map<HarnessId, Set<string>>;
  removedKeys: Set<string>;
}

/**
 * Reconciles Pitwall chats with the native sessions on disk.
 *
 * Pitwall-started sessions are linked by their harness watcher, but two cases
 * have no chosen ID: a session started in the agent's VS Code UI, and a
 * session started outside Pitwall entirely. This service covers both.
 *
 * It also imports recent native sessions automatically and ages out quiet rows
 * on the retention setting, keeping starred and open chats.
 * All work is asynchronous and bounded by a timer that stops when there is
 * nothing left to do.
 */
export class SessionImportService implements vscode.Disposable {
  private readonly scanIntervalMs: number;
  private readonly hotScanIntervalMs: number;
  private readonly isChatOpen: (chat: ChatSession) => boolean;
  private readonly isVisible: () => boolean;
  private readonly onChatsChanged: (event: SessionImportEvent) => void;
  private readonly onSessionsListed: (sessions: HarnessSession[]) => void;
  private readonly readSettings: () => SessionImportSettings;

  private readonly expectations = new Map<string, PendingUiExpectation>();
  private readonly configListener: vscode.Disposable;
  private timer: NodeJS.Timeout | undefined;
  private timerIntervalMs: number | undefined;
  private started = false;
  private scanning = false;
  /** A wake that arrived mid-scan; the scan runs again when it ends. */
  private wakeQueued = false;
  /** A refresh asked for a full pass; the next scan runs one even while hot or hidden. */
  private fullQueued = false;
  /** Targeted imports waiting for the scan in progress to end. */
  private readonly scanEnded: Array<() => void> = [];
  private disposed = false;

  constructor(
    private readonly storageService: StorageService,
    private readonly catalog: WorktreeCatalog,
    private readonly harnessRegistry: HarnessRegistry,
    options: SessionImportServiceOptions = {}
  ) {
    this.scanIntervalMs =
      options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.hotScanIntervalMs =
      options.hotScanIntervalMs ?? DEFAULT_HOT_SCAN_INTERVAL_MS;
    this.isChatOpen = options.isChatOpen ?? (() => false);
    this.isVisible = options.isVisible ?? (() => true);
    this.onChatsChanged = options.onChatsChanged ?? (() => undefined);
    this.onSessionsListed = options.onSessionsListed ?? (() => undefined);
    this.readSettings =
      options.readSettings ??
      (() => {
        const config = vscode.workspace.getConfiguration('pitwall');
        const days = Number(config.get<number>('autoImport.retentionDays', 14));
        return {
          enabled: config.get<boolean>('autoImport.enabled', true),
          retentionDays:
            Number.isFinite(days) && days >= 1 ? Math.floor(days) : 7,
        };
      });

    this.configListener = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration('pitwall.autoImport')) {
          this.schedule();
          this.wake();
        }
      }
    );
  }

  /**
   * Start scanning. The first scan waits for `firstRender` (the list's first
   * render), so neither activation nor that render waits on it (E16).
   */
  start(firstRender: PromiseLike<unknown> = Promise.resolve()): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    // Restoring a launch needs the worktrees, one git call per repository,
    // listed without blocking; skip it when no chat is waiting for a UI
    // session.
    if (this.storageService.getChats().some((chat) => chat.pendingUiLaunch && !chat.harnessSessionId)) {
      void this.catalog.scopesAsync(true).then(
        (scopes) => {
          if (this.disposed) {
            return;
          }
          this.restorePendingUiExpectations(scopes, this.storageService.getChats());
          this.schedule();
          this.wake();
        },
        (error) => console.error('[SessionImportService] Could not restore UI launches:', error)
      );
    }
    this.schedule();
    void Promise.resolve(firstRender).then(
      () => this.wake(),
      (error) => console.error('[SessionImportService] Scanning did not start:', error)
    );
  }

  /**
   * Record a chat whose session will be created by its native UI. The
   * snapshot is taken before the UI opens, so only a session that appears
   * afterwards can be claimed. It is persisted too, so a reload between the
   * launch and the first prompt cannot make the placeholder claim an older
   * session in the same worktree.
   */
  async expectChat(
    chatId: string,
    worktreePath: string,
    options: { bindSurface?: boolean } = {}
  ): Promise<void> {
    const chat = this.storageService.getChat(chatId);
    if (!chat || chat.harnessSessionId || !chat.pendingUiLaunch) {
      return;
    }

    const snapshot = await this.snapshotSessions(chat.harness, worktreePath);
    const knownSessionIds = new Set(snapshot ?? []);

    // The user may have started this chat in a terminal while the listing was
    // in flight; that launch owns the linkage now.
    const latest = this.storageService.getChat(chatId);
    if (!latest || latest.harnessSessionId || !latest.pendingUiLaunch) {
      return;
    }

    this.expectations.set(chatId, {
      harness: chat.harness,
      worktreePath,
      since: Date.now(),
      knownSessionIds,
      bindSurface: options.bindSurface ?? true,
    });
    if (snapshot) {
      this.storageService.updateChat(chatId, {
        pendingUiKnownSessionIds: snapshot,
      });
    }
    this.schedule();
  }

  /**
   * Sessions that already exist before a UI launch. A listing failure must not
   * strand the placeholder: the `since` cutoff still keeps older sessions out,
   * so an empty snapshot is the safe fallback.
   */
  private async snapshotSessions(
    harness: HarnessId,
    worktreePath: string
  ): Promise<string[] | undefined> {
    try {
      const sessions = await this.harnessRegistry
        .get(harness)
        .listSessionsForWorktree(worktreePath, true);
      return snapshotSessionIds(sessions);
    } catch (error) {
      console.error(
        '[SessionImportService] Could not snapshot sessions before a UI launch:',
        error
      );
      return undefined;
    }
  }

  cancelExpectation(chatId: string): void {
    if (this.expectations.delete(chatId)) {
      this.schedule();
    }
    // The launch did not happen, so its snapshot must not outlive it.
    if (this.storageService.getChat(chatId)?.pendingUiKnownSessionIds) {
      this.storageService.updateChat(chatId, {
        pendingUiKnownSessionIds: undefined,
      });
    }
  }

  /**
   * Scan immediately, e.g. after a UI launch, a settings change or a newly
   * discovered repo. A wake during a scan runs one more scan after it, which
   * sees what changed meanwhile.
   */
  wake(): void {
    if (this.disposed) {
      return;
    }
    if (this.scanning) {
      this.wakeQueued = true;
      return;
    }
    void this.scan().catch((error) => {
      console.error('[SessionImportService] Scan failed:', error);
    });
  }

  /**
   * A full pass now, for a live session no row holds yet (Q31, N5): it runs
   * while a UI launch is linking, when a plain wake only polls that launch,
   * and while the list is hidden, since its pop-ups do not need the list in
   * view. The attention service asks at most once per session per window.
   */
  refresh(): void {
    this.fullQueued = true;
    this.wake();
  }

  /**
   * List live sessions no row holds, each read by itself (new-chat pickup):
   * the attention service asks as a session's turn starts, list hidden or
   * not, and a full scan would re-read every transcript of every repository
   * to find one. What it read goes to `onSessionsListed`, as a scan's
   * listing does (tab adoption titles, closed rows' turn state). Each session
   * goes through the same per-worktree steps as a full scan's (a waiting UI
   * launch claims it first, then the import with its tombstone, reservation,
   * retention and setting checks); where a launch or CLI chat is waiting,
   * those compare the worktree's whole listing, as the hot pass does.
   * Renames, relocation and retention pruning need every repository's
   * listing and stay with the scans. It runs between scans, never alongside
   * one.
   *
   * A live import is seen as of just before its latest prompt: its turn is
   * news (Q30), so a first turn that ended before it was listed still pops.
   */
  async importLive(sessionIds: readonly string[]): Promise<LiveImportResult> {
    const result: LiveImportResult = { retry: [], unplaced: [], unsupported: [] };
    while (this.scanning && !this.disposed) {
      await new Promise<void>((resolve) => this.scanEnded.push(resolve));
    }
    if (this.disposed || sessionIds.length === 0) {
      return result;
    }
    this.scanning = true;
    const event: SessionImportEvent = { imported: 0, linked: 0, renamed: 0, relocated: 0, removed: [] };
    try {
      const adapters = (await this.harnessRegistry.getInstalled()).filter((adapter) => adapter.getSession);
      if (adapters.length === 0) {
        result.unsupported.push(...sessionIds);
        return result;
      }
      const settings = this.readSettings();
      const now = Date.now();
      const scopes = await this.catalog.scopesAsync();
      const chats = this.storageService.getChats();
      this.restorePendingUiExpectations(scopes, chats);
      const index = this.buildIndex(chats);
      const allWorktrees = scopes.flatMap((scope) => scope.worktrees);
      const read: Array<{ adapter: HarnessAdapter; session: HarnessSession }> = [];
      for (const sessionId of sessionIds) {
        const found = await this.readLiveSession(adapters, sessionId);
        if (found) {
          read.push(found);
        } else {
          result.retry.push(sessionId);
        }
      }
      // As a scan does: tab adoption learns the titles (so a new chat's tab
      // binds), and closed rows their turn state.
      if (read.length > 0) {
        this.onSessionsListed(read.map((entry) => entry.session));
      }
      const groups = new Map<string, { adapter: HarnessAdapter; worktree: Worktree; sessions: HarnessSession[] }>();
      for (const { adapter, session } of read) {
        if (index.linked.get(adapter.id)?.has(session.sessionId)) {
          continue;
        }
        const worktree = deepestContainingRoot(allWorktrees, session.cwd);
        if (!worktree) {
          result.unplaced.push(session.sessionId);
          continue;
        }
        const key = `${adapter.id}\u0000${worktree.id}`;
        const group = groups.get(key) ?? { adapter, worktree, sessions: [] };
        group.sessions.push(session);
        groups.set(key, group);
      }
      for (const { adapter, worktree, sessions } of groups.values()) {
        // A launch waiting in this worktree compares candidates by creation
        // time: it must see the same list a scan would, the worktree's whole
        // listing, or it could claim the wrong session (QA on #73).
        const candidates = this.hasWaitingLaunch(adapter.id, worktree, index)
          ? await this.withWorktreeListing(adapter, worktree, sessions)
          : sessions;
        this.linkPendingUiLaunches(adapter, worktree, candidates, index, event);
        if (settings.enabled) {
          const asked = new Set(sessions.map((session) => session.sessionId));
          this.importRecentSessions(adapter, worktree, candidates, index, event, now, settings.retentionDays * DAY_MS, {
            only: asked,
            seenAt: (session) => (session.lastActivity ?? session.lastUpdated?.getTime() ?? now) - 1,
          });
        }
      }
    } catch (error) {
      console.error('[SessionImportService] Could not import live sessions:', error);
    } finally {
      this.scanning = false;
      if (event.imported > 0 || event.linked > 0) {
        this.onChatsChanged(event);
      }
      this.endScan();
    }
    return result;
  }

  /** Whether a UI launch or a CLI chat in this worktree is still waiting for its session. */
  private hasWaitingLaunch(harness: HarnessId, worktree: Worktree, index: ChatIndex): boolean {
    for (const [chatId, expectation] of this.expectations) {
      if (expectation.harness === harness && samePath(expectation.worktreePath, worktree.path) && !index.byId.get(chatId)?.harnessSessionId) {
        return true;
      }
    }
    const now = Date.now();
    return [...index.byId.values()].some(
      (chat) =>
        chat.harness === harness &&
        chat.worktreeId === worktree.id &&
        !chat.harnessSessionId &&
        !chat.pendingUiLaunch &&
        !chat.pendingHarnessSessionId &&
        now - chat.createdAt <= PENDING_LINK_WINDOW_MS
    );
  }

  /** The worktree's own sessions, as the hot pass lists them, with the ones just read (fresher) in place. */
  private async withWorktreeListing(adapter: HarnessAdapter, worktree: Worktree, sessions: HarnessSession[]): Promise<HarnessSession[]> {
    let listed: HarnessSession[] = [];
    try {
      listed = this.catalog.ownedSessions(worktree.path, await adapter.listSessionsForWorktree(worktree.path, true));
    } catch (error) {
      console.error(`[SessionImportService] Could not list ${adapter.displayName} sessions for ${worktree.path}:`, error);
    }
    const asked = new Set(sessions.map((session) => session.sessionId));
    return [...listed.filter((session) => !asked.has(session.sessionId)), ...sessions];
  }

  /** The first adapter that reads this session by itself, with the session. */
  private async readLiveSession(
    adapters: HarnessAdapter[],
    sessionId: string
  ): Promise<{ adapter: HarnessAdapter; session: HarnessSession } | undefined> {
    for (const adapter of adapters) {
      try {
        const session = await adapter.getSession!(sessionId);
        if (session?.cwd) {
          return { adapter, session };
        }
      } catch (error) {
        console.error(`[SessionImportService] Could not read ${adapter.displayName} session ${sessionId}:`, error);
      }
    }
    return undefined;
  }

  /** A scan or targeted import ended: let one waiting import run, then any wake that came meanwhile. */
  private endScan(): void {
    const next = this.scanEnded.shift();
    if (next) {
      next();
      return;
    }
    if (this.wakeQueued) {
      this.wakeQueued = false;
      this.wake();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
    this.expectations.clear();
    this.configListener.dispose();
    this.scanEnded.splice(0).forEach((resolve) => resolve());
  }

  private async scan(): Promise<void> {
    if (this.scanning || this.disposed) {
      return;
    }
    this.scanning = true;

    const event: SessionImportEvent = {
      imported: 0,
      linked: 0,
      renamed: 0,
      relocated: 0,
      removed: [],
    };

    try {
      const settings = this.readSettings();
      const now = Date.now();
      const full = this.fullQueued;
      this.fullQueued = false;
      const hot = !full && this.hasHotExpectation(now);
      // Nothing is linking and nobody can see the rows: skip the whole
      // discovery pass so an idle, hidden sidebar spawns no harness processes.
      if (!full && !hot && !this.isVisible()) {
        return;
      }
      const adapters = await this.harnessRegistry.getInstalled();
      if (adapters.length === 0) {
        return;
      }
      const scopes = await this.catalog.scopesAsync();
      const chats = this.storageService.getChats();
      this.restorePendingUiExpectations(scopes, chats);

      const index = this.buildIndex(chats);

      // While a UI launch is linking, poll only its worktree. A full discovery
      // pass over every repository every few seconds would spawn harness
      // processes and walk session directories for no benefit.
      if (hot) {
        await this.linkHotExpectations(adapters, scopes, index, event);
        return;
      }

      const retentionMs = settings.retentionDays * DAY_MS;
      const starred = this.storageService.getStarredChatIds();
      const listings = await this.listRepositorySessions(scopes, adapters);
      this.onSessionsListed(listings.flatMap((listing) => listing.sessions));
      // Roots can nest, and a listing for the outer root includes the inner
      // root's sessions; each goes to the deepest worktree across all roots.
      const allWorktrees = scopes.flatMap((scope) => scope.worktrees);
      this.relocateMisplacedChats(listings, allWorktrees, index, event);

      for (const { scope, adapter, sessions } of listings) {
        const byWorktree = this.groupByWorktree(allWorktrees, sessions);
        for (const worktree of scope.worktrees) {
          const worktreeSessions = byWorktree.get(worktree.id) ?? [];
          const sessionsById = new Map(
            worktreeSessions.map((session) => [session.sessionId, session])
          );
          this.linkPendingUiLaunches(
            adapter,
            worktree,
            worktreeSessions,
            index,
            event
          );
          this.renameLinkedChats(adapter, worktree, sessionsById, index, event);
          if (settings.enabled) {
            this.importRecentSessions(
              adapter,
              worktree,
              worktreeSessions,
              index,
              event,
              now,
              retentionMs
            );
            this.pruneExpiredChats(
              adapter,
              worktree,
              sessionsById,
              starred,
              index,
              event,
              now,
              retentionMs
            );
          }
        }
      }
    } finally {
      if (event.removed.length > 0) {
        this.storageService.deleteChats(event.removed, {
          rememberSession: false,
        });
      }
      this.scanning = false;
      if (
        event.imported > 0 ||
        event.linked > 0 ||
        event.renamed > 0 ||
        event.relocated > 0 ||
        event.removed.length > 0
      ) {
        this.onChatsChanged(event);
      }
      this.schedule();
      this.endScan();
    }
  }

  /**
   * List every repository once per adapter. The listings are independent, so
   * they run together; only the mutations that follow need the original order.
   */
  private async listRepositorySessions(
    scopes: Scope[],
    adapters: HarnessAdapter[]
  ): Promise<Array<{ scope: Scope; adapter: HarnessAdapter; sessions: HarnessSession[] }>> {
    const listings = await Promise.all(
      scopes.flatMap((scope) =>
        adapters.map(async (adapter) => {
          try {
            const sessions = await adapter.listSessionsForRepository(
              scope.repoRoot,
              scope.worktrees.map((worktree) => worktree.path)
            );
            return [{ scope, adapter, sessions }];
          } catch (error) {
            console.error(
              `[SessionImportService] Could not list ${adapter.displayName} sessions for ${scope.repoRoot}:`,
              error
            );
            return [];
          }
        })
      )
    );
    return listings.flat();
  }

  /**
   * The fast pass while a UI launch is waiting for its session. Only the
   * worktree that has an expectation is listed; imports, renames, and
   * retention wait for the next full scan.
   */
  private async linkHotExpectations(
    adapters: HarnessAdapter[],
    scopes: Scope[],
    index: ChatIndex,
    event: SessionImportEvent
  ): Promise<void> {
    const jobs = new Map<
      string,
      { adapter: HarnessAdapter; worktree: Worktree }
    >();
    for (const expectation of this.expectations.values()) {
      const adapter = adapters.find(
        (candidate) => candidate.id === expectation.harness
      );
      const worktree = this.findWorktree(scopes, (candidate) => samePath(candidate.path, expectation.worktreePath));
      if (adapter && worktree) {
        jobs.set(`${expectation.harness}\u0000${worktree.path}`, {
          adapter,
          worktree,
        });
      }
    }

    const listings = await Promise.all(
      Array.from(jobs.values(), async ({ adapter, worktree }) => {
        try {
          return {
            adapter,
            worktree,
            sessions: this.catalog.ownedSessions(
              worktree.path,
              await adapter.listSessionsForWorktree(worktree.path, true)
            ),
          };
        } catch (error) {
          console.error(
            `[SessionImportService] Could not poll ${adapter.displayName} sessions for ${worktree.path}:`,
            error
          );
          return undefined;
        }
      })
    );

    for (const listing of listings) {
      if (listing) {
        this.linkPendingUiLaunches(
          listing.adapter,
          listing.worktree,
          listing.sessions,
          index,
          event
        );
      }
    }
  }

  private buildIndex(chats: ChatSession[]): ChatIndex {
    const index: ChatIndex = {
      byId: new Map(chats.map((chat) => [chat.id, chat])),
      linked: new Map(),
      pending: new Map(),
      removedKeys: this.storageService.getRemovedSessionKeys(),
    };

    for (const chat of chats) {
      const linked = index.linked.get(chat.harness) ?? new Set<string>();
      const pending = index.pending.get(chat.harness) ?? new Set<string>();
      if (chat.harnessSessionId) {
        linked.add(chat.harnessSessionId);
      }
      if (chat.pendingHarnessSessionId) {
        pending.add(chat.pendingHarnessSessionId);
      }
      index.linked.set(chat.harness, linked);
      index.pending.set(chat.harness, pending);
    }
    return index;
  }

  private restorePendingUiExpectations(
    scopes: Scope[],
    chats: ChatSession[]
  ): void {
    const now = Date.now();
    for (const chat of chats) {
      if (!chat.pendingUiLaunch || chat.harnessSessionId) {
        continue;
      }
      if (now - chat.createdAt > PENDING_LINK_WINDOW_MS) {
        // Stop polling a placeholder that never produced a session. The chat
        // stays in the tree and can still be opened in the terminal.
        this.storageService.updateChat(chat.id, {
          pendingUiLaunch: false,
          pendingUiKnownSessionIds: undefined,
        });
        this.expectations.delete(chat.id);
        continue;
      }
      if (this.expectations.has(chat.id)) {
        continue;
      }
      const worktree = this.findWorktree(scopes, (candidate) => candidate.id === chat.worktreeId);
      if (!worktree) {
        continue;
      }
      // Prefer the snapshot the launch persisted. Without one, fall back to
      // the chat's creation time: the session appeared after the UI opened.
      this.expectations.set(chat.id, {
        harness: chat.harness,
        worktreePath: worktree.path,
        since: chat.createdAt,
        knownSessionIds: new Set(chat.pendingUiKnownSessionIds ?? []),
        bindSurface: true,
      });
    }
  }

  private linkPendingUiLaunches(
    adapter: HarnessAdapter,
    worktree: Worktree,
    sessions: HarnessSession[],
    index: ChatIndex,
    event: SessionImportEvent
  ): void {
    const linked = index.linked.get(adapter.id) ?? new Set<string>();

    for (const [chatId, expectation] of Array.from(
      this.expectations.entries()
    )) {
      if (
        expectation.harness !== adapter.id ||
        !samePath(expectation.worktreePath, worktree.path)
      ) {
        continue;
      }

      const chat = index.byId.get(chatId);
      if (!chat || chat.harnessSessionId) {
        this.expectations.delete(chatId);
        continue;
      }

      // A UI-started chat normally has no chosen ID, but honoring one keeps
      // the path correct if the harness ever accepts it.
      const exact = chat.pendingHarnessSessionId
        ? sessions.find(
            (session) =>
              session.sessionId === chat.pendingHarnessSessionId &&
              !linked.has(session.sessionId)
          )
        : undefined;
      const match =
        exact ??
        findClaimableSession(
          sessions,
          expectation.since,
          (sessionId) =>
            expectation.knownSessionIds.has(sessionId) ||
            linked.has(sessionId)
        );
      if (!match) {
        continue;
      }

      this.linkChat(
        adapter,
        chat,
        match,
        expectation.bindSurface,
        index,
        event
      );
      this.expectations.delete(chatId);
      linked.add(match.sessionId);
      index.linked.set(adapter.id, linked);
    }
  }

  private linkChat(
    adapter: HarnessAdapter,
    chat: ChatSession,
    session: HarnessSession,
    bindSurface: boolean,
    index: ChatIndex,
    event: SessionImportEvent
  ): void {
    const updates: Partial<ChatSession> = {
      harnessSessionId: session.sessionId,
      pendingHarnessSessionId: null,
      pendingUiLaunch: false,
      pendingUiKnownSessionIds: undefined,
      forkedFromSessionId: null,
    };
    const name = session.summary?.trim();
    if (name && hasDefaultName(chat)) {
      updates.name = truncateName(name);
    }

    const updated = this.storageService.updateChat(chat.id, updates);
    if (!updated) {
      return;
    }
    index.byId.set(updated.id, updated);
    event.linked++;

    if (bindSurface) {
      const surfaces = adapter.nativeUi?.surfaces;
      surfaces?.expect(session.sessionId, updated.name);
      // This runs in the background, so the active tab may belong to another
      // conversation: bind only a tab whose title matches the session name.
      surfaces?.settle(session.sessionId, { allowActiveFallback: false });
    }
  }

  private renameLinkedChats(
    adapter: HarnessAdapter,
    worktree: Worktree,
    sessionsById: Map<string, HarnessSession>,
    index: ChatIndex,
    event: SessionImportEvent
  ): void {
    for (const chat of index.byId.values()) {
      if (
        chat.harness !== adapter.id ||
        chat.worktreeId !== worktree.id ||
        !chat.harnessSessionId ||
        chat.customName
      ) {
        continue;
      }
      // A user-started chat picks up its first harness name once. An
      // auto-imported one may have been named from the first prompt before
      // the harness wrote its title, so keep it current. A name the user gave
      // the session in the agent (Claude's /rename, its tab's title) renames
      // either, so the row and the tab match; a Pitwall rename (customName,
      // above) always wins.
      const session = sessionsById.get(chat.harnessSessionId);
      if (!chat.autoImported && !hasDefaultName(chat) && !session?.userTitled) {
        continue;
      }
      const name = session?.summary?.trim();
      if (!name) {
        continue;
      }
      const nextName = truncateName(name);
      if (nextName === chat.name) {
        continue;
      }
      const updated = this.storageService.updateChat(chat.id, { name: nextName });
      if (updated) {
        index.byId.set(updated.id, updated);
        event.renamed++;
      }
    }
  }

  private importRecentSessions(
    adapter: HarnessAdapter,
    worktree: Worktree,
    sessions: HarnessSession[],
    index: ChatIndex,
    event: SessionImportEvent,
    now: number,
    retentionMs: number,
    /**
     * A live import (`importLive`): only these sessions are imported (the
     * rest are candidates for the reservation only), each seen as `seenAt`
     * gives; a scan's import imports every candidate, seen now.
     */
    live?: { only: ReadonlySet<string>; seenAt: (session: HarnessSession) => number }
  ): void {
    if (event.imported >= MAX_IMPORTS_PER_SCAN) {
      return;
    }

    const linked = index.linked.get(adapter.id) ?? new Set<string>();
    const pending = index.pending.get(adapter.id) ?? new Set<string>();

    // A CLI-launched chat without a chosen ID is waiting for its own session.
    // Reserve the session its watcher will claim so this scan cannot create a
    // duplicate first. Chats started in the UI are linked above instead.
    const reserved = this.reserveAwaitingSessions(
      adapter.id,
      worktree,
      sessions,
      index,
      linked
    );

    const candidates = [...sessions].sort(
      (a, b) =>
        (a.lastUpdated?.getTime() ?? 0) - (b.lastUpdated?.getTime() ?? 0)
    );

    for (const session of candidates) {
      if (event.imported >= MAX_IMPORTS_PER_SCAN) {
        return;
      }
      if (live && !live.only.has(session.sessionId)) {
        continue;
      }
      if (linked.has(session.sessionId)) {
        continue;
      }
      if (pending.has(session.sessionId)) {
        continue;
      }
      if (reserved.has(session.sessionId)) {
        continue;
      }
      if (
        index.removedKeys.has(
          harnessSessionKey(adapter.id, session.sessionId)
        )
      ) {
        continue;
      }

      const lastActive =
        session.lastActivity ??
        session.lastUpdated?.getTime() ??
        0;
      if (!lastActive || now - lastActive > retentionMs) {
        continue;
      }

      const name = session.summary?.trim();
      const createdAt = session.lastUpdated?.getTime() ?? lastActive;
      // The id comes from the session, so another window importing it at the
      // same moment writes the same record rather than a second row.
      const chat = this.storageService.createChat(
        worktree.id,
        adapter.id,
        name ? truncateName(name) : DEFAULT_CHAT_NAME,
        {
          id: importedChatId(adapter.id, session.sessionId),
          harnessSessionId: session.sessionId,
          createdAt,
          lastAccessedAt: lastActive,
          autoImported: true,
          ...(live ? { seenAt: live.seenAt(session) } : {}),
        }
      );
      index.byId.set(chat.id, chat);
      linked.add(session.sessionId);
      index.linked.set(adapter.id, linked);
      event.imported++;
    }
  }

  /**
   * Sessions that an unlinked CLI chat is about to claim. Its watcher owns the
   * link; auto-import only needs to stay out of the way.
   */
  private reserveAwaitingSessions(
    harness: HarnessId,
    worktree: Worktree,
    sessions: HarnessSession[],
    index: ChatIndex,
    linked: Set<string>
  ): Set<string> {
    const reserved = new Set<string>();
    const now = Date.now();
    const awaiting = Array.from(index.byId.values())
      .filter(
        (chat) =>
          chat.harness === harness &&
          chat.worktreeId === worktree.id &&
          !chat.harnessSessionId &&
          !chat.pendingUiLaunch &&
          !chat.pendingHarnessSessionId &&
          // A placeholder that never produced a session must not keep
          // reserving sessions that belong to someone else.
          now - chat.createdAt <= PENDING_LINK_WINDOW_MS
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    if (awaiting.length === 0) {
      return reserved;
    }

    for (const chat of awaiting) {
      const match = findClaimableSession(
        sessions,
        chat.createdAt,
        (sessionId) => linked.has(sessionId) || reserved.has(sessionId)
      );
      if (match) {
        reserved.add(match.sessionId);
      }
    }
    return reserved;
  }

  /**
   * Remove rows that have been quiet longer than the retention window, whether
   * Pitwall created them or they were imported. A star is the only exemption
   * the user controls; an open terminal or native-UI tab is kept so retention
   * never pulls a row out from under a live session.
   */
  private pruneExpiredChats(
    adapter: HarnessAdapter,
    worktree: Worktree,
    sessionsById: Map<string, HarnessSession>,
    starred: Set<string>,
    index: ChatIndex,
    event: SessionImportEvent,
    now: number,
    retentionMs: number
  ): void {
    for (const chat of Array.from(index.byId.values())) {
      if (chat.harness !== adapter.id || chat.worktreeId !== worktree.id) {
        continue;
      }
      if (starred.has(chat.id) || this.isChatOpen(chat)) {
        continue;
      }

      const session = chat.harnessSessionId
        ? sessionsById.get(chat.harnessSessionId)
        : undefined;
      const lastActive = Math.max(
        session?.lastActivity ?? 0,
        session?.lastUpdated?.getTime() ?? 0,
        chat.lastAccessedAt ?? 0
      );
      // An unknown timestamp is not evidence that the row is old.
      if (!lastActive || now - lastActive <= retentionMs) {
        continue;
      }

      // Retention is not a user removal, so no tombstone: if the session
      // becomes active again, the importer may bring it back. The scan
      // deletes every expired row in one write once it has finished.
      index.byId.delete(chat.id);
      event.removed.push(chat.id);
    }
  }

  /**
   * Move a linked row to the worktree that owns its session, keeping its name
   * and star. Rows imported before nested roots were told apart sit under the
   * outer root, where the harness cannot even resume them. An open row stays
   * put until its terminal or tab closes.
   */
  private relocateMisplacedChats(
    listings: Array<{ adapter: HarnessAdapter; sessions: HarnessSession[] }>,
    worktrees: Worktree[],
    index: ChatIndex,
    event: SessionImportEvent
  ): void {
    const owners = new Map<string, Worktree>();
    for (const { adapter, sessions } of listings) {
      for (const session of sessions) {
        const owner = deepestContainingRoot(worktrees, session.cwd);
        if (owner) {
          owners.set(harnessSessionKey(adapter.id, session.sessionId), owner);
        }
      }
    }
    for (const chat of Array.from(index.byId.values())) {
      const owner = chat.harnessSessionId && owners.get(harnessSessionKey(chat.harness, chat.harnessSessionId));
      if (!owner || owner.id === chat.worktreeId || this.isChatOpen(chat)) {
        continue;
      }
      const updated = this.storageService.updateChat(chat.id, { worktreeId: owner.id });
      if (updated) {
        index.byId.set(updated.id, updated);
        event.relocated++;
      }
    }
  }

  private groupByWorktree(
    worktrees: Worktree[],
    sessions: HarnessSession[]
  ): Map<string, HarnessSession[]> {
    const byId = new Map<string, HarnessSession[]>();
    for (const session of sessions) {
      const worktree = deepestContainingRoot(worktrees, session.cwd);
      if (worktree) {
        const group = byId.get(worktree.id);
        if (group) {
          group.push(session);
        } else {
          byId.set(worktree.id, [session]);
        }
      }
    }
    return byId;
  }

  /** Whether a UI launch is recent enough to keep polling quickly. */
  private hasHotExpectation(now: number): boolean {
    for (const expectation of this.expectations.values()) {
      if (now - expectation.since < HOT_WINDOW_MS) {
        return true;
      }
    }
    return false;
  }

  private findWorktree(scopes: Scope[], matches: (worktree: Worktree) => boolean): Worktree | undefined {
    return scopes.flatMap((scope) => scope.worktrees).find(matches);
  }

  private nextIntervalMs(): number | undefined {
    const settings = this.readSettings();
    const now = Date.now();
    let hot = false;

    for (const [chatId, expectation] of Array.from(this.expectations)) {
      const age = now - expectation.since;
      if (age > PENDING_LINK_WINDOW_MS) {
        this.expectations.delete(chatId);
        continue;
      }
      if (age < HOT_WINDOW_MS) {
        hot = true;
      }
    }

    if (hot) {
      return this.hotScanIntervalMs;
    }
    if (settings.enabled || this.expectations.size > 0) {
      return this.scanIntervalMs;
    }
    return undefined;
  }

  private schedule(): void {
    if (!this.started || this.disposed) {
      return;
    }
    const interval = this.nextIntervalMs();
    if (interval === undefined) {
      this.stopTimer();
      return;
    }
    if (this.timer && this.timerIntervalMs === interval) {
      return;
    }
    this.stopTimer();
    this.timerIntervalMs = interval;
    this.timer = setInterval(() => {
      this.wake();
    }, interval);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.timerIntervalMs = undefined;
  }
}
