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

/** Minimal DataTransferItem: holds a value, `asString()` gives it as text. */
class DataTransferItem {
  constructor(value) {
    this.value = value;
  }

  async asString() {
    return typeof this.value === 'string' ? this.value : JSON.stringify(this.value);
  }

  asFile() {
    return undefined;
  }
}

/** Minimal DataTransfer: items by mime type, lower-cased as in the editor. */
class DataTransfer {
  constructor() {
    this.items = new Map();
  }

  get(mimeType) {
    return this.items.get(mimeType.toLowerCase());
  }

  set(mimeType, value) {
    this.items.set(mimeType.toLowerCase(), value);
  }

  forEach(callback) {
    for (const [mime, item] of this.items) callback(item, mime, this);
  }

  [Symbol.iterator]() {
    return this.items[Symbol.iterator]();
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
    this.canSelectMany = false;
    this.buttons = [];
    this.activeItems = [];
    this.selectedItems = [];
    this.shown = false;
    this.hidden = false;
    this.changeListeners = new Set();
    this.acceptListeners = new Set();
    this.hideListeners = new Set();
    this.buttonListeners = new Set();
    quickPicks.push(this);
  }

  onDidTriggerButton(listener) {
    this.buttonListeners.add(listener);
    return { dispose: () => this.buttonListeners.delete(listener) };
  }

  /** Test helper: click the title-bar button at `index`. */
  __triggerButton(index = 0) {
    for (const listener of [...this.buttonListeners]) {
      listener(this.buttons[index]);
    }
  }

  /** Test helper: tick exactly `items` (a many-pick) and press Enter. */
  __acceptSelected(items) {
    this.selectedItems = items;
    for (const listener of [...this.acceptListeners]) {
      listener();
    }
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
const activeTextEditorListeners = new Set();
const windowStateListeners = new Set();
const configurationChangeListeners = new Set();
const treeViews = [];
const statusBarItems = [];
/** `window.setStatusBarMessage` calls, as `{ text, timeoutMs }`. */
const statusBarMessages = [];
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
const terminalStateListeners = new Set();
const warningResponses = [];
/** Answers for showInformationMessage, in order; undefined (dismissed) once empty. */
const informationResponses = [];
const quickPickResponses = [];
const inputResponses = [];
const openDialogResponses = [];
let quickPickHandler = null;
const installedExtensions = new Set();
const extensionChangeListeners = new Set();
const openExternalCalls = [];
let openExternalResult = true;
const deletedUris = [];
const uriHandlers = [];

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
  DataTransfer,
  DataTransferItem,
  Uri,
  MarkdownString,
  RelativePattern,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
  TerminalLocation: { Editor: 2, Panel: 1 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
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
      for (const listener of [...activeTextEditorListeners]) {
        listener(editor);
      }
    },
    onDidChangeActiveTextEditor: (listener) => {
      activeTextEditorListeners.add(listener);
      return { dispose: () => activeTextEditorListeners.delete(listener) };
    },
    setStatusBarMessage: (text, timeoutMs) => {
      statusBarMessages.push({ text, timeoutMs });
      return { dispose: () => undefined };
    },
    /** Records each item; `shown` follows show()/hide(), as in the status bar. */
    createStatusBarItem: (alignment, priority) => {
      const item = {
        alignment,
        priority,
        text: '',
        tooltip: undefined,
        command: undefined,
        shown: false,
        disposed: false,
        show() {
          this.shown = true;
        },
        hide() {
          this.shown = false;
        },
        dispose() {
          this.shown = false;
          this.disposed = true;
        },
      };
      statusBarItems.push(item);
      return item;
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
    /**
     * Test helper: announce a tab change after a test rearranged `tabGroups.all`,
     * optionally naming the opened, closed or changed tabs.
     */
    __fireTabsChanged: (event = {}) => {
      for (const listener of [...tabChangeListeners]) {
        listener({ opened: [], closed: [], changed: [], ...event });
      }
    },
    /**
     * Test helper: a tab-model refresh. VS Code rebuilds every group and Tab
     * object when groups are added or removed, and fires only a group event.
     */
    __fireTabGroupsChanged: () => {
      for (const listener of [...tabGroupChangeListeners]) {
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
      const collapse = new EventEmitter();
      const provider = options?.treeDataProvider;
      /**
       * The rows the extension host still knows, by id. As in the editor's
       * `ExtHostTreeView`, a full refresh (`onDidChangeTreeData` with no
       * element) clears them all, and the workbench asking for a row's
       * children after that logs "No tree item with id '1/<id>' found."
       */
      const known = new Set();
      /**
       * Row commands as the editor's `CommandsConverter` hands them to the
       * workbench (extHostCommands.ts `toInternal`): a command with arguments
       * becomes `_internal_command_delegation` with a cache id
       * (`<command> /<n>`), and that cache entry is disposed with the row's
       * node: on a full refresh, or when the row or its parent is refreshed.
       * The workbench keeps the command it last received until it re-renders,
       * so a click in between runs a disposed id and the extension host logs
       * "Actual command not found, wanted to execute <id>".
       */
      const commandCache = new Map();
      let commandPool = 0;
      /** Extension-host nodes by element object (as `ExtHostTreeView.nodes`): its id, command dispose and children. */
      const nodes = new Map();
      /** The command each row's id carries in the workbench, as last received. */
      const shownCommands = new Map();
      /** Ids of rows the workbench shows expanded; their children re-render with them. */
      const expanded = new Set();
      const toInternal = (command) => {
        if (!command) return { dto: undefined, dispose: () => undefined };
        if (Array.isArray(command.arguments) && command.arguments.length > 0) {
          const cacheId = `${command.command} /${++commandPool}`;
          commandCache.set(cacheId, command);
          return {
            dto: { id: '_internal_command_delegation', arguments: [cacheId] },
            dispose: () => commandCache.delete(cacheId),
          };
        }
        return { dto: { id: command.command, arguments: undefined }, dispose: () => undefined };
      };
      const treeItemOf = (element) => provider?.getTreeItem?.(element) ?? element;
      const clearNode = (element) => {
        const node = nodes.get(element);
        if (!node) return;
        for (const child of node.children) clearNode(child);
        node.dispose();
        nodes.delete(element);
      };
      const clearChildren = (parent) => {
        const node = parent ? nodes.get(parent) : undefined;
        const children = parent ? node?.children ?? [] : [...nodes.keys()].filter((element) => !nodes.get(element).parent);
        for (const child of children) clearNode(child);
        if (node) node.children = [];
      };
      const createNode = (element, parent) => {
        const item = treeItemOf(element);
        const { dto, dispose } = toInternal(item?.command);
        nodes.set(element, { id: item?.id, dto, dispose, parent, children: [] });
        if (parent && nodes.has(parent)) nodes.get(parent).children.push(element);
        return { item, dto };
      };
      /** The workbench receives a row: its command, and its children when it is expanded. */
      const show = async (item, dto) => {
        if (!item?.id) return;
        shownCommands.set(item.id, dto);
        if (expanded.has(item.id)) await fetchChildren(item);
      };
      const fetchChildren = async (parent) => {
        const items = (await provider?.getChildren?.(parent)) ?? [];
        // The answer replaces the children held before it (two overlapping
        // requests leave only the later answer's rows).
        clearChildren(parent);
        register(items);
        const created = items.map((element) => ({ element, ...createNode(element, parent) }));
        for (const { item, dto } of created) await show(item, dto);
        return items;
      };
      const register = (items) => {
        for (const item of items ?? []) {
          if (item && item.id) known.add(item.id);
        }
      };
      const render = () => fetchChildren(undefined).catch(() => undefined);
      provider?.onDidChangeTreeData?.((element) => {
        if (element) {
          // An element refresh (extHostTreeViews.ts `refreshNode`): each row
          // the extension host knows, by object, gets a new node and command;
          // its children are cleared. An object it never handed out is ignored.
          for (const target of Array.isArray(element) ? element : [element]) {
            const old = nodes.get(target);
            if (!old) {
              view.ignoredRefreshes += 1;
              continue;
            }
            clearChildren(target);
            old.dispose();
            nodes.delete(target);
            const { item, dto } = createNode(target, old.parent);
            view.elementRefreshes += 1;
            setTimeout(() => void show(item, dto).catch(() => undefined), view.__renderDelayMs);
          }
          return;
        }
        view.fullRefreshes += 1;
        known.clear();
        for (const element of [...nodes.keys()]) clearNode(element);
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
        /** Full refreshes (`onDidChangeTreeData` with no element) the provider fired. */
        fullRefreshes: 0,
        /** Rows refreshed one by one (element refreshes the extension host carried out). */
        elementRefreshes: 0,
        /** Element refreshes naming an object the extension host never received (it ignores them). */
        ignoredRefreshes: 0,
        /** The workbench renders the root rows now, and the children of expanded ones. */
        __render: () => render(),
        /** The row object the extension host holds for an id, if any. */
        __rowOf: (rowId) => [...nodes.entries()].find(([, node]) => node.id === rowId)?.[0],
        /** The ids of a row's children, in order, as the extension host holds them (root rows with no argument). */
        __childIds: (parent) =>
          parent
            ? (nodes.get(parent)?.children ?? []).map((child) => nodes.get(child)?.id)
            : [...nodes.entries()].filter(([, node]) => !node.parent).map(([, node]) => node.id),
        /** The user expands a row: the workbench asks for its children and keeps them in step from then on. */
        __expand: async (item) => {
          expanded.add(item.id);
          await fetchChildren(item);
        },
        /**
         * The user collapses a row. The workbench then never fetches its
         * children on a refresh (AsyncDataTree `refreshNode` marks a collapsed
         * node stale and gives it no children). `report: false` leaves out
         * `onDidCollapseElement`, for a collapse the extension never hears of.
         */
        __collapse: (item, { report = true } = {}) => {
          expanded.delete(item.id);
          if (report) collapse.fire({ element: item });
        },
        /**
         * The user clicks a row: the workbench runs the command it holds for
         * the row's id, as `TreeView`'s `onDidOpen` does. A disposed cache id
         * is logged to `treeErrors` and nothing runs.
         */
        __click: async (item) => {
          if (!shownCommands.has(item.id)) {
            view.treeErrors.push(`No row with id '${item.id}' is shown.`);
            return;
          }
          const dto = shownCommands.get(item.id);
          if (!dto) return;
          if (dto.id === '_internal_command_delegation') {
            const actual = commandCache.get(dto.arguments[0]);
            if (!actual) {
              view.treeErrors.push(`Actual command not found, wanted to execute ${dto.arguments[0]}`);
              return;
            }
            return module.exports.commands.executeCommand(actual.command, ...actual.arguments);
          }
          return module.exports.commands.executeCommand(dto.id, ...(dto.arguments ?? []));
        },
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
        onDidCollapseElement: collapse.event,
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
    onDidChangeTerminalState: (listener) => {
      terminalStateListeners.add(listener);
      return { dispose: () => terminalStateListeners.delete(listener) };
    },
    /**
     * Test helper: data goes to a terminal's process (the user typing, or an
     * extension's sendText); its state turns interacted-with once, as in VS Code.
     */
    __typeInTerminal: (terminal) => {
      if (terminal.state.isInteractedWith) return;
      terminal.state = { ...terminal.state, isInteractedWith: true };
      for (const listener of [...terminalStateListeners]) {
        listener(terminal);
      }
    },
    /** Test helper: the user types keys into a terminal before Pitwall sends its line (they wait in the line editor). */
    __typeKeys: (terminal, text) => {
      terminal.__input += text;
      module.exports.window.__typeInTerminal(terminal);
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
        typed: [],
        __input: '',
        shown: 0,
        disposed: false,
        __pid: options.__pid ?? nextTerminalPid++,
        exitStatus: options.__exitStatus,
        shellIntegration: lateShellIntegration ? undefined : {},
        __awaitingIntegration: lateShellIntegration,
        __pidReads: 0,
        state: { isInteractedWith: false },
        get processId() {
          this.__pidReads += 1;
          return pidPromise ?? Promise.resolve(this.__pid);
        },
        /**
         * `typed` records each raw send, with "\n" when it adds a newline;
         * `sent` records the lines the shell runs. Like a shell's line
         * editor, keys typed first (`__typeKeys`) and text sent without a
         * newline wait in the line, and a line-clear (Esc or Ctrl+U) at the
         * start of a send erases what waits (Q27).
         */
        sendText(text, addNewLine = true) {
          this.typed.push(addNewLine ? `${text}\n` : text);
          const clears = text.startsWith('\x1b') || text.startsWith('\x15');
          this.__input = clears ? text.slice(1) : this.__input + text;
          // As in VS Code, text an extension sends counts as interaction (QA #51).
          module.exports.window.__typeInTerminal(this);
          if (!addNewLine) {
            return;
          }
          const line = this.__input;
          this.__input = '';
          this.sent.push(line);
          // A shell that has not integrated yet runs typed-ahead text later.
          if (silentExecutionEvents || this.__awaitingIntegration) {
            return;
          }
          for (const listener of executionStartListeners) {
            listener({ terminal: this, execution: { commandLine: line } });
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
      return informationResponses.shift();
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
    /** Records the extension's URI handler; tests read it back as `__uriHandlers`. */
    registerUriHandler: (handler) => {
      uriHandlers.push(handler);
      return { dispose: () => uriHandlers.splice(uriHandlers.indexOf(handler), 1) };
    },
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
    /** The app's link scheme: `vscode` in VS Code, `cursor` in Cursor. Tests may assign it. */
    uriScheme: 'vscode',
  },
  commands: {
    registerCommand: (id, handler) => {
      // VS Code throws on a second registration of a live id ("command '…' already exists").
      // Enforced for internal commands (a leading underscore, such as the
      // `_pitwall.row.*` row clicks); tests deliberately re-register public
      // `pitwall.*` commands with fakes.
      if (id.startsWith('_') && commandHandlers.has(id)) {
        throw new Error(`command '${id}' already exists`);
      }
      commandHandlers.set(id, handler);
      return {
        dispose: () => {
          if (commandHandlers.get(id) === handler) commandHandlers.delete(id);
        },
      };
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
      informationResponses,
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
      uriHandlers,
      shownDocuments,
      treeViews,
      statusBarItems,
      statusBarMessages,
    ]) {
      list.length = 0;
    }
    for (const set of [
      closeListeners,
      openTerminalListeners,
      activeTerminalListeners,
      executionStartListeners,
      shellIntegrationListeners,
      terminalStateListeners,
      tabChangeListeners,
      tabGroupChangeListeners,
      activeTextEditorListeners,
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
    module.exports.env.uriScheme = 'vscode';
    nextTerminalPid = 4100;
    module.exports.workspace.workspaceFolders = [];
    module.exports.workspace.workspaceFile = undefined;
    module.exports.window.tabGroups.all = [];
    module.exports.window.state = { focused: false };
    module.exports.env.shell = '/bin/bash';
  },
  __deleted: deletedUris,
  __uriHandlers: uriHandlers,
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
  __statusBarItems: statusBarItems,
  __statusBarMessages: statusBarMessages,
  __messages: messages,
  __warningResponses: warningResponses,
  __informationResponses: informationResponses,
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
