/**
 * Native-UI tab tracking. The shared tracker maps tabs to native sessions and
 * follows focus; each harness supplies a policy: Claude's webview tab carries
 * only a title, so it binds through an expectation, while a Codex panel's
 * resource names its thread exactly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { claudeUiSurfaces } from '../../../src/harnesses/claude/claudeUi';
import { codexUiSurfaces } from '../../../src/harnesses/codex/codexUi';

interface FakeTab {
  label: string;
  input: unknown;
  isActive: boolean;
}
interface FakeGroup {
  isActive: boolean;
  activeTab: FakeTab | undefined;
  tabs: FakeTab[];
}

/** Editor groups and tab events the tracker observes. */
function tabWorld() {
  const groups: FakeGroup[] = [{ isActive: true, activeTab: undefined, tabs: [] }];
  const tabListeners = new Set<(event: vscode.TabChangeEvent) => void>();
  const groupListeners = new Set<() => void>();
  const subscribe = <T>(set: Set<T>) => (listener: T) => {
    set.add(listener);
    return { dispose: () => set.delete(listener) };
  };
  const event = (opened: FakeTab[] = [], changed: FakeTab[] = [], closed: FakeTab[] = []) => {
    for (const listener of tabListeners) listener({ opened, changed, closed } as never);
  };
  const activate = (tab: FakeTab, group = groups[0]) => {
    for (const other of group.tabs) other.isActive = false;
    tab.isActive = true;
    group.activeTab = tab;
  };

  return {
    options: {
      getTabGroups: () => groups as unknown as readonly vscode.TabGroup[],
      onDidChangeTabs: subscribe(tabListeners) as never,
      onDidChangeTabGroups: subscribe(groupListeners) as never,
    },
    /** Add a tab, active by default; `announce: false` models a restored tab. */
    open(input: unknown, label = 'Tab', options: { active?: boolean; announce?: boolean; group?: FakeGroup } = {}) {
      const group = options.group ?? groups[0];
      const tab: FakeTab = { label, input, isActive: false };
      group.tabs.push(tab);
      if (options.active ?? true) activate(tab, group);
      if (options.announce ?? true) event([tab]);
      return tab;
    },
    focus(tab: FakeTab) {
      activate(tab);
      event([], groups[0].tabs);
    },
    close(tab: FakeTab) {
      groups[0].tabs = groups[0].tabs.filter((candidate) => candidate !== tab);
      groups[0].activeTab = undefined;
      event([], [], [tab]);
    },
    /** Make a new group active, or switch back to the first. */
    focusGroup(index: number) {
      while (groups.length <= index) groups.push({ isActive: false, activeTab: undefined, tabs: [] });
      groups.forEach((group, i) => (group.isActive = i === index));
      for (const listener of groupListeners) listener();
    },
    groups,
    /** Fire a tab event after a test rearranged `groups` itself. */
    emit: event,
    /** Fire a tab-group event (no tab event) after a test rearranged `groups` itself. */
    emitGroups() {
      for (const listener of groupListeners) listener();
    },
  };
}

const claudeTab = () => new vscode.TabInputWebview('mainThreadWebview-claudeVSCodePanel');
const codexTab = (threadId: string, viewType = 'chatgpt.conversationEditor') =>
  new vscode.TabInputCustom(vscode.Uri.from({ scheme: 'openai-codex', authority: 'route', path: `/local/${threadId}` }), viewType);
const fileTab = () => new vscode.TabInputText(vscode.Uri.file('/repo/file.ts'));

test('the active session follows the active tab and the active editor group', () => {
  const world = tabWorld();
  const service = codexUiSurfaces(world.options);
  let changes = 0;
  service.onDidChange(() => changes++);

  const panel = world.open(codexTab('thread-1'));
  assert.equal(service.activeSessionId(), 'thread-1');
  const file = world.open(fileTab(), 'file.ts');
  assert.equal(service.activeSessionId(), undefined, 'a file tab in the same group');
  world.focus(panel);
  assert.equal(service.activeSessionId(), 'thread-1');
  world.focusGroup(1);
  world.open(fileTab(), 'README.md', { group: world.groups[1] });
  assert.equal(service.activeSessionId(), undefined, 'another active group');
  world.focusGroup(0);
  assert.equal(service.activeSessionId(), 'thread-1');
  assert.equal(changes, 5, 'every transition is announced once');
  void file;
  service.dispose();
});

test('Codex panels map by resource, including tabs restored before activation, and close cleanly', () => {
  const world = tabWorld();
  world.open(codexTab('restored'), 'Codex', { announce: false });
  const service = codexUiSurfaces(world.options);
  assert.ok(service.isOpen('restored'), 'no expectation is needed');

  world.open(codexTab('other-editor', 'other.conversationEditor'));
  world.open(new vscode.TabInputWebview('other.webview'), 'Other UI');
  assert.ok(!service.isOpen('other-editor'), 'other custom editors are ignored');

  const panel = world.open(codexTab('thread-2'));
  assert.ok(service.isOpen('thread-2'));
  world.close(panel);
  assert.ok(!service.isOpen('thread-2'));
  service.dispose();
});

test('a Claude tab binds to the expectation whose title it carries; cancelled ones never bind', () => {
  const world = tabWorld();
  const service = claudeUiSurfaces(world.options);

  service.expect('first', 'First session');
  service.expect('second', 'Second session');
  world.open(claudeTab(), 'Second session');
  assert.equal(service.activeSessionId(), 'second', 'a title match beats the oldest expectation');

  service.cancelExpect('first');
  world.open(claudeTab(), 'First session');
  assert.ok(!service.isOpen('first'));

  service.expect('named', 'file.ts');
  world.open(fileTab(), 'file.ts');
  assert.ok(!service.isOpen('named'), 'only Claude tabs are bound');

  const [bound] = world.groups[0].tabs;
  world.close(bound);
  assert.ok(!service.isOpen('second'));
  service.dispose();
});

test('a Claude tab dragged to another group stays bound, whether VS Code reports the move as one tab event or two (D16)', () => {
  const world = tabWorld();
  const service = claudeUiSurfaces(world.options);
  world.groups.push({ isActive: false, activeTab: undefined, tabs: [] });
  const [left, right] = world.groups;
  /** The moved copy: a new Tab object in the target group. */
  const openCopy = (tab: FakeTab, to: FakeGroup): FakeTab => {
    const moved: FakeTab = { label: tab.label, input: claudeTab(), isActive: true };
    to.tabs.push(moved);
    to.activeTab = moved;
    return moved;
  };
  const remove = (tab: FakeTab, from: FakeGroup) => {
    from.tabs = from.tabs.filter((candidate) => candidate !== tab);
    from.activeTab = undefined;
  };

  service.expect('dragged', 'Dragged chat');
  const tab = world.open(claudeTab(), 'Dragged chat');
  assert.ok(service.isOpen('dragged'));

  const once = openCopy(tab, right);
  remove(tab, left);
  world.emit([once], [], [tab]);
  assert.ok(service.isOpen('dragged'), 'one event (closed + opened): still bound');

  // VS Code moves an editor across groups by opening it in the target, then
  // closing it in the source (EditorGroupView.doMoveOrCopyEditorAcrossGroups),
  // so two events arrive open first. A close before the open does not happen.
  const twice = openCopy(once, left);
  world.emit([twice]);
  remove(once, right);
  world.emit([], [], [once]);
  assert.ok(service.isOpen('dragged'), 'two events, open then close: still bound');

  left.tabs = [];
  left.activeTab = undefined;
  world.emit([], [], [twice]);
  assert.ok(!service.isOpen('dragged'), 'a real close releases it');
  service.dispose();
});

test('settle binds the active Claude tab a command just opened, but a tab already there or a background link needs a matching title', () => {
  const world = tabWorld();
  const service = claudeUiSurfaces(world.options);

  // A tab that was there before the open is never "the only expected chat"
  // (live I1b): the panel's own tab may not have opened yet.
  world.open(claudeTab(), 'Already open', { announce: false });
  service.expect('command', 'A different name');
  service.settle('command');
  assert.equal(service.activeSessionId(), undefined, 'the old active tab stays unknown');
  // The tab the command opened, titled differently from the row, is the one.
  world.open(claudeTab(), 'Its own title');
  service.settle('command');
  assert.equal(service.activeSessionId(), 'command');

  // The importer links in the background: the active tab may be another
  // conversation, so only a matching (or truncated) title binds.
  world.open(claudeTab(), 'Another conversation', { announce: false });
  service.expect('background', 'Linked session');
  service.settle('background', { allowActiveFallback: false });
  assert.ok(!service.isOpen('background'));

  world.open(claudeTab(), 'Truncated title…', { announce: false });
  service.expect('truncated', 'Truncated title and more');
  service.settle('truncated', { allowActiveFallback: false });
  assert.equal(service.activeSessionId(), 'truncated');
  service.dispose();
});

// ---- Phase 4 Task 4: serial open, reliable binding (rows 4.3, 4.4, 4.9) ----

/** A timer the test fires by hand, and the delays it was asked for. */
function manualTimers() {
  const pending: { fn: () => void; ms: number; live: boolean }[] = [];
  return {
    schedule: (fn: () => void, ms: number) => {
      const entry = { fn, ms, live: true };
      pending.push(entry);
      return { dispose: () => void (entry.live = false) };
    },
    delays: () => pending.filter((entry) => entry.live).map((entry) => entry.ms),
    fire: () => {
      const next = pending.find((entry) => entry.live);
      if (next) {
        next.live = false;
        next.fn();
      }
    },
  };
}

/** A cancellation token the test cancels by hand. */
function manualToken() {
  const listeners = new Set<() => void>();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return {
    token,
    cancel() {
      token.isCancellationRequested = true;
      listeners.forEach((listener) => listener());
    },
  };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Wait (without a real timer) until `condition` holds. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !condition(); i++) {
    await nextTurn();
  }
}

function serialWorld() {
  const world = tabWorld();
  const timers = manualTimers();
  const logs: string[] = [];
  const clock = { now: 0 };
  const service = claudeUiSurfaces({ ...world.options, schedule: timers.schedule, now: () => clock.now, log: (line: string) => void logs.push(line) } as never);
  /** Which session each tab is bound to, per group. */
  const bound = () => service.describeTabs().map((group) => group.tabs.map((tab) => tab.sessionId));
  return { world, timers, logs, service, bound, clock };
}

test('serial opens bind each new tab to the session just requested', async () => {
  const { world, service, logs } = serialWorld();
  const tabs = new Map<string, FakeTab>();
  const result = await service.openSerially(['aaaa1111', 'bbbb2222', 'cccc3333'], async (id) => {
    tabs.set(id, world.open(claudeTab(), `Chat ${id}`));
  });
  for (const id of ['aaaa1111', 'bbbb2222', 'cccc3333']) {
    assert.ok(service.isOpen(id), `${id} is bound`);
    assert.equal(result.get(id), tabs.get(id) as never, `${id} maps to its own tab`);
  }
  assert.deepEqual(
    logs,
    ['aaaa1111', 'bbbb2222', 'cccc3333'].map((id) => `[Pitwall] tab bound ${id.slice(0, 8)} "Chat ${id}"`)
  );
  service.dispose();
});

test('two new chats both titled "Claude Code" bind to the right sessions', async () => {
  const { world, service, bound } = serialWorld();
  const tabs: FakeTab[] = [];
  const result = await service.openSerially(['aaaa', 'bbbb'], async () => void tabs.push(world.open(claudeTab(), 'Claude Code')));
  assert.equal(result.get('aaaa'), tabs[0] as never);
  assert.equal(result.get('bbbb'), tabs[1] as never);
  assert.deepEqual(bound(), [['aaaa', 'bbbb']]);
  service.dispose();
});

test('a Claude tab the user opened stays unknown', async () => {
  const { world, service, bound } = serialWorld();
  world.open(claudeTab(), 'Claude Code');
  assert.deepEqual(bound(), [[undefined]], 'nothing was waiting for it');
  let mine: FakeTab | undefined;
  const result = await service.openSerially(['mine'], async () => void (mine = world.open(claudeTab(), 'Claude Code')));
  assert.equal(result.get('mine'), mine as never);
  assert.deepEqual(bound(), [[undefined, 'mine']], 'only the tab opened for the request binds');
  world.open(claudeTab(), 'Claude Code');
  assert.deepEqual(bound(), [[undefined, 'mine', undefined]], 'a tab opened after the request is unknown again');
  service.dispose();
});

test('an already-bound session is revealed, not reopened', async () => {
  const { world, service, timers } = serialWorld();
  let opened = 0;
  await service.openSerially(['a'], async () => void (opened++, world.open(claudeTab(), 'Claude Code')));
  const revealed: string[] = [];
  const result = await service.openSerially(['a'], async (id) => {
    revealed.push(`${id} open=${service.isOpen(id)}`);
  });
  assert.deepEqual(revealed, ['a open=true'], 'the open callback is told it is open, so it reveals');
  assert.equal(opened, 1);
  assert.equal(world.groups[0].tabs.length, 1, 'no second tab');
  assert.equal(result.get('a'), world.groups[0].tabs[0] as never);
  assert.deepEqual(timers.delays(), [], 'a reveal waits for no new tab');
  service.dispose();
});

test('a 5 s timeout leaves the session unbound and continues', async () => {
  const { world, service, timers } = serialWorld();
  const asked: string[] = [];
  const promise = service.openSerially(['slow', 'next'], async (id) => {
    asked.push(id);
  });
  await until(() => timers.delays().length > 0);
  assert.deepEqual(timers.delays(), [5000], 'waits at most 5 s for the tab');
  assert.deepEqual(asked, ['slow'], 'the next open waits for this one');
  timers.fire();
  await until(() => asked.length === 2);
  assert.deepEqual(asked, ['slow', 'next'], 'the next open goes ahead');
  // The one tab that arrives belongs to the oldest open still waiting (QA #52 C2), not to the next one.
  world.open(claudeTab(), 'Claude Code');
  await until(() => timers.delays().length > 0);
  timers.fire();
  await promise;
  assert.ok(service.isOpen('slow'));
  assert.ok(!service.isOpen('next'));
  service.dispose();
});

test('cancel stops before the next open', async () => {
  const { world, service } = serialWorld();
  const control = manualToken();
  const asked: string[] = [];
  const result = await service.openSerially(
    ['one', 'two', 'three'],
    async (id) => {
      asked.push(id);
      world.open(claudeTab(), `Chat ${id}`);
      control.cancel();
    },
    control.token as never
  );
  assert.deepEqual(asked, ['one']);
  assert.deepEqual([...result.keys()], ['one']);
  assert.ok(service.isOpen('one') && !service.isOpen('two'));
  service.dispose();
});

test("serial bind replaces T2's interim title re-match: two \"Claude Code\" tabs survive a group rebuild without swapping bindings", async () => {
  const { world, service, bound } = serialWorld();
  await service.openSerially(['aaaa', 'bbbb'], async () => void world.open(claudeTab(), 'Claude Code'));
  // VS Code replaces every Tab object when it rebuilds its model (a group
  // added or removed) and fires a group event only.
  const rebuilt = world.groups[0].tabs.map((tab) => ({ ...tab }));
  world.groups[0].tabs = rebuilt;
  world.groups[0].activeTab = rebuilt[1];
  world.focusGroup(0);
  assert.deepEqual(bound(), [['aaaa', 'bbbb']], 'order, not the shared title, keeps each binding');
  assert.ok(service.isOpen('aaaa') && service.isOpen('bbbb'));
  // A later close names the rebuilt object and releases the right session.
  world.close(rebuilt[0]);
  assert.ok(!service.isOpen('aaaa') && service.isOpen('bbbb'));
  service.dispose();
});

test('a moved tab keeps its own session when another tab shares its title', async () => {
  const { world, service, bound } = serialWorld();
  await service.openSerially(['aaaa', 'bbbb'], async () => void world.open(claudeTab(), 'Claude Code'));
  world.groups.push({ isActive: false, activeTab: undefined, tabs: [] });
  const [left, right] = world.groups;
  const original = left.tabs[1];
  // Drag the second tab: opened in the target group first, then closed in the source.
  const copy: FakeTab = { label: original.label, input: claudeTab(), isActive: true };
  right.tabs.push(copy);
  right.activeTab = copy;
  world.emit([copy]);
  left.tabs = left.tabs.filter((tab) => tab !== original);
  world.emit([], [], [original]);
  assert.deepEqual(bound(), [['aaaa'], ['bbbb']]);
  service.dispose();
});

// ---- Round 1 (QA #52): C2, C3, C4 ----

test('a late tab for a timed-out open does not take the next session', async () => {
  const { world, service, timers, bound } = serialWorld();
  const promise = service.openSerially(['slow', 'next'], async (id) => {
    service.expect(id, 'Claude Code');
    if (id === 'next') {
      world.open(claudeTab(), 'Claude Code');
      world.open(claudeTab(), 'Claude Code');
    }
  });
  await until(() => timers.delays().length > 0);
  timers.fire();
  await promise;
  assert.deepEqual(bound(), [['slow', 'next']], 'the first tab to arrive is the oldest outstanding open');
  service.dispose();
});

test('an open that resolves false schedules no 5 s wait', async () => {
  const { service, timers } = serialWorld();
  const result = await service.openSerially(['terminal'], async () => false);
  assert.deepEqual(timers.delays(), []);
  assert.equal(result.get('terminal'), undefined);
  service.dispose();
});

test('a group event where the number of Claude tabs changed releases a vanished binding instead of shifting it', async () => {
  const { world, service, bound } = serialWorld();
  await service.openSerially(['aaaa', 'bbbb'], async () => void world.open(claudeTab(), 'Claude Code'));
  const second = world.groups[0].tabs[1];
  world.groups[0].tabs = [{ ...second }];
  world.groups[0].activeTab = world.groups[0].tabs[0];
  world.focusGroup(0);
  assert.deepEqual(bound(), [[undefined]], 'neither binding lands on the tab now in its old place');
  service.dispose();
});

test('a user tab opened long before is not taken for a moved copy on close', async () => {
  const { world, service, bound, clock } = serialWorld();
  world.open(claudeTab(), 'Claude Code');
  clock.now = 10_000;
  let mine: FakeTab | undefined;
  await service.openSerially(['a'], async () => void (mine = world.open(claudeTab(), 'Claude Code')));
  clock.now = 20_000;
  world.close(mine!);
  assert.deepEqual(bound(), [[undefined]]);
  service.dispose();
});

// ---- Round 1 (tester T2): the real orders of a group move ----

test('a moved tab keeps its binding when the copy opens with another title, before the close', async () => {
  const { world, service, bound } = serialWorld();
  await service.openSerially(['aaaa'], async () => void world.open(claudeTab(), 'My chat name'));
  world.groups.push({ isActive: false, activeTab: undefined, tabs: [] });
  const [left, right] = world.groups;
  const original = left.tabs[0];
  // The moved webview comes up with its default title until it sets its own.
  const copy: FakeTab = { label: 'Claude Code', input: claudeTab(), isActive: true };
  right.tabs.push(copy);
  right.activeTab = copy;
  world.emit([copy]);
  left.tabs = [];
  world.emit([], [], [original]);
  assert.deepEqual(bound(), [[], ['aaaa']]);
  service.dispose();
});

test('a moved tab keeps its binding when the close arrives before the open', async () => {
  const { world, service, bound } = serialWorld();
  await service.openSerially(['aaaa'], async () => void world.open(claudeTab(), 'My chat name'));
  world.groups.push({ isActive: false, activeTab: undefined, tabs: [] });
  const [left, right] = world.groups;
  const original = left.tabs[0];
  left.tabs = [];
  world.emit([], [], [original]);
  const copy: FakeTab = { label: 'My chat name', input: claudeTab(), isActive: true };
  right.tabs.push(copy);
  right.activeTab = copy;
  world.emit([copy]);
  assert.deepEqual(bound(), [[], ['aaaa']]);
  service.dispose();
});

test('a tab opened long after a close does not inherit the closed tab\'s binding', async () => {
  const { world, service, bound, clock } = serialWorld();
  await service.openSerially(['aaaa'], async () => void world.open(claudeTab(), 'Chat'));
  world.close(world.groups[0].tabs[0]);
  clock.now = 10_000;
  world.open(claudeTab(), 'Chat');
  assert.deepEqual(bound(), [[undefined]]);
  service.dispose();
});

test('side by side: every moved tab keeps its own session, and panes = min(n, 4) when some moved earlier', async () => {
  const { world, service, bound } = serialWorld();
  const ids = ['s1', 's2', 's3', 's4', 's5'];
  await service.openSerially(ids, async (id) => void world.open(claudeTab(), `Chat ${id}`));
  const { splitSideBySide } = await import('../../../src/core/windows/sideBySide');
  /** Where a bound session's tab is now. */
  const find = (id: string) => {
    for (const group of world.groups) {
      const tab = group.tabs.find((candidate) => service.describeTabs().flatMap((g) => g.tabs).some((d) => d.label === candidate.label && d.sessionId === id));
      if (tab) return { group, tab };
    }
    throw new Error(`no tab for ${id}`);
  };
  const move = (command: string) => {
    if (!command.startsWith('workbench.action.moveEditorTo')) return; // evenEditorWidths moves nothing
    const from = world.groups.find((group) => group.isActive)!;
    const tab = from.activeTab!;
    let to: FakeGroup;
    if (command.endsWith('LastGroup')) {
      to = world.groups[world.groups.length - 1];
    } else {
      to = { isActive: false, activeTab: undefined, tabs: [] };
      world.groups.splice(world.groups.indexOf(from) + 1, 0, to);
    }
    if (to === from) return;
    // The workbench opens the copy (a webview with its default title) in the target, then closes the original.
    const copy: FakeTab = { label: 'Claude Code', input: claudeTab(), isActive: true };
    to.tabs.push(copy);
    to.activeTab = copy;
    world.groups.forEach((group) => (group.isActive = group === to));
    world.emit([copy]);
    from.tabs = from.tabs.filter((candidate) => candidate !== tab);
    from.activeTab = from.tabs[0];
    world.emit([], [], [tab]);
  };
  const run = async () =>
    splitSideBySide(ids, {
      reveal: async (id) => {
        const { group, tab } = find(id);
        world.groups.forEach((g) => (g.isActive = g === group));
        group.activeTab = tab;
      },
      exec: async (command) => void move(command),
    });
  // Move the second tab on its own first, as a user's earlier drag would have.
  world.groups[0].activeTab = world.groups[0].tabs[1];
  move('workbench.action.moveEditorToRightGroup');
  assert.equal(world.groups.length, 2);
  const result = await run();
  assert.deepEqual(result, { panes: 4, stacked: 1 });
  const nonEmpty = world.groups.filter((group) => group.tabs.length > 0);
  assert.equal(nonEmpty.length, 4, 'four panes');
  assert.deepEqual(
    ids.map((id) => service.isOpen(id)),
    [true, true, true, true, true],
    'every session still bound'
  );
  assert.equal(bound().flat().filter((id) => id !== undefined).length, 5);
  service.dispose();
});

// ---- Round 2 (live F1): Cursor re-sends its whole tab model in the middle of a move ----

/**
 * Cursor's workbench as the extension host sees it, read from Cursor 3.14.27's
 * own MainThreadEditorTabs and ExtHostEditorTabs. A group added or removed,
 * and every change of a group's active editor (an EDITORS_SELECTION change,
 * which VS Code ignores and Cursor does not), make the workbench re-send the
 * whole tab model: the extension host replaces every Tab object and fires a
 * tab-group event only. A move to another group opens the copy in the target
 * (a tab event), makes it active there (re-send), closes the original in the
 * source (a tab event), makes the next tab active there (re-send), focuses
 * the target group (a group event that keeps the Tab objects), and removes
 * the source group if the move emptied it (re-send).
 */
type MoveOrder = 'cursor' | 'close-first' | 'one-event' | 'no-resend';
function cursorWorkbench(world: ReturnType<typeof tabWorld>) {
  const resend = () => {
    for (const group of world.groups) {
      const activeAt = group.activeTab ? group.tabs.indexOf(group.activeTab) : -1;
      group.tabs = group.tabs.map((tab) => ({ ...tab }));
      group.activeTab = activeAt >= 0 ? group.tabs[activeAt] : undefined;
    }
    world.emitGroups();
  };
  const setActive = (group: FakeGroup, tab: FakeTab | undefined) => {
    for (const other of group.tabs) other.isActive = other === tab;
    group.activeTab = tab;
  };
  /** Move the tab at `fromGroup`/`fromIndex` into group `to`, or into a new group made right or left of the source. */
  const move = (fromGroup: number, fromIndex: number, to: number | 'new-after' | 'new-before', order: MoveOrder = 'cursor'): void => {
    const again = () => (order === 'no-resend' ? world.emitGroups() : resend());
    const from = world.groups[fromGroup];
    let target: FakeGroup;
    if (typeof to === 'number') {
      target = world.groups[to];
    } else {
      target = { isActive: false, activeTab: undefined, tabs: [] };
      world.groups.splice(to === 'new-after' ? fromGroup + 1 : fromGroup, 0, target);
      again();
    }
    const copy: FakeTab = { label: from.tabs[fromIndex].label, input: claudeTab(), isActive: false };
    const openCopy = () => {
      target.tabs.push(copy);
      world.emit([copy]);
      setActive(target, copy);
      world.emit([], [copy]);
      again();
    };
    const closeOriginal = () => {
      const [original] = from.tabs.splice(fromIndex, 1);
      world.emit([], [], [original]);
      const next = from.tabs[Math.min(fromIndex, from.tabs.length - 1)];
      setActive(from, next);
      if (next) world.emit([], [next]);
      again();
    };
    if (order === 'one-event') {
      target.tabs.push(copy);
      const [original] = from.tabs.splice(fromIndex, 1);
      setActive(target, copy);
      setActive(from, from.tabs[0]);
      world.emit([copy], [], [original]);
      again();
    } else if (order === 'close-first') {
      closeOriginal();
      openCopy();
    } else {
      openCopy();
      closeOriginal();
    }
    world.groups.forEach((group) => (group.isActive = group === target));
    world.emitGroups();
    if (from.tabs.length === 0) {
      world.groups.splice(world.groups.indexOf(from), 1);
      again();
    }
  };
  /** Bring a tab to the front of its group and focus the group (a re-send in Cursor). */
  const reveal = (groupIndex: number, tabIndex: number) => {
    const group = world.groups[groupIndex];
    world.groups.forEach((candidate) => (candidate.isActive = candidate === group));
    setActive(group, group.tabs[tabIndex]);
    world.emit([], [group.tabs[tabIndex]]);
    resend();
  };
  return { move, resend, reveal };
}

/** Where each bound session's tab is: group index and index in the group. */
function placesOf(service: ReturnType<typeof claudeUiSurfaces>): Map<string, [number, number]> {
  const places = new Map<string, [number, number]>();
  service.describeTabs().forEach((group, g) =>
    group.tabs.forEach((tab, i) => {
      if (tab.sessionId) places.set(tab.sessionId, [g, i]);
    })
  );
  return places;
}
const groupOf = (service: ReturnType<typeof claudeUiSurfaces>) =>
  Object.fromEntries([...placesOf(service)].map(([id, [g]]) => [id, g] as const).sort());

test('a move into a new group keeps its binding when Cursor re-sends the tab model between the open and the close', async () => {
  const { world, service, bound } = serialWorld();
  const cursor = cursorWorkbench(world);
  await service.openSerially(['aaaa', 'bbbb', 'cccc'], async (id) => void world.open(claudeTab(), `Chat ${id}`));
  cursor.move(0, 1, 'new-after');
  assert.deepEqual(bound(), [['aaaa', 'cccc'], ['bbbb']]);
  service.dispose();
});

test('a group move keeps every binding in every event order VS Code and Cursor emit', async () => {
  type Cursor = ReturnType<typeof cursorWorkbench>;
  type Service = ReturnType<typeof claudeUiSurfaces>;
  const at = (service: Service, id: string) => placesOf(service).get(id)!;
  const scenarios: { name: string; setup?: (c: Cursor, s: Service) => void; run: (c: Cursor, s: Service, o: MoveOrder) => void; expect: Record<string, number> }[] = [
    { name: 'Move Editor into Next Group (makes a group)', run: (c, s, o) => c.move(...at(s, 'bbbb'), 'new-after', o), expect: { aaaa: 0, bbbb: 1, cccc: 0 } },
    { name: 'drag to the left edge (makes a group before)', run: (c, s, o) => c.move(...at(s, 'cccc'), 'new-before', o), expect: { aaaa: 1, bbbb: 1, cccc: 0 } },
    {
      name: 'Move Editor into Next Group (existing group)',
      setup: (c, s) => c.move(...at(s, 'cccc'), 'new-after'),
      run: (c, s, o) => c.move(...at(s, 'aaaa'), 1, o),
      expect: { aaaa: 1, bbbb: 0, cccc: 1 },
    },
    {
      name: 'Move Editor into Previous Group (empties and closes the group)',
      setup: (c, s) => c.move(...at(s, 'cccc'), 'new-after'),
      run: (c, s, o) => c.move(...at(s, 'cccc'), 0, o),
      expect: { aaaa: 0, bbbb: 0, cccc: 0 },
    },
    {
      name: 'Move Editor into Previous Group (leaves a tab behind)',
      setup: (c, s) => {
        c.move(...at(s, 'bbbb'), 'new-after');
        c.move(...at(s, 'cccc'), 1);
      },
      run: (c, s, o) => c.move(...at(s, 'bbbb'), 0, o),
      expect: { aaaa: 0, bbbb: 0, cccc: 1 },
    },
  ];
  const failures: string[] = [];
  for (const titles of ['own', 'shared'] as const) {
    for (const scenario of scenarios) {
      for (const order of ['cursor', 'close-first', 'one-event', 'no-resend'] as const) {
        const { world, service } = serialWorld();
        const cursor = cursorWorkbench(world);
        world.open(fileTab(), 'file.ts');
        await service.openSerially(['aaaa', 'bbbb', 'cccc'], async (id) => void world.open(claudeTab(), titles === 'own' ? `Chat ${id}` : 'Claude Code'));
        try {
          scenario.setup?.(cursor, service);
          scenario.run(cursor, service, order);
          assert.deepEqual(groupOf(service), scenario.expect);
        } catch {
          failures.push(`${scenario.name} / ${order} / ${titles} titles: ${JSON.stringify(groupOf(service))}`);
        }
        service.dispose();
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('a re-sent model that lost a tab keeps the bindings it can still place', async () => {
  const { world, service } = serialWorld();
  const cursor = cursorWorkbench(world);
  await service.openSerially(['aaaa', 'bbbb', 'cccc', 'dddd'], async (id) => void world.open(claudeTab(), `Chat ${id}`));
  cursor.move(0, 3, 'new-after');
  // A tab gone from a re-sent model with no close event (the workbench re-sends instead of reporting it).
  world.groups[1].tabs = [];
  world.groups[1].activeTab = undefined;
  cursor.resend();
  assert.deepEqual(groupOf(service), { aaaa: 0, bbbb: 0, cccc: 0 }, 'a group whose tabs are unchanged keeps them by place');
  world.groups[0].tabs.splice(1, 1);
  cursor.resend();
  assert.deepEqual(groupOf(service), { aaaa: 0, cccc: 0 }, 'in a group that lost one, the others keep theirs by their own title');
  service.dispose();
});

test('side by side with 6 bound tabs in Cursor: all 6 still bound, 4 panes', async () => {
  const { world, service } = serialWorld();
  const cursor = cursorWorkbench(world);
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6'];
  await service.openSerially(ids, async (id) => void world.open(claudeTab(), `Chat ${id}`));
  const { splitSideBySide } = await import('../../../src/core/windows/sideBySide');
  const result = await splitSideBySide(ids, {
    reveal: async (id) => cursor.reveal(...placesOf(service).get(id)!),
    exec: async (command) => {
      const from = world.groups.findIndex((group) => group.isActive);
      const fromIndex = world.groups[from].tabs.indexOf(world.groups[from].activeTab!);
      if (command === 'workbench.action.moveEditorToLastGroup') {
        if (from !== world.groups.length - 1) cursor.move(from, fromIndex, world.groups.length - 1);
      } else if (command === 'workbench.action.moveEditorToRightGroup') {
        cursor.move(from, fromIndex, from === world.groups.length - 1 ? 'new-after' : from + 1);
      }
    },
  });
  assert.deepEqual(result, { panes: 4, stacked: 2 });
  assert.equal(world.groups.filter((group) => group.tabs.length > 0).length, 4, 'four panes');
  assert.deepEqual(ids.filter((id) => !service.isOpen(id)), [], 'every session still bound');
  service.dispose();
});

test('the tab trace logs raw tab and group events, whether a group event replaced the Tab objects, and each bind decision', async () => {
  const { world, service, logs } = serialWorld();
  const cursor = cursorWorkbench(world);
  await service.openSerially(['aaaa', 'bbbb'], async (id) => void world.open(claudeTab(), `Chat ${id}`));
  cursor.resend();
  assert.deepEqual(logs.filter((line) => line.includes('trace')), [], 'off by default');
  assert.equal(service.toggleTrace(), true);
  logs.length = 0;
  cursor.move(0, 1, 'new-after');
  const trace = logs.filter((line) => line.startsWith('[Pitwall] trace '));
  assert.ok(trace.some((line) => /^\[Pitwall\] trace groups .*replaced=2\/2/.test(line)), 'a re-send says every Tab object was replaced');
  assert.ok(trace.some((line) => /^\[Pitwall\] trace groups .*replaced=0\//.test(line)), 'a focus change says none were');
  assert.ok(
    trace.some((line) => line.startsWith('[Pitwall] trace tabs opened=[g1:0 "Chat bbbb" webview:mainThreadWebview-claudeVSCodePanel]')),
    'a tab event names group, index, label and input kind'
  );
  assert.ok(trace.some((line) => /^\[Pitwall\] trace follow bbbb "Chat bbbb" \(moved copy\)/.test(line)), 'the bind decision and its reason');
  assert.equal(service.toggleTrace(), false);
  logs.length = 0;
  cursor.resend();
  assert.deepEqual(logs.filter((line) => line.includes('trace')), [], 'off again');
  service.dispose();
});

// ---- Round 2 (live F2): side by side waits for each move to land ----

test('whenTabMoved resolves when a Claude tab closes (a move landing), or false after its timeout', async () => {
  const { world, service, timers } = serialWorld();
  await service.openSerially(['aaaa'], async () => void world.open(claudeTab(), 'Chat a'));
  const landed = service.whenTabMoved(1000);
  assert.deepEqual(timers.delays(), [1000]);
  const file = world.open(fileTab(), 'file.ts');
  world.close(file);
  world.open(claudeTab(), 'Claude Code');
  let settled: boolean | undefined;
  void landed.then((value) => (settled = value));
  await until(() => settled !== undefined);
  assert.equal(settled, undefined, 'a file closing or a tab opening is not the end of a move');
  world.close(world.groups[0].tabs[0]);
  assert.equal(await landed, true);
  assert.deepEqual(timers.delays(), [], 'its timer is gone');
  const nothing = service.whenTabMoved(1000);
  timers.fire();
  assert.equal(await nothing, false, 'a move that never lands times out');
  service.dispose();
});

// ---- T8 (live I1b): a tab that was there before an open is never "the only expected chat" ----

test('a pre-existing unbound tab is never taken as "the only expected chat": each open binds its own new tab (I1b)', async () => {
  const { world, service, bound } = serialWorld();
  // b after the relaunch: a restored, pinned "Probe-b1" tab nobody bound, in front.
  world.open(claudeTab(), 'Probe-b1.txt file creati…', { announce: false });
  /** T2's single open: expect, the command resolves, settle, and only then the panel's open event (d2 trace). */
  const openOne = (sessionId: string, rowName: string, tabTitle: string) => {
    service.expect(sessionId, rowName);
    service.settle(sessionId, { allowActiveFallback: true });
    world.open(claudeTab(), tabTitle);
  };
  openOne('aa4f8ec3', 'reply with exactly: o2 chat one', 'O2 chat one');
  openOne('20aa05a6', 'reply with exactly: o2 chat two', 'O2 chat two');
  openOne('4397131d', 'reply with exactly: probe b1', 'Probe-b1.txt file creati…');
  assert.deepEqual(bound(), [[undefined, 'aa4f8ec3', '20aa05a6', '4397131d']], 'every open binds the tab it made; the old tab stays unknown');
  service.dispose();
});

test('a pre-existing tab losing focus to the new one is not bound to the pending open either (I1b, the changed event)', async () => {
  const { world, service, bound } = serialWorld();
  const old = world.open(claudeTab(), 'Lab C two', { announce: false });
  service.expect('095a88d2', 'reply with exactly: lab c one');
  world.focus(old);
  assert.deepEqual(bound(), [[undefined]], 'a changed event on the old tab binds nothing');
  world.open(claudeTab(), 'Lab C one');
  assert.deepEqual(bound(), [[undefined, '095a88d2']]);
  service.dispose();
});

test('a pre-existing tab still binds when its own title names the chat, and only one unbound tab carries it', async () => {
  const { world, service, bound } = serialWorld();
  world.open(claudeTab(), 'O2 chat two', { announce: false });
  world.open(claudeTab(), 'Claude in Chrome browser…', { announce: false });
  world.open(claudeTab(), 'Claude in Chrome browser…', { announce: false });
  service.expect('20aa05a6', 'O2 chat two');
  service.settle('20aa05a6', { allowActiveFallback: true });
  service.expect('5b7f5314', 'Claude in Chrome browser automation');
  service.settle('5b7f5314', { allowActiveFallback: true });
  assert.deepEqual(bound(), [['20aa05a6', undefined, undefined]], 'two tabs carry the second title, so neither is guessed');
  service.dispose();
});

// ---- T8 (live I1): tabs Pitwall did not open are adopted by a title that names one chat ----

const labB = [
  { sessionId: '20aa05a6', titles: ['O2 chat two', 'reply with exactly: o2 chat two'] },
  { sessionId: '4397131d', titles: ['Probe-b1.txt file creation'] },
  { sessionId: 'aa4f8ec3', titles: ['O2 chat one'] },
  { sessionId: 'c631abb6', titles: ['Lab B ready'] },
];

test("tabs restored before activation are adopted when their title names exactly one of the folder's chats (I1, R1)", () => {
  const world = tabWorld();
  const logs: string[] = [];
  for (const title of ['O2 chat two', 'Probe-b1.txt file creati…', 'O2 chat one', 'Claude Code']) {
    world.open(claudeTab(), title, { announce: false });
  }
  world.open(fileTab(), 'README.md', { announce: false });
  const service = claudeUiSurfaces({ ...world.options, log: (line: string) => void logs.push(line) } as never);
  let changes = 0;
  service.onDidChange(() => changes++);
  assert.ok(!service.isOpen('20aa05a6'), 'nothing is adopted before the titles are known');
  service.setTitleSource(() => labB);
  assert.deepEqual(
    service.describeTabs()[0].tabs.map((tab) => tab.sessionId),
    ['20aa05a6', '4397131d', 'aa4f8ec3', undefined, undefined],
    'each named tab bound; the default-titled tab and the file stay unknown'
  );
  assert.equal(changes, 1, 'one change for the batch');
  assert.ok(logs.includes('[Pitwall] tab bound 20aa05a6 "O2 chat two"'), logs.join('\n'));
  service.dispose();
});

test("a tab whose title fits two chats, or two tabs with one chat's title, stay unknown (never guessed)", () => {
  const world = tabWorld();
  world.open(claudeTab(), 'Claude in Chrome browser…', { announce: false });
  world.open(claudeTab(), 'Lab C one', { announce: false });
  world.open(claudeTab(), 'Lab C one', { announce: false });
  world.open(claudeTab(), 'Lab C two', { announce: false });
  const service = claudeUiSurfaces(world.options);
  service.setTitleSource(() => [
    { sessionId: 'chrome-1', titles: ['Claude in Chrome browser automation'] },
    { sessionId: 'chrome-2', titles: ['Claude in Chrome browser automation'] },
    { sessionId: '095a88d2', titles: ['Lab C one'] },
    { sessionId: '23c80023', titles: ['Lab C two'] },
  ]);
  assert.deepEqual(service.describeTabs()[0].tabs.map((tab) => tab.sessionId), [undefined, undefined, undefined, '23c80023']);
  service.dispose();
});

test('a tab that gets its title later is adopted then, and a waiting serial open takes it without its 5 s wait', async () => {
  const { world, service, timers } = serialWorld();
  const tab = world.open(claudeTab(), 'Claude Code', { announce: false });
  service.setTitleSource(() => [{ sessionId: '095a88d2', titles: ['Lab C one'] }]);
  assert.ok(!service.isOpen('095a88d2'));
  const result = service.openSerially(['095a88d2'], async () => {
    // The panel reveals the tab it already had (no open event); its title arrives.
    tab.label = 'Lab C one';
    world.emit([], [tab]);
  });
  const map = await result;
  assert.equal(map.get('095a88d2'), tab as never, 'the open resolves with the adopted tab');
  assert.deepEqual(timers.delays(), [], 'no 5 s wait is left running');
  service.dispose();
});

test('adoption never takes a moved copy, a tab bound by an open, or a binding released into the move window', async () => {
  const { world, service, bound } = serialWorld();
  const cursor = cursorWorkbench(world);
  await service.openSerially(['aaaa', 'bbbb', 'cccc'], async (id) => void world.open(claudeTab(), `Chat ${id}`));
  service.setTitleSource(() => ['aaaa', 'bbbb', 'cccc'].map((id) => ({ sessionId: id, titles: [`Chat ${id}`] })));
  for (const order of ['cursor', 'close-first', 'one-event', 'no-resend'] as const) {
    cursor.move(0, 0, 'new-after', order);
    cursor.move(1, 0, 0, order);
  }
  assert.deepEqual(groupOf(service), { aaaa: 0, bbbb: 0, cccc: 0 });
  assert.equal(bound().flat().filter(Boolean).length, 3);
  service.dispose();
});

test('adoptBeforeOpen waits for the titles (bounded), then adopts', async () => {
  const world = tabWorld();
  world.open(claudeTab(), 'Lab C one', { announce: false });
  const service = claudeUiSurfaces(world.options);
  let release: () => void = () => undefined;
  const titles: { sessionId: string; titles: string[] }[] = [];
  service.setTitleSource(() => titles, new Promise<void>((resolve) => (release = resolve)));
  const before = service.adoptBeforeOpen(5_000);
  titles.push({ sessionId: '095a88d2', titles: ['Lab C one'] });
  release();
  await before;
  assert.ok(service.isOpen('095a88d2'));
  const stuck = claudeUiSurfaces(world.options);
  stuck.setTitleSource(() => [], new Promise(() => undefined));
  const startedAt = Date.now();
  await stuck.adoptBeforeOpen(50);
  assert.ok(Date.now() - startedAt < 1_000, 'a listing that never ends does not hold the open');
  service.dispose();
  stuck.dispose();
});

// ---- T8 round 2: guards QA showed could be deleted with every test still green ----

test('R2-2: nothing is adopted while the title source is partial; once the listing lands, a title two chats share leaves the tab unknown', async () => {
  const world = tabWorld();
  const tab = world.open(claudeTab(), 'Lab C one', { announce: false });
  const service = claudeUiSurfaces(world.options);
  let release: () => void = () => undefined;
  // The listing so far has chat A only; chat B, with the very same title, is not listed yet.
  const titles = [{ sessionId: 'aaaa', titles: ['Lab C one'] }];
  service.setTitleSource(() => titles, new Promise<void>((resolve) => (release = resolve)));
  world.emit([], [tab]);
  world.emitGroups();
  service.adopt();
  assert.ok(!service.isOpen('aaaa'), 'the partial source cannot prove the title is chat A\'s alone');
  titles.push({ sessionId: 'bbbb', titles: ['Lab C one'] });
  release();
  for (let i = 0; i < 3; i++) await nextTurn();
  assert.ok(!service.isOpen('aaaa') && !service.isOpen('bbbb'), 'listing ready: the shared title stays unknown');
  assert.deepEqual(service.describeTabs()[0].tabs.map((entry) => entry.sessionId), [undefined]);
  service.dispose();
});

test("R2-3 (I1b): a new tab titled as ANOTHER chat of the folder (the user opened it by hand) is not bound to the pending open", () => {
  const { world, service, bound } = serialWorld();
  service.setTitleSource(() => [
    { sessionId: 'aaaa', titles: ['Chat A'] },
    { sessionId: 'bbbb', titles: ['Chat B'] },
  ]);
  service.expect('aaaa', 'reply with exactly: chat a');
  world.open(claudeTab(), 'Chat B');
  assert.ok(!service.isOpen('aaaa'), 'chat A is still waiting for its own tab');
  assert.deepEqual(bound(), [['bbbb']], 'the tab is chat B\'s');
  service.dispose();
});

test('R2-4: a title that arrives after the open callback resolved adopts the tab and ends the serial open at once', async () => {
  const { world, service, timers } = serialWorld();
  const tab = world.open(claudeTab(), 'Claude Code', { announce: false });
  service.setTitleSource(() => [{ sessionId: '095a88d2', titles: ['Lab C one'] }]);
  let opened = false;
  const result = service.openSerially(['095a88d2'], async () => void (opened = true));
  await until(() => opened);
  await nextTurn();
  assert.equal(timers.delays().length, 1, 'the open is now waiting out its 5 s for the tab');
  tab.label = 'Lab C one';
  world.emit([], [tab]);
  const outcome = await Promise.race([result, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1_000))]);
  assert.notEqual(outcome, 'hung', 'adoption ends the wait; the 5 s timer never has to run');
  assert.equal((outcome as Map<string, unknown>).get('095a88d2'), tab as never);
  assert.deepEqual(timers.delays(), [], 'no 5 s wait is left running');
  service.dispose();
});

test('R2-5 (F1): a title that arrives only in a re-sent tab model (Cursor) adopts the tab, and bound tabs still pair by place', async () => {
  const { world, service, bound } = serialWorld();
  const cursor = cursorWorkbench(world);
  world.open(claudeTab(), 'Claude Code', { announce: false });
  await service.openSerially(['bbbb'], async () => void world.open(claudeTab(), 'Chat bbbb'));
  service.setTitleSource(() => [
    { sessionId: 'aaaa', titles: ['Lab C one'] },
    { sessionId: 'bbbb', titles: ['Chat bbbb'] },
  ]);
  assert.deepEqual(bound(), [[undefined, 'bbbb']]);
  // The new model carries the title; a re-send fires a group event only, no tab event.
  world.groups[0].tabs[0].label = 'Lab C one';
  cursor.resend();
  assert.deepEqual(bound(), [['aaaa', 'bbbb']], 'adopted by the group event; the other binding followed its place');
  service.dispose();
});

test('R2-6: while the title source is partial, a title proves nothing: a restored tab is not bound by it, nor is a new tab with an unlisted title', () => {
  const restored = serialWorld();
  restored.world.open(claudeTab(), 'O2 chat two', { announce: false });
  restored.service.setTitleSource(() => labB, new Promise(() => undefined));
  restored.service.expect('20aa05a6', 'O2 chat two');
  restored.service.settle('20aa05a6', { allowActiveFallback: true });
  assert.deepEqual(restored.bound(), [[undefined]], 'provenFor is false until the listing is complete');
  restored.service.dispose();

  const fresh = serialWorld();
  fresh.service.setTitleSource(() => [], new Promise(() => undefined));
  fresh.service.expect('aaaa', 'reply with exactly: chat a');
  fresh.world.open(claudeTab(), 'Title the partial listing lacks');
  assert.deepEqual(fresh.bound(), [[undefined]], 'namesOther is conservative until the listing is complete');
  fresh.service.dispose();
});

// ---- Phase 5 Task 1 (E11): the first visit of a restored panel tab ----

test('a Tab seeded at activation, inactive then, is a first visit until it is active once and left, bound or not', () => {
  const world = tabWorld();
  const shown = world.open(claudeTab(), 'O2 chat one', { announce: false });
  const named = world.open(claudeTab(), 'O2 chat two', { active: false, announce: false });
  const untitled = world.open(claudeTab(), 'Claude Code', { active: false, announce: false });
  const file = world.open(fileTab(), 'README.md', { active: false, announce: false });
  const service = claudeUiSurfaces(world.options);
  service.setTitleSource(() => labB);
  assert.ok(service.isOpen('20aa05a6'), 'the named tab is bound; the untitled one stays unbound');
  const first = (tab: FakeTab) => service.isFirstVisitSinceLaunch(tab as unknown as vscode.Tab);

  assert.deepEqual([shown, named, untitled, file].map(first), [false, true, true, false], 'active at activation, or not a Claude tab: never');
  world.focus(untitled);
  assert.equal(first(untitled), true, 'the visit in progress is still the first: the hold reads it on the activation event');
  world.focus(named);
  assert.deepEqual([untitled, named].map(first), [false, true], 'left once: visited, unbound or not');
  world.focus(shown);
  assert.deepEqual([shown, named, untitled].map(first), [false, false, false], 'bound or not, each is visited once');
  service.dispose();
});

test('a first visit follows a re-sent tab model (Cursor) and ends when the tab closes', () => {
  const world = tabWorld();
  world.open(claudeTab(), 'Active', { announce: false });
  world.open(claudeTab(), 'Claude Code', { active: false, announce: false });
  world.open(claudeTab(), 'Claude Code', { active: false, announce: false });
  const service = claudeUiSurfaces(world.options);
  const first = (tab: FakeTab | undefined) => service.isFirstVisitSinceLaunch(tab as unknown as vscode.Tab);
  cursorWorkbench(world).resend();
  const [, second, third] = world.groups[0].tabs;
  assert.deepEqual([second, third].map(first), [true, true], 'the replacement Tab objects inherit the first visit by place');
  world.close(third);
  assert.equal(first(third), false, 'a closed tab is no visit');
  service.dispose();
});

test('a tab Pitwall opened is never a first visit', async () => {
  const { world, service } = serialWorld();
  const background = world.open(claudeTab(), 'Opened later', { active: false });
  await service.openSerially(['aaaa'], async () => void world.open(claudeTab(), 'Chat aaaa', { active: false }));
  const opened = world.groups[0].tabs[1];
  const first = (tab: FakeTab) => service.isFirstVisitSinceLaunch(tab as unknown as vscode.Tab);
  assert.deepEqual([background, opened].map(first), [false, false], 'only tabs present at activation');
  service.dispose();
});

test('traceTabs logs a re-sent identical tab model once', async () => {
  const { world, service, logs } = serialWorld();
  const cursor = cursorWorkbench(world);
  await service.openSerially(['aaaa', 'bbbb'], async (id) => void world.open(claudeTab(), `Chat ${id}`));
  service.toggleTrace();
  logs.length = 0;
  cursor.resend();
  cursor.resend();
  cursor.resend();
  const groups = () => logs.filter((line) => line.startsWith('[Pitwall] trace groups '));
  assert.equal(groups().length, 1, `three identical re-sends, one line: ${groups().join('\n')}`);
  world.focus(world.groups[0].tabs[0]);
  cursor.resend();
  assert.equal(groups().length, 2, 'a re-send after the model changed is logged again');
  service.dispose();
});
