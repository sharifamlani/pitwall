import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatSession, Worktree } from './core/types';
import { HarnessSession } from './core/harness/types';
import { StorageService } from './core/services/StorageService';
import { WorktreeCatalog } from './core/services/WorktreeCatalog';
import { GitService } from './core/services/GitService';
import { TerminalManager } from './core/services/TerminalManager';
import { HarnessWatcherRegistry } from './core/harness/HarnessWatcherRegistry';
import { SessionImportService } from './core/services/SessionImportService';
import { createUnlistedLiveHandler } from './core/services/unlistedLive';
import { RepoDiscoveryService } from './core/services/RepoDiscoveryService';
import { NotificationService, openFromPopup } from './core/services/NotificationService';
import { POPUPS_DIR, PopupLedger } from './core/notify/PopupLedger';
import { WindowsToast } from './core/notify/WindowsToast';
import { FirstRunCheck, runAfterRegistration } from './core/notify/FirstRunCheck';
import { notificationState, readersFor } from './core/notify/notificationState';
import { SoundSwitches, registerSoundUi } from './core/notify/SoundSwitches';
import { PopupUriHandler } from './core/notify/PopupUriHandler';
import { SessionAttentionService } from './core/services/SessionAttentionService';
import { SessionSearchService } from './core/services/SessionSearchService';
import * as chatVisibility from './core/services/chatVisibility';
import { disposeOperationLog, logOperation } from './core/services/OperationLog';
import { HarnessRegistry } from './core/harness/HarnessRegistry';
import { enabledHarnesses } from './harnesses';
import { chatNativeSessionIds } from './core/harness/sessionUtils';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from './core/providers/WorkspacesTreeProvider';
import { FilesDragController, FilesTreeProvider, FileTreeItem, clipboardBanner } from './core/providers/FilesTreeProvider';
import { SharedClipboard } from './core/files/SharedClipboard';
import { RepoDropController } from './core/files/RepoDropController';
import { RepoRef } from './core/files/copyInto';
import { SessionSearchTreeProvider } from './core/providers/SessionSearchTreeProvider';
import { registerRepositoryCommands } from './core/commands/repository';
import { registerWorktreeRowCommands } from './core/commands/worktree-rows';
import { ChatCommands, registerChatCommands } from './core/commands/chat';
import { registerSessionImportCommands } from './core/commands/sessionImport';
import { registerFileCommands } from './core/commands/files';
import { registerNavigationCommands } from './core/commands/navigation';
import { registerSearchCommands } from './core/commands/search';
import { SESSION_SEARCH_VIEW, registerSessionSearchCommands } from './core/commands/sessionSearch';
import { commandRegistrar } from './core/commands/common';
import { debounce } from './core/utils/debounce';
import { samePath } from './core/utils/paths';
import { RepoStatusBar } from './core/windows/RepoStatusBar';
import { AttentionStatusBar } from './core/windows/AttentionStatusBar';
import { JumpWalk } from './core/windows/JumpWalk';
import { WindowServices, startWindowRegistry, startWindowServices } from './core/windows/startWindowServices';
import { ChatRouter } from './core/windows/ChatRouter';
import { SIDE_BY_SIDE_MOVE_WAIT_MS, splitSideBySide } from './core/windows/sideBySide';
import { classifyLiveProcess } from './core/windows/outsideProcess';
import { raiseThisWindow } from './core/windows/raiseWindow';
import { cachedParentPid } from './core/utils/parentPid';
import { WindowRegistry, ownsFolder } from './core/windows/WindowRegistry';
import { startTabAdoption } from './core/windows/tabAdoption';

/** Panels re-read the worktree this long after its files stop changing. */
const FILE_CHANGE_DEBOUNCE_MS = 300;
/** Work deferred past the list's first render starts after this long anyway while the list stays hidden. */
export const HIDDEN_LIST_START_MS = 3_000;
/** Startup work after the first render waits at most this long for a handoff's claimed chats to open (I3). */
const CLAIM_FIRST_MAX_MS = 3_000;
/** Every window sweeps old pop-up locks this often, besides once after its first render (Q32). */
const POPUP_SWEEP_MS = 5 * 60_000;

export async function activate(context: vscode.ExtensionContext) {
  // Startup timing (E16): this line and the tree's "first render" bracket
  // activation, in a channel an installed build shows.
  logOperation('[Pitwall] activate');
  const config = () => vscode.workspace.getConfiguration('pitwall');
  const register = commandRegistrar(context);
  const setContext = (key: string, value: unknown) =>
    void vscode.commands.executeCommand('setContext', key, value);

  // Services and harnesses. Only enabled harnesses are built, so the registry
  // holds exactly these ids; storage skips records that name any other.
  const harnessModules = enabledHarnesses();
  const enabledIds = new Set<string>(harnessModules.map((m) => m.id));
  const storageService = new StorageService(context, (id) => enabledIds.has(id));
  const gitService = new GitService();
  const worktreeCatalog = new WorktreeCatalog(storageService, gitService);
  const modules = harnessModules.map((m) => m.create({ storageService, worktreeCatalog }));
  const harnessRegistry = new HarnessRegistry(modules.map((m) => m.adapter));
  /** Every session listing the importer's scans make (tab adoption reads the titles). */
  const sessionsListed = new vscode.EventEmitter<HarnessSession[]>();
  context.subscriptions.push(sessionsListed);
  const harnessWatcherRegistry = new HarnessWatcherRegistry(
    modules.flatMap((m) => (m.watcher ? [m.watcher] : []))
  );
  const terminalManager = new TerminalManager(storageService, harnessRegistry, harnessWatcherRegistry);

  const hasOpenNativeUi = (chat: ChatSession): boolean => {
    if (!harnessRegistry.has(chat.harness)) {
      return false;
    }
    const surfaces = harnessRegistry.get(chat.harness).nativeUi?.surfaces;
    return Boolean(surfaces && chatNativeSessionIds(chat).some((id) => surfaces.isOpen(id)));
  };
  /**
   * The one definition of an open chat: a live terminal or a mapped
   * native-UI tab. The tree, attention tick, and importer all use it.
   */
  const isChatOpen = (chat: ChatSession): boolean => terminalManager.isActive(chat.id) || hasOpenNativeUi(chat);

  const visibilitySources: chatVisibility.ChatVisibilitySources = {
    getChats: () => storageService.getChats(),
    adapters: () => harnessRegistry.all(),
    chatIdForTerminalName: (name) => terminalManager.getChatIdForTerminalName(name),
    isPitwallActivation: (chatId) => terminalManager.isPitwallActivation(chatId),
  };
  /** The chat whose native-UI tab is the active editor tab, if any. */
  const activeNativeUiChatId = (): string | undefined => chatVisibility.activeNativeUiChatId(visibilitySources);

  // Menu gating: a harness entry needs its CLI; a UI entry needs the agent's
  // extension, re-checked when extensions change so no reload is needed.
  void Promise.all(
    harnessRegistry.all().map(async (adapter) => {
      const installed = await harnessRegistry.isInstalled(adapter.id);
      setContext(`pitwall.${adapter.id}Installed`, installed);
      return installed;
    })
  ).then((installed) => setContext('pitwall.anyHarnessInstalled', installed.some(Boolean)));
  const updateNativeUiContexts = (): void => {
    let anyInstalled = false;
    for (const adapter of harnessRegistry.all()) {
      if (adapter.nativeUi) {
        const installed = adapter.nativeUi.isInstalled();
        anyInstalled ||= installed;
        setContext(`pitwall.${adapter.id}UiInstalled`, installed);
      }
    }
    setContext('pitwall.anyNativeUiInstalled', anyInstalled);
  };
  updateNativeUiContexts();
  context.subscriptions.push(vscode.extensions.onDidChange(updateNativeUiContexts));

  // Views
  const workspacesProvider = new WorkspacesTreeProvider(
    storageService,
    gitService,
    terminalManager,
    harnessRegistry,
    context.extensionUri
  );
  workspacesProvider.setChatOpenProvider(isChatOpen);

  // Run `start` once the list has first rendered (E16), in a task of its own
  // so the rows reach the workbench first, or after HIDDEN_LIST_START_MS
  // while the list stays hidden; never after deactivation.
  let deactivated = false;
  const afterFirstRender = (start: () => void): void => {
    let started = false;
    const once = () => {
      if (!started && !deactivated) {
        started = true;
        start();
      }
    };
    void workspacesProvider.whenSettled().then(() => setImmediate(once));
    const fallback = setTimeout(once, HIDDEN_LIST_START_MS);
    context.subscriptions.push({ dispose: () => clearTimeout(fallback) });
  };
  context.subscriptions.push({ dispose: () => (deactivated = true) });

  // A window a handoff started claims it before anything else reads the
  // Claude profile or runs git (I3): the window services start first after
  // the first render, and the heavy startup work waits until the chats the
  // first claim pass took have opened, at most CLAIM_FIRST_MAX_MS. A window
  // with no request passes at once.
  let firstClaimed: () => void = () => undefined;
  let firstOpened: () => void = () => undefined;
  const claimedPass = new Promise<void>((resolve) => (firstClaimed = resolve));
  const openedPass = new Promise<void>((resolve) => (firstOpened = resolve));
  const bounded = (pass: Promise<void>): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLAIM_FIRST_MAX_MS);
      context.subscriptions.push({ dispose: () => clearTimeout(timer) });
      void pass.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  /** Run `start` after the first render (as `afterFirstRender`) and the first claim's opens. */
  const afterClaim = (start: () => void): void =>
    afterFirstRender(() => void bounded(openedPass).then(() => !deactivated && start()));

  // Clicking a chat lands in its folder's window (rows 4.2, 4.6, 4.8). The
  // local open is the chat commands' own, bound once they are registered.
  let windowServices: WindowServices | undefined;
  const earlyRegistry = startWindowRegistry(context);
  let openChatHere: ChatCommands['openChatHere'] = async () => 'failed';
  /** The first harness UI whose tab tracker can open sessions serially and describe its tabs. */
  const tabTracker = () => harnessRegistry.all().find((adapter) => adapter.nativeUi?.surfaces?.openSerially)?.nativeUi?.surfaces;
  /** A panel's parent, asked of the OS once per pid (each Windows query starts PowerShell). */
  const parentPidOf = cachedParentPid();
  /**
   * A live process for a session (Q28): this window's own panel (a child of
   * this extension host) is marked `here`; any other is an outsider. Shared by
   * the router and the session finder's resume.
   */
  const liveProcess = async (sessionId: string) => {
    for (const adapter of harnessRegistry.all()) {
      const live = await adapter.liveProcessOf?.(sessionId);
      if (live) {
        // The start time (else the session) names the process: a pid this window's old panel had may be another window's now.
        return classifyLiveProcess({ ...live, sessionId }, { hostPid: process.pid, parentPidOf });
      }
    }
    return undefined;
  };
  const router = new ChatRouter({
    services: () => windowServices,
    // Claude's own rule: a window's folder is its first workspace folder.
    windowFolder: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    harnessRegistry,
    worktreeOf: (chat) => workspacesProvider.getWorktreeByIdAsync(chat.worktreeId),
    worktreeFor: (chat, folder) => workspacesProvider.worktreeWithoutGit(chat.worktreeId, folder),
    rootsOf: (worktree) => workspacesProvider.rootsOf(worktree),
    repoName: (folder) => workspacesProvider.repoContaining(folder)?.name ?? path.basename(folder),
    isOpenHere: isChatOpen,
    // Asked only for a session with no tab or terminal Pitwall knows of.
    outsideTerminal: liveProcess,
    // This window's own panel with a tab Pitwall never bound (v0.6.0): the agent UI reveals the tab
    // holding the session, never a second process; the title tracker then binds it if its title names one chat.
    revealLive: async (chat, sessionId) => {
      const ui = harnessRegistry.has(chat.harness) ? harnessRegistry.get(chat.harness).nativeUi : undefined;
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ui?.revealOpenSession || !folder) {
        return false;
      }
      const result = await ui.revealOpenSession(sessionId, folder).catch(() => undefined);
      if (result?.kind !== 'opened') {
        return false;
      }
      ui.surfaces?.adopt?.();
      return true;
    },
    openSerially: async (sessionIds, open) => {
      const tracker = tabTracker();
      if (tracker?.openSerially) {
        await tracker.openSerially(sessionIds, open);
      } else {
        for (const sessionId of sessionIds) {
          await open(sessionId);
        }
      }
    },
    sideBySide: async (sessionIds) => {
      await splitSideBySide(sessionIds, {
        reveal: async (sessionId) => {
          const chat = storageService.getChats().find((candidate) => chatNativeSessionIds(candidate).includes(sessionId));
          const worktree = chat && (await workspacesProvider.getWorktreeByIdAsync(chat.worktreeId));
          const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (chat && worktree) {
            await openChatHere(chat, { ...worktree, path: folder ?? worktree.path }, false);
          }
        },
        exec: (command) => Promise.resolve(vscode.commands.executeCommand(command)),
        whenMoved: () => tabTracker()?.whenTabMoved?.(SIDE_BY_SIDE_MOVE_WAIT_MS) ?? Promise.resolve(false),
      });
    },
    chatForSession: (sessionId) =>
      storageService.getChats().find((chat) => harnessRegistry.has(chat.harness) && chatNativeSessionIds(chat).includes(sessionId)),
    openHere: async (chat, worktree, { keepListFocus }) => {
      const opened = await openChatHere(chat, worktree, keepListFocus);
      return opened === 'failed' ? false : opened === 'terminal' ? 'terminal' : true;
    },
    startNew: async (folder) => {
      const worktree = await workspacesProvider.findWorktreeByPathAsync(folder);
      if (!worktree) {
        return false;
      }
      await vscode.commands.executeCommand(
        'pitwall.newClaudeChat',
        new WorkspaceTreeItem(worktree.name, vscode.TreeItemCollapsibleState.None, 'worktree', worktree, 'worktree')
      );
      return true;
    },
  });
  context.subscriptions.push(router);

  /**
   * Publish this window's open chats to the registry on every change (a
   * terminal or a Claude tab opening or closing), and show every window's on
   * the rows (` · open`, ` · {k} windows`, the menu flip), refreshed at most
   * every 500 ms.
   */
  const publishWindows = (registry: WindowRegistry): void => {
    const openSessionIds = (): string[] =>
      storageService.getChats().flatMap((chat) => {
        if (!harnessRegistry.has(chat.harness)) {
          return [];
        }
        const ids = chatNativeSessionIds(chat);
        if (terminalManager.isActive(chat.id)) {
          return ids.slice(0, 1);
        }
        const surfaces = harnessRegistry.get(chat.harness).nativeUi?.surfaces;
        return surfaces ? ids.filter((id) => surfaces.isOpen(id)) : [];
      });
    // The chat in front and window focus ride along (Q33): no other window pops a chat in front of a focused window here.
    const beat = debounce(
      () =>
        void registry
          .beat({ openSessionIds: openSessionIds(), front: chatVisibility.frontSessionId(visibilitySources), focused: vscode.window.state.focused })
          .catch(() => undefined),
      50
    );
    const showWindows = debounce(() => void registry.windows().then((windows) => workspacesProvider.setWindows(windows)), 500);
    context.subscriptions.push(
      terminalManager.onTerminalStateChange(() => beat()),
      ...harnessRegistry.all().flatMap((adapter) => (adapter.nativeUi?.surfaces ? [adapter.nativeUi.surfaces.onDidChange(() => beat())] : [])),
      ...chatVisibility.onFrontMayChange(() => beat()),
      registry.onDidChange(() => showWindows()),
      { dispose: () => (beat.cancel(), showWindows.cancel()) }
    );
    beat();
  };

  // The window registry and handoff inbox (ADR 0020); nothing awaits them.
  // This window's registry entry was written at activation, so a sender
  // that raised it sees it before its 45 s retry (I2, live E6).
  // Requests this window claims open through the router (T3). First of the
  // work after the first render (I3).
  afterFirstRender(() => {
    windowServices = startWindowServices(context, logOperation, (requests, inbox) => router.runClaimed(requests, inbox), earlyRegistry);
    if (windowServices) {
      publishWindows(windowServices.registry);
      void windowServices.claimed.then(firstClaimed);
      void windowServices.opened.then(firstOpened);
    } else {
      firstClaimed();
      firstOpened();
    }
  });

  // The session watchers arm a file watcher per project folder, which costs
  // the extension host most of a reload's activation on Windows; a chat that
  // links meanwhile is caught by their first check.
  afterClaim(() => harnessWatcherRegistry.startAll());

  // Adopt the Claude tabs this window has that Pitwall did not open (I1):
  // restored after a reload or a relaunch, or reopened by the editor's own
  // session restore. The title source is installed now, so an open waits
  // for it (at most 1 s); the folder's listing runs once the first claim
  // pass is done.
  afterFirstRender(() => {
    context.subscriptions.push(
      startTabAdoption({
        folder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        adapters: harnessRegistry.all(),
        chats: () => storageService.getChats(),
        worktreePathOf: (chat) => workspacesProvider.getWorktreeById(chat.worktreeId)?.path,
        onSessionsListed: sessionsListed.event,
        listAfter: bounded(claimedPass),
      })
    );
  });

  // Bottom bar: this window's `repo · ⎇ branch` (row 4.5).
  afterClaim(() => {
    const bar = new RepoStatusBar(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, gitService);
    context.subscriptions.push(bar);
    void bar.refresh();
  });

  // Reconcile terminals that survived a reload or a quit (ADR 0009), in the
  // background: activation never waits for a PID. A click on a chat whose
  // surviving tab is still waiting for its PID waits for that adoption in
  // openChat instead, so it cannot start a second agent.
  // A revived tab's worktree may be one git has not listed yet (a first
  // start): the lookup waits for it, taking its turn behind the list's.
  const restore = terminalManager.beginRestoreSync((id) => workspacesProvider.getWorktreeByIdAsync(id, { urgent: false }));
  void restore.complete.catch((error) => console.error('Pitwall: restoring terminals failed', error));

  const filesProvider = new FilesTreeProvider();
  /** The sidebar repo holding a path, for FILES messages and drops. */
  const repoOf = (filePath: string): RepoRef | undefined => {
    const repo = workspacesProvider.repoContaining(filePath);
    return repo && { name: repo.name, rootPath: repo.rootPath };
  };
  const workspacesTreeView = vscode.window.createTreeView('pitwall.workspacesView', {
    treeDataProvider: workspacesProvider,
    showCollapseAll: true,
    // Session rows can be removed, closed, and starred several at a time.
    canSelectMany: true,
    // A FILES row dropped on a repo row is copied into that repo (row 4.7).
    // The controller can only be given here, at creation.
    dragAndDropController: new RepoDropController(repoOf, (filePath) => workspacesProvider.deepestRootContaining(filePath)?.path),
  });
  const filesTreeView = vscode.window.createTreeView('pitwall.filesView', {
    treeDataProvider: filesProvider,
    showCollapseAll: true,
    dragAndDropController: new FilesDragController(),
  });
  context.subscriptions.push(workspacesTreeView, filesTreeView);
  // The header description and the needs-you badge.
  workspacesProvider.bindView(workspacesTreeView);
  // A collapsed repo's session rows are never fetched on a refresh, so reveals must not wait for them.
  context.subscriptions.push(workspacesTreeView.onDidCollapseElement(({ element }) => workspacesProvider.onRowCollapsed(element)));
  const refreshTree = () => workspacesProvider.refresh();

  // The worktree the user last picked in the list: a new session with no row
  // starts there. FILES no longer follows it; it shows this window's folder (Q8).
  let shownWorktree: Worktree | undefined;
  const showWorktree = (worktree: Worktree | undefined): void => {
    shownWorktree = worktree;
  };

  // FILES: always this window's folder (Q8, `workspaceFolders[0]`), with one
  // watcher on its files that refreshes it. An empty window shows no rows.
  const windowFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let filesWatcher: vscode.FileSystemWatcher | undefined;
  const refreshPanels = debounce(() => {
    filesProvider.refresh();
  }, FILE_CHANGE_DEBOUNCE_MS);
  /** The clipboard banner (§3e) while anything is on the clipboard. */
  let clipboardLine: string | undefined;
  // The FILES header: "{repo} ⎇ {branch}" (no branch for a plain folder),
  // and the folder path, or the clipboard banner while the clipboard holds a
  // file. A view has no header tooltip, so the path is the view's message line.
  const updateFilesHeader = (): void => {
    const worktree = filesProvider.getActiveWorktree();
    const owner = worktree && workspacesProvider.repositoryFor(worktree);
    filesTreeView.description = !worktree
      ? undefined
      : owner?.isGit
        ? `${owner.repo.name} ⎇ ${worktree.branch ?? worktree.name}`
        : owner?.repo.name ?? worktree.name;
    filesTreeView.message = worktree ? clipboardLine ?? worktree.path : undefined;
  };
  /** Show the window folder as the list knows it; before the list does, as a plain folder. */
  const showWindowFolder = (): void => {
    if (!windowFolder) {
      return;
    }
    const listed = workspacesProvider.findWorktreeByPath(windowFolder);
    const next: Worktree = listed ?? {
      id: `folder:${windowFolder}`,
      repoId: '',
      name: path.basename(windowFolder),
      path: windowFolder,
      isMain: true,
    };
    const shown = filesProvider.getActiveWorktree();
    if (!shown || shown.id !== next.id || shown.branch !== next.branch || shown.name !== next.name) {
      filesProvider.setActiveWorktree(next);
    }
    updateFilesHeader();
  };
  if (windowFolder) {
    filesWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(windowFolder, '**/*'));
    filesWatcher.onDidChange(refreshPanels);
    filesWatcher.onDidCreate(refreshPanels);
    filesWatcher.onDidDelete(refreshPanels);
    showWindowFolder();
    // A relisting can name the folder's repo or a new branch: the header follows.
    context.subscriptions.push(workspacesProvider.onDidChangeTreeData(() => showWindowFolder()));
  }

  // One FILES clipboard for every window (Q9), in global storage.
  const clipboard = new SharedClipboard(context.globalStorageUri?.fsPath);
  const updateClipboardLine = async (): Promise<void> => {
    // A source deleted since it was copied clears the clipboard, so no stale banner.
    const entry = await clipboard.live();
    clipboardLine = entry
      ? clipboardBanner(path.basename(entry.path), repoOf(entry.path)?.name ?? path.basename(path.dirname(entry.path)))
      : undefined;
    setContext('pitwall.hasFileClipboard', entry !== undefined);
    updateFilesHeader();
  };
  context.subscriptions.push(clipboard, clipboard.onDidChange(() => void updateClipboardLine()));
  // Another window's copy shows here once the list has first rendered (E16).
  afterFirstRender(() => {
    context.subscriptions.push(clipboard.watch());
    void updateClipboardLine();
  });

  /** Close chats' terminals and delete their rows; a removed selection is cleared. */
  const removeChats = (chatIds: string[], options?: { rememberSession?: boolean; closeTerminals?: boolean }): string[] => {
    if (options?.closeTerminals !== false) {
      chatIds.forEach((id) => terminalManager.closeChat(id));
    }
    const removed = storageService.deleteChats(chatIds, { rememberSession: options?.rememberSession });
    const activeId = storageService.getActiveChatId();
    if (activeId && removed.includes(activeId)) {
      storageService.setActiveChatId(undefined);
      showWorktree(undefined);
    }
    return removed;
  };

  /**
   * Forget worktrees that are gone from Pitwall. Their chats are removed
   * without tombstones, so the sessions can be imported again later.
   */
  const forgetWorktrees = (worktrees: Worktree[], options?: { closeTerminals?: boolean }): void => {
    const ids = new Set(worktrees.map((worktree) => worktree.id));
    removeChats(
      storageService.getChats().filter((chat) => ids.has(chat.worktreeId)).map((chat) => chat.id),
      { rememberSession: false, closeTerminals: options?.closeTerminals }
    );
    if (shownWorktree && ids.has(shownWorktree.id)) {
      showWorktree(undefined);
    }
  };

  const switchWorkspaceFolder = (folderPath: string): void => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders[0] || !samePath(folders[0].uri.fsPath, folderPath)) {
      vscode.workspace.updateWorkspaceFolders(0, folders.length, { uri: vscode.Uri.file(folderPath) });
    }
  };

  /** Set once the attention service exists; visiting a chat clears its needs-you flag. */
  let markChatSeen: (chatId: string) => void = () => undefined;

  /** Select a chat's row and point the panels at its worktree. */
  const activateChat = (chat: ChatSession, options: { revealIfHidden?: boolean } = { revealIfHidden: true }) => {
    markChatSeen(chat.id);
    if (storageService.getActiveChatId() !== chat.id) {
      storageService.setActiveChatId(chat.id);
    }
    const worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
    if (worktree) {
      showWorktree(worktree);
    }
    if (options.revealIfHidden || workspacesTreeView.visible) {
      // Only the latest chat is revealed: a burst of focus changes would
      // otherwise queue one reveal each.
      const ticket = ++latestReveal;
      const reveal = () =>
        workspacesProvider.revealWhenSettled(() =>
          ticket === latestReveal
            ? workspacesTreeView.reveal(workspacesProvider.getChatTreeItem(chat), { select: true, focus: false, expand: true })
            : Promise.resolve()
        );
      deferredReveal?.dispose();
      deferredReveal = undefined;
      if (workspacesTreeView.visible) {
        void reveal();
      } else {
        // A hidden view has no rows yet, so revealing one now names a row that
        // does not exist. Reveal the latest chat once the view shows and its
        // rows have rendered, like the start worktree below.
        deferredReveal = workspacesTreeView.onDidChangeVisibility((event) => {
          if (event.visible) {
            deferredReveal?.dispose();
            deferredReveal = undefined;
            void reveal();
          }
        });
      }
    }
  };
  /** The newest chat reveal; an older one still waiting is dropped. */
  let latestReveal = 0;
  /** The one reveal waiting for the hidden Workspaces view to show. */
  let deferredReveal: vscode.Disposable | undefined;
  context.subscriptions.push({ dispose: () => deferredReveal?.dispose() });

  /** Set once the attention service exists; the scan's turn states feed closed chats' rows. */
  let noteSessions: (sessions: HarnessSession[]) => void = () => undefined;

  // Native sessions started outside an exact-ID launch: a UI launch, or a
  // session started outside Pitwall. Also ages out quiet auto-imports.
  const sessionImporter = new SessionImportService(storageService, worktreeCatalog, harnessRegistry, {
    onSessionsListed: (sessions) => {
      noteSessions(sessions);
      sessionsListed.fire(sessions);
    },
    // Retention must also keep a chat whose terminal is still resuming.
    isChatOpen: (chat) => isChatOpen(chat) || terminalManager.isResuming(chat.id),
    isVisible: () => workspacesTreeView.visible,
    log: logOperation,
    onChatsChanged: (event) => {
      workspacesProvider.softRefresh();
      const activeId = storageService.getActiveChatId();
      if (activeId && event.removed.includes(activeId)) {
        storageService.setActiveChatId(undefined);
        showWorktree(undefined);
      }
    },
  });
  context.subscriptions.push(sessionImporter);
  // The first scan starts after the list's first render (E16), or after
  // HIDDEN_LIST_START_MS while the list stays hidden (a window whose Pitwall
  // view is never shown still tracks status and pops up), and the first
  // claim's opens (I3); never after deactivation.
  const afterSettledClaim = new Promise<void>((resolve) => afterClaim(resolve));
  sessionImporter.start(afterSettledClaim);
  /** The importer's and discovery's first passes have started; before that, a refresh would only run early. */
  let scansStarted = false;
  /** A live session no row holds was asked about before the first passes started; they run it once they do. */
  let unlistedBeforeScans = false;
  // The answer to "a live session no row holds", once its turn has started (Q31, new-chat pickup):
  // see createUnlistedLiveHandler. The attention service is made below; it is only called later.
  const unlistedLive = createUnlistedLiveHandler({
    scansStarted: () => scansStarted,
    deferUntilScans: () => (unlistedBeforeScans = true),
    importLive: (sessionIds) => sessionImporter.importLive(sessionIds),
    wakeDiscovery: () => repoDiscovery.wake(),
    fullRefresh: () => sessionImporter.refresh(),
    pollAttention: () => void attentionService.poll(),
    stillUnlisted: (sessionId) => attentionService.isUnlistedLive(sessionId),
  });

  // Repos found from the agents' sessions (ADR 0019), after the list first
  // renders; activation never waits for a pass.
  const repoDiscovery = new RepoDiscoveryService(storageService, gitService, () => harnessRegistry.all(), {
    // Until the first pass ends, the empty list says it is scanning, not "No repositories yet".
    onFirstPassDone: () => setContext('pitwall.scanned', true),
    log: logOperation,
    onAdded: () => {
      worktreeCatalog.invalidate();
      refreshTree();
      sessionImporter.wake();
      // A live session in a folder no repo held lists now, list hidden or not.
      void unlistedLive.onReposAdded().catch((error) => console.error('[Pitwall] Could not list live sessions of new repos:', error));
    },
  });
  context.subscriptions.push(repoDiscovery);
  repoDiscovery.start(afterSettledClaim);
  // After the passes' own starts, so the asked-for discovery pass is not
  // dropped before discovery has started. The attention service asks about a
  // session once per window, so an ask that came before this would be lost:
  // a hidden list's first import pass skips a full scan, and a handoff's
  // claim can hold the passes for CLAIM_FIRST_MAX_MS past the first ticks.
  void afterSettledClaim.then(() => {
    scansStarted = true;
    if (unlistedBeforeScans) {
      unlistedBeforeScans = false;
      repoDiscovery.wake();
      sessionImporter.refresh();
    }
  });

  /** Whether the chat's terminal or native-UI tab is the one in front of the user. */
  const isChatVisible = (chatId: string): boolean => chatVisibility.isChatVisible(visibilitySources, chatId);
  // One lock per transition in the shared global storage: exactly one window pops it (Q32).
  const popupLedger = context.globalStorageUri
    ? new PopupLedger(path.join(context.globalStorageUri.fsPath, POPUPS_DIR), Date.now, logOperation)
    : undefined;
  // On Windows the pop-up shows under Pitwall's own sender (row 5.2, Q46 = A); the in-window message is its fallback (Q35).
  // Only in a real run: a test host (ExtensionMode.Test, or a dry test's context) never writes the registry.
  const realRun = context.extensionMode === vscode.ExtensionMode.Production || context.extensionMode === vscode.ExtensionMode.Development;
  const windowsToast =
    process.platform === 'win32' && realRun ? new WindowsToast(undefined, process.platform, { log: logOperation }) : undefined;
  // The pop-up sender's registration (set after the first render); the notifications check waits for it (Q42).
  let registration: Promise<'ok' | 'failed'> = Promise.resolve('failed');
  // First-run check: Windows only, once per profile (Q42). Read-only; "Pitwall: Check Windows Notifications" re-runs it.
  const notifyCheck =
    windowsToast && context.globalStorageUri
      ? new FirstRunCheck(
          context.globalState,
          context.globalStorageUri.fsPath,
          () => notificationState(readersFor(windowsToast, registration)),
          { log: logOperation }
        )
      : undefined;
  // Off by default (Q41); the bell and Settings → Pitwall → Sound flip them.
  const soundSwitches = new SoundSwitches();
  context.subscriptions.push(soundSwitches);
  const notificationService = new NotificationService(
    // The message's Open goes through the router like every other open (D35, Q35).
    (chatId) => {
      const chat = storageService.getChat(chatId);
      if (chat) {
        void openFromPopup(chat, {
          route: (request) => router.route(request),
          activateLocal: (entry) => activateChat(entry, { revealIfHidden: false }),
        }).catch((error) => console.error('[Pitwall] Could not open the chat from its notification:', error));
      }
    },
    isChatVisible,
    {
      ledger: popupLedger,
      frontAnywhere: (sessionId) => (windowServices?.registry ?? earlyRegistry)?.frontAnywhere(sessionId) ?? false,
      isListed: (chatId) => storageService.getChat(chatId) !== undefined,
      // A brand-new chat's tab, in front before it binds, is in front: only the one new chat with no
      // open surface that started after the tab opened (PR #73, QA round 2).
      unboundFront: (chat) =>
        chatVisibility.unboundTabMayBeChat(chat, {
          adapters: () => harnessRegistry.all(),
          chats: () => storageService.getChats(),
          worktreePathOf: (entry) => workspacesProvider.getWorktreeById(entry.worktreeId)?.path,
          folders: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
          isOpenAnywhere: (entry) => workspacesProvider.isOpenAnywhere(entry),
        }),
      log: logOperation,
      toast: windowsToast,
      sound: (kind) => soundSwitches.get(kind),
    }
  );
  // The Repos-header bell, its quick pick and Test sound (row 5.3).
  context.subscriptions.push(...registerSoundUi(soundSwitches, () => notificationService.testSound()));
  // A pop-up click: `<uriScheme>://sharifamlani.pitwall/open?session=<uuid>` (Q37), through the router (D35).
  // Registering is synchronous and reads nothing; a click before the window services start waits in the router.
  context.subscriptions.push(
    vscode.window.registerUriHandler(
      new PopupUriHandler({
        chatForSession: (sessionId) =>
          storageService.getChats().find((chat) => harnessRegistry.has(chat.harness) && chatNativeSessionIds(chat).includes(sessionId)),
        route: (request) => router.route(request),
        activateLocal: (chat) => activateChat(chat, { revealIfHidden: false }),
        log: logOperation,
        // The window that handled the click comes forward, as a handoff raises its target (v0.6.0).
        raiseWindow: () => raiseThisWindow(),
      })
    ),
    vscode.commands.registerCommand('pitwall.checkWindowsNotifications', async () => {
      if (!notifyCheck) {
        void vscode.window.showInformationMessage('Pitwall checks Windows notifications only on Windows.');
        return;
      }
      await notifyCheck.run({ force: true });
    }),
    vscode.commands.registerCommand('pitwall.removePopupRegistration', async () => {
      if (!windowsToast) {
        void vscode.window.showInformationMessage('Pitwall registers a pop-up sender only on Windows.');
        return;
      }
      await windowsToast.unregisterAumid();
      void vscode.window.showInformationMessage(
        "Removed Pitwall's pop-up registration. Pop-ups show inside the window until Pitwall starts again."
      );
    })
  );
  const attentionService = new SessionAttentionService(
    storageService,
    harnessRegistry,
    notificationService,
    (worktreeId) => workspacesProvider.getWorktreeById(worktreeId),
    // Turn and needs-you changes swap the row mark (beating mark, orange or green dot).
    () => workspacesProvider.softRefresh(),
    isChatOpen,
    isChatVisible,
    {
      log: logOperation,
      // A live session no row holds yet, once its turn has started (Q31): imported from its own
      // transcript, list hidden or not (new-chat pickup, 12f645db); see createUnlistedLiveHandler.
      onUnlistedLive: (sessionIds) => unlistedLive.ask(sessionIds),
    }
  );
  markChatSeen = (chatId) => attentionService.markSeen(chatId);
  noteSessions = (sessions) => attentionService.noteSessions(sessions);
  attentionService.start();
  // After the first render (E16): re-poll within 150 ms of a sessions-file
  // change, register the Windows pop-up sender, and sweep pop-up locks older
  // than 10 min now and every 5 min.
  afterFirstRender(() => {
    context.subscriptions.push(attentionService.watchLive());
    // The pop-up sender, once per activation and idempotent; the first pop-up waits behind it (Q46 = A).
    if (windowsToast) {
      registration = windowsToast.registerAumid(vscode.Uri.joinPath(context.extensionUri, 'resources', 'icons', 'pitwall.png').fsPath);
      // The first-run check reads Pitwall's own switch, which Windows knows only once the sender is registered (Q42).
      if (notifyCheck) {
        void runAfterRegistration(registration, notifyCheck, logOperation).catch(() => undefined);
      }
    }
    if (popupLedger) {
      const sweep = () => void popupLedger.sweep().catch(() => undefined);
      sweep();
      const timer = setInterval(sweep, POPUP_SWEEP_MS);
      timer.unref?.();
      context.subscriptions.push({ dispose: () => clearInterval(timer) });
    }
  });
  // The jump walk behind Next ▸ and the bottom-bar counts (row 5.4, Q38, Q40). The walk file is shared by
  // every window; this window re-reads it every 2 s so a jump made in another one shows Next ▸ here too.
  const jumpWalk = new JumpWalk(context.globalStorageUri?.fsPath ?? path.join(os.tmpdir(), 'pitwall-jump'));
  /** The needs-you chats this window's Next ▸ may open: all but the one in front here (QA C3). */
  const jumpable = () => attentionService.sessionsNeedingYou().filter((chatId) => !isChatVisible(chatId));
  afterFirstRender(() => {
    const bar = new AttentionStatusBar(
      { counts: () => attentionService.counts(), onDidChange: attentionService.onDidChangeStatus, order: jumpable },
      jumpWalk
    );
    const timer = setInterval(() => void jumpWalk.poll().catch(() => undefined), 2_000);
    timer.unref?.();
    context.subscriptions.push(bar, { dispose: () => clearInterval(timer) });
    bar.refresh();
  });
  // Records what the user looks at between ticks, for needs-you toasts; never polls.
  context.subscriptions.push(...chatVisibility.onFrontMayChange(() => attentionService.noteFront()));
  // Every row's status and the re-sorts it triggers (rows 3.3, 3.4).
  workspacesProvider.setStatusSource(attentionService);

  // Commands
  registerRepositoryCommands(context, {
    storageService,
    gitService,
    harnessRegistry,
    forgetWorktrees,
    refreshTree,
    router: () => router,
    mainChats: (repo) => workspacesProvider.mainChatsOf(repo),
    windowFolder: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    isChatOpen,
    // The repo's main-folder chats open in its window: this window's own, or what the registry's heartbeat lists.
    openChatsOf: async (repo) => {
      const here = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const ours = Boolean(here && samePath(here, repo.rootPath));
      const registered = new Set(
        ((await windowServices?.registry.windowsFor(repo.rootPath).catch(() => [])) ?? []).flatMap((window) => window.openSessionIds)
      );
      return workspacesProvider
        .mainChatsOf(repo)
        .filter((chat) => (ours && isChatOpen(chat)) || chatNativeSessionIds(chat).some((id) => registered.has(id)));
    },
    dump: {
      dir: path.join(context.globalStorageUri?.fsPath ?? os.tmpdir(), 'pitwall-dump'),
      pid: process.pid,
      tabs: () => tabTracker()?.describeTabs?.() ?? [],
      windowFolder: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      statuses: () => attentionService.statuses(),
      counts: () => attentionService.counts(),
    },
    traceTabs: () => tabTracker()?.toggleTrace?.() ?? false,
  });
  registerWorktreeRowCommands(context, { workspacesProvider, switchWorkspaceFolder });
  ({ openChatHere } = registerChatCommands(context, {
    storageService,
    gitService,
    terminalManager,
    workspacesProvider,
    harnessRegistry,
    harnessWatcherRegistry,
    sessionImporter,
    sessionsNeedingYou: () => attentionService.sessionsNeedingYou(),
    statusList: (status) => attentionService.chatsWithStatus(status),
    waitingFor: (chatId) => attentionService.waitingForOf(chatId),
    inFront: isChatVisible,
    jumpWalk,
    // The folder this window owns, as the router counts it: none in a multi-root or workspace-file window.
    windowFolder: ownsFolder,
    log: logOperation,
    selectedRows: () => workspacesTreeView.selection,
    activeWorktree: () => shownWorktree,
    activateChat,
    showWorktree,
    removeChats,
    refreshTree,
    router: () => router,
  }));
  registerSessionImportCommands(context, storageService, gitService, worktreeCatalog, workspacesProvider, harnessRegistry, refreshTree);
  registerFileCommands(
    context,
    filesProvider,
    () => {
      const [row] = filesTreeView.selection;
      return row instanceof FileTreeItem ? row : undefined;
    },
    {
      clipboard,
      repos: () => storageService.getRepositories().map((repo) => ({ name: repo.name, rootPath: repo.rootPath })),
      repoOf,
    }
  );

  registerNavigationCommands(context, { workspacesProvider, workspacesTreeView, filesTreeView });
  registerSearchCommands(context, {
    workspacesProvider,
    opensHere: (chat) => router.opensHere(chat, workspacesProvider.getWorktreeById(chat.worktreeId)),
  });

  // Each search runs in a short temp folder of its own, so its leftovers
  // never mix with a real project's sessions.
  const sessionSearch = new SessionSearchService(storageService, harnessRegistry, os.tmpdir());
  const sessionSearchProvider = new SessionSearchTreeProvider(sessionSearch, harnessRegistry, context.extensionUri);
  const sessionSearchTreeView = vscode.window.createTreeView(SESSION_SEARCH_VIEW, {
    treeDataProvider: sessionSearchProvider,
  });
  context.subscriptions.push(sessionSearch, sessionSearchProvider, sessionSearchTreeView);
  registerSessionSearchCommands(context, {
    sessionSearch,
    storageService,
    harnessRegistry,
    worktreeCatalog,
    workspacesProvider,
    activateChat,
    refreshTree,
    isViewVisible: () => sessionSearchTreeView.visible,
    liveProcess,
  });
  // The Keyboard Shortcuts editor, filtered to this extension's commands.
  register('pitwall.openKeybindings', () =>
    vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', `@ext:${context.extension.id}`)
  );
  // The Settings editor, filtered to this extension's sections.
  register('pitwall.openSettings', () =>
    vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`)
  );
  for (const [name, setting, label] of [
    ['AutoSwitch', 'autoSwitchWorkspaceFolder', 'Auto-switch workspace folder'],
    ['FocusOnStartup', 'focusOnStartup', 'Focus on startup'],
  ]) {
    for (const enabled of [true, false]) {
      register(`pitwall.${enabled ? 'enable' : 'disable'}${name}`, async () => {
        await config().update(setting, enabled, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`${label} ${enabled ? 'enabled' : 'disabled'}`);
      });
    }
  }

  // Follow focus: a terminal, an editor terminal tab, or a native-UI tab
  // selects its chat. Switching back from a Claude tab to an editor terminal
  // may not change `activeTerminal`, so the tab title is the fallback.
  const activateActiveEditorChat = (): void => {
    const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (!activeTab) {
      return;
    }
    let chatId: string | undefined;
    if (activeTab.input instanceof vscode.TabInputTerminal) {
      const terminal = vscode.window.activeTerminal;
      chatId =
        (terminal && terminalManager.getChatIdForTerminal(terminal)) ??
        terminalManager.getChatIdForTerminalName(activeTab.label);
    } else {
      chatId = activeNativeUiChatId();
    }
    // A tab Pitwall put in front to rename it is not the user visiting it (R44).
    if (chatId && terminalManager.isPitwallActivation(chatId)) {
      return;
    }
    const chat = chatId ? storageService.getChat(chatId) : undefined;
    if (chat) {
      activateChat(chat);
    }
  };
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(activateActiveEditorChat),
    vscode.window.tabGroups.onDidChangeTabGroups(activateActiveEditorChat),
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      // The retitle pass activates restored tabs to rename them; that is not
      // a user focus change and must not move the selection.
      if (!terminal || terminalManager.consumeBackgroundActivation(terminal)) {
        return;
      }
      const chatId = terminalManager.getChatIdForTerminal(terminal);
      if (chatId && terminalManager.isPitwallActivation(chatId)) {
        return;
      }
      const chat = chatId ? storageService.getChat(chatId) : undefined;
      if (chat) {
        activateChat(chat);
      }
    }),
    harnessWatcherRegistry.onChatNameUpdated(() => workspacesProvider.softRefresh()),
    // The importer pauses its discovery pass while the view is hidden.
    workspacesTreeView.onDidChangeVisibility((event) => {
      if (event.visible) {
        sessionImporter.wake();
      }
    }),
    workspacesTreeView.onDidChangeSelection(({ selection: [selected, ...others] }) => {
      // Selecting several rows prepares a bulk action; it is not a visit.
      if (!selected || others.length > 0) {
        return;
      }
      let worktree: Worktree | undefined;
      if (selected.itemType === 'chat') {
        const chat = selected.data as ChatSession;
        markChatSeen(chat.id);
        storageService.setActiveChatId(chat.id);
        worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
      } else {
        // A repo row points FILES at its main worktree (a plain folder's
        // own folder).
        worktree = workspacesProvider.getWorktreeForItem(selected);
      }
      if (!worktree) {
        return;
      }
      showWorktree(worktree);
      // Switching the folder restarts the extension host; activation then
      // restores this worktree from the new first folder.
      if (config().get<boolean>('autoSwitchWorkspaceFolder', false)) {
        switchWorkspaceFolder(worktree.path);
      }
    })
  );
  for (const adapter of harnessRegistry.all()) {
    const surfaces = adapter.nativeUi?.surfaces;
    if (surfaces) {
      context.subscriptions.push(surfaces.onDidChange(() => workspacesProvider.softRefresh()));
    }
  }

  // Start on the worktree that matches the open workspace folder, which may
  // be a linked worktree git has not listed yet. Reveal is best-effort: the
  // row may not have rendered yet.
  const folderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const showStartWorktree = (startWorktree: Worktree | undefined) => {
    if (!startWorktree) {
      return;
    }
    showWorktree(startWorktree);
    const reveal = () =>
      setTimeout(() => {
        void workspacesProvider.revealWhenSettled(() =>
          workspacesTreeView.reveal(workspacesProvider.getTreeItemForWorktree(startWorktree), {
            select: true,
            focus: false,
            expand: true,
          })
        );
      }, 100);
    if (workspacesTreeView.visible) {
      reveal();
    } else {
      const once = workspacesTreeView.onDidChangeVisibility((event) => {
        if (event.visible) {
          once.dispose();
          reveal();
        }
      });
      context.subscriptions.push(once);
    }
  };
  if (folderPath) {
    const known = workspacesProvider.findWorktreeByPath(folderPath);
    if (known) {
      showStartWorktree(known);
    } else {
      // Not known until git lists it; a selection made meanwhile wins.
      void workspacesProvider
        .findWorktreeByPathAsync(folderPath, { urgent: false })
        .then((listed) => (shownWorktree ? undefined : showStartWorktree(listed)));
    }
  }

  context.subscriptions.push({
    dispose: () => {
      refreshPanels.cancel();
      filesWatcher?.dispose();
      attentionService.dispose();
      terminalManager.dispose();
      filesProvider.dispose();
      workspacesProvider.dispose();
      harnessWatcherRegistry.dispose();
      harnessRegistry.dispose();
    },
  });

  if (config().get<boolean>('focusOnStartup', false)) {
    void vscode.commands.executeCommand('workbench.view.extension.pitwall');
  }
}

export function deactivate() {
  disposeOperationLog();
}
