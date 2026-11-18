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
import { RepoDiscoveryService } from './core/services/RepoDiscoveryService';
import { NotificationService } from './core/services/NotificationService';
import { SessionAttentionService } from './core/services/SessionAttentionService';
import { SessionSearchService } from './core/services/SessionSearchService';
import * as chatVisibility from './core/services/chatVisibility';
import { disposeOperationLog, logOperation } from './core/services/OperationLog';
import { HarnessRegistry } from './core/harness/HarnessRegistry';
import { enabledHarnesses } from './harnesses';
import { chatNativeSessionIds } from './core/harness/sessionUtils';
import { WorkspacesTreeProvider } from './core/providers/WorkspacesTreeProvider';
import { FilesDragController, FilesTreeProvider, FileTreeItem, clipboardBanner } from './core/providers/FilesTreeProvider';
import { SharedClipboard } from './core/files/SharedClipboard';
import { RepoDropController } from './core/files/RepoDropController';
import { RepoRef } from './core/files/copyInto';
import { SessionSearchTreeProvider } from './core/providers/SessionSearchTreeProvider';
import { registerRepositoryCommands } from './core/commands/repository';
import { registerWorktreeRowCommands } from './core/commands/worktree-rows';
import { registerChatCommands } from './core/commands/chat';
import { registerSessionImportCommands } from './core/commands/sessionImport';
import { registerFileCommands } from './core/commands/files';
import { registerNavigationCommands } from './core/commands/navigation';
import { registerSearchCommands } from './core/commands/search';
import { SESSION_SEARCH_VIEW, registerSessionSearchCommands } from './core/commands/sessionSearch';
import { commandRegistrar } from './core/commands/common';
import { debounce } from './core/utils/debounce';
import { samePath } from './core/utils/paths';
import { RepoStatusBar } from './core/windows/RepoStatusBar';
import { startWindowServices } from './core/windows/startWindowServices';

/** Panels re-read the worktree this long after its files stop changing. */
const FILE_CHANGE_DEBOUNCE_MS = 300;
/** Work deferred past the list's first render starts after this long anyway while the list stays hidden. */
const HIDDEN_LIST_START_MS = 3_000;

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

  // The session watchers arm a file watcher per project folder, which costs
  // the extension host most of a reload's activation on Windows; a chat that
  // links meanwhile is caught by their first check.
  afterFirstRender(() => harnessWatcherRegistry.startAll());
  // The window registry and handoff inbox (ADR 0020); nothing awaits them.
  afterFirstRender(() => startWindowServices(context, logOperation));

  // Bottom bar: this window's `repo · ⎇ branch` (row 4.5).
  afterFirstRender(() => {
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
    const entry = await clipboard.get();
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
    onSessionsListed: (sessions) => noteSessions(sessions),
    // Retention must also keep a chat whose terminal is still resuming.
    isChatOpen: (chat) => isChatOpen(chat) || terminalManager.isResuming(chat.id),
    isVisible: () => workspacesTreeView.visible,
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
  // The first scan starts after the list's first render (E16).
  sessionImporter.start(workspacesProvider.whenSettled());

  // Repos found from the agents' sessions (ADR 0019), after the list first
  // renders; activation never waits for a pass.
  const repoDiscovery = new RepoDiscoveryService(storageService, gitService, () => harnessRegistry.all(), {
    // Until the first pass ends, the empty list says it is scanning, not "No repositories yet".
    onFirstPassDone: () => setContext('pitwall.scanned', true),
    onAdded: () => {
      worktreeCatalog.invalidate();
      refreshTree();
      sessionImporter.wake();
    },
  });
  context.subscriptions.push(repoDiscovery);
  repoDiscovery.start(workspacesProvider.whenSettled());

  /** Whether the chat's terminal or native-UI tab is the one in front of the user. */
  const isChatVisible = (chatId: string): boolean => chatVisibility.isChatVisible(visibilitySources, chatId);
  const notificationService = new NotificationService(
    (chatId) => {
      const chat = storageService.getChat(chatId);
      if (chat) {
        terminalManager.focusChat(chatId);
        activateChat(chat, { revealIfHidden: false });
      }
    },
    isChatVisible
  );
  const attentionService = new SessionAttentionService(
    storageService,
    harnessRegistry,
    notificationService,
    (worktreeId) => workspacesProvider.getWorktreeById(worktreeId),
    // Turn and needs-you changes swap the row mark (beating mark, orange or green dot).
    () => workspacesProvider.softRefresh(),
    isChatOpen,
    isChatVisible
  );
  markChatSeen = (chatId) => attentionService.markSeen(chatId);
  noteSessions = (sessions) => attentionService.noteSessions(sessions);
  attentionService.start();
  // Records what the user looks at between ticks, for needs-you toasts; never polls.
  context.subscriptions.push(...chatVisibility.onFrontMayChange(() => attentionService.noteFront()));
  // Every row's status and the re-sorts it triggers (rows 3.3, 3.4).
  workspacesProvider.setStatusSource(attentionService);

  // Commands
  registerRepositoryCommands(context, { storageService, gitService, harnessRegistry, forgetWorktrees, refreshTree });
  registerWorktreeRowCommands(context, { workspacesProvider, switchWorkspaceFolder });
  registerChatCommands(context, {
    storageService,
    gitService,
    terminalManager,
    workspacesProvider,
    harnessRegistry,
    harnessWatcherRegistry,
    sessionImporter,
    sessionsNeedingYou: () => attentionService.sessionsNeedingYou(),
    selectedRows: () => workspacesTreeView.selection,
    activeWorktree: () => shownWorktree,
    activateChat,
    showWorktree,
    removeChats,
    refreshTree,
  });
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
  registerSearchCommands(context, { workspacesProvider });

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
