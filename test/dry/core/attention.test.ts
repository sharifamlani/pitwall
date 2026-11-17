import { beforeEach, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  NEEDS_INPUT_COOLDOWN_MS,
  SessionAttentionService,
  shouldNotifyNeedsInput,
} from '../../../src/core/services/SessionAttentionService';
import { escapeAppleScript, NotificationService } from '../../../src/core/services/NotificationService';
import { HarnessAdapter, HarnessLiveState } from '../../../src/core/harness/types';
import { ChatSession } from '../../../src/core/types';
import * as chatVisibility from '../../../src/core/services/chatVisibility';
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
  makeStorage,
  runCommand,
  sessionRecord,
  shown,
  stub,
  worktreeRecord,
} from '../support';

beforeEach(() => stub.__reset());

/** An attention service over one chat whose adapter the test drives. */
function attention(chat: ChatSession, adapter: HarnessAdapter, options: { terminalOpen?: boolean; isChatOpen?: (chat: ChatSession) => boolean; isChatVisible?: () => boolean } = {}) {
  const notified: string[] = [];
  const service = new SessionAttentionService(
    { getChats: () => [chat], getRepository: () => ({ name: 'repo' }) } as never,
    { get: () => adapter } as never,
    { notify: (kind: string, target: { detail?: string }) => notified.push(target.detail ? `${kind}:${target.detail}` : kind) } as never,
    () => worktreeRecord(),
    () => undefined,
    options.isChatOpen ?? (() => options.terminalOpen ?? true),
    options.isChatVisible
  );
  return { service, notified };
}

const linkedChat = (overrides: Partial<ChatSession> = {}) =>
  chatRecord({ harnessSessionId: 'session-1', status: 'active', ...overrides });

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

test('a session needs you from an unseen turn end or wait until you visit it, it works again, or it closes', async () => {
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
  assert.deepEqual(service.sessionsNeedingYou(), ['chat-1']);
  service.markSeen('chat-1');
  assert.deepEqual(service.sessionsNeedingYou(), [], 'visiting clears it');

  await step({ turnState: 'working', turnEndedAt: null, waitingFor: 'permission prompt' });
  assert.deepEqual(service.sessionsNeedingYou(), ['chat-1'], 'a wait mid-turn needs you too');
  await step({ turnState: 'working', turnEndedAt: null });
  assert.deepEqual(service.sessionsNeedingYou(), [], 'answered: the agent is working again');

  visible = true;
  await step({ turnState: 'done', turnEndedAt: 2000 });
  assert.deepEqual(service.sessionsNeedingYou(), [], 'a turn that ends in front of you is already seen');

  visible = false;
  await step({ turnState: 'working', turnEndedAt: null });
  await step({ turnState: 'done', turnEndedAt: 3000 });
  open = false;
  await service.poll();
  assert.deepEqual(service.sessionsNeedingYou(), [], 'a closed session is forgotten');
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

test('a notification is suppressed while its session has focus; AppleScript text is escaped', () => {
  stub.__setConfiguration('notifications.nativeBanner', false);
  const state = (stub.window as unknown as { state: { focused: boolean } });
  const notifications = new NotificationService(() => undefined, () => true);
  const target = { chat: linkedChat(), context: 'repo · main', detail: 'permission prompt' };

  state.state = { focused: true };
  notifications.notify('needs-input', target);
  assert.equal(stub.__messages.length, 0);
  state.state = { focused: false };
  notifications.notify('needs-input', target);
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
    { getChats: () => [chat], getRepository: () => ({ name: 'repo' }) } as never,
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

const WAITING: HarnessLiveState = { turnState: 'working', turnEndedAt: null, waitingFor: 'permission prompt' };

test('a wait that began in front of you is listed once you look away', async (t) => {
  useClock(t);
  windowState().state = { focused: true };
  let visible = false;
  const { service, set } = liveAttention(() => visible);
  await service.poll(true);

  visible = true; // the user typed the request into this chat
  set(WAITING);
  await service.poll();
  assert.deepEqual(service.sessionsNeedingYou(), [], 'in front of you: not listed');

  visible = false; // the user looks at another tab
  await service.poll();
  assert.deepEqual(service.sessionsNeedingYou(), ['chat-1'], 'listed on the next tick');

  visible = true;
  await service.poll();
  assert.deepEqual(service.sessionsNeedingYou(), [], 'not listed while it is in front again');
  service.markSeen('chat-1');
  visible = false;
  await service.poll();
  assert.deepEqual(service.sessionsNeedingYou(), ['chat-1'], 'visited but unanswered: listed again');

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
    { listRepositoryWorktrees: () => ({ isGit: true, worktrees: [worktree] }), getAheadBehind: () => null } as never,
    terminals,
    registry,
    { getCachedPRInfo: () => null, fetchPRInfo: async () => null, clearCache: () => undefined } as never,
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
    workspacesProvider: { getWorktreeById: getWorktree } as never,
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
      const row = (await tree.getChildren(worktreeRow)).find((item) => item.label === chat.name)!;
      return (row.iconPath as { light: vscode.Uri }).light.path.split('/').pop();
    },
  };
}

test("replay of the tester's flow: a prompt that appears while typing in the chat's terminal is needs-you once you switch tabs", async (t) => {
  const clock = useClock(t);
  windowState().state = { focused: true };
  const flow = await needsYouFlow(t);
  flow.focusTerminal();
  showTabs(flow.terminalTab(), settingsTab());
  await flow.attentionService.poll(true);

  flow.startWaiting(); // "run git status" stops at a permission prompt
  clock.advance(12_000);
  await flow.attentionService.poll();
  assert.equal(await flow.rowMark(), 'claude-light-working.svg', 'in front of you: the row is still working');

  showTabs(settingsTab(), flow.terminalTab()); // the user clicks another editor tab
  clock.advance(4_000);
  await flow.attentionService.poll();
  assert.equal(await flow.rowMark(), 'claude-light-needs.svg', 'the row shows needs-you');
  assert.deepEqual(flow.attentionService.sessionsNeedingYou(), [flow.chatId]);

  await runCommand('pitwall.openNextSessionNeedingYou');
  assert.deepEqual(flow.activated, [flow.chatId], 'Go to Next finds it');
  assert.ok(!shown('No session is waiting for you.'));
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
  assert.ok(!shown('No session is waiting for you.'));
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
    { getChats: () => [chat], getRepository: () => ({ name: 'repo' }) } as never,
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

  const stale = flow.marks.filter((mark) => mark.at > 15_000 && (mark.needs || mark.listed));
  assert.deepEqual(stale.map((mark) => mark.at).slice(0, 3), [], 'no re-mark or listing from the stale sample');
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
