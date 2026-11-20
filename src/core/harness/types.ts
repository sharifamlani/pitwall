import * as vscode from 'vscode';
import { HarnessId } from '../types';

/** A user message extracted from a native session for previews. */
export interface PreviewMessage {
  text: string;
  timestamp: number | null;
}

/**
 * A folder a harness saw sessions in, for finding repos automatically
 * (ADR 0019). One entry per `cwd` spelling the harness recorded.
 */
export interface DiscoveredFolder {
  /** The sessions' working directory, as the harness recorded it. */
  cwd: string;
  /** When the newest session in this folder started: its transcript's first entry (P2). */
  firstEntryAt: number;
  /** The newest transcript write in this folder, from the file's mtime. */
  lastActivity: number;
}

/** Tallies a discovery pass adds to. */
export interface DiscoveryCounts {
  /** Session files skipped because they name no folder, or cannot be read. */
  skipped: number;
  /** Session files in the window that named a folder. */
  sessions?: number;
}

/** A session as discovered from a harness, normalized for Pitwall. */
export interface HarnessSession {
  harness: HarnessId;
  sessionId: string;
  /** Directory the session was created in (used to map it to a worktree). */
  cwd: string;
  /** Title/summary shown in the UI. */
  summary: string | null;
  /**
   * The summary is a name the user gave the session in the agent itself
   * (Claude's /rename), the name its own tab shows. It renames a chat that
   * otherwise keeps its first name, but never one renamed in Pitwall.
   */
  userTitled?: boolean;
  gitBranch: string | null;
  lastUpdated: Date | null;
  /** Timestamp of the last user prompt, when available. */
  lastActivity: number | null;
  /** Message count when the harness can provide it cheaply; 0 when unknown. */
  messageCount: number;
  /**
   * Whether the harness is mid-turn (`working`) or has finished responding
   * (`done`). Undefined when the harness cannot tell, in which case no
   * turn-end notification is sent for it.
   */
  turnState?: TurnState;
  /** Timestamp the completed turn ended at, used to notify once per turn. */
  turnEndedAt?: number | null;
  model?: string;
  agent?: string;
}

/**
 * Live turn state a harness reports for a session. Declared once so services,
 * providers, and adapters cannot drift apart when a state is added.
 */
export type TurnState = 'working' | 'done';

/** A session's live turn state plus whatever is blocking it on the user. */
export interface HarnessLiveState {
  turnState: TurnState;
  turnEndedAt: number | null;
  /** Raw harness reason, e.g. "permission prompt". Undefined when not waiting. */
  waitingFor?: string;
  /**
   * When the sample behind `waitingFor` was taken: the read time of a fresh
   * source, or the start of the (possibly cached) call that produced it.
   * Undefined means "now".
   */
  observedAt?: number;
  /**
   * The closest known time the current wait began, read alongside a waiting
   * reason: the harness's own status timestamp when it has one, else the
   * transcript's last write (Claude writes the tool call just before a prompt
   * shows).
   */
  writtenAt?: number;
  /**
   * The process status the harness reports for a running session. Undefined
   * when the session is not running or the harness does not say.
   */
  liveStatus?: 'busy' | 'waiting' | 'idle';
  /**
   * When the harness last changed `liveStatus` (Claude: the sessions file's
   * `statusUpdatedAt`). An idle status with a transcript that looks mid-turn
   * (a denied prompt) dates the turn's end from this.
   */
  statusUpdatedAt?: number;
  /**
   * False when the harness's live record, read completely, shows no process
   * for this session (it exited, or never started). A transcript that looks
   * mid-turn then means a process that died mid-turn: the row is idle, never
   * working or finished (Q30). Undefined when the harness can't tell.
   */
  running?: boolean;
}

/**
 * Visual state of a chat row in the session tree.
 *
 * `working` is the animated mark (mid-turn), `needs` is the mark plus an
 * orange dot (the agent is waiting on the user), `done` is the mark plus a
 * green dot (turn finished, terminal open), `closed` is the grey mark, and
 * `new` is the mark plus a hollow ring for a chat the harness has not linked
 * yet.
 */
export type HarnessIconState = 'working' | 'needs' | 'finished' | 'idle' | 'new';

/** Extension-relative SVG paths for each theme and tree state. */
export interface HarnessTreeIcons {
  light: Record<HarnessIconState, string>;
  dark: Record<HarnessIconState, string>;
}

/** Metadata used to render a chat row and its tooltip. */
export interface SessionMetadata {
  lastActivity: number | null;
  /** Last few user prompts, oldest first. */
  preview: PreviewMessage[];
  /** Most recent user prompt, when it is not already in `preview`. */
  lastAsk?: PreviewMessage | null;
  /** Most recent assistant text, skipping tool-only turns. */
  lastReply?: PreviewMessage | null;
  /** Total messages in the conversation, when known. */
  messageCount?: number;
  model?: string;
  agent?: string;
}

export interface LaunchOptions {
  worktreePath: string;
  /** Resume this native session. */
  sessionId?: string | null;
  /**
   * A caller-chosen ID for a session that does not exist yet. Harnesses that
   * assign their own IDs ignore it.
   */
  newSessionId?: string | null;
  /** Fork this native session using the harness's terminal fork flag. */
  forkFromSessionId?: string | null;
}

/**
 * How a fork was created. `linked` means the harness returned a new session
 * ID to resume; `terminal` means the harness forks in the terminal under an
 * ID the caller chose, which the watcher then links.
 */
export type ForkResult =
  | { kind: 'linked'; sessionId: string }
  | { kind: 'terminal'; pendingSessionId: string };

export interface HarnessCapabilities {
  /** Accepts a caller-chosen ID for a new session. */
  newSessionId: boolean;
  /**
   * How previews are obtained. `inline` means they arrive with session
   * metadata (cheap); `lazy` means fetching them is expensive and should
   * happen only when the user asks for them.
   */
  preview: 'inline' | 'lazy';
}

/**
 * A harness's native graphical UI, when it has one. The CLI remains the
 * default launch path; this capability only adds an explicit handoff for an
 * existing session.
 */
export interface NativeUiCapability {
  /** Human-readable surface name, for messages. */
  displayName: string;
  /**
   * Suffix appended to a chat row's context value so a menu can target rows
   * whose adapter has this UI. The provider never names a harness.
   */
  contextValueSuffix: string;
  /** Marketplace extension ID, used to point the user at an install. */
  extensionId: string;
  /** Whether the extension that provides the UI is installed. */
  isInstalled(): boolean;
  /**
   * Whether this cwd can be handed to the UI. Callers check this before
   * stopping a running terminal; `openSession` checks it again so a folder
   * change between the two calls cannot open the wrong tree.
   */
  checkAvailability(cwd: string): NativeUiAvailability;
  /**
   * Whether a brand-new conversation can start in this UI from `cwd`. New
   * sessions are more constrained than existing ones: the extension chooses
   * the workspace folder itself, so only the folder it uses is safe.
   */
  checkNewSessionAvailability(cwd: string): NativeUiAvailability;
  /**
   * Open a brand-new conversation in the UI. The extension assigns the native
   * session ID and creates the transcript on the first prompt; callers keep a
   * placeholder chat and let the session importer link it.
   */
  openNewSession(cwd: string): Promise<NativeUiOpenResult>;
  /** Open an existing, resumable session in the UI. */
  openSession(sessionId: string, cwd: string): Promise<NativeUiOpenResult>;
  /**
   * Bring forward a session already live in this window's UI, by a route
   * known to reveal its existing tab rather than start a process. Absent, or
   * not 'opened', when that can't be guaranteed: the caller opens nothing.
   */
  revealOpenSession?(sessionId: string, cwd: string): Promise<NativeUiOpenResult>;
  /**
   * Why this UI cannot resume a session the agent's CLI can (for Claude, a
   * chat started by `claude -p` or the SDK), as a sentence for the user;
   * undefined when it can, or when the session is unknown. A click then
   * opens the terminal instead, and the explicit UI command says why (Q23).
   */
  resumeRefusal?(sessionId: string): Promise<string | undefined>;
  /**
   * Tracks native-UI tabs for this adapter's sessions. A tracker either reads
   * the session ID from the tab (Codex's conversation editor) or binds a tab
   * to an expectation registered before a handoff (Claude's webview tab has
   * no ID).
   */
  readonly surfaces?: NativeUiSurfaceTracker;
}

/**
 * A restored tab's first visit lasts at most this long after its webview was
 * first shown, and a Ctrl+↓/↑ first-visit retry fires no later than this after
 * the press (Q43). By then the webview has loaded (S1: last focus movement at
 * ≤ 556 ms).
 */
export const RESTORED_DEADLINE_CAP_MS = 1_200;

/**
 * Maps native-UI tabs to native session IDs. The tree, attention service, and
 * active-row logic resolve that ID back to a chat, so the tracker stays free
 * of stored state.
 */
export interface NativeUiSurfaceTracker extends vscode.Disposable {
  /** Fires when a tracked surface opens/closes or the active session changes. */
  readonly onDidChange: vscode.Event<void>;
  /**
   * Associate the next surface opened for this native session. A tracker that
   * reads the ID from the tab has nothing to claim and may ignore this. A tab
   * that was already there when this is called binds only by its title,
   * never as "the only expected chat" (live I1b).
   */
  expect(sessionId: string, label: string): void;
  /** Drop an expectation when the open did not happen. */
  cancelExpect(sessionId: string): void;
  /**
   * Associate the active surface after a successful open. `allowActiveFallback`
   * lets a command bind the active tab even when its title was truncated
   * differently from the chat name; a background link must not, because the
   * active tab may belong to another conversation.
   */
  settle(
    sessionId: string,
    options?: { allowActiveFallback?: boolean }
  ): void;
  /** The native session whose surface is the active editor tab, if any. */
  activeSessionId(): string | undefined;
  /**
   * When the active editor tab opened in this window, if it is one of this
   * harness's tabs that no session is bound to yet (a brand-new chat's tab
   * before it binds): the user may be watching a chat Pitwall cannot name yet
   * (PR #73). Undefined when the active tab is bound, is not this harness's,
   * or was already there when the tracker started (a restored tab has no
   * open time, so it can never stand for a new chat).
   */
  activeUnboundTabOpenedAt?(): number | undefined;
  /** Whether this native session currently has an open native-UI tab. */
  isOpen(sessionId: string): boolean;
  /**
   * Close this session's tab. Used when the user switches an open session
   * back to a terminal, so two agent processes cannot run at once.
   */
  closeSurface(sessionId: string): Promise<boolean>;
  /**
   * Open sessions one after another, binding each new tab to the session
   * just requested (a tracker that reads the ID from the tab needs no help).
   * `open` resolving false means nothing opened, so there is no tab to wait for.
   */
  openSerially?(
    sessionIds: string[],
    open: (sessionId: string) => Promise<unknown>,
    token?: vscode.CancellationToken
  ): Promise<Map<string, vscode.Tab | undefined>>;
  /** Every tab group with its tabs' labels, pinned flags and bound sessions (the dump). */
  describeTabs?(): NativeUiTabGroupState[];
  /** Turn the tab trace (every raw tab and group event, each bind decision) on or off; returns the new state. */
  toggleTrace?(): boolean;
  /** Resolve true when one of this harness's tabs closes (the last step of a move), or false after `timeoutMs`. */
  whenTabMoved?(timeoutMs: number): Promise<boolean>;
  /**
   * Start adopting tabs Pitwall did not open (restored after a reload or a
   * relaunch, reopened by the editor's session restore, opened before
   * activation): an unbound tab whose title names exactly one of these
   * sessions, and no other unbound tab names it, is bound to it. `ready`
   * settles once the titles are complete enough to trust (the window
   * folder's session listing); `adoptBeforeOpen` waits for it.
   */
  setTitleSource?(source: () => readonly NativeUiTitleCandidate[], ready?: Promise<unknown>): void;
  /** Run adoption now (the titles changed). */
  adopt?(): void;
  /** Before an open: wait at most `timeoutMs` for the titles, then adopt, so an open never misses a tab already there. */
  adoptBeforeOpen?(timeoutMs?: number): Promise<void>;
  /**
   * Whether this is the first visit since launch of a tab restored before
   * activation: one of this harness's tabs that was there at activation and
   * not shown then, whose first visit has not ended. A visit starts when the
   * tab is first shown and ends when `endFirstVisit` is called (the hold on it
   * finished) or RESTORED_DEADLINE_CAP_MS after it started. Keyed on the Tab,
   * not a session: restored tabs are often unbound. Its webview loads on this
   * visit and takes focus late (E11).
   */
  isFirstVisitSinceLaunch?(tab: vscode.Tab): boolean;
  /** The Ctrl+↓/↑ hold on this tab finished (its retry fired or it let go): its first visit is over. */
  endFirstVisit?(tab: vscode.Tab): void;
  /**
   * The Tab object the editor has now for a tab the Ctrl+↓/↑ hold is on: the
   * tab itself while it is present; after a re-sent tab model (Cursor
   * replaces every Tab object), its replacement, paired as the bindings are;
   * undefined once it closed or was left unpaired. Logs on the tab trace
   * when it follows a replacement (live E12).
   */
  followHeldTab?(tab: vscode.Tab): vscode.Tab | undefined;
}

/** A session a tab may belong to, and the titles its tab can show (its agent's title, its row name). */
export interface NativeUiTitleCandidate {
  sessionId: string;
  titles: readonly string[];
}

/** One tab group as the dump reads it. */
export interface NativeUiTabGroupState {
  index: number;
  isActive: boolean;
  tabs: { label: string; pinned: boolean; active: boolean; sessionId: string | undefined }[];
}

/** Why a session cannot be handed to the native UI. */
export type NativeUiUnavailable =
  | { kind: 'not-installed' }
  | { kind: 'no-workspace' }
  | { kind: 'workspace-mismatch'; uiCwd: string }
  | { kind: 'workspace-multi-root'; uiCwd: string };

/** Whether the native UI can open a session in this cwd right now. */
export type NativeUiAvailability =
  | { kind: 'available' }
  | NativeUiUnavailable;

/** What happened when Pitwall asked a harness to open a session in its UI. */
export type NativeUiOpenResult =
  | { kind: 'opened'; via: 'command' | 'uri' }
  | NativeUiUnavailable
  | { kind: 'failed'; message: string };

/**
 * A harness whose sessions the session finder can search. The finder is an
 * agent with read-only file tools, so a source describes where its sessions
 * live and how to read them; it never runs code of its own during a search.
 */
export interface SessionSearchSource {
  /**
   * Materialize records that are not readable files, such as opencode's
   * database, into the search's own folder, and return the instructions for
   * that view. Called once per search before the prompt is built; the view
   * is removed with the folder, and a failure drops this harness from that
   * search instead of failing all of it.
   */
  prepare?(options: { cwd: string; signal: AbortSignal }): Promise<string>;
  /**
   * Search instructions for the agent: where the records are, how to tell
   * the user's own prompts from injected context, and what to skip.
   * `excludedCwds` are folders whose records belong to the search itself.
   */
  instructions(options: { excludedCwds: string[] }): string;
  /** Directories the agent must be able to read. */
  readableDirs(): string[];
  /**
   * The session the agent named, read back from the harness's own record,
   * with the user's prompt that `quote` comes from. Null when the session
   * does not exist; `prompt` is absent when the quote is not one of the
   * user's prompts in it.
   */
  verify(sessionId: string, quote: string): Promise<{ session: HarnessSession; prompt?: PreviewMessage } | null>;
}

/** One headless search conversation. */
export interface SessionSearchRunRequest {
  /** The first message, including the JSON Schema the reply must match. */
  prompt: string;
  /** Empty means the model configured in the harness. */
  model: string;
  /** Empty means the effort configured in the harness. */
  effort: string;
  /** A folder of the search's own, used as the agent's working directory. */
  cwd: string;
  /** Directories the agent may read besides `cwd`. */
  readableDirs: string[];
  signal: AbortSignal;
  /** A short description of each step the agent takes, as it takes it. */
  onActivity(step: string): void;
  /**
   * Called with each reply. Returns the next message for the same agent, in
   * the same conversation, or undefined when the reply is final.
   */
  followUp(reply: string): string | undefined;
}

/** A harness whose CLI can run the session finder. */
export interface SessionSearchRunner {
  /** Models offered in the picker besides the harness's configured one; the user may type any other. */
  readonly suggestedModels: readonly string[];
  /** Effort levels the CLI accepts, lowest first. */
  readonly efforts: readonly string[];
  /**
   * Whether the CLI this runner spawns is available now. A harness can have
   * a profile and sessions without its CLI on PATH, so a search must probe
   * the executable rather than the adapter's install state.
   */
  isAvailable(): Promise<boolean>;
  /**
   * Hold one conversation with read-only file tools and no saved session:
   * the prompt, then each `followUp()` message, and remove anything the CLI
   * wrote for `cwd`. Resolves with the agent's final reply as text, which the
   * caller parses and validates. Rejects when the CLI fails or the signal
   * aborts.
   */
  run(request: SessionSearchRunRequest): Promise<string>;
}

/**
 * A CLI coding harness (Claude Code, opencode, ...).
 *
 * Implementations must not read the harness's internal database directly;
 * prefer the harness's documented CLI/API so schema changes don't break us.
 */
export interface HarnessAdapter {
  readonly id: HarnessId;
  readonly displayName: string;
  /** Codicon id for the harness's terminal tabs. */
  readonly icon: string;
  /** Generated marks for session rows, per theme and state. */
  readonly treeIcons: HarnessTreeIcons;
  readonly capabilities: HarnessCapabilities;

  /** Whether the harness CLI/data is available. Cached by the registry. */
  isInstalled(): Promise<boolean>;

  /** Full shell command used by TerminalManager. */
  buildLaunchCommand(options: LaunchOptions): string;

  /** Whether the harness can resume this session (checked before launching). */
  isSessionResumable(sessionId: string, cwd?: string): Promise<boolean>;

  listSessionsForWorktree(
    worktreePath: string,
    force?: boolean
  ): Promise<HarnessSession[]>;
  listSessionsForRepository(
    repoRootPath: string,
    worktreePaths: string[]
  ): Promise<HarnessSession[]>;

  /**
   * One session by ID, read from its own record alone (Claude: its one
   * transcript), so a new live session can be listed without a full scan.
   * Null while the record does not exist or does not place the session in a
   * folder yet. Undefined (not implemented) sends callers to a full scan.
   */
  getSession?(sessionId: string): Promise<HarnessSession | null>;

  /**
   * Live state for specific sessions, when the harness has a cheaper way to
   * answer than a full discovery pass. The attention tick prefers this.
   * `cwd` scopes a harness whose record lookup depends on the working
   * directory. Sessions without a readable native record are omitted.
   */
  getLiveStates?(
    sessionIds: string[],
    cwd?: string
  ): Promise<Map<string, HarnessLiveState>>;

  /**
   * Native sessions running right now by the harness's own live record
   * (Claude: `~/.claude/sessions`), cheap enough for every attention tick.
   * The tick polls these besides the open chats, so a closed chat's row
   * still gets a live status. Undefined when the harness has no such record.
   */
  liveSessionIds?(): Promise<Set<string> | undefined>;

  /**
   * The live sessions whose turn is under way (busy or waiting, or a status
   * Pitwall does not know), from the same record as `liveSessionIds`. A
   * session that has never been prompted has no transcript yet, so discovery
   * has nothing to find; the attention service asks discovery about an
   * unlisted session only once its first turn starts. Undefined when the
   * harness cannot tell; every unlisted live session is then asked about.
   */
  liveSessionsUnderWay?(): Promise<Set<string> | undefined>;

  /**
   * Calls `onChange` soon after the harness's live record changes (Claude: a
   * `*.json` event in `~/.claude/sessions`, debounced 150 ms), so the
   * attention service re-polls at once instead of on its next 4 s tick.
   * Watching reads and writes nothing. Undefined when the harness has no
   * such record.
   */
  watchLive?(onChange: () => void): vscode.Disposable;

  /**
   * The live agent process running a native session on this machine, by the
   * harness's own record (Claude: a `~/.claude/sessions/*.json` entry whose
   * pid is alive). Only the pid is returned, and whether the harness's own
   * editor panel (not a terminal) started it. Pitwall uses it to refuse a
   * second process for a chat that runs in a terminal it doesn't own (Q28).
   * `cwd`, when the record has one, is the process's folder: for a panel,
   * the folder of the window it runs in (D35). `startedAt`, when the record
   * has one, is when the process started: with the pid it names one process,
   * since the OS reuses pids.
   */
  liveProcessOf?(sessionId: string): Promise<{ pid: number; panel: boolean; cwd?: string; startedAt?: number } | undefined>;

  /**
   * Whether the harness's own editor panel (not a terminal) runs this
   * session, by the last live record read (the attention tick's): a sync
   * read for pop-up checks. Undefined when the record does not list the
   * session or does not say where it started (PR #73, QA round 3).
   */
  isPanelSession?(sessionId: string): boolean | undefined;

  /**
   * The folder a session's window is (Q2): the one its agent's UI resumes it
   * from, among `roots` (its repo's main folder and worktrees). Undefined when
   * the harness can't tell; the caller then uses the chat's worktree.
   */
  launchFolder?(sessionId: string, roots: readonly string[]): Promise<string | undefined>;

  /**
   * Metadata for a chat row. Implementations should prefer cached data and
   * return quickly; opencode previews are populated by getPreview lazily.
   * `cwd` lets the adapter locate a session that is not in its cache.
   */
  getSessionMetadata(sessionId: string, cwd?: string): Promise<SessionMetadata | null>;

  /** Last few user prompts, newest last. */
  getPreview(sessionId: string, maxMessages?: number): Promise<PreviewMessage[]>;

  /** Fork a conversation. */
  forkSession(sessionId: string, cwd?: string): Promise<ForkResult>;

  /** The harness's native graphical UI, when it has one. */
  readonly nativeUi?: NativeUiCapability;

  /** Lets the session finder search this harness's sessions. */
  readonly sessionSearch?: SessionSearchSource;

  /** Lets this harness's CLI run the session finder. */
  readonly sessionSearchRunner?: SessionSearchRunner;

  /**
   * Prepare a fork into a brand-new worktree. The result is either a session
   * already forked into the destination cwd (`linked`) or a pending ID that
   * the destination terminal's launch forks into (`terminal`).
   */
  prepareForkToNewWorktree(
    sessionId: string,
    sourceWorktreePath: string,
    destinationWorktreePath: string
  ): Promise<ForkResult>;

  /**
   * Folders with a session file written at or after `sinceMs`, so Pitwall can
   * list their repos without being told (ADR 0019). Files that name no folder
   * or cannot be read are left out and counted in `counts.skipped`.
   */
  discoverRecentFolders?(sinceMs: number, counts?: DiscoveryCounts): Promise<DiscoveredFolder[]>;

  /** Release long-lived resources such as child processes or caches. */
  dispose?(): void;
}

/** Watches for newly-created native sessions and links them to pending chats. */
export interface HarnessSessionWatcher extends vscode.Disposable {
  readonly harness: HarnessId;
  readonly onChatNameUpdated: vscode.Event<{ chatId: string; name: string }>;
  startWatching(): void;
  registerPendingChat(chatId: string, worktreePath: string): void | Promise<void>;
}
