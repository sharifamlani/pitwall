import {
  ClaudeSessionService,
  toHarnessSession,
} from './ClaudeSessionService';
import { ClaudeAgentsService } from './ClaudeAgentsService';
import { ClaudeTurnReading } from './ClaudeTurnState';
import { ClaudeUi } from './claudeUi';
import { ClaudeSearchRunner, ClaudeSessionSearch } from './claudeSearch';
import { generateId } from '../../core/types';
import {
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

export interface ClaudeHarnessOptions {
  sessionService?: ClaudeSessionService;
  agentsService?: ClaudeAgentsService;
  nativeUi?: NativeUiCapability;
}

/**
 * Claude Code: sessions are JSONL transcripts (the only surface Claude
 * offers), new chats choose their ID up front, and needs-you comes from
 * `claude agents --json`.
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

  constructor(options: ClaudeHarnessOptions = {}) {
    this.sessionService =
      options.sessionService ?? new ClaudeSessionService();
    this.agentsService =
      options.agentsService ??
      new ClaudeAgentsService({ command: () => this.command });
    this.nativeUi = options.nativeUi ?? new ClaudeUi();
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

  async getLiveStates(
    sessionIds: string[]
  ): Promise<Map<string, HarnessLiveState>> {
    const states = new Map<string, HarnessLiveState>();
    if (sessionIds.length === 0) {
      return states;
    }

    // Start the independent transcript reads immediately; the shared agents
    // call may have to spawn the CLI and must not delay them.
    const agentsPromise = this.agentsService.getSnapshot();
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

    const { observedAt, states: agents } = await agentsPromise;
    await Promise.all(
      readings.map(async (entry) => {
        if (!entry) {
          return;
        }
        const [sessionId, filePath, reading] = entry;
        let waitingFor = agents.get(sessionId)?.waitingFor;
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
        states.set(sessionId, { ...reading, waitingFor, observedAt, ...(writtenAt !== undefined ? { writtenAt } : {}) });
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
