import * as fs from 'fs';
import * as vscode from 'vscode';
import { ChatSession, Worktree } from '../types';
import { HarnessRegistry } from '../harness/HarnessRegistry';
import { pathKey, samePath } from '../utils/paths';
import { errorMessage } from '../utils/text';
import { logOperation } from '../services/OperationLog';
import type { WindowRegistry } from './WindowRegistry';
import { EXPIRE_MS, HandoffInbox, HandoffKind, HandoffOutcome, HandoffRequest, WARN_MS } from './HandoffInbox';
import { OPEN_ITS_WINDOW, raiseFolderWindow } from './raiseWindow';

/**
 * Where a route landed: opened in this window, handed to another, held back
 * because every chat is live in a terminal Pitwall doesn't own (Q28, Q48), or
 * nowhere (its folder is gone, nothing to hand over, or no window could be reached).
 */
export type RouteResult = 'here' | 'routed' | 'outside' | 'gone';

export interface RouterTiming {
  /** Warn once when no `done` with `ok` arrives within this long, when the folder had a window (Q16). */
  warnMs: number;
  /** The same wait when the folder had no window yet: a new window takes 22–30 s to start Pitwall (Q26). */
  coldWarnMs: number;
  /** Expire a request nobody claimed after this long (Q16). */
  expireMs: number;
  /**
   * Raise the folder once more when no window has registered for it this
   * long after the request (live I2: Cursor sometimes drops the first open
   * of a folder whose window closed minutes before). Never below 45 s: a
   * new window takes 22–30 s to start Pitwall.
   */
  retryOpenMs: number;
  /** How often the sender reads the request's outcome. */
  pollMs: number;
  /** How long a click made before the window services started waits for them. */
  servicesWaitMs: number;
}

export const ROUTER_TIMING: RouterTiming = { warnMs: WARN_MS, coldWarnMs: 60_000, expireMs: EXPIRE_MS, retryOpenMs: 45_000, pollMs: 250, servicesWaitMs: 2_000 };
/** How often an early click checks whether the window services have started. */
const SERVICES_CHECK_MS = 50;

/** §3f, new copy. */
export const folderGoneMessage = (folder: string): string => `That chat's folder is gone: ${folder}`;
/** §3f, new copy. */
export const unreachedMessage = (repo: string): string => `Pitwall couldn't reach the ${repo} window. Click the chat again.`;
/** Q28, new copy: a chat a terminal outside Pitwall is running is never opened a second time. */
export const outsideTerminalMessage = (pid: number, panel = false): string =>
  panel
    ? `That chat is already running in another window or terminal (pid ${pid}). Switch to it there.`
    : `That chat is already running in another terminal (pid ${pid}). Switch to it there.`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChatRouterDeps {
  /** The handoff inbox, once the window services have started (after first render). */
  services: () => { inbox: HandoffInbox; registry?: Pick<WindowRegistry, 'windowsFor' | 'windows'> } | undefined;
  /** This window's folder: `workspaceFolders[0]`, Claude's own rule. Undefined in an empty window. */
  windowFolder: () => string | undefined;
  harnessRegistry: Pick<HarnessRegistry, 'has' | 'get' | 'all'>;
  worktreeOf: (chat: ChatSession) => Promise<Worktree | undefined>;
  /**
   * The chat's worktree for a request this window claimed, answered without
   * git (the request names the folder), or undefined when it cannot be.
   * A worktree window's claim then never waits on a worktree listing (live E6).
   */
  worktreeFor?: (chat: ChatSession, folder: string) => Worktree | undefined;
  /** The folders a worktree's repo owns: its main folder and every worktree. */
  rootsOf: (worktree: Worktree) => string[];
  /** The sidebar name of the repo holding a folder, for the warning. */
  repoName: (folder: string) => string;
  /** Whether the chat's terminal or agent-UI tab is open in this window (a click then reveals it here). */
  isOpenHere: (chat: ChatSession) => boolean;
  /** This window's row for a native session, if it has one. */
  chatForSession: (sessionId: string) => ChatSession | undefined;
  /**
   * Open a chat in this window (T2's path). `worktree.path` is the launch
   * folder, which availability is checked against (Q2). Resolves false when
   * nothing opened, and 'terminal' when it opened in a terminal (no tab).
   */
  openHere: (chat: ChatSession, worktree: Worktree, options: { keepListFocus: boolean }) => Promise<boolean | 'terminal'>;
  /** Start a new chat in a folder this window shows. */
  startNew: (folder: string) => Promise<boolean>;
  /**
   * The pid of a live agent process running this session outside anything
   * Pitwall owns (a terminal the user started), if any (Q28). Asked only for a
   * chat that is not open here or in another Pitwall window: those are Pitwall's.
   * A panel's `cwd` names its window (D35): a panel tab Pitwall never bound
   * (its title is shared, W4(b)) still routes there.
   */
  outsideTerminal?: (sessionId: string) => Promise<{ pid: number; panel?: boolean; cwd?: string } | undefined>;
  /**
   * Open sessions one at a time, binding each new tab to its session (the tab
   * tracker's `openSerially`). Used for `openAll` and `sideBySide`; a single
   * open keeps T2's own binding.
   */
  openSerially?: (sessionIds: string[], open: (sessionId: string) => Promise<unknown>) => Promise<unknown>;
  /** Put these sessions' tabs side by side in this window (at most 4 panes, Q15). */
  sideBySide?: (sessionIds: string[]) => Promise<void>;
  /** Where the `[Pitwall] route ...` diagnostic lines go; the Operations log by default. */
  log?: (line: string) => void;
  timing?: Partial<RouterTiming>;
}

/**
 * Clicking a chat lands in its folder's window (rows 4.2, 4.6, 4.8). A chat
 * whose launch folder is this window's opens here; any other is written to
 * that folder's handoff inbox and its window raised with `vscode.openFolder`
 * (which opens one only when none exists, S1). The window there claims the
 * request and opens it through `runClaimed`. The sender dedupes a pending
 * request, warns once unless a `done` with `ok` arrives within 20 s, and
 * expires an unclaimed one at 120 s (Q16).
 */
export class ChatRouter implements vscode.Disposable {
  private readonly timing: RouterTiming;
  /** The last launch folder read per session; only the search box's meta reads it. */
  private readonly launchFolders = new Map<string, string>();
  private readonly timers = new Set<NodeJS.Timeout>();
  /** Routes still running, by what they route (kind and chats, or "+" and its folder). */
  private readonly inFlight = new Map<string, Promise<RouteResult>>();
  /** Requests this window sent that are not done, failed or expired yet, by folder, kind and chats. */
  private readonly sent = new Set<string>();
  /** Claimed batches open one after another, never interleaved. */
  private claims: Promise<void> = Promise.resolve();
  private uiActivated = false;
  private disposed = false;

  constructor(private readonly deps: ChatRouterDeps) {
    this.timing = { ...ROUTER_TIMING, ...deps.timing };
  }

  dispose(): void {
    this.disposed = true;
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
  }

  /**
   * A chat's launch folder (Q2): where its agent's UI resumes it, as its
   * harness reads it from the transcript, among its repo's folders. Falls
   * back to the chat's worktree. Read on every call, never from a cache:
   * EnterWorktree can move a transcript to another project folder at any
   * time (QA #51), and the read stops at the first cwd.
   */
  async launchFolder(chat: ChatSession, worktree?: Worktree): Promise<string | undefined> {
    const target = worktree ?? (await this.deps.worktreeOf(chat));
    const sessionId = chat.harnessSessionId;
    if (!sessionId || !this.deps.harnessRegistry.has(chat.harness)) {
      return target?.path;
    }
    let found: string | undefined;
    try {
      found = await this.deps.harnessRegistry.get(chat.harness).launchFolder?.(sessionId, target ? this.deps.rootsOf(target) : []);
    } catch {
      found = undefined;
    }
    if (found) {
      this.launchFolders.set(sessionId, found);
    } else {
      this.launchFolders.delete(sessionId);
    }
    return found ?? target?.path;
  }

  /**
   * Whether a click on this chat opens it here, from what is known now (the
   * last launch folder read, else its worktree), for the search box's meta.
   */
  opensHere(chat: ChatSession, worktree: Worktree | undefined): boolean {
    const here = this.deps.windowFolder();
    const folder = (chat.harnessSessionId && this.launchFolders.get(chat.harnessSessionId)) || worktree?.path;
    return Boolean(here && folder && samePath(here, folder));
  }

  /**
   * Open chats (or start one, kind `new`) in their folders' windows. Chats of
   * this window's folder open here, serially; the rest go to their window,
   * one request per folder. A chat whose folder is gone opens nothing and
   * shows a warning.
   *
   * A second route for the same thing while the first is still running (a
   * fast double click, live E4) joins the first rather than sending its own
   * request: it is matched synchronously, before anything is awaited.
   */
  route(
    req: { kind: HandoffKind; chats: ChatSession[]; folder?: string },
    options: { keepListFocus?: boolean } = {}
  ): Promise<RouteResult> {
    const key =
      req.kind === 'new'
        ? `new|${req.folder ? pathKey(req.folder) : ''}`
        : `${req.kind}|${req.chats.map((chat) => chat.harnessSessionId ?? chat.id).sort().join(',')}`;
    const running = this.inFlight.get(key);
    if (running) {
      return running;
    }
    const run = this.routeNow(req, options).finally(() => {
      if (this.inFlight.get(key) === run) {
        this.inFlight.delete(key);
      }
    });
    this.inFlight.set(key, run);
    return run;
  }

  private async routeNow(
    req: { kind: HandoffKind; chats: ChatSession[]; folder?: string },
    options: { keepListFocus?: boolean }
  ): Promise<RouteResult> {
    const keepListFocus = options.keepListFocus ?? false;
    if (req.kind === 'new') {
      const folder = req.folder;
      if (!folder) {
        return 'gone';
      }
      if (!fs.existsSync(folder)) {
        this.logNewRoute(folder, 'gone');
        void vscode.window.showWarningMessage(folderGoneMessage(folder));
        return 'gone';
      }
      if (this.isThisWindow(folder)) {
        this.logNewRoute('here', 'same-folder');
        await this.deps.startNew(folder);
        return 'here';
      }
      this.logNewRoute(folder, 'handoff');
      return (await this.handOff(folder, 'new', [])) ? 'routed' : 'gone';
    }

    const local: { chat: ChatSession; worktree: Worktree }[] = [];
    const remote = new Map<string, { folder: string; ids: string[]; reasons: Map<string, string> }>();
    const gone = new Set<string>();
    let blocked = 0;
    /** Chats held back by the outside-terminal guard (Q28): counted apart, so a route of only those is 'outside' (Q48). */
    let outsideTerminal = 0;
    const hand = (folder: string, id: string, reason: string) => {
      const key = pathKey(folder);
      const group = remote.get(key) ?? { folder, ids: [] as string[], reasons: new Map<string, string>() };
      group.ids.push(id);
      group.reasons.set(id, reason);
      remote.set(key, group);
    };
    for (const chat of req.chats) {
      const worktree = await this.deps.worktreeOf(chat);
      if (!worktree) {
        continue;
      }
      const id = chat.harnessSessionId ?? chat.id;
      // One agent process per session. Where the session is live decides
      // first: Claude files a transcript under the session's current folder,
      // which moves with EnterWorktree, so the launch folder alone would start
      // a second process beside the live one.
      if (this.deps.isOpenHere(chat)) {
        this.logRoute(id, 'here', 'open-here');
        local.push({ chat, worktree: { ...worktree, path: this.deps.windowFolder() ?? worktree.path } });
        continue;
      }
      const there = this.canHandOff(chat) ? await this.windowOpening(chat.harnessSessionId!) : undefined;
      if (there) {
        hand(there, chat.harnessSessionId!, 'open-there');
        continue;
      }
      // Neither open here nor in another Pitwall window: a live process for it
      // is one Pitwall doesn't own (a terminal the user started). A second
      // process on the session would fork it, so Pitwall warns and opens nothing.
      const outside = chat.harnessSessionId ? await this.deps.outsideTerminal?.(chat.harnessSessionId).catch(() => undefined) : undefined;
      if (outside?.panel && this.canHandOff(chat)) {
        // A panel runs in some editor window whose tab Pitwall never bound (a
        // shared title, W4(b)). One window per folder (D35): its folder names
        // the window. Opening there makes the agent's UI re-send its open tab,
        // never a second process. This window's own panel never gets here (it
        // is no outsider), so a panel in this window's folder belongs to a
        // second window on it: opening here would fork the session, so it
        // keeps the warning below.
        const folder = outside.cwd || ((await this.launchFolder(chat, worktree)) ?? worktree.path);
        if (!this.isThisWindow(folder) && (await this.hasWindow(folder))) {
          hand(folder, chat.harnessSessionId!, 'open-there-unbound');
          continue;
        }
      }
      if (outside !== undefined) {
        this.logRoute(id, 'elsewhere', 'outside-terminal');
        void vscode.window.showWarningMessage(outsideTerminalMessage(outside.pid, outside.panel));
        outsideTerminal++;
        continue;
      }
      if (!this.canHandOff(chat)) {
        if ((!chat.harnessSessionId || chat.pendingUiLaunch) && !this.isThisWindow(worktree.path)) {
          // Nothing to hand over, and its folder is another window's: starting it here would
          // run a chat for that folder in this window.
          this.logRoute(id, worktree.path, 'no-transcript-elsewhere');
          blocked++;
          continue;
        }
        // Nothing of this chat exists natively to hand over: it stays here.
        this.logRoute(id, 'here', 'no-transcript');
        local.push({ chat, worktree });
        continue;
      }
      // Open nowhere: the launch folder decides (D35).
      const folder = (await this.launchFolder(chat, worktree)) ?? worktree.path;
      if (!fs.existsSync(folder)) {
        this.logRoute(id, folder, 'gone');
        gone.add(folder);
      } else if (this.isThisWindow(folder)) {
        this.logRoute(id, 'here', 'same-folder');
        local.push({ chat, worktree: { ...worktree, path: folder } });
      } else {
        hand(folder, chat.harnessSessionId!, 'handoff');
      }
    }

    for (const folder of gone) {
      void vscode.window.showWarningMessage(folderGoneMessage(folder));
    }
    const idOf = (chat: ChatSession) => chat.harnessSessionId ?? chat.id;
    const byId = new Map(local.map((entry) => [idOf(entry.chat), entry]));
    const openLocal = async (id: string): Promise<boolean | 'terminal'> => {
      const entry = byId.get(id)!;
      return this.deps.openHere(entry.chat, entry.worktree, { keepListFocus });
    };
    const ids = local.map((entry) => idOf(entry.chat));
    await this.openChats(req.kind, ids, openLocal);
    let routed = 0;
    for (const { folder, ids, reasons } of remote.values()) {
      const sent = await this.handOff(folder, req.kind, ids);
      for (const id of ids) {
        this.logRoute(id, folder, sent ? reasons.get(id)! : 'no-services');
      }
      routed += sent ? 1 : 0;
    }
    if (routed > 0) {
      return 'routed';
    }
    if (local.length > 0) {
      return 'here';
    }
    const elsewhere = gone.size > 0 || remote.size > 0 || blocked > 0;
    if (outsideTerminal > 0 && !elsewhere) {
      return 'outside';
    }
    return elsewhere ? 'gone' : 'here';
  }

  /**
   * Open chats in this window. `openAll` and `sideBySide` go one at a time
   * through the tab tracker, which binds each new tab to the session just
   * requested; `sideBySide` then splits what opened (Q15). A single open
   * keeps T2's own binding.
   */
  private async openChats(kind: HandoffKind, ids: string[], open: (id: string) => Promise<boolean | 'terminal'>): Promise<string[]> {
    const opened: string[] = [];
    const inTab: string[] = [];
    const openOne = async (id: string): Promise<boolean> => {
      const result = await open(id);
      if (result) {
        opened.push(id);
      }
      // A terminal open makes no tab, so the tracker has nothing to wait for.
      if (result === true) {
        inTab.push(id);
      }
      return result === true;
    };
    if ((kind === 'openAll' || kind === 'sideBySide') && this.deps.openSerially) {
      await this.deps.openSerially(ids, openOne);
    } else {
      for (const id of ids) {
        await openOne(id);
      }
    }
    if (kind === 'sideBySide' && inTab.length > 0) {
      // In the order asked, whatever order the opens finished in.
      await this.deps.sideBySide?.(ids.filter((id) => inTab.includes(id)));
    }
    return opened;
  }

  /**
   * Open the requests this window claimed, in order and one chat at a time,
   * and report each as `done` (Q16). Availability is checked against the
   * request's folder, the launch folder the sender computed (Q2). The agent's
   * UI extension is activated before the first open (a fresh window may not
   * have started it yet, S2b).
   */
  runClaimed(reqs: HandoffRequest[], inbox?: HandoffInbox): Promise<void> {
    const run = this.claims.then(() => this.openClaimed(reqs, inbox));
    this.claims = run.catch(() => undefined);
    return run;
  }

  private async openClaimed(reqs: HandoffRequest[], given?: HandoffInbox): Promise<void> {
    const inbox = given ?? this.deps.services()?.inbox;
    for (const req of reqs) {
      let outcome: HandoffOutcome;
      try {
        outcome = req.kind === 'new' ? await this.startClaimed(req) : await this.openClaimedChats(req);
      } catch (error) {
        outcome = { ok: false, error: errorMessage(error) };
      }
      await inbox?.complete(req.nonce, outcome).catch(() => undefined);
    }
  }

  private async startClaimed(req: HandoffRequest): Promise<HandoffOutcome> {
    return (await this.deps.startNew(req.folder)) ? { ok: true } : { ok: false, error: `could not start a chat in ${req.folder}` };
  }

  private async openClaimedChats(req: HandoffRequest): Promise<HandoffOutcome> {
    await this.activateUi();
    const failed: string[] = [];
    await this.openChats(req.kind, req.sessionIds, async (sessionId) => {
      const chat = this.deps.chatForSession(sessionId);
      // The lookup that waits on nothing first; the awaited one (which can wait on the listing) only when it knows nothing.
      const quick = chat && this.deps.worktreeFor?.(chat, req.folder);
      if (chat) {
        this.log(`[Pitwall] claim lookup ${sessionId.slice(0, 8)} (${quick ? 'no-wait' : 'awaited'})`);
      }
      const worktree = chat && (quick || (await this.deps.worktreeOf(chat)));
      const opened =
        chat && worktree
          ? await this.deps.openHere(chat, { ...worktree, path: req.folder }, { keepListFocus: false })
          : await this.openUnlisted(sessionId, req.folder);
      if (!opened) {
        failed.push(sessionId.slice(0, 8));
      }
      return opened;
    });
    return failed.length === 0 ? { ok: true } : { ok: false, error: `could not open ${failed.join(', ')}` };
  }

  /** A session this window has no row for yet: hand it straight to the agent's UI. */
  private async openUnlisted(sessionId: string, folder: string): Promise<boolean> {
    const ui = this.deps.harnessRegistry.all().find((adapter) => adapter.nativeUi)?.nativeUi;
    if (!ui) {
      return false;
    }
    try {
      return (await ui.openSession(sessionId, folder)).kind === 'opened';
    } catch {
      return false;
    }
  }

  private async activateUi(): Promise<void> {
    if (this.uiActivated) {
      return;
    }
    this.uiActivated = true;
    for (const adapter of this.deps.harnessRegistry.all()) {
      const id = adapter.nativeUi?.extensionId;
      if (id) {
        try {
          await vscode.extensions.getExtension(id)?.activate();
        } catch {
          // The open below reports a UI that can't start.
        }
      }
    }
  }

  private isThisWindow(folder: string): boolean {
    const here = this.deps.windowFolder();
    return here !== undefined && samePath(here, folder);
  }

  /** Whether a live Pitwall window shows this folder (its heartbeat says so). */
  private async hasWindow(folder: string): Promise<boolean> {
    const windows = (await this.deps.services()?.registry?.windowsFor(folder).catch(() => [])) ?? [];
    return windows.length > 0;
  }

  /** The folder of another window that has this session open, if any (its heartbeat lists it). */
  private async windowOpening(sessionId: string): Promise<string | undefined> {
    const registry = this.deps.services()?.registry;
    const windows = (await registry?.windows().catch(() => [])) ?? [];
    return windows.find((w) => w.folder && !this.isThisWindow(w.folder) && w.openSessionIds.includes(sessionId))?.folder;
  }

  private log(line: string): void {
    (this.deps.log ?? logOperation)(line);
  }

  /** Log one routing decision (`here`, or the folder it went to or was missing). */
  private logRoute(id: string, where: string, reason: string): void {
    const line = `[Pitwall] route ${id.slice(0, 8)} → ${where} (${reason})`;
    (this.deps.log ?? logOperation)(line);
  }

  /** Log where a "+" went: `same-folder` (here), `handoff` (another window) or `gone`. */
  private logNewRoute(folder: string, reason: string): void {
    (this.deps.log ?? logOperation)(`[Pitwall] route new → ${folder} (${reason})`);
  }

  /**
   * Whether this chat has a native session another window can open: a real
   * session id, not still starting in its UI, a harness this build knows.
   * Whether its UI can resume it (Q23) is the target window's local open to
   * decide (a terminal there), never a reason to open it in the wrong window.
   */
  private canHandOff(chat: ChatSession): boolean {
    const sessionId = chat.harnessSessionId;
    return Boolean(sessionId && UUID.test(sessionId) && !chat.pendingUiLaunch && this.deps.harnessRegistry.has(chat.harness));
  }

  /** Send a request (unless the same one is pending) and raise the folder's window. */
  private async handOff(folder: string, kind: HandoffKind, ids: string[]): Promise<boolean> {
    const services = await this.servicesReady();
    if (this.disposed) {
      return false;
    }
    const inbox = services?.inbox;
    if (!services || !inbox) {
      // Raising the window without a request would bring it up with no chat.
      void vscode.window.showWarningMessage(unreachedMessage(this.deps.repoName(folder)));
      return false;
    }
    // Checked and marked before anything is awaited, so a request this window
    // has in flight is never sent twice; the file check below covers the ones
    // another window, or this one before a reload, sent.
    const key = `${pathKey(folder)}|${kind}|${[...ids].sort().join(',')}`;
    if (!this.sent.has(key)) {
      this.sent.add(key);
      const release = () => this.sent.delete(key);
      try {
        const pending = await inbox.pending(folder, kind, ids).catch(() => undefined);
        if (pending) {
          release();
        } else {
          // A folder with no window yet is a cold open, which gets the longer wait (Q26).
          const windows = (await services.registry?.windowsFor(folder).catch(() => [])) ?? [];
          const warnMs = windows.length > 0 ? this.timing.warnMs : this.timing.coldWarnMs;
          const nonce = await inbox.send(folder, { kind, sessionIds: ids });
          this.watchOutcome(inbox, folder, nonce, warnMs, release, services.registry);
        }
      } catch (error) {
        release();
        throw error;
      }
    }
    // The repo menu's "Open its window" makes this same call (I2).
    await raiseFolderWindow(folder);
    return true;
  }

  /**
   * The window services, waiting up to 2 s for them: they start after the
   * list's first render, so a click in the first moment after activation
   * comes before them. Undefined when they still aren't up.
   */
  private async servicesReady(): Promise<ReturnType<ChatRouterDeps['services']>> {
    const deadline = Date.now() + this.timing.servicesWaitMs;
    for (;;) {
      const services = this.deps.services();
      if (services || this.disposed || Date.now() >= deadline) {
        return services;
      }
      await new Promise((resolve) => setTimeout(resolve, SERVICES_CHECK_MS));
    }
  }

  /**
   * Read the request's outcome until a `done` arrives. A failed one warns at
   * once; no `ok` within `warnMs` (20 s, or 60 s for a cold open) warns once;
   * an unclaimed request is expired at 120 s (Q16, Q26). Never toasts on
   * success (Q6). `settled` runs once the request is done, failed or expired.
   * When no window has registered for the folder `retryOpenMs` (45 s) after
   * the request, the folder is raised once more (I2). The warning offers
   * "Open its window", the repo menu's own call.
   */
  private watchOutcome(
    inbox: HandoffInbox,
    folder: string,
    nonce: string,
    warnMs: number,
    settled: () => void,
    registry?: Pick<WindowRegistry, 'windowsFor'>
  ): void {
    const startedAt = Date.now();
    let warned = false;
    let retried = false;
    /** When the retry raised the window; the toast waits `retryOpenMs` more, so the retried window has its 22-30 s to start. */
    let retriedAt: number | undefined;
    // A closing window (a disposed router) never warns, even when a read it
    // started before closing returns afterwards.
    const warn = () => {
      if (!warned && !this.disposed) {
        warned = true;
        void Promise.resolve(vscode.window.showWarningMessage(unreachedMessage(this.deps.repoName(folder)), OPEN_ITS_WINDOW)).then((choice) =>
          choice === OPEN_ITS_WINDOW ? raiseFolderWindow(folder) : undefined
        );
      }
    };
    /** Raise the folder once more if no window has registered for it. */
    const retry = async (): Promise<void> => {
      retried = true;
      const windows = await registry?.windowsFor(folder).catch(() => undefined);
      if (windows && windows.length === 0 && !this.disposed) {
        (this.deps.log ?? logOperation)(`[Pitwall] handoff retry ${nonce.slice(0, 8)} → ${folder} (no window after ${Math.round((Date.now() - startedAt) / 1000)} s)`);
        await Promise.resolve(raiseFolderWindow(folder)).catch(() => undefined);
        retriedAt = Date.now();
      }
    };
    const tick = async (): Promise<void> => {
      if (this.disposed) {
        return;
      }
      const outcome = await inbox.outcome(folder, nonce).catch(() => undefined);
      if (this.disposed) {
        return;
      }
      if (outcome) {
        if (!outcome.ok) {
          warn();
        }
        settled();
        return;
      }
      const age = Date.now() - startedAt;
      if (!retried && age >= this.timing.retryOpenMs) {
        await retry();
      }
      if (age >= warnMs && (retriedAt === undefined || Date.now() - retriedAt >= this.timing.retryOpenMs)) {
        warn();
      }
      if (age >= this.timing.expireMs) {
        await inbox.expire(folder, nonce).catch(() => false);
        settled();
        return;
      }
      this.schedule(tick);
    };
    this.schedule(tick);
  }

  private schedule(tick: () => Promise<void>): void {
    if (this.disposed) {
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void tick();
    }, this.timing.pollMs);
    timer.unref?.();
    this.timers.add(timer);
  }
}
