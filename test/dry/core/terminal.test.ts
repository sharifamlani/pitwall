/**
 * TerminalManager: what a launch sends, what a closed terminal leaves behind,
 * and how terminals are reconciled after a reload (the pty survives) or a quit
 * (VS Code revives the tab as a new shell). See ADR 0009.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { RESTORED_SHELL_TIMEOUT_MS, REVIVED_SHELL_READY_CAP_MS, TerminalManager } from '../../../src/core/services/TerminalManager';
import { PROCESS_ID_TIMEOUT_MS, terminalTitle } from '../../../src/core/services/terminalEvents';
import { quoteShellArgument } from '../../../src/core/harness/cli';
import { HarnessRegistry } from '../../../src/core/harness/HarnessRegistry';
import { ClaudeHarness } from '../../../src/harnesses/claude/ClaudeHarness';
import { HarnessAdapter } from '../../../src/core/harness/types';
import { ChatSession, STORAGE_KEYS } from '../../../src/core/types';
import { chatRecord, fakeAdapter, FakeTerminal, flush, makeStorage, memento, shown, stub, waitFor, worktreeRecord } from '../support';

beforeEach(() => stub.__reset());

/** Spaces force the restore path to quote the directory it changes into. */
const WORKTREE = worktreeRecord({ path: '/work/repo with space' });

function setup(
  t: { after(fn: () => void): void },
  options: { chats?: Partial<ChatSession>[]; adapter?: Partial<HarnessAdapter> } = {}
) {
  const globalState = memento();
  void globalState.update(
    STORAGE_KEYS.CHATS,
    (options.chats ?? []).map((chat) => chatRecord({ worktreeId: WORKTREE.id, ...chat }))
  );
  const storage = makeStorage(globalState);
  const registrations: string[] = [];
  const adapter = fakeAdapter('claude', { icon: 'sparkle', ...options.adapter });
  const manager = new TerminalManager(storage, new HarnessRegistry([adapter]), {
    registerPendingChat: (_harness: string, chatId: string, worktreePath: string) =>
      registrations.push(`${chatId}@${worktreePath}`),
  } as never);
  t.after(() => manager.dispose());

  vscode.commands.registerCommand('pitwall.refreshWorkspaces', () => undefined);
  // The rename command targets whichever terminal is active, like the workbench.
  vscode.commands.registerCommand('workbench.action.terminal.renameWithArg', (arg: { name: string }) => {
    if (stub.window.activeTerminal) stub.window.activeTerminal.name = arg.name;
  });

  return {
    storage,
    manager,
    registrations,
    chat: (id: string) => storage.getChat(id)!,
    open: async (id: string) => (await manager.openChat(storage.getChat(id)!, WORKTREE)) as FakeTerminal | undefined,
    /** A tab already in the window at activation, with its own pty. */
    restoredTab: (name: string, pid: number, exited = false) =>
      stub.window.createTerminal({ name, __pid: pid, __exitStatus: exited ? { code: 0 } : undefined }),
    close: (terminal: FakeTerminal) => {
      terminal.dispose();
      stub.window.__fireDidCloseTerminal(terminal);
    },
  };
}

test('a launch resumes, starts, or repeats a fork depending on what the harness already has', async (t) => {
  const cases: [Partial<ChatSession>, string][] = [
    [{}, 'claude'],
    [{ pendingHarnessSessionId: 'chosen' }, 'claude --session-id chosen'],
    [{ pendingHarnessSessionId: 'written' }, 'claude --resume written'],
    [{ pendingHarnessSessionId: 'chosen', forkedFromSessionId: 'source' }, 'claude --fork source --session-id chosen'],
    [{ pendingHarnessSessionId: 'written', forkedFromSessionId: 'source' }, 'claude --resume written'],
    [{ harnessSessionId: 'linked' }, 'claude --resume linked'],
  ];
  const f = setup(t, {
    chats: cases.map(([chat], i) => ({ id: `chat-${i}`, name: `Chat ${i}`, ...chat })),
    adapter: { isSessionResumable: async (id) => id === 'written' || id === 'linked' },
  });

  for (const [i, [chat, expected]] of cases.entries()) {
    assert.equal((await f.open(`chat-${i}`))?.sent[0], expected, JSON.stringify(chat));
  }

  const terminal = f.manager.getTerminal('chat-5') as unknown as FakeTerminal;
  assert.deepEqual([terminal.options.cwd, terminal.options.iconPath?.id], [WORKTREE.path, 'sparkle']);
  assert.equal(terminal.name, 'Pitwall: Chat 5 [chat-5]', 'the title is applied once the command runs');
  assert.equal(f.chat('chat-5').status, 'active');
  assert.equal(f.storage.getTerminalPids()['chat-5'], terminal.__pid, 'the pty is recorded for a reload');
  assert.equal(f.manager.getChatIdForTerminalName(terminal.name), 'chat-5');
});

test('a missing session or a failing launch opens nothing and says why', async (t) => {
  const f = setup(t, {
    chats: [{ id: 'gone', harnessSessionId: 'gone' }, { id: 'broken' }],
    adapter: {
      isSessionResumable: async () => false,
      buildLaunchCommand: () => {
        throw new Error('bad settings');
      },
    },
  });
  assert.equal(await f.open('gone'), undefined);
  assert.ok(shown('Session not found in Claude Code'));
  assert.equal(await f.open('broken'), undefined);
  assert.ok(shown('Could not open the Claude Code session: bad settings'));
  assert.equal(stub.window.terminals.length, 0);
});

test('an open chat is focused, not relaunched; an exited process is replaced', async (t) => {
  const f = setup(t, { chats: [{ id: 'chat', harnessSessionId: 'linked' }] });
  const first = (await f.open('chat'))!;
  assert.equal(await f.open('chat'), first);
  assert.equal(stub.window.terminals.length, 1);

  first.exitStatus = { code: 0 };
  assert.equal(f.manager.isActive('chat'), false, 'a tab whose process exited is not open');
  const second = (await f.open('chat'))!;
  assert.notEqual(second, first);
  assert.ok(first.disposed);
});

test('a shell without integration still gets the launch command, without waiting for it to start', async (t) => {
  stub.__setConfiguration('shellIntegration.enabled', false);
  stub.__setSilentExecutionEvents(true);
  const f = setup(t, { chats: [{ id: 'chat' }] });
  const opened = await Promise.race([f.open('chat'), flush().then(() => 'still waiting' as const)]);
  assert.notEqual(opened, 'still waiting');
  assert.equal((opened as FakeTerminal).sent[0], 'claude');
});

test('closing a terminal keeps what can be resumed and drops what cannot', async (t) => {
  const f = setup(t, {
    chats: [
      { id: 'linked', harnessSessionId: 'linked' },
      { id: 'unlinked' }, // the harness assigns IDs and never linked one
      { id: 'pending', pendingHarnessSessionId: 'chosen' }, // relaunching reuses the ID
      { id: 'unused-fork', pendingHarnessSessionId: 'chosen-fork', forkedFromSessionId: 'source' },
      { id: 'prompted-fork', pendingHarnessSessionId: 'written', forkedFromSessionId: 'source' },
    ],
    adapter: { isSessionResumable: async (id) => id === 'linked' || id === 'written' },
  });
  for (const id of ['linked', 'unlinked', 'pending', 'unused-fork', 'prompted-fork']) {
    f.close((await f.open(id))!);
  }

  // A fork that never wrote a transcript exists only in the closed process;
  // reopening it would fork from wherever the source has moved since.
  await waitFor(() => !f.storage.getChat('unused-fork'), 'the unused fork to be dropped');
  assert.deepEqual(
    f.storage.getChats().map((chat) => `${chat.id}:${chat.status}`),
    ['linked:closed', 'pending:closed', 'prompted-fork:closed']
  );
});

test('after a reload, a tab whose pty has the recorded PID is adopted and never typed into', async (t) => {
  const f = setup(t, {
    chats: [
      { id: 'abcdef00-live', harnessSessionId: 'linked', status: 'active' },
      { id: 'ab12cd00-unlinked', status: 'active' },
      { id: 'ccddee00-exited', status: 'active' },
      { id: 'eeff0000-late', harnessSessionId: 'linked', status: 'active' },
    ],
  });
  const pids: Record<string, number> = { 'abcdef00-live': 7001, 'ab12cd00-unlinked': 7002, 'ccddee00-exited': 7003, 'eeff0000-late': 7004 };
  for (const [id, pid] of Object.entries(pids)) await f.storage.rememberTerminalPid(id, pid);
  const live = f.restoredTab('a title the user typed', 7001);
  const unlinked = f.restoredTab('Pitwall: Unlinked [ab12cd]', 7002);
  f.restoredTab('Pitwall: Exited [ccddee]', 7003, true);
  stub.window.__setActiveTerminal(live);

  const restore = f.manager.beginRestoreSync(() => WORKTREE);
  await restore.adopted;
  await restore.complete;
  assert.ok(f.manager.isActive('abcdef00-live'));
  assert.equal(live.name, terminalTitle(f.chat('abcdef00-live')), 'the focused tab gets its title back');
  assert.ok(f.manager.isActive('ab12cd00-unlinked'));
  assert.deepEqual(f.registrations, [`ab12cd00-unlinked@${WORKTREE.path}`], 'only the unlinked chat needs its watcher again');
  assert.ok(!f.manager.isActive('ccddee00-exited'));
  assert.equal(f.chat('ccddee00-exited').status, 'idle');

  const late = f.restoredTab('Pitwall: Late [eeff00]', 7004);
  stub.window.__fireDidOpenTerminal(late);
  await waitFor(() => f.manager.isActive('eeff0000-late'), 'a tab restored after activation');
  assert.deepEqual([live, unlinked, late].map((tab) => tab.sent.length), [0, 0, 0], 'a live agent is never typed into');
});

test('after a quit, each revived tab resumes its own chat in its worktree, quietly and in the background', async (t) => {
  const f = setup(t, {
    chats: [
      { id: 'aabbcc00-revived', harnessSessionId: 'linked', status: 'closed' },
      { id: 'cd34ef00-unlinked', status: 'closed' },
      { id: 'ffeedd00-duplicate', harnessSessionId: 'linked', status: 'closed' },
      { id: 'ddeeff00-same-pty', harnessSessionId: 'linked', status: 'active' },
      { id: '11223300-fork', forkedFromSessionId: 'source', status: 'closed' },
      { id: '44556600-gone', harnessSessionId: 'gone', status: 'closed' },
      { id: '99aabb00-stale', status: 'active' },
      { id: '77889900-foreign', status: 'active' }, // another window's chat: no PID here
    ],
    adapter: { isSessionResumable: async (id) => id !== 'gone' },
  });
  const recorded: [string, number][] = [
    ['aabbcc00-revived', 7001], ['cd34ef00-unlinked', 7002], ['ffeedd00-duplicate', 7003],
    ['ddeeff00-same-pty', 7004], ['11223300-fork', 7005], ['44556600-gone', 7006], ['99aabb00-stale', 7007],
  ];
  for (const [id, pid] of recorded) await f.storage.rememberTerminalPid(id, pid);
  const revived = f.restoredTab('Pitwall: Revived [aabbcc]', 8001);
  const unlinked = f.restoredTab('Pitwall: Unlinked [cd34ef]', 8002);
  const duplicateFirst = f.restoredTab('Pitwall: Duplicate [ffeedd]', 8003);
  const duplicateSecond = f.restoredTab('Pitwall: Duplicate [ffeedd]', 8004);
  const samePty = f.restoredTab('Pitwall: Same [ddeeff]', 7004);
  const fork = f.restoredTab('Pitwall: Fork [112233]', 8005);
  const gone = f.restoredTab('Pitwall: Gone [445566]', 8006);
  const previous = f.restoredTab('an unrelated shell', 9000);
  stub.window.__setActiveTerminal(previous);

  // The extension's focus listener: retitle activations are not selections.
  const selections: unknown[] = [];
  let background = 0;
  vscode.window.onDidChangeActiveTerminal((terminal) => {
    if (!terminal) return;
    if (f.manager.consumeBackgroundActivation(terminal)) background++;
    else selections.push(terminal);
  });

  const restore = f.manager.beginRestoreSync(() => WORKTREE);
  await restore.adopted;
  await restore.complete;
  const cd = `cd '${WORKTREE.path}' && `;
  assert.deepEqual(
    [revived, unlinked, duplicateFirst, duplicateSecond, samePty, fork, gone].map((tab) => tab.sent[0]),
    [`${cd}claude --resume linked`, `${cd}claude`, `${cd}claude --resume linked`, undefined, undefined, undefined, undefined]
  );
  assert.equal(f.manager.getTerminal('ffeedd00-duplicate'), duplicateFirst as unknown, 'the first same-titled tab owns the chat');
  assert.equal(f.storage.getTerminalPids()['aabbcc00-revived'], 8001, 'the new pty replaces the old record');
  assert.deepEqual(f.registrations, [`cd34ef00-unlinked@${WORKTREE.path}`]);
  assert.equal(stub.__messages.length, 0, 'a missing session is skipped without a warning');
  assert.deepEqual([f.chat('99aabb00-stale').status, f.chat('77889900-foreign').status], ['idle', 'active']);

  await waitFor(() => background >= 4, 'three retitles and the return to the previous tab');
  assert.equal(stub.window.activeTerminal, previous);
  assert.deepEqual(selections, [], 'retitling is not a user focus change');
  stub.window.__setActiveTerminal(revived);
  assert.deepEqual(selections, [revived], 'a real focus change still is');
});

test('overlapping focus changes never swap two tabs’ titles', async (t) => {
  const f = setup(t, {
    chats: [
      { id: '0a0a0a00-a', name: 'Race A', harnessSessionId: 'a', status: 'active' },
      { id: '0b0b0b00-b', name: 'Race B', harnessSessionId: 'b', status: 'active' },
    ],
  });
  await f.storage.rememberTerminalPid('0a0a0a00-a', 7101);
  await f.storage.rememberTerminalPid('0b0b0b00-b', 7102);
  const tabA = f.restoredTab('stale-a', 7101);
  const tabB = f.restoredTab('stale-b', 7102);
  const restore = f.manager.beginRestoreSync(() => WORKTREE);
  await restore.complete;

  // The workbench resolves the active tab when the rename runs, one hop later.
  const writes: { intended: string; target: unknown }[] = [];
  vscode.commands.registerCommand('workbench.action.terminal.renameWithArg', async (arg: { name: string }) => {
    await Promise.resolve();
    writes.push({ intended: arg.name, target: stub.window.activeTerminal });
    if (stub.window.activeTerminal) stub.window.activeTerminal.name = arg.name;
  });
  const titleA = terminalTitle(f.chat('0a0a0a00-a'));
  const titleB = terminalTitle(f.chat('0b0b0b00-b'));
  stub.window.__setActiveTerminal(tabA);
  stub.window.__setActiveTerminal(tabB);
  await waitFor(() => tabB.name === titleB, 'the last focused tab to get its title');
  assert.ok(writes.every(({ intended, target }) => (intended === titleA ? target === tabA : target === tabB)));
  assert.notEqual(tabA.name, titleB);

  stub.window.__setActiveTerminal(tabA);
  await waitFor(() => tabA.name === titleA, 'the refocused tab to get its title');
});

test('adoption does not wait for a slow harness check, and a click meanwhile focuses the restored tab', async (t) => {
  let release: (resumable: boolean) => void = () => undefined;
  const f = setup(t, {
    chats: [{ id: '5a5a5a00-slow', harnessSessionId: 'slow', status: 'closed' }],
    adapter: { isSessionResumable: () => new Promise<boolean>((resolve) => (release = resolve)) },
  });
  await f.storage.rememberTerminalPid('5a5a5a00-slow', 7201);
  const tab = f.restoredTab('Pitwall: Slow [5a5a5a]', 7202);

  const restore = f.manager.beginRestoreSync(() => WORKTREE);
  await restore.adopted;
  let complete = false;
  void restore.complete.then(() => (complete = true));
  await flush();
  assert.equal(complete, false);
  assert.ok(f.manager.isResuming('5a5a5a00-slow'), 'the restored tab is still this chat’s');

  assert.equal(await f.open('5a5a5a00-slow'), tab, 'a click focuses the tab instead of starting a second agent');
  assert.deepEqual([tab.sent.length, stub.window.terminals.length], [0, 1]);

  release(true);
  await restore.complete;
  assert.equal(tab.sent[0], `cd '${WORKTREE.path}' && claude --resume slow`);
  assert.ok(!f.manager.isResuming('5a5a5a00-slow'));
});

test('a storage failure while adopting a late tab stays contained', async (t) => {
  const f = setup(t, { chats: [{ id: '6b6b6b00-late', harnessSessionId: 'late', status: 'active' }] });
  await f.storage.rememberTerminalPid('6b6b6b00-late', 7301);
  f.storage.rememberTerminalPid = async () => {
    throw new Error('storage unavailable');
  };
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  const error = console.error;
  console.error = () => undefined;
  t.after(() => {
    process.off('unhandledRejection', record);
    console.error = error;
  });

  stub.window.__fireDidOpenTerminal(f.restoredTab('Pitwall: Late [6b6b6b]', 7301));
  await flush();
  await flush();
  assert.deepEqual(unhandled, []);
});

test('a new chat with a full-path Claude command runs in PowerShell through the call operator; bash and cmd keep today’s line', async (t) => {
  stub.__setConfiguration('harnessCommands', { claude: 'C:\\Program Files\\Claude\\claude.exe' });
  const claude = new ClaudeHarness();
  const f = setup(t, {
    chats: [{ id: 'new-ps' }, { id: 'new-bash' }, { id: 'new-cmd' }],
    adapter: { buildLaunchCommand: (options) => claude.buildLaunchCommand(options) },
  });
  const quoted = "'C:\\Program Files\\Claude\\claude.exe'";

  stub.__setShell('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const powershell = (await f.open('new-ps'))!.sent[0];
  assert.ok(powershell.startsWith("& '"), powershell);
  assert.equal(powershell, `& ${quoted}`);

  stub.__setShell('/bin/bash');
  assert.equal((await f.open('new-bash'))!.sent[0], quoted);
  stub.__setShell('C:\\WINDOWS\\system32\\cmd.exe');
  assert.equal((await f.open('new-cmd'))!.sent[0], quoted);
});

test('after a quit, activation waits at most one PID timeout however many revived tabs never report a PID', async (t) => {
  const f = setup(t, {
    chats: [
      { id: 'a0a0a000-mute', harnessSessionId: 'mute-a', status: 'closed' },
      { id: 'b0b0b000-mute', harnessSessionId: 'mute-b', status: 'closed' },
    ],
  });
  await f.storage.rememberTerminalPid('a0a0a000-mute', 7401);
  await f.storage.rememberTerminalPid('b0b0b000-mute', 7402);
  const tabs = [
    stub.window.createTerminal({ name: 'Pitwall: Mute A [a0a0a0]', __pidDelayMs: Infinity }),
    stub.window.createTerminal({ name: 'Pitwall: Mute B [b0b0b0]', __pidDelayMs: Infinity }),
  ];

  await f.manager.beginRestoreSync(() => WORKTREE).adopted;
  // Each PID was awaited once, in the shared parallel read. A second read per
  // tab would hold activation for another timeout each.
  assert.deepEqual(tabs.map((tab) => tab.__pidReads), [1, 1]);
});

test('a revived tab whose PID arrives late is still resumed in the background, and a click focuses it', async (t) => {
  const f = setup(t, { chats: [{ id: 'c0c0c000-late', harnessSessionId: 's1', status: 'closed' }] });
  await f.storage.rememberTerminalPid('c0c0c000-late', 7501);
  const tab = stub.window.createTerminal({ name: 'Pitwall: Late [c0c0c0]', __pid: 8501, __pidDelayMs: 2_500 });

  const restore = f.manager.beginRestoreSync(() => WORKTREE);
  await restore.adopted;
  assert.equal(await f.open('c0c0c000-late'), tab, 'a click while the PID is pending focuses the revived tab');
  await restore.complete;
  assert.deepEqual(tab.sent, [`cd ${quoteShellArgument(WORKTREE.path)} && claude --resume s1`]);
  assert.ok(f.manager.isActive('c0c0c000-late'));
  assert.equal(f.storage.getTerminalPids()['c0c0c000-late'], 8501, 'the late PID is recorded for a reload');

  const count = stub.window.terminals.length;
  await f.manager.openChat(f.chat('c0c0c000-late'), WORKTREE);
  assert.equal(stub.window.terminals.length, count, 'a click focuses the resumed tab instead of opening another');
});

test('Remove closes a restored tab Pitwall could not resume, and only that tab', async (t) => {
  const f = setup(t, {
    chats: [
      { id: 'd0d0d000-fork', forkedFromSessionId: 'source', status: 'closed' },
      { id: 'e0e0e000-other', harnessSessionId: 'other', status: 'closed' },
      { id: 'f0f0f000-twin-a', harnessSessionId: 'twin-a', status: 'closed' },
      { id: 'f0f0f000-twin-b', harnessSessionId: 'twin-b', status: 'closed' },
    ],
  });
  await f.storage.rememberTerminalPid('d0d0d000-fork', 7601);
  await f.storage.rememberTerminalPid('f0f0f000-twin-a', 7603);
  const fork = f.restoredTab('Pitwall: Fork [d0d0d0]', 8601);
  const other = f.restoredTab('Pitwall: Other [e0e0e0]', 8602);
  const twin = f.restoredTab('Pitwall: Twin [f0f0f0]', 8603);
  await f.manager.beginRestoreSync(() => WORKTREE).complete;
  assert.deepEqual([fork, other, twin].map((tab) => tab.sent.length), [0, 0, 0], 'restore resumed none of them');

  f.manager.closeChat('d0d0d000-fork');
  // Two stored chats share this short ID, so the tab is not provably theirs.
  f.manager.closeChat('f0f0f000-twin-a');
  assert.deepEqual([fork, other, twin].map((tab) => tab.disposed), [true, false, false]);
});

test('a new tab whose PID arrives after the wait still has its PID recorded', async (t) => {
  stub.__setPidDelayMs(PROCESS_ID_TIMEOUT_MS + 500);
  const f = setup(t, { chats: [{ id: '3c3c3c00-slow-pid', harnessSessionId: 'linked' }] });

  const terminal = (await f.open('3c3c3c00-slow-pid'))!;
  // openChat returned on today's bound, before the PID arrived.
  assert.equal(f.storage.getTerminalPids()['3c3c3c00-slow-pid'], undefined);
  await waitFor(
    () => f.storage.getTerminalPids()['3c3c3c00-slow-pid'] === terminal.__pid,
    'the late PID to be recorded',
    PROCESS_ID_TIMEOUT_MS
  );
  assert.equal(terminal.__pidReads, 1, 'the late PID comes from the same read');
});

test('a late PID is not recorded for a tab that closed meanwhile', async (t) => {
  stub.__setPidDelayMs(PROCESS_ID_TIMEOUT_MS + 300);
  const f = setup(t, { chats: [{ id: '4d4d4d00-closed', harnessSessionId: 'linked' }] });
  const terminal = (await f.open('4d4d4d00-closed'))!;
  f.close(terminal);
  let pidSettled = false;
  void terminal.processId.then(() => (pidSettled = true));
  await waitFor(() => pidSettled, 'the late PID to arrive', PROCESS_ID_TIMEOUT_MS);
  await flush();
  assert.equal(f.storage.getTerminalPids()['4d4d4d00-closed'], undefined);
});

test('a background tab whose shell integration arrives late still gets its restore title', async (t) => {
  stub.__setLateShellIntegration(true);
  const f = setup(t, { chats: [{ id: '5e5e5e00-slow-shell', name: 'Slow Shell', harnessSessionId: 'linked' }] });
  const renames: { name: string; target: unknown }[] = [];
  vscode.commands.registerCommand('workbench.action.terminal.renameWithArg', (arg: { name: string }) => {
    renames.push({ name: arg.name, target: stub.window.activeTerminal });
    if (stub.window.activeTerminal) stub.window.activeTerminal.name = arg.name;
  });

  // openChat returns on today's bound, before the shell integrates; waiting
  // for the late shell would never settle here.
  const tab = (await f.open('5e5e5e00-slow-shell'))!;

  // The user moves on to another tab before the slow shell starts.
  const front = f.restoredTab('the user’s shell', 9100);
  stub.window.__setActiveTerminal(front);
  // Only a rename after the launch command starts is the one a quit keeps.
  const before = renames.length;
  stub.window.__integrateShell(tab);

  const title = terminalTitle(f.chat('5e5e5e00-slow-shell'));
  await waitFor(() => renames.slice(before).some((r) => r.target === tab && r.name === title), 'the late title');
  await waitFor(() => stub.window.activeTerminal === front, 'the user’s tab to be active again');
  assert.ok(renames.every((r) => r.target === tab), 'only the slow tab is renamed');
  assert.equal(front.name, 'the user’s shell');
});

test('a late title still lands when another tab takes the front while the rename waits its turn', async (t) => {
  stub.__setLateShellIntegration(true);
  const f = setup(t, { chats: [{ id: '6f6f6f00-slow-shell', name: 'Slow Shell', harnessSessionId: 'linked' }] });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  // Renames as requested, in order; each completes once the gate opens.
  const renames: { name: string; target: unknown }[] = [];
  vscode.commands.registerCommand('workbench.action.terminal.renameWithArg', async (arg: { name: string }) => {
    const target = stub.window.activeTerminal;
    renames.push({ name: arg.name, target });
    await gate;
    if (target) target.name = arg.name;
  });

  const tab = (await f.open('6f6f6f00-slow-shell'))!;
  // A focus rename is in flight, so the late title has to queue behind it.
  stub.window.__setActiveTerminal(tab);
  stub.window.__integrateShell(tab);
  await flush();
  // The command started while the tab was in front; then the user moves on.
  const front = f.restoredTab('the user’s shell', 9200);
  stub.window.__setActiveTerminal(front);
  const before = renames.length;
  release();

  const title = terminalTitle(f.chat('6f6f6f00-slow-shell'));
  await waitFor(() => renames.slice(before).some((r) => r.target === tab && r.name === title), 'the late title');
  await waitFor(() => stub.window.activeTerminal === front, 'the user’s tab to be active again');
});

test('a revived tab is resumed only after its shell reports ready', async (t) => {
  // A revived PowerShell can take many seconds to start; a line typed into it
  // meanwhile can be lost.
  stub.__setLateShellIntegration(true);
  const f = setup(t, { chats: [{ id: 'a1a1a100-slow', harnessSessionId: 's2', status: 'closed' }] });
  await f.storage.rememberTerminalPid('a1a1a100-slow', 7701);
  const tab = f.restoredTab('Pitwall: Slow Shell [a1a1a1]', 8701);

  await f.manager.beginRestoreSync(() => WORKTREE).complete;
  await flush();
  assert.deepEqual(tab.sent, [], 'nothing is typed into a shell that is still starting');
  assert.equal(await f.open('a1a1a100-slow'), tab, 'a click meanwhile focuses the revived tab');
  assert.equal(stub.window.terminals.length, 1, 'and opens no second tab');

  stub.window.__integrateShell(tab);
  await waitFor(() => tab.sent.length > 0, 'the resume line');
  await flush();
  assert.deepEqual(tab.sent, [`cd ${quoteShellArgument(WORKTREE.path)} && claude --resume s2`]);
});

test('with shell integration turned off, a revived tab is resumed at once', async (t) => {
  stub.__setConfiguration('shellIntegration.enabled', false);
  // With the setting off the shell never reports ready, so nothing waits for it.
  stub.__setLateShellIntegration(true);
  const f = setup(t, { chats: [{ id: 'a2a2a200-off', harnessSessionId: 's3', status: 'closed' }] });
  await f.storage.rememberTerminalPid('a2a2a200-off', 7702);
  const tab = f.restoredTab('Pitwall: No Integration [a2a2a2]', 8702);

  await f.manager.beginRestoreSync(() => WORKTREE).complete;
  assert.deepEqual(tab.sent, [`cd ${quoteShellArgument(WORKTREE.path)} && claude --resume s3`]);
});

test('a revived tab whose shell never reports ready is still resumed, once, when the readiness cap runs out', async (t) => {
  // Integration is on, but the shell never activates it (for example, an
  // execution policy that blocks the integration script).
  stub.__setLateShellIntegration(true);
  const warnings: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  t.after(() => (console.warn = warn));
  const f = setup(t, { chats: [{ id: 'a3a3a300-never', harnessSessionId: 's4', status: 'closed' }] });
  await f.storage.rememberTerminalPid('a3a3a300-never', 7703);
  const tab = f.restoredTab('Pitwall: Never Ready [a3a3a3]', 8703);
  const line = `cd ${quoteShellArgument(WORKTREE.path)} && claude --resume s4`;

  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.manager.beginRestoreSync(() => WORKTREE).complete;
  t.mock.timers.tick(REVIVED_SHELL_READY_CAP_MS - 1);
  await flush();
  assert.deepEqual(tab.sent, [], 'not typed into before the cap');

  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(tab.sent, [line], 'sent anyway when the cap runs out');
  assert.equal(warnings.length, 1, 'one log line says so');

  t.mock.timers.tick(REVIVED_SHELL_READY_CAP_MS);
  await flush();
  assert.deepEqual(tab.sent, [line], 'and never sent twice');
});

test('a revived tab whose command starts after the retitle wait still gets its restore title', async (t) => {
  // The shell reports no command start until the test says so.
  stub.__setSilentExecutionEvents(true);
  const f = setup(t, { chats: [{ id: 'a4a4a400-slow-start', name: 'Slow Start', harnessSessionId: 's5', status: 'closed' }] });
  await f.storage.rememberTerminalPid('a4a4a400-slow-start', 7704);
  const tab = f.restoredTab('Pitwall: Slow Start [a4a4a4]', 8704);
  const renames: { name: string; target: unknown }[] = [];
  vscode.commands.registerCommand('workbench.action.terminal.renameWithArg', (arg: { name: string }) => {
    renames.push({ name: arg.name, target: stub.window.activeTerminal });
    if (stub.window.activeTerminal) stub.window.activeTerminal.name = arg.name;
  });

  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.manager.beginRestoreSync(() => WORKTREE).complete;
  t.mock.timers.tick(RESTORED_SHELL_TIMEOUT_MS);
  await flush();
  // Under load the command starts after the wait gave up.
  const before = renames.length;
  stub.window.__fireDidStartTerminalShellExecution(tab);
  await flush();

  const title = terminalTitle(f.chat('a4a4a400-slow-start'));
  assert.ok(
    renames.slice(before).some((r) => r.target === tab && r.name === title),
    'the title is applied after the late command start, the rename a quit keeps'
  );
});

/** One editor group whose active tab is the user's, as `tabGroups` reports it. */
function userTabInFront(input: unknown, viewColumn = 1) {
  const tab = { input, label: 'user tab', isPreview: false, isActive: true };
  stub.window.tabGroups.all = [{ isActive: true, viewColumn, tabs: [tab], activeTab: tab }];
  stub.window.__setActiveTerminal(undefined);
}

/** Open a chat whose shell integrates late, then let the user move on. */
async function slowChat(f: ReturnType<typeof setup>, id: string) {
  const tab = (await f.open(id))!;
  return { tab, title: terminalTitle(f.chat(id)) };
}

test('a background retitle puts the user’s text editor back in front, without taking focus', async (t) => {
  stub.__setLateShellIntegration(true);
  const f = setup(t, { chats: [{ id: 'a5a5a500-front', name: 'Front', harnessSessionId: 'linked' }] });
  const { tab, title } = await slowChat(f, 'a5a5a500-front');

  const uri = vscode.Uri.file('/work/notes.md');
  userTabInFront(new vscode.TabInputText(uri), 1);
  stub.window.__setActiveTextEditor({ document: { uri }, viewColumn: 1 });
  stub.window.__integrateShell(tab);

  await waitFor(() => tab.name === title, 'the late title');
  await flush();
  assert.equal(stub.window.activeTextEditor?.document.uri, uri, 'the file is in front again');
  assert.deepEqual(stub.__shownDocuments.at(-1)?.options, { viewColumn: 1, preserveFocus: true, preview: false });
});

test('a background retitle brings back a custom or diff tab without focus; a webview tab is left behind it', async (t) => {
  stub.__setLateShellIntegration(true);
  const f = setup(t, {
    chats: [
      { id: 'a6a6a600-custom', name: 'Custom', harnessSessionId: 'c' },
      { id: 'a7a7a700-diff', name: 'Diff', harnessSessionId: 'd' },
      { id: 'a8a8a800-webview', name: 'Webview', harnessSessionId: 'w' },
    ],
  });
  const calls: unknown[][] = [];
  for (const id of ['vscode.openWith', 'vscode.diff']) {
    vscode.commands.registerCommand(id, (...args: unknown[]) => void calls.push([id, ...args]));
  }

  const custom = await slowChat(f, 'a6a6a600-custom');
  const image = vscode.Uri.file('/work/logo.png');
  userTabInFront(new vscode.TabInputCustom(image, 'imagePreview.previewEditor'), 2);
  stub.window.__integrateShell(custom.tab);
  await waitFor(() => custom.tab.name === custom.title, 'the custom-tab case title');
  await flush();
  assert.deepEqual(calls.at(-1), ['vscode.openWith', image, 'imagePreview.previewEditor', { viewColumn: 2, preserveFocus: true }]);

  const diff = await slowChat(f, 'a7a7a700-diff');
  const left = vscode.Uri.file('/work/a.ts');
  const right = vscode.Uri.file('/work/b.ts');
  userTabInFront(new vscode.TabInputTextDiff(left, right), 1);
  stub.window.__integrateShell(diff.tab);
  await waitFor(() => diff.tab.name === diff.title, 'the diff-tab case title');
  await flush();
  assert.deepEqual(calls.at(-1), ['vscode.diff', left, right, 'user tab', { viewColumn: 1, preserveFocus: true, preview: false }]);

  // A webview (such as an extension's chat panel) has no focus-free way back.
  const webview = await slowChat(f, 'a8a8a800-webview');
  userTabInFront(new vscode.TabInputWebview('mainThreadWebview-someChat'), 1);
  const before = calls.length;
  stub.window.__integrateShell(webview.tab);
  await waitFor(() => webview.tab.name === webview.title, 'the webview case title');
  await flush();
  assert.equal(calls.length, before, 'nothing is reopened for a webview tab');
  assert.equal(stub.window.activeTerminal, webview.tab, 'the renamed terminal stays in front of it');
});

/**
 * The workbench's rename, as the editor's own code runs it:
 * `workbench.action.terminal.renameWithArg` renames
 * `TerminalService.activeInstance`, which returns a terminal that holds
 * keyboard focus first and the last active terminal only when none does.
 * `show(true)` makes a tab active without moving focus, so with focus in
 * another terminal the extension host's `activeTerminal` and the rename's
 * target differ.
 */
function focusFirstRename() {
  const renames: { name: string; target: FakeTerminal | undefined }[] = [];
  vscode.commands.registerCommand('workbench.action.terminal.renameWithArg', (arg: { name: string }) => {
    const target = stub.window.__focusedTerminal ?? stub.window.activeTerminal;
    renames.push({ name: arg.name, target });
    if (target) target.name = arg.name;
  });
  return renames;
}

/** Terminals other than `owner` that carry a Pitwall title. */
function pitwallTitledOthers(owner: FakeTerminal): string[] {
  return stub.window.terminals.filter((t) => t !== owner && /^Pitwall: .*\[[a-f0-9]{6}\]$/.test(t.name)).map((t) => t.name);
}

test('a late title never lands on the user’s own terminal that holds keyboard focus (F-a)', async (t) => {
  stub.__setLateShellIntegration(true);
  const f = setup(t, { chats: [{ id: '40de4f00-lab', name: 'Lab ready', harnessSessionId: 'lab' }] });
  const renames = focusFirstRename();
  // Opened from its row; Windows PowerShell 5.1 integrates after openChat returns.
  const tab = (await f.open('40de4f00-lab'))!;
  // The user pastes the copied resume command into a panel terminal of their own.
  const panel = stub.window.createTerminal({ name: 'powershell', location: vscode.TerminalLocation.Panel });
  stub.window.__focusTerminal(panel);
  const before = renames.length;
  // The chat tab's slow command starts now, so its late title is applied.
  stub.window.__integrateShell(tab);

  await waitFor(() => renames.length > before, 'the late rename to run');
  await waitFor(() => stub.window.activeTerminal === panel, 'the user’s terminal to be in front again');
  assert.equal(panel.name, 'powershell', 'the user’s terminal keeps its own name');
  assert.deepEqual(pitwallTitledOthers(tab), [], 'no other terminal carries the chat’s identity');
});

test('after a reload, adopting tabs never renames the tab that holds keyboard focus (R1(d))', async (t) => {
  const f = setup(t, {
    chats: [
      { id: '40de4f00-lab', name: 'Lab ready', harnessSessionId: 'lab', status: 'active' },
      { id: '0ad61000-new', name: 'New Session', harnessSessionId: 'new', status: 'active' },
    ],
  });
  await f.storage.rememberTerminalPid('40de4f00-lab', 82260);
  await f.storage.rememberTerminalPid('0ad61000-new', 13740);
  const lab = f.restoredTab('Pitwall: Lab ready [40de4f]', 82260);
  const fresh = f.restoredTab('Pitwall: New Session [0ad610]', 13740);
  // After the reload, keyboard focus is in Lab ready's tab while the window's
  // last active terminal is New Session (shown without focus).
  stub.window.__focusTerminal(lab);
  stub.window.__setActiveTerminal(fresh);
  const renames = focusFirstRename();

  const restore = f.manager.beginRestoreSync(() => WORKTREE);
  await restore.adopted;
  await restore.complete;
  await waitFor(() => renames.length > 0, 'an adoption rename to run');
  await flush();
  assert.ok(f.manager.isActive('40de4f00-lab') && f.manager.isActive('0ad61000-new'), 'both live tabs are adopted');
  assert.equal(lab.name, 'Pitwall: Lab ready [40de4f]', 'Lab ready keeps its own title');
  assert.equal(new Set(stub.window.terminals.map((t) => t.name)).size, 2, 'no two tabs share a title');
});

test('after a reload, a live tab whose PID arrives after the wait is still adopted, and a click focuses it (R1(d))', async (t) => {
  const f = setup(t, { chats: [{ id: '40de4f00-lab', name: 'Lab ready', harnessSessionId: 'lab', status: 'active' }] });
  await f.storage.rememberTerminalPid('40de4f00-lab', 82260);
  // The surviving pty reports its PID after activation's bounded read gave up.
  const lab = stub.window.createTerminal({
    name: 'Pitwall: Lab ready [40de4f]',
    __pid: 82260,
    __pidDelayMs: PROCESS_ID_TIMEOUT_MS + 500,
  });

  await f.manager.beginRestoreSync(() => WORKTREE).complete;
  await waitFor(() => f.manager.isActive('40de4f00-lab'), 'the late live tab to be adopted', PROCESS_ID_TIMEOUT_MS);
  assert.equal(f.chat('40de4f00-lab').status, 'active', 'the row does not fall back to idle');
  assert.equal(await f.open('40de4f00-lab'), lab, 'a click focuses the live tab');
  assert.deepEqual([stub.window.terminals.length, lab.sent.length], [1, 0], 'no second tab, and the live agent is never typed into');
});

test('guard: a tab activated between the retitle’s show and its rename is never renamed (active-only rename)', async (t) => {
  // The suspect in R37: something else becomes active after the queue shows
  // the tab and before the rename runs. writeTitle re-checks the active tab
  // in the same turn as the rename, so this passes before and after the fix.
  stub.__setLateShellIntegration(true);
  const f = setup(t, { chats: [{ id: '7a7a7a00-slow', name: 'Slow', harnessSessionId: 'slow' }] });
  const renames: { name: string; target: unknown }[] = [];
  vscode.commands.registerCommand('workbench.action.terminal.renameWithArg', (arg: { name: string }) => {
    renames.push({ name: arg.name, target: stub.window.activeTerminal });
    if (stub.window.activeTerminal) stub.window.activeTerminal.name = arg.name;
  });
  const tab = (await f.open('7a7a7a00-slow'))!;
  const other = f.restoredTab('the user’s shell', 9300);
  stub.window.__setActiveTerminal(other);
  // The moment the retitle shows the slow tab, another tab takes the front.
  let stolen = false;
  vscode.window.onDidChangeActiveTerminal((active) => {
    if (active === (tab as unknown) && !stolen) {
      stolen = true;
      queueMicrotask(() => stub.window.__setActiveTerminal(other));
    }
  });
  stub.window.__integrateShell(tab);
  await waitFor(() => stolen, 'the retitle to show the slow tab');
  await flush();
  await flush();
  assert.equal(other.name, 'the user’s shell');
  assert.ok(renames.every((r) => r.target === tab));
});
