import * as vscode from 'vscode';
import { HandoffInbox, HandoffRequest } from './HandoffInbox';
import { WindowRegistry, ownsFolder, sharedDir } from './WindowRegistry';

export interface WindowServices {
  registry: WindowRegistry;
  inbox: HandoffInbox;
}

/**
 * Without an opener (the extension passes `ChatRouter.runClaimed`), a window
 * reports each claimed request as failed, so its sender warns.
 */
const NO_OPENER = 'this build cannot open handed-off chats';

/**
 * Start the window registry and the handoff inbox (ADR 0020). Runs after the
 * list's first render and returns at once: the first beat, the sweep and the
 * first claim run in the background, and failures are logged, never thrown.
 * Returns undefined when there is no global storage to share.
 */
export function startWindowServices(
  context: vscode.ExtensionContext,
  log: (line: string) => void,
  onRequests?: (requests: HandoffRequest[], inbox: HandoffInbox) => void
): WindowServices | undefined {
  try {
    if (!context.globalStorageUri) {
      return undefined;
    }
    const dir = sharedDir(context);
    const self = { pid: process.pid, folder: ownsFolder() };
    const registry = new WindowRegistry(dir, self);
    const inbox = new HandoffInbox(dir, self, Date.now, log);
    context.subscriptions.push(
      registry.onDidChange(() => {
        void registry.windows().then((windows) => log(`[Pitwall] window registry ${windows.length} windows`));
      }),
      registry.start()
    );
    const handle =
      onRequests ??
      ((requests: HandoffRequest[]) => {
        for (const request of requests) {
          void inbox.complete(request.nonce, { ok: false, error: NO_OPENER }).catch(() => undefined);
        }
      });
    context.subscriptions.push(inbox.watch((requests) => handle(requests, inbox)));
    void inbox.sweep().catch((error) => log(`[Pitwall] handoff sweep failed: ${(error as Error).message}`));
    return { registry, inbox };
  } catch (error) {
    log(`[Pitwall] window services did not start: ${(error as Error).message}`);
    return undefined;
  }
}
