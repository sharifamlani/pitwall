import * as path from 'path';
import * as vscode from 'vscode';
import { ChatSession } from '../types';
import { quoteShellArgument } from '../harness/cli';

/** How long to wait for a terminal's pty before giving up on its PID. */
export const PROCESS_ID_TIMEOUT_MS = 2000;
/** How long to let `show()` settle before renaming the active terminal. */
const ACTIVE_TERMINAL_TIMEOUT_MS = 1000;

const TITLE_PREFIX = 'Pitwall: ';

/**
 * A chat terminal's title, `Pitwall: <name> [<shortId>]`. The short ID is the
 * identity that survives a quit (ADR 0009).
 */
export function terminalTitle(chat: ChatSession): string {
  return `${TITLE_PREFIX}${chat.name} [${chat.id.substring(0, 6)}]`;
}

/** The chat short ID in a Pitwall title; null for a terminal Pitwall does not own. */
export function titleShortId(terminalName: string): string | null {
  if (!terminalName.startsWith(TITLE_PREFIX)) {
    return null;
  }
  return terminalName.match(/\[([a-f0-9]{6})\]$/)?.[1] ?? null;
}

/**
 * Whether a terminal still owns a running process. VS Code keeps a terminal
 * listed after its process exits (the tab keeps its last output), so presence
 * alone does not mean the session is open.
 */
export function isLiveTerminal(terminal: vscode.Terminal): boolean {
  return vscode.window.terminals.includes(terminal) && terminal.exitStatus === undefined;
}

/** The shell syntax a terminal line has to parse in. */
export type ShellKind = 'posix' | 'powershell' | 'cmd';

/**
 * Which syntax a shell executable reads. No shell path means VS Code's own
 * default: PowerShell on Windows, a POSIX shell elsewhere.
 */
export function shellKind(shellPath: string | undefined): ShellKind {
  if (!shellPath) {
    return process.platform === 'win32' ? 'powershell' : 'posix';
  }
  const name = path.win32.basename(shellPath).toLowerCase();
  if (['powershell.exe', 'powershell', 'pwsh.exe', 'pwsh'].includes(name)) {
    return 'powershell';
  }
  if (name === 'cmd.exe' || name === 'cmd') {
    return 'cmd';
  }
  return 'posix';
}

/**
 * PowerShell reads a line that starts with a quoted string (a quoted full
 * path to the CLI) as a value, not a command; the call operator runs it.
 */
function withCallOperator(command: string): string {
  return /^['"]/.test(command) ? `& ${command}` : command;
}

/**
 * A launch command as a terminal line for the given shell. Only PowerShell
 * needs a change; bash and cmd.exe run it as built.
 */
export function launchLine(
  command: string,
  // The default profile's shell, as for `commandInDirectory` below.
  shellPath: string | undefined = vscode.env.shell
): string {
  return shellKind(shellPath) === 'powershell' ? withCallOperator(command) : command;
}

/**
 * Change directory and launch as one shell line: a revived tab's shell starts
 * in the workspace root, the command-start event then covers the launch, and
 * a failed `cd` cannot start an agent in the wrong worktree. The line is
 * written for the shell it lands in: Windows PowerShell 5.1, the default
 * terminal on Windows, cannot parse `&&`.
 */
export function commandInDirectory(
  directory: string,
  command: string,
  // A revived tab keeps the shell it was created with; this uses the current default profile because Pitwall creates its tabs with it (a default changed between sessions is out of scope for v1).
  shellPath: string | undefined = vscode.env.shell
): string {
  switch (shellKind(shellPath)) {
    case 'powershell':
      return `Set-Location -LiteralPath '${directory.replace(/'/g, "''")}'; if ($?) { ${withCallOperator(command)} }`;
    case 'cmd':
      return `cd /d "${directory}" && ${command}`;
    default:
      return `cd ${quoteShellArgument(directory)} && ${command}`;
  }
}

/**
 * Settle on the first matching event or the timeout, and always release the
 * listener and timer.
 */
export function waitForEvent<T>(
  timeoutMs: number,
  onTimeout: T,
  subscribe: (done: (value: T) => void) => vscode.Disposable
): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    let disposable: vscode.Disposable | undefined;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      disposable?.dispose();
      resolve(value);
    };
    const timer = setTimeout(() => finish(onTimeout), timeoutMs);
    disposable = subscribe(finish);
    if (settled) {
      disposable.dispose();
    }
  });
}

/** A terminal's pty PID, bounded so activation cannot hang on one that never reports. */
export function readProcessId(
  terminal: vscode.Terminal,
  timeoutMs = PROCESS_ID_TIMEOUT_MS
): Promise<number | undefined> {
  return waitForProcessId(terminal.processId, timeoutMs);
}

/**
 * Wait, bounded, on a PID read that is already under way. A caller that gave
 * up on a read can keep waiting on the same one instead of reading again.
 */
export function waitForProcessId(
  processId: Thenable<number | undefined>,
  timeoutMs = PROCESS_ID_TIMEOUT_MS
): Promise<number | undefined> {
  return waitForEvent<number | undefined>(timeoutMs, undefined, (done) => {
    Promise.resolve(processId).then(done, () => done(undefined));
    return { dispose: () => undefined };
  });
}

/**
 * Wait until the command sent into a terminal has started. Shell integration
 * reports the working directory as the shell starts and again as a command
 * starts, and each report re-tags the title as a config title, which a quit
 * then lets the revived shell overwrite. A rename after the command starts is
 * the one VS Code persists. False when no command start is reported (no
 * integration), which is also when the title never needs re-applying.
 */
export function waitForCommandStart(terminal: vscode.Terminal, timeoutMs: number): Promise<boolean> {
  return waitForEvent<boolean>(timeoutMs, false, (done) =>
    vscode.window.onDidStartTerminalShellExecution((event) => {
      if (event.terminal === terminal) {
        done(true);
      }
    })
  );
}

/**
 * Wait, with no time limit, for the first command to start in a terminal:
 * true when one starts, false once the terminal closes or the watch is
 * cancelled. For background work that must happen however late a slow shell
 * starts. Create it before sending the command, which can start at once.
 */
export function watchCommandStart(terminal: vscode.Terminal): { started: Promise<boolean>; cancel(): void } {
  const subscriptions: vscode.Disposable[] = [];
  let finish: (value: boolean) => void = () => undefined;
  const started = new Promise<boolean>((resolve) => {
    finish = (value) => {
      subscriptions.forEach((subscription) => subscription.dispose());
      subscriptions.length = 0;
      resolve(value);
    };
  });
  subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution((event) => {
      if (event.terminal === terminal) {
        finish(true);
      }
    }),
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) {
        finish(false);
      }
    })
  );
  return { started, cancel: () => finish(false) };
}

/** Whether VS Code's shell integration setting is on. */
export function shellIntegrationEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('terminal.integrated')
    .get<boolean>('shellIntegration.enabled', true);
}

/**
 * Wait until a terminal's shell reports integration, or give up. Only an
 * integrated shell makes VS Code re-tag the title from a cwd report.
 */
export function waitForShellIntegration(terminal: vscode.Terminal, timeoutMs: number): Promise<boolean> {
  if (!shellIntegrationEnabled()) {
    return Promise.resolve(false);
  }
  if (terminal.shellIntegration) {
    return Promise.resolve(true);
  }
  return waitForEvent(timeoutMs, false, (done) =>
    vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === terminal) {
        done(true);
      }
    })
  );
}

/** How a wait for a shell to be ready to read a typed line ended. */
export type ShellReadiness = 'ready' | 'off' | 'cap' | 'closed';

/**
 * Wait until a terminal's shell can read a typed line: its shell integration
 * has activated. A line typed into a shell that is still starting can be lost
 * (a revived Windows PowerShell 5.1 can take many seconds to start).
 * - `ready`: integration is active, now or later.
 * - `off`: at once, because the setting turns integration off, so there is
 *   nothing to wait for.
 * - `cap`: integration never arrived within `capMs` (a broken shell, or a
 *   policy that blocks the integration script).
 * - `closed`: the tab closed or the watch was cancelled.
 */
export function watchShellReady(
  terminal: vscode.Terminal,
  capMs: number
): { ready: Promise<ShellReadiness>; cancel(): void } {
  if (!shellIntegrationEnabled()) {
    return { ready: Promise.resolve('off'), cancel: () => undefined };
  }
  // Revived tabs report integration restored from the previous session, so this passes at once for them.
  if (terminal.shellIntegration) {
    return { ready: Promise.resolve('ready'), cancel: () => undefined };
  }
  const subscriptions: vscode.Disposable[] = [];
  let finish: (value: ShellReadiness) => void = () => undefined;
  const ready = new Promise<ShellReadiness>((resolve) => {
    let settled = false;
    finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscriptions.forEach((subscription) => subscription.dispose());
      subscriptions.length = 0;
      resolve(value);
    };
  });
  const timer = setTimeout(() => finish('cap'), capMs);
  subscriptions.push(
    vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === terminal) {
        finish('ready');
      }
    }),
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) {
        finish('closed');
      }
    })
  );
  return { ready, cancel: () => finish('closed') };
}

/**
 * Wait for a terminal that was just shown to become active. The rename command
 * targets the active tab, and `show()` crosses process boundaries
 * asynchronously.
 */
export function waitForActive(terminal: vscode.Terminal): Promise<void> {
  if (vscode.window.activeTerminal === terminal) {
    return Promise.resolve();
  }
  return waitForEvent<void>(ACTIVE_TERMINAL_TIMEOUT_MS, undefined, (done) =>
    vscode.window.onDidChangeActiveTerminal((active) => {
      if (active === terminal) {
        done(undefined);
      }
    })
  );
}
