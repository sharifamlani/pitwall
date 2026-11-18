import * as vscode from 'vscode';
import { HandoffInbox, HandoffRequest } from './HandoffInbox';
import { WindowRegistry, ownsFolder, sharedDir } from './WindowRegistry';

export interface WindowServices {
  registry: WindowRegistry;
  inbox: HandoffInbox;
  /** Settles when the first claim pass is done (at once in a window with no folder). */
  claimed: Promise<void>;
  /** Settles when the chats that first pass claimed have opened (I3: other startup work waits for it). */
  opened: Promise<void>;
}

/**
 * Without an opener (the extension passes `ChatRouter.runClaimed`), a window
 * reports each claimed request as failed, so its sender warns.
 */
const NO_OPENER = 'this build cannot open handed-off chats';

/**
 * Register this window in the shared registry (ADR 0020), at activation,
 * before the first render: a sender that raised this window must see it as
 * soon as its extension runs, not after the list has rendered, or its
 * "no window registered" retry (I2) races a window that is just starting.
 * One small file write in the background; undefined when there is no global
 * storage to share. Pass the result to `startWindowServices`.
 */
export function startWindowRegistry(context: vscode.ExtensionContext): WindowRegistry | undefined {
  try {
    if (!context.globalStorageUri) {
      return undefined;
    }
    const registry = new WindowRegistry(sharedDir(context), { pid: process.pid, folder: ownsFolder() });
    context.subscriptions.push(registry.start());
    return registry;
  } catch {
    return undefined;
  }
}

/**
 * Start the window registry (unless `early` already did) and the handoff inbox (ADR 0020). Runs after the
 * list's first render and returns at once: the first beat and the first claim
 * run in the background, and failures are logged, never thrown. The sweep of
 * old files waits for the first claim, so a window a handoff started claims
 * it first (I3). Returns undefined when there is no global storage to share.
 */
export function startWindowServices(
  context: vscode.ExtensionContext,
  log: (line: string) => void,
  onRequests?: (requests: HandoffRequest[], inbox: HandoffInbox) => unknown,
  early?: WindowRegistry
): WindowServices | undefined {
  try {
    if (!context.globalStorageUri) {
      return undefined;
    }
    const dir = sharedDir(context);
    const self = { pid: process.pid, folder: ownsFolder() };
    const registry = early ?? new WindowRegistry(dir, self);
    const inbox = new HandoffInbox(dir, self, Date.now, log);
    context.subscriptions.push(
      registry.onDidChange(() => {
        void registry.windows().then((windows) => log(`[Pitwall] window registry ${windows.length} windows`));
      }),
      ...(early ? [] : [registry.start()])
    );
    const handle =
      onRequests ??
      ((requests: HandoffRequest[]) => {
        for (const request of requests) {
          void inbox.complete(request.nonce, { ok: false, error: NO_OPENER }).catch(() => undefined);
        }
      });
    // Boxed: a promise resolved with a promise would wait for it.
    let passed: (pass: { handled: Promise<unknown> }) => void = () => undefined;
    const pass = new Promise<{ handled: Promise<unknown> }>((resolve) => (passed = resolve));
    context.subscriptions.push(inbox.watch((requests) => handle(requests, inbox), { onFirstPass: (handled) => passed({ handled }) }));
    const claimed = pass.then(() => undefined);
    const opened = pass.then(({ handled }) => handled).then(() => undefined);
    void claimed.then(() => inbox.sweep()).catch((error) => log(`[Pitwall] handoff sweep failed: ${(error as Error).message}`));
    return { registry, inbox, claimed, opened };
  } catch (error) {
    log(`[Pitwall] window services did not start: ${(error as Error).message}`);
    return undefined;
  }
}
