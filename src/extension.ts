import * as os from 'os';
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
import { disposeOperationLog } from './core/services/OperationLog';
import { HarnessRegistry } from './core/harness/HarnessRegistry';
import { enabledHarnesses } from './harnesses';
import { chatNativeSessionIds } from './core/harness/sessionUtils';
import { WorkspacesTreeProvider } from './core/providers/WorkspacesTreeProvider';
import { FilesTreeProvider, FileTreeItem } from './core/providers/FilesTreeProvider';
import { SessionSearchTreeProvider } from './core/providers/SessionSearchTreeProvider';
import { registerRepositoryCommands } from './core/commands/repository';
import { registerWorktreeRowCommands } from './core/commands/worktree-rows';
import { registerChatCommands } from './core/commands/chat';
import { registerSessionImportCommands } from './core/commands/sessionImport';
import { registerFileCommands } from './core/commands/files';
import { registerNavigationCommands } from './core/commands/navigation';
import { SESSION_SEARCH_VIEW, registerSessionSearchCommands } from './core/commands/sessionSearch';
import { commandRegistrar } from './core/commands/common';
import { debounce } from './core/utils/debounce';
import { samePath } from './core/utils/paths';

/** Panels re-read the worktree this long after its files stop changing. */
const FILE_CHANGE_DEBOUNCE_MS = 300;

export async function activate(context: vscode.ExtensionContext) {
  // Startup timing (E16): this line and the tree's "first render" bracket activation.
  console.log('[Pitwall] activate');
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

  harnessWatcherRegistry.startAll();

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

  // Reconcile terminals that survived a reload or a quit (ADR 0009), in the
  // background: activation never waits for a PID. A click on a chat whose
  // surviving tab is still waiting for its PID waits for that adoption in
  // openChat instead, so it cannot start a second agent.
  const restore = terminalManager.beginRestoreSync((id) => workspacesProvider.getWorktreeById(id));
  void restore.complete.catch((error) => console.error('Pitwall: restoring terminals failed', error));

  const filesProvider = new FilesTreeProvider();
  const workspacesTreeView = vscode.window.createTreeView('pitwall.workspacesView', {
    treeDataProvider: workspacesProvider,
    showCollapseAll: true,
    // Session rows can be removed, closed, and starred several at a time.
    canSelectMany: true,
  });
  const filesTreeView = vscode.window.createTreeView('pitwall.filesView', {
    treeDataProvider: filesProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(workspacesTreeView, filesTreeView);
  // The header description and the needs-you badge.
  workspacesProvider.bindView(workspacesTreeView);
  const refreshTree = () => workspacesProvider.refresh();

  // The worktree the Files panel shows, and one watcher on its files that
  // refreshes it.
  let shownWorktree: Worktree | undefined;
  let worktreeWatcher: vscode.FileSystemWatcher | undefined;
  const refreshPanels = debounce(() => {
    filesProvider.refresh();
  }, FILE_CHANGE_DEBOUNCE_MS);
  const showWorktree = (worktree: Worktree | undefined): void => {
    if (worktree?.id !== shownWorktree?.id) {
      shownWorktree = worktree;
      worktreeWatcher?.dispose();
      worktreeWatcher = undefined;
      if (worktree) {
        worktreeWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(worktree.path, '**/*'));
        worktreeWatcher.onDidChange(refreshPanels);
        worktreeWatcher.onDidCreate(refreshPanels);
        worktreeWatcher.onDidDelete(refreshPanels);
      }
      filesProvider.setActiveWorktree(worktree);
    }
    // The FILES header: "{repo} ⎇ {branch}" (no branch for a plain folder),
    // and the folder path. A view has no header tooltip, so the path is the
    // view's message line.
    const owner = worktree && workspacesProvider.repositoryFor(worktree);
    filesTreeView.description = !worktree
      ? undefined
      : owner?.isGit
        ? `${owner.repo.name} ⎇ ${worktree.branch ?? worktree.name}`
        : owner?.repo.name ?? worktree.name;
    filesTreeView.message = worktree?.path;
  };

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
  sessionImporter.start();

  // Repos found from the agents' sessions (ADR 0019), after the list first
  // renders; activation never waits for a pass.
  const repoDiscovery = new RepoDiscoveryService(storageService, gitService, () => harnessRegistry.all(), {
    onAdded: () => {
      worktreeCatalog.scopes(true);
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
  registerFileCommands(context, filesProvider, () => {
    const [row] = filesTreeView.selection;
    return row instanceof FileTreeItem ? row : undefined;
  });

  registerNavigationCommands(context, { workspacesProvider, workspacesTreeView, filesTreeView });

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

  // Start on the worktree that matches the open workspace folder. Reveal is
  // best-effort: the row may not have rendered yet.
  const folderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const startWorktree = folderPath ? workspacesProvider.findWorktreeByPath(folderPath) : undefined;
  if (startWorktree) {
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
  }

  context.subscriptions.push({
    dispose: () => {
      refreshPanels.cancel();
      worktreeWatcher?.dispose();
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
