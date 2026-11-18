import * as fs from 'fs';
import * as vscode from 'vscode';
import { ChatSession, Worktree } from '../types';
import { HarnessRegistry } from '../harness/HarnessRegistry';
import { pathKey, samePath } from '../utils/paths';
import { errorMessage } from '../utils/text';
import { EXPIRE_MS, HandoffInbox, HandoffKind, HandoffOutcome, HandoffRequest, WARN_MS } from './HandoffInbox';

/** Where a route landed: opened in this window, handed to another, or nowhere (its folder is gone). */
export type RouteResult = 'here' | 'routed' | 'gone';

export interface RouterTiming {
  /** Warn once when no `done` with `ok` arrives within this long (Q16). */
  warnMs: number;
  /** Expire a request nobody claimed after this long (Q16). */
  expireMs: number;
  /** How often the sender reads the request's outcome. */
  pollMs: number;
}

export const ROUTER_TIMING: RouterTiming = { warnMs: WARN_MS, expireMs: EXPIRE_MS, pollMs: 250 };

/** §3f, new copy. */
export const folderGoneMessage = (folder: string): string => `That chat's folder is gone: ${folder}`;
/** §3f, new copy. */
export const unreachedMessage = (repo: string): string => `Pitwall couldn't reach the ${repo} window. Click the chat again.`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChatRouterDeps {
  /** The handoff inbox, once the window services have started (after first render). */
  services: () => { inbox: HandoffInbox } | undefined;
  /** This window's folder: `workspaceFolders[0]`, Claude's own rule. Undefined in an empty window. */
  windowFolder: () => string | undefined;
  harnessRegistry: Pick<HarnessRegistry, 'has' | 'get' | 'all'>;
  worktreeOf: (chat: ChatSession) => Promise<Worktree | undefined>;
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
   * nothing opened.
   */
  openHere: (chat: ChatSession, worktree: Worktree, options: { keepListFocus: boolean }) => Promise<boolean>;
  /** Start a new chat in a folder this window shows. */
  startNew: (folder: string) => Promise<boolean>;
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
  private readonly launchFolders = new Map<string, string>();
  private readonly timers = new Set<NodeJS.Timeout>();
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

  /** Drop the cached launch folders (a transcript may have been filed elsewhere since). */
  forgetLaunchFolders(): void {
    this.launchFolders.clear();
  }

  /**
   * A chat's launch folder (Q2): where its agent's UI resumes it, as its
   * harness reads it from the transcript, among its repo's folders. Falls
   * back to the chat's worktree. Cached per session.
   */
  async launchFolder(chat: ChatSession, worktree?: Worktree): Promise<string | undefined> {
    const target = worktree ?? (await this.deps.worktreeOf(chat));
    const sessionId = chat.harnessSessionId;
    if (!sessionId || !this.deps.harnessRegistry.has(chat.harness)) {
      return target?.path;
    }
    const cached = this.launchFolders.get(sessionId);
    if (cached) {
      return cached;
    }
    let found: string | undefined;
    try {
      found = await this.deps.harnessRegistry.get(chat.harness).launchFolder?.(sessionId, target ? this.deps.rootsOf(target) : []);
    } catch {
      found = undefined;
    }
    if (found) {
      this.launchFolders.set(sessionId, found);
    }
    return found ?? target?.path;
  }

  /**
   * Whether a click on this chat opens it here, from what is known now (the
   * cached launch folder, else its worktree), for the search box's meta.
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
   */
  async route(
    req: { kind: HandoffKind; chats: ChatSession[]; folder?: string },
    options: { keepListFocus?: boolean } = {}
  ): Promise<RouteResult> {
    const keepListFocus = options.keepListFocus ?? false;
    if (req.kind === 'new') {
      const folder = req.folder;
      if (!folder) {
        return 'gone';
      }
      if (!fs.existsSync(folder)) {
        void vscode.window.showWarningMessage(folderGoneMessage(folder));
        return 'gone';
      }
      if (this.isThisWindow(folder)) {
        await this.deps.startNew(folder);
        return 'here';
      }
      await this.handOff(folder, 'new', []);
      return 'routed';
    }

    const local: { chat: ChatSession; worktree: Worktree }[] = [];
    const remote = new Map<string, { folder: string; ids: string[] }>();
    const gone = new Set<string>();
    for (const chat of req.chats) {
      const worktree = await this.deps.worktreeOf(chat);
      if (!worktree) {
        continue;
      }
      if (!(await this.routable(chat))) {
        local.push({ chat, worktree });
        continue;
      }
      const folder = (await this.launchFolder(chat, worktree)) ?? worktree.path;
      if (!fs.existsSync(folder)) {
        gone.add(folder);
      } else if (this.isThisWindow(folder)) {
        local.push({ chat, worktree: { ...worktree, path: folder } });
      } else {
        const key = pathKey(folder);
        const group = remote.get(key) ?? { folder, ids: [] };
        group.ids.push(chat.harnessSessionId!);
        remote.set(key, group);
      }
    }

    for (const folder of gone) {
      void vscode.window.showWarningMessage(folderGoneMessage(folder));
    }
    for (const { chat, worktree } of local) {
      await this.deps.openHere(chat, worktree, { keepListFocus });
    }
    for (const { folder, ids } of remote.values()) {
      await this.handOff(folder, req.kind, ids);
    }
    return remote.size > 0 ? 'routed' : local.length > 0 || gone.size === 0 ? 'here' : 'gone';
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
    for (const sessionId of req.sessionIds) {
      const chat = this.deps.chatForSession(sessionId);
      const worktree = chat && (await this.deps.worktreeOf(chat));
      const opened =
        chat && worktree
          ? await this.deps.openHere(chat, { ...worktree, path: req.folder }, { keepListFocus: false })
          : await this.openUnlisted(sessionId, req.folder);
      if (!opened) {
        failed.push(sessionId.slice(0, 8));
      }
    }
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

  /**
   * Whether a click may send this chat to another window. Not when it is
   * already open here (a click reveals it), has no native session yet, is
   * still starting in its UI, or is one its UI can't resume (Q23: it opens
   * in a terminal here and is never routed for a UI open).
   */
  private async routable(chat: ChatSession): Promise<boolean> {
    const sessionId = chat.harnessSessionId;
    if (!sessionId || !UUID.test(sessionId) || chat.pendingUiLaunch || this.deps.isOpenHere(chat)) {
      return false;
    }
    if (!this.deps.harnessRegistry.has(chat.harness)) {
      return false;
    }
    const ui = this.deps.harnessRegistry.get(chat.harness).nativeUi;
    try {
      return !(await ui?.resumeRefusal?.(sessionId));
    } catch {
      return true;
    }
  }

  /** Send a request (unless the same one is pending) and raise the folder's window. */
  private async handOff(folder: string, kind: HandoffKind, ids: string[]): Promise<void> {
    const inbox = this.deps.services()?.inbox;
    if (inbox) {
      const pending = await inbox.pending(folder, kind, ids).catch(() => undefined);
      if (!pending) {
        const nonce = await inbox.send(folder, { kind, sessionIds: ids });
        this.watchOutcome(inbox, folder, nonce);
      }
    }
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });
  }

  /**
   * Read the request's outcome until a `done` arrives. A failed one warns at
   * once; no `ok` within 20 s warns once; an unclaimed request is expired at
   * 120 s (Q16). Never toasts on success (Q6).
   */
  private watchOutcome(inbox: HandoffInbox, folder: string, nonce: string): void {
    const startedAt = Date.now();
    let warned = false;
    const warn = () => {
      if (!warned) {
        warned = true;
        void vscode.window.showWarningMessage(unreachedMessage(this.deps.repoName(folder)));
      }
    };
    const tick = async (): Promise<void> => {
      if (this.disposed) {
        return;
      }
      const outcome = await inbox.outcome(folder, nonce).catch(() => undefined);
      if (outcome) {
        if (!outcome.ok) {
          warn();
        }
        return;
      }
      const age = Date.now() - startedAt;
      if (age >= this.timing.warnMs) {
        warn();
      }
      if (age >= this.timing.expireMs) {
        await inbox.expire(folder, nonce).catch(() => false);
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
