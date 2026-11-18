/**
 * Shared plumbing for dry tests: typed access to the `vscode` stub's test
 * controls, in-memory storage, temp directories, polling, and fakes at the
 * harness boundary. Fakes here stand in for processes and the editor, never
 * for the code under test.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { StorageService } from '../../src/core/services/StorageService';
import { harnessTreeIcons } from '../../src/core/harness/treeIcons';
import {
  HarnessAdapter,
  HarnessSession,
  NativeUiCapability,
  NativeUiSurfaceTracker,
  SessionSearchRunner,
} from '../../src/core/harness/types';
import { ChatSession, HarnessId, RepositoryWorktrees, Worktree } from '../../src/core/types';
import { HARNESS_IDS } from '../../src/harnesses';

/** A terminal created by the stub. */
export interface FakeTerminal {
  name: string;
  options: {
    name?: string;
    cwd?: string;
    iconPath?: { id: string };
    __pid?: number;
    __pidDelayMs?: number;
    __exitStatus?: unknown;
    location?: number;
  };
  sent: string[];
  shown: number;
  disposed: boolean;
  __pid: number;
  /** How many times `processId` was read. */
  __pidReads: number;
  exitStatus: unknown;
  shellIntegration: unknown;
  state: { isInteractedWith: boolean };
  readonly processId: Promise<number>;
  sendText(text: string): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

export interface FakeInputBox {
  value: string;
  title: string;
  buttons: unknown[];
  hidden: boolean;
  __accept(value: string): void;
  __triggerButton(index?: number): void;
}

export interface FakeQuickPick {
  value: string;
  items: { label: string; description?: string; kind?: number; alwaysShow?: boolean; [key: string]: unknown }[];
  placeholder: string;
  matchOnDescription: boolean;
  sortByLabel: boolean;
  activeItems: FakeQuickPick['items'];
  shown: boolean;
  hidden: boolean;
  __type(value: string): void;
  __accept(item?: FakeQuickPick['items'][number]): void;
}

interface StubControls {
  __reset(): void;
  __messages: unknown[][];
  __warningResponses: (string | undefined)[];
  __inputResponses: (string | undefined)[];
  __quickPickResponses: unknown[];
  __openDialogResponses: unknown[];
  __inputBoxes: FakeInputBox[];
  __quickPicks: FakeQuickPick[];
  __fileWatchers: {
    pattern: { base: string; pattern: string };
    disposed: boolean;
    __fireChange(): void;
    __fireCreate(): void;
    __fireDelete(): void;
  }[];
  __statusBarItems: {
    alignment: number;
    text: string;
    tooltip?: string;
    command?: string;
    shown: boolean;
    disposed: boolean;
  }[];
  __deleted: { path: string; options?: { useTrash?: boolean } }[];
  __setQuickPickHandler(handler: ((items: any[], options?: any) => unknown) | null): void;
  __setConfiguration(key: string, value: unknown): void;
  __setExtensionInstalled(id: string, installed?: boolean): void;
  __setOpenExternalResult(value: boolean): void;
  __openExternalCalls: { toString(): string }[];
  __setSilentExecutionEvents(value: boolean): void;
  __setShell(shellPath: string | undefined): void;
  __setPidDelayMs(ms: number | undefined): void;
  __setLateShellIntegration(value: boolean): void;
  __shownDocuments: { target: unknown; options: Record<string, unknown> }[];
  __treeViews: FakeTreeView[];
  __outputChannels: Array<{ name: string; lines: string[] }>;
  /** Context keys the extension set with `setContext`, by key. */
  __contextKeys: Map<string, unknown>;
  __setTreeViewsVisible(visible: boolean): void;
  /** A visible tree view created from now on is first drawn this long after it is created. */
  __setTreeViewFirstRenderDelay(ms: number): void;
  workspace: { workspaceFolders: { uri: { fsPath: string } }[]; workspaceFile?: { fsPath: string } };
  window: {
    terminals: FakeTerminal[];
    activeTerminal: FakeTerminal | undefined;
    activeTextEditor: { document: { uri: unknown }; viewColumn?: number } | undefined;
    tabGroups: { all: unknown[] };
    createTerminal(options: FakeTerminal['options']): FakeTerminal;
    __fireDidCloseTerminal(terminal: unknown): void;
    __fireDidOpenTerminal(terminal: unknown): void;
    __fireDidStartTerminalShellExecution(terminal: unknown, commandLine?: string): void;
    __setActiveTerminal(terminal: unknown): void;
    __focusTerminal(terminal: unknown): void;
    readonly __focusedTerminal: FakeTerminal | undefined;
    __setActiveTextEditor(editor: { document: { uri: unknown }; viewColumn?: number } | undefined): void;
    __focusTextEditor(editor: { document: { uri: unknown }; viewColumn?: number }): void;
    __integrateShell(terminal: unknown): void;
    __fireWindowState(focused: boolean): void;
    __fireTabsChanged(event?: { opened?: unknown[]; closed?: unknown[]; changed?: unknown[] }): void;
    __fireTabGroupsChanged(): void;
    /** Data reaches a terminal (typing, or sendText): its state turns interacted-with and `onDidChangeTerminalState` fires once. */
    __typeInTerminal(terminal: unknown): void;
  };
}

/** A stub tree view (`window.createTreeView`) that records reveals. */
export interface FakeTreeView {
  id: string;
  visible: boolean;
  reveals: { item: unknown; options: unknown }[];
  /** Lines the extension host would log for a row it no longer knows (L1). */
  treeErrors: string[];
  /** Reveals the workbench has finished (or given up on). */
  revealsDone: number;
  /** How long the workbench takes to expand a reveal's parent rows. */
  __revealRoundTripMs: number;
  /** How long a refresh takes to reach the workbench, which then re-renders the rows. */
  __renderDelayMs: number;
  __setVisible(visible: boolean): void;
  /** The user selects rows: sets `selection` and fires the selection event. */
  __select(items: unknown[]): void;
  options: { treeDataProvider?: { getChildren(element?: unknown): Promise<unknown[]> } };
  selection: unknown[];
  title: string;
  description?: string;
  message?: string;
  badge?: { value: number; tooltip: string };
}

/** The `vscode` stub's test controls. */
export const stub = vscode as unknown as StubControls;

/** Text of every message, input prompt, or dialog shown since the last reset. */
export function shownMessages(): string[] {
  return stub.__messages.map((args) => {
    const first = args[0] as unknown;
    if (typeof first === 'string') {
      return first;
    }
    const prompt = (first as { prompt?: string } | undefined)?.prompt;
    return prompt ?? '';
  });
}

/** Whether a message containing `text` was shown since the last reset. */
export function shown(text: string): boolean {
  return shownMessages().some((message) => message.includes(text));
}

export function runCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T> {
  return vscode.commands.executeCommand<T>(id, ...args) as Promise<T>;
}

/** An in-memory `Memento` that clones values the way VS Code serializes them. */
export function memento() {
  const state = new Map<string, unknown>();
  const clone = <T>(value: T): T =>
    value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
  return {
    get: <T>(key: string, fallback?: T): T =>
      (state.has(key) ? clone(state.get(key)) : fallback) as T,
    update: async (key: string, value: unknown): Promise<void> => {
      state.set(key, clone(value));
    },
    keys: () => Array.from(state.keys()),
    setKeysForSync: () => undefined,
  };
}

/**
 * Storage over in-memory mementos. By default every harness in the repo is
 * known; pass `isKnownHarness` (usually registry membership) to model a build
 * with some switched off.
 */
export function makeStorage(
  globalState = memento(),
  workspaceState = memento(),
  isKnownHarness: (id: string) => boolean = (id) => HARNESS_IDS.includes(id)
): StorageService {
  return new StorageService({ globalState, workspaceState } as unknown as vscode.ExtensionContext, isKnownHarness);
}

/** A temp directory removed when the test ends, pass or fail. */
export function tempDir(t: { after(fn: () => void): void }, prefix = 'pitwall-'): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  // Asynchronous and retried: on Windows a background git child (the list and
  // the scan run git without blocking) can hold a folder until it exits.
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  return dir;
}

/** Links a directory. Windows junctions need no Developer Mode, and `fs.realpathSync` resolves them. */
export function dirLink(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Skips a test on Windows. The reason is required: the spec reporter prints it, so every skip is explained. */
export function skipOnWindows(reason: string): { skip: string | false } {
  return { skip: process.platform === 'win32' ? reason : false };
}

/**
 * An executable `dir/name` standing in for a harness CLI: it runs the Node
 * `fixture` with `env` set and passes its arguments through. On Windows it is
 * a `.cmd` file (CRLF) and the returned path is that file.
 */
export function fakeCli(dir: string, name: string, fixture: string, env: Record<string, string>): string {
  if (process.platform === 'win32') {
    const lines = ['@echo off'];
    for (const [key, value] of Object.entries(env)) {
      if (/["%\r\n]/.test(value)) {
        throw new Error(`fakeCli cannot pass ${key} to a .cmd file: ${value}`);
      }
      lines.push(`set "${key}=${value}"`);
    }
    lines.push(`"${process.execPath}" "${fixture}" %*`);
    const cli = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(cli, lines.join('\r\n') + '\r\n');
    return cli;
  }
  const cli = path.join(dir, name);
  const vars = Object.entries(env)
    .map(([key, value]) => `${key}='${value}' `)
    .join('');
  fs.writeFileSync(cli, `#!/bin/sh\n${vars}exec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o755 });
  return cli;
}

/** Set environment variables for one test; `undefined` unsets one. */
export function setEnv(
  t: { after(fn: () => void): void },
  values: Record<string, string | undefined>
): void {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  t.after(() => apply(saved));
}

/** Poll an explicit condition (sync or async) instead of sleeping for a fixed time. */
export async function waitFor<T>(
  condition: () => T | Promise<T>,
  what: string,
  timeoutMs = 2_000
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) {
      return value as NonNullable<T>;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Watches how long the event loop is blocked: the largest gap between runs of
 * a 1 ms interval, counted only as far as this process spent CPU in it. A
 * synchronous parse holds the loop and burns CPU for its whole length; a gap
 * where the OS ran other processes (a loaded machine, parallel test files)
 * burns almost none, so it does not count as a block.
 */
export function watchEventLoopBlocks(): { stop(): { maxBlockMs: number; maxGapMs: number } } {
  let maxBlockMs = 0;
  let maxGapMs = 0;
  let last = performance.now();
  let lastCpu = process.cpuUsage();
  const sample = () => {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const gap = now - last;
    const cpuMs = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000;
    maxGapMs = Math.max(maxGapMs, gap);
    maxBlockMs = Math.max(maxBlockMs, Math.min(gap, cpuMs));
    last = now;
    lastCpu = cpu;
  };
  const timer = setInterval(sample, 1);
  return {
    stop() {
      sample();
      clearInterval(timer);
      return { maxBlockMs, maxGapMs };
    },
  };
}

/**
 * Asserts a step does not hold the event loop for more than `maxMs`, tolerant
 * of a loaded machine. A real synchronous block shows up on EVERY run; a load
 * spike rarely hits all of them. So the step runs up to `runs` times (default
 * 3) and passes as soon as one run stays under `maxMs`; it fails only when
 * every run exceeds it. `fn` must be repeatable (build its fixtures inside).
 * `metric` is 'gap' (wall-clock gap, default) or 'block' (gap limited to this
 * process's CPU time, see watchEventLoopBlocks).
 */
export async function assertNoLongBlock(
  fn: () => Promise<void>,
  maxMs: number,
  opts: { runs?: number; label?: string; metric?: 'gap' | 'block' } = {}
): Promise<void> {
  const runs = opts.runs ?? 3;
  const metric = opts.metric ?? 'gap';
  const seen: number[] = [];
  for (let i = 0; i < runs; i++) {
    const blocks = watchEventLoopBlocks();
    try {
      await fn();
      await new Promise((resolve) => setTimeout(resolve, 5));
    } finally {
      const { maxBlockMs, maxGapMs } = blocks.stop();
      seen.push(metric === 'gap' ? maxGapMs : maxBlockMs);
    }
    if (seen[i] < maxMs) return;
  }
  throw new Error(
    `${opts.label ?? 'step'} held the event loop over ${maxMs} ms on all ${runs} runs (${metric} ms: ${seen.map((g) => g.toFixed(1)).join(', ')})`
  );
}

/** Let queued promise callbacks run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The worktree listings a fake `GitService` gives the Repos tree: the
 * blocking listing and the asynchronous one the tree renders from, both
 * answered by `list`. Spread it into a test's `gitService` fake.
 */
export function fakeWorktreeListing(
  list: (rootPath: string, repoId: string) => RepositoryWorktrees
): {
  listRepositoryWorktrees: (rootPath: string, repoId: string) => RepositoryWorktrees;
  listRepositoryWorktreesAsync: (rootPath: string, repoId: string) => Promise<RepositoryWorktrees>;
} {
  return {
    listRepositoryWorktrees: list,
    listRepositoryWorktreesAsync: async (rootPath, repoId) => list(rootPath, repoId),
  };
}

export function chatRecord(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'chat-1',
    worktreeId: 'wt-1',
    name: 'Session',
    harness: 'claude',
    harnessSessionId: null,
    createdAt: 1,
    lastAccessedAt: 1,
    status: 'idle',
    ...overrides,
  };
}

export function worktreeRecord(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    name: 'main',
    path: '/repo',
    isMain: true,
    ...overrides,
  };
}

export function sessionRecord(
  harness: HarnessId,
  sessionId: string,
  overrides: Partial<HarnessSession> = {}
): HarnessSession {
  const updated = overrides.lastUpdated?.getTime() ?? Date.now();
  return {
    harness,
    sessionId,
    cwd: '/repo',
    summary: null,
    gitBranch: null,
    lastUpdated: new Date(updated),
    lastActivity: updated,
    messageCount: 0,
    ...overrides,
  };
}

const DISPLAY_NAMES: Record<HarnessId, string> = {
  claude: 'Claude Code',
  opencode: 'opencode',
  codex: 'Codex',
  pi: 'Pi',
};

/**
 * A harness adapter with neutral defaults. The launch command is a readable
 * stand-in (`claude --resume s1`), so tests assert what the terminal received
 * without depending on any real CLI's flags.
 */
export function fakeAdapter(
  id: HarnessId,
  overrides: Partial<HarnessAdapter> = {}
): HarnessAdapter {
  return {
    id,
    displayName: DISPLAY_NAMES[id],
    icon: 'terminal',
    treeIcons: harnessTreeIcons(id),
    capabilities: {
      newSessionId: id === 'claude' || id === 'pi',
      preview: id === 'opencode' ? 'lazy' : 'inline',
    },
    isInstalled: async () => true,
    buildLaunchCommand: ({ sessionId, newSessionId, forkFromSessionId }) =>
      [
        id,
        forkFromSessionId && `--fork ${forkFromSessionId}`,
        sessionId && `--resume ${sessionId}`,
        newSessionId && `--session-id ${newSessionId}`,
      ]
        .filter(Boolean)
        .join(' '),
    isSessionResumable: async () => true,
    listSessionsForWorktree: async () => [],
    listSessionsForRepository: async () => [],
    getSessionMetadata: async () => null,
    getPreview: async () => [],
    forkSession: async () => {
      throw new Error(`${id} fork is not faked`);
    },
    prepareForkToNewWorktree: async () => {
      throw new Error(`${id} worktree fork is not faked`);
    },
    ...overrides,
  };
}

/** A search runner that is available and answers that nothing matched. */
export function fakeSearchRunner(overrides: Partial<SessionSearchRunner> = {}): SessionSearchRunner {
  return {
    suggestedModels: [],
    efforts: ['low', 'medium', 'high'],
    isAvailable: async () => true,
    run: async () => JSON.stringify({ answer: 'Nothing matched.', matches: [] }),
    ...overrides,
  };
}

/** A native-UI surface tracker whose open tabs and calls the test controls. */
export function fakeSurfaces() {
  const open = new Set<string>();
  const calls: string[] = [];
  const tracker: NativeUiSurfaceTracker = {
    onDidChange: () => ({ dispose: () => undefined }),
    expect: (sessionId, label) => calls.push(`expect:${sessionId}:${label}`),
    cancelExpect: (sessionId) => calls.push(`cancel:${sessionId}`),
    settle: (sessionId) => calls.push(`settle:${sessionId}`),
    activeSessionId: () => undefined,
    dispose: () => undefined,
    isOpen: (sessionId) => open.has(sessionId),
    closeSurface: async (sessionId) => {
      calls.push(`close:${sessionId}`);
      return open.delete(sessionId);
    },
  };
  return { tracker, open, calls };
}

/** A native UI whose availability and open results the test sets. */
export function fakeNativeUi(displayName: string, overrides: Partial<NativeUiCapability> = {}) {
  const opened: { sessionId?: string; cwd: string }[] = [];
  const surfaces = fakeSurfaces();
  const nativeUi: NativeUiCapability = {
    displayName,
    contextValueSuffix: displayName.replace(/\W/g, ''),
    extensionId: `test.${displayName.replace(/\W/g, '').toLowerCase()}`,
    isInstalled: () => true,
    checkAvailability: () => ({ kind: 'available' }),
    checkNewSessionAvailability: () => ({ kind: 'available' }),
    openNewSession: async (cwd) => {
      opened.push({ cwd });
      return { kind: 'opened', via: 'command' };
    },
    openSession: async (sessionId, cwd) => {
      opened.push({ sessionId, cwd });
      return { kind: 'opened', via: 'command' };
    },
    surfaces: surfaces.tracker,
    ...overrides,
  };
  return { nativeUi, opened, surfaces };
}
