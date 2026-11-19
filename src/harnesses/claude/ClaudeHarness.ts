import type * as vscode from 'vscode';
import {
  ClaudeSessionService,
  toHarnessSession,
} from './ClaudeSessionService';
import { ClaudeAgentsService } from './ClaudeAgentsService';
import { ClaudeSessionFileState, ClaudeSessionsFile, ClaudeSessionsSnapshot } from './ClaudeSessionsFile';
import { ClaudeTurnReading } from './ClaudeTurnState';
import { ClaudeRepoDiscovery } from './ClaudeRepoDiscovery';
import { readLaunchFolder } from './launchFolder';
import { ClaudeUi } from './claudeUi';
import { ClaudeSearchRunner, ClaudeSessionSearch } from './claudeSearch';
import { generateId } from '../../core/types';
import {
  DiscoveredFolder,
  DiscoveryCounts,
  ForkResult,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessLiveState,
  HarnessSession,
  LaunchOptions,
  NativeUiCapability,
  PreviewMessage,
  SessionMetadata,
  SessionSearchRunner,
  SessionSearchSource,
} from '../../core/harness/types';
import { commandExists, getHarnessCommand, quoteShellArgument } from '../../core/harness/cli';
import { harnessTreeIcons } from '../../core/harness/treeIcons';

/** How long a `liveSessionIds` read stands in for the same tick's `getLiveStates` reads. */
const SHARED_READ_MS = 1_000;

export interface ClaudeHarnessOptions {
  sessionService?: ClaudeSessionService;
  agentsService?: ClaudeAgentsService;
  sessionsFile?: ClaudeSessionsFile;
  nativeUi?: NativeUiCapability;
}

/**
 * Claude Code: sessions are JSONL transcripts (the only surface Claude
 * offers), new chats choose their ID up front, and live status and needs-you
 * come from `~/.claude/sessions`, with `claude agents --json` as the fallback
 * (ADR 0018).
 */
export class ClaudeHarness implements HarnessAdapter {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly icon = 'sparkle';
  readonly treeIcons = harnessTreeIcons('claude');
  readonly capabilities: HarnessCapabilities = {
    newSessionId: true,
    preview: 'inline',
  };
  readonly nativeUi: NativeUiCapability;
  readonly sessionSearch: SessionSearchSource;
  readonly sessionSearchRunner: SessionSearchRunner;

  private readonly sessionService: ClaudeSessionService;
  private readonly agentsService: ClaudeAgentsService;
  private readonly sessionsFile: ClaudeSessionsFile;
  /** The folder read of the latest `liveSessionIds`, reused by that tick's `getLiveStates`. */
  private sharedRead: { at: number; snapshot: Promise<ClaudeSessionsSnapshot> } | undefined;
  /** Sessions the last complete `liveSessionIds` read listed. */
  private lastLiveIds = new Set<string>();
  /** The last waiting state the folder showed per session (R45 residual). */
  private readonly lastFileWaits = new Map<string, ClaudeSessionFileState>();
  /** Sessions whose wait the previous tick carried over a torn read. */
  private readonly carriedWaits = new Set<string>();
  private readonly repoDiscovery: ClaudeRepoDiscovery;

  constructor(options: ClaudeHarnessOptions = {}) {
    this.sessionService =
      options.sessionService ?? new ClaudeSessionService();
    this.agentsService =
      options.agentsService ??
      new ClaudeAgentsService({ command: () => this.command });
    this.sessionsFile = options.sessionsFile ?? new ClaudeSessionsFile();
    this.repoDiscovery = new ClaudeRepoDiscovery(this.sessionService.getProjectsDirectory(), this.sessionService);
    this.nativeUi = options.nativeUi ?? new ClaudeUi((sessionId) => this.sessionService.getEntrypoint(sessionId));
    this.sessionSearch = new ClaudeSessionSearch(this.sessionService);
    this.sessionSearchRunner = new ClaudeSearchRunner({
      command: () => this.command,
      projectsDir: () => this.sessionService.getProjectsDirectory(),
    });
  }

  get command(): string {
    return getHarnessCommand('claude', 'claude');
  }

  async isInstalled(): Promise<boolean> {
    if (this.sessionService.isClaudeInstalled()) {
      return true;
    }
    return commandExists(this.command);
  }

  buildLaunchCommand(options: LaunchOptions): string {
    const command = quoteShellArgument(this.command);

    if (options.forkFromSessionId) {
      if (!options.newSessionId) {
        throw new Error(
          'Claude Code forks require a chosen new session ID'
        );
      }
      return `${command} --resume ${quoteShellArgument(
        options.forkFromSessionId
      )} --fork-session --session-id ${quoteShellArgument(
        options.newSessionId
      )}`;
    }
    if (options.sessionId) {
      return `${command} --resume ${quoteShellArgument(options.sessionId)}`;
    }
    if (options.newSessionId) {
      return `${command} --session-id ${quoteShellArgument(
        options.newSessionId
      )}`;
    }
    return command;
  }

  /** Folders sessions ran in, from the transcripts' heads (ADR 0019). */
  discoverRecentFolders(sinceMs: number, counts?: DiscoveryCounts): Promise<DiscoveredFolder[]> {
    return this.repoDiscovery.discoverRecentFolders(sinceMs, counts);
  }

  /** The folder Claude's panel resumes a session from (Q2), read from its transcript's head. */
  async launchFolder(sessionId: string, roots: readonly string[]): Promise<string | undefined> {
    const transcript = this.sessionService.getSessionFilePath(sessionId);
    return transcript ? readLaunchFolder(transcript, roots) : undefined;
  }

  async isSessionResumable(sessionId: string): Promise<boolean> {
    return this.sessionService.isSessionResumable(sessionId);
  }
  async listSessionsForWorktree(worktreePath: string): Promise<HarnessSession[]> {
    const sessions = await this.sessionService.findSessionsForWorktree(worktreePath);
    return sessions.map(toHarnessSession);
  }

  async listSessionsForRepository(
    repoRootPath: string,
    worktreePaths: string[]
  ): Promise<HarnessSession[]> {
    const sessions = await this.sessionService.findSessionsForRepository(
      repoRootPath,
      worktreePaths
    );
    return sessions.map(toHarnessSession);
  }

  async getSessionMetadata(
    sessionId: string,
    _cwd?: string
  ): Promise<SessionMetadata | null> {
    const session = await this.sessionService.getSessionById(sessionId);
    if (!session) {
      return null;
    }

    return {
      lastActivity: session.lastPromptAt ?? session.lastUpdated?.getTime() ?? null,
      preview: session.recentUserPrompts,
      lastAsk: session.lastAsk,
      lastReply: session.lastReply,
    };
  }

  /**
   * The pid of the live process running a session, from the same
   * `~/.claude/sessions/*.json` read (`.key` files are never opened). A
   * terminal outside Pitwall and a panel in some window look alike here; the
   * caller tells them apart by what Pitwall owns (Q28). The record's `cwd`
   * names the folder, and so the window (D35), of a panel Pitwall never bound.
   */
  async liveProcessOf(sessionId: string): Promise<{ pid: number; panel: boolean; cwd?: string } | undefined> {
    const state = (await this.sessionsFile.snapshot()).states.get(sessionId);
    return state ? { pid: state.pid, panel: state.entrypoint === 'claude-vscode', ...(state.cwd ? { cwd: state.cwd } : {}) } : undefined;
  }

  /**
   * The sessions the folder lists as running, for the attention tick's poll
   * set (row status for closed chats). The read is shared with the
   * `getLiveStates` calls of the same tick. A torn read keeps the previous
   * tick's sessions for one tick, so a half-written file never drops a row's
   * status.
   */
  async liveSessionIds(): Promise<Set<string>> {
    const snapshot = this.sessionsFile.snapshot();
    this.sharedRead = { at: Date.now(), snapshot };
    const file = await snapshot;
    const ids = new Set([...file.states.keys(), ...file.unknownStatus]);
    const result = file.partial ? new Set([...ids, ...this.lastLiveIds]) : ids;
    this.lastLiveIds = file.partial ? new Set() : ids;
    return result;
  }

  /**
   * The live sessions that are busy or waiting (or whose status Pitwall does
   * not know), from the same folder read as the tick's `liveSessionIds`.
   * Claude writes a session's transcript with its first prompt, so an idle
   * session that was never prompted has nothing for discovery to find.
   */
  async liveSessionsUnderWay(): Promise<Set<string>> {
    const file = await this.readSessionsFile();
    const ids = [...file.states].filter(([, state]) => state.status !== 'idle').map(([sessionId]) => sessionId);
    return new Set([...ids, ...file.unknownStatus]);
  }

  /** Re-poll soon after a `*.json` change in `~/.claude/sessions` (150 ms debounce; `.key` files never count). */
  watchLive(onChange: () => void): vscode.Disposable {
    return this.sessionsFile.watch(onChange);
  }

  /** The folder read a `liveSessionIds` call just made, or a fresh one. */
  private readSessionsFile(): Promise<ClaudeSessionsSnapshot> {
    const shared = this.sharedRead;
    if (shared && Date.now() - shared.at < SHARED_READ_MS) {
      return shared.snapshot;
    }
    return this.sessionsFile.snapshot();
  }

  /**
   * R45 residual: a torn read (a file caught mid-write) can hide a session
   * that was waiting on the previous tick. Its previous file state stands in
   * for one tick, so the wait neither ends nor restarts (which could toast a
   * wait that was already there). A second torn read in a row falls back as
   * before.
   */
  private withCarriedWaits(file: ClaudeSessionsSnapshot, sessionIds: string[]): ClaudeSessionsSnapshot {
    let states = file.states;
    for (const sessionId of sessionIds) {
      const current = file.states.get(sessionId);
      if (current) {
        this.carriedWaits.delete(sessionId);
        if (current.status === 'waiting') {
          this.lastFileWaits.set(sessionId, current);
        } else {
          this.lastFileWaits.delete(sessionId);
        }
        continue;
      }
      const previous = this.lastFileWaits.get(sessionId);
      if (file.partial && previous && !this.carriedWaits.has(sessionId)) {
        if (states === file.states) {
          states = new Map(file.states);
        }
        states.set(sessionId, previous);
        this.carriedWaits.add(sessionId);
        continue;
      }
      this.carriedWaits.delete(sessionId);
      this.lastFileWaits.delete(sessionId);
    }
    return states === file.states ? file : { ...file, states, available: true };
  }

  async getLiveStates(
    sessionIds: string[]
  ): Promise<Map<string, HarnessLiveState>> {
    const states = new Map<string, HarnessLiveState>();
    if (sessionIds.length === 0) {
      return states;
    }

    // The sessions folder is the live source (ADR 0018). `claude agents` is
    // the fallback, per session: for all of them when the folder does not
    // count (missing, or an older CLI), for one whose file has a status
    // Pitwall does not know, and for one a torn file may be hiding. A session
    // absent from a complete, available folder is simply not running.
    const filePromise = this.readSessionsFile().then((file) => this.withCarriedWaits(file, sessionIds));
    const needsFallback = (file: ClaudeSessionsSnapshot, sessionId: string) =>
      !file.available ||
      file.unknownStatus.has(sessionId) ||
      (file.partial && !file.states.has(sessionId));
    // Start the independent transcript reads immediately; the fallback call
    // may have to spawn the CLI and must not delay them.
    const agentsPromise = filePromise.then((file) =>
      sessionIds.some((sessionId) => needsFallback(file, sessionId))
        ? this.agentsService.getSnapshot()
        : undefined
    );
    const readings = await Promise.all(
      sessionIds.map(async (sessionId): Promise<
        [string, string, ClaudeTurnReading] | null
      > => {
        // The negative cache stops a session whose transcript has not appeared
        // from rescanning every project dir on each attention tick.
        const filePath = this.sessionService.getSessionFilePath(
          sessionId,
          30_000
        );
        if (!filePath) {
          return null;
        }
        const reading = await this.sessionService.readTurnState(filePath);
        return reading ? [sessionId, filePath, reading] : null;
      })
    );

    const file = await filePromise;
    const agentsSnapshot = await agentsPromise;
    // A complete read of a folder that exists lists every running session:
    // one absent from it has no process (Q30: a death mid-turn is idle).
    const notRunning = (sessionId: string) =>
      file.listed && !file.partial && !file.states.has(sessionId) && !file.unknownStatus.has(sessionId);
    await Promise.all(
      readings.map(async (entry) => {
        if (!entry) {
          return;
        }
        const [sessionId, filePath, reading] = entry;

        if (!agentsSnapshot || !needsFallback(file, sessionId)) {
          // The file is read fresh each tick, so its status is current truth:
          // no stale-wait drop (P4). statusUpdatedAt is when the wait began;
          // it does not move during a wait, so it is only the wait's start,
          // never a reason to drop it. A wait whose file has no stamp is
          // dated by the transcript's last write instead (Q32); without
          // either it has no stamp, and never pops.
          const live = file.states.get(sessionId);
          const waiting = live?.status === 'waiting';
          let writtenAt = waiting && live.statusUpdatedAt > 0 ? live.statusUpdatedAt : undefined;
          if (waiting && writtenAt === undefined) {
            const mtime = await this.sessionService.transcriptWrittenAt(filePath);
            writtenAt = mtime === null ? undefined : Math.floor(mtime);
          }
          states.set(sessionId, {
            ...reading,
            waitingFor: waiting ? live.waitingFor : undefined,
            observedAt: file.observedAt,
            ...(writtenAt !== undefined ? { writtenAt } : {}),
            ...(live ? { liveStatus: live.status } : {}),
            ...(live && live.statusUpdatedAt > 0 ? { statusUpdatedAt: live.statusUpdatedAt } : {}),
            ...(notRunning(sessionId) ? { running: false } : {}),
          });
          return;
        }

        const { observedAt, states: agents } = agentsSnapshot;
        const agent = agents.get(sessionId);
        let waitingFor = agent?.waitingFor;
        let writtenAt: number | undefined;
        // A "waiting" row may come from a cached call up to ~10 s old. Drop it
        // when the transcript was written after that call started. This
        // relies on Claude not writing the main transcript while a prompt is
        // showing: the tool call is written just before the prompt appears,
        // and the answer (a deny's tool result, or the run after an allow)
        // is written once the prompt is gone. So a real wait survives (at
        // worst until the next call, if one started just before the tool-call
        // write), while a sample taken before a deny is dropped instead of
        // re-marking the chat. A one-off write during a wait (a resumed
        // session re-appending its metadata) only delays the mark until the
        // next call, whose start is later than the write. Subagent (sidechain) records go to their own
        // files under <session>/subagents/, so they do not touch this mtime.
        // One stat per waiting session per tick, never per agent row.
        // The same stat also tells the attention service when the wait most
        // likely began (the tool-call write).
        if (waitingFor) {
          const rawMtime = await this.sessionService.transcriptWrittenAt(filePath);
          // observedAt is whole ms but mtimeMs is fractional: compare at ms resolution, so a write in the same ms as the call counts as before it.
          const mtime = rawMtime === null ? null : Math.floor(rawMtime);
          if (mtime !== null && mtime > observedAt) {
            waitingFor = undefined;
          } else if (mtime !== null) {
            writtenAt = mtime;
          }
        }
        // A dropped wait leaves the status unknown until the next sample.
        const liveStatus = waitingFor
          ? 'waiting'
          : agent?.status === 'waiting'
            ? undefined
            : agent?.status;
        states.set(sessionId, {
          ...reading,
          waitingFor,
          observedAt,
          ...(writtenAt !== undefined ? { writtenAt } : {}),
          ...(liveStatus ? { liveStatus } : {}),
          ...(!liveStatus && notRunning(sessionId) ? { running: false } : {}),
        });
      })
    );

    return states;
  }

  async getPreview(sessionId: string, maxMessages = 3): Promise<PreviewMessage[]> {
    return this.sessionService.getSessionPreview(sessionId, maxMessages);
  }

  async forkSession(sessionId: string, _cwd?: string): Promise<ForkResult> {
    await this.requireSourceSession(sessionId);
    // Claude forks in the terminal (--fork-session) under an ID we choose.
    return { kind: 'terminal', pendingSessionId: generateId() };
  }

  dispose(): void {
    this.nativeUi.surfaces?.dispose();
    this.agentsService.dispose?.();
  }

  async prepareForkToNewWorktree(
    sessionId: string,
    _sourceWorktreePath: string,
    _destinationWorktreePath: string
  ): Promise<ForkResult> {
    await this.requireSourceSession(sessionId);
    // The fork transcript is created in the destination cwd on the first
    // prompt; there are no files to copy.
    return { kind: 'terminal', pendingSessionId: generateId() };
  }

  /** A fork that cannot resume its source can only produce a broken launch. */
  private async requireSourceSession(sessionId: string): Promise<void> {
    if (!(await this.sessionService.isSessionResumable(sessionId))) {
      throw new Error('The source Claude session no longer exists');
    }
  }
}
