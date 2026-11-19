import * as vscode from 'vscode';
import { NativeUiSurfaceTracker, NativeUiTabGroupState, NativeUiTitleCandidate, RESTORED_DEADLINE_CAP_MS } from '../types';
import { logOperation } from '../../services/OperationLog';

/** How long an expected tab can take to appear before the expectation expires. */
const PENDING_TTL_MS = 30_000;
/** How long a serial open waits for its tab before moving on with the session unbound (Q5). */
export const SERIAL_BIND_TIMEOUT_MS = 5_000;
/**
 * A move opens the copy in the target group, then closes the original. A
 * close takes the binding to a copy that opened this recently, so a Claude
 * tab the user opened long before is never taken for the moved one.
 */
const MOVE_WINDOW_MS = 2_000;

interface PendingSurface {
  sessionId: string;
  label: string;
  expiresAt: number;
  /**
   * The open sequence number when the expectation was made: only a tab that
   * opened after it (a higher stamp) is new enough to be the expected chat's
   * without its title proving it (live I1b).
   */
  seq: number;
}

/** How long an open waits for the titles before adopting with what it has. */
const ADOPT_WAIT_MS = 1_000;

/**
 * What identifies a tab across Tab objects: its place, its title and its
 * input's kind. A tab moved to another group is a new Tab object: the
 * workbench opens the copy in the target group, then closes the original.
 * The editor also re-sends its whole tab model, replacing every Tab object
 * and firing a tab-group event only: VS Code when a group is added or
 * removed, and Cursor (3.14) also on every change of a group's active editor,
 * which lands between a move's open and its close.
 */
/** The title a Claude webview shows until it sets its own: a moved tab's copy comes up with it. */
const DEFAULT_TITLE = 'Claude Code';

/** A copy's title is the original's, or the default one a fresh webview shows. */
function sameOrDefaultTitle(copy: string, original: string): boolean {
  return copy === original || copy.trim() === DEFAULT_TITLE;
}

/** A title that can name a chat: not empty and not the default every fresh Claude tab shows. */
function namingTitle(label: string): boolean {
  const title = label.trim();
  return title.length > 0 && title !== DEFAULT_TITLE;
}

function tabKind(tab: vscode.Tab): string {
  const input = tab.input as { viewType?: unknown; uri?: { toString(): string } } | undefined;
  return typeof input?.viewType === 'string' ? input.viewType : input?.uri?.toString() ?? '';
}

/** The input's kind as the trace prints it: a view type, never a file path. */
function traceKind(tab: vscode.Tab): string {
  const input = tab.input as { viewType?: unknown; uri?: unknown } | undefined;
  if (typeof input?.viewType === 'string') {
    return `${input.uri ? 'custom' : 'webview'}:${input.viewType}`;
  }
  return input?.uri ? 'text' : 'other';
}

export interface NativeUiTabSurfaceOptions {
  /** Whether the tab belongs to this harness's native UI. */
  isUiTab: (tab: vscode.Tab) => boolean;
  /**
   * The native session ID the tab exposes, when the tab carries one. A tab
   * without an ID can still bind through a label expectation.
   */
  sessionIdForTab?: (tab: vscode.Tab) => string | undefined;
  /**
   * Whether a pending label may bind a tab that exposes no session ID. Claude
   * webview tabs need this; Codex conversation tabs are matched by URI only.
   */
  matchByLabel?: boolean;
  /** Injection points keep the tab API behind a testable boundary. */
  getTabGroups?: () => readonly vscode.TabGroup[];
  onDidChangeTabs?: (
    listener: (event: vscode.TabChangeEvent) => void
  ) => vscode.Disposable;
  onDidChangeTabGroups?: (
    listener: (event: vscode.TabGroupChangeEvent) => void
  ) => vscode.Disposable;
  /** The clock and timer behind the 5 s bind wait and the move window; tests inject their own. */
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => { dispose(): void };
  /** Where `[Pitwall] tab bound ...` goes; the Operations log by default. */
  log?: (line: string) => void;
}

/** The session a serial open is waiting to see a tab for. */
interface Claim {
  sessionId: string;
  tab: vscode.Tab | undefined;
  arrived: () => void;
  /** Set when its wait timed out: a tab arriving later is still its, until then. */
  lateUntil?: number;
}

/**
 * Associates native-UI tabs with native session IDs.
 *
 * Harnesses differ in what a tab reveals: Codex's conversation editor carries
 * the thread URI, while Claude's webview carries only the title. The shared
 * lifecycle lives here; each harness supplies a policy for recognizing its
 * tabs and, when possible, reading the session ID from one.
 */
export class NativeUiTabSurfaceService implements NativeUiSurfaceTracker {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private readonly tabs = new Map<vscode.Tab, string>();
  /** Reverse index so isOpen and closeSurface never scan the tab list. */
  private readonly sessionTabs = new Map<string, Set<vscode.Tab>>();
  private pending: PendingSurface[] = [];
  private lastActiveSessionId: string | undefined;
  /** The serial open waiting for a new tab, if any (one at a time). */
  private claim: Claim | undefined;
  /** Opens whose 5 s wait ran out, oldest first: a late tab belongs to the oldest of them, not the next open. */
  private late: Claim[] = [];
  /** Serial opens run one after another, never interleaved. */
  private serialQueue: Promise<unknown> = Promise.resolve();
  /** When an unbound Claude tab appeared, so a move's copy can be told from an older tab. */
  private readonly openedAt = new WeakMap<vscode.Tab, { at: number; seq: number }>();
  private openSeq = 0;
  /**
   * Bindings of tabs that closed with no copy yet: a move can report the close
   * before the open. A Claude tab of the same kind opening within the move
   * window takes the binding.
   */
  private released: { sessionId: string; kind: string; label: string; at: number }[] = [];
  /**
   * Every Claude tab as of the last tab or group event, per group in editor
   * order. A re-sent tab model replaces every Tab object but keeps the order,
   * so a tab's place here finds its replacement.
   */
  private layout: vscode.Tab[][] = [];
  /** Each Tab a re-sent model replaced, to the Tab it was paired with: `followHeldTab` walks it (live E12). */
  private readonly successor = new WeakMap<vscode.Tab, vscode.Tab>();
  /** `pitwall.dev.traceTabs`: log every raw event and each bind decision. Off by default. */
  private tracing = false;
  /** Every Tab object (any kind) as of the last event, while tracing: tells a re-send from a plain group event. */
  private traceSeen = new Set<vscode.Tab>();
  /** The last group line traced, so back-to-back identical re-sends log once. */
  private lastGroupTrace: string | undefined;
  /**
   * Restored tabs whose first visit has not ended: this harness's tabs
   * present at activation and not shown then. A tab leaves when its hold
   * ends (`endFirstVisit`), RESTORED_DEADLINE_CAP_MS after it was first
   * shown, or when it closes (E11).
   */
  private readonly unvisited = new Set<vscode.Tab>();
  /** When each unvisited tab was first shown (its webview started loading). */
  private readonly visitStartedAt = new Map<vscode.Tab, number>();
  /** `whenTabMoved` calls waiting for one of this harness's tabs to close. */
  private readonly moveWaiters = new Set<() => void>();
  /** The sessions a tab here may belong to, with their titles; set once titles are known (I1). */
  private titleSource: (() => readonly NativeUiTitleCandidate[]) | undefined;
  /** Settles when the title source is complete enough to trust (the folder's session listing). */
  private titlesReady: Promise<unknown> = Promise.resolve();
  /** Whether adoption may act on the title source yet. */
  private titlesTrusted = false;

  private readonly isUiTab: (tab: vscode.Tab) => boolean;
  private readonly sessionIdForTab:
    | ((tab: vscode.Tab) => string | undefined)
    | undefined;
  private readonly matchByLabel: boolean;
  private readonly getTabGroups: () => readonly vscode.TabGroup[];
  private readonly tabListener: vscode.Disposable;
  private readonly groupListener: vscode.Disposable;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => { dispose(): void };
  private readonly log: (line: string) => void;

  constructor(options: NativeUiTabSurfaceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        return { dispose: () => clearTimeout(timer) };
      });
    this.log = options.log ?? logOperation;
    this.isUiTab = options.isUiTab;
    this.sessionIdForTab = options.sessionIdForTab;
    this.matchByLabel = options.matchByLabel ?? false;

    const tabGroups = vscode.window.tabGroups;
    this.getTabGroups = options.getTabGroups ?? (() => tabGroups.all);
    this.tabListener = (
      options.onDidChangeTabs ??
      ((listener) => tabGroups.onDidChangeTabs(listener))
    )((event) => this.handleTabChange(event));
    this.groupListener = (
      options.onDidChangeTabGroups ??
      ((listener) => tabGroups.onDidChangeTabGroups(listener))
    )(() => {
      this.traceGroupEvent();
      const reconciled = this.reconcile();
      const mappingChanged = this.adoptTabs() || reconciled;
      this.layout = this.uiTabsByGroup();
      this.trackVisits();
      if (this.updateActiveSession() || mappingChanged) {
        this._onDidChange.fire();
      }
    });

    // Seed tabs that were restored before the extension activated. Claude has
    // no expectation yet, so this is a no-op there; Codex panels map exactly.
    for (const group of this.getTabGroups()) {
      for (const tab of group.tabs) {
        this.associate(tab, false);
      }
    }
    this.lastActiveSessionId = this.activeSessionId();
    this.layout = this.uiTabsByGroup();
    // A restored tab that is not shown has not loaded its webview yet.
    for (const tab of this.layout.flat()) {
      if (!tab.isActive) {
        this.unvisited.add(tab);
      }
    }
  }

  isFirstVisitSinceLaunch(tab: vscode.Tab): boolean {
    const started = this.visitStartedAt.get(tab);
    return this.unvisited.has(tab) && (started === undefined || this.now() - started <= RESTORED_DEADLINE_CAP_MS);
  }

  endFirstVisit(tab: vscode.Tab): void {
    this.unvisited.delete(tab);
    this.visitStartedAt.delete(tab);
  }

  followHeldTab(tab: vscode.Tab): vscode.Tab | undefined {
    const present = this.allTabs();
    const seen = new Set<vscode.Tab>();
    let current: vscode.Tab | undefined = tab;
    while (current && !present.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.successor.get(current);
    }
    if (!current || !present.has(current)) {
      return undefined;
    }
    if (current !== tab && this.tracing) {
      this.log(`[Pitwall] trace hold follows re-sent tab ${this.placeOf(current)}`);
    }
    return current;
  }

  /**
   * `pitwall.dev.traceTabs`: toggle the tab trace. While on, every raw tab and
   * tab-group event (group, index, label, input kind; for a group event,
   * how many Tab objects it replaced) and each bind or release decision with
   * its reason goes to the log as `[Pitwall] trace ...`.
   */
  toggleTrace(): boolean {
    this.tracing = !this.tracing;
    this.traceSeen = this.tracing ? this.allTabs() : new Set();
    this.log(`[Pitwall] tab trace ${this.tracing ? 'on' : 'off'}`);
    return this.tracing;
  }

  /**
   * Adopt tabs Pitwall did not open (row 4.9, live I1): Claude tabs restored
   * after a reload or a relaunch, reopened by the editor's own session
   * restore, or opened before activation carry only their title. `source`
   * names the sessions a tab in this window can show (the window folder's)
   * with their titles; an unbound tab whose title names exactly one of them,
   * when no other unbound tab names that one, is bound to it. A default
   * "Claude Code" title, or a title two chats share, stays unknown. Runs now
   * and after every tab or group event from here on.
   */
  setTitleSource(source: () => readonly NativeUiTitleCandidate[], ready?: Promise<unknown>): void {
    this.titleSource = source;
    if (!ready) {
      this.titlesTrusted = true;
      this.adopt();
      return;
    }
    // Until the source is complete, a title cannot prove a tab is one chat's
    // and no other's: adoption waits for it.
    this.titlesTrusted = false;
    this.titlesReady = ready.catch(() => undefined).then(() => {
      if (this.titleSource === source) {
        this.titlesTrusted = true;
        this.adopt();
      }
    });
  }

  /** Adopt now, after the titles changed. */
  adopt(): void {
    if (this.adoptTabs()) {
      this.updateActiveSession();
      this._onDidChange.fire();
    }
  }

  /**
   * Before an open: wait at most `timeoutMs` for the titles to be complete,
   * then adopt, so a chat whose tab is already here is revealed and bound,
   * never claimed or opened twice.
   */
  async adoptBeforeOpen(timeoutMs = ADOPT_WAIT_MS): Promise<void> {
    if (!this.titleSource) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = this.schedule(resolve, timeoutMs);
      void this.titlesReady.then(() => {
        timer.dispose();
        resolve();
      });
    });
    this.adopt();
  }

  /**
   * Resolve true when one of this harness's tabs closes, the last step of a
   * move (the copy opens first), or false after `timeoutMs`. Side by side
   * arms it before each move so the next waits for this one to land.
   */
  whenTabMoved(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const done = (landed: boolean) => {
        this.moveWaiters.delete(waiter);
        timer.dispose();
        resolve(landed);
      };
      const waiter = () => done(true);
      const timer = this.schedule(() => done(false), timeoutMs);
      this.moveWaiters.add(waiter);
    });
  }

  /**
   * Open sessions one after another and bind each new tab to the session just
   * requested (rows 4.3, 4.4). `open` opens or reveals a session; while it
   * runs, the next new Claude tab is that session's, so a title never has to
   * tell them apart (new chats are all "Claude Code"). A session that already
   * has a tab is only revealed. Each open waits at most 5 s for its tab, then
   * moves on with the session unbound. Stops before the next open on cancel.
   * `open` may resolve false when nothing opened, which skips the wait.
   */
  openSerially(
    ids: string[],
    open: (sessionId: string) => Promise<unknown>,
    token?: vscode.CancellationToken
  ): Promise<Map<string, vscode.Tab | undefined>> {
    const run = this.serialQueue.then(() => this.openEach(ids, open, token));
    this.serialQueue = run.catch(() => undefined);
    return run;
  }

  private async openEach(
    ids: string[],
    open: (sessionId: string) => Promise<unknown>,
    token?: vscode.CancellationToken
  ): Promise<Map<string, vscode.Tab | undefined>> {
    const result = new Map<string, vscode.Tab | undefined>();
    for (const sessionId of ids) {
      if (token?.isCancellationRequested) {
        break;
      }
      if (this.isOpen(sessionId)) {
        await open(sessionId);
        result.set(sessionId, this.sessionTabs.get(sessionId)?.values().next().value);
        continue;
      }
      let arrived: () => void = () => undefined;
      const tabArrived = new Promise<void>((resolve) => (arrived = resolve));
      const claim: Claim = { sessionId, tab: undefined, arrived };
      this.claim = claim;
      try {
        const opened = await open(sessionId);
        if (!claim.tab && opened !== false && !token?.isCancellationRequested) {
          await this.waitFor(tabArrived, token);
          if (!claim.tab) {
            claim.lateUntil = this.now() + PENDING_TTL_MS;
            this.late.push(claim);
          }
        }
      } finally {
        this.claim = undefined;
      }
      result.set(sessionId, claim.tab);
    }
    return result;
  }

  /** Resolve when the tab arrives, the wait runs out, or the token cancels. */
  private waitFor(arrived: Promise<void>, token?: vscode.CancellationToken): Promise<void> {
    return new Promise<void>((resolve) => {
      let subscription: { dispose(): void } | undefined;
      const timer = this.schedule(() => finish(), SERIAL_BIND_TIMEOUT_MS);
      const finish = () => {
        timer.dispose();
        subscription?.dispose();
        resolve();
      };
      subscription = token?.onCancellationRequested(() => finish());
      void arrived.then(finish);
    });
  }

  /** Every tab group as the dump script reads it: labels, pinned and active flags, and the bound session. */
  describeTabs(): NativeUiTabGroupState[] {
    return this.getTabGroups().map((group, index) => ({
      index,
      isActive: group.isActive,
      tabs: group.tabs.map((tab) => ({
        label: tab.label,
        pinned: Boolean((tab as { isPinned?: boolean }).isPinned),
        active: tab.isActive,
        sessionId: this.tabs.get(tab),
      })),
    }));
  }

  expect(sessionId: string, label: string): void {
    // A tracker that reads the session ID from the tab has nothing to claim;
    // the tab is associated as soon as it appears.
    if (!this.matchByLabel) {
      return;
    }
    // Reopening a session that already has a mapped tab just reveals it; there
    // is no new tab to claim.
    if (this.isOpen(sessionId)) {
      return;
    }
    this.prunePending();
    this.pending = this.pending.filter((entry) => entry.sessionId !== sessionId);
    this.pending.push({
      sessionId,
      label,
      expiresAt: Date.now() + PENDING_TTL_MS,
      seq: this.openSeq,
    });
  }

  cancelExpect(sessionId: string): void {
    this.pending = this.pending.filter((entry) => entry.sessionId !== sessionId);
  }

  settle(
    sessionId: string,
    options: { allowActiveFallback?: boolean } = {}
  ): void {
    this.prunePending();
    let mappingChanged = false;

    if (this.pending.some((entry) => entry.sessionId === sessionId)) {
      const groups = this.getTabGroups();
      const activeTab = groups.find((group) => group.isActive)?.activeTab;
      if (activeTab) {
        // The command just opened or revealed this session's tab. With a
        // single expectation, the active tab is safe to bind even if its title
        // was truncated differently from the chat name.
        mappingChanged = this.associate(
          activeTab,
          (options.allowActiveFallback ?? true) && this.pending.length === 1
        );
      }

      // A tab can be active in a non-active group, or the active tab can be a
      // file when the panel opened in the background. Match remaining tabs
      // without guessing.
      if (this.pending.some((entry) => entry.sessionId === sessionId)) {
        for (const group of groups) {
          for (const tab of group.tabs) {
            mappingChanged = this.associate(tab, false) || mappingChanged;
          }
        }
      }
    }

    const activeChanged = this.updateActiveSession();
    if (mappingChanged || activeChanged) {
      this._onDidChange.fire();
    }
  }

  activeSessionId(): string | undefined {
    const activeTab = this.getTabGroups().find((group) => group.isActive)
      ?.activeTab;
    if (!activeTab) {
      return undefined;
    }
    const mapped = this.tabs.get(activeTab);
    if (mapped) {
      return mapped;
    }
    return this.isUiTab(activeTab)
      ? this.sessionIdForTab?.(activeTab)
      : undefined;
  }

  async closeSurface(sessionId: string): Promise<boolean> {
    const tab = this.sessionTabs.get(sessionId)?.values().next().value;
    return tab ? vscode.window.tabGroups.close(tab, true) : false;
  }

  /**
   * Whether this native session currently has an open native-UI tab.
   *
   * Reads the map only: the constructor seeds every restored tab and
   * `onDidChangeTabs` maps each new one, so the map is authoritative. This is
   * called once per chat row per tree render, so it must not scan the tabs.
   */
  isOpen(sessionId: string): boolean {
    return this.sessionTabs.has(sessionId);
  }

  dispose(): void {
    this.tabListener.dispose();
    this.groupListener.dispose();
    this._onDidChange.dispose();
    this.tabs.clear();
    this.sessionTabs.clear();
    this.pending = [];
  }

  private handleTabChange(event: vscode.TabChangeEvent): void {
    this.traceTabEvent(event);
    this.prunePending();
    const now = this.now();
    let mappingChanged = false;

    // A copy that opens unbound may be a moved tab's new Tab object: note when.
    for (const tab of event.opened) {
      if (this.isUiTab(tab) && !this.tabs.has(tab)) {
        this.openedAt.set(tab, { at: now, seq: ++this.openSeq });
      }
    }
    // A closed tab is released, unless a moved copy opened just before it:
    // then the binding follows the copy (D16). Before the group sweep below,
    // which would otherwise take a closed tab for a rebuilt one.
    for (const tab of event.closed) {
      const sessionId = this.tabs.get(tab);
      if (sessionId === undefined) {
        continue;
      }
      const copy = this.movedCopy(tab, now);
      this.unmapTab(tab);
      if (copy) {
        this.mapTab(copy, sessionId);
        this.decide('follow', sessionId, copy, 'moved copy');
      } else {
        this.released.push({ sessionId, kind: tabKind(tab), label: tab.label, at: now });
        this.decide('release', sessionId, tab, `closed; a copy opening within ${MOVE_WINDOW_MS} ms takes it`);
      }
      mappingChanged = true;
    }
    // Follow re-sent Tab objects (a re-send fires no tab event).
    mappingChanged = this.reconcile(event) || mappingChanged;

    for (const tab of event.opened) {
      mappingChanged = this.claimTab(tab) || mappingChanged;
    }
    for (const tab of [...event.opened, ...event.changed]) {
      mappingChanged =
        this.associate(tab, this.pending.length === 1) || mappingChanged;
    }
    for (const tab of event.opened) {
      mappingChanged = this.rebindReleased(tab, now) || mappingChanged;
    }
    // Last, so a claim, an expectation and a move's pairing always come first.
    mappingChanged = this.adoptTabs() || mappingChanged;

    this.layout = this.uiTabsByGroup();
    this.trackVisits();
    const activeChanged = this.updateActiveSession();
    if (mappingChanged || activeChanged) {
      this._onDidChange.fire();
    }
    if (event.closed.some((tab) => this.isUiTab(tab))) {
      for (const waiter of [...this.moveWaiters]) {
        waiter();
      }
    }
  }

  /** A serial open's new tab binds to the session it requested. */
  private claimTab(tab: vscode.Tab): boolean {
    const now = this.now();
    this.late = this.late.filter((entry) => !entry.tab && (entry.lateUntil ?? 0) > now);
    const claim = this.late[0] ?? (this.claim?.tab ? undefined : this.claim);
    if (!claim || claim.tab || !this.isUiTab(tab) || this.tabs.has(tab) || this.sessionIdForTab?.(tab)) {
      return false;
    }
    claim.tab = tab;
    this.pending = this.pending.filter((entry) => entry.sessionId !== claim.sessionId);
    this.mapTab(tab, claim.sessionId);
    this.logBound(claim.sessionId, tab, claim === this.claim ? 'serial open' : 'serial open, late');
    claim.arrived();
    return true;
  }

  /**
   * A tab that opens just after a bound one closed (a move reported close
   * first) takes that binding. `unique` (a tab that appeared in a re-sent
   * model, with no open event) takes it only when no other closed binding
   * fits it as well.
   */
  private rebindReleased(tab: vscode.Tab, now: number, unique = false): boolean {
    this.released = this.released.filter((entry) => now - entry.at <= MOVE_WINDOW_MS);
    if (!this.isUiTab(tab) || this.tabs.has(tab) || this.sessionIdForTab?.(tab)) {
      return false;
    }
    const fits = (entry: (typeof this.released)[number]) =>
      entry.kind === tabKind(tab) && sameOrDefaultTitle(tab.label, entry.label) && !this.isOpen(entry.sessionId);
    const at = this.released.findIndex(fits);
    if (at < 0 || (unique && this.released.filter(fits).length > 1)) {
      return false;
    }
    const [entry] = this.released.splice(at, 1);
    this.mapTab(tab, entry.sessionId);
    this.decide('follow', entry.sessionId, tab, unique ? 'closed binding, copy in a re-sent model' : 'closed binding, copy opened after the close');
    return true;
  }

  /**
   * The unbound Claude tab that opened most recently, just now, of the closed
   * tab's kind, with its title or the default one (a moved webview comes up
   * with the default until it sets its own).
   */
  private movedCopy(closed: vscode.Tab, now: number): vscode.Tab | undefined {
    const kind = tabKind(closed);
    let best: { tab: vscode.Tab; seq: number } | undefined;
    for (const tab of this.uiTabs()) {
      const seen = this.openedAt.get(tab);
      if (!seen || this.tabs.has(tab) || now - seen.at > MOVE_WINDOW_MS || tabKind(tab) !== kind || !sameOrDefaultTitle(tab.label, closed.label)) {
        continue;
      }
      if (!best || seen.seq > best.seq) {
        best = { tab, seq: seen.seq };
      }
    }
    return best?.tab;
  }

  private uiTabs(): vscode.Tab[] {
    return this.uiTabsByGroup().flat();
  }

  /** This harness's tabs, per group in editor order. */
  private uiTabsByGroup(): vscode.Tab[][] {
    return this.getTabGroups().map((group) => group.tabs.filter((tab) => this.isUiTab(tab)));
  }

  private allTabs(): Set<vscode.Tab> {
    return new Set(this.getTabGroups().flatMap((group) => group.tabs));
  }

  private logBound(sessionId: string, tab: vscode.Tab, reason: string): void {
    this.log(`[Pitwall] tab bound ${sessionId.slice(0, 8)} "${tab.label}"`);
    this.decide('bind', sessionId, tab, reason);
  }

  /** A bind, follow or release decision, while tracing. */
  private decide(verb: 'bind' | 'follow' | 'release', sessionId: string, tab: vscode.Tab, reason: string): void {
    if (this.tracing) {
      this.log(`[Pitwall] trace ${verb} ${sessionId.slice(0, 8)} "${tab.label}" (${reason})`);
    }
  }

  /** Where a tab is now, as `g<group>:<index>`; `g?` once it is gone. */
  private placeOf(tab: vscode.Tab): string {
    const groups = this.getTabGroups();
    for (const [g, group] of groups.entries()) {
      const index = group.tabs.indexOf(tab);
      if (index >= 0) {
        return `g${g}:${index}`;
      }
    }
    return 'g?';
  }

  private traceTab(tab: vscode.Tab): string {
    const bound = this.tabs.get(tab);
    return `${this.placeOf(tab)} "${tab.label}" ${traceKind(tab)}${bound ? ` =${bound.slice(0, 8)}` : ''}`;
  }

  /** The raw tab event, before it is handled. */
  private traceTabEvent(event: vscode.TabChangeEvent): void {
    if (!this.tracing) {
      return;
    }
    const list = (tabs: readonly vscode.Tab[]) => `[${tabs.map((tab) => this.traceTab(tab)).join(', ')}]`;
    this.log(`[Pitwall] trace tabs opened=${list(event.opened)} closed=${list(event.closed)} changed=${list(event.changed)}`);
    this.traceSeen = this.allTabs();
    this.lastGroupTrace = undefined;
  }

  /**
   * The raw tab-group event, before it is handled: how many of the Tab
   * objects seen at the last event it replaced (by identity), and every tab
   * per group. A re-send identical to the group event just before it, with
   * no tab event between, is not logged again.
   */
  private traceGroupEvent(): void {
    if (!this.tracing) {
      return;
    }
    const now = this.allTabs();
    const replaced = [...this.traceSeen].filter((tab) => !now.has(tab)).length;
    const groups = this.getTabGroups();
    const active = groups.findIndex((group) => group.isActive);
    const tabs = groups.flatMap((group) => group.tabs.map((tab) => this.traceTab(tab)));
    const line = `[Pitwall] trace groups n=${groups.length} active=${active} replaced=${replaced}/${this.traceSeen.size} tabs=[${tabs.join(', ')}]`;
    if (line !== this.lastGroupTrace) {
      this.log(line);
      this.lastGroupTrace = line;
    }
    this.traceSeen = now;
  }

  private associate(tab: vscode.Tab, allowFallback: boolean): boolean {
    if (!this.isUiTab(tab)) {
      return false;
    }

    const exact = this.sessionIdForTab?.(tab);
    if (exact) {
      // The tab itself proves the session opened; a pending expectation for
      // that session is satisfied even if its label never matched.
      const pendingIndex = this.pending.findIndex(
        (entry) => entry.sessionId === exact
      );
      if (pendingIndex >= 0) {
        this.pending.splice(pendingIndex, 1);
      }
      const bound = this.mapTab(tab, exact);
      if (bound) {
        this.logBound(exact, tab, 'session id on the tab');
      }
      return bound;
    }

    if (this.tabs.has(tab) || !this.matchByLabel || this.pending.length === 0) {
      return false;
    }

    // A tab that opened after the expectation may be the expected chat's on
    // its title alone, or as the only one expected. A tab that was already
    // there (restored, or opened by the user) binds only when its title
    // proves it: it names the chat, no other unbound tab does, and it names
    // no other chat of this folder. Never as "the only expected chat": the
    // panel's own tab opens just after the command returns (live I1b).
    const match = this.pending.findIndex(
      (entry) => this.titlesOf(entry).some((title) => labelsMatch(tab.label, title)) && (this.isNewSince(tab, entry.seq) || this.provenFor(tab, entry))
    );
    const fallback = allowFallback && this.pending[0] && this.isNewSince(tab, this.pending[0].seq) && !this.namesOther(tab, this.pending[0].sessionId) ? 0 : -1;
    const index = match >= 0 ? match : fallback;
    if (index < 0) {
      return false;
    }

    const [pending] = this.pending.splice(index, 1);
    if (!pending) {
      return false;
    }
    this.mapTab(tab, pending.sessionId);
    this.logBound(pending.sessionId, tab, match >= 0 ? 'title matches the expected chat' : 'the only expected chat');
    return true;
  }

  /** Whether the tab opened after the open sequence number `seq` (an expectation's or a claim's). */
  private isNewSince(tab: vscode.Tab, seq: number): boolean {
    return (this.openedAt.get(tab)?.seq ?? 0) > seq;
  }

  /** The titles a pending chat's tab can show: the row name it was expected with, and its known titles. */
  private titlesOf(entry: PendingSurface): string[] {
    const known = this.titleSource?.().filter((candidate) => candidate.sessionId === entry.sessionId).flatMap((candidate) => candidate.titles) ?? [];
    return [entry.label, ...known];
  }

  /** A pre-existing tab is this chat's only when no other unbound tab carries one of its titles, and the tab names no other chat. */
  private provenFor(tab: vscode.Tab, entry: PendingSurface): boolean {
    // A partial title source cannot prove "no other chat carries this title".
    if (this.titlesUnsettled() || !namingTitle(tab.label) || this.namesOther(tab, entry.sessionId)) {
      return false;
    }
    const titles = this.titlesOf(entry);
    const carriers = this.uiTabs().filter((other) => !this.tabs.has(other) && titles.some((title) => labelsMatch(other.label, title)));
    return carriers.length === 1 && carriers[0] === tab;
  }

  /** A title source is set but its listing has not landed: titles cannot yet prove anything. */
  private titlesUnsettled(): boolean {
    return this.titleSource !== undefined && !this.titlesTrusted;
  }

  /** Whether the tab's title names a chat of this folder other than `sessionId`. */
  private namesOther(tab: vscode.Tab, sessionId: string): boolean {
    if (!namingTitle(tab.label)) {
      return false;
    }
    // Conservative while the source is partial: the chat it names may not be listed yet.
    if (this.titlesUnsettled()) {
      return true;
    }
    return (this.titleSource?.() ?? []).some(
      (candidate) => candidate.sessionId !== sessionId && candidate.titles.some((title) => labelsMatch(tab.label, title))
    );
  }

  /**
   * Bind each unbound tab whose title names exactly one candidate session
   * that has no tab yet, when no other unbound tab names that session (I1).
   * A session whose binding was just released into the move window is left
   * to the move's pairing. An adopted session's pending expectation, claim
   * or late claim is satisfied by the tab, so a serial open that only
   * revealed it stops waiting.
   */
  private adoptTabs(): boolean {
    const source = this.titleSource;
    if (!source || !this.titlesTrusted) {
      return false;
    }
    const unbound = this.uiTabs().filter((tab) => !this.tabs.has(tab) && !this.sessionIdForTab?.(tab) && namingTitle(tab.label));
    if (unbound.length === 0) {
      return false;
    }
    const now = this.now();
    const moving = new Set(this.released.filter((entry) => now - entry.at <= MOVE_WINDOW_MS).map((entry) => entry.sessionId));
    const titles = new Map<string, string[]>();
    for (const candidate of source()) {
      if (!this.isOpen(candidate.sessionId) && !moving.has(candidate.sessionId)) {
        titles.set(candidate.sessionId, [...(titles.get(candidate.sessionId) ?? []), ...candidate.titles]);
      }
    }
    const fits = (tab: vscode.Tab, sessionId: string) => titles.get(sessionId)!.some((title) => labelsMatch(tab.label, title));
    let changed = false;
    for (const tab of unbound) {
      const named = [...titles.keys()].filter((sessionId) => fits(tab, sessionId));
      if (named.length !== 1 || unbound.filter((other) => fits(other, named[0])).length !== 1) {
        continue;
      }
      const [sessionId] = named;
      this.mapTab(tab, sessionId);
      this.pending = this.pending.filter((entry) => entry.sessionId !== sessionId);
      for (const claim of [this.claim, ...this.late]) {
        if (claim && !claim.tab && claim.sessionId === sessionId) {
          claim.tab = tab;
          claim.arrived();
        }
      }
      this.logBound(sessionId, tab, 'adopted: its title names one chat of this folder');
      changed = true;
    }
    return changed;
  }

  /** Map a tab to a session, keeping the reverse index in step. */
  private mapTab(tab: vscode.Tab, sessionId: string): boolean {
    if (this.tabs.get(tab) === sessionId) {
      return false;
    }
    this.unmapTab(tab);
    this.tabs.set(tab, sessionId);
    const mapped = this.sessionTabs.get(sessionId) ?? new Set<vscode.Tab>();
    mapped.add(tab);
    this.sessionTabs.set(sessionId, mapped);
    return true;
  }

  /** Drop a tab's mapping, whatever session it was bound to. */
  private unmapTab(tab: vscode.Tab): boolean {
    const sessionId = this.tabs.get(tab);
    if (!sessionId) {
      return false;
    }
    this.tabs.delete(tab);
    const mapped = this.sessionTabs.get(sessionId);
    if (mapped) {
      mapped.delete(tab);
      if (mapped.size === 0) {
        this.sessionTabs.delete(sessionId);
      }
    }
    return true;
  }

  /**
   * Keep every per-tab fact on the Tab objects the editor has now. A re-sent
   * tab model replaces every Tab object and fires a group event only (see
   * the top of this file), so each Claude tab that vanished is paired with
   * its replacement, which takes its binding and its move stamp. Cursor
   * re-sends between a move's open and its close: without the stamp, the
   * close would find no moved copy and drop the binding (live F1).
   *
   * Pairing, in order: by place in the editor order when the number of
   * Claude tabs is unchanged (a re-send keeps the order, and new chats all
   * share one title, so a title cannot tell them apart); else by place in
   * the group, for each group whose count is unchanged; else by title and
   * kind, when exactly one vanished and one new tab share them. A bound tab
   * left unpaired is released into the move window, where a copy arriving
   * later (or a new tab of this re-send that fits it alone) takes it.
   *
   * On a tab event, the tabs it opened and closed are its own business, not
   * a re-send's: they are left to `handleTabChange`.
   */
  private reconcile(event?: vscode.TabChangeEvent): boolean {
    const previous = this.layout;
    const current = this.uiTabsByGroup();
    const present = new Set(current.flat());
    const closed = new Set(event?.closed ?? []);
    const opened = new Set(event?.opened ?? []);
    const gone = [...new Set([...previous.flat(), ...this.tabs.keys()])].filter((tab) => !present.has(tab) && !closed.has(tab));
    if (gone.length === 0) {
      return false;
    }
    const before = new Set(previous.flat());
    const fresh = new Set(current.flat().filter((tab) => !before.has(tab) && !opened.has(tab)));
    const pairs = new Map<vscode.Tab, { tab: vscode.Tab; by: string }>();
    const pair = (old: vscode.Tab, replacement: vscode.Tab | undefined, by: string) => {
      if (replacement && !present.has(old) && fresh.has(replacement) && !pairs.has(old)) {
        pairs.set(old, { tab: replacement, by });
        fresh.delete(replacement);
      }
    };
    if (previous.flat().length === current.flat().length) {
      const now = current.flat();
      previous.flat().forEach((old, place) => pair(old, now[place], 'place'));
    } else if (previous.length === current.length) {
      previous.forEach((group, g) => {
        if (group.length === current[g].length) {
          group.forEach((old, index) => pair(old, current[g][index], 'place in group'));
        }
      });
    }
    const key = (tab: vscode.Tab) => `${tabKind(tab)}\u0000${tab.label}`;
    const unpaired = gone.filter((tab) => !pairs.has(tab));
    for (const old of unpaired) {
      const sameKey = (tab: vscode.Tab) => key(tab) === key(old);
      const candidates = [...fresh].filter(sameKey);
      if (candidates.length === 1 && unpaired.filter(sameKey).length === 1) {
        pair(old, candidates[0], 'title');
      }
    }

    const now = this.now();
    let changed = false;
    for (const old of gone) {
      const sessionId = this.tabs.get(old);
      const replacement = pairs.get(old);
      const stamp = this.openedAt.get(old);
      if (replacement) {
        this.successor.set(old, replacement.tab);
      }
      if (replacement && stamp) {
        this.openedAt.set(replacement.tab, stamp);
      }
      if (replacement && this.unvisited.delete(old)) {
        this.unvisited.add(replacement.tab);
        const started = this.visitStartedAt.get(old);
        this.visitStartedAt.delete(old);
        if (started !== undefined) {
          this.visitStartedAt.set(replacement.tab, started);
        }
      }
      if (sessionId === undefined) {
        continue;
      }
      this.unmapTab(old);
      changed = true;
      if (replacement && !this.tabs.has(replacement.tab)) {
        this.mapTab(replacement.tab, sessionId);
        this.decide('follow', sessionId, replacement.tab, `re-sent model, by ${replacement.by}`);
      } else {
        this.released.push({ sessionId, kind: tabKind(old), label: old.label, at: now });
        this.decide('release', sessionId, old, 'gone from a re-sent model');
      }
    }
    for (const tab of fresh) {
      changed = this.rebindReleased(tab, now, true) || changed;
    }
    return changed;
  }

  /**
   * After every tab or group event (and its re-send pairing; a group switch
   * or a re-send fires no tab event): an unvisited tab shown now, the
   * selected tab of its group, starts its visit, whose webview loads now. A
   * visit never ends on the tab being hidden again: the selected tab of a
   * group that lost focus stays selected (QA C1). It ends with its hold or
   * RESTORED_DEADLINE_CAP_MS after it started; a tab that is gone is dropped.
   */
  private trackVisits(): void {
    if (this.unvisited.size === 0) {
      return;
    }
    const present = new Set(this.layout.flat());
    const now = this.now();
    for (const tab of [...this.unvisited]) {
      const started = this.visitStartedAt.get(tab);
      if (!present.has(tab) || (started !== undefined && now - started > RESTORED_DEADLINE_CAP_MS)) {
        this.endFirstVisit(tab);
      } else if (started === undefined && tab.isActive) {
        this.visitStartedAt.set(tab, now);
      }
    }
  }

  /** Returns true when the active native-UI session changed. */
  private updateActiveSession(): boolean {
    const active = this.activeSessionId();
    if (active === this.lastActiveSessionId) {
      return false;
    }
    this.lastActiveSessionId = active;
    return true;
  }

  /** Drop expectations whose tab never appeared. */
  private prunePending(): void {
    const now = Date.now();
    this.pending = this.pending.filter((entry) => entry.expiresAt > now);
  }
}

/** A tab title and a chat name match exactly or by a truncated prefix. */
function labelsMatch(tabLabel: string, chatName: string): boolean {
  const label = tabLabel.trim();
  const name = chatName.trim();
  if (!label || !name) {
    return false;
  }
  if (label === name) {
    return true;
  }
  if (label.endsWith('…')) {
    const prefix = label.slice(0, -1);
    return prefix.length > 0 && name.startsWith(prefix);
  }
  return false;
}
