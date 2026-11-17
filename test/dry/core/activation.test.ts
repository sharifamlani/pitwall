/**
 * Extension activation and terminal restore: what `activate()` waits for, and
 * what a restore start reveals in the sidebar.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { activate } from '../../../src/extension';
import { ChatSession, STORAGE_KEYS } from '../../../src/core/types';
import { PROCESS_ID_TIMEOUT_MS } from '../../../src/core/services/terminalEvents';
import { chatRecord, flush, makeStorage, memento, setEnv, stub, tempDir, waitFor } from '../support';

beforeEach(() => stub.__reset());

/** Activate the extension over seeded storage; everything it registers is disposed when the test ends. */
async function seededActivation(
  t: { after(fn: () => unknown): void },
  chats: Partial<ChatSession>[],
  pids: Record<string, number>
) {
  setEnv(t, { CLAUDE_CONFIG_DIR: tempDir(t, 'pitwall-claude-') });
  const globalState = memento();
  const workspaceState = memento();
  await globalState.update(STORAGE_KEYS.CHATS, chats.map((chat) => chatRecord(chat)));
  const seed = makeStorage(globalState, workspaceState);
  for (const [chatId, pid] of Object.entries(pids)) await seed.rememberTerminalPid(chatId, pid);
  const context = {
    subscriptions: [] as { dispose(): unknown }[],
    globalState,
    workspaceState,
    extensionUri: vscode.Uri.file('/extension'),
    extension: { id: 'sharifamlani.pitwall' },
  };
  let activation: Promise<unknown> | undefined;
  t.after(async () => {
    await activation?.catch(() => undefined);
    context.subscriptions.forEach((subscription) => subscription.dispose());
  });
  return {
    context,
    start: () => (activation = activate(context as never)),
  };
}

test('activation settles while a restored tab’s PID is still pending (R1(a))', async (t) => {
  const f = await seededActivation(t, [{ id: '40de4f00-lab', name: 'Lab ready', harnessSessionId: 'lab', status: 'active' }], {
    '40de4f00-lab': 82260,
  });
  // A reload's surviving pty whose PID the editor has not reported yet.
  stub.window.createTerminal({ name: 'Pitwall: Lab ready [40de4f]', __pid: 82260, __pidDelayMs: Infinity });

  const settled = await Promise.race([
    f.start().then(() => 'settled' as const),
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), PROCESS_ID_TIMEOUT_MS / 4)),
  ]);
  assert.equal(settled, 'settled', 'activate() does not wait for a PID read');
});

test('a chat revealed while the sidebar is hidden is revealed only once the sidebar shows and the tree settles (L1)', async (t) => {
  const f = await seededActivation(t, [{ id: '40de4f00-lab', name: 'Lab ready', harnessSessionId: 'lab', status: 'active' }], {
    '40de4f00-lab': 82260,
  });
  const lab = stub.window.createTerminal({ name: 'Pitwall: Lab ready [40de4f]', __pid: 82260 });
  await f.start();
  const view = stub.__treeViews.find((candidate) => candidate.id === 'pitwall.workspacesView')!;
  // The surviving tab is adopted (its PID is the recorded one); the user then focuses it.
  await flush();
  await flush();
  stub.window.__focusTerminal(lab);
  await flush();
  await flush();
  assert.deepEqual(view.reveals, [], 'nothing is revealed into a hidden view, whose rows do not exist yet');

  view.__setVisible(true);
  await waitFor(() => view.reveals.length > 0, 'the deferred reveal once the view shows');
  await flush();
  assert.equal(view.reveals.length, 1, 'revealed once');
});
