import * as vscode from 'vscode';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { TerminalManager } from '../services/TerminalManager';
import { HarnessWatcherRegistry } from '../harness/HarnessWatcherRegistry';
import { SessionImportService } from '../services/SessionImportService';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from '../providers/WorkspacesTreeProvider';
import { ChatSession, HarnessId, Worktree, generateId } from '../types';
import { HarnessRegistry } from '../harness/HarnessRegistry';
import {
  ForkResult,
  HarnessAdapter,
  NativeUiCapability,
  NativeUiOpenResult,
  NativeUiSurfaceTracker,
  NativeUiUnavailable,
  RESTORED_DEADLINE_CAP_MS,
} from '../harness/types';
import { DEFAULT_CHAT_NAME, chatPrimarySessionId } from '../harness/sessionUtils';
import { errorMessage, formatRelativeTime, nextForkName } from '../utils/text';
import { samePath } from '../utils/paths';
import { commandInDirectory } from '../services/terminalEvents';
import { consumeKeepListFocus } from './navigation';
import type { ChatRouter } from '../windows/ChatRouter';
import {
  commandRegistrar,
  defaultWorktreePath,
  noHarnessInstalledMessage,
  pickWorktree,
  promptNewBranchName,
} from './common';

type SessionSurface = 'terminal' | 'ui';
/**
 * Where a row open landed: in this window (a UI tab, a revealed panel, or
 * nothing to open), in a terminal, or handed to its folder's window (T3).
 */
export type PrimaryOpen = 'here' | 'routed' | 'terminal';
/** The Repos list's focus command, contributed by the workbench for the view. */
const FOCUS_LIST_COMMAND = 'pitwall.workspacesView.focus';
/** After a Ctrl+↓/↑ reveals a panel tab, the list is refocused once more this long after the tab settles (E8). */
const PANEL_SETTLE_MS = 250;
/**
 * On the first visit since launch of a restored panel tab, its webview loads
 * and takes focus late: the one retry waits this long after the press. S1
 * (12 launches): the last focus movement came at ≤ 556 ms, + 250, rounded (Q43a).
 */
const RESTORED_DEADLINE_MS = 800;
type LinkedChat = ChatSession & { harnessSessionId: string };

export interface ChatCommandDeps {
  storageService: StorageService;
  gitService: GitService;
  terminalManager: TerminalManager;
  workspacesProvider: Pick<
    WorkspacesTreeProvider,
    'getWorktreeById' | 'getWorktreeByIdAsync' | 'getWorktreeForItem' | 'isGitWorktree'
  >;
  harnessRegistry: HarnessRegistry;
  harnessWatcherRegistry: Pick<HarnessWatcherRegistry, 'registerPendingChat'>;
  sessionImporter: Pick<SessionImportService, 'expectChat' | 'cancelExpectation'>;
  /** The rows selected in the Workspaces tree; a keybinding acts on these. */
  selectedRows: () => readonly WorkspaceTreeItem[];
  /** The worktree the Changes and Files panels show, if any. */
  activeWorktree: () => Worktree | undefined;
  /** Open chats that finished or began waiting while the user was elsewhere, longest-waiting first. */
  sessionsNeedingYou: () => string[];
  /** Select a chat's row and point the worktree panels at it. */
  activateChat: (chat: ChatSession) => void;
  /** Point the Changes and Files panels at a worktree. */
  showWorktree: (worktree: Worktree) => void;
  /** Close chats' terminals, delete their rows, and clear the selection if it was one of them. */
  removeChats: (chatIds: string[], options?: { rememberSession?: boolean }) => string[];
  refreshTree: () => void;
  /** The chat router (T3), once built: a row open lands in its folder's window. */
  router?: () => Pick<ChatRouter, 'route'> | undefined;
}

/** What the session commands give back: this window's open, for the router's local path. */
export interface ChatCommands {
  openChatHere(chat: ChatSession, worktree: Worktree, keepListFocus: boolean): Promise<'here' | 'terminal' | 'failed'>;
}

/**
 * Register the session commands: create, open (terminal or native UI),
 * rename, close, remove, fork, and star.
 *
 * Commands stay harness-agnostic. Per-harness commands are derived from the
 * registry, and behavior that differs by harness comes from the adapter.
 */
export function registerChatCommands(
  context: vscode.ExtensionContext,
  deps: ChatCommandDeps
): ChatCommands {
  const {
    storageService,
    gitService,
    terminalManager,
    workspacesProvider,
    harnessRegistry,
    harnessWatcherRegistry,
    sessionImporter,
    sessionsNeedingYou,
    selectedRows,
    activeWorktree,
    activateChat,
    showWorktree,
    removeChats,
    refreshTree,
  } = deps;

  const register = commandRegistrar(context);

  const defaultSessionSurface = (): SessionSurface =>
    vscode.workspace
      .getConfiguration('pitwall')
      .get<SessionSurface>('defaultSessionSurface', 'ui');

  /**
   * The chat on a session row. A keybinding passes no row, so the command
   * then acts on the tree's selection when exactly one row is selected.
   */
  const rowChat = (item?: WorkspaceTreeItem): ChatSession | undefined => {
    const selection = item ? [item] : selectedRows();
    const row = selection.length === 1 ? selection[0] : undefined;
    return row?.itemType === 'chat' ? (row.data as ChatSession) : undefined;
  };

  /**
   * The chats a row action applies to: every selected session row when the
   * clicked row is one of several selected, otherwise the clicked row alone.
   * A keybinding passes no row and acts on the tree's selection. Current
   * records are returned, so a stale row cannot act on a removed chat.
   */
  const rowChats = (item?: WorkspaceTreeItem, selected?: WorkspaceTreeItem[]): ChatSession[] => {
    const rows = !item
      ? selectedRows()
      : selected && selected.length > 1 && selected.includes(item)
        ? selected
        : [item];
    return rows.flatMap((row) => {
      const current = row.itemType === 'chat' ? storageService.getChat((row.data as ChatSession).id) : undefined;
      return current && harnessRegistry.has(current.harness) ? [current] : [];
    });
  };

  /** The chat on a session row, or the selected chat for a palette command. */
  const resolveChat = (item?: WorkspaceTreeItem): ChatSession | undefined => {
    const chat = rowChat(item);
    if (chat) {
      return chat;
    }
    const activeId = storageService.getActiveChatId();
    const stored = activeId ? storageService.getChat(activeId) : undefined;
    // A stored chat of a harness this build has switched off is not selectable.
    const active = stored && harnessRegistry.has(stored.harness) ? stored : undefined;
    if (!active) {
      vscode.window.showInformationMessage('Select a session first.');
    }
    return active;
  };

  /**
   * The worktree a chat runs in, or an error when it no longer exists. Waits
   * for git when the worktree is not known yet (a first start lists linked
   * worktrees in the background).
   */
  const chatWorktree = async (chat: ChatSession): Promise<Worktree | undefined> => {
    const worktree = await workspacesProvider.getWorktreeByIdAsync(chat.worktreeId);
    if (!worktree) {
      vscode.window.showErrorMessage('Could not find worktree for this session.');
    }
    return worktree;
  };

  /** Make a chat the active row after opening it. */
  const selectChat = (chat: ChatSession, worktree: Worktree): void => {
    showWorktree(worktree);
    storageService.touchChat(chat.id);
    refreshTree();
  };

  /**
   * Persist a pending native ID when the harness accepts a chosen one and the
   * chat has none, then register the chat with its harness watcher. This also
   * gives a chat created before pending IDs existed its ID on first open.
   */
  const registerPendingSession = (
    chat: ChatSession,
    worktree: Worktree,
    pendingSessionId?: string
  ): ChatSession => {
    if (chat.harnessSessionId) {
      return chat;
    }

    // A chat that was waiting for a UI-created session is now starting in a
    // terminal; the importer must not claim a different session for it.
    let target = chat;
    if (chat.pendingUiLaunch) {
      sessionImporter.cancelExpectation(chat.id);
      target = storageService.updateChat(chat.id, { pendingUiLaunch: false }) ?? chat;
    }

    const chosenId =
      pendingSessionId ??
      target.pendingHarnessSessionId ??
      (harnessRegistry.get(target.harness).capabilities.newSessionId
        ? generateId()
        : undefined);
    const updated =
      chosenId && chosenId !== target.pendingHarnessSessionId
        ? storageService.updateChat(target.id, { pendingHarnessSessionId: chosenId }) ?? target
        : target;

    harnessWatcherRegistry.registerPendingChat(updated.harness, updated.id, worktree.path);
    return updated;
  };

  /**
   * Open a chat in its terminal. A live terminal is focused; otherwise a new
   * one is launched and registered for linkage when the harness assigns its
   * session ID later. `keepListFocus` (a Ctrl+↓/↑, Q4) shows it without
   * taking focus, and puts focus back on the list once a new terminal's
   * creation and rename have settled (E8, F4).
   */
  const openInTerminal = async (chat: ChatSession, worktree: Worktree, keepListFocus = false): Promise<boolean> => {
    pitwallOpens += 1;
    const prepared = terminalManager.isActive(chat.id)
      ? chat
      : registerPendingSession(chat, worktree);
    // Armed now, at the key press, so a move before the first refocus counts too.
    const refocus = keepListFocus ? listRefocusAfterTitle(chat) : undefined;
    const terminal = await terminalManager.openChat(prepared, worktree, {
      preserveFocus: keepListFocus,
      ...(refocus ? { afterTitle: refocus.afterTitle } : {}),
    });
    await refocus?.openReturned();
    selectChat(prepared, worktree);
    return terminal !== undefined;
  };

  /** Every chat open Pitwall starts; a held list yields to a newer one. */
  let pitwallOpens = 0;
  /** The focus watch of the last Ctrl+↓/↑ terminal open that may still restore the list. */
  let heldList: vscode.Disposable | undefined;
  /** When the last native-UI open started its reveal: a Ctrl+↓/↑ hold times its first-visit retry from it. */
  let revealStartedAt = 0;
  context.subscriptions.push({ dispose: () => heldList?.dispose() });

  /**
   * The list refocus for a Ctrl+↓/↑ terminal open (E8). The list is held
   * from the key press: `'now'`, once the terminal exists, refocuses it, and
   * each later title write (`'late'`: the shell reported in) drops focus
   * again, so it restores the list. Both run only while the list is still
   * held, and any move since the press lets go of it (QA #47): a text editor,
   * another terminal or a non-terminal tab (a Claude panel tab, in this
   * group or another) becoming active, the window losing focus, or another
   * Pitwall open. A missed restore is harmless; a stolen focus is not. The
   * new terminal itself becoming active, and Pitwall's own activations to
   * rename tabs, are not moves. Typing into the new terminal can't be seen:
   * `isInteractedWith` turns true when Pitwall sends the launch line (QA #51),
   * so type-ahead before the late rename is a known issue.
   */
  const listRefocusAfterTitle = (chat: ChatSession) => {
    heldList?.dispose();
    const opensAtPress = pitwallOpens;
    let held = true;
    let refocusedNow = false;
    const activeTab = () => vscode.window.tabGroups.activeTabGroup?.activeTab;
    const tabAtPress = activeTab();
    /** Whether a terminal becoming active is this open's own doing (its new terminal, a rename pass), not the user's. */
    const isOwnActivation = (terminal: vscode.Terminal): boolean => {
      const chatId = terminalManager.getChatIdForTerminal(terminal);
      return chatId === chat.id || (chatId !== undefined && terminalManager.isPitwallActivation(chatId));
    };
    const terminalMoved = (terminal: vscode.Terminal): void => {
      if (isOwnActivation(terminal)) {
        return;
      }
      // A terminal can report active while it is being created, before the
      // open maps it to its chat, which it does in the same task: decide once
      // that task is done.
      void Promise.resolve().then(() => !isOwnActivation(terminal) && letGo());
    };
    const tabMoved = () => {
      const tab = activeTab();
      if (tab !== tabAtPress && !(tab?.input instanceof vscode.TabInputTerminal)) {
        letGo();
      }
    };
    const watches = [
      vscode.window.onDidChangeActiveTextEditor((editor) => editor && letGo()),
      vscode.window.onDidChangeActiveTerminal((terminal) => terminal && terminalMoved(terminal)),
      vscode.window.tabGroups.onDidChangeTabs(tabMoved),
      vscode.window.tabGroups.onDidChangeTabGroups(tabMoved),
      vscode.window.onDidChangeWindowState((state) => !state.focused && letGo()),
    ];
    const watch: vscode.Disposable = { dispose: () => watches.forEach((entry) => entry.dispose()) };
    heldList = watch;
    function letGo(): void {
      held = false;
      watch.dispose();
      if (heldList === watch) {
        heldList = undefined;
      }
    }
    const stillHeld = () => held && pitwallOpens === opensAtPress && heldList === watch;
    return {
      afterTitle: async (phase: 'now' | 'late'): Promise<void> => {
        if (phase === 'now') {
          refocusedNow = true;
        }
        if (stillHeld()) {
          await refocusList();
        } else {
          letGo();
        }
      },
      /**
       * An existing terminal is only shown and never calls back. Showing it
       * still moves focus to its tab (E8), so the list is refocused once, if
       * nothing moved since the press, and nothing is left to hold.
       */
      openReturned: async (): Promise<void> => {
        if (refocusedNow) {
          return;
        }
        const refocus = stillHeld();
        letGo();
        if (refocus) {
          await refocusList();
        }
      },
    };
  };

  /**
   * Claude's chat panel takes focus again once its revealed webview has
   * activated, after the refocus above (E8). Nothing public reveals a panel
   * tab without focus, so the list is refocused once more, a short settle
   * after the tab is active. One retry, never a loop, and only while nothing
   * else moved since: an editor, another terminal, the window losing focus,
   * a second tab change or another Pitwall open lets go.
   *
   * The held tab changing again with the active tab unchanged is the host's
   * doing, not the user's (S1: once 77-162 ms after the activation, then a
   * burst at about +2.3 s), so it is ignored; a switch, open or close still
   * lets go (Q43a). On the first visit since launch of a restored tab, whose
   * webview loads now and takes focus late, the retry waits until
   * RESTORED_DEADLINE_MS after the press, never past RESTORED_DEADLINE_CAP_MS
   * (E11). `pressedAt` is when the reveal started.
   */
  const holdListForPanel = (surfaces: NativeUiSurfaceTracker | undefined, pressedAt: number): void => {
    heldList?.dispose();
    const opensAtPress = pitwallOpens;
    const activeTab = () => vscode.window.tabGroups.activeTabGroup?.activeTab;
    let settled = activeTab();
    let tabChanges = 0;
    let timer: NodeJS.Timeout | undefined;
    const watches: vscode.Disposable[] = [];
    const watch: vscode.Disposable = {
      dispose: () => {
        clearTimeout(timer);
        watches.forEach((entry) => entry.dispose());
        // Whether the retry fired or the hold let go, this tab's first visit is over (QA C1).
        if (settled) {
          surfaces?.endFirstVisit?.(settled);
        }
      },
    };
    heldList = watch;
    const letGo = (): void => {
      watch.dispose();
      if (heldList === watch) {
        heldList = undefined;
      }
    };
    /** When the one retry runs: a settle after the tab settled, or the first-visit deadline after the press. */
    const retryDelay = (): number => {
      if (!settled || !surfaces?.isFirstVisitSinceLaunch?.(settled)) {
        return PANEL_SETTLE_MS;
      }
      const now = Date.now();
      const at = Math.min(Math.max(pressedAt + RESTORED_DEADLINE_MS, now + PANEL_SETTLE_MS), pressedAt + RESTORED_DEADLINE_CAP_MS);
      return Math.max(0, at - now);
    };
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const stillHeld = heldList === watch && pitwallOpens === opensAtPress && activeTab() === settled;
        letGo();
        if (stillHeld) {
          void refocusList();
        }
      }, retryDelay());
    };
    /** The held tab changed again, the active tab did not: the host's doing (S1), not a move. */
    const sameTabAgain = (event: vscode.TabChangeEvent): boolean =>
      event.opened.length === 0 &&
      event.closed.length === 0 &&
      event.changed.length > 0 &&
      event.changed.every((tab) => tab === settled) &&
      activeTab() === settled;
    watches.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => editor && letGo()),
      vscode.window.onDidChangeActiveTerminal((terminal) => terminal && letGo()),
      vscode.window.onDidChangeWindowState((state) => !state.focused && letGo()),
      vscode.window.tabGroups.onDidChangeTabs((event) => {
        if (sameTabAgain(event)) {
          return;
        }
        // The revealed tab becoming active is the one change expected; a second is the user's.
        tabChanges += 1;
        if (tabChanges > 1) {
          letGo();
          return;
        }
        settled = activeTab();
        arm();
      })
    );
    arm();
  };

  /**
   * Put keyboard focus back on the Repos list after an open in this window
   * (Q4). The webview takes focus with its tab, at the open itself (S1b), so
   * this runs right after the awaited open; no timer.
   */
  const refocusList = async (): Promise<void> => {
    try {
      await vscode.commands.executeCommand(FOCUS_LIST_COMMAND);
    } catch (error) {
      console.error('[Pitwall] Could not refocus the Repos list:', error);
    }
  };

  /**
   * Start a new session in the agent's VS Code UI. The extension assigns the
   * session ID and writes the transcript on the first prompt, so the chat is
   * created now and the importer links it when the native session appears.
   */
  const startSessionInNativeUi = async (
    worktree: Worktree,
    harness: HarnessId,
    nativeUi: NativeUiCapability
  ): Promise<void> => {
    const chat = storageService.createChat(worktree.id, harness, DEFAULT_CHAT_NAME, { pendingUiLaunch: true });
    await sessionImporter.expectChat(chat.id, worktree.path, { bindSurface: true });
    selectChat(chat, worktree);

    const result = await tryOpen(() => nativeUi.openNewSession(worktree.path));
    if (result.kind === 'opened') {
      vscode.window.showInformationMessage(
        `Opened a new ${nativeUi.displayName} conversation for ${worktree.name}. Send your first prompt there; Pitwall will link the session.`
      );
      return;
    }

    // The conversation never opened. Drop the placeholder rather than leave an
    // unlinked row that could reserve (or be renamed from) a session the user
    // did not start.
    sessionImporter.cancelExpectation(chat.id);
    removeChats([chat.id], { rememberSession: false });
    refreshTree();
    await reportNativeUiProblem(nativeUi, worktree.path, result);
  };

  const createSession = async (
    item: WorkspaceTreeItem | undefined,
    harness: HarnessId,
    surface?: SessionSurface,
    /** Used when no row was clicked, before asking. */
    fallbackWorktree?: Worktree
  ): Promise<void> => {
    const worktree =
      workspacesProvider.getWorktreeForItem(item) ??
      fallbackWorktree ??
      (await pickWorktree(storageService, gitService, 'Select worktree for new session'));
    if (!worktree) {
      return;
    }

    const adapter = harnessRegistry.get(harness);
    // Only the explicit "In Terminal"/"In UI" commands name a surface; the
    // plain New Session command follows the configured default.
    const nativeUi = (surface ?? defaultSessionSurface()) === 'ui' ? adapter.nativeUi : undefined;
    if (nativeUi) {
      const availability = nativeUi.checkNewSessionAvailability(worktree.path);
      if (availability.kind === 'available') {
        await startSessionInNativeUi(worktree, harness, nativeUi);
        return;
      }
      if (surface === 'ui') {
        await explainNativeUiUnavailable(nativeUi, worktree.path, availability);
        return;
      }
      // The default surface is a preference: when the UI cannot start this
      // worktree, keep the action useful by launching the terminal.
    }

    if (!(await adapter.isInstalled())) {
      vscode.window.showErrorMessage(noHarnessInstalledMessage(harnessRegistry));
      return;
    }

    // The name updates when the harness or the first prompt provides one. A
    // harness that accepts a chosen ID gets one now, so the transcript is
    // linked deterministically when the first prompt creates it.
    const chat = storageService.createChat(worktree.id, harness, DEFAULT_CHAT_NAME);
    const prepared = registerPendingSession(chat, worktree);
    await terminalManager.openChat(prepared, worktree);
    selectChat(prepared, worktree);
  };

  /**
   * Hand an existing session to its harness's native UI. Shared by the
   * explicit Open in ... commands and the row click (which reveals an open
   * panel, or follows a UI default). Every refusal is explained, and a running
   * terminal is closed only after the user confirms and the UI is known to be
   * able to open the session, so two agent processes never share a session.
   * Resolves true when the UI opened or revealed the session.
   */
  const openChatInNativeUi = async (
    chat: ChatSession,
    worktree: Worktree,
    nativeUi: NativeUiCapability
  ): Promise<boolean> => {
    pitwallOpens += 1;
    const adapter = harnessRegistry.get(chat.harness);
    const surfaces = nativeUi.surfaces;
    if (!nativeUi.isInstalled()) {
      await explainNativeUiUnavailable(nativeUi, worktree.path, { kind: 'not-installed' });
      return false;
    }

    // The UI extensions cannot adopt a chosen ID, so the handoff only covers a
    // session that already exists natively.
    const sessionId = chatPrimarySessionId(chat);
    if (!sessionId) {
      vscode.window.showInformationMessage(
        chat.pendingUiLaunch
          ? pendingUiMessage(nativeUi.displayName)
          : `Start this session in the terminal first. ${nativeUi.displayName} can open it after its first prompt creates the session.`
      );
      return false;
    }

    // A tab the editor restored (or the user opened) is adopted first, by a
    // title that names one chat of this folder, so its chat is revealed and
    // bound rather than expected (I1). Waits at most 1 s for the titles.
    await surfaces?.adoptBeforeOpen?.();
    // Revealing an open panel needs neither a resume check nor a terminal close.
    let open = surfaces?.isOpen(sessionId) ?? false;
    if (!open && terminalManager.isResuming(chat.id)) {
      vscode.window.showInformationMessage('This session is still starting. Try again in a moment.');
      return false;
    }
    if (!open) {
      // A session the UI can't resume opens a blank tab there (Q23): say why
      // and resume it where it can be resumed.
      const refusal = await nativeUi.resumeRefusal?.(sessionId);
      if (refusal) {
        vscode.window.showInformationMessage(refusal);
        await openInTerminal(chat, worktree);
        return false;
      }

      const resumable = await adapter.isSessionResumable(sessionId, worktree.path);
      // The panel may have opened while the native check was in flight; an
      // open panel is itself proof that the session exists.
      open = surfaces?.isOpen(sessionId) ?? false;
      if (!resumable && !open) {
        if (chat.harnessSessionId) {
          vscode.window.showWarningMessage(
            `The ${adapter.displayName} session no longer exists. It may have been removed.`
          );
        } else {
          vscode.window.showInformationMessage(
            `This session has no transcript yet. Send a prompt in the terminal first, then open it in ${nativeUi.displayName}.`
          );
        }
        return false;
      }
    }

    // Preflight the folder before stopping a terminal: a mismatch must not
    // cost the user a running process.
    const availability = nativeUi.checkAvailability(worktree.path);
    if (availability.kind !== 'available') {
      await explainNativeUiUnavailable(nativeUi, worktree.path, availability);
      return false;
    }

    if (!open && terminalManager.isActive(chat.id)) {
      const confirm = await vscode.window.showWarningMessage(
        `Close the terminal for "${chat.name}"?\n\nThe running ${adapter.displayName} process stops. The conversation is preserved and will open in ${nativeUi.displayName}.`,
        { modal: true },
        'Close and Open'
      );
      if (confirm !== 'Close and Open') {
        return false;
      }
      const closed = terminalManager.waitForChatClosed(chat.id);
      terminalManager.closeChat(chat.id);
      if (!(await closed)) {
        vscode.window.showErrorMessage(
          'Could not close the terminal for this session. Close it and try again.'
        );
        return false;
      }
    }

    // Claude's tab carries only its title, so the expectation is what binds
    // the tab it creates. A tracker that reads the ID from the tab, or a tab
    // that is already mapped, ignores it.
    surfaces?.expect(sessionId, chat.name);
    revealStartedAt = Date.now();
    const result = await tryOpen(() => nativeUi.openSession(sessionId, worktree.path));
    if (result.kind !== 'opened') {
      surfaces?.cancelExpect(sessionId);
      await reportNativeUiProblem(nativeUi, worktree.path, result);
      return false;
    }
    surfaces?.settle(sessionId, { allowActiveFallback: true });
    selectChat(chat, worktree);
    activateChat(chat);
    return true;
  };

  /**
   * Whether a UI default can open this chat without asking anything: it has a
   * native session the UI can resume (Q23), no terminal owns it, and the UI
   * can open its worktree.
   */
  const canOpenInNativeUi = async (
    chat: ChatSession,
    worktree: Worktree,
    nativeUi: NativeUiCapability
  ): Promise<boolean> =>
    Boolean(chat.harnessSessionId) &&
    !terminalManager.isActive(chat.id) &&
    !terminalManager.isResuming(chat.id) &&
    nativeUi.isInstalled() &&
    nativeUi.checkAvailability(worktree.path).kind === 'available' &&
    !(await nativeUi.resumeRefusal?.(chat.harnessSessionId!));

  /**
   * Open a chat the way a row click does. Shared by the row click, the
   * needs-you jump and the starred-session picker so all obey "never two
   * agent processes for one session".
   *
   * With the router (T3), a chat of another folder goes to that folder's
   * window and focus goes with it (Q4); a chat of this window's folder opens
   * here through `openChatHere`. A Ctrl+↓/↑ that fired this open left a
   * one-shot marker, read now, before anything is awaited.
   */
  const openChatPrimary = async (chat: ChatSession, worktree: Worktree): Promise<PrimaryOpen> => {
    const keepListFocus = consumeKeepListFocus();
    const router = deps.router?.();
    if (router) {
      const where = await router.route({ kind: 'open', chats: [chat] }, { keepListFocus });
      return where === 'routed' ? 'routed' : 'here';
    }
    const result = await openChatHere(chat, worktree, keepListFocus);
    return result === 'terminal' ? 'terminal' : 'here';
  };

  /**
   * Open a chat in this window (T2's path). `worktree.path` is the folder
   * availability is checked against and a terminal starts in: the chat's
   * launch folder when the router passes one (Q2). The list keeps focus
   * after a Ctrl+↓/↑ (Q4), by `show(true)` on a terminal and by a refocus
   * right after an open in this window's UI. 'failed' when nothing opened.
   */
  const openChatHere = async (
    chat: ChatSession,
    worktree: Worktree,
    keepListFocus: boolean
  ): Promise<'here' | 'terminal' | 'failed'> => {
    const nativeUi = harnessRegistry.get(chat.harness).nativeUi;
    const sessionId = chatPrimarySessionId(chat);
    const terminalOpen = terminalManager.isActive(chat.id);
    // The panels follow the chat's own worktree, never the launch folder it opened in.
    const listed = workspacesProvider.getWorktreeById(chat.worktreeId) ?? worktree;

    const inUi = async (ui: NativeUiCapability): Promise<'here' | 'failed'> => {
      const opened = await openChatInNativeUi(chat, worktree, ui);
      if (listed.path !== worktree.path) {
        showWorktree(listed);
      }
      if (opened && keepListFocus) {
        await refocusList();
        holdListForPanel(ui.surfaces, revealStartedAt);
      }
      return opened ? 'here' : 'failed';
    };

    // A session already open in its agent's UI is revealed, not duplicated in
    // a terminal. A live terminal stays the surface a click focuses.
    if (nativeUi && sessionId && nativeUi.surfaces?.isOpen(sessionId) && !terminalOpen) {
      return inUi(nativeUi);
    }

    // A UI-started chat has no native ID until its first prompt; a click must
    // not start a second agent beside the open conversation.
    if (chat.pendingUiLaunch && !terminalOpen) {
      vscode.window.showInformationMessage(pendingUiMessage(nativeUi?.displayName));
      return 'here';
    }

    // The configured default is a preference: use the UI when it can open the
    // session, otherwise keep the action useful in the terminal.
    if (
      defaultSessionSurface() === 'ui' &&
      nativeUi &&
      (await canOpenInNativeUi(chat, worktree, nativeUi))
    ) {
      return inUi(nativeUi);
    }

    const opened = await openInTerminal(chat, worktree, keepListFocus);
    if (listed.path !== worktree.path) {
      showWorktree(listed);
    }
    return opened ? 'terminal' : 'failed';
  };

  /** Explicit Open in <harness> UI: refuses another harness's session. */
  const openNativeUi = async (
    item: WorkspaceTreeItem | undefined,
    harness: HarnessId,
    nativeUi: NativeUiCapability
  ): Promise<void> => {
    const chat = resolveChat(item);
    if (!chat) {
      return;
    }
    if (chat.harness !== harness) {
      vscode.window.showInformationMessage(
        `This is not a ${harnessRegistry.get(harness).displayName} session.`
      );
      return;
    }
    const worktree = await chatWorktree(chat);
    if (worktree) {
      await openChatInNativeUi(chat, worktree, nativeUi);
    }
  };

  /** Create the forked chat and open it. Shared by both fork commands. */
  const openFork = async (source: LinkedChat, worktree: Worktree, fork: ForkResult): Promise<void> => {
    const name = nextForkName(
      source.name,
      storageService.getChatsByWorktree(worktree.id).map((chat) => chat.name)
    );
    if (fork.kind === 'linked') {
      const linked = storageService.createChat(worktree.id, source.harness, name, {
        harnessSessionId: fork.sessionId,
      });
      await terminalManager.openChat(linked, worktree);
    } else {
      // The harness forks in the terminal under the chosen ID and its watcher
      // links the transcript. Keep the source so a reopen before the first
      // prompt repeats the fork.
      const forked = storageService.createChat(worktree.id, source.harness, name, {
        forkedFromSessionId: source.harnessSessionId,
      });
      await terminalManager.openChat(registerPendingSession(forked, worktree, fork.pendingSessionId), worktree);
    }
    showWorktree(worktree);
    refreshTree();
  };

  /** A row's chat that has a native session to fork, and its worktree. */
  const forkSource = async (
    item?: WorkspaceTreeItem
  ): Promise<{ chat: LinkedChat; worktree: Worktree } | undefined> => {
    const chat = rowChat(item);
    if (!chat) {
      return undefined;
    }
    if (!chat.harnessSessionId) {
      vscode.window.showErrorMessage(
        'Cannot fork a session that has not been started yet. Start the session first.'
      );
      return undefined;
    }
    const worktree = await chatWorktree(chat);
    return worktree ? { chat: chat as LinkedChat, worktree } : undefined;
  };

  // Per-harness commands come from the registry: a harness with a native UI
  // also gets explicit In Terminal / In UI variants and an Open in UI command.
  for (const adapter of harnessRegistry.all()) {
    const name = `${adapter.id[0].toUpperCase()}${adapter.id.slice(1)}`;
    register(`pitwall.new${name}Chat`, (item?: WorkspaceTreeItem) =>
      createSession(item, adapter.id)
    );
    const nativeUi = adapter.nativeUi;
    if (nativeUi) {
      register(`pitwall.new${name}ChatInTerminal`, (item?: WorkspaceTreeItem) =>
        createSession(item, adapter.id, 'terminal')
      );
      register(`pitwall.new${name}ChatInUi`, (item?: WorkspaceTreeItem) =>
        createSession(item, adapter.id, 'ui')
      );
      register(`pitwall.open${name}Ui`, (item?: WorkspaceTreeItem) =>
        openNativeUi(item, adapter.id, nativeUi)
      );
    }
  }
  // Backwards-compatible alias; hidden from menus. It starts the first enabled
  // harness: the registry holds src/harnesses/enabled.json in order.
  register('pitwall.newChat', (item?: WorkspaceTreeItem) => {
    const [first] = harnessRegistry.all();
    return first ? createSession(item, first.id) : undefined;
  });

  /** The configured default agent, when it names a registered harness. */
  const defaultHarness = (): HarnessId | undefined => {
    const id = vscode.workspace.getConfiguration('pitwall').get<string>('defaultHarness', '');
    return harnessRegistry.all().find((adapter) => adapter.id === id)?.id;
  };

  /**
   * Whether New Session can start this harness: its CLI is installed, or the
   * preferred surface is its VS Code UI and that extension is.
   */
  const canStartSession = async (adapter: HarnessAdapter): Promise<boolean> =>
    (await harnessRegistry.isInstalled(adapter.id)) ||
    (defaultSessionSurface() === 'ui' && Boolean(adapter.nativeUi?.isInstalled()));

  // One click starts the default agent. Without a usable default the command
  // asks, so it is never a dead end from the palette or a stale setting. From
  // the keyboard or the palette it starts in the worktree the panels show.
  register('pitwall.newDefaultSession', async (item?: WorkspaceTreeItem) => {
    const start = (harness: HarnessId) =>
      createSession(item, harness, undefined, item ? undefined : activeWorktree());
    const all = harnessRegistry.all();
    const startable = (await Promise.all(all.map(canStartSession))).flatMap((ok, index) =>
      ok ? [all[index]] : []
    );
    if (startable.length === 0) {
      vscode.window.showErrorMessage(noHarnessInstalledMessage(harnessRegistry));
      return;
    }
    const preferred = defaultHarness();
    if (preferred && startable.some((adapter) => adapter.id === preferred)) {
      await start(preferred);
      return;
    }
    if (startable.length === 1 && !preferred) {
      await start(startable[0].id);
      return;
    }
    const selected = await vscode.window.showQuickPick(
      startable.map((adapter) => ({ label: adapter.displayName, harness: adapter.id })),
      {
        placeHolder: preferred
          ? `${harnessRegistry.get(preferred).displayName} is the default agent but is not installed. Choose an agent for the new session`
          : 'Choose an agent for the new session',
      }
    );
    if (selected) {
      await start(selected.harness);
    }
  });

  register('pitwall.setDefaultHarness', async () => {
    const current = defaultHarness();
    const mark = (id: HarnessId | undefined) => (id === current ? 'current' : undefined);
    const adapters = harnessRegistry.all();
    const installed = await Promise.all(adapters.map((adapter) => harnessRegistry.isInstalled(adapter.id)));
    const selected = await vscode.window.showQuickPick<vscode.QuickPickItem & { harness: HarnessId | '' }>(
      [
        {
          label: 'Ask Every Time',
          description: mark(undefined),
          detail: 'New Session opens a menu of every installed agent.',
          harness: '',
        },
        ...adapters.map((adapter, index) => ({
          label: adapter.displayName,
          description: [mark(adapter.id), installed[index] ? undefined : 'not installed']
            .filter(Boolean)
            .join(' · '),
          harness: adapter.id,
        })),
      ],
      { title: 'Default Agent', placeHolder: 'Choose the agent New Session starts with one click' }
    );
    if (selected) {
      await vscode.workspace
        .getConfiguration('pitwall')
        .update('defaultHarness', selected.harness, vscode.ConfigurationTarget.Global);
    }
  });

  register('pitwall.openChat', async (item?: WorkspaceTreeItem) => {
    const chat = rowChat(item);
    const worktree = chat && (await chatWorktree(chat));
    if (chat && worktree) {
      await openChatPrimary(chat, worktree);
    }
  });

  // The bell on a needs-you row: the same as clicking the row. Its own
  // command only because a command has one icon.
  register('pitwall.openNeedsYouChat', (item?: WorkspaceTreeItem) =>
    vscode.commands.executeCommand('pitwall.openChat', item)
  );

  // Explicitly open a session in its terminal. If it is open in its agent's
  // UI, close that tab first so two agent processes cannot run.
  register('pitwall.openChatInTerminal', async (item?: WorkspaceTreeItem) => {
    const chat = resolveChat(item);
    const worktree = chat && (await chatWorktree(chat));
    if (!chat || !worktree) {
      return;
    }

    if (!terminalManager.isActive(chat.id)) {
      if (chat.pendingUiLaunch) {
        const confirm = await vscode.window.showWarningMessage(
          `"${chat.name}" is starting in its VS Code UI. Starting it in a terminal may create two sessions.`,
          { modal: true },
          'Start in Terminal'
        );
        if (confirm !== 'Start in Terminal') {
          return;
        }
      }

      const nativeUi = harnessRegistry.get(chat.harness).nativeUi;
      const sessionId = chatPrimarySessionId(chat);
      if (nativeUi?.surfaces && sessionId && nativeUi.surfaces.isOpen(sessionId)) {
        const confirm = await vscode.window.showWarningMessage(
          `Close the ${nativeUi.displayName} tab for "${chat.name}"?\n\nThe UI session stops running. The conversation will resume in a terminal.`,
          { modal: true },
          'Close and Open'
        );
        if (confirm !== 'Close and Open') {
          return;
        }
        if (!(await nativeUi.surfaces.closeSurface(sessionId))) {
          vscode.window.showErrorMessage(
            `Could not close the ${nativeUi.displayName} tab. Close it and try again.`
          );
          return;
        }
      }
    }

    await openInTerminal(chat, worktree);
  });

  register('pitwall.renameChat', async (item?: WorkspaceTreeItem) => {
    const chat = rowChat(item);
    if (!chat) {
      return;
    }
    const newName = await vscode.window.showInputBox({
      prompt: 'Enter new name for this session',
      value: chat.name,
      validateInput: (value) =>
        value && value.trim().length > 0 ? undefined : 'Session name is required',
    });
    if (!newName || newName === chat.name) {
      return;
    }
    storageService.updateChat(chat.id, { name: newName, customName: true });
    refreshTree();
  });

  // Close the running terminal; the chat stays in the list.
  register('pitwall.closeChat', (item?: WorkspaceTreeItem, selected?: WorkspaceTreeItem[]) => {
    const chats = rowChats(item, selected);
    for (const chat of chats) {
      terminalManager.closeChat(chat.id);
    }
    if (chats.length > 0) {
      refreshTree();
    }
  });

  // Remove a chat from the list. The harness keeps the session.
  register('pitwall.deleteChat', async (item?: WorkspaceTreeItem, selected?: WorkspaceTreeItem[]) => {
    const chats = rowChats(item, selected);
    if (chats.length === 0) {
      return;
    }
    const harnessNames = [...new Set(chats.map((chat) => harnessRegistry.get(chat.harness).displayName))];
    let message: string;
    if (chats.length === 1) {
      message = `Remove "${chats[0].name}" from the list?\n\nThe session in ${harnessNames[0]} is preserved and can be re-imported later.`;
    } else {
      // Name what goes: the first few sessions, then a count of the rest.
      const names = chats.slice(0, 5).map((chat) => `• ${chat.name}`);
      if (chats.length > names.length) {
        names.push(`…and ${chats.length - names.length} more`);
      }
      message = `Remove ${chats.length} sessions from the list?\n\n${names.join('\n')}\n\nThe sessions in ${harnessNames.join(', ')} are preserved and can be re-imported later.`;
    }
    const confirm = await vscode.window.showWarningMessage(message, { modal: true }, 'Remove');
    if (confirm !== 'Remove') {
      return;
    }
    removeChats(chats.map((chat) => chat.id));
    refreshTree();
  });

  register('pitwall.clearWorktreeSessions', async (item?: WorkspaceTreeItem) => {
    const worktree = workspacesProvider.getWorktreeForItem(item);
    if (!worktree) {
      return;
    }
    const chats = storageService.getChatsByWorktree(worktree.id);
    if (chats.length === 0) {
      vscode.window.showInformationMessage(`No sessions to clear for "${worktree.name}".`);
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Clear all ${chats.length} session(s) from "${worktree.name}"?\n\nThe harness sessions are preserved and can be re-imported later.`,
      { modal: true },
      'Clear All'
    );
    if (confirm !== 'Clear All') {
      return;
    }

    const deletedIds = removeChats(chats.map((chat) => chat.id));
    vscode.window.showInformationMessage(
      `Cleared ${deletedIds.length} session(s) from "${worktree.name}".`
    );
    refreshTree();
  });

  register('pitwall.forkChat', async (item?: WorkspaceTreeItem) => {
    const source = await forkSource(item);
    if (!source) {
      return;
    }
    const { chat, worktree } = source;
    const adapter = harnessRegistry.get(chat.harness);
    let fork: ForkResult;
    try {
      fork = await adapter.forkSession(chat.harnessSessionId, worktree.path);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to fork ${adapter.displayName} session: ${errorMessage(error)}`
      );
      return;
    }
    await openFork(chat, worktree, fork);
    vscode.window.showInformationMessage(`Forked session "${chat.name}"`);
  });

  // Parked by ROADMAP row 3.6 (ruling P9): registered, not contributed.
  // Fork into a new worktree that starts from the source's HEAD and carries
  // its uncommitted changes.
  register('pitwall.forkChatWithChanges', async (item?: WorkspaceTreeItem) => {
    const source = await forkSource(item);
    if (!source) {
      return;
    }
    const { chat, worktree } = source;

    if (!workspacesProvider.isGitWorktree(worktree)) {
      vscode.window.showInformationMessage(
        'This session lives in a plain folder, so there is no branch to fork into a worktree. Use Fork Session Here to fork it in the same folder.'
      );
      return;
    }
    const repo = storageService.getRepository(worktree.repoId);
    if (!repo) {
      vscode.window.showErrorMessage('Could not find repository for this worktree.');
      return;
    }

    // Validate the source before prompting and creating a worktree; a missing
    // transcript would otherwise leave a new worktree behind.
    const adapter = harnessRegistry.get(chat.harness);
    if (!(await adapter.isSessionResumable(chat.harnessSessionId, worktree.path))) {
      vscode.window.showErrorMessage(`The ${adapter.displayName} session no longer exists.`);
      return;
    }

    const branch = await promptNewBranchName(gitService.getBranches(repo.rootPath), {
      prompt: 'Enter branch name for the new worktree',
      value: `${worktree.name}-fork`,
    });
    if (!branch) {
      return;
    }
    const worktreePath = await vscode.window.showInputBox({
      prompt: 'Enter path for the new worktree directory',
      value: defaultWorktreePath(repo, branch),
      validateInput: (value) => (value.trim() ? undefined : 'Path is required'),
    });
    if (!worktreePath) {
      return;
    }

    const baseCommit = gitService.getCurrentCommit(worktree.path);
    if (
      !gitService.createWorktreeWithNewBranch(repo.rootPath, branch, worktreePath, baseCommit || 'HEAD')
    ) {
      vscode.window.showErrorMessage('Failed to create worktree.');
      return;
    }
    if (
      gitService.hasUncommittedChanges(worktree.path) &&
      !gitService.copyUncommittedChanges(worktree.path, worktreePath)
    ) {
      vscode.window.showWarningMessage('Worktree created but some changes may not have been copied.');
    }
    refreshTree();

    // Git reports the physical path, which may differ from what was typed.
    const newWorktree = gitService
      .listWorktrees(repo.rootPath, repo.id)
      .find((candidate) => samePath(candidate.path, worktreePath));
    if (!newWorktree) {
      vscode.window.showErrorMessage('Worktree created but could not find it in the list.');
      return;
    }

    // The adapter decides how the fork reaches the destination cwd.
    let fork: ForkResult;
    try {
      fork = await adapter.prepareForkToNewWorktree(chat.harnessSessionId, worktree.path, worktreePath);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to fork the ${adapter.displayName} session into the new worktree: ${errorMessage(error)}`
      );
      return;
    }
    await openFork(chat, newWorktree, fork);
    vscode.window.showInformationMessage(`Forked session to new worktree "${branch}"`);
  });

  // Star and Unstar set the state of every selected row; a row already in
  // that state is left alone. `toggleStarChat` is the earlier name, kept for
  // existing keybindings: it flips the clicked row.
  const setStarred = (wanted: boolean | 'toggle') =>
    (item?: WorkspaceTreeItem, selected?: WorkspaceTreeItem[]) => {
      const starred = storageService.getStarredChatIds();
      const chats = rowChats(item, wanted === 'toggle' ? undefined : selected).filter(
        (chat) => wanted === 'toggle' || starred.has(chat.id) !== wanted
      );
      for (const chat of chats) {
        storageService.toggleStar(chat.id);
      }
      if (chats.length > 0) {
        refreshTree();
      }
    };
  register('pitwall.starChat', setStarred(true));
  register('pitwall.unstarChat', setStarred(false));
  register('pitwall.toggleStarChat', setStarred('toggle'));

  /** A row's chat with a native session, or an explanation when it has none yet. */
  const linkedRowChat = (item?: WorkspaceTreeItem): LinkedChat | undefined => {
    const chat = rowChat(item);
    if (chat && !chat.harnessSessionId) {
      vscode.window.showInformationMessage(
        'This session has no ID yet. It gets one when its first prompt is sent.'
      );
      return undefined;
    }
    return chat as LinkedChat | undefined;
  };

  register('pitwall.copySessionId', async (item?: WorkspaceTreeItem) => {
    const chat = linkedRowChat(item);
    if (chat) {
      await vscode.env.clipboard.writeText(chat.harnessSessionId);
      vscode.window.showInformationMessage(`Copied: ${chat.harnessSessionId}`);
    }
  });

  // The command that resumes the session from any terminal.
  register('pitwall.copyResumeCommand', async (item?: WorkspaceTreeItem) => {
    const chat = linkedRowChat(item);
    const worktree = chat && (await chatWorktree(chat));
    if (chat && worktree) {
      const resume = harnessRegistry
        .get(chat.harness)
        .buildLaunchCommand({ worktreePath: worktree.path, sessionId: chat.harnessSessionId });
      const command = commandInDirectory(worktree.path, resume);
      await vscode.env.clipboard.writeText(command);
      vscode.window.showInformationMessage(`Copied: ${command}`);
    }
  });

  // Jump to the open session that has waited longest since it finished or
  // asked for something. Visiting it clears its flag, so repeating the
  // command walks through the rest.
  register('pitwall.openNextSessionNeedingYou', async () => {
    for (const chatId of sessionsNeedingYou()) {
      const chat = storageService.getChat(chatId);
      const worktree = chat && harnessRegistry.has(chat.harness) && (await workspacesProvider.getWorktreeByIdAsync(chat.worktreeId));
      if (chat && worktree) {
        await openChatPrimary(chat, worktree);
        activateChat(chat);
        return;
      }
    }
    vscode.window.showInformationMessage('No session is waiting for you.');
  });

  register('pitwall.showStarredSessions', async () => {
    const starredChats = storageService.getStarredChats().filter((chat) => harnessRegistry.has(chat.harness));
    if (starredChats.length === 0) {
      vscode.window.showInformationMessage(
        'No starred sessions. Star a session from the tree view to bookmark it.'
      );
      return;
    }

    const multiHarness = await harnessRegistry.hasMultipleInstalled();
    const worktreeOf = (chat: ChatSession) => workspacesProvider.getWorktreeById(chat.worktreeId);

    // One separator per repository; newest access first within each.
    const groups = new Map<string, { repoName: string; chats: ChatSession[] }>();
    for (const chat of starredChats) {
      const repoId = worktreeOf(chat)?.repoId;
      const group = groups.get(repoId ?? '') ?? {
        repoName: (repoId && storageService.getRepository(repoId)?.name) || 'Unknown',
        chats: [],
      };
      group.chats.push(chat);
      groups.set(repoId ?? '', group);
    }

    const items: (vscode.QuickPickItem & { chatId?: string })[] = [];
    for (const { repoName, chats } of groups.values()) {
      items.push({ label: repoName, kind: vscode.QuickPickItemKind.Separator });
      chats.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
      for (const chat of chats) {
        const worktreeName = worktreeOf(chat)?.name ?? 'unknown';
        const harnessLabel = multiHarness
          ? ` · ${harnessRegistry.get(chat.harness).displayName}`
          : '';
        items.push({
          label: `$(star-full) ${chat.name}`,
          description: `${formatRelativeTime(chat.lastAccessedAt, { absoluteAfterDays: 30 })} · ${worktreeName}${harnessLabel}`,
          chatId: chat.id,
        });
      }
    }

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a starred session to open',
      matchOnDescription: true,
    });
    const chat = selected?.chatId ? storageService.getChat(selected.chatId) : undefined;
    if (!chat || !harnessRegistry.has(chat.harness)) {
      return;
    }
    const worktree = await chatWorktree(chat);
    if (worktree) {
      await openChatPrimary(chat, worktree);
    }
  });

  return { openChatHere };
}

function pendingUiMessage(displayName = 'its VS Code UI'): string {
  return `This session is starting in ${displayName}. Send your first prompt there and Pitwall will link it.`;
}

/** Run an open call, turning a thrown error into a reportable result. */
async function tryOpen(open: () => Promise<NativeUiOpenResult>): Promise<NativeUiOpenResult> {
  try {
    return await open();
  } catch (error) {
    return { kind: 'failed', message: errorMessage(error) };
  }
}

/** Explain a native-UI open that did not happen. */
async function reportNativeUiProblem(
  nativeUi: Pick<NativeUiCapability, 'displayName' | 'extensionId'>,
  worktreePath: string,
  result: Exclude<NativeUiOpenResult, { kind: 'opened' }>
): Promise<void> {
  if (result.kind === 'failed') {
    vscode.window.showErrorMessage(`Could not open the ${nativeUi.displayName}: ${result.message}`);
    return;
  }
  await explainNativeUiUnavailable(nativeUi, worktreePath, result);
}

/**
 * Explain why a native-UI handoff cannot proceed. A worktree mismatch offers
 * to open that worktree in a new window, where it becomes the first folder and
 * the handoff is safe.
 */
async function explainNativeUiUnavailable(
  nativeUi: Pick<NativeUiCapability, 'displayName' | 'extensionId'>,
  worktreePath: string,
  result: NativeUiUnavailable
): Promise<void> {
  const { displayName, extensionId } = nativeUi;
  switch (result.kind) {
    case 'not-installed': {
      const choice = await vscode.window.showInformationMessage(
        `The ${displayName} extension is not installed. Install it to use the ${displayName}.`,
        'Find Extension'
      );
      if (choice === 'Find Extension') {
        // The Extensions view is unavailable in some hosts; the message above
        // still tells the user what to install.
        await Promise.resolve(
          vscode.commands.executeCommand('workbench.extensions.search', `@id:${extensionId}`)
        ).catch(() => undefined);
      }
      return;
    }
    case 'no-workspace':
      vscode.window.showInformationMessage(`Open a folder in VS Code before using ${displayName}.`);
      return;
    case 'workspace-mismatch':
    case 'workspace-multi-root': {
      const message =
        result.kind === 'workspace-mismatch'
          ? `${displayName} runs in the first folder open in VS Code:\n${result.uiCwd}\n\nThis session belongs to:\n${worktreePath}\n\nOpen that worktree in a new window, where ${displayName} can use it.`
          : `${displayName} starts new sessions in the whole VS Code workspace, not one folder.\n\nOpen this worktree as the only folder in a window:\n${worktreePath}`;
      const choice = await vscode.window.showWarningMessage(message, 'Open in New Window');
      if (choice === 'Open in New Window') {
        try {
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), {
            forceNewWindow: true,
          });
        } catch (error) {
          vscode.window.showErrorMessage(
            `Could not open the worktree in a new window: ${errorMessage(error)}`
          );
        }
      }
      return;
    }
  }
}
