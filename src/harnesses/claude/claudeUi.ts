import * as vscode from 'vscode';
import { NativeUiAvailability, NativeUiCapability, NativeUiOpenResult } from '../../core/harness/types';
import { attemptOpen, firstWorkspaceFolderAvailability } from '../../core/harness/kit/nativeUiWorkspace';
import { NativeUiTabSurfaceOptions, NativeUiTabSurfaceService } from '../../core/harness/kit/NativeUiTabSurfaceService';
import { errorMessage } from '../../core/utils/text';

const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
/** The extension's command that opens a session in its UI. */
const CLAUDE_UI_COMMAND = 'claude-vscode.editor.open';
/**
 * The documented URI handler, used when the command is unavailable. The
 * scheme is the app's own (`cursor` in Cursor): an app routes only its own
 * scheme to its extensions, so a hard-coded `vscode://` would open VS Code.
 */
const claudeUiUri = (): string => `${vscode.env.uriScheme}://anthropic.claude-code/open`;
/** The surfaces whose chats Claude's panel lists and can resume (Q23). */
const PANEL_ENTRYPOINTS: ReadonlySet<string> = new Set(['cli', 'claude-vscode']);
/** Shown by the explicit UI command for a chat the panel cannot resume (new copy, Q23). */
export const PANEL_CANNOT_RESUME =
  "Claude Code's chat panel can't resume chats made with claude -p or the SDK; opening it in a terminal.";
/** The webview view type the extension registers for its tabs. */
const CLAUDE_TAB_VIEW_TYPE = 'claudeVSCodePanel';

/**
 * Claude Code tabs carry the session title, not its ID, so a tab binds
 * through an expectation registered before a handoff (ADR 0010).
 */
export function claudeUiSurfaces(
  options: Omit<Partial<NativeUiTabSurfaceOptions>, 'matchByLabel'> = {}
): NativeUiTabSurfaceService {
  return new NativeUiTabSurfaceService({
    ...options,
    isUiTab:
      options.isUiTab ??
      ((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes(CLAUDE_TAB_VIEW_TYPE)),
    matchByLabel: true,
  });
}

/**
 * The Claude Code extension's UI. It runs in the first workspace folder, not
 * in the session's cwd, so a session from another worktree is refused. The
 * extension's command is preferred because it honors
 * `claudeCode.preferredLocation`; the documented URI is the fallback for
 * builds without it.
 */
export class ClaudeUi implements NativeUiCapability {
  readonly displayName = 'Claude Code UI';
  readonly contextValueSuffix = 'ClaudeUi';
  readonly extensionId = CLAUDE_EXTENSION_ID;
  readonly surfaces = claudeUiSurfaces();

  /**
   * @param entrypointOf A session's transcript `entrypoint` (null when no line
   *   has one, undefined when there is no transcript), from the harness's
   *   transcript reader.
   */
  constructor(private readonly entrypointOf: (sessionId: string) => Promise<string | null | undefined> = async () => undefined) {}

  /**
   * Claude's panel lists and resumes only chats started in a terminal or in
   * the panel. A `claude -p` or SDK chat (`sdk-cli`) opens as a blank
   * "Untitled" tab on every call (S3 finding F2), so it goes to the terminal.
   */
  async resumeRefusal(sessionId: string): Promise<string | undefined> {
    const entrypoint = await this.entrypointOf(sessionId);
    if (entrypoint === undefined) {
      return undefined;
    }
    return entrypoint !== null && PANEL_ENTRYPOINTS.has(entrypoint) ? undefined : PANEL_CANNOT_RESUME;
  }

  isInstalled(): boolean {
    return vscode.extensions.getExtension(CLAUDE_EXTENSION_ID) !== undefined;
  }

  checkAvailability(cwd: string): NativeUiAvailability {
    return this.isInstalled() ? firstWorkspaceFolderAvailability(cwd) : { kind: 'not-installed' };
  }

  /** A new conversation also runs in the first workspace folder. */
  checkNewSessionAvailability(cwd: string): NativeUiAvailability {
    return this.checkAvailability(cwd);
  }

  openSession(sessionId: string, cwd: string): Promise<NativeUiOpenResult> {
    return this.open(cwd, sessionId);
  }

  openNewSession(cwd: string): Promise<NativeUiOpenResult> {
    return this.open(cwd);
  }

  /**
   * A session live in this window's panel (its process is a child of this
   * extension host) whose tab Pitwall never bound (v0.6.0). The extension's
   * `claude-vscode.editor.open` with a session ID first looks the session up
   * among its open panels and the sidebar and reveals that one; it starts a
   * process only for a session no panel holds (read in extension 2.1.296's
   * `createPanel`; the W4(b) re-walk saw one process before and after, 3/3).
   * That is the extension's behaviour, not a documented contract, so only the
   * command is used: the URI fallback's behaviour for an open session is
   * unknown, and without the command this returns failed and nothing opens.
   */
  async revealOpenSession(sessionId: string, cwd: string): Promise<NativeUiOpenResult> {
    const availability = this.checkAvailability(cwd);
    if (availability.kind !== 'available') {
      return availability;
    }
    if (!(await vscode.commands.getCommands(true)).includes(CLAUDE_UI_COMMAND)) {
      return { kind: 'failed', message: `${CLAUDE_UI_COMMAND} is not available.` };
    }
    return attemptOpen(() =>
      vscode.commands.executeCommand(CLAUDE_UI_COMMAND, sessionId, undefined, undefined, undefined, undefined, {
        programmatic: 'honor-preferred-location',
      })
    );
  }

  private async open(cwd: string, sessionId?: string): Promise<NativeUiOpenResult> {
    const availability = this.checkAvailability(cwd);
    if (availability.kind !== 'available') {
      return availability;
    }

    if ((await vscode.commands.getCommands(true)).includes(CLAUDE_UI_COMMAND)) {
      return attemptOpen(() =>
        vscode.commands.executeCommand(
          CLAUDE_UI_COMMAND,
          sessionId,
          undefined,
          // Without a column the extension opens a new group on the right and
          // may lock it. The active group is where the session's terminal
          // was, or where the user's files are.
          vscode.ViewColumn.Active,
          undefined,
          undefined,
          { programmatic: 'honor-preferred-location' }
        )
      );
    }

    try {
      const base = claudeUiUri();
      const uri = sessionId ? `${base}?session=${encodeURIComponent(sessionId)}` : base;
      return (await vscode.env.openExternal(vscode.Uri.parse(uri)))
        ? { kind: 'opened', via: 'uri' }
        : { kind: 'failed', message: 'VS Code did not open the Claude Code UI.' };
    } catch (error) {
      return { kind: 'failed', message: errorMessage(error) };
    }
  }
}
