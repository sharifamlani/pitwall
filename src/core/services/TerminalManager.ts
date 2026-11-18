import * as vscode from 'vscode';
import { ChatSession, Worktree } from '../types';
import { StorageService } from './StorageService';
import { HarnessRegistry } from '../harness/HarnessRegistry';
import { HarnessWatcherRegistry } from '../harness/HarnessWatcherRegistry';
import { HarnessAdapter } from '../harness/types';
import { errorMessage } from '../utils/text';
import {
  commandInDirectory,
  isLiveTerminal,
  launchLine,
  PROCESS_ID_TIMEOUT_MS,
  readProcessId,
  shellIntegrationEnabled,
  terminalTitle,
  titleShortId,
  waitForActive,
  waitForCommandStart,
  waitForEvent,
  waitForProcessId,
  waitForShellIntegration,
  watchCommandStart,
  watchShellReady,
} from './terminalEvents';

/** How long to wait for the launch command to start before applying the title. */
const COMMAND_START_TIMEOUT_MS = 2000;

/**
 * How long a disagreement between the front tab and the reported active
 * terminal may last before the front tab is believed (see `captureFront`).
 * The tab list follows an active-terminal change within a few milliseconds.
 */
const FRONT_SETTLE_MS = 300;

/**
 * How long to wait for a restored tab's shell. A restored tab resumes in the
 * background, where a slow shell start (prompt frameworks, version managers)
 * is worth waiting out, and nothing blocks the user.
 */
export const RESTORED_SHELL_TIMEOUT_MS = 10000;

/**
 * Longest a revived tab waits for its shell to report ready before its resume
 * line is sent anyway (today's behaviour), with one log line. Nothing the user
 * sees waits on it: the wait runs after activation, and the tab is already the
 * chat's, so a click focuses it. The cap only stops a shell whose integration
 * never arrives (a broken profile, a policy that blocks the integration
 * script) from holding a listener forever. Revived Windows PowerShell 5.1
 * shells here took 10-17 s to start under load and once 28 s; 60 s is about
 * twice the slowest seen, so a slow shell is not typed into early.
 */
export const REVIVED_SHELL_READY_CAP_MS = 60_000;

/** A launched tab and the waits its command start is observed through. */
interface StartedTerminal {
  terminal: vscode.Terminal;
  integrated: Promise<boolean>;
  started: Promise<boolean>;
  /** An unbounded wait for the first command start, for a start after `started` gave up. */
  lateStart?: Promise<CommandStartWatch | undefined>;
}

type CommandStartWatch = ReturnType<typeof watchCommandStart>;

/** Called once a new terminal's title work has settled; see `openChat`. */
export type AfterTitle = (phase: 'now' | 'late') => Promise<void>;

/** Rename whichever terminal the workbench's rename command targets (see `writeTitle`). */
async function renameFocusedTerminal(name: string): Promise<void> {
  await vscode.commands
    .executeCommand('workbench.action.terminal.renameWithArg', { name })
    .then(undefined, () => undefined);
}

/** What the user had in front before a background retitle showed a tab. */
interface FrontView {
  terminal?: vscode.Terminal;
  tab?: vscode.Tab;
  viewColumn?: vscode.ViewColumn;
}

/** The two phases of terminal restore. Activation awaits neither. */
/**
 * A chat's worktree by id. It may wait: on a first start the list knows a
 * repository's linked worktrees only once git has listed them.
 */
export type WorktreeLookup = (worktreeId: string) => Worktree | undefined | PromiseLike<Worktree | undefined>;

export interface RestoreSync {
  /**
   * Every PID read has arrived or waited one bounded PID wait. A terminal
   * whose pty survived a reload is adopted whenever its PID arrives, before
   * or after this resolves; `openChat` waits for a pending adoption itself.
   */
  adopted: Promise<void>;
  /**
   * Revived tabs are resumed and chat statuses are reconciled. Runs in the
   * background because a harness resumability check can outlast startup.
   */
  complete: Promise<void>;
}

/**
 * Owns the editor terminals that run chat sessions, for every harness.
 *
 * A terminal that maps to a chat always carries the chat's title. That title
 * is the restore identity: a window reload keeps the pty (matched by PID),
 * while a quit revives the tab as a new shell under the stored title (matched
 * by the short ID in it). See ADR 0009.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, vscode.Terminal>();
  private readonly terminalToChatId = new Map<vscode.Terminal, string>();
  private readonly disposables: vscode.Disposable[];
  private isDisposed = false;

  /**
   * Serializes title writes. The rename command targets whichever terminal is
   * active when it executes, so two overlapping writes can rename each other's
   * tab; the chain makes the last focus win.
   */
  private titleWrites: Promise<void> = Promise.resolve();

  /**
   * Resolves a worktree for a restored chat. Set by the restore pass so a
   * terminal that appears later can register its chat with the harness watcher.
   */
  private getWorktreeById?: WorktreeLookup;

  /**
   * Chats whose restored tab is being resumed. The harness resumability check
   * can take seconds; until it finishes, the tab is still this chat's terminal
   * even though it is not in the map yet.
   */
  private readonly restoringChats = new Map<string, vscode.Terminal>();

  /**
   * Background waits for a slow shell to be ready or to start its first
   * command, cancelled on dispose.
   */
  private readonly lateStarts = new Set<() => void>();

  /**
   * A terminal TerminalManager activated to re-apply a title. Background
   * retitling must not look like a user focus change to the tree.
   */
  private backgroundActivation?: vscode.Terminal;

  /**
   * Terminals in front only because Pitwall showed them to rename them, with
   * one count per show sequence still running (R43). The needs-you pipeline
   * must not take such a show for the user looking at the chat. A sequence's
   * count is released when it ends, however it ends; the user activating the
   * terminal themselves clears it at once.
   */
  private readonly pitwallShows = new Map<vscode.Terminal, number>();

  /**
   * Restored terminals whose PID has not arrived yet, so their adoption is
   * still open, and the PID records the restore pass started from.
   */
  private readonly pendingAdoptions = new Set<vscode.Terminal>();
  private restoreRecordedPids: Record<string, number> = {};
  /** Fires when a pending adoption maps a terminal or ends. */
  private readonly adoptionEvents = new vscode.EventEmitter<void>();

  /**
   * Mapped terminals whose title landed on another terminal instead, and was
   * taken back. Each is retried once per event after which keyboard focus can
   * have moved (see `retryPendingTitles`), never in a loop.
   */
  private readonly pendingTitles = new Set<vscode.Terminal>();
  private readonly queuedTitleRetries = new Set<vscode.Terminal>();
  /** Terminal activations that were not Pitwall's own background shows. */
  private userActivations = 0;

  private readonly stateEmitter = new vscode.EventEmitter<{ chatId: string; state: 'opened' | 'closed' }>();
  readonly onTerminalStateChange = this.stateEmitter.event;

  constructor(
    private readonly storageService: StorageService,
    private readonly harnessRegistry: HarnessRegistry,
    private readonly harnessWatcherRegistry: HarnessWatcherRegistry
  ) {
    this.disposables = [
      vscode.window.onDidCloseTerminal((terminal) => {
        const chatId = this.terminalToChatId.get(terminal);
        if (chatId) {
          this.handleTerminalClosed(chatId, terminal);
        }
      }),
      // A restored terminal can appear after activation; adopt it if its pty
      // is one Pitwall recorded, whenever its PID arrives.
      vscode.window.onDidOpenTerminal((terminal) => {
        if (terminal.exitStatus === undefined && !this.terminalToChatId.has(terminal)) {
          this.adoptWhenPidArrives(terminal, terminal.processId, () => this.storageService.getTerminalPids(), this.getWorktreeById);
        }
      }),
      // A mapped terminal always shows Pitwall's title. Re-applying on focus
      // covers a title VS Code lost during a restore and a hand-renamed tab.
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        if (!terminal) {
          return;
        }
        if (terminal === this.backgroundActivation) {
          // Pitwall showed this tab to rename it; the queued work that showed
          // it writes the title, and keyboard focus has not moved.
          return;
        }
        if (this.backgroundActivation) {
          // Someone else took the active tab; a later focus of the expected
          // tab is the user's and must not be swallowed by the marker.
          this.backgroundActivation = undefined;
        }
        this.userActivations += 1;
        // The user brought it to the front: from now on it is their look.
        this.pitwallShows.delete(terminal);
        void this.applyTitle(terminal);
        this.retryPendingTitles(terminal);
      }),
      // Switching windows or apps moves keyboard focus too.
      vscode.window.onDidChangeWindowState(() => this.retryPendingTitles()),
      // Each cwd report re-tags the title as a config title, letting the
      // shell's own title win; re-apply after it, which also covers a slow
      // shell that started after the initial title.
      vscode.window.onDidChangeTerminalShellIntegration((event) => void this.applyTitle(event.terminal)),
    ];
  }

  /**
   * Focus a chat's live terminal, or launch (or resume) it in a new one.
   * `preserveFocus` shows the terminal without taking keyboard focus (a
   * Ctrl+↓/↑ in the list keeps the list focused, Q4).
   *
   * A new terminal takes focus as it is created whatever `show` is told, and
   * its rename (which targets the focused terminal) leaves focus nowhere
   * (E8). `afterTitle` runs once that title work has settled, so a caller can
   * put focus back without racing the rename (F4): with `'now'` while this
   * call is still in progress, with `'late'` after a shell that integrated
   * late got its title. An existing terminal is only shown and never calls it.
   */
  async openChat(
    chat: ChatSession,
    worktree: Worktree,
    options: { preserveFocus?: boolean; afterTitle?: AfterTitle } = {}
  ): Promise<vscode.Terminal | undefined> {
    const preserveFocus = options.preserveFocus ?? false;
    const afterTitle = options.afterTitle;
    // Only a terminal still in the in-memory map is this chat's session. A
    // same-named terminal is not: after a quit it is a revived shell.
    const existingTerminal = this.terminals.get(chat.id);
    if (existingTerminal) {
      if (isLiveTerminal(existingTerminal)) {
        existingTerminal.show(preserveFocus);
        return existingTerminal;
      }
      // The process exited or VS Code dropped the terminal; its tab may
      // linger. Forget it and launch a fresh one below.
      this.terminals.delete(chat.id);
      this.terminalToChatId.delete(existingTerminal);
      existingTerminal.dispose();
    }

    // A restored tab is this chat's terminal even before its resume command
    // is sent. Its resumability check can still be running; treating it as
    // unowned would let this click launch a second agent.
    const restoring = this.restoringChats.get(chat.id);
    if (restoring) {
      if (isLiveTerminal(restoring)) {
        restoring.show(preserveFocus);
        return restoring;
      }
      this.restoringChats.delete(chat.id);
    }

    // A tab that survived a reload may still be waiting for its PID, which is
    // the only thing that proves it is this chat's agent. Wait for that, at
    // most one PID wait, rather than launch a second agent beside it.
    if (await this.waitForPendingAdoption(chat.id)) {
      const adopted = this.terminals.get(chat.id);
      if (adopted && isLiveTerminal(adopted)) {
        adopted.show(preserveFocus);
        return adopted;
      }
    }

    const launch = await this.prepareLaunch(chat, worktree.path, true);
    if (!launch) {
      return undefined;
    }

    const terminal = vscode.window.createTerminal({
      name: terminalTitle(chat),
      cwd: worktree.path,
      iconPath: new vscode.ThemeIcon(launch.icon),
      location: vscode.TerminalLocation.Editor,
    });

    // Watched from before the send, which can start the command at once.
    const lateStart = watchCommandStart(terminal);
    const { integrated, started } = this.startTerminal(
      chat,
      terminal,
      launchLine(launch.command),
      COMMAND_START_TIMEOUT_MS
    );
    terminal.show(preserveFocus);

    // A rename is only persisted by VS Code after the shell has reported its
    // cwd for the running command. A shell without integration reports no
    // command start and no cwd re-tag, so there is nothing to wait for; the
    // setting check makes that case return immediately.
    await this.recordTerminalPid(chat.id, terminal);
    if (await integrated) {
      const commandStarted = await started;
      await waitForActive(terminal);
      await this.applyTitle(terminal);
      await this.afterTitleWork(afterTitle, 'now');
      if (commandStarted) {
        lateStart.cancel();
      } else {
        this.retitleOnLateStart(terminal, lateStart, afterTitle);
      }
    } else if (shellIntegrationEnabled()) {
      // The shell has not integrated yet (Windows PowerShell 5.1 starts
      // slowly); the title still needs applying once its command starts.
      this.retitleOnLateStart(terminal, lateStart, afterTitle);
    } else {
      lateStart.cancel();
      // No rename to wait for, but the creation may still have taken focus.
      await afterTitle?.('now');
    }

    return terminal;
  }

  /**
   * Map a terminal to its chat, send the launch command, and announce the
   * session. Callers must create any event waits before calling this, because
   * the command can start as soon as it is sent.
   */
  private startTerminal(
    chat: ChatSession,
    terminal: vscode.Terminal,
    command: string,
    commandStartTimeout: number
  ): StartedTerminal {
    const integrated = waitForShellIntegration(
      terminal,
      commandStartTimeout
    );
    const started = waitForCommandStart(
      terminal,
      commandStartTimeout
    );

    this.terminals.set(chat.id, terminal);
    this.terminalToChatId.set(terminal, chat.id);
    terminal.sendText(command);
    this.markOpened(chat);

    return { terminal, integrated, started };
  }

  private markOpened(chat: ChatSession): void {
    this.storageService.updateChat(chat.id, {
      status: 'active',
      lastAccessedAt: Date.now(),
    });
    this.stateEmitter.fire({ chatId: chat.id, state: 'opened' });
  }

  /**
   * Map a revived tab to its chat now, and type its resume line once the
   * shell reports ready. A revived shell can still be starting, and a line
   * typed into it then can be lost. The tab is the chat's meanwhile, so a
   * click focuses it. Nothing awaits the readiness wait.
   */
  private startRevivedTerminal(
    chat: ChatSession,
    terminal: vscode.Terminal,
    command: string
  ): StartedTerminal {
    const watch = watchShellReady(terminal, REVIVED_SHELL_READY_CAP_MS);
    this.lateStarts.add(watch.cancel);
    this.terminals.set(chat.id, terminal);
    this.terminalToChatId.set(terminal, chat.id);
    this.markOpened(chat);

    const sent = watch.ready.then((readiness) => {
      this.lateStarts.delete(watch.cancel);
      if (
        readiness === 'closed' ||
        this.isDisposed ||
        this.terminals.get(chat.id) !== terminal ||
        !isLiveTerminal(terminal)
      ) {
        return { readiness, started: Promise.resolve(false), lateStart: undefined };
      }
      if (readiness === 'cap') {
        console.warn(
          `Pitwall: the revived terminal for chat ${chat.id.substring(0, 6)} did not report its shell ready within ${REVIVED_SHELL_READY_CAP_MS / 1000} s; sending its resume line anyway`
        );
      }
      // Watched from before the send, which can start the command at once.
      const lateStart = watchCommandStart(terminal);
      this.lateStarts.add(lateStart.cancel);
      const started = waitForCommandStart(terminal, RESTORED_SHELL_TIMEOUT_MS);
      // R42: a revived shell can report ready before it reads keystrokes (its
      // shell integration is restored from the last session) and drop the
      // first one: Smoke 7 saw "et-Location -LiteralPath ...". A leading space
      // is harmless in PowerShell, cmd.exe and bash (and keeps the line out
      // of bash history under ignorespace), so a dropped keystroke is the space.
      terminal.sendText(` ${command}`);
      return { readiness, started, lateStart };
    });

    return {
      terminal,
      // Only an integrated shell re-tags the title, so only it needs a retitle.
      integrated: sent.then(({ readiness }) => readiness === 'ready'),
      started: sent.then(({ started }) => started),
      lateStart: sent.then(({ lateStart }) => lateStart),
    };
  }

  /**
   * Resolve the command that launches or resumes a chat. Shared by opening a
   * chat on demand and resuming restored tabs in the background; only the
   * former announces a missing session to the user.
   */
  private async prepareLaunch(
    chat: ChatSession,
    worktreePath: string,
    announce: boolean
  ): Promise<{ command: string; icon: string } | undefined> {
    // A chat whose harness this build has switched off cannot be launched.
    if (!this.harnessRegistry.has(chat.harness)) {
      return undefined;
    }
    const adapter = this.harnessRegistry.get(chat.harness);
    const pendingId = chat.pendingHarnessSessionId ?? undefined;
    // A terminal fork that has not linked yet keeps its source on the chat, so
    // reopening it repeats the fork rather than starting fresh.
    const forkSource = !chat.harnessSessionId
      ? chat.forkedFromSessionId ?? undefined
      : undefined;

    let sessionId: string | undefined;
    let newSessionId: string | undefined;
    let forkFrom: string | undefined;

    // A pending ID whose transcript already exists means the watcher has not
    // caught up (or failed to); resume it instead of forking/launching again.
    if (pendingId && (await this.isResumable(adapter, pendingId, worktreePath))) {
      sessionId = pendingId;
    } else if (forkSource) {
      // A terminal fork starts from the source and writes under the chosen ID.
      forkFrom = forkSource;
      newSessionId = pendingId;
    } else if (chat.harnessSessionId) {
      if (
        !(await this.isResumable(adapter, chat.harnessSessionId, worktreePath))
      ) {
        if (announce) {
          this.showMissingSessionWarning(chat, adapter);
        }
        return undefined;
      }
      sessionId = chat.harnessSessionId;
    } else {
      newSessionId = pendingId;
    }

    try {
      return {
        command: adapter.buildLaunchCommand({
          worktreePath,
          sessionId,
          newSessionId,
          forkFromSessionId: forkFrom,
        }),
        icon: adapter.icon,
      };
    } catch (error) {
      if (announce) {
        vscode.window.showErrorMessage(
          `Could not open the ${adapter.displayName} session: ${errorMessage(error)}`
        );
      }
      return undefined;
    }
  }

  private async isResumable(
    adapter: HarnessAdapter,
    sessionId: string,
    cwd?: string
  ): Promise<boolean> {
    try {
      return await adapter.isSessionResumable(sessionId, cwd);
    } catch {
      return false;
    }
  }

  /**
   * A chat without a native session is linked by its harness watcher once the
   * session appears. Opening a chat registers it before launch; a restored tab
   * has no such call, so the restore paths register it here.
   */
  private registerPendingChat(chat: ChatSession, worktreePath: string): void {
    if (chat.harnessSessionId) {
      return;
    }
    this.harnessWatcherRegistry.registerPendingChat(
      chat.harness,
      chat.id,
      worktreePath
    );
  }

  /**
   * Record the pty behind a mapped terminal so a reload can find it again.
   * Callers that already read the PID pass it in to avoid a second bounded
   * read during activation. A PID that arrives after the bounded wait
   * (Windows can report a new pty's PID late) is recorded whenever it comes,
   * from the same read, without anyone waiting for it.
   */
  private async recordTerminalPid(
    chatId: string,
    terminal: vscode.Terminal,
    knownPid?: number
  ): Promise<void> {
    if (knownPid !== undefined) {
      await this.rememberPid(chatId, terminal, knownPid);
      return;
    }
    const read = terminal.processId;
    const pid = await waitForProcessId(read);
    if (pid !== undefined) {
      await this.rememberPid(chatId, terminal, pid);
      return;
    }
    void Promise.resolve(read)
      .then((late) => (late === undefined ? undefined : this.rememberPid(chatId, terminal, late)))
      .catch((error) => console.error('Pitwall: could not record a late terminal PID', error));
  }

  /**
   * Store a terminal's PID for its chat, unless the tab closed, the chat was
   * removed, or Pitwall shut down while the PID was pending.
   */
  private async rememberPid(chatId: string, terminal: vscode.Terminal, pid: number): Promise<void> {
    if (
      this.isDisposed ||
      this.terminals.get(chatId) !== terminal ||
      !this.storageService.getChat(chatId)
    ) {
      return;
    }
    await this.storageService.rememberTerminalPid(chatId, pid);
  }

  /**
   * Apply a launched tab's title once its command starts, however late. A
   * shell that integrates after the launch wait re-tags the title when its
   * command starts, so only a rename after that survives a quit.
   */
  private retitleOnLateStart(
    terminal: vscode.Terminal,
    watch: { started: Promise<boolean>; cancel(): void },
    afterTitle?: AfterTitle
  ): void {
    this.lateStarts.add(watch.cancel);
    void watch.started
      .then(async (started) => {
        this.lateStarts.delete(watch.cancel);
        if (started) {
          await this.retitleInBackground(terminal);
          await this.afterTitleWork(afterTitle, 'late');
        }
      })
      .catch(() => undefined);
  }

  /**
   * Run `afterTitle` once every queued title write has finished: a focus
   * change while the tab was created can queue a second rename behind this
   * one, and a refocus between them would send that rename elsewhere (F4).
   */
  private async afterTitleWork(afterTitle: AfterTitle | undefined, phase: 'now' | 'late'): Promise<void> {
    if (!afterTitle || this.isDisposed) {
      return;
    }
    await this.titleWrites;
    await afterTitle(phase);
  }

  /**
   * Rename one mapped tab wherever focus is, with the same steps as revived
   * tabs: a tab that is not active is shown without taking focus, renamed,
   * and the tab that was active is shown again. Which tab is active is read
   * when the queued work runs, so another tab opening meanwhile is restored
   * rather than skipping the rename.
   */
  private retitleInBackground(terminal: vscode.Terminal): Promise<void> {
    return this.queueTitleWork(async () => {
      if (this.isDisposed || !this.terminalToChatId.has(terminal) || !isLiveTerminal(terminal)) {
        return;
      }
      if (vscode.window.activeTerminal === terminal) {
        await this.writeTitle(terminal);
        return;
      }
      if (!this.canShowInBackground(terminal)) {
        // Showing it would replace what the user is looking at, and can take
        // keyboard focus with it. Wait for a later trigger instead.
        this.pendingTitles.add(terminal);
        return;
      }
      const front = await this.captureFront(terminal);
      const release = this.beginPitwallShow(terminal);
      try {
        await this.showForRetitle(terminal);
        await this.writeTitle(terminal);
      } finally {
        try {
          // Put back what the user had in front, however the rename ended
          // (R44), unless they moved on meanwhile.
          if (!this.isDisposed && vscode.window.activeTerminal === terminal) {
            await this.restoreFront(front, terminal);
          }
        } finally {
          release();
        }
      }
    });
  }

  /**
   * Whether a tab can be shown, to rename it, without replacing what the user
   * is looking at. Showing an editor terminal in the active editor group
   * replaces that group's front tab: when the front tab is the user's (a
   * file, a diff, a webview such as a chat panel), keyboard focus can go with
   * it, and the editor moves it to the terminal. So a tab in that group is
   * shown only while a terminal tab is in front there; a tab in another group
   * (or a panel terminal) does not touch the front tab.
   */
  private canShowInBackground(terminal: vscode.Terminal): boolean {
    const group = vscode.window.tabGroups.activeTabGroup;
    const front = group?.activeTab;
    if (!group || !front || front.input instanceof vscode.TabInputTerminal) {
      return true;
    }
    return !group.tabs.some((tab) => tab.input instanceof vscode.TabInputTerminal && tab.label === terminal.name);
  }

  /**
   * What is in front now: the active terminal, and the front tab of the group
   * the show will change. A background retitle has to show its tab, because
   * the rename command only renames the active terminal; this is what to put
   * back. When the front tab is a terminal tab but the reported active
   * terminal's own tab sits behind it, the two disagree: right after a show
   * the tab list can lag the active terminal by a moment, while Cursor can
   * keep reporting a revived window's last revived tab as active with
   * another tab in front (R1-x). A disagreement that a tab change resolves
   * within FRONT_SETTLE_MS was the lag; one that lasts is the front the user
   * sees, and its terminal is found by the tab's title.
   */
  private async captureFront(target?: vscode.Terminal): Promise<FrontView> {
    if (this.readFront(target).disagrees) {
      await waitForEvent<void>(FRONT_SETTLE_MS, undefined, (done) =>
        vscode.window.tabGroups.onDidChangeTabs(() => {
          if (!this.readFront(target).disagrees) {
            done(undefined);
          }
        })
      );
    }
    return this.readFront(target).front;
  }

  private readFront(target?: vscode.Terminal): { front: FrontView; disagrees: boolean } {
    let group = vscode.window.tabGroups.activeTabGroup;
    // Showing the target replaces the front tab of the group that holds it.
    // When the active group's front is something else (such as an agent
    // pane in another group), that group is left alone, so capture the front
    // of the target's group instead (R1-x).
    if (target && group?.activeTab && !(group.activeTab.input instanceof vscode.TabInputTerminal)) {
      const holding = vscode.window.tabGroups.all.find(
        (candidate) =>
          candidate !== group &&
          candidate.tabs.some((tab) => tab.input instanceof vscode.TabInputTerminal && tab.label === target.name)
      );
      group = holding ?? group;
    }
    const tab = group?.activeTab;
    const active = vscode.window.activeTerminal;
    let terminal = active;
    let disagrees = false;
    if (group && tab?.input instanceof vscode.TabInputTerminal && active?.name !== tab.label) {
      // No reported terminal, or one whose own tab is behind the front tab.
      disagrees =
        !active ||
        group.tabs.some((other) => other !== tab && other.input instanceof vscode.TabInputTerminal && other.label === active.name);
      if (disagrees) {
        const named = vscode.window.terminals.filter((candidate) => candidate.name === tab.label);
        terminal = named.length === 1 ? named[0] : active;
      }
    }
    return { front: { terminal, tab, viewColumn: group?.viewColumn }, disagrees };
  }

  /**
   * Show again what was in front before a background retitle, without moving
   * keyboard focus. Text, diff, custom and notebook tabs are reopened by their
   * resource with `preserveFocus`. A webview tab (such as an extension's chat
   * panel), the settings page and other editors have no way back that leaves
   * focus alone, so the renamed terminal stays in front of them until the
   * user switches back. A terminal tab, or no editor tab, brings back the
   * terminal that was active.
   */
  private async restoreFront(front: FrontView, retitled?: vscode.Terminal): Promise<void> {
    const tab = front.tab;
    const input = tab?.input;
    const options = { viewColumn: front.viewColumn, preserveFocus: true };
    const ignore = () => undefined;
    if (tab && input instanceof vscode.TabInputText) {
      await vscode.window.showTextDocument(input.uri, { ...options, preview: tab.isPreview }).then(undefined, ignore);
      return;
    }
    if (tab && input instanceof vscode.TabInputTextDiff) {
      await vscode.commands
        .executeCommand('vscode.diff', input.original, input.modified, tab.label, { ...options, preview: tab.isPreview })
        .then(undefined, ignore);
      return;
    }
    if (input instanceof vscode.TabInputCustom) {
      await vscode.commands.executeCommand('vscode.openWith', input.uri, input.viewType, options).then(undefined, ignore);
      return;
    }
    if (input instanceof vscode.TabInputNotebook) {
      await vscode.commands.executeCommand('vscode.openWith', input.uri, input.notebookType, options).then(undefined, ignore);
      return;
    }
    if (tab && !(input instanceof vscode.TabInputTerminal)) {
      return;
    }
    if (front.terminal && front.terminal !== retitled && vscode.window.terminals.includes(front.terminal)) {
      await this.showForRetitle(front.terminal);
    }
  }

  /**
   * Give a mapped terminal Pitwall's title. The rename command targets the
   * active terminal, so the caller must make this terminal active first. Writes
   * are serialized: each one re-checks the active tab when it runs, so a focus
   * change between queueing and execution cannot swap two tabs' titles.
   */
  private applyTitle(terminal: vscode.Terminal): Promise<void> {
    return this.queueTitleWork(() => this.writeTitle(terminal));
  }

  /**
   * Run one rename, or a show-rename-restore sequence, after every title write
   * already queued. Keeping title work serial means a background retitle cannot
   * activate its tab in the middle of another retitle's show window.
   */
  private queueTitleWork(work: () => Promise<void>): Promise<void> {
    const run = this.titleWrites.then(work);
    this.titleWrites = run.then(undefined, () => undefined);
    return this.titleWrites;
  }

  /**
   * Rename the active, mapped terminal to its chat's title, then check where
   * the title landed. The rename command renames the terminal that holds
   * keyboard focus, and only falls back to the active one when no terminal
   * has focus (`TerminalService.activeInstance`). A tab shown without focus
   * is active but not focused, so with the user's keyboard in another
   * terminal the title lands there. That terminal is given its previous name
   * back at once (focus has not moved, so that rename lands on it too), and
   * the target is requeued. The editor reports a rename's new name before the
   * command resolves; the terminal-restore e2e asserts it.
   */
  private async writeTitle(terminal: vscode.Terminal): Promise<void> {
    if (this.isDisposed) {
      return;
    }
    const chatId = this.terminalToChatId.get(terminal);
    const chat = chatId ? this.storageService.getChat(chatId) : undefined;
    if (!chat || vscode.window.activeTerminal !== terminal) {
      return;
    }
    const title = terminalTitle(chat);
    const before = new Map(vscode.window.terminals.map((candidate) => [candidate, candidate.name] as const));
    await renameFocusedTerminal(title);
    const strays = vscode.window.terminals.filter(
      (candidate) => candidate !== terminal && candidate.name === title && before.has(candidate) && before.get(candidate) !== title
    );
    if (strays.length === 0) {
      if (terminal.name === title) {
        this.pendingTitles.delete(terminal);
      }
      return;
    }
    for (const stray of strays) {
      // The command refuses an empty name and offers no way back to a dynamic
      // title, so the previous name comes back as a fixed one.
      const previous = before.get(stray) || 'Terminal';
      await renameFocusedTerminal(previous);
      if (stray.name !== previous) {
        console.warn(`Pitwall: a chat title landed on another terminal and its name "${previous}" could not be put back`);
      }
    }
    this.pendingTitles.add(terminal);
  }

  /**
   * Retry each requeued title once, after an event that can have moved
   * keyboard focus: a terminal became active (`except`, when the user focused
   * it, is renamed by the focus handler instead) or the window gained or lost
   * focus. One attempt per trigger, because until another such event focus
   * is where it was, and a second attempt would land on the same terminal
   * again. With the keyboard parked in a user's terminal, nothing retries.
   */
  private retryPendingTitles(except?: vscode.Terminal): void {
    for (const terminal of [...this.pendingTitles]) {
      if (terminal === except || this.queuedTitleRetries.has(terminal)) {
        continue;
      }
      if (!isLiveTerminal(terminal) || !this.terminalToChatId.has(terminal)) {
        this.pendingTitles.delete(terminal);
        continue;
      }
      this.queuedTitleRetries.add(terminal);
      void this.retitleInBackground(terminal).finally(() => this.queuedTitleRetries.delete(terminal));
    }
  }

  /**
   * Adopt a restored terminal once its PID arrives, however late (a reload's
   * pty can report it after any bounded wait). The terminal counts as a
   * pending adoption until then, so a click waits for it instead of opening
   * a second agent.
   */
  private adoptWhenPidArrives(
    terminal: vscode.Terminal,
    read: Thenable<number | undefined>,
    recordedPids: () => Record<string, number>,
    getWorktree?: WorktreeLookup
  ): void {
    this.pendingAdoptions.add(terminal);
    void Promise.resolve(read)
      .then((pid) =>
        pid === undefined || this.isDisposed
          ? undefined
          : this.adoptRestoredTerminal(terminal, recordedPids(), pid, getWorktree)
      )
      .catch((error) => console.error('Pitwall: could not adopt a restored terminal', error))
      .finally(() => {
        this.pendingAdoptions.delete(terminal);
        if (!this.isDisposed) {
          this.adoptionEvents.fire();
        }
      });
  }

  /**
   * Wait, at most one PID wait, while a chat this workspace recorded could
   * still be adopted by a restored terminal whose PID is pending. True when
   * the chat has a terminal afterwards.
   */
  private async waitForPendingAdoption(chatId: string): Promise<boolean> {
    if (
      this.pendingAdoptions.size === 0 ||
      this.terminals.has(chatId) ||
      this.restoreRecordedPids[chatId] === undefined
    ) {
      return this.terminals.has(chatId);
    }
    return waitForEvent<boolean>(PROCESS_ID_TIMEOUT_MS, false, (done) => {
      const check = () => {
        if (this.terminals.has(chatId)) {
          done(true);
        } else if (this.pendingAdoptions.size === 0) {
          done(false);
        }
      };
      const subscription = this.adoptionEvents.event(check);
      check();
      return subscription;
    });
  }

  /**
   * Whether TerminalManager activated this terminal to re-apply its title,
   * rather than the user focusing it. Consumes the marker, so a later real
   * focus is handled normally. The tree uses this to ignore selection changes
   * caused by the background retitle pass.
   */
  /**
   * Whether the chat's tab is in front only because Pitwall showed it to
   * rename it, so being in front is not the user looking at it (R43).
   */
  isPitwallActivation(chatId: string): boolean {
    const terminal = this.terminals.get(chatId);
    return terminal !== undefined && this.pitwallShows.has(terminal);
  }

  /** Count one show sequence for `terminal`; the returned release is idempotent. */
  private beginPitwallShow(terminal: vscode.Terminal): () => void {
    this.pitwallShows.set(terminal, (this.pitwallShows.get(terminal) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const left = (this.pitwallShows.get(terminal) ?? 1) - 1;
      if (left > 0) {
        this.pitwallShows.set(terminal, left);
      } else {
        this.pitwallShows.delete(terminal);
      }
    };
  }

  consumeBackgroundActivation(terminal: vscode.Terminal): boolean {
    if (this.backgroundActivation !== terminal) {
      return false;
    }
    this.backgroundActivation = undefined;
    return true;
  }

  /**
   * Activate a tab long enough to rename it, without reporting the activation
   * as a user focus change.
   */
  private async showForRetitle(terminal: vscode.Terminal): Promise<void> {
    this.backgroundActivation = terminal;
    terminal.show(true);
    await waitForActive(terminal);
    if (this.backgroundActivation === terminal) {
      this.backgroundActivation = undefined;
    }
  }

  /** The session is gone from the harness: offer to drop the stale chat. */
  private showMissingSessionWarning(chat: ChatSession, adapter: HarnessAdapter): void {
    vscode.window
      .showWarningMessage(
        `Session not found in ${adapter.displayName}. It is no longer available, so this chat cannot be reopened.`,
        'Delete Chat',
        'Cancel'
      )
      .then((choice) => {
        if (choice === 'Delete Chat') {
          this.storageService.deleteChat(chat.id);
          vscode.commands.executeCommand('pitwall.refreshWorkspaces');
        }
      });
  }

  /**
   * Close a chat's terminal; the close event does the bookkeeping. A restored
   * tab Pitwall never resumed (an unlinked fork, a session that was gone) is
   * not mapped, so it is found by the short ID in its title, and only when no
   * other stored chat shares that short ID and exactly one unmanaged tab
   * carries it: of two, one may be the user's own terminal.
   */
  closeChat(chatId: string): void {
    const terminal = this.terminals.get(chatId);
    if (terminal) {
      terminal.dispose();
      return;
    }
    const shortId = chatId.substring(0, 6);
    const shared = this.storageService
      .getChats()
      .some((chat) => chat.id !== chatId && chat.id.substring(0, 6) === shortId);
    if (shared) {
      return;
    }
    const orphans = vscode.window.terminals.filter(
      (orphan) => isLiveTerminal(orphan) && !this.terminalToChatId.has(orphan) && titleShortId(orphan.name) === shortId
    );
    if (orphans.length === 1) {
      orphans[0].dispose();
    }
  }

  /**
   * Whether a restored terminal for this chat is still being resumed. It is
   * not in `terminals` yet, so callers that could start another process (such
   * as the native-UI handoff) must check this separately from `isActive()`.
   */
  isResuming(chatId: string): boolean {
    const terminal = this.restoringChats.get(chatId);
    if (!terminal) {
      return false;
    }
    if (isLiveTerminal(terminal)) {
      return true;
    }
    this.restoringChats.delete(chatId);
    return false;
  }

  /**
   * Wait for a chat's terminal close event, bounded so a missed event cannot
   * leave a caller waiting forever. Used before a native-UI handoff starts a
   * second agent process.
   */
  waitForChatClosed(chatId: string, timeoutMs = 2_000): Promise<boolean> {
    return waitForEvent<boolean>(
      timeoutMs,
      false,
      (done) =>
        this.onTerminalStateChange((event) => {
          if (event.chatId === chatId && event.state === 'closed') {
            done(true);
          }
        })
    );
  }

  /** Whether a chat's terminal is mapped and still running. */
  isActive(chatId: string): boolean {
    const terminal = this.terminals.get(chatId);
    if (!terminal) {
      return false;
    }
    if (isLiveTerminal(terminal)) {
      return true;
    }
    // Clean up a stale reference; the close event never reached us or the
    // process exited while its tab stayed listed. Dispose it so a dead tab
    // cannot stand in for the chat.
    this.terminals.delete(chatId);
    this.terminalToChatId.delete(terminal);
    terminal.dispose();
    return false;
  }

  getTerminal(chatId: string): vscode.Terminal | undefined {
    return this.terminals.get(chatId);
  }

  getChatIdForTerminal(terminal: vscode.Terminal): string | undefined {
    return this.terminalToChatId.get(terminal);
  }

  /**
   * Get the chat a terminal title is mapped to. Editor tab focus can move
   * between a terminal and a webview without changing the active terminal, so
   * the tab's title is the reliable key in that case.
   */
  getChatIdForTerminalName(name: string): string | undefined {
    for (const [terminal, chatId] of this.terminalToChatId) {
      if (terminal.name === name) {
        return chatId;
      }
    }
    return undefined;
  }

  focusChat(chatId: string): void {
    this.terminals.get(chatId)?.show();
  }

  private handleTerminalClosed(chatId: string, terminal: vscode.Terminal): void {
    this.terminals.delete(chatId);
    this.terminalToChatId.delete(terminal);

    const chat = this.storageService.getChat(chatId);

    if (chat && !chat.harnessSessionId && !chat.pendingHarnessSessionId) {
      // A harness that assigns its own ID never linked this chat before the
      // terminal closed, so there is nothing to resume.
      this.dropChat(chatId);
    } else {
      if (chat && !chat.harnessSessionId && chat.forkedFromSessionId) {
        // A fork that never wrote a transcript has no session to resume, and
        // reopening it would fork from the source's current state. Drop the
        // row instead, unless the first prompt already produced a transcript.
        void this.dropUnusedFork(chat);
      }
      // The pty is gone; keep the recorded PID as proof for the next
      // activation, but do not adopt this terminal again.
      this.storageService.updateChat(chatId, { status: 'closed' });
    }

    this.stateEmitter.fire({ chatId, state: 'closed' });
  }

  private dropChat(chatId: string): void {
    this.storageService.deleteChat(chatId);
    vscode.commands.executeCommand('pitwall.refreshWorkspaces');
  }

  /**
   * Drop a terminal fork that never produced a transcript. The fork exists
   * only inside the closed process, so keeping the chat would offer a fork of
   * wherever the source has moved to since.
   */
  private async dropUnusedFork(chat: ChatSession): Promise<void> {
    if (!this.harnessRegistry.has(chat.harness)) {
      return;
    }
    const adapter = this.harnessRegistry.get(chat.harness);
    const pendingId = chat.pendingHarnessSessionId;
    if (pendingId && (await this.isResumable(adapter, pendingId))) {
      return;
    }
    // The watcher may have linked the chat while we checked.
    const current = this.storageService.getChat(chat.id);
    if (!current || current.harnessSessionId) {
      return;
    }
    this.dropChat(chat.id);
  }

  dispose(): void {
    this.isDisposed = true;
    this.disposables.forEach((disposable) => disposable.dispose());
    for (const terminal of this.terminals.values()) {
      terminal.dispose();
    }
    this.terminals.clear();
    this.terminalToChatId.clear();
    this.restoringChats.clear();
    for (const cancel of [...this.lateStarts]) {
      cancel();
    }
    this.lateStarts.clear();
    this.pendingAdoptions.clear();
    this.pendingTitles.clear();
    this.adoptionEvents.dispose();
    this.stateEmitter.dispose();
  }

  /**
   * Reconcile terminals that survived an extension-host restart. Activation
   * awaits none of it.
   *
   * A window reload keeps every pty, so adoption is silent: the terminal with
   * a chat's recorded PID is that chat's live agent, adopted whenever that
   * PID arrives. Until then `openChat` waits for it (at most one PID wait).
   * A quit revives each tab as a new shell, and resuming one asks the harness
   * whether its session still exists; that native check can outlast startup.
   * Until it finishes, `openChat` treats a candidate tab as the chat's
   * terminal, so a click cannot launch a second agent.
   */
  beginRestoreSync(getWorktree: WorktreeLookup): RestoreSync {
    this.getWorktreeById = getWorktree;
    const chats = this.storageService.getChats();
    const recordedPids = this.storageService.getTerminalPids();
    this.restoreRecordedPids = recordedPids;
    const terminals = [...vscode.window.terminals];
    const pids = new Map<vscode.Terminal, number | undefined>();
    // Each terminal's PID read, kept so a late PID is waited for on the same
    // read rather than a second one.
    const pidReads = new Map<vscode.Terminal, Thenable<number | undefined>>();

    // Resolve each worktree once. The lookup may wait for git (a first
    // start lists linked worktrees in the background), so each answer is
    // kept as the promise of it, and an answer is the listed one.
    const worktrees = new Map<string, Promise<Worktree | undefined>>();
    const resolveWorktree = (worktreeId: string): Promise<Worktree | undefined> => {
      let worktree = worktrees.get(worktreeId);
      if (!worktree) {
        worktree = Promise.resolve(getWorktree(worktreeId));
        worktrees.set(worktreeId, worktree);
      }
      return worktree;
    };

    // Only terminals that can be adopted or resumed need their PID.
    // Unrelated user terminals must not add their read timeout to restore.
    const canAdopt = Object.keys(recordedPids).length > 0;
    const firstWaits: Promise<void>[] = [];
    for (const terminal of terminals) {
      if (terminal.exitStatus !== undefined || (!canAdopt && !titleShortId(terminal.name))) {
        continue;
      }
      const read = terminal.processId;
      pidReads.set(terminal, read);
      // A surviving pty is adopted whenever its PID arrives, with no cut-off.
      if (canAdopt) {
        this.adoptWhenPidArrives(terminal, read, () => recordedPids, resolveWorktree);
      }
      firstWaits.push(waitForProcessId(read).then((pid) => void pids.set(terminal, pid)));
    }
    // A PID that arrived within the bound has been adopted by now: its
    // continuation was chained on the read before this wait's.
    const adopted = Promise.all(firstWaits).then(() => resolveWorktree);

    const complete = adopted.then(async (resolveWorktree) => {
      try {
        await this.resumeRevivedTerminals(
          chats,
          recordedPids,
          pids,
          pidReads,
          resolveWorktree
        );

        // Reconcile only chats this workspace launched; leave chats it never
        // opened alone.
        const mine = new Set(Object.keys(recordedPids));
        for (const chat of chats) {
          if (
            mine.has(chat.id) &&
            chat.status === 'active' &&
            !this.isActive(chat.id)
          ) {
            this.storageService.updateChat(chat.id, { status: 'idle' });
          }
        }
      } finally {
        this.restoringChats.clear();
      }
    });

    return { adopted: adopted.then(() => undefined), complete };
  }

  /**
   * Adopt a restored terminal whose pty is the one recorded for a chat. Never
   * type into an adopted terminal: the pty is the running agent.
   * The caller passes the PID once it has arrived.
   */
  private async adoptRestoredTerminal(
    terminal: vscode.Terminal,
    recordedPids: Record<string, number>,
    pid: number,
    getWorktree?: WorktreeLookup
  ): Promise<void> {
    if (
      terminal.exitStatus !== undefined ||
      this.terminalToChatId.has(terminal)
    ) {
      return;
    }

    const chatId = Object.keys(recordedPids).find(
      (id) => recordedPids[id] === pid && !this.terminals.has(id)
    );
    if (!chatId) {
      return;
    }

    this.terminals.set(chatId, terminal);
    this.terminalToChatId.set(terminal, chatId);
    this.adoptionEvents.fire();

    const chat = this.storageService.getChat(chatId);
    if (chat && chat.status !== 'active') {
      this.storageService.updateChat(chatId, { status: 'active' });
    }
    if (chat && !chat.harnessSessionId && getWorktree) {
      const worktree = await getWorktree(chat.worktreeId);
      if (worktree) {
        this.registerPendingChat(chat, worktree.path);
      }
    }
    await this.storageService.rememberTerminalPid(chatId, pid);
    // A reload can leave a background tab's title re-tagged as the shell's,
    // which the next quit would then revive it as; rename it in the background.
    await (vscode.window.activeTerminal === terminal ? this.applyTitle(terminal) : this.retitleInBackground(terminal));
    this.stateEmitter.fire({ chatId, state: 'opened' });
  }

  /**
   * Resume every restored tab that VS Code revived as a new shell. A chat is
   * only resumed into its own tab: the workspace must have recorded a PID for
   * it and that PID must differ from the restored shell's, which proves this
   * is not a live agent. A chat whose short ID is on two or more unclaimed
   * tabs is not resumed at all, and every such tab is left unmanaged.
   */
  private async resumeRevivedTerminals(
    chats: ChatSession[],
    recordedPids: Record<string, number>,
    pids: Map<vscode.Terminal, number | undefined>,
    pidReads: Map<vscode.Terminal, Thenable<number | undefined>>,
    getWorktree: WorktreeLookup
  ): Promise<void> {
    const chatsByShortId = new Map<string, ChatSession>();
    const ambiguous = new Set<string>();
    for (const chat of chats) {
      const shortId = chat.id.substring(0, 6);
      if (chatsByShortId.has(shortId)) {
        ambiguous.add(shortId);
      } else {
        chatsByShortId.set(shortId, chat);
      }
    }

    // Tabs titled for a chat that may be resumed into them.
    const matched: Array<{ chat: ChatSession; terminal: vscode.Terminal }> = [];
    for (const terminal of vscode.window.terminals) {
      if (
        terminal.exitStatus !== undefined ||
        this.terminalToChatId.has(terminal)
      ) {
        continue;
      }

      const shortId = titleShortId(terminal.name);
      if (!shortId || ambiguous.has(shortId)) {
        continue;
      }
      const chat = chatsByShortId.get(shortId);
      if (!chat || this.terminals.has(chat.id)) {
        continue;
      }
      // Its harness is switched off in this build: leave the tab alone.
      if (!this.harnessRegistry.has(chat.harness)) {
        continue;
      }

      // Only a chat this workspace launched may be typed into.
      if (recordedPids[chat.id] === undefined) {
        continue;
      }

      // An unlinked fork exists only inside the process that closed;
      // repeating the fork would start from the source's current state.
      if (!chat.harnessSessionId && chat.forkedFromSessionId) {
        continue;
      }

      matched.push({ chat, terminal });
    }

    // Windows can report a revived shell's PID after activation's read gave
    // up. Keep waiting on that same read here, in the background, and hold the
    // matched tabs meanwhile so a click focuses one instead of launching a
    // second agent.
    const late = matched.filter(({ terminal }) => pids.get(terminal) === undefined);
    if (late.length > 0) {
      for (const { chat, terminal } of matched) {
        if (!this.restoringChats.has(chat.id)) {
          this.restoringChats.set(chat.id, terminal);
        }
      }
      await Promise.all(
        late.map(async ({ terminal }) => {
          const read = pidReads.get(terminal);
          pids.set(
            terminal,
            await (read
              ? waitForProcessId(read, RESTORED_SHELL_TIMEOUT_MS)
              : readProcessId(terminal, RESTORED_SHELL_TIMEOUT_MS))
          );
        })
      );
      // Released here; the tabs that become candidates are held again below.
      for (const { chat, terminal } of matched) {
        if (this.restoringChats.get(chat.id) === terminal) {
          this.restoringChats.delete(chat.id);
        }
      }
      if (this.isDisposed) {
        return;
      }
    }

    // A click, a close or an adoption can have claimed a chat while PIDs
    // were read. Of what is left, a chat with two or more tabs carrying its
    // short ID is ambiguous: after a quit every PID is new, so nothing tells
    // its own tab from another terminal that carries the title. Resume none
    // of them rather than guess.
    const open = matched.filter(
      ({ chat, terminal }) =>
        isLiveTerminal(terminal) && !this.terminalToChatId.has(terminal) && !this.terminals.has(chat.id)
    );
    const tabsPerChat = new Map<string, number>();
    for (const { chat } of open) {
      tabsPerChat.set(chat.id, (tabsPerChat.get(chat.id) ?? 0) + 1);
    }
    for (const [chatId, count] of tabsPerChat) {
      if (count > 1) {
        console.warn(
          `Pitwall: ${count} restored terminals carry the title of chat [${chatId.substring(0, 6)}]; none is resumed, because nothing tells the chat's own tab apart`
        );
      }
    }

    const candidates: Array<{ chat: ChatSession; terminal: vscode.Terminal }> = [];
    for (const { chat, terminal } of open) {
      if (tabsPerChat.get(chat.id) !== 1) {
        continue;
      }
      // Type only when the current pty is not the one the chat recorded.
      const pid = pids.get(terminal);
      if (pid === undefined || pid === recordedPids[chat.id]) {
        continue;
      }
      candidates.push({ chat, terminal });
    }

    // The harness checks below read the harness's own store and can be slow.
    // Hold the tab for each chat so a click during the check focuses it instead
    // of launching a second agent.
    for (const { chat, terminal } of candidates) {
      this.restoringChats.set(chat.id, terminal);
    }

    // Resumability checks read the harness's own store, so overlap them. The
    // sends and their storage writes stay ordered to avoid lost updates.
    const prepared = await Promise.all(
      candidates.map(async ({ chat, terminal }) => {
        if (this.isDisposed) {
          return undefined;
        }
        // The chat may have changed since the restore candidates were
        // collected (for example, a click minted a pending session id).
        const latest = this.storageService.getChat(chat.id) ?? chat;
        const worktree = await getWorktree(latest.worktreeId);
        if (!worktree) {
          this.restoringChats.delete(chat.id);
          return undefined;
        }
        const launch = await this.prepareLaunch(latest, worktree.path, false);
        if (!launch) {
          this.restoringChats.delete(chat.id);
          return undefined;
        }
        // The watcher that would have linked this chat died with the previous
        // extension host; register it again before the new session appears.
        this.registerPendingChat(latest, worktree.path);
        return { chat: latest, terminal, launch, worktreePath: worktree.path };
      })
    );

    const revived: StartedTerminal[] = [];
    for (const item of prepared) {
      if (!item || this.isDisposed) {
        continue;
      }
      const { chat, terminal, launch, worktreePath } = item;
      if (!isLiveTerminal(terminal)) {
        this.restoringChats.delete(chat.id);
        continue;
      }
      // A revived shell starts in the workspace root, not the chat's worktree.
      const command = commandInDirectory(
        worktreePath,
        launch.command
      );
      this.restoringChats.delete(chat.id);
      const started = this.startRevivedTerminal(chat, terminal, command);
      await this.recordTerminalPid(chat.id, terminal, pids.get(terminal));
      revived.push(started);
    }

    this.retitleRevivedTerminals(revived);
  }

  /**
   * Re-apply Pitwall's title to tabs that VS Code restored as new shells.
   *
   * An editor terminal is serialized with an empty cwd, so every revival makes
   * the shell report a cwd change and VS Code re-tags the title as a config
   * title. With that tag the revived shell's own title wins, and the next quit
   * restores a tab named after the shell instead of the chat. Only the active
   * tab can be renamed, so each tab is activated without taking focus and the
   * previously active tab is restored afterwards.
   *
   * Runs in the background so a slow shell start does not delay activation,
   * and stops as soon as the user takes over the active tab.
   */
  private retitleRevivedTerminals(revived: StartedTerminal[]): void {
    if (revived.length === 0) {
      return;
    }
    // Captured inside the title queue right before the pass's first show.
    let front: FrontView | undefined;
    // The pass stops once the user activates a terminal; Pitwall's own
    // background shows (this pass, a late retitle, an adoption) do not count.
    const userActivations = this.userActivations;
    const userTookOver = () => this.userActivations !== userActivations;
    // Late-start watches not handed to `retitleOnLateStart` are cancelled
    // when the pass ends, however it ends.
    const unhanded = new Set(revived);
    // Each tab this pass shows stays in front until the next one, so the
    // shows are released only once the front is restored or the pass ends.
    const releases: Array<() => void> = [];
    const releaseShows = () => releases.forEach((release) => release());
    // The tabs this pass showed. The front is put back only while one of them
    // is still the active terminal: otherwise the user moved on (R44).
    const shown = new Set<vscode.Terminal>();
    const showRevived = async (): Promise<void> => {
      for (const item of revived) {
        const { terminal, integrated, started } = item;
        if (this.isDisposed || userTookOver()) {
          return;
        }
        // A shell without integration never re-tags the title, so its stored
        // title is already correct and there is nothing to re-apply.
        if (!(await integrated)) {
          continue;
        }
        if (!(await started)) {
          // The command started after the bounded wait, or has not started
          // yet. Only a rename after the start survives a quit, so rename
          // then, in the background, like a launched tab (R29).
          const late = await item.lateStart;
          if (late) {
            unhanded.delete(item);
            this.retitleOnLateStart(terminal, late);
          }
          continue;
        }
        if (
          this.isDisposed ||
          userTookOver() ||
          !vscode.window.terminals.includes(terminal)
        ) {
          return;
        }
        let outcome: 'shown' | 'deferred' | 'stopped' = 'stopped';
        await this.queueTitleWork(async () => {
          if (
            this.isDisposed ||
            userTookOver() ||
            !vscode.window.terminals.includes(terminal)
          ) {
            return;
          }
          if (!this.canShowInBackground(terminal)) {
            // The user's file or panel is in front of this tab's group.
            this.pendingTitles.add(terminal);
            outcome = 'deferred';
            return;
          }
          front ??= await this.captureFront(terminal);
          releases.push(this.beginPitwallShow(terminal));
          shown.add(terminal);
          await this.showForRetitle(terminal);
          await this.writeTitle(terminal);
          outcome = 'shown';
        });
        if (outcome === 'stopped') {
          return;
        }
      }
    };
    void (async () => {
      try {
        await showRevived();
      } finally {
        // Put back what the user had in front, however the pass ended (R44).
        await this.queueTitleWork(async () => {
          try {
            const active = vscode.window.activeTerminal;
            if (front && !this.isDisposed && !userTookOver() && active !== undefined && shown.has(active)) {
              await this.restoreFront(front);
            }
          } finally {
            releaseShows();
          }
        });
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        releaseShows();
        for (const { lateStart } of unhanded) {
          void lateStart?.then((watch) => {
            if (watch) {
              this.lateStarts.delete(watch.cancel);
              watch.cancel();
            }
          });
        }
      });
  }
}
