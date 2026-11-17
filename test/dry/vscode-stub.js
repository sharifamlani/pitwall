/**
 * Minimal `vscode` module stub for dry tests.
 *
 * The extension's service/adapter/provider modules import `vscode`, which only
 * exists inside the extension host. Tests bundle the module under test with
 * esbuild and alias `vscode` to this file, so the real logic can run under
 * plain Node without installing the extension.
 */
const fs = require('fs');
class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }

  fire(value) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose() {
    this.listeners.clear();
  }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class TabInputWebview {
  constructor(viewType) {
    this.viewType = viewType;
  }
}

class TabInputText {
  constructor(uri) {
    this.uri = uri;
  }
}

class TabInputTextDiff {
  constructor(original, modified) {
    this.original = original;
    this.modified = modified;
  }
}

class TabInputTerminal {}

class TabInputNotebook {
  constructor(uri, notebookType) {
    this.uri = uri;
    this.notebookType = notebookType;
  }
}

class TabInputCustom {
  constructor(uri, viewType) {
    this.uri = uri;
    this.viewType = viewType;
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class Uri {
  constructor(scheme, pathValue, authority = '', query = '') {
    this.scheme = scheme;
    this.path = pathValue;
    this.fsPath = pathValue;
    this.authority = authority;
    this.query = query;
  }

  static file(pathValue) {
    return new Uri('file', pathValue);
  }

  static from({ scheme, authority = '', path, query = '' }) {
    return new Uri(scheme, path, authority, query);
  }

  static parse(value) {
    const match = String(value).match(/^([^:]+):\/\/(.*)$/);
    return match ? new Uri(match[1], match[2]) : new Uri('', String(value));
  }

  toString() {
    const authority = this.authority ? `${this.authority}` : '';
    const query = this.query ? `?${this.query}` : '';
    return `${this.scheme}://${authority}${this.path}${query}`;
  }

  static joinPath(base, ...parts) {
    const joined = [base && base.path, ...parts].filter(Boolean).join('/').replace(/\/+/g, '/');
    return new Uri((base && base.scheme) || 'file', joined);
  }
}

const inputBoxes = [];
const quickPicks = [];

/** Minimal InputBox: tests type and press Enter or a title button explicitly. */
class FakeQuickPick {
  constructor() {
    this.value = '';
    this.items = [];
    this.placeholder = '';
    this.title = '';
    this.matchOnDescription = false;
    this.matchOnDetail = false;
    this.sortByLabel = true;
    this.activeItems = [];
    this.selectedItems = [];
    this.shown = false;
    this.hidden = false;
    this.changeListeners = new Set();
    this.acceptListeners = new Set();
    this.hideListeners = new Set();
    quickPicks.push(this);
  }

  onDidChangeValue(listener) {
    this.changeListeners.add(listener);
    return { dispose: () => this.changeListeners.delete(listener) };
  }

  onDidAccept(listener) {
    this.acceptListeners.add(listener);
    return { dispose: () => this.acceptListeners.delete(listener) };
  }

  onDidHide(listener) {
    this.hideListeners.add(listener);
    return { dispose: () => this.hideListeners.delete(listener) };
  }

  show() {
    this.shown = true;
  }

  hide() {
    if (this.hidden) {
      return;
    }
    this.hidden = true;
    for (const listener of [...this.hideListeners]) {
      listener();
    }
  }

  dispose() {
    this.hide();
  }

  /** Test helper: type `value`. */
  __type(value) {
    this.value = value;
    for (const listener of [...this.changeListeners]) {
      listener(value);
    }
  }

  /** Test helper: pick `item` and press Enter. */
  __accept(item) {
    this.selectedItems = item ? [item] : [];
    this.activeItems = this.selectedItems;
    for (const listener of [...this.acceptListeners]) {
      listener();
    }
  }
}

class FakeInputBox {
  constructor() {
    this.value = '';
    this.title = '';
    this.placeholder = '';
    this.buttons = [];
    this.shown = false;
    this.hidden = false;
    this.acceptListeners = new Set();
    this.buttonListeners = new Set();
    this.hideListeners = new Set();
    inputBoxes.push(this);
  }

  onDidAccept(listener) {
    this.acceptListeners.add(listener);
    return { dispose: () => this.acceptListeners.delete(listener) };
  }

  onDidTriggerButton(listener) {
    this.buttonListeners.add(listener);
    return { dispose: () => this.buttonListeners.delete(listener) };
  }

  onDidHide(listener) {
    this.hideListeners.add(listener);
    return { dispose: () => this.hideListeners.delete(listener) };
  }

  show() {
    this.shown = true;
  }

  hide() {
    if (this.hidden) {
      return;
    }
    this.hidden = true;
    for (const listener of [...this.hideListeners]) {
      listener();
    }
  }

  dispose() {
    this.hide();
  }

  /** Test helper: type `value` and press Enter. */
  __accept(value) {
    this.value = value;
    for (const listener of [...this.acceptListeners]) {
      listener();
    }
  }

  /** Test helper: press a title-bar button. */
  __triggerButton(index = 0) {
    for (const listener of [...this.buttonListeners]) {
      listener(this.buttons[index]);
    }
  }
}

class MarkdownString {
  constructor(value = '') {
    this.value = value;
    this.supportHtml = false;
  }

  appendMarkdown(value) {
    this.value += value;
    return this;
  }
}

class RelativePattern {
  constructor(base, pattern) {
    this.base = base;
    this.pattern = pattern;
  }
}

const fileWatchers = [];
class FakeWatcher {
  constructor(pattern) {
    this.pattern = pattern;
    this.changeListeners = new Set();
    this.createListeners = new Set();
    this.deleteListeners = new Set();
    this.disposed = false;
    fileWatchers.push(this);
  }
  onDidChange(listener) {
    this.changeListeners.add(listener);
    return { dispose: () => this.changeListeners.delete(listener) };
  }
  onDidCreate(listener) {
    this.createListeners.add(listener);
    return { dispose: () => this.createListeners.delete(listener) };
  }
  onDidDelete(listener) {
    this.deleteListeners.add(listener);
    return { dispose: () => this.deleteListeners.delete(listener) };
  }
  dispose() {
    this.disposed = true;
    this.changeListeners.clear();
    this.createListeners.clear();
    this.deleteListeners.clear();
  }
  /** Test helper: deliver a filesystem event to the registered listeners. */
  __fireChange() {
    for (const listener of [...this.changeListeners]) listener({});
  }
  __fireCreate() {
    for (const listener of [...this.createListeners]) listener({});
  }
  __fireDelete() {
    for (const listener of [...this.deleteListeners]) listener({});
  }
}

const configurationValues = new Map();
const configuration = {
  get(key, fallback) {
    if (key === 'harnessCommands') {
      // Tests point a harness at a fake CLI by setting this key.
      return {
        claude: 'claude',
        opencode: 'opencode',
        codex: 'codex',
        pi: 'pi',
        ...(configurationValues.get('harnessCommands') ?? {}),
      };
    }
    return configurationValues.has(key)
      ? configurationValues.get(key)
      : fallback;
  },
  async update(key, value) {
    module.exports.__setConfiguration(key, value);
  },
  inspect(key) {
    return configurationValues.has(key)
      ? { key: `pitwall.${key}`, globalValue: configurationValues.get(key) }
      : undefined;
  },
};
let clipboardText = '';

const commandHandlers = new Map();
/** Context keys the extension set with `setContext`, by key. */
const contextKeys = new Map();
const outputChannels = [];
const messages = [];
const openTerminals = [];
const closeListeners = new Set();
const openTerminalListeners = new Set();
const activeTerminalListeners = new Set();
const executionStartListeners = new Set();
const tabChangeListeners = new Set();
const tabGroupChangeListeners = new Set();
const windowStateListeners = new Set();
const configurationChangeListeners = new Set();
const treeViews = [];
let treeViewsVisible = false;
/** How long a tree view created visible waits before the workbench asks for its first rows. */
let treeViewFirstRenderDelayMs = 0;
let activeTerminal;
/**
 * The terminal holding keyboard focus, if any. The workbench's rename command
 * renames this terminal before the active one (`TerminalService.activeInstance`
 * returns a focused host terminal first), and `show(true)` leaves it alone.
 */
let focusedTerminal;
let activeTextEditor;
const shownDocuments = [];
let nextTerminalPid = 4100;
let silentExecutionEvents = false;
let defaultPidDelayMs;
let lateShellIntegration = false;
const shellIntegrationListeners = new Set();
const warningResponses = [];
const quickPickResponses = [];
const inputResponses = [];
const openDialogResponses = [];
let quickPickHandler = null;
const installedExtensions = new Set();
const extensionChangeListeners = new Set();
const openExternalCalls = [];
let openExternalResult = true;
const deletedUris = [];

function createOutputChannel(name) {
  const channel = {
    name,
    lines: [],
    appendLine: (line) => channel.lines.push(line),
    append: (line) => channel.lines.push(line),
    show: () => undefined,
    clear: () => {
      channel.lines.length = 0;
    },
    dispose: () => undefined,
  };
  outputChannels.push(channel);
  return channel;
}

module.exports = {
  EventEmitter,
  TreeItem,
  TabInputWebview,
  TabInputCustom,
  TabInputText,
  TabInputTextDiff,
  TabInputTerminal,
  TabInputNotebook,
  ThemeIcon,
  ThemeColor,
  Uri,
  MarkdownString,
  RelativePattern,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
  TerminalLocation: { Editor: 2, Panel: 1 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  workspace: {
    fs: {
      readDirectory: async (uri) => {
        const entries = fs.readdirSync(uri.fsPath, { withFileTypes: true });
        return entries.map((entry) => [
          entry.name,
          entry.isDirectory() ? 2 : 1,
        ]);
      },
      stat: async (uri) => {
        const info = fs.statSync(uri.fsPath);
        return { type: info.isDirectory() ? 2 : 1, size: info.size };
      },
      createDirectory: async (uri) => {
        fs.mkdirSync(uri.fsPath, { recursive: true });
      },
      writeFile: async (uri, content) => {
        fs.writeFileSync(uri.fsPath, content);
      },
      rename: async (from, to) => {
        fs.renameSync(from.fsPath, to.fsPath);
      },
      copy: async (from, to) => {
        fs.cpSync(from.fsPath, to.fsPath, { recursive: true });
      },
      /** Records the request and removes the path, standing in for the Trash. */
      delete: async (uri, options) => {
        deletedUris.push({ path: uri.fsPath, options });
        fs.rmSync(uri.fsPath, { recursive: true, force: true });
      },
    },
    getConfiguration: () => configuration,
    workspaceFolders: [],
    createFileSystemWatcher: (pattern) => new FakeWatcher(pattern),
    onDidChangeConfiguration: (listener) => {
      configurationChangeListeners.add(listener);
      return {
        dispose: () => configurationChangeListeners.delete(listener),
      };
    },
  },
  window: {
    terminals: openTerminals,
    get activeTerminal() {
      return activeTerminal;
    },
    get activeTextEditor() {
      return activeTextEditor;
    },
    /** Records each call; the document (or URI) becomes the active text editor. */
    showTextDocument: async (documentOrUri, options = {}) => {
      shownDocuments.push({ target: documentOrUri, options });
      const document = documentOrUri && documentOrUri.uri ? documentOrUri : { uri: documentOrUri };
      activeTextEditor = { document, viewColumn: options.viewColumn };
      return activeTextEditor;
    },
    /** Test helper: the user focuses a text editor, `{ document, viewColumn }`. */
    __setActiveTextEditor: (editor) => {
      activeTextEditor = editor;
    },
    /**
     * Test helper: the user clicks into a text editor. It becomes the active
     * editor and takes keyboard focus from any terminal; the window's active
     * terminal stays what it was, as in the editor.
     */
    __focusTextEditor: (editor) => {
      activeTextEditor = editor;
      focusedTerminal = undefined;
    },
    state: { focused: false },
    onDidChangeWindowState: (listener) => {
      windowStateListeners.add(listener);
      return { dispose: () => windowStateListeners.delete(listener) };
    },
    /** Test helper: the window gains or loses focus; `window.state` changes before listeners run. */
    __setWindowState: (state) => {
      module.exports.window.state = state;
      for (const listener of [...windowStateListeners]) {
        listener(state);
      }
    },
    /** Test helper: `__setWindowState({ focused })`, by its focus flag alone. */
    __fireWindowState: (focused) => module.exports.window.__setWindowState({ focused }),
    /** Test helper: announce a tab change after a test rearranged `tabGroups.all`. */
    __fireTabsChanged: () => {
      for (const listener of [...tabChangeListeners]) {
        listener({ opened: [], closed: [], changed: [] });
      }
    },
    /**
     * A tree view that records reveals. Views start hidden unless
     * `__setTreeViewsVisible(true)` was called; `__setVisible` on a view
     * fires its visibility event.
     */
    createTreeView: (id, options) => {
      const visibility = new EventEmitter();
      const selection = new EventEmitter();
      const provider = options?.treeDataProvider;
      /**
       * The rows the extension host still knows, by id. As in the editor's
       * `ExtHostTreeView`, a full refresh (`onDidChangeTreeData` with no
       * element) clears them all, and the workbench asking for a row's
       * children after that logs "No tree item with id '1/<id>' found."
       */
      const known = new Set();
      const register = (items) => {
        for (const item of items ?? []) {
          if (item && item.id) known.add(item.id);
        }
      };
      const render = () =>
        Promise.resolve(provider?.getChildren?.())
          .then(register)
          .catch(() => undefined);
      provider?.onDidChangeTreeData?.((element) => {
        if (element) return;
        known.clear();
        // The workbench re-renders the rows once the refresh reaches it.
        if (view.visible) setTimeout(() => void render(), view.__renderDelayMs);
      });
      const view = {
        id,
        options,
        visible: treeViewsVisible,
        title: '',
        selection: [],
        reveals: [],
        /** Lines the extension host would log for a row it no longer knows. */
        treeErrors: [],
        /**
         * How long the workbench takes, after the extension host resolved a
         * reveal's parent rows, to ask for their children (it expands each
         * one). A busy window at startup takes hundreds of ms.
         */
        __revealRoundTripMs: 0,
        /** How long a refresh takes to reach the workbench, which then re-renders the rows. */
        __renderDelayMs: 0,
        /** Reveals the workbench has finished (or given up on). */
        revealsDone: 0,
        reveal: async (item, revealOptions) => {
          view.reveals.push({ item, options: revealOptions });
          if (!provider?.getParent) {
            view.revealsDone += 1;
            return;
          }
          try {
            const chain = [];
            for (let parent = provider.getParent(item); parent; parent = provider.getParent(parent)) chain.unshift(parent);
            // The extension host resolves and registers the parent chain...
            register(chain);
            // ...and the workbench then expands each parent, asking for its children.
            await new Promise((resolve) => setTimeout(resolve, view.__revealRoundTripMs));
            for (const parent of chain) {
              if (!known.has(parent.id)) {
                view.treeErrors.push(`No tree item with id '1/${parent.id}' found.`);
                return;
              }
              register(await provider.getChildren(parent));
            }
          } catch {
            // A provider that cannot answer is not what this models.
          } finally {
            view.revealsDone += 1;
          }
        },
        onDidChangeVisibility: visibility.event,
        onDidChangeSelection: selection.event,
        /** Test helper: the user selects rows; `selection` changes before listeners run. */
        __select: (items) => {
          view.selection = items;
          selection.fire({ selection: items });
        },
        /** The view shows (or hides); a shown view renders its root rows, like the workbench. */
        __setVisible: (visible) => {
          view.visible = visible;
          visibility.fire({ visible });
          if (visible) {
            void render();
          }
        },
        dispose: () => undefined,
      };
      if (view.visible) {
        if (treeViewFirstRenderDelayMs > 0) setTimeout(() => void render(), treeViewFirstRenderDelayMs);
        else void render();
      }
      treeViews.push(view);
      return view;
    },
    tabGroups: {
      all: [],
      get activeTabGroup() {
        return this.all.find((group) => group.isActive);
      },
      close: (tab) => {
        for (const group of module.exports.window.tabGroups.all) {
          const index = group.tabs.indexOf(tab);
          if (index !== -1) {
            group.tabs.splice(index, 1);
            return Promise.resolve(true);
          }
        }
        return Promise.resolve(false);
      },
      onDidChangeTabs: (listener) => {
        tabChangeListeners.add(listener);
        return { dispose: () => tabChangeListeners.delete(listener) };
      },
      onDidChangeTabGroups: (listener) => {
        tabGroupChangeListeners.add(listener);
        return { dispose: () => tabGroupChangeListeners.delete(listener) };
      },
    },
    createOutputChannel,
    onDidCloseTerminal: (listener) => {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    onDidOpenTerminal: (listener) => {
      openTerminalListeners.add(listener);
      return { dispose: () => openTerminalListeners.delete(listener) };
    },
    onDidChangeActiveTerminal: (listener) => {
      activeTerminalListeners.add(listener);
      return { dispose: () => activeTerminalListeners.delete(listener) };
    },
    onDidChangeTerminalShellIntegration: (listener) => {
      shellIntegrationListeners.add(listener);
      return { dispose: () => shellIntegrationListeners.delete(listener) };
    },
    onDidStartTerminalShellExecution: (listener) => {
      executionStartListeners.add(listener);
      return { dispose: () => executionStartListeners.delete(listener) };
    },
    __fireDidCloseTerminal: (terminal) => {
      for (const listener of closeListeners) {
        listener(terminal);
      }
    },
    __fireDidOpenTerminal: (terminal) => {
      for (const listener of openTerminalListeners) {
        listener(terminal);
      }
    },
    __fireDidStartTerminalShellExecution: (terminal, commandLine = '') => {
      for (const listener of executionStartListeners) {
        listener({ terminal, execution: { commandLine } });
      }
    },
    /**
     * Test helper: a slow shell reports integration now, then runs the text
     * typed into it before, reporting each as a command start.
     */
    __integrateShell: (terminal) => {
      terminal.shellIntegration = {};
      terminal.__awaitingIntegration = false;
      for (const listener of [...shellIntegrationListeners]) {
        listener({ terminal, shellIntegration: terminal.shellIntegration });
      }
      for (const text of terminal.sent) {
        for (const listener of [...executionStartListeners]) {
          listener({ terminal, execution: { commandLine: text } });
        }
      }
    },
    /** Test helper: the user clicks into a terminal: it takes keyboard focus and becomes active. */
    __focusTerminal: (terminal) => {
      focusedTerminal = terminal;
      activeTerminal = terminal;
      for (const listener of activeTerminalListeners) {
        listener(terminal);
      }
    },
    /** The terminal holding keyboard focus (see `focusedTerminal`). */
    get __focusedTerminal() {
      return focusedTerminal;
    },
    __setActiveTerminal: (terminal) => {
      activeTerminal = terminal;
      for (const listener of activeTerminalListeners) {
        listener(terminal);
      }
    },
    createTerminal: (options) => {
      const terminal = {
        name: options.name,
        options,
        sent: [],
        shown: 0,
        disposed: false,
        __pid: options.__pid ?? nextTerminalPid++,
        exitStatus: options.__exitStatus,
        shellIntegration: lateShellIntegration ? undefined : {},
        __awaitingIntegration: lateShellIntegration,
        __pidReads: 0,
        get processId() {
          this.__pidReads += 1;
          return pidPromise ?? Promise.resolve(this.__pid);
        },
        sendText(text) {
          this.sent.push(text);
          // A shell that has not integrated yet runs typed-ahead text later.
          if (silentExecutionEvents || this.__awaitingIntegration) {
            return;
          }
          for (const listener of executionStartListeners) {
            listener({ terminal: this, execution: { commandLine: text } });
          }
        },
        show(preserveFocus) {
          this.shown += 1;
          activeTerminal = this;
          if (!preserveFocus) {
            focusedTerminal = this;
          }
          // An editor-area terminal takes the text editor's place in front.
          if (options.location === 2) {
            activeTextEditor = undefined;
          }
          for (const listener of activeTerminalListeners) {
            listener(this);
          }
        },
        dispose() {
          this.disposed = true;
          const index = openTerminals.indexOf(this);
          if (index >= 0) {
            openTerminals.splice(index, 1);
          }
          if (focusedTerminal === this) {
            focusedTerminal = undefined;
          }
          if (activeTerminal === this) {
            activeTerminal = undefined;
            for (const listener of activeTerminalListeners) {
              listener(undefined);
            }
          }
        },
      };
      // `__pidDelayMs` models a pty that reports its PID late (Windows):
      // one promise per terminal, like VS Code; Infinity never resolves.
      const delay = options.__pidDelayMs ?? defaultPidDelayMs;
      const pidPromise =
        delay === undefined
          ? undefined
          : delay === Infinity
            ? new Promise(() => undefined)
            : new Promise((resolve) => setTimeout(() => resolve(terminal.__pid), delay));
      openTerminals.push(terminal);
      return terminal;
    },
    showWarningMessage: async (...args) => {
      messages.push(args);
      return warningResponses.shift();
    },
    showErrorMessage: async (...args) => {
      messages.push(args);
      return undefined;
    },
    showInformationMessage: async (...args) => {
      messages.push(args);
      return undefined;
    },
    showOpenDialog: async (options) => {
      messages.push([options]);
      return openDialogResponses.shift();
    },
    showQuickPick: async (items, options) => {
      messages.push([items, options]);
      if (quickPickHandler) {
        return quickPickHandler(items, options);
      }
      return quickPickResponses.shift();
    },
    createInputBox: () => new FakeInputBox(),
    createQuickPick: () => new FakeQuickPick(),
    showInputBox: async (options) => {
      messages.push([options]);
      return inputResponses.shift();
    },
    withProgress: async (_options, task) => task(),
  },
  extensions: {
    getExtension: (id) =>
      installedExtensions.has(id)
        ? { id, isActive: true, activate: async () => undefined }
        : undefined,
    onDidChange: (listener) => {
      extensionChangeListeners.add(listener);
      return { dispose: () => extensionChangeListeners.delete(listener) };
    },
    all: [],
  },
  env: {
    clipboard: {
      writeText: async (text) => {
        clipboardText = text;
      },
      readText: async () => clipboardText,
    },
    openExternal: async (uri) => {
      openExternalCalls.push(uri);
      return openExternalResult;
    },
    /** The default terminal profile's shell; tests switch it with `__setShell`. */
    shell: '/bin/bash',
  },
  commands: {
    registerCommand: (id, handler) => {
      commandHandlers.set(id, handler);
      return { dispose: () => commandHandlers.delete(id) };
    },
    getCommands: async () => Array.from(commandHandlers.keys()),
    executeCommand: async (id, ...args) => {
      // Context keys gate menus and welcome views; tests read them back.
      if (id === 'setContext') {
        contextKeys.set(args[0], args[1]);
        return undefined;
      }
      const handler = commandHandlers.get(id);
      if (!handler) {
        throw new Error(`No command registered: ${id}`);
      }
      return handler(...args);
    },
  },
  /**
   * Return the stub to its initial state so each test starts clean: no
   * messages, queued responses, terminals, commands, listeners, or settings.
   */
  __reset: () => {
    for (const list of [
      messages,
      warningResponses,
      quickPickResponses,
      inputResponses,
      openDialogResponses,
      inputBoxes,
      quickPicks,
      openTerminals,
      openExternalCalls,
      fileWatchers,
      outputChannels,
      deletedUris,
      shownDocuments,
      treeViews,
    ]) {
      list.length = 0;
    }
    for (const set of [
      closeListeners,
      openTerminalListeners,
      activeTerminalListeners,
      executionStartListeners,
      shellIntegrationListeners,
      tabChangeListeners,
      tabGroupChangeListeners,
      windowStateListeners,
      configurationChangeListeners,
      extensionChangeListeners,
      installedExtensions,
    ]) {
      set.clear();
    }
    commandHandlers.clear();
    contextKeys.clear();
    configurationValues.clear();
    quickPickHandler = null;
    clipboardText = '';
    activeTerminal = undefined;
    focusedTerminal = undefined;
    treeViewsVisible = false;
    treeViewFirstRenderDelayMs = 0;
    activeTextEditor = undefined;
    silentExecutionEvents = false;
    defaultPidDelayMs = undefined;
    lateShellIntegration = false;
    openExternalResult = true;
    nextTerminalPid = 4100;
    module.exports.workspace.workspaceFolders = [];
    module.exports.window.tabGroups.all = [];
    module.exports.window.state = { focused: false };
    module.exports.env.shell = '/bin/bash';
  },
  __deleted: deletedUris,
  __treeViews: treeViews,
  /** Test helper: tree views created from now on start visible (or hidden). */
  __setTreeViewsVisible: (visible) => {
    treeViewsVisible = Boolean(visible);
  },
  /** Test helper: a visible tree view created from now on is first drawn this long after it is created. */
  __setTreeViewFirstRenderDelay: (ms) => {
    treeViewFirstRenderDelayMs = ms;
  },
  __shownDocuments: shownDocuments,
  __commandHandlers: commandHandlers,
  __contextKeys: contextKeys,
  __outputChannels: outputChannels,
  __fileWatchers: fileWatchers,
  __messages: messages,
  __warningResponses: warningResponses,
  __quickPickResponses: quickPickResponses,
  __inputResponses: inputResponses,
  __openDialogResponses: openDialogResponses,
  __openExternalCalls: openExternalCalls,
  __setExtensionInstalled: (id, installed = true) => {
    if (installed) {
      installedExtensions.add(id);
    } else {
      installedExtensions.delete(id);
    }
  },
  __setOpenExternalResult: (value) => {
    openExternalResult = Boolean(value);
  },
  __inputBoxes: inputBoxes,
  __quickPicks: quickPicks,
  __setQuickPickHandler: (handler) => {
    quickPickHandler = handler;
  },
  __setConfiguration: (key, value) => {
    if (value === undefined) {
      configurationValues.delete(key);
    } else {
      configurationValues.set(key, value);
    }
    const changed = `pitwall.${key}`;
    for (const listener of configurationChangeListeners) {
      listener({
        affectsConfiguration: (section) =>
          changed === section || changed.startsWith(`${section}.`),
      });
    }
  },
  /** Test helper: terminals created from now on report their PID after `ms`. */
  __setPidDelayMs: (ms) => {
    defaultPidDelayMs = ms;
  },
  /** Test helper: terminals created from now on integrate only on `window.__integrateShell`. */
  __setLateShellIntegration: (value) => {
    lateShellIntegration = Boolean(value);
  },
  /** Test helper: change the default terminal shell (`vscode.env.shell`). */
  __setShell: (shellPath) => {
    module.exports.env.shell = shellPath;
  },
  /** Test helper: model a shell that never reports a command start. */
  __setSilentExecutionEvents: (value) => {
    silentExecutionEvents = Boolean(value);
  },
};
