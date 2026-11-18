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

test('settle binds the active Claude tab after a command, but a background link needs a matching title', () => {
  const world = tabWorld();
  const service = claudeUiSurfaces(world.options);

  // A command just revealed the tab, so the active tab may be bound even when
  // its title was truncated differently.
  world.open(claudeTab(), 'Already open', { announce: false });
  service.expect('command', 'A different name');
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
