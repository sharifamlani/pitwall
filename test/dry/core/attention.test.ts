import { beforeEach, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  NEEDS_INPUT_COOLDOWN_MS,
  SessionAttentionService,
  StatusTransition,
  shouldNotifyNeedsInput,
} from '../../../src/core/services/SessionAttentionService';
import { escapeAppleScript, NotificationOptions, NotificationService, openFromPopup } from '../../../src/core/services/NotificationService';
import { PopupKey, PopupLedger } from '../../../src/core/notify/PopupLedger';
import { WindowRegistry } from '../../../src/core/windows/WindowRegistry';
import { ClaudeSessionsFile } from '../../../src/harnesses/claude/ClaudeSessionsFile';
import { writeDump } from '../../../src/core/windows/dumpState';
import { HarnessAdapter, HarnessLiveState } from '../../../src/core/harness/types';
import { ChatSession } from '../../../src/core/types';
import * as chatVisibility from '../../../src/core/services/chatVisibility';
import { chatNativeSessionIds } from '../../../src/core/harness/sessionUtils';
import { ClaudeAgentsService } from '../../../src/harnesses/claude/ClaudeAgentsService';
import { ClaudeHarness } from '../../../src/harnesses/claude/ClaudeHarness';
import { claudeUiSurfaces } from '../../../src/harnesses/claude/claudeUi';
import { HarnessRegistry } from '../../../src/core/harness/HarnessRegistry';
import { TerminalManager } from '../../../src/core/services/TerminalManager';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from '../../../src/core/providers/WorkspacesTreeProvider';
import { registerChatCommands } from '../../../src/core/commands/chat';
import {
  chatRecord,
  fakeAdapter,
  fakeNativeUi,
  flush,
  makeStorage,
  memento,
  runCommand,
  sessionRecord,
  shown,
  stub,
  tempDir,
  worktreeRecord,
} from '../support';

beforeEach(() => stub.__reset());

/** An attention service over one chat whose adapter the test drives. */
function attention(chat: ChatSession, adapter: HarnessAdapter, options: { terminalOpen?: boolean; isChatOpen?: (chat: ChatSession) => boolean; isChatVisible?: () => boolean } = {}) {
  const notified: string[] = [];
  // Mirrors NotificationService's contract: a pre-existing or in-front wait is skipped, anything else shows.
  const notify = async (kind: string, target: { detail?: string; preExisting?: boolean; inFront?: boolean }) => {
    if (target.preExisting) return 'skipped-pre-existing';
    if (target.inFront) return 'skipped-front';
    notified.push(target.detail ? `${kind}:${target.detail}` : kind);
    return 'shown';
  };
  const service = new SessionAttentionService(
    { getChats: () => [chat], getRepository: () => ({ name: 'repo' }), markChatSeen: async () => undefined } as never,
    { get: () => adapter } as never,
    { notify } as never,
    () => worktreeRecord(),
    () => undefined,
    options.isChatOpen ?? (() => options.terminalOpen ?? true),
    options.isChatVisible
  );
  return { service, notified };
}

/** A linked chat; like every stored chat (P16) it has a seen baseline, so a turn that ends after it is finished. */
const linkedChat = (overrides: Partial<ChatSession> = {}) =>
  chatRecord({ harnessSessionId: 'session-1', status: 'active', seenAt: 1, ...overrides });

test('a new or changed waiting reason notifies at once; a repeat waits out the cooldown', () => {
  assert.ok(shouldNotifyNeedsInput(undefined, 'permission prompt', undefined, 0));
  assert.ok(!shouldNotifyNeedsInput('permission prompt', 'permission prompt', 0, 1));
  assert.ok(shouldNotifyNeedsInput('permission prompt', 'permission prompt', 0, NEEDS_INPUT_COOLDOWN_MS));
  assert.ok(shouldNotifyNeedsInput('permission prompt', 'idle question', 0, 1));
});

test('each finished turn and each wait notifies once; startup state never does', async () => {
  let live: HarnessLiveState = { turnState: 'done', turnEndedAt: 500, waitingFor: 'permission prompt' };
  const adapter = fakeAdapter('claude', { getLiveStates: async () => new Map([['session-1', live]]) });
  const { service, notified } = attention(linkedChat(), adapter);
  const step = async (next: HarnessLiveState) => {
    live = next;
    await service.poll();
  };

  await service.poll(true);
  await service.poll();
  assert.deepEqual(notified, [], 'a session already waiting at startup is primed silently');

  await step({ turnState: 'working', turnEndedAt: null });
  await step({ turnState: 'done', turnEndedAt: 1000 });
  await step({ turnState: 'done', turnEndedAt: 1000 });
  assert.deepEqual(notified, ['finished'], 'one turn end, one notification');

  await step({ turnState: 'done', turnEndedAt: 1000, waitingFor: 'permission prompt' });
  await step({ turnState: 'done', turnEndedAt: 2000, waitingFor: 'permission prompt' });
  await step({ turnState: 'done', turnEndedAt: 2000 });
  assert.deepEqual(notified, ['finished', 'needs-input:permission prompt'], 'a turn end at a wait is not announced twice');

  await step({ turnState: 'done', turnEndedAt: 3000 });
  await step({ turnState: 'done', turnEndedAt: 3000, waitingFor: 'permission prompt' });
  await step({ turnState: 'working', turnEndedAt: null });
  assert.deepEqual(notified, ['finished', 'needs-input:permission prompt', 'finished', 'needs-input:permission prompt']);
  assert.equal(service.getTurnState('chat-1'), 'working', 'the tree reads the latest state');
});

test('a session needs you while it waits, in front or not, until the wait ends; a finished turn is finished, not needs-you (Q30)', async () => {
  let live: HarnessLiveState = { turnState: 'done', turnEndedAt: 500 };
  let visible = false;
  let open = true;
  const adapter = fakeAdapter('claude', { getLiveStates: async () => new Map([['session-1', live]]) });
  const { service } = attention(linkedChat(), adapter, { isChatOpen: () => open, isChatVisible: () => visible });
  const step = async (next: HarnessLiveState) => {
    live = next;
    await service.poll();
  };

  await service.poll(true);
  assert.deepEqual(service.sessionsNeedingYou(), [], 'a turn that ended before startup is not news');

  await step({ turnState: 'working', turnEndedAt: null });
  await step({ turnState: 'done', turnEndedAt: 1000 });
  assert.deepEqual(service.sessionsNeedingYou(), [], 'a finished turn is not on the needs-you list');
  assert.equal(service.statusOf('chat-1').status, 'finished');
  service.markSeen('chat-1');
  assert.equal(service.statusOf('chat-1').status, 'idle', 'visiting turns it idle');

  await step({ turnState: 'working', turnEndedAt: null, waitingFor: 'permission prompt' });
  assert.deepEqual(service.sessionsNeedingYou(), ['chat-1'], 'a wait mid-turn needs you');
  visible = true;
  await step({ turnState: 'working', turnEndedAt: null, waitingFor: 'permission prompt' });
  assert.deepEqual(service.sessionsNeedingYou(), ['chat-1'], 'still listed while it is in front (Q30)');
  service.markSeen('chat-1');
  assert.deepEqual(service.sessionsNeedingYou(), ['chat-1'], 'visiting does not answer it');
  await step({ turnState: 'working', turnEndedAt: null });
  assert.deepEqual(service.sessionsNeedingYou(), [], 'answered: the agent is working again');

  visible = false;
  await step({ turnState: 'working', turnEndedAt: null, waitingFor: 'permission prompt' });
  open = false;
  await service.poll();
  assert.deepEqual(service.sessionsNeedingYou(), [], 'a closed chat with no live process is not waiting');
});

test('a harness without live states is polled through discovery', async () => {
  let turnState: 'working' | 'done' = 'working';
  const adapter = fakeAdapter('opencode', {
    listSessionsForWorktree: async () => [
      sessionRecord('opencode', 'session-1', { cwd: worktreeRecord().path, turnState, turnEndedAt: turnState === 'done' ? 1000 : null }),
    ],
  });
  const { service, notified } = attention(linkedChat({ harness: 'opencode' }), adapter);
  await service.poll(true);
  turnState = 'done';
  await service.poll();
  assert.deepEqual(notified, ['finished']);
});

test('a chat open only in its native UI is still polled', async () => {
  const chat = linkedChat({ status: 'closed' });
  const adapter = fakeAdapter('claude', {
    getLiveStates: async () => new Map([['session-1', { turnState: 'done' as const, turnEndedAt: 1000 }]]),
  });
  const { service } = attention(chat, adapter, { terminalOpen: false, isChatOpen: (entry) => entry.id === chat.id });
  await service.poll(true);
  assert.equal(service.getTurnState(chat.id), 'done');
});

test('a notification is suppressed while its session has focus; AppleScript text is escaped', async () => {
  stub.__setConfiguration('notifications.nativeBanner', false);
  const state = (stub.window as unknown as { state: { focused: boolean } });
  const notifications = new NotificationService(() => undefined, () => true);
  const target = { chat: linkedChat(), context: 'repo · main', detail: 'permission prompt', sessionId: 'session-1', at: 1_800_000_000_000 };

  state.state = { focused: true };
  assert.equal(await notifications.notify('needs-input', target), 'skipped-front');
  assert.equal(stub.__messages.length, 0);
  state.state = { focused: false };
  assert.equal(await notifications.notify('needs-input', { ...target, at: target.at + 1 }), 'shown');
  assert.equal(stub.__messages.length, 1);

  assert.equal(escapeAppleScript('He said "hi"\nbye'), 'He said \\"hi\\" bye');
});

// ---------------------------------------------------------------------------
// R36: needs-you is re-evaluated each tick and judged by the tab really in
// front. A waiting chat that is not in front is listed on every tick; a toast
// fires only for a wait that begins unseen, and a held-back toast does not
// start the cooldown.
// ---------------------------------------------------------------------------

/** Move Date.now by hand; the attention service reads it directly. */
function useClock(t: { after(fn: () => void): void }) {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  t.after(() => {
    Date.now = realNow;
  });
  return { advance: (ms: number) => (offset += ms) };
}

const toasts = () => stub.__messages.map((args) => String(args[0])).filter((text) => text.includes('needs your input'));
const windowState = () => stub.window as unknown as { state: { focused: boolean } };
const setActiveTerminal = (terminal: unknown) =>
  (stub.window as unknown as { __setActiveTerminal(terminal: unknown): void }).__setActiveTerminal(terminal);

/** One chat whose live state the test drives, with the real notification service. */
function liveAttention(isChatVisible: () => boolean) {
  let live: HarnessLiveState = { turnState: 'working', turnEndedAt: null };
  const adapter = fakeAdapter('claude', { getLiveStates: async () => new Map([['session-1', live]]) });
  const chat = linkedChat();
  const service = new SessionAttentionService(
    { getChats: () => [chat], getRepository: () => ({ name: 'repo' }), markChatSeen: async () => undefined } as never,
    { get: () => adapter } as never,
    new NotificationService(() => undefined, isChatVisible),
    () => worktreeRecord(),
    () => undefined,
    () => true,
    isChatVisible
  );
  return {
    service,
    set: (next: HarnessLiveState) => {
      live = next;
    },
  };
}

/** A wait with its stamp (the sessions file's statusUpdatedAt, Q32): a wait with no stamp never pops. */
const WAITING: HarnessLiveState = { turnState: 'working', turnEndedAt: null, waitingFor: 'permission prompt', writtenAt: Date.now() };

test('a wait that began in front of you is listed at once and stays listed until it ends (Q30), with no toast', async (t) => {
  useClock(t);
  windowState().state = { focused: true };
  let visible = false;
  const { service, set } = liveAttention(() => visible);
  await service.poll(true);

  visible = true; // the user typed the request into this chat
  set(WAITING);
  await service.poll();
  assert.deepEqual(service.sessionsNeedingYou(), ['chat-1'], 'in front of you: listed all the same');

  visible = false; // the user looks at another tab
  await service.poll();
  assert.deepEqual(service.sessionsNeedingYou(), ['chat-1']);
  service.markSeen('chat-1');
  await service.poll();
  assert.deepEqual(service.sessionsNeedingYou(), ['chat-1'], 'visited but unanswered: still listed');
  assert.deepEqual(toasts(), [], 'it began in front of you: no toast');

  set({ turnState: 'working', turnEndedAt: null });
  await service.poll();
  assert.deepEqual(service.sessionsNeedingYou(), [], 'the wait ended');
});

test('a wait already present at startup is listed, without a toast', async (t) => {
  const clock = useClock(t);
  windowState().state = { focused: true };
  const { service, set } = liveAttention(() => false);
  set(WAITING);
  await service.poll(true);
  assert.deepEqual(service.sessionsNeedingYou(), ['chat-1'], 'listed on the first pass');
  for (let tick = 0; tick < 30; tick++) {
    clock.advance(4_000);
    await service.poll();
  }
  assert.deepEqual(service.sessionsNeedingYou(), ['chat-1']);
  assert.deepEqual(toasts(), [], 'a wait that predates activation never toasts, even past the cooldown');
});

test('a wait that begins while you look elsewhere toasts once', async (t) => {
  const clock = useClock(t);
  windowState().state = { focused: true };
  const { service, set } = liveAttention(() => false);
  await service.poll(true);
  set(WAITING);
  await service.poll();
  for (let tick = 0; tick < 10; tick++) {
    clock.advance(4_000);
    await service.poll();
  }
  assert.equal(toasts().length, 1, 'one toast within the cooldown');
  assert.match(toasts()[0], /needs your input .*permission prompt/);
  assert.deepEqual(service.sessionsNeedingYou(), ['chat-1']);
});

test('a suppressed toast does not start the cooldown', async (t) => {
  const clock = useClock(t);
  windowState().state = { focused: true };
  const { service, set } = liveAttention(() => false);
  await service.poll(true);
  stub.__setConfiguration('notifications.onNeedsInput', false);
  set(WAITING);
  await service.poll();
  assert.equal(toasts().length, 0, 'held back by the setting');

  stub.__setConfiguration('notifications.onNeedsInput', true);
  clock.advance(4_000);
  await service.poll();
  assert.equal(toasts().length, 1, 'the held-back toast fires on the next tick, not after a cooldown');
});

test('a wait toasts at most once, even after the user looks at it and leaves', async (t) => {
  const clock = useClock(t);
  windowState().state = { focused: true };
  let visible = false;
  const { service, set } = liveAttention(() => visible);
  await service.poll(true);
  set(WAITING);
  await service.poll();
  assert.equal(toasts().length, 1, 'the wait began unseen');

  visible = true; // the user looks at it and does not answer
  clock.advance(4_000);
  await service.poll();
  visible = false;
  clock.advance(61_000);
  await service.poll();
  assert.equal(toasts().length, 1, 'the same wait never toasts again');
  assert.deepEqual(service.sessionsNeedingYou(), ['chat-1'], 'it is still listed');

  set({ turnState: 'working', turnEndedAt: null }); // answered
  clock.advance(4_000);
  await service.poll();
  set(WAITING); // a new wait begins unseen, past the cooldown
  clock.advance(NEEDS_INPUT_COOLDOWN_MS);
  await service.poll();
  assert.equal(toasts().length, 2, 'a new wait may toast');
});

/** Editor tabs for the visibility tests; the first becomes the active tab of the one group. */
function showTabs(...tabs: { label: string; input: unknown }[]) {
  const all = tabs.map((tab, index) => ({ ...tab, isActive: index === 0 }));
  stub.window.tabGroups.all = [{ isActive: true, viewColumn: 1, activeTab: all[0], tabs: all }] as never;
}
const terminalTab = (label: string) => ({ label, input: new vscode.TabInputTerminal() });
const settingsTab = () => ({ label: 'Settings', input: new vscode.TabInputText(vscode.Uri.file('/work/settings.json')) });

function visibilityOf(chats: ChatSession[], terminals: Record<string, { name: string }>, adapters: HarnessAdapter[] = []) {
  const sources = {
    getChats: () => chats,
    adapters: () => adapters,
    getTerminal: (chatId: string) => terminals[chatId] as never,
    chatIdForTerminalName: (name: string) => Object.keys(terminals).find((chatId) => terminals[chatId].name === name),
  };
  return (chatId: string) => chatVisibility.isChatVisible(sources, chatId);
}

test('a terminal tab behind another tab, or with the window unfocused, is not visible', () => {
  const chat = linkedChat();
  const terminal = { name: 'Pitwall: Session [chat-1]' };
  const visible = visibilityOf([chat], { [chat.id]: terminal });
  // VS Code keeps the last focused terminal as activeTerminal after focus moves on.
  setActiveTerminal(terminal);

  windowState().state = { focused: true };
  showTabs(terminalTab(terminal.name), settingsTab());
  assert.ok(visible(chat.id), 'its editor terminal tab is in front of a focused window');

  showTabs(settingsTab(), terminalTab(terminal.name));
  assert.ok(!visible(chat.id), 'another tab is in front');

  showTabs(terminalTab(terminal.name));
  windowState().state = { focused: false };
  assert.ok(!visible(chat.id), 'the window is not focused');
});

test('a chat whose surface is its Claude panel tab is visible only when that tab is active in the active group and the window is focused', () => {
  const chat = linkedChat();
  const panelTab = { label: 'Fixture chat', input: new vscode.TabInputWebview('mainThreadWebview-claudeVSCodePanel') };
  showTabs(panelTab);
  const surfaces = claudeUiSurfaces({
    getTabGroups: () => stub.window.tabGroups.all as unknown as readonly vscode.TabGroup[],
    onDidChangeTabs: () => ({ dispose: () => undefined }),
    onDidChangeTabGroups: () => ({ dispose: () => undefined }),
    sessionIdForTab: (tab) => (tab.label === panelTab.label ? 'session-1' : undefined),
  });
  const adapter = fakeAdapter('claude', { nativeUi: { ...fakeNativeUi('Claude Code UI').nativeUi, surfaces } });
  const visible = visibilityOf([chat], {}, [adapter]);

  windowState().state = { focused: true };
  assert.ok(visible(chat.id), 'its panel tab is active in the active group');

  showTabs(settingsTab(), panelTab);
  assert.ok(!visible(chat.id), 'another tab is active');

  showTabs(panelTab);
  windowState().state = { focused: false };
  assert.ok(!visible(chat.id), 'the window is not focused');
  surfaces.dispose();
});

test('a chat whose terminal sits in the bottom panel is treated as not visible (known limitation)', () => {
  // VS Code exposes no stable API that says whether the bottom panel, or a
  // terminal in it, is on screen. activeTerminal only names the terminal that
  // has or last had focus, so a panel terminal never counts as in front:
  // listing a chat the user is looking at beats missing one they are not.
  const chat = linkedChat();
  const terminal = { name: 'Pitwall: Session [chat-1]' };
  const visible = visibilityOf([chat], { [chat.id]: terminal });
  setActiveTerminal(terminal);
  windowState().state = { focused: true };

  showTabs(settingsTab());
  assert.ok(!visible(chat.id), 'focused panel terminal, a file tab in the editor area');
  stub.window.tabGroups.all = [];
  assert.ok(!visible(chat.id), 'focused panel terminal, no editor tab at all');
});

// ---------------------------------------------------------------------------
// The tester's flow end to end: `claude agents --json` (an invented fixture in
// the real shape) → ClaudeAgentsService → ClaudeHarness.getLiveStates →
// attention → the tree row's mark and Go to Next Session That Needs You.
// ---------------------------------------------------------------------------

const FIXTURE_SESSION = 'aaaaaaaa-1111-4111-8111-000000000003';
const agentsFixture = () =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'claude-agents-waiting.json'), 'utf8')) as Record<
    string,
    unknown
  >[];

async function needsYouFlow(t: { after(fn: () => void): void }) {
  let waiting = false;
  const rows = agentsFixture();
  // Before the prompt the fixture's waiting session is busy, as Claude reports it.
  const agentsJson = () =>
    JSON.stringify(
      rows.map((row) => {
        if (row.sessionId !== FIXTURE_SESSION || waiting) {
          return row;
        }
        const { waitingFor: _waitingFor, ...busy } = row;
        return { ...busy, status: 'busy' };
      })
    );
  const storage = makeStorage();
  const repo = storage.addRepository('demo', '/work/demo');
  const worktree = worktreeRecord({ id: 'wt-main', repoId: repo.id, path: '/work/demo' });
  const agents = new ClaudeAgentsService({ command: () => 'claude', enabled: () => true, exec: async () => agentsJson() });
  // A transcript that ends in a tool call reads as mid-turn, as at a permission prompt.
  const transcripts = {
    getSessionFilePath: () => '/fake/transcript.jsonl',
    readTurnState: async () => ({ turnState: 'working' as const, turnEndedAt: null }),
    transcriptWrittenAt: async () => null,
    isSessionResumable: async () => true,
    getSessionById: async () => null,
    getProjectsDirectory: () => '/fake/projects',
  };
  const harness = new ClaudeHarness({
    agentsService: agents,
    sessionService: transcripts as never,
    nativeUi: fakeNativeUi('Claude Code UI').nativeUi,
  });
  const registry = new HarnessRegistry([harness]);
  const watchers = { registerPendingChat: () => undefined };
  const terminals = new TerminalManager(storage, registry, watchers as never);
  t.after(() => terminals.dispose());

  const chat = storage.createChat(worktree.id, 'claude', 'Fixture chat', { harnessSessionId: FIXTURE_SESSION });
  const terminal = (await terminals.openChat(chat, worktree))!;
  const getWorktree = (id: string) => (id === worktree.id ? worktree : undefined);
  const isChatOpen = (entry: ChatSession) => terminals.isActive(entry.id);
  const sources = {
    getChats: () => storage.getChats(),
    adapters: () => registry.all(),
    getTerminal: (chatId: string) => terminals.getTerminal(chatId),
    chatIdForTerminalName: (name: string) => terminals.getChatIdForTerminalName(name),
  };
  const isChatVisible = (chatId: string) => chatVisibility.isChatVisible(sources, chatId);
  const attentionService = new SessionAttentionService(
    storage,
    registry,
    new NotificationService(() => undefined, isChatVisible),
    getWorktree,
    () => undefined,
    isChatOpen,
    isChatVisible
  );

  const tree = new WorkspacesTreeProvider(
    storage,
    {
      listRepositoryWorktrees: () => ({ isGit: true, worktrees: [worktree] }),
      listRepositoryWorktreesAsync: async () => ({ isGit: true, worktrees: [worktree] }),
      getAheadBehind: () => null,
    } as never,
    terminals,
    registry,
    vscode.Uri.file('/extension')
  );
  t.after(() => tree.dispose());
  tree.setChatOpenProvider(isChatOpen);
  tree.setTurnStateProvider((chatId) => attentionService.getTurnState(chatId));
  tree.setNeedsYouProvider((chatId) => attentionService.needsYou(chatId));

  const activated: string[] = [];
  registerChatCommands({ subscriptions: [], extensionUri: vscode.Uri.file('/extension') } as never, {
    storageService: storage,
    gitService: {} as never,
    terminalManager: terminals,
    workspacesProvider: { getWorktreeById: getWorktree, getWorktreeByIdAsync: async (id: string) => getWorktree(id) } as never,
    harnessRegistry: registry,
    harnessWatcherRegistry: watchers as never,
    sessionImporter: { expectChat: async () => undefined, cancelExpectation: () => undefined },
    sessionsNeedingYou: () => attentionService.sessionsNeedingYou(),
    selectedRows: () => [],
    activeWorktree: () => undefined,
    activateChat: (entry) => {
      activated.push(entry.id);
      attentionService.markSeen(entry.id);
    },
    showWorktree: () => undefined,
    removeChats: () => [],
    refreshTree: () => undefined,
  });

  const worktreeRow = new WorkspaceTreeItem(worktree.name, 1, 'worktree', worktree, 'worktree');
  return {
    attentionService,
    activated,
    chatId: chat.id,
    terminalTab: () => terminalTab(terminal.name),
    /** The user clicks into the chat's editor terminal, which becomes VS Code's activeTerminal. */
    focusTerminal: () => setActiveTerminal(terminal),
    startWaiting: () => {
      waiting = true;
    },
    rowMark: async () => {
      await tree.whenListed();
      const row = (await tree.getChildren(worktreeRow)).find((item) => item.label === chat.name)!;
      return (row.iconPath as { light: vscode.Uri }).light.path.split('/').pop();
    },
  };
}

test("replay of the tester's flow: a prompt that appears while typing in the chat's terminal is needs-you, in front or not", async (t) => {
  const clock = useClock(t);
  windowState().state = { focused: true };
  const flow = await needsYouFlow(t);
  flow.focusTerminal();
  showTabs(flow.terminalTab(), settingsTab());
  await flow.attentionService.poll(true);

  flow.startWaiting(); // "run git status" stops at a permission prompt
  clock.advance(12_000);
  await flow.attentionService.poll();
  assert.equal(await flow.rowMark(), 'claude-light-needs.svg', 'in front of you: the row already shows needs-you (Q30)');

  showTabs(settingsTab(), flow.terminalTab()); // the user clicks another editor tab
  clock.advance(4_000);
  await flow.attentionService.poll();
  assert.equal(await flow.rowMark(), 'claude-light-needs.svg', 'the row shows needs-you');
  assert.deepEqual(flow.attentionService.sessionsNeedingYou(), [flow.chatId]);

  await runCommand('pitwall.openNextSessionNeedingYou');
  assert.deepEqual(flow.activated, [flow.chatId], 'Go to Next finds it');
  assert.ok(!shown('Nobody is waiting on you right now.'));
  assert.deepEqual(toasts(), [], 'the prompt appeared while the user was typing in it: no toast');
});

test('after a reload, an existing wait is listed and Go to Next Session That Needs You finds it, with no toast', async (t) => {
  const clock = useClock(t);
  windowState().state = { focused: true };
  const flow = await needsYouFlow(t);
  flow.startWaiting(); // already waiting when the extension host starts
  flow.focusTerminal(); // restored as the last focused terminal
  showTabs(settingsTab(), flow.terminalTab());
  await flow.attentionService.poll(true);
  assert.equal(await flow.rowMark(), 'claude-light-needs.svg', 'the row shows needs-you on the first pass');
  assert.deepEqual(flow.attentionService.sessionsNeedingYou(), [flow.chatId]);

  for (let tick = 0; tick < 20; tick++) {
    clock.advance(4_000);
    await flow.attentionService.poll();
  }
  await runCommand('pitwall.openNextSessionNeedingYou');
  assert.deepEqual(flow.activated, [flow.chatId], 'Go to Next finds it');
  assert.ok(!shown('Nobody is waiting on you right now.'));
  assert.deepEqual(toasts(), [], 'zero toasts, even past the cooldown');
});

// ---------------------------------------------------------------------------
// R40: the live S1 timelines on fake timers. Everything runs on the clock:
// the real 4 s attention timer (start()), the real 10 s agents cache with a
// 1.5 s fetch, the real harness join and the real visibility module. Unless a
// test says otherwise, no focus, tab or terminal event reaches the service;
// the tabs change under it and it only learns of that on its own ticks.
// ---------------------------------------------------------------------------

const T0 = 1_790_000_000_000;
const FETCH_MS = 1_500;

interface TimedOptions {
  /** When Claude reports a wait, in ms after activation: [start, end). */
  waits: [number, number][];
  /** When the session's transcript is written, in ms after activation. */
  writes: number[];
  /** The chat counts as open (a restored terminal or tab) only from this many ms after activation. */
  openAt?: number;
  /** The chat record's createdAt, in ms after activation. Default: long before. */
  createdAt?: number;
}

/**
 * The attention pipeline on mocked setInterval/setTimeout/Date. `claude
 * agents --json` takes 1.5 s and reports the state at the END of the call,
 * the adversarial case for the transcript rule: its sample is later than the
 * fetch start it is stamped with.
 */
function timedFlow(t: TestContext, options: TimedOptions) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: T0 });
  const elapsed = () => Date.now() - T0;
  const waitingAt = (at: number) => options.waits.some(([start, end]) => at >= start && at < end);
  const agentsJson = (waiting: boolean) =>
    JSON.stringify([
      {
        pid: 41003,
        cwd: '/repo',
        kind: 'interactive',
        startedAt: T0 - 60_000,
        sessionId: 'session-1',
        name: 'Session',
        ...(waiting ? { status: 'waiting', waitingFor: 'permission prompt' } : { status: 'busy' }),
      },
    ]);
  let fetches = 0;
  const agents = new ClaudeAgentsService({
    command: () => 'claude',
    enabled: () => true,
    exec: () =>
      new Promise((resolve) => {
        fetches++;
        setTimeout(() => resolve(agentsJson(waitingAt(elapsed()))), FETCH_MS);
      }),
  });
  const transcripts = {
    getSessionFilePath: () => '/fake/transcript.jsonl',
    readTurnState: async () => ({ turnState: 'working' as const, turnEndedAt: null }),
    transcriptWrittenAt: async () => {
      const past = options.writes.filter((at) => at <= elapsed());
      return past.length ? T0 + Math.max(...past) : null;
    },
    isSessionResumable: async () => true,
    getSessionById: async () => null,
    getProjectsDirectory: () => '/fake/projects',
  };
  const harness = new ClaudeHarness({
    agentsService: agents,
    sessionService: transcripts as never,
    nativeUi: fakeNativeUi('Claude Code UI').nativeUi,
  });
  const chat = linkedChat(options.createdAt === undefined ? {} : { createdAt: T0 + options.createdAt });
  const terminal = { name: 'Pitwall: Session [chat-1]' };
  const isVisible = visibilityOf([chat], { [chat.id]: terminal });
  const service = new SessionAttentionService(
    { getChats: () => [chat], getRepository: () => ({ name: 'repo' }), markChatSeen: async () => undefined } as never,
    { get: () => harness } as never,
    new NotificationService(() => undefined, isVisible),
    () => worktreeRecord(),
    () => undefined,
    () => elapsed() >= (options.openAt ?? 0),
    isVisible
  );
  t.after(() => service.dispose());

  const marks: { at: number; listed: boolean; needs: boolean; toasts: number }[] = [];
  /** Run the clock to `until` ms after activation in 100 ms steps, applying `actions` on time. */
  const runTo = async (until: number, actions: [number, () => void][] = []) => {
    while (elapsed() < until) {
      for (const [at, action] of actions) {
        if (at === elapsed()) {
          action();
        }
      }
      t.mock.timers.tick(100);
      await new Promise((resolve) => setImmediate(resolve));
      marks.push({
        at: elapsed(),
        listed: service.sessionsNeedingYou().includes(chat.id),
        needs: service.needsYou(chat.id),
        toasts: toasts().length,
      });
    }
  };
  return {
    service,
    chat,
    marks,
    runTo,
    fetches: () => fetches,
    front: () => showTabs(terminalTab(terminal.name), settingsTab()),
    away: () => showTabs(settingsTab(), terminalTab(terminal.name)),
  };
}

test('the attention poll runs on the timer with no focus or terminal events', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: T0 });
  let calls = 0;
  const adapter = fakeAdapter('claude', {
    getLiveStates: async () => {
      calls++;
      return new Map([['session-1', { turnState: 'working' as const, turnEndedAt: null }]]);
    },
  });
  const { service } = attention(linkedChat(), adapter);
  t.after(() => service.dispose());
  service.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, 'start() primes at once');
  for (let tick = 1; tick <= 5; tick++) {
    t.mock.timers.tick(4_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1 + tick, `tick ${tick} ran on the 4 s timer alone`);
  }
});

test('a wait that began in front, then the user looked away before the first sighting, marks and lists but does not toast', async (t) => {
  windowState().state = { focused: true };
  // The live S1-a timeline: the tool call is written just before the prompt
  // shows at +8.0 s; the user switches to a file at +8.4 s.
  const flow = timedFlow(t, { waits: [[8_000, 120_000]], writes: [7_999] });
  flow.front(); // typing the request into the chat
  flow.service.start();
  await flow.runTo(40_000, [[8_400, flow.away]]);

  const firstNeeds = flow.marks.find((mark) => mark.needs);
  assert.ok(firstNeeds, 'the row shows needs-you');
  assert.ok(firstNeeds.at <= 8_000 + 10_000 + 4_000 + FETCH_MS, `marked within one cache cycle and tick (at ${firstNeeds.at})`);
  assert.deepEqual(flow.service.sessionsNeedingYou(), [flow.chat.id], 'listed for Go to Next');
  assert.deepEqual(toasts(), [], 'the wait could have begun while the chat was in front: no toast');
});

test('a wait that begins genuinely unseen marks, lists and toasts exactly once', async (t) => {
  windowState().state = { focused: true };
  // The user types the request, leaves at +0.5 s, and the prompt shows at
  // +20 s, after a no-wait sample taken while the chat was already behind.
  const flow = timedFlow(t, { waits: [[20_000, 120_000]], writes: [19_999] });
  flow.front();
  flow.service.start();
  await flow.runTo(90_000, [[500, flow.away]]);

  const firstNeeds = flow.marks.find((mark) => mark.needs);
  assert.ok(firstNeeds && firstNeeds.at <= 20_000 + 10_000 + 4_000 + FETCH_MS, 'marked within one cache cycle and tick');
  assert.deepEqual(flow.service.sessionsNeedingYou(), [flow.chat.id]);
  assert.equal(toasts().length, 1, 'one toast, and only one, past the cooldown');
  assert.match(toasts()[0], /Session needs your input .*permission prompt/);
});

test('a wait whose first sample was fetched just before its tool call was written still marks on the next fetch', async (t) => {
  windowState().state = { focused: true };
  // Fetches start at 0, 12 and 24 s. The one at 12 s reports the prompt that
  // shows at 12.5 s, but its stamp predates the tool-call write at 12.499 s,
  // so it is held back; the 24 s fetch is newer than the write and counts.
  const flow = timedFlow(t, { waits: [[12_500, 120_000]], writes: [12_499] });
  flow.away();
  flow.service.start();
  await flow.runTo(40_000);

  assert.ok(!flow.marks.some((mark) => mark.needs && mark.at < 24_000), 'the straddling sample is not trusted');
  const firstNeeds = flow.marks.find((mark) => mark.needs);
  assert.ok(firstNeeds && firstNeeds.at <= 24_000 + FETCH_MS + 100, `marked by the next fetch (at ${firstNeeds?.at})`);
  assert.equal(toasts().length, 1, 'it began unseen');
});

test('after a deny, a stale cached waiting result does not re-mark the chat', async (t) => {
  windowState().state = { focused: true };
  // The prompt shows at +8 s in front of the user and is sighted by the 12 s
  // fetch. The user denies at +14 s (a transcript write) and switches to a
  // file at +15 s, while the cache still holds the 12 s "waiting" sample.
  const flow = timedFlow(t, { waits: [[8_000, 14_000]], writes: [7_999, 14_000] });
  flow.front();
  flow.service.start();
  await flow.runTo(40_000, [[15_000, flow.away]]);

  // Until the 16 s tick the row shows the wait it last saw (Q30: listed even
  // in front); from that tick on, the stale cached sample (taken at 12 s,
  // before the deny's write) never marks or lists it again.
  const stale = flow.marks.filter((mark) => mark.at > 16_000 + FETCH_MS && (mark.needs || mark.listed));
  assert.deepEqual(stale.map((mark) => mark.at).slice(0, 3), [], 'no re-mark or listing from the stale sample');
  assert.ok(!flow.marks.some((mark) => mark.at > 16_000 && mark.at < 23_500 && mark.needs), 'not while the stale sample is cached');
  assert.deepEqual(toasts(), []);
  assert.ok(flow.fetches() >= 3, 'the cache did refresh during the run');
});

test('a one-second look strictly between two ticks counts as seen: no toast', async (t) => {
  windowState().state = { focused: true };
  // Ticks run at 0, 4, 8, 12 s. The prompt shows unseen at +8.0 s; the user
  // looks at the chat from +9.0 s to +10.0 s, and the first sample to report
  // the wait lands at +13.5 s. The tab events record the look; they never poll.
  const flow = timedFlow(t, { waits: [[8_000, 120_000]], writes: [7_999] });
  const subscriptions = chatVisibility.onFrontMayChange(() => flow.service.noteFront());
  t.after(() => subscriptions.forEach((subscription) => subscription.dispose()));
  const tabsChanged = () => (stub.window as unknown as { __fireTabsChanged(): void }).__fireTabsChanged();
  flow.away();
  flow.service.start();
  await flow.runTo(40_000, [
    [9_000, () => (flow.front(), tabsChanged())],
    [10_000, () => (flow.away(), tabsChanged())],
  ]);

  assert.ok(flow.marks.some((mark) => mark.needs), 'the row still shows needs-you');
  assert.deepEqual(flow.service.sessionsNeedingYou(), [flow.chat.id], 'and it is listed');
  assert.deepEqual(toasts(), [], 'the user saw the prompt between ticks: no toast');
});

// R45: a wait already pending at activation is pre-existing. R41's transcript
// anchor must not turn it into a "new" wait just because the mtime is known.
test('after a reload, a pending wait with a known transcript time is listed and marked but never toasts (R45)', async (t) => {
  windowState().state = { focused: true };
  // The prompt showed at -30 s, before this service started, and the
  // transcript was written then. The chat is not in front, and its
  // terminal restores after the baseline pass, so the wait is first seen on a
  // tick after it.
  const flow = timedFlow(t, { waits: [[-30_000, 600_000]], writes: [-30_001], openAt: 2_000 });
  flow.away();
  flow.service.start();
  await flow.runTo(60_000);

  assert.ok(flow.marks.some((mark) => mark.needs), 'the row shows needs-you');
  assert.deepEqual(flow.service.sessionsNeedingYou(), [flow.chat.id], 'listed for Go to Next');
  assert.deepEqual(toasts(), [], 'present at activation: never a toast, even after 60 s of ticks');
});

test('a wait that begins after a no-wait observation since activation can still toast (R45 guard)', async (t) => {
  windowState().state = { focused: true };
  const flow = timedFlow(t, { waits: [[20_000, 600_000]], writes: [19_999] });
  flow.away();
  flow.service.start();
  await flow.runTo(60_000);

  assert.ok(flow.marks.some((mark) => mark.needs), 'the row shows needs-you');
  assert.equal(toasts().length, 1, 'observed clear after activation, then a wait: it toasts once');
});

test('a chat launched after activation whose very first agents result is waiting, with the user elsewhere, toasts once (R45)', async (t) => {
  windowState().state = { focused: true };
  // "+" at +5 s, the user switches to a file at once, and the prompt shows
  // 1 s later. The chat's first poll already reports the wait.
  const flow = timedFlow(t, { waits: [[6_000, 600_000]], writes: [5_999], openAt: 5_000, createdAt: 5_000 });
  flow.away();
  flow.service.start();
  await flow.runTo(60_000);

  assert.ok(flow.marks.some((mark) => mark.needs), 'the row shows needs-you');
  assert.equal(toasts().length, 1, 'it began unseen, after activation: one toast');
});

test('the front-change events are the active terminal, tabs, tab groups and window focus; they only notify', () => {
  let notes = 0;
  const subscriptions = chatVisibility.onFrontMayChange(() => notes++);
  const window = stub.window as unknown as {
    __fireTabsChanged(): void;
    __setWindowState(state: { focused: boolean }): void;
  };
  window.__fireTabsChanged();
  window.__setWindowState({ focused: false });
  setActiveTerminal({ name: 'Pitwall: Session [chat-1]' });
  assert.equal(notes, 3);
  assert.equal(subscriptions.length, 4, 'tab groups too');
  subscriptions.forEach((subscription) => subscription.dispose());
  window.__fireTabsChanged();
  assert.equal(notes, 3, 'disposed with the extension');
});

// ---------------------------------------------------------------------------
// R41: the wait is anchored at the transcript write that comes just before
// the prompt (the tool call), so only a look AFTER the prompt appeared holds
// the toast back. The front history comes from the tab events, as wired in
// extension.ts; the events still never poll.
// ---------------------------------------------------------------------------

/** timedFlow with the extension's front-change wiring; `tabsAt` moves the tabs and fires the event. */
function timedFlowWithEvents(t: TestContext, options: TimedOptions) {
  const flow = timedFlow(t, options);
  const subscriptions = chatVisibility.onFrontMayChange(() => flow.service.noteFront());
  t.after(() => subscriptions.forEach((subscription) => subscription.dispose()));
  const tabsChanged = () => (stub.window as unknown as { __fireTabsChanged(): void }).__fireTabsChanged();
  return {
    ...flow,
    awayWithEvent: () => (flow.away(), tabsChanged()),
  };
}

test('S1-b as walked: the user leaves 0.3 s after sending, the prompt shows 2 s later; it marks and toasts exactly once', async (t) => {
  windowState().state = { focused: true };
  // Enter at +6.0 s with the chat in front, a file in front from +6.3 s, the
  // tool call written at +7.999 s and the prompt at +8.0 s.
  const flow = timedFlowWithEvents(t, { waits: [[8_000, 120_000]], writes: [7_999] });
  flow.front();
  flow.service.start();
  await flow.runTo(90_000, [[6_300, flow.awayWithEvent]]);

  assert.ok(flow.marks.some((mark) => mark.needs), 'the row shows needs-you');
  assert.deepEqual(flow.service.sessionsNeedingYou(), [flow.chat.id], 'listed for Go to Next');
  assert.equal(toasts().length, 1, 'the chat was not in front after the prompt appeared: exactly one toast');
});

test('S1-a with the tab events: the prompt shows in front and the user leaves 0.4 s later; it marks with no toast', async (t) => {
  windowState().state = { focused: true };
  const flow = timedFlowWithEvents(t, { waits: [[8_000, 120_000]], writes: [7_999] });
  flow.front();
  flow.service.start();
  await flow.runTo(40_000, [[8_400, flow.awayWithEvent]]);

  assert.ok(flow.marks.some((mark) => mark.needs), 'the row shows needs-you');
  assert.deepEqual(flow.service.sessionsNeedingYou(), [flow.chat.id]);
  assert.deepEqual(toasts(), [], 'the user had the prompt in front: no toast');
});

test('with no transcript time (missing file or failed stat), the wait falls back to the window since the last no-wait sample', async (t) => {
  windowState().state = { focused: true };
  // The S1-b-as-walked timeline again, but the stat finds nothing: the chat
  // was in front inside [last no-wait fetch, now], so no toast.
  const flow = timedFlowWithEvents(t, { waits: [[8_000, 120_000]], writes: [] });
  flow.front();
  flow.service.start();
  await flow.runTo(40_000, [[6_300, flow.awayWithEvent]]);

  assert.ok(flow.marks.some((mark) => mark.needs), 'the row still shows needs-you');
  assert.deepEqual(toasts(), [], 'fallback window includes the time in front');
});

test('a transcript older than the last no-wait fetch anchors the wait at that fetch: an earlier glance does not suppress the toast', async (t) => {
  windowState().state = { focused: true };
  // The transcript was last written at +1 s; the user had the chat in front
  // until +3 s. Fetches at 0 and 12 s find no wait; the prompt shows at +20 s
  // and the 24 s fetch reports it. The wait start is max(mtime, last no-wait
  // fetch) = 12 s, so R41 can only narrow R40's window: the glance before
  // 12 s does not count.
  const flow = timedFlowWithEvents(t, { waits: [[20_000, 120_000]], writes: [1_000] });
  flow.front();
  flow.service.start();
  await flow.runTo(60_000, [[3_000, flow.awayWithEvent]]);

  assert.ok(flow.marks.some((mark) => mark.needs), 'the row shows needs-you');
  assert.equal(toasts().length, 1, 'anchored at the 12 s fetch, after the glance: one toast');
});

// ---------------------------------------------------------------------------
// Row status for every chat (rows 3.3, P5, P16, QA S4–S6). Toasts stay limited
// to open chats; every row gets a status, from the open-chat tick, the live
// sessions file for closed chats, and the discovery scan for the rest.
// ---------------------------------------------------------------------------

interface RowFlowOptions {
  /** Chat ids open in a terminal or tab. */
  open?: Set<string>;
  /** Chat ids in front of the user. */
  visible?: Set<string>;
  /** Native session ids live in the sessions file. */
  live?: () => Set<string>;
  /** Live state per native session id; missing ids are not reported. */
  states?: () => Record<string, HarnessLiveState>;
}

/** An attention service over real storage, with toasts through the real notification service. */
function rowFlow(storage: ReturnType<typeof makeStorage>, options: RowFlowOptions = {}) {
  const open = options.open ?? new Set<string>();
  const visible = options.visible ?? new Set<string>();
  const polled: string[][] = [];
  const adapter = fakeAdapter('claude', {
    liveSessionIds: async () => options.live?.() ?? new Set<string>(),
    getLiveStates: async (sessionIds: string[]) => {
      polled.push([...sessionIds]);
      const states = options.states?.() ?? {};
      return new Map(sessionIds.flatMap((id) => (states[id] ? [[id, states[id]] as [string, HarnessLiveState]] : [])));
    },
  });
  const seenWrites: [string, number][] = [];
  const markChatSeen = storage.markChatSeen.bind(storage);
  storage.markChatSeen = (chatId: string, at: number) => {
    seenWrites.push([chatId, at]);
    return markChatSeen(chatId, at);
  };
  const isVisible = (chatId: string) => visible.has(chatId);
  const service = new SessionAttentionService(
    storage,
    new HarnessRegistry([adapter]),
    new NotificationService(() => undefined, isVisible),
    (id) => worktreeRecord({ id, path: `/repo/${id}` }),
    () => undefined,
    (chat) => open.has(chat.id),
    isVisible
  );
  const changes: string[][] = [];
  service.onDidChangeStatus((ids) => changes.push(ids));
  return { service, polled, seenWrites, changes, open, visible };
}

test('a closed session gets a status dot from the sessions file', async () => {
  const storage = makeStorage();
  const openChat = storage.createChat('wt-1', 'claude', 'Open', { harnessSessionId: 's-open' });
  const closedLive = storage.createChat('wt-1', 'claude', 'Closed but running', { harnessSessionId: 's-live' });
  const closedQuiet = storage.createChat('wt-1', 'claude', 'Closed and quiet', { harnessSessionId: 's-quiet' });
  let liveStatus: HarnessLiveState['liveStatus'] = 'busy';
  const flow = rowFlow(storage, {
    open: new Set([openChat.id]),
    live: () => new Set(['s-live']),
    states: () => ({
      's-open': { turnState: 'working', turnEndedAt: null, liveStatus: 'busy' },
      's-live': { turnState: 'working', turnEndedAt: null, liveStatus, ...(liveStatus === 'waiting' ? { waitingFor: 'permission prompt' } : {}) },
    }),
  });
  await flow.service.poll(true);
  assert.equal(flow.service.statusOf(closedLive.id).status, 'working', 'the sessions file says busy');
  assert.equal(flow.service.statusOf(openChat.id).status, 'working');
  assert.equal(flow.service.statusOf(closedQuiet.id).status, 'idle');
  assert.ok(flow.changes.flat().includes(closedLive.id), 'the row change is announced');

  liveStatus = 'waiting';
  flow.changes.length = 0;
  await flow.service.poll();
  assert.equal(flow.service.statusOf(closedLive.id).status, 'needs');
  assert.deepEqual(flow.changes, [[closedLive.id]], 'only the chat whose status changed');
  assert.deepEqual(toasts(), [], 'a wait with no stamp never toasts (Q32)');

  // The discovery scan refreshes the turn state of chats the tick does not poll.
  flow.changes.length = 0;
  flow.service.noteSessions([sessionRecord('claude', 's-quiet', { turnState: 'done', turnEndedAt: Date.now() + 60_000 })]);
  assert.equal(flow.service.statusOf(closedQuiet.id).status, 'finished');
  assert.deepEqual(flow.changes, [[closedQuiet.id]]);
});

test('opening a finished chat marks it seen and it turns idle', async () => {
  const storage = makeStorage();
  const chat = storage.createChat('wt-1', 'claude', 'Finished elsewhere', { harnessSessionId: 's-1' });
  storage.updateChat(chat.id, { seenAt: 1_000 });
  const flow = rowFlow(storage);
  await flow.service.poll(true);
  flow.service.noteSessions([sessionRecord('claude', 's-1', { turnState: 'done', turnEndedAt: 5_000 })]);
  assert.equal(flow.service.statusOf(chat.id).status, 'finished');
  assert.equal(flow.service.statusOf(chat.id).statusSince, 5_000, 'finished since the turn ended');

  // pitwall.openChat → activateChat → markSeen.
  const before = Date.now();
  flow.service.markSeen(chat.id);
  assert.equal(flow.service.statusOf(chat.id).status, 'idle');
  assert.equal(flow.seenWrites.length, 1);
  assert.ok(flow.seenWrites[0][1] >= before);
  assert.ok((storage.getChat(chat.id)!.seenAt ?? 0) >= before, 'seenAt is stored');
  flow.service.markSeen(chat.id);
  assert.equal(flow.seenWrites.length, 1, 'an idle chat writes nothing');
});

test('a session whose turn ended before it was first listed is idle', async () => {
  const storage = makeStorage();
  const chat = storage.createChat('wt-1', 'claude', 'Imported', { harnessSessionId: 's-old' });
  const listedAt = storage.getChat(chat.id)!.seenAt!;
  const flow = rowFlow(storage);
  await flow.service.poll(true);
  flow.service.noteSessions([sessionRecord('claude', 's-old', { turnState: 'done', turnEndedAt: listedAt - 60_000 })]);
  assert.equal(flow.service.statusOf(chat.id).status, 'idle', 'not ~500 green dots on first run (QA B2)');
  assert.deepEqual(flow.seenWrites, []);
});

test('a chat kept in front writes seenAt at most once per finished turn', async (t) => {
  const clock = useClock(t);
  const storage = makeStorage();
  const chat = storage.createChat('wt-1', 'claude', 'In front', { harnessSessionId: 's-1' });
  let live: HarnessLiveState = { turnState: 'working', turnEndedAt: null, liveStatus: 'busy' };
  const flow = rowFlow(storage, { open: new Set([chat.id]), visible: new Set([chat.id]), states: () => ({ 's-1': live }) });
  await flow.service.poll(true);
  clock.advance(4_000);
  live = { turnState: 'done', turnEndedAt: Date.now(), liveStatus: 'idle' };
  for (let tick = 0; tick < 5; tick++) {
    clock.advance(4_000);
    await flow.service.poll();
  }
  assert.equal(flow.seenWrites.length, 1, 'one write for the finished turn');
  assert.equal(flow.service.statusOf(chat.id).status, 'idle', 'a turn that ends in front of you is seen');

  live = { turnState: 'working', turnEndedAt: null, liveStatus: 'busy' };
  clock.advance(4_000);
  await flow.service.poll();
  clock.advance(4_000);
  live = { turnState: 'done', turnEndedAt: Date.now(), liveStatus: 'idle' };
  for (let tick = 0; tick < 5; tick++) {
    clock.advance(4_000);
    await flow.service.poll();
  }
  assert.equal(flow.seenWrites.length, 2, 'the next finished turn writes once more');
});

test("a closed chat's wait that began after activation pops once while closed, and reopening it never pops again", async (t) => {
  const clock = useClock(t);
  windowState().state = { focused: true };
  const storage = makeStorage();
  let live: HarnessLiveState = { turnState: 'working', turnEndedAt: null, liveStatus: 'busy' };
  const flow = popupFlow(storage, { live: () => new Set(['s-1']), states: () => ({ 's-1': live }) });
  const chat = storage.createChat('wt-1', 'claude', 'Reopened', { harnessSessionId: 's-1' });
  flow.open.add(chat.id);
  await flow.service.poll(true);
  await flow.service.poll();
  assert.equal(flow.service.statusOf(chat.id).status, 'working');

  flow.open.delete(chat.id);
  await flow.service.poll();
  assert.equal(flow.service.statusOf(chat.id).status, 'working', 'closing keeps the row status');

  const stamp = Date.now();
  live = { turnState: 'working', turnEndedAt: null, liveStatus: 'waiting', waitingFor: 'permission prompt', writtenAt: stamp, statusUpdatedAt: stamp };
  await flow.service.poll();
  assert.equal(flow.service.statusOf(chat.id).status, 'needs', 'the closed row shows the wait');
  assert.equal(toasts().length, 1, 'closed, and the wait began after activation: it pops (Q31)');
  await flow.service.poll();
  assert.equal(toasts().length, 1, 'once');

  flow.open.add(chat.id);
  flow.visible.add(chat.id);
  await flow.service.poll();
  flow.visible.delete(chat.id);
  await flow.service.poll();
  await flow.service.poll();
  assert.equal(flow.service.statusOf(chat.id).status, 'needs');
  assert.deepEqual(flow.service.sessionsNeedingYou(), [chat.id], 'listed for Go to Next');
  assert.equal(toasts().length, 1, 'the same wait after the reopen: never again');

  // A new wait after the reopen is news again (ticks 4 s apart, as in the extension).
  clock.advance(4_000);
  live = { turnState: 'working', turnEndedAt: null, liveStatus: 'busy', statusUpdatedAt: Date.now() };
  await flow.service.poll();
  clock.advance(4_000);
  live = { turnState: 'working', turnEndedAt: null, liveStatus: 'waiting', waitingFor: 'permission prompt', writtenAt: Date.now(), statusUpdatedAt: Date.now() };
  await flow.service.poll();
  assert.equal(toasts().length, 2);
  assert.equal(flow.shownLines().length, 2, 'one shown line per pop-up');
});

test('at 500 chats a tick stats only open and live sessions-file chats', async () => {
  const chats = Array.from({ length: 500 }, (_, i) =>
    chatRecord({ id: `chat-${i}`, worktreeId: `wt-${i % 10}`, harnessSessionId: `s-${i}`, seenAt: 1 })
  );
  const open = new Set(['chat-3', 'chat-250']);
  const live = new Set(['s-7', 's-123', 's-499', 's-3']);
  const polled: string[] = [];
  const adapter = fakeAdapter('claude', {
    liveSessionIds: async () => live,
    getLiveStates: async (sessionIds: string[]) => {
      polled.push(...sessionIds);
      return new Map(sessionIds.map((id) => [id, { turnState: 'working' as const, turnEndedAt: null, liveStatus: 'busy' as const }]));
    },
  });
  const service = new SessionAttentionService(
    { getChats: () => chats, getRepository: () => ({ name: 'repo' }), markChatSeen: async () => undefined } as never,
    new HarnessRegistry([adapter]),
    { notify: () => true } as never,
    (id) => worktreeRecord({ id, path: `/repo/${id}` }),
    () => undefined,
    (chat) => open.has(chat.id),
    () => false
  );
  await service.poll(true);
  assert.deepEqual(polled.sort(), ['s-123', 's-250', 's-3', 's-499', 's-7'], 'open ∪ live, each once; 0 others');
  polled.length = 0;
  await service.poll();
  assert.equal(polled.length, 5);
  assert.equal(service.statusOf('chat-123').status, 'working');
  assert.equal(service.statusOf('chat-124').status, 'idle');
});

// ---------------------------------------------------------------------------
// Phase 5 (row 5.1): status and pop-ups for every listed chat, transitions
// with their lag, and exactly one pop-up per transition (Q29–Q34).
// ---------------------------------------------------------------------------

interface PopupFlowOptions extends RowFlowOptions {
  /** A real pop-up lock folder (the shared global storage); without one every claim wins. */
  ledgerDir?: string;
  /** The registry's answer for "in front of a focused window anywhere". */
  frontAnywhere?: (sessionId: string) => boolean;
  /** Live sessions whose turn is under way (busy or waiting); without it the adapter cannot tell. */
  underWay?: () => Set<string>;
  /** Whether this window's active tab is an unbound tab that may be the chat's (a brand-new chat being watched). */
  unboundFront?: (chat: ChatSession) => boolean;
  /** Runs after each discovery request is recorded (a test's import); returns the sessions still worth asking about again. */
  onUnlisted?: (sessionIds: string[]) => void | readonly string[] | Promise<void | readonly string[]>;
  /** The Windows pop-up host; without one every pop-up is the in-window message. */
  toast?: NotificationOptions['toast'];
  /** Whether the user is looking at this chat in this window; default: the chat is in `visible`. */
  isVisible?: (chatId: string) => boolean;
  /** Publishes this window's chat in front to the registry (as extension.ts wires it). */
  publishFront?: () => void;
}

/** rowFlow with the whole Phase 5 pop-up path: lock, front anywhere, listed check, log lines. */
function popupFlow(storage: ReturnType<typeof makeStorage>, options: PopupFlowOptions = {}) {
  const open = options.open ?? new Set<string>();
  const visible = options.visible ?? new Set<string>();
  const logs: string[] = [];
  const unlisted: string[][] = [];
  const claims: PopupKey[] = [];
  const ledger = options.ledgerDir ? new PopupLedger(options.ledgerDir) : undefined;
  const adapter = fakeAdapter('claude', {
    liveSessionIds: async () => options.live?.() ?? new Set<string>(),
    getLiveStates: async (sessionIds: string[]) => {
      const states = options.states?.() ?? {};
      return new Map(sessionIds.flatMap((id) => (states[id] ? [[id, states[id]] as [string, HarnessLiveState]] : [])));
    },
    ...(options.underWay ? { liveSessionsUnderWay: async () => options.underWay!() } : {}),
  });
  const isVisible = options.isVisible ?? ((chatId: string) => visible.has(chatId));
  const notifications = new NotificationService(() => undefined, isVisible, {
    ledger: {
      claim: async (key: PopupKey) => {
        claims.push(key);
        return ledger ? ledger.claim(key) : true;
      },
    },
    frontAnywhere: (sessionId) => options.frontAnywhere?.(sessionId) ?? false,
    isListed: (chatId) => storage.getChats().some((chat) => chat.id === chatId),
    unboundFront: options.unboundFront,
    log: (line) => logs.push(line),
    toast: options.toast,
    publishFront: options.publishFront,
  });
  const service = new SessionAttentionService(
    storage,
    new HarnessRegistry([adapter]),
    notifications,
    (id) => worktreeRecord({ id, path: `/repo/${id}` }),
    () => undefined,
    (chat) => open.has(chat.id),
    isVisible,
    {
      log: (line) => logs.push(line),
      onUnlistedLive: (sessionIds) => {
        unlisted.push([...sessionIds]);
        return options.onUnlisted?.(sessionIds);
      },
    }
  );
  const transitions: StatusTransition[] = [];
  service.onDidTransition((transition) => transitions.push(transition));
  return {
    service,
    open,
    visible,
    logs,
    claims,
    unlisted,
    transitions,
    shownLines: () => logs.filter((line) => / shown /.test(line)),
    skipped: (reason: string) => logs.filter((line) => line.endsWith(` skipped ${reason}`)),
    statusLines: () => logs.filter((line) => line.startsWith('[Pitwall] status ')),
  };
}

const busy = (stamp?: number): HarnessLiveState => ({
  turnState: 'working',
  turnEndedAt: null,
  liveStatus: 'busy',
  ...(stamp ? { statusUpdatedAt: stamp } : {}),
});
/** A sessions-file wait: statusUpdatedAt dates it, and the harness reports it as writtenAt too. */
const waitingAt = (stamp: number, waitingFor = 'permission prompt'): HarnessLiveState => ({
  turnState: 'working',
  turnEndedAt: null,
  liveStatus: 'waiting',
  waitingFor,
  writtenAt: stamp,
  statusUpdatedAt: stamp,
});
const idleAfter = (turnEndedAt: number): HarnessLiveState => ({ turnState: 'done', turnEndedAt, liveStatus: 'idle', statusUpdatedAt: turnEndedAt });
const finishedToasts = () => stub.__messages.map((args) => String(args[0])).filter((text) => text.includes(' finished'));

test('R36–R45 toasts fire for every listed chat', async () => {
  windowState().state = { focused: true };
  const storage = makeStorage();
  const states: Record<string, HarnessLiveState> = {};
  const preChat = storage.createChat('wt-3', 'claude', 'Waiting at start', { harnessSessionId: 's-pre' });
  const flow = popupFlow(storage, { live: () => new Set(['s-open', 's-closed', 's-pre', 's-unlisted']), states: () => states });
  const openChat = storage.createChat('wt-1', 'claude', 'Open chat', { harnessSessionId: 's-open' });
  const closedChat = storage.createChat('wt-2', 'claude', 'Closed chat', { harnessSessionId: 's-closed' });
  flow.open.add(openChat.id);
  const t0 = Date.now();
  states['s-open'] = busy();
  states['s-closed'] = busy();
  states['s-pre'] = waitingAt(t0 - 60_000); // already waiting when the window starts
  states['s-unlisted'] = waitingAt(t0); // a live session Pitwall does not list
  await flow.service.poll(true);
  await flow.service.poll();

  states['s-open'] = waitingAt(t0 + 1);
  states['s-closed'] = waitingAt(t0 + 2);
  await flow.service.poll();
  await flow.service.poll();
  await flow.service.poll();
  assert.equal(toasts().length, 2, 'one toast each for the open and the closed chat');
  assert.equal(toasts().filter((text) => text.includes('Closed chat')).length, 1, 'the closed chat pops once');
  assert.equal(toasts().filter((text) => text.includes('Open chat')).length, 1);
  assert.ok(!toasts().some((text) => text.includes('Waiting at start')), 'a wait already there at activation never pops (R45)');
  assert.equal(flow.shownLines().length, 2, 'exactly one shown per transition');
  assert.equal(flow.skipped('pre-existing').length, 1, 'the pre-existing wait is judged once, and logged');
  assert.equal(flow.service.statusOf(closedChat.id).status, 'needs');
  assert.deepEqual(flow.service.sessionsNeedingYou(), [preChat.id, openChat.id, closedChat.id], 'every listed waiting chat, oldest wait first');
  assert.ok(!flow.claims.some((key) => key.sessionId === 's-unlisted'), 'an unlisted session never reaches the lock');
});

test('a waiting chat in front stays on the needs-you list and in counts()', async () => {
  windowState().state = { focused: true };
  const storage = makeStorage();
  let live = busy();
  const flow = popupFlow(storage, { states: () => ({ 's-1': live }) });
  const chat = storage.createChat('wt-1', 'claude', 'In front', { harnessSessionId: 's-1' });
  flow.open.add(chat.id);
  flow.visible.add(chat.id);
  await flow.service.poll(true);
  live = waitingAt(Date.now());
  await flow.service.poll();
  assert.deepEqual(flow.service.sessionsNeedingYou(), [chat.id]);
  assert.deepEqual(flow.service.needsYouOrder().map((entry) => entry.chatId), [chat.id]);
  assert.equal(flow.service.needsYou(chat.id), true, 'the row shows needs-you');
  assert.deepEqual(flow.service.counts(), { needs: 1, working: 0, finished: 0 });
  assert.deepEqual(toasts(), [], 'in front of you: no pop-up');
  assert.equal(flow.skipped('front').length, 1);
});

test('a missing statusUpdatedAt uses the transcript time, else skips with no-stamp; never a .0 lock', async (t) => {
  windowState().state = { focused: true };
  const ledgerDir = path.join(tempDir(t), 'pitwall-popups');
  const storage = makeStorage();
  const states: Record<string, HarnessLiveState> = { 's-a': busy(), 's-b': busy() };
  const flow = popupFlow(storage, { ledgerDir, live: () => new Set(['s-a', 's-b']), states: () => states });
  storage.createChat('wt-1', 'claude', 'Has a transcript time', { harnessSessionId: 's-a' });
  storage.createChat('wt-2', 'claude', 'Has no stamp', { harnessSessionId: 's-b' });
  await flow.service.poll(true);
  const transcriptTime = Date.now() - 500;
  states['s-a'] = { turnState: 'working', turnEndedAt: null, liveStatus: 'waiting', waitingFor: 'permission prompt', writtenAt: transcriptTime };
  states['s-b'] = { turnState: 'working', turnEndedAt: null, liveStatus: 'waiting', waitingFor: 'permission prompt' };
  await flow.service.poll();
  await flow.service.poll();

  assert.deepEqual(flow.claims, [{ sessionId: 's-a', kind: 'needs', at: transcriptTime }], 'the transcript time keys the lock; no claim without a stamp');
  assert.equal(toasts().length, 1);
  assert.match(toasts()[0], /Has a transcript time/);
  assert.deepEqual(flow.skipped('no-stamp').map((line) => line.split(' ')[3]), ['s-b'], 'logged once, by id8');
  assert.deepEqual(fs.readdirSync(ledgerDir), [`s-a.needs.${transcriptTime}.lock`]);
  assert.ok(!fs.readdirSync(ledgerDir).some((name) => /\.0\.lock$/.test(name)));

  // The Claude harness: a sessions file with no statusUpdatedAt is dated by the transcript's last write.
  const sessionsDir = path.join(tempDir(t), 'sessions');
  fs.mkdirSync(sessionsDir);
  fs.writeFileSync(
    path.join(sessionsDir, '4242.json'),
    JSON.stringify({ pid: 4242, sessionId: 's-a', pidDomain: 'test:domain', cwd: '/repo', status: 'waiting', waitingFor: 'permission prompt' })
  );
  const harness = new ClaudeHarness({
    agentsService: new ClaudeAgentsService({ command: () => 'claude', enabled: () => false }),
    sessionsFile: new ClaudeSessionsFile({ dir: () => sessionsDir, isAlive: () => true, pidDomain: async () => 'test:domain' }),
    sessionService: {
      getSessionFilePath: () => '/fake/transcript.jsonl',
      readTurnState: async () => ({ turnState: 'working' as const, turnEndedAt: null }),
      transcriptWrittenAt: async () => 1_800_000_000_500.75,
      getProjectsDirectory: () => '/fake/projects',
    } as never,
    nativeUi: fakeNativeUi('Claude Code UI').nativeUi,
  });
  const state = (await harness.getLiveStates(['s-a'])).get('s-a');
  assert.equal(state?.writtenAt, 1_800_000_000_500, 'the transcript time, whole ms');
  assert.equal(state?.statusUpdatedAt, undefined, 'and no invented statusUpdatedAt');
  harness.dispose();
});

test('a window that lost the claim never pops the same wait after a later statusUpdatedAt rewrite', async (t) => {
  windowState().state = { focused: true };
  const ledgerDir = path.join(tempDir(t), 'pitwall-popups');
  const storage = makeStorage();
  let live = busy();
  const flow = popupFlow(storage, { ledgerDir, live: () => new Set(['s-1']), states: () => ({ 's-1': live }) });
  storage.createChat('wt-1', 'claude', 'Shared', { harnessSessionId: 's-1' });
  await flow.service.poll(true);
  const stamp = Date.now();
  // Another window saw the same transition first.
  assert.equal(await new PopupLedger(ledgerDir).claim({ sessionId: 's-1', kind: 'needs', at: stamp }), true);

  live = waitingAt(stamp);
  await flow.service.poll();
  assert.deepEqual(toasts(), []);
  assert.equal(flow.skipped('locked').length, 1, 'lost the claim');

  // Claude restamps the same wait (S2 checks whether it does): still one wait, used up here.
  live = waitingAt(stamp + 700);
  await flow.service.poll();
  await flow.service.poll();
  assert.deepEqual(toasts(), [], 'no second chance at the same wait');
  assert.equal(flow.claims.length, 1, 'never claimed again');
  assert.equal(flow.statusLines().length, 1, 'and the rewrite is no transition');
});

test('a disabled kind keeps the wait, and it pops once the setting is turned on', async () => {
  windowState().state = { focused: true };
  const storage = makeStorage();
  const states: Record<string, HarnessLiveState> = { 's-wait': busy(), 's-turn': busy() };
  const flow = popupFlow(storage, { live: () => new Set(['s-wait', 's-turn']), states: () => states });
  storage.createChat('wt-1', 'claude', 'Asks', { harnessSessionId: 's-wait' });
  storage.createChat('wt-2', 'claude', 'Works', { harnessSessionId: 's-turn' });
  await flow.service.poll(true);

  stub.__setConfiguration('notifications.onNeedsInput', false);
  stub.__setConfiguration('notifications.onTurnEnd', false);
  states['s-wait'] = waitingAt(Date.now());
  states['s-turn'] = idleAfter(Date.now() + 1);
  await flow.service.poll();
  await flow.service.poll();
  assert.deepEqual([toasts(), finishedToasts()], [[], []], 'held back by the settings');
  assert.equal(flow.skipped('disabled').length, 2, 'one line per held-back pop-up, not one per tick');

  stub.__setConfiguration('notifications.onNeedsInput', true);
  stub.__setConfiguration('notifications.onTurnEnd', true);
  await flow.service.poll();
  assert.equal(toasts().length, 1, 'the wait pops once its setting is on');
  assert.equal(finishedToasts().length, 1, 'and so does the finished turn');
  await flow.service.poll();
  assert.equal(flow.shownLines().length, 2, 'once each');
});

test("the in-window Open on a closed other-folder chat's message routes once through ChatRouter", async () => {
  windowState().state = { focused: false };
  stub.__setConfiguration('notifications.nativeBanner', false);
  const chat = linkedChat({ id: 'chat-far', worktreeId: 'wt-far', name: 'Far chat', harnessSessionId: 's-far' });
  const routed: unknown[] = [];
  const activated: string[] = [];
  let answer: 'routed' | 'here' = 'routed';
  const open = (chatId: string) =>
    chatId === chat.id
      ? openFromPopup(chat, {
          route: async (request) => {
            routed.push(request);
            return answer;
          },
          activateLocal: (entry) => activated.push(entry.id),
        })
      : Promise.resolve();
  const notifications = new NotificationService((chatId) => void open(chatId), () => false);
  stub.__informationResponses.push('Open');
  assert.equal(await notifications.notify('needs-input', { chat, context: 'far · main', detail: 'permission prompt', sessionId: 's-far', at: 5 }), 'shown');
  await flush();
  await flush();
  assert.deepEqual(routed, [{ kind: 'open', chats: [chat] }], 'one route, through the router (D35)');
  assert.deepEqual(activated, [], 'routed to its window: nothing is activated here');

  answer = 'here';
  stub.__informationResponses.push('Open');
  await notifications.notify('finished', { chat, context: 'far · main', sessionId: 's-far', at: 6 });
  await flush();
  await flush();
  assert.equal(routed.length, 2);
  assert.deepEqual(activated, [chat.id], 'opened here: its row is selected and marked seen');

  // The extension wires the message's Open to the router, not the old local focus.
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
  const wiring = source.slice(source.indexOf('new NotificationService('), source.indexOf('const attentionService = new SessionAttentionService('));
  assert.ok(/openFromPopup\(/.test(wiring) && /router\.route/.test(wiring), 'Open goes through openFromPopup and router.route');
  assert.ok(!/focusChat/.test(wiring), 'no local terminalManager.focusChat');
});

/** Chat commands over one linked chat whose open the given router answers. */
function goToNextFlow(t: { after(fn: () => void): void }, routeResult: 'routed' | 'here') {
  const storage = makeStorage();
  const repo = storage.addRepository('demo', '/work/demo');
  const worktree = worktreeRecord({ id: 'wt-main', repoId: repo.id, path: '/work/demo' });
  const registry = new HarnessRegistry([fakeAdapter('claude', { nativeUi: fakeNativeUi('Claude Code UI').nativeUi })]);
  const watchers = { registerPendingChat: () => undefined };
  const terminals = new TerminalManager(storage, registry, watchers as never);
  t.after(() => terminals.dispose());
  const chat = storage.createChat(worktree.id, 'claude', 'Elsewhere', { harnessSessionId: 's-1' });
  const activated: string[] = [];
  const routes: unknown[] = [];
  registerChatCommands({ subscriptions: [], extensionUri: vscode.Uri.file('/extension') } as never, {
    storageService: storage,
    gitService: {} as never,
    terminalManager: terminals,
    workspacesProvider: { getWorktreeById: () => worktree, getWorktreeByIdAsync: async () => worktree } as never,
    harnessRegistry: registry,
    harnessWatcherRegistry: watchers as never,
    sessionImporter: { expectChat: async () => undefined, cancelExpectation: () => undefined },
    sessionsNeedingYou: () => [chat.id],
    selectedRows: () => [],
    activeWorktree: () => undefined,
    activateChat: (entry) => activated.push(entry.id),
    showWorktree: () => undefined,
    removeChats: () => [],
    refreshTree: () => undefined,
    router: () => ({
      route: async (request: unknown) => {
        routes.push(request);
        return routeResult;
      },
    }),
  });
  return { chat, activated, routes };
}

test('Go to Next skips the local activateChat when the open was routed', async (t) => {
  const routed = goToNextFlow(t, 'routed');
  await runCommand('pitwall.openNextSessionNeedingYou');
  assert.equal(routed.routes.length, 1);
  assert.deepEqual(routed.activated, [], 'its own window marks it seen; this one selects nothing');

  stub.__reset();
  const here = goToNextFlow(t, 'here');
  await runCommand('pitwall.openNextSessionNeedingYou');
  assert.deepEqual(here.activated, [here.chat.id], 'opened here (or outside/gone, Q48): marked seen and selected here');
});

test('busy → idle on a live record is finished; a pid that disappears mid-turn is idle with no pop-up', async () => {
  windowState().state = { focused: true };
  const storage = makeStorage();
  const states: Record<string, HarnessLiveState> = { 's-done': busy(), 's-died': busy() };
  const flow = popupFlow(storage, { states: () => states });
  const done = storage.createChat('wt-1', 'claude', 'Ends normally', { harnessSessionId: 's-done' });
  const died = storage.createChat('wt-2', 'claude', 'Process dies', { harnessSessionId: 's-died' });
  flow.open.add(done.id);
  flow.open.add(died.id);
  await flow.service.poll(true);
  await flow.service.poll();

  states['s-done'] = idleAfter(Date.now() + 1);
  // The process is gone (a complete sessions read lacks it); the transcript still ends mid-turn.
  states['s-died'] = { turnState: 'working', turnEndedAt: null, running: false };
  await flow.service.poll();
  await flow.service.poll();
  assert.equal(flow.service.statusOf(done.id).status, 'finished');
  assert.equal(flow.service.statusOf(died.id).status, 'idle', 'a death mid-turn is idle, never working or finished');
  assert.equal(finishedToasts().length, 1);
  assert.match(finishedToasts()[0], /Ends normally finished/);
  assert.deepEqual(
    flow.transitions.map(({ chatId, from, to }) => [chatId, from, to]),
    [
      [done.id, 'working', 'finished'],
      [died.id, 'working', 'idle'],
    ]
  );
});

test('a chat in front of a focused window in another window does not pop', async () => {
  windowState().state = { focused: false };
  const storage = makeStorage();
  let live = busy();
  let elsewhere = true;
  const flow = popupFlow(storage, { live: () => new Set(['s-1']), states: () => ({ 's-1': live }), frontAnywhere: (sessionId) => elsewhere && sessionId === 's-1' });
  storage.createChat('wt-1', 'claude', 'Open in another window', { harnessSessionId: 's-1' });
  await flow.service.poll(true);
  live = waitingAt(Date.now());
  await flow.service.poll();
  assert.deepEqual(toasts(), []);
  assert.equal(flow.skipped('front').length, 1);

  elsewhere = false; // the user moves on without answering
  await flow.service.poll();
  assert.deepEqual(toasts(), [], 'in front anywhere uses up the wait');
});

test('every transition logs status <id8> from→to lag=', async () => {
  const storage = makeStorage();
  const sid = 'abcdef12-3456-4789-8abc-def012345678';
  let live = busy(Date.now());
  const flow = popupFlow(storage, { live: () => new Set([sid]), states: () => ({ [sid]: live }) });
  const chat = storage.createChat('wt-1', 'claude', 'Logged', { harnessSessionId: sid });
  await flow.service.poll(true);
  const stamp = Date.now() - 250;
  live = waitingAt(stamp);
  await flow.service.poll();
  live = busy(Date.now());
  await flow.service.poll();
  live = idleAfter(Date.now() + 5);
  await flow.service.poll();

  const lines = flow.statusLines();
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.match(lines[0], /^\[Pitwall\] status abcdef12 working→needs lag=\d+$/);
  assert.match(lines[1], /^\[Pitwall\] status abcdef12 needs→working lag=\d+$/);
  assert.match(lines[2], /^\[Pitwall\] status abcdef12 working→finished lag=\d+$/);
  assert.ok(Number(lines[0].split('lag=')[1]) >= 250, 'lag = detection time − statusUpdatedAt');
  assert.ok(lines.every((line) => !line.includes('Logged') && !line.includes('/repo')), 'no title, no path');
  const [first] = flow.transitions;
  assert.deepEqual(
    { chatId: first.chatId, sessionId: first.sessionId, from: first.from, to: first.to, at: first.at, waitingFor: first.waitingFor },
    { chatId: chat.id, sessionId: sid, from: 'working', to: 'needs', at: stamp, waitingFor: 'permission prompt' }
  );
  assert.equal(typeof first.observedAt, 'number');
});

test('a transition 1 s late or more logs its lag split: the agent\'s share and Pitwall\'s', async () => {
  const storage = makeStorage();
  const sid = 'abcdef12-3456-4789-8abc-def012345678';
  let live: HarnessLiveState = busy(Date.now());
  const flow = popupFlow(storage, { live: () => new Set([sid]), states: () => ({ [sid]: live }) });
  storage.createChat('wt-1', 'claude', 'Split', { harnessSessionId: sid, seenAt: Date.now() - 60_000 });
  await flow.service.poll(true);

  // The reply landed 2.7 s ago; Claude wrote idle 2.5 s after it (the owner's real chats: 2.2–3.2 s).
  const replyAt = Date.now() - 2_700;
  live = { turnState: 'done', turnEndedAt: replyAt, liveStatus: 'idle', statusUpdatedAt: replyAt + 2_500 };
  await flow.service.poll();
  const splits = () => flow.logs.filter((line) => line.startsWith('[Pitwall] lag split '));
  assert.equal(splits().length, 1, flow.logs.join('\n'));
  const [, agent, pitwall] = /agent=(\d+) pitwall=(\d+)$/.exec(splits()[0]) ?? [];
  assert.match(splits()[0], /^\[Pitwall\] lag split abcdef12 working→finished agent=\d+ pitwall=\d+$/);
  assert.equal(Number(agent), 2_500, "the agent's share: idle written 2.5 s after the reply");
  assert.ok(Number(pitwall) >= 200 && Number(pitwall) < 1_000, `Pitwall's share: ${pitwall} ms`);
  assert.ok(splits()[0].length < 80 && !splits()[0].includes('Split'), 'no title, no path');
  assert.equal(flow.statusLines().length, 1, 'the status line itself is unchanged');
  assert.match(flow.statusLines()[0], / lag=\d+$/);

  // A prompt transition is not split.
  live = busy(Date.now());
  await flow.service.poll();
  assert.equal(splits().length, 1, 'no split under 1 s');
});

test('the tick warms the pop-up host while a chat works or a pop-up is pending, and not while all are idle', async () => {
  const storage = makeStorage();
  const sid = 'abcdef12-3456-4789-8abc-def012345678';
  let warmed = 0;
  const shown: string[] = [];
  let live: HarnessLiveState = idleAfter(Date.now() - 60_000);
  const flow = popupFlow(storage, {
    live: () => new Set([sid]),
    states: () => ({ [sid]: live }),
    toast: { show: async (p) => (shown.push(p.tag), 'shown'), warm: () => warmed++ },
  });
  storage.createChat('wt-1', 'claude', 'Warm', { harnessSessionId: sid });
  await flow.service.poll(true);
  await flow.service.poll();
  assert.equal(warmed, 0, 'an idle chat warms nothing');

  live = busy(Date.now());
  await flow.service.poll();
  assert.equal(warmed, 1, 'a working chat warms the host before its pop-up');
  await flow.service.poll();
  assert.equal(warmed, 2, 'each tick while it works keeps it warm (restarts the idle clock)');

  live = idleAfter(Date.now() + 5);
  await flow.service.poll();
  assert.ok(warmed >= 3, 'the finished turn still pending a pop-up warms it on that tick');
  assert.deepEqual(shown, ['abcdef12-finished'], 'and the pop-up goes to the host');
  const after = warmed;
  await flow.service.poll();
  assert.equal(warmed, after, 'nothing left to pop: no more warming');
});

test('a re-poll with the same statusUpdatedAt makes no second transition', async () => {
  windowState().state = { focused: true };
  const storage = makeStorage();
  let live = busy();
  const flow = popupFlow(storage, { live: () => new Set(['s-1']), states: () => ({ 's-1': live }) });
  storage.createChat('wt-1', 'claude', 'Re-polled', { harnessSessionId: 's-1' });
  await flow.service.poll(true);
  live = waitingAt(Date.now());
  for (let tick = 0; tick < 5; tick++) {
    await flow.service.poll();
  }
  assert.equal(flow.transitions.length, 1);
  assert.equal(flow.statusLines().length, 1);
  assert.equal(toasts().length, 1);
  assert.equal(flow.shownLines().length, 1);
});

test('one status line and one notify per transition for a CLI chat stored twice; opening it clears the row you see', async () => {
  windowState().state = { focused: false };
  // Two windows imported the CLI session at once before the fix: two chat
  // records, one harness session (the S7 walk's uj-lab-c).
  const globalState = memento();
  const twin = (id: string, createdAt: number) =>
    chatRecord({ id, worktreeId: 'wt-c', name: 'T2-C ready', harnessSessionId: 's-cli', createdAt, lastAccessedAt: createdAt, seenAt: createdAt, autoImported: true });
  const t0 = Date.now() - 60_000;
  await globalState.update('pitwall.chats', [twin('chat-from-a', t0), twin('chat-from-c', t0 + 5)]);
  const storage = makeStorage(globalState);
  let live: HarnessLiveState = idleAfter(t0 - 1_000);
  const flow = popupFlow(storage, { live: () => new Set(['s-cli']), states: () => ({ 's-cli': live }) });
  assert.equal(storage.getChats().filter((chat) => chat.harnessSessionId === 's-cli').length, 1, 'one row for the session');
  await flow.service.poll(true);

  live = busy(Date.now());
  await flow.service.poll();
  live = waitingAt(Date.now());
  await flow.service.poll();
  live = busy(Date.now());
  await flow.service.poll();
  live = idleAfter(Date.now() + 1);
  await flow.service.poll();

  assert.deepEqual(
    flow.statusLines().map((line) => line.replace(/ lag=\d+$/, '')),
    [
      '[Pitwall] status s-cli idle→working',
      '[Pitwall] status s-cli working→needs',
      '[Pitwall] status s-cli needs→working',
      '[Pitwall] status s-cli working→finished',
    ],
    'one line per transition'
  );
  assert.equal(flow.shownLines().length, 2, 'one pop-up for the wait, one for the finish');
  assert.deepEqual(flow.skipped('locked'), [], 'no second copy losing its own lock');
  assert.equal(flow.claims.length, 2, 'one claim per transition');

  const [row] = storage.getChats().filter((chat) => chat.harnessSessionId === 's-cli');
  flow.service.markSeen(row.id);
  assert.deepEqual(flow.service.statuses(), { 's-cli': 'idle' }, 'opening the row you see turns it idle');
  assert.deepEqual(flow.service.counts(), { needs: 0, working: 0, finished: 0 });
});

test("counts() matches the sidebar list's needs, working and finished rows", async () => {
  windowState().state = { focused: true };
  const storage = makeStorage();
  const states: Record<string, HarnessLiveState> = { 's-n': busy(), 's-w': busy(), 's-f': busy(), 's-n2': busy() };
  const flow = popupFlow(storage, { live: () => new Set(['s-n', 's-w', 's-f', 's-n2']), states: () => states });
  const chats = ['s-n', 's-w', 's-f', 's-n2', 's-quiet'].map((sid, i) => storage.createChat(`wt-${i}`, 'claude', sid, { harnessSessionId: sid }));
  flow.open.add(chats[1].id);
  await flow.service.poll(true);
  states['s-n'] = waitingAt(Date.now());
  states['s-n2'] = waitingAt(Date.now() + 1, 'input needed');
  states['s-f'] = idleAfter(Date.now() + 2);
  await flow.service.poll();

  const rows = chats.map((chat) => flow.service.statusOf(chat.id).status);
  assert.deepEqual(rows, ['needs', 'working', 'finished', 'needs', 'idle']);
  const tally = (status: string) => rows.filter((row) => row === status).length;
  assert.deepEqual(flow.service.counts(), { needs: tally('needs'), working: tally('working'), finished: tally('finished') });
  flow.service.markSeen(chats[2].id);
  assert.deepEqual(flow.service.counts(), { needs: 2, working: 1, finished: 0 }, 'opening the finished chat drops it');
});

test('needsYouOrder() is oldest wait first across open and closed chats', async () => {
  windowState().state = { focused: true };
  const storage = makeStorage();
  const t0 = Date.now() - 10_000;
  const states: Record<string, HarnessLiveState> = { 'closed-1': busy(), 'open-1': busy(), 'closed-2': busy() };
  const flow = popupFlow(storage, { live: () => new Set(['closed-1', 'closed-2']), states: () => states });
  const closed1 = storage.createChat('wt-1', 'claude', 'Closed one', { harnessSessionId: 'closed-1' });
  const open1 = storage.createChat('wt-2', 'claude', 'Open one', { harnessSessionId: 'open-1' });
  const closed2 = storage.createChat('wt-3', 'claude', 'Closed two', { harnessSessionId: 'closed-2' });
  flow.open.add(open1.id);
  await flow.service.poll(true);
  states['closed-1'] = waitingAt(t0 + 3_000);
  states['open-1'] = waitingAt(t0 + 1_000);
  states['closed-2'] = waitingAt(t0 + 2_000);
  await flow.service.poll();
  assert.deepEqual(flow.service.needsYouOrder(), [
    { chatId: open1.id, since: t0 + 1_000 },
    { chatId: closed2.id, since: t0 + 2_000 },
    { chatId: closed1.id, since: t0 + 3_000 },
  ]);
  assert.deepEqual(flow.service.sessionsNeedingYou(), [open1.id, closed2.id, closed1.id]);
});

test('a live session in an unlisted folder asks discovery to refresh once per session per window', async () => {
  windowState().state = { focused: true };
  const storage = makeStorage();
  const live = new Set(['s-new']);
  const states: Record<string, HarnessLiveState> = { 's-new': busy() };
  const flow = popupFlow(storage, { live: () => live, states: () => states });
  await flow.service.poll(true);
  assert.deepEqual(flow.unlisted, [], "the first pass leaves it to discovery's own first pass (nothing runs before the first render)");
  await flow.service.poll();
  await flow.service.poll();
  assert.deepEqual(flow.unlisted, [['s-new']], 'one refresh for it, however many ticks see it');
  live.add('s-other');
  await flow.service.poll();
  assert.deepEqual(flow.unlisted, [['s-new'], ['s-other']], 'another unknown session asks once more');

  // The refresh lists it; its next wait pops (Q31).
  storage.createChat('wt-new', 'claude', 'Brand-new repo', { harnessSessionId: 's-new' });
  await flow.service.poll();
  states['s-new'] = waitingAt(Date.now());
  await flow.service.poll();
  assert.equal(toasts().length, 1);
  assert.match(toasts()[0], /Brand-new repo/);
  assert.equal(flow.unlisted.length, 2);
});

test('isUnlistedLive: a live session no row holds counts while it is tracked, and stops once it ends or is listed', async () => {
  windowState().state = { focused: true };
  const storage = makeStorage();
  const live = new Set(['s-ends', 's-listed']);
  const flow = popupFlow(storage, { live: () => live, states: () => ({ 's-ends': busy(), 's-listed': busy() }), onUnlisted: () => [] });
  await flow.service.poll(true);
  await flow.service.poll();
  assert.deepEqual(flow.unlisted, [['s-ends', 's-listed']]);
  assert.deepEqual(['s-ends', 's-listed', 's-never'].map((id) => flow.service.isUnlistedLive(id)), [true, true, false], 'asked about and settled, still live');
  live.delete('s-ends');
  storage.createChat('wt-1', 'claude', 'Listed by a full scan', { harnessSessionId: 's-listed' });
  await flow.service.poll();
  assert.deepEqual(['s-ends', 's-listed'].map((id) => flow.service.isUnlistedLive(id)), [false, false], 'ended; listed');
  flow.service.dispose();
});

test('a live session not yet listed triggers one discovery refresh when its first turn starts, and is listed within one poll', async () => {
  windowState().state = { focused: true };
  const storage = makeStorage();
  const live = new Set<string>();
  const underWay = new Set<string>();
  const states: Record<string, HarnessLiveState> = {};
  let imported: ChatSession | undefined;
  const flow = popupFlow(storage, {
    live: () => live,
    underWay: () => underWay,
    states: () => states,
    // The refresh finds the session's transcript and imports it.
    onUnlisted: (sessionIds) => {
      if (sessionIds.includes('s-new') && underWay.has('s-new')) {
        imported = storage.createChat('wt-c', 'claude', 'New CLI chat', { harnessSessionId: 's-new', autoImported: true });
      }
    },
  });
  await flow.service.poll(true);

  // `claude` starts in a console: a live record, idle, with no transcript yet.
  live.add('s-new');
  states['s-new'] = idleAfter(0);
  await flow.service.poll();
  await flow.service.poll();
  assert.deepEqual(flow.unlisted, [], 'nothing to find before the first prompt writes the transcript');

  // The first prompt: busy, and the transcript now exists.
  underWay.add('s-new');
  states['s-new'] = busy(Date.now());
  await flow.service.poll();
  assert.deepEqual(flow.unlisted, [['s-new']], 'one refresh, as the first turn starts');
  assert.ok(imported, 'the refresh listed it');
  await flow.service.poll();
  assert.equal(flow.service.statusOf(imported!.id).status, 'working', 'listed and tracked within one poll');
  assert.deepEqual(
    flow.statusLines().map((line) => line.replace(/ lag=\d+$/, '')),
    ['[Pitwall] status s-new idle→working'],
    "the new chat's first turn is a transition"
  );
});

test('the discovery refresh is rate-limited to once per unknown session per window', async () => {
  windowState().state = { focused: true };
  const storage = makeStorage();
  const live = new Set(['s-a']);
  const underWay = new Set(['s-a']);
  const flow = popupFlow(storage, { live: () => live, underWay: () => underWay, states: () => ({}) });
  await flow.service.poll(true);
  for (let tick = 0; tick < 5; tick++) {
    await flow.service.poll();
  }
  underWay.delete('s-a'); // its turn ends; the refresh found nothing to list
  await flow.service.poll();
  underWay.add('s-a'); // and the next one starts
  await flow.service.poll();
  assert.deepEqual(flow.unlisted, [['s-a']], 'once, however many ticks and turns see it');

  live.add('s-b');
  await flow.service.poll();
  assert.deepEqual(flow.unlisted, [['s-a']], 'another session idle since it started asks nothing yet');
  underWay.add('s-b');
  await flow.service.poll();
  await flow.service.poll();
  assert.deepEqual(flow.unlisted, [['s-a'], ['s-b']], 'and asks once when its turn starts');
});

/** Let the retry timer's poll, and the promise jobs it starts, run. */
const settleTimers = async (t: TestContext, ms: number) => {
  t.mock.timers.tick(ms);
  for (let i = 0; i < 20; i++) await flush();
};

test('a new chat whose transcript has nothing to import at the first ask is asked again, listed within 5 s, and its 15 s first turn pops up once (12f645db)', async (t) => {
  const T0 = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: T0 });
  windowState().state = { focused: true };
  const storage = makeStorage();
  const live = new Set<string>();
  const underWay = new Set<string>();
  const states: Record<string, HarnessLiveState> = {};
  let transcriptReady = false;
  let promptAt = 0;
  const flow = popupFlow(storage, {
    live: () => live,
    underWay: () => underWay,
    states: () => states,
    // The importer: nothing to import until the first prompt's line is in the transcript.
    onUnlisted: async (sessionIds) => {
      if (!transcriptReady) return sessionIds;
      storage.createChat('wt-a', 'claude', 'Night ferry story', { id: 'chat-new', harnessSessionId: 's-new', autoImported: true, seenAt: promptAt - 1 });
      return [];
    },
  });
  await flow.service.poll(true);

  // Open in New Tab, then the prompt: the live record is busy before Claude writes the transcript.
  const turnStart = Date.now();
  promptAt = turnStart;
  live.add('s-new');
  underWay.add('s-new');
  states['s-new'] = busy(turnStart);
  await flow.service.poll();
  for (let i = 0; i < 20; i++) await flush();
  assert.deepEqual(flow.unlisted, [['s-new']], 'asked as the turn starts');
  assert.equal(storage.getChat('chat-new'), undefined, 'too early: nothing to import');

  // The transcript lands half a second later; the service asks again on its own.
  await settleTimers(t, 500);
  transcriptReady = true;
  for (let waited = 500; !storage.getChat('chat-new'); waited += 100) {
    assert.ok(waited <= 5_000, 'listed within 5 s of the turn start');
    await settleTimers(t, 100);
  }
  assert.ok(flow.unlisted.length >= 2, 'asked again after the first answer said "not yet"');

  // Tracked from the next poll: the first turn is a transition.
  await flow.service.poll();
  assert.equal(flow.service.statusOf('chat-new').status, 'working');

  // The 15 s turn ends with the chat closed and nobody looking.
  await settleTimers(t, turnStart + 15_000 - Date.now());
  states['s-new'] = idleAfter(Date.now());
  underWay.delete('s-new');
  for (let tick = 0; tick < 4; tick++) {
    await flow.service.poll();
  }
  assert.deepEqual(
    flow.statusLines().map((line) => line.replace(/ lag=\d+$/, '')),
    ['[Pitwall] status s-new idle→working', '[Pitwall] status s-new working→finished']
  );
  assert.equal(finishedToasts().length, 1, 'exactly one finished pop-up');
  assert.equal(flow.shownLines().length, 1);
  const asks = flow.unlisted.length;
  await settleTimers(t, 60_000);
  await flow.service.poll();
  assert.equal(flow.unlisted.length, asks, 'listed: never asked about again');
  flow.service.dispose();
});

/** A 2.6 s first turn (dac4f591), over by the time the import lists it (seen as of its prompt); `unboundFront` says whether its unbound tab is in front. */
async function shortFirstTurn(focused: boolean, unboundTabInFront: boolean) {
  windowState().state = { focused };
  const storage = makeStorage();
  const live = new Set(['s-short']);
  const promptAt = Date.now() - 3_000;
  const states: Record<string, HarnessLiveState> = { 's-short': busy(promptAt) };
  const flow = popupFlow(storage, {
    live: () => live,
    states: () => states,
    unboundFront: (chat) => unboundTabInFront && chat.harnessSessionId === 's-short',
  });
  await flow.service.poll(true);
  states['s-short'] = idleAfter(promptAt + 2_600);
  storage.createChat('wt-b', 'claude', 'Short first turn', { harnessSessionId: 's-short', autoImported: true, seenAt: promptAt - 1 });
  for (let tick = 0; tick < 3; tick++) {
    await flow.service.poll();
  }
  assert.deepEqual(flow.statusLines().map((line) => line.replace(/ lag=\d+$/, '')), ['[Pitwall] status s-short idle→finished']);
  return flow;
}

test('a first turn that ended unwatched before its new chat was listed pops up once (another app in front)', async () => {
  // Notepad is in front: the window is not focused, though its active tab is the chat's unbound tab.
  const flow = await shortFirstTurn(false, true);
  assert.equal(finishedToasts().length, 1, 'one finished pop-up');
  assert.equal(flow.shownLines().length, 1);
});

test('a fast first turn watched in its own tab, not bound yet, never pops up (QA on #73)', async () => {
  // The window is focused and its active tab is the new chat's tab, which Pitwall has not bound yet.
  const flow = await shortFirstTurn(true, true);
  assert.equal(finishedToasts().length, 0, 'no pop-up while you watch it');
  assert.equal(flow.skipped('front').length, 1, 'judged once, as in front');
});

// ---------------------------------------------------------------------------
// QA round 2 on #73: the unbound-tab front check, wired as the extension
// wires it, silences only the one new chat the tab can be, never another
// chat's needs-input or finished pop-up.
// ---------------------------------------------------------------------------

/** One chat beside the unbound tab: when its session started, and its own surface. */
interface ChatBesideTab {
  sessionId: string;
  /** Started an hour before the tab opened. */
  older?: boolean;
  /** In a Pitwall terminal (its own surface). */
  inTerminal?: boolean;
  /** Has its own Claude tab, bound, while the unbound tab is in front again (R4). */
  boundTab?: boolean;
  /** Where the live record says its process started (default the Claude panel); `unknown`: the record doesn't say. */
  entrypoint?: 'claude-vscode' | 'cli' | 'unknown';
}

/**
 * The focused window's active tab is a Claude tab bound to no session: one
 * the user just opened ("Claude Code"), or with `restoredTab` one that was
 * there before the tracker started. Each chat's turn then ends at `kind`.
 */
async function popBesideUnboundTab(t: TestContext, kind: 'needs' | 'finished', chats: ChatBesideTab[], restoredTab = false) {
  windowState().state = { focused: true };
  const storage = makeStorage();
  const tabOf = (label: string) => ({ label, input: new vscode.TabInputWebview('mainThreadWebview-claudeVSCodePanel'), isActive: false });
  const group = { isActive: true, viewColumn: 1, activeTab: undefined as unknown, tabs: (restoredTab ? [tabOf('Claude Code')] : []) as unknown[] };
  group.activeTab = group.tabs[0];
  let fire: (event: vscode.TabChangeEvent) => void = () => undefined;
  const surfaces = claudeUiSurfaces({
    getTabGroups: () => [group] as never,
    onDidChangeTabs: (listener) => ((fire = listener), { dispose: () => undefined }),
    onDidChangeTabGroups: () => ({ dispose: () => undefined }),
    log: () => undefined,
  });
  t.after(() => surfaces.dispose());
  const openTab = (label: string) => {
    const tab = tabOf(label);
    group.tabs.push(tab);
    group.activeTab = tab;
    fire({ opened: [tab], closed: [], changed: [] } as never);
    return tab;
  };
  const open = new Set<string>();
  const live = new Set<string>();
  const states: Record<string, HarnessLiveState> = {};
  const entrypoints = new Map(chats.map((entry) => [entry.sessionId, entry.entrypoint ?? 'claude-vscode']));
  const list = (entry: ChatBesideTab) => {
    const startedAt = entry.older ? Date.now() - 60 * 60_000 : Date.now();
    const chat = storage.createChat('wt-a', 'claude', entry.sessionId, { harnessSessionId: entry.sessionId, createdAt: startedAt, lastAccessedAt: startedAt });
    if (entry.inTerminal) {
      open.add(chat.id);
    }
    live.add(entry.sessionId);
    states[entry.sessionId] = busy(Date.now());
  };
  chats.filter((entry) => entry.older).forEach(list);
  const unboundTab = restoredTab ? group.activeTab : openTab('Claude Code');
  chats.filter((entry) => !entry.older).forEach(list);
  for (const entry of chats.filter((candidate) => candidate.boundTab)) {
    surfaces.expect(entry.sessionId, `${entry.sessionId} tab`);
    openTab(`${entry.sessionId} tab`);
    assert.equal(surfaces.isOpen(entry.sessionId), true, 'its own tab is bound');
  }
  group.activeTab = unboundTab;
  fire({ opened: [], closed: [], changed: [unboundTab] } as never);
  assert.equal(surfaces.activeSessionId(), undefined, 'the unbound tab is in front');

  const flow = popupFlow(storage, {
    open,
    live: () => live,
    states: () => states,
    // As extension.ts wires it.
    unboundFront: (chat) =>
      chatVisibility.unboundTabMayBeChat(chat, {
        adapters: () => [
          {
            id: 'claude',
            nativeUi: { surfaces },
            // As ClaudeHarness answers from the tick's live record.
            isPanelSession: (id: string) => (entrypoints.get(id) === 'unknown' ? undefined : entrypoints.get(id) === 'claude-vscode'),
          } as never,
        ],
        chats: () => storage.getChats(),
        worktreePathOf: (entry) => `/repo/${entry.worktreeId}`,
        folders: () => ['/repo/wt-a'],
        isOpenAnywhere: (entry) => open.has(entry.id) || chatNativeSessionIds(entry).some((id) => surfaces.isOpen(id)),
      }),
  });
  await flow.service.poll(true);
  const stamp = Date.now() + 1;
  for (const id of live) {
    states[id] = kind === 'needs' ? waitingAt(stamp) : idleAfter(stamp);
  }
  while (Date.now() <= stamp) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await flow.service.poll();
  await flow.service.poll();
  const pops = kind === 'needs' ? toasts().length : finishedToasts().length;
  return { flow, pops };
}

for (const kind of ['needs', 'finished'] as const) {
  test(`a new empty tab never silences an hour-old Pitwall-terminal chat's ${kind} pop-up (QA round 2 on #73)`, async (t) => {
    const { flow, pops } = await popBesideUnboundTab(t, kind, [{ sessionId: 's-old', older: true, inTerminal: true }]);
    assert.equal(pops, 1);
    assert.deepEqual(flow.skipped('front'), []);
  });

  test(`a new empty tab never silences the ${kind} pop-up of an hour-old chat with no surface (an outside terminal)`, async (t) => {
    const { flow, pops } = await popBesideUnboundTab(t, kind, [{ sessionId: 's-old', older: true }]);
    assert.equal(pops, 1, 'it started before the tab opened');
    assert.deepEqual(flow.skipped('front'), []);
  });

  test(`a restored unbound tab (no open time) never silences a new chat's ${kind} pop-up`, async (t) => {
    const { flow, pops } = await popBesideUnboundTab(t, kind, [{ sessionId: 's-new' }], true);
    assert.equal(pops, 1);
    assert.deepEqual(flow.skipped('front'), []);
  });

  test(`two new chats beside one unbound tab: neither ${kind} pop-up is silenced`, async (t) => {
    const { flow, pops } = await popBesideUnboundTab(t, kind, [{ sessionId: 's-one' }, { sessionId: 's-two' }]);
    assert.equal(pops, 2);
    assert.deepEqual(flow.skipped('front'), []);
  });

  test(`a chat with its own bound tab pops ${kind} normally while another unbound tab is in front (R4)`, async (t) => {
    const { flow, pops } = await popBesideUnboundTab(t, kind, [{ sessionId: 's-bound', boundTab: true }]);
    assert.equal(pops, 1);
    assert.deepEqual(flow.skipped('front'), []);
  });

  test(`the one new chat that started after the unbound tab opened, with no surface, gives no ${kind} pop-up while you watch`, async (t) => {
    const { flow, pops } = await popBesideUnboundTab(t, kind, [{ sessionId: 's-new' }, { sessionId: 's-old', older: true, inTerminal: true }]);
    assert.equal(pops, 1, "only the older terminal chat's");
    assert.equal(flow.skipped('front').length, 1, 'the new chat, judged in front');
  });

  test(`a new empty tab never silences the ${kind} pop-up of a \`claude\` started after it in an outside terminal (QA #73 round 3, G1)`, async (t) => {
    const { flow, pops } = await popBesideUnboundTab(t, kind, [{ sessionId: 's-cli', entrypoint: 'cli' }]);
    assert.equal(pops, 1, 'a terminal process is never in a panel tab');
    assert.deepEqual(flow.skipped('front'), []);
  });

  test(`a new chat the live record says nothing of pops ${kind} beside an unbound tab (unknown never fits)`, async (t) => {
    const { flow, pops } = await popBesideUnboundTab(t, kind, [{ sessionId: 's-new', entrypoint: 'unknown' }]);
    assert.equal(pops, 1);
    assert.deepEqual(flow.skipped('front'), []);
  });

  test(`a new panel chat beside an outside-terminal chat started after the tab: only the terminal chat pops ${kind}`, async (t) => {
    const { flow, pops } = await popBesideUnboundTab(t, kind, [{ sessionId: 's-new' }, { sessionId: 's-cli', entrypoint: 'cli' }]);
    assert.equal(pops, 1, "the terminal chat's");
    assert.equal(flow.skipped('front').length, 1, 'the panel chat, judged in front');
  });
}

// ---------------------------------------------------------------------------
// RC walk on 8553eb3 (N2, N3): a chat in front of the focused window a never
// pops from window b, whichever window judges the turn end first. The two
// windows share the pop-up locks and the window registry, as real ones do.
// ---------------------------------------------------------------------------

/**
 * Window a's active tab is the chat's own: `new`, a brand-new chat's tab not
 * bound yet ("Claude Code: Open in New Tab", PR #73); `existing`, an hour-old
 * chat's bound tab. Window b lists the same chat and has nothing in front.
 * Window a publishes its front as extension.ts does: on the tab change and on
 * each poll while a pop-up may follow.
 */
async function twoWindowsOneInFront(t: TestContext, chat: 'new' | 'existing', aFocused = true) {
  const ledgerDir = path.join(tempDir(t), 'pitwall-popups');
  const sharedDir = tempDir(t);
  const registryA = new WindowRegistry(sharedDir, { pid: process.pid, folder: '/repo/wt-a' });
  const registryB = new WindowRegistry(sharedDir, { pid: process.ppid, folder: '/repo/wt-b' });
  t.after(() => (registryA.dispose(), registryB.dispose()));

  const tabOf = (label: string) => ({ label, input: new vscode.TabInputWebview('mainThreadWebview-claudeVSCodePanel'), isActive: false });
  const group = { isActive: true, viewColumn: 1, activeTab: undefined as unknown, tabs: [] as unknown[] };
  (stub.window as unknown as { tabGroups: { all: unknown[] } }).tabGroups.all = [group];
  let fire: (event: vscode.TabChangeEvent) => void = () => undefined;
  const surfaces = claudeUiSurfaces({
    getTabGroups: () => [group] as never,
    onDidChangeTabs: (listener) => ((fire = listener), { dispose: () => undefined }),
    onDidChangeTabGroups: () => ({ dispose: () => undefined }),
    log: () => undefined,
  });
  t.after(() => surfaces.dispose());
  const openTab = (label: string) => {
    const tab = tabOf(label);
    group.tabs.push(tab);
    group.activeTab = tab;
    fire({ opened: [tab], closed: [], changed: [] } as never);
  };

  const sessionId = chat === 'new' ? 's-new' : 's-old';
  const storages = [makeStorage(), makeStorage()];
  const listChat = (startedAt: number) =>
    storages.forEach((storage) =>
      storage.createChat('wt-a', 'claude', 'Watched', { id: 'chat-w', harnessSessionId: sessionId, createdAt: startedAt, lastAccessedAt: startedAt })
    );
  if (chat === 'new') {
    openTab('Claude Code');
    listChat(Date.now());
    assert.equal(surfaces.activeSessionId(), undefined, 'its tab is not bound yet');
  } else {
    listChat(Date.now() - 60 * 60_000);
    surfaces.expect(sessionId, 'Watched');
    openTab('Watched');
    assert.equal(surfaces.activeSessionId(), sessionId, 'its own tab, bound');
  }
  const states: Record<string, HarnessLiveState> = { [sessionId]: busy(Date.now()) };
  const live = () => new Set([sessionId]);

  // Window a, wired as extension.ts wires it.
  const adapterA = { id: 'claude', nativeUi: { surfaces }, isPanelSession: () => true } as unknown as HarnessAdapter;
  const sourcesA: chatVisibility.ChatVisibilitySources = {
    getChats: () => storages[0].getChats(),
    adapters: () => [adapterA],
    chatIdForTerminalName: () => undefined,
  };
  const unboundA: chatVisibility.UnboundFrontDeps = {
    adapters: () => [adapterA],
    chats: () => storages[0].getChats(),
    worktreePathOf: (entry) => `/repo/${entry.worktreeId}`,
    folders: () => ['/repo/wt-a'],
    isOpenAnywhere: (entry) => chatNativeSessionIds(entry).some((id) => surfaces.isOpen(id)),
  };
  const beats: Promise<void>[] = [];
  const beatA = () =>
    void beats.push(
      registryA.beat({
        openSessionIds: storages[0].getChats().flatMap((entry) => chatNativeSessionIds(entry).filter((id) => surfaces.isOpen(id))),
        front: chatVisibility.publishedFrontSessionId(sourcesA, unboundA),
        focused: vscode.window.state.focused,
      })
    );
  const flowA = popupFlow(storages[0], {
    ledgerDir,
    live,
    states: () => states,
    isVisible: (chatId) => chatVisibility.isChatVisible(sourcesA, chatId),
    unboundFront: (entry) => chatVisibility.unboundTabMayBeChat(entry, unboundA),
    publishFront: beatA,
  });
  // Window b: nothing in front; it reads the registry.
  const flowB = popupFlow(storages[1], { ledgerDir, live, states: () => states, frontAnywhere: (id) => registryB.frontAnywhere(id) });

  const focus = { a: aFocused, b: false };
  const flows = { a: flowA, b: flowB };
  const pollIn = async (name: 'a' | 'b', prime = false) => {
    windowState().state = { focused: focus[name] };
    await flows[name].service.poll(prime);
  };
  await registryB.refresh();
  await pollIn('a', true);
  beatA(); // the tab change
  await pollIn('b', true);
  await Promise.all(beats);

  /**
   * One turn: under way in both windows, then over. `first` judges its end
   * first; `bReadA` says whether window b's registry has read window a's
   * beats by then (its folder watcher fired), or still holds an older read.
   */
  const turn = async (first: 'a' | 'b', bReadA: boolean) => {
    states[sessionId] = busy(Date.now());
    await pollIn('a');
    await pollIn('b');
    await Promise.all(beats);
    if (bReadA) {
      await registryB.refresh();
    }
    const stamp = Date.now() + 1;
    states[sessionId] = idleAfter(stamp);
    while (Date.now() <= stamp) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (const name of first === 'a' ? (['a', 'b'] as const) : (['b', 'a'] as const)) {
      await pollIn(name);
      await pollIn(name);
    }
    await Promise.all(beats);
  };
  return {
    a: flowA,
    b: flowB,
    turn,
    focus,
    shown: () => [...flowA.shownLines(), ...flowB.shownLines()],
  };
}

for (const chat of ['new', 'existing'] as const) {
  test(`the ${chat} chat in front of focused window a, judged there first: 0 pop-ups, window b loses the lock (RC N2/N3)`, async (t) => {
    const w = await twoWindowsOneInFront(t, chat);
    await w.turn('a', false);
    assert.deepEqual(w.shown(), [], 'no window pops a chat in front of the focused window');
    assert.equal(w.a.skipped('front').length, 1, 'window a judges it in front');
    assert.equal(w.b.skipped('locked').length, 1, "window a's front judgement holds the lock");
  });

  test(`the ${chat} chat in front of focused window a, judged in window b first: 0 pop-ups, b reads a's front`, async (t) => {
    const w = await twoWindowsOneInFront(t, chat);
    await w.turn('b', true);
    assert.deepEqual(w.shown(), [], 'no window pops a chat in front of the focused window');
    assert.equal(w.b.skipped('front').length, 1, "window b reads window a's front from the registry");
    assert.equal(w.a.skipped('front').length, 1);
  });

  test(`the ${chat} chat in front of window a while another app is in front pops exactly once`, async (t) => {
    for (const first of ['a', 'b'] as const) {
      const w = await twoWindowsOneInFront(t, chat, false);
      await w.turn(first, true);
      assert.equal(w.shown().length, 1, `one pop-up (${first} first)`);
      assert.deepEqual([...w.a.skipped('front'), ...w.b.skipped('front')], [], 'a window that is not focused silences nothing');
    }
  });

  test(`a ${chat} chat's turn held back in front still lets its next turn pop, once`, async (t) => {
    const w = await twoWindowsOneInFront(t, chat);
    await w.turn('a', false);
    assert.deepEqual(w.shown(), []);
    w.focus.a = false; // the user moves to another app
    await w.turn('b', true);
    assert.equal(w.shown().length, 1, 'the next turn pops once');
  });
}

test('asks about a session that stays unimportable are bounded: at most 6 a minute however often it polls, then none until its next turn', async (t) => {
  const T0 = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: T0 });
  windowState().state = { focused: true };
  const storage = makeStorage();
  const live = new Set(['s-stuck']);
  const underWay = new Set(['s-stuck']);
  const flow = popupFlow(storage, {
    live: () => live,
    underWay: () => underWay,
    states: () => ({ 's-stuck': busy(T0) }),
    onUnlisted: (sessionIds) => sessionIds, // never importable
  });
  await flow.service.poll(true);
  // A minute of polls every 500 ms (a sessions folder that never stops changing).
  for (let at = 0; at < 60_000; at += 500) {
    await flow.service.poll();
    await settleTimers(t, 500);
  }
  const asked = flow.unlisted.length;
  assert.ok(asked >= 3 && asked <= 6, `asked ${asked} times in a minute (between 3 and 6)`);
  for (let at = 0; at < 120_000; at += 4_000) {
    await flow.service.poll();
    await settleTimers(t, 4_000);
  }
  assert.equal(flow.unlisted.length, asked, 'spent until its next turn starts');

  underWay.delete('s-stuck');
  await flow.service.poll();
  underWay.add('s-stuck');
  await flow.service.poll();
  assert.equal(flow.unlisted.length, asked + 1, 'a new turn asks again at once');
  flow.service.dispose();
});

test('a new turn that starts while an ask is in flight starts the tries over once the answer comes (QA on #73)', async (t) => {
  const T0 = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: T0 });
  windowState().state = { focused: true };
  const storage = makeStorage();
  const live = new Set(['s-x']);
  const underWay = new Set(['s-x']);
  let answer: (retry: readonly string[]) => void = () => undefined;
  const flow = popupFlow(storage, {
    live: () => live,
    underWay: () => underWay,
    states: () => ({ 's-x': busy(T0) }),
    onUnlisted: () => new Promise<readonly string[]>((resolve) => (answer = resolve)),
  });
  await flow.service.poll(true);
  await flow.service.poll();
  assert.equal(flow.unlisted.length, 1, 'asked; the answer is slow');
  // Its turn ends and the next one starts while the answer is still out.
  underWay.delete('s-x');
  await flow.service.poll();
  underWay.add('s-x');
  await flow.service.poll();
  assert.equal(flow.unlisted.length, 1, 'one ask at a time');
  answer(['s-x']);
  for (let i = 0; i < 20; i++) await flush();
  assert.equal(flow.unlisted.length, 2, 'the new turn asks at once when the answer arrives, without waiting out a backoff');
  flow.service.dispose();
});

test('dispose stops the retry timers: no ask and no poll after it', async (t) => {
  const T0 = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: T0 });
  windowState().state = { focused: true };
  const storage = makeStorage();
  let liveReads = 0;
  const flow = popupFlow(storage, {
    live: () => {
      liveReads++;
      return new Set(['s-stuck']);
    },
    underWay: () => new Set(['s-stuck']),
    states: () => ({ 's-stuck': busy(T0) }),
    onUnlisted: (sessionIds) => sessionIds,
  });
  await flow.service.poll(true);
  await flow.service.poll();
  for (let i = 0; i < 20; i++) await flush();
  assert.equal(flow.unlisted.length, 1);
  flow.service.dispose();
  const reads = liveReads;
  await settleTimers(t, 120_000);
  assert.equal(flow.unlisted.length, 1, 'no ask after dispose');
  assert.equal(liveReads, reads, 'and no poll');
});

test('a chat first seen after activation at needs pops once across windows (not pre-existing)', async (t) => {
  windowState().state = { focused: false };
  const ledgerDir = path.join(tempDir(t), 'pitwall-popups');
  // A placeholder the user opened an hour ago in the panel: its chat is older than both windows.
  const openedAt = Date.now() - 60 * 60_000;
  const windows = [makeStorage(), makeStorage()].map((storage) => {
    let live: HarnessLiveState | undefined;
    const flow = popupFlow(storage, { ledgerDir, live: () => new Set(live ? ['s-new'] : []), states: (): Record<string, HarnessLiveState> => (live ? { 's-new': live } : {}) });
    return { storage, flow, set: (state: HarnessLiveState) => (live = state) };
  });
  for (const window of windows) {
    await window.flow.service.poll(true);
  }

  // Its first prompt asks for permission before any window has it listed.
  const stamp = Date.now() + 1;
  for (const window of windows) {
    window.storage.createChat('wt-a', 'claude', 'New panel chat', { id: 'chat-a', harnessSessionId: 's-new', createdAt: openedAt, lastAccessedAt: openedAt });
    window.set(waitingAt(stamp));
  }
  for (const window of windows) {
    await window.flow.service.poll();
    await window.flow.service.poll();
  }

  const shown = windows.flatMap((window) => window.flow.shownLines());
  assert.equal(shown.length, 1, 'its first wait pops exactly once across the windows');
  assert.deepEqual(windows.flatMap((window) => window.flow.skipped('pre-existing')), [], 'a wait that began after activation is not pre-existing');
  assert.equal(windows.flatMap((window) => window.flow.skipped('locked')).length, 1, 'the other window loses the lock');
  for (const window of windows) {
    assert.equal(window.flow.service.statusOf('chat-a').status, 'needs');
  }
});

test("Pitwall's own open or close of a chat makes no transition", async () => {
  windowState().state = { focused: true };
  const storage = makeStorage();
  const chat = storage.createChat('wt-1', 'claude', 'At rest', { harnessSessionId: 's-1' });
  const listedAt = storage.getChat(chat.id)!.seenAt!;
  let running = false;
  const flow = popupFlow(storage, {
    live: () => new Set(running ? ['s-1'] : []),
    // Opening starts an idle process (the panel); the transcript's last turn ended before the chat was listed.
    states: () => ({ 's-1': running ? idleAfter(listedAt - 60_000) : { turnState: 'done', turnEndedAt: listedAt - 60_000, running: false } }),
  });
  await flow.service.poll(true);
  assert.equal(flow.service.statusOf(chat.id).status, 'idle');

  running = true; // Pitwall opens it in the panel
  flow.open.add(chat.id);
  flow.visible.add(chat.id);
  flow.service.markSeen(chat.id);
  await flow.service.poll();
  flow.visible.delete(chat.id);
  flow.open.delete(chat.id); // and closes the tab
  await flow.service.poll();
  running = false; // the process exits
  await flow.service.poll();
  await flow.service.poll();
  assert.deepEqual(flow.transitions, []);
  assert.deepEqual(flow.statusLines(), []);
  assert.equal(flow.service.statusOf(chat.id).status, 'idle');
});

test('compare-status passes a matching walk and fails a missing, extra or mismatched transition, a wrong dump or a slow lag', async (t) => {
  const dir = tempDir(t);
  const script = path.resolve(__dirname, '..', '..', '..', 'scripts', 'compare-status.mjs');
  const t0 = Date.parse('2026-11-19T10:00:00.000Z');
  const truth = path.join(dir, 'truth.jsonl');
  // One cycle for session aaaaaaaa: idle → working → needs → working → finished → (opened) idle.
  const samples = [
    { t: t0, sid8: 'aaaaaaaa', status: 'idle', waitingFor: null, statusUpdatedAt: t0 - 5_000 },
    { t: t0 + 1_000, sid8: 'aaaaaaaa', status: 'busy', waitingFor: null, statusUpdatedAt: t0 + 1_000 },
    { t: t0 + 2_000, sid8: 'aaaaaaaa', status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: t0 + 2_000 },
    { t: t0 + 2_500, sid8: 'aaaaaaaa', status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: t0 + 2_400 },
    { t: t0 + 3_000, sid8: 'aaaaaaaa', status: 'busy', waitingFor: null, statusUpdatedAt: t0 + 3_000 },
    { t: t0 + 4_000, sid8: 'aaaaaaaa', status: 'idle', waitingFor: null, statusUpdatedAt: t0 + 4_000 },
  ];
  fs.writeFileSync(truth, samples.map((sample) => JSON.stringify(sample)).join('\n') + '\n');
  const at = (ms: number) => new Date(t0 + ms).toISOString();
  const good = [
    `[${at(-60_000)}] [Pitwall] status aaaaaaaa idle→finished lag=9`, // before the recording: ignored
    `[${at(1_200)}] [Pitwall] status aaaaaaaa idle→working lag=200`,
    `[${at(2_150)}] [Pitwall] status aaaaaaaa working→needs lag=150`,
    `[${at(3_100)}] [Pitwall] status aaaaaaaa needs→working lag=100`,
    `[${at(4_300)}] [Pitwall] status aaaaaaaa working→finished lag=300`,
    `[${at(9_000)}] [Pitwall] route aaaaaaaa → /work/lab (same-folder)`,
    `[${at(9_010)}] [Pitwall] status aaaaaaaa finished→idle lag=0`,
  ];
  const run = (lines: string[], ...extra: string[]) => {
    const log = path.join(dir, 'ops.log');
    fs.writeFileSync(log, lines.join('\n') + '\n');
    return spawnSync(process.execPath, [script, '--truth', truth, '--log', log, ...extra], { encoding: 'utf8' });
  };

  const ok = run(good, '--max-lag', '2000');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /aaaaaaaa expected=5 logged=5 ok/);
  assert.match(ok.stdout, /compare ok; 5 transitions matched; lag p95=300 max=300/);

  const missing = run(good.filter((line) => !line.includes('needs→working')));
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /mismatch #3: expected needs→working, logged working→finished/);
  const extra = run([...good, `[${at(9_500)}] [Pitwall] status aaaaaaaa idle→working lag=1`]);
  assert.equal(extra.status, 1);
  assert.match(extra.stdout, /extra #6: idle→working/);
  const unopened = run(good.filter((line) => !line.includes('route')));
  assert.equal(unopened.status, 1, 'with no open, finished never turns idle');
  assert.match(unopened.stdout, /extra #5: finished→idle/);
  const slow = run(good, '--max-lag', '250');
  assert.equal(slow.status, 1);
  assert.match(slow.stdout, /lag #4: working→finished lag=300 > 250/);

  const dumps = path.join(dir, 'pitwall-dump');
  fs.mkdirSync(dumps);
  fs.writeFileSync(path.join(dumps, '4242.json'), JSON.stringify({ version: 1, statuses: { 'aaaaaaaa-1111-4111-8111-000000000001': 'idle' } }));
  assert.equal(run(good, '--dump', dumps).status, 0, 'the dump agrees with the final status');
  fs.writeFileSync(path.join(dumps, '4343.json'), JSON.stringify({ version: 1, statuses: { 'aaaaaaaa-1111-4111-8111-000000000001': 'finished' } }));
  const wrong = run(good, '--dump', dumps);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stdout, /dump 4343\.json: aaaaaaaa shows finished, expected idle/);
  assert.equal(run(good, '--bogus').status, 2);
});

test('compare-status --opened-from takes the opened lines from every window, so a window that did not click passes', (t) => {
  const dir = tempDir(t);
  const script = path.resolve(__dirname, '..', '..', '..', 'scripts', 'compare-status.mjs');
  const t0 = Date.parse('2026-11-19T10:00:00.000Z');
  const at = (ms: number) => new Date(t0 + ms).toISOString();
  const truth = path.join(dir, 'truth.jsonl');
  fs.writeFileSync(
    truth,
    [
      { t: t0, sid8: 'aaaaaaaa', status: 'idle', statusUpdatedAt: t0 - 5_000 },
      { t: t0 + 1_000, sid8: 'aaaaaaaa', status: 'busy', statusUpdatedAt: t0 + 1_000 },
      { t: t0 + 4_000, sid8: 'aaaaaaaa', status: 'idle', statusUpdatedAt: t0 + 4_000 },
    ]
      .map((sample) => JSON.stringify(sample))
      .join('\n') + '\n'
  );
  const write = (name: string, lines: string[]) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  };
  const statusLines = [
    `[${at(1_200)}] [Pitwall] status aaaaaaaa idle→working lag=200`,
    `[${at(4_300)}] [Pitwall] status aaaaaaaa working→finished lag=300`,
    `[${at(9_010)}] [Pitwall] status aaaaaaaa finished→idle lag=0`,
  ];
  // The user opened the chat in window a; window b only saw it turn idle.
  const windowA = write('ops-a.log', [...statusLines, `[${at(9_000)}] [Pitwall] popup click aaaaaaaa`]);
  const windowB = write('ops-b.log', statusLines);
  const windowC = write('ops-c.log', statusLines);
  const run = (...extra: string[]) => spawnSync(process.execPath, [script, '--truth', truth, ...extra], { encoding: 'utf8' });

  const alone = run('--log', windowB);
  assert.equal(alone.status, 1, 'per window, the open is missing');
  assert.match(alone.stdout, /extra #3: finished→idle/);

  const merged = run('--log', windowB, '--opened-from', windowA, windowB, windowC, '--max-lag', '2000');
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  assert.match(merged.stdout, /aaaaaaaa expected=3 logged=3 ok/);
  assert.match(merged.stdout, /compare ok; 3 transitions matched/);
  // Only --log counts status lines: the other windows' lines are never matched twice.
  assert.match(run('--opened-from', windowA, '--log', windowA).stdout, /aaaaaaaa expected=3 logged=3 ok/);
  assert.equal(run('--log', windowB, '--opened-from').status, 2, '--opened-from needs at least one log');
  assert.equal(run('--log', windowB, '--opened-from', path.join(dir, 'missing.log')).status, 2);
});

test('compare-status takes idle→needs for a first turn shorter than a tick as a note, not a FAIL', (t) => {
  const dir = tempDir(t);
  const script = path.resolve(__dirname, '..', '..', '..', 'scripts', 'compare-status.mjs');
  const t0 = Date.parse('2026-11-19T10:00:00.000Z');
  const at = (ms: number) => new Date(t0 + ms).toISOString();
  const truthFor = (waitAfterMs: number) => {
    const file = path.join(dir, `truth-${waitAfterMs}.jsonl`);
    fs.writeFileSync(
      file,
      [
        { t: t0, sid8: 'cccccccc', status: 'idle', statusUpdatedAt: t0 },
        { t: t0 + 1_000, sid8: 'cccccccc', status: 'busy', statusUpdatedAt: t0 + 1_000 },
        { t: t0 + 1_000 + waitAfterMs, sid8: 'cccccccc', status: 'waiting', statusUpdatedAt: t0 + 1_000 + waitAfterMs },
      ]
        .map((sample) => JSON.stringify(sample))
        .join('\n') + '\n'
    );
    return file;
  };
  // A brand-new chat is listed after its first turn started; the first line Pitwall can log is idle→needs.
  const log = path.join(dir, 'ops.log');
  fs.writeFileSync(log, `[${at(4_500)}] [Pitwall] status cccccccc idle→needs lag=300\n`);
  const run = (truth: string) => spawnSync(process.execPath, [script, '--truth', truth, '--log', log], { encoding: 'utf8' });

  const short = run(truthFor(3_000));
  assert.equal(short.status, 0, short.stdout + short.stderr);
  assert.match(short.stdout, /NOTE cccccccc #1: first turn shorter than a tick \(3000 ms working\), logged idle→needs for idle→working→needs/);
  assert.match(short.stdout, /cccccccc expected=1 logged=1 ok/);

  const long = run(truthFor(9_000));
  assert.equal(long.status, 1, 'a working phase longer than a tick still had to be logged');
  assert.match(long.stdout, /mismatch #1: expected idle→working, logged idle→needs/);
});

test('the state dump carries every listed session status and the counts', async (t) => {
  const dir = tempDir(t);
  const file = writeDump(
    {
      dir,
      pid: 4242,
      tabs: () => [],
      windowFolder: () => undefined,
      statuses: () => ({ 's-1': 'needs', 's-2': 'idle' }),
      counts: () => ({ needs: 1, working: 0, finished: 0 }),
    },
    []
  );
  const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(dump.statuses, { 's-1': 'needs', 's-2': 'idle' });
  assert.deepEqual(dump.counts, { needs: 1, working: 0, finished: 0 });
});

test('chatsWithStatus lists each status oldest first, ties by chat id', async () => {
  const storage = makeStorage();
  const sessions = ['n-late', 'n-early', 'n-tie', 'w-1', 'f-new', 'f-old'];
  const chats = Object.fromEntries(sessions.map((id) => [id, storage.createChat('wt-1', 'claude', id, { harnessSessionId: id })]));
  const t0 = Date.now();
  let phase = 0;
  const states = (): Record<string, HarnessLiveState> => ({
    'n-late': waitingAt(t0 + 3_000),
    'n-early': waitingAt(t0 + 1_000),
    'n-tie': waitingAt(t0 + 1_000),
    'w-1': busy(),
    'f-new': phase === 0 ? busy() : idleAfter(t0 + 20),
    'f-old': phase === 0 ? busy() : idleAfter(t0 + 10),
  });
  const flow = popupFlow(storage, { states });
  Object.values(chats).forEach((chat) => flow.open.add(chat.id));
  await flow.service.poll(true);
  phase = 1;
  await flow.service.poll();
  await flow.service.poll();

  const ids = (status: 'needs' | 'working' | 'finished') => flow.service.chatsWithStatus(status).map((entry) => entry.chatId);
  const tied = [chats['n-early'].id, chats['n-tie'].id].sort();
  assert.deepEqual(ids('needs'), [...tied, chats['n-late'].id], 'oldest wait first; the tie breaks by chat id');
  assert.deepEqual(ids('working'), [chats['w-1'].id]);
  assert.deepEqual(ids('finished'), [chats['f-old'].id, chats['f-new'].id], 'the earlier turn end first');
  assert.deepEqual(flow.service.chatsWithStatus('needs').map((entry) => entry.since), [t0 + 1_000, t0 + 1_000, t0 + 3_000]);
});
