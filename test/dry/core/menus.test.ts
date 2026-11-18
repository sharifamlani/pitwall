/**
 * Manifest rules for the quiet layout. Each test states a rule over every
 * entry it applies to, so a new harness or command is covered without a new
 * check. Registration and activation are proven by the integration suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pkg from '../../../package.json';

interface MenuEntry {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}

const menus = pkg.contributes.menus as Record<string, MenuEntry[]>;
const commands = pkg.contributes.commands as { command: string; title: string }[];
interface Setting { enum?: string[]; enumItemLabels?: string[]; markdownDescription?: string; order?: number }
const sections = pkg.contributes.configuration as unknown as { title: string; properties: Record<string, Setting> }[];
const settings: Record<string, Setting> = Object.assign({}, ...sections.map((section) => section.properties));
const rowMenu = (menus['view/item/context'] ?? []).filter((entry) =>
  entry.when?.includes('pitwall.workspacesView')
);
const isInline = (entry: MenuEntry) => entry.group?.split('@')[0] === 'inline';
const id = (entry: MenuEntry) => entry.command ?? entry.submenu ?? '';

/** Whether a menu entry's `viewItem =~ /…/` pattern matches a row's context value. */
const shownOn = (entry: MenuEntry, contextValue: string) => {
  const pattern = /viewItem =~ \/(.+?)\/(?= &&|$)/.exec(entry.when ?? '')?.[1];
  return pattern !== undefined && new RegExp(pattern).test(contextValue);
};
const orderOf = (entry: MenuEntry) => {
  const [group, order] = (entry.group ?? '').split('@');
  return `${group}@${order.padStart(3, '0')}`;
};

test('session rows show bell (needs you only), terminal and fork inline; star, rename and close are in the right-click menu only', () => {
  const inline = rowMenu.filter(isInline);
  // The values real Claude rows carry: the ClaudeUi suffix is always present (claudeUi.ts).
  const slots = (contextValue: string) =>
    inline
      .filter((entry) => shownOn(entry, contextValue))
      .sort((a, b) => orderOf(a).localeCompare(orderOf(b)))
      .map((entry) => `${id(entry)}@${entry.group}`);
  const BELL = 'pitwall.openNeedsYouChat@inline@0';
  const TERMINAL = 'pitwall.openChatInTerminal@inline@2';
  const FORK = 'pitwall.forkChat@inline@3';
  for (const value of ['chatNeedsClaudeUi', 'starredChatNeedsClaudeUi']) {
    assert.deepEqual(slots(value), [BELL, TERMINAL, FORK], `${value}: bell, terminal and fork, each in its own slot`);
  }
  for (const value of ['chatClaudeUi', 'starredChatClaudeUi']) {
    assert.deepEqual(slots(value), [TERMINAL, FORK], `${value}: terminal and fork, no bell`);
  }
  // A running row already has its terminal, so it shows the bell (when it needs you) and fork.
  assert.deepEqual(slots('runningChatNeedsClaudeUi'), [BELL, FORK]);
  assert.deepEqual(slots('runningChatClaudeUi'), [FORK]);
  const sessionCommands = new Set(inline.filter((entry) => shownOn(entry, 'chatNeedsClaudeUi')).map(id));
  for (const command of ['pitwall.starChat', 'pitwall.unstarChat', 'pitwall.renameChat', 'pitwall.closeChat']) {
    assert.ok(!inline.some((entry) => entry.command === command), `${command} is not a hover action`);
    assert.ok(
      rowMenu.some((entry) => entry.command === command && !isInline(entry)),
      `${command} stays in the right-click menu`
    );
  }
  assert.ok(sessionCommands.has('pitwall.openNeedsYouChat'));
  const bell = commands.find((entry) => entry.command === 'pitwall.openNeedsYouChat') as { icon?: string } | undefined;
  assert.equal(bell?.icon, '$(bell)');
  assert.ok(
    (menus.commandPalette ?? []).some((entry) => entry.command === 'pitwall.openNeedsYouChat' && entry.when === 'false'),
    'the bell is a row action, not a palette command'
  );
  for (const command of ['pitwall.deleteChat', 'pitwall.dismissRepository', 'pitwall.clearWorktreeSessions']) {
    assert.ok(!inline.some((entry) => entry.command === command), `${command} is not a hover action`);
  }
  assert.ok(
    rowMenu.some((entry) => entry.command === 'pitwall.deleteChat' && entry.group?.includes('destructive')),
    'Remove Session from List lives in the destructive context group'
  );

  const titleInline = (menus['view/title'] ?? []).filter(
    (entry) => entry.when?.includes('pitwall.workspacesView') && entry.group?.startsWith('navigation')
  );
  assert.deepEqual(titleInline.map(id), ['pitwall.search', 'pitwall.addRepository'], 'search then add, in canvas order');
});

test('the repo menu has exactly the §3c items in order, and the row shows history and "+" on hover', () => {
  const onRepo = rowMenu.filter((entry) => shownOn(entry, 'repository') || shownOn(entry, 'folderRepository'));
  const title = (command: string) => commands.find((entry) => entry.command === command)?.title;
  const byOrder = (a: MenuEntry, b: MenuEntry) => orderOf(a).localeCompare(orderOf(b));
  const menu = onRepo.filter((entry) => !isInline(entry)).sort(byOrder);
  const expected = [
    'pitwall.newSessionInRepository',
    'pitwall.sessionHistory',
    'pitwall.openInNewWindow',
    'pitwall.copyRepositoryPath',
    'pitwall.revealRepository',
    'pitwall.dismissRepository',
  ];
  assert.deepEqual(menu.map(id), expected);
  assert.deepEqual(expected.map(title), [
    'New Claude Code session',
    'Session history…',
    'Open its window',
    'Copy Path',
    'Reveal in File Explorer',
    'Dismiss from Pitwall',
  ]);
  assert.deepEqual(menu.map((entry) => entry.group?.split('_')[0]), ['1', '1', '1', '2', '2', '9'], 'separators fall after Open its window and before Dismiss');
  assert.deepEqual(
    onRepo.filter(isInline).sort(byOrder).map(id),
    ['pitwall.sessionHistoryInline', 'pitwall.newSessionInRepositoryInline'],
    'hover shows the history clock, then "+"'
  );
  const icon = (command: string) => (commands.find((entry) => entry.command === command) as { icon?: string }).icon;
  assert.equal(icon('pitwall.sessionHistoryInline'), '$(history)');
  assert.equal(icon('pitwall.newSessionInRepositoryInline'), '$(add)');
});

test('header and row action tooltips match the canvas copy', () => {
  // An icon action's hover text is its command title; VS Code appends the bound
  // key itself, so "(Ctrl+Alt+R)" and "(Ctrl+Alt+F)" are not written into titles.
  const title = (command: string) => commands.find((entry) => entry.command === command)?.title;
  assert.equal(title('pitwall.search'), 'Search repos and chats');
  assert.equal(title('pitwall.addRepository'), 'Add a repository');
  // A static title cannot carry the repo's name, so "in job-market" is "in this repo".
  assert.equal(title('pitwall.newSessionInRepositoryInline'), 'New Claude Code session in this repo');
  assert.equal(title('pitwall.sessionHistoryInline'), 'Session history for this repo: every past chat');
  assert.equal(title('pitwall.toggleFiles'), 'Show or hide files');
  for (const command of ['pitwall.newSessionInRepositoryInline', 'pitwall.sessionHistoryInline']) {
    assert.ok((menus.commandPalette ?? []).some((entry) => entry.command === command && entry.when === 'false'), `${command} is hover-only`);
  }
  const keys = pkg.contributes.keybindings as { command: string; key: string }[];
  assert.ok(keys.some((entry) => entry.command === 'pitwall.search' && entry.key === 'ctrl+alt+r'), 'the key VS Code appends');
  assert.ok(keys.some((entry) => entry.command === 'pitwall.toggleFiles' && entry.key === 'ctrl+alt+f'), 'the key VS Code appends');
});

test('a plain folder row offers the same repo menu as a git repo', () => {
  const folderActions = new Set(rowMenu.filter((entry) => shownOn(entry, 'folderRepository') && !isInline(entry)).map(id));
  const repoActions = new Set(rowMenu.filter((entry) => shownOn(entry, 'repository') && !isInline(entry)).map(id));
  assert.deepEqual([...folderActions].sort(), [...repoActions].sort());
});

test('New Session entries are gated on their harness, and the submenus on any harness', () => {
  for (const submenu of ['pitwall.newSession', 'pitwall.newSessionContext']) {
    const entries = menus[submenu] ?? [];
    assert.ok(entries.length > 0, submenu);
    assert.ok(entries.some((entry) => entry.command === 'pitwall.setDefaultHarness'), `${submenu} offers Set Default Agent`);
    for (const entry of entries.filter((candidate) => candidate.command !== 'pitwall.setDefaultHarness')) {
      const [, harness, variant] = /^pitwall\.new(\w+?)Chat(InTerminal|InUi)?$/.exec(entry.command ?? '') ?? [];
      assert.ok(harness, `${entry.command} is a New Session command`);
      const key = harness.toLowerCase();
      if (variant === 'InUi') {
        // Shown without the extension, so clicking it can explain the install.
        assert.match(entry.when ?? '', /defaultSessionSurface != 'ui'/, entry.command);
      } else {
        assert.ok(entry.when?.includes(`pitwall.${key}Installed`), `${entry.command} needs the ${key} CLI`);
      }
    }
  }
  for (const entry of rowMenu.filter((candidate) => candidate.submenu)) {
    assert.ok(entry.when?.includes('pitwall.anyHarnessInstalled'), entry.submenu);
  }
});

test('the default agent can be any harness, or none', () => {
  const harnesses = Object.keys(settings).flatMap((key) => /^pitwall\.harnessCommands\.(\w+)$/.exec(key)?.[1] ?? []);
  assert.deepEqual(settings['pitwall.defaultHarness'].enum, ['', ...harnesses]);
});

test('every setting sits in a titled section, explains itself, and names its choices; Pitwall Settings is in the view menu', () => {
  assert.ok(sections.length > 1 && sections.every((section) => section.title), 'settings are grouped');
  for (const [key, setting] of Object.entries(settings)) {
    assert.ok(setting.markdownDescription, `${key} has a description`);
    assert.ok(setting.order, `${key} has a position in its section`);
    if (setting.enum) {
      assert.equal(setting.enumItemLabels?.length, setting.enum.length, `${key} labels every choice`);
    }
  }
  assert.ok(
    (menus['view/title'] ?? []).some((entry) => entry.command === 'pitwall.openSettings' && entry.when?.includes('pitwall.workspacesView')),
    'the settings are one click from the sidebar'
  );
});

test('every Workspaces context entry sits in a numbered group, and every command is in the Pitwall category', () => {
  for (const entry of rowMenu.filter((candidate) => !isInline(candidate) && !candidate.when?.includes('changedFile'))) {
    assert.match(entry.group ?? '', /^\d_\w+@\d$/, id(entry));
  }
  for (const command of pkg.contributes.commands as { command: string; category?: string }[]) {
    assert.equal(command.category, 'Pitwall', command.command);
  }
});

test('with several session rows selected, the context menu keeps only actions that apply to all of them', () => {
  const sessionContext = rowMenu.filter((entry) => !isInline(entry) && /chat\|/i.test(entry.when ?? ''));
  assert.ok(sessionContext.length > 0);
  const bulk = new Set(['pitwall.starChat', 'pitwall.unstarChat', 'pitwall.closeChat', 'pitwall.deleteChat']);
  for (const entry of sessionContext) {
    assert.equal(!entry.when?.includes('!listMultiSelection'), bulk.has(id(entry)), id(entry));
  }
});

test('global shortcuts use Ctrl+Alt (Ctrl+Cmd on macOS); plain keys work only in a focused Pitwall tree, never while typing', () => {
  const bindings = pkg.contributes.keybindings as { command: string; key: string; mac?: string; when?: string }[];
  for (const binding of bindings) {
    if (binding.when) {
      assert.match(binding.when, /^focusedView == 'pitwall\.(workspaces|files)View' && !inputFocus/, binding.command);
    } else {
      assert.match(binding.key, /^ctrl\+alt\+(shift\+)?\w+$/, binding.command);
      assert.match(binding.mac ?? '', /^ctrl\+cmd\+(shift\+)?\w+$/, binding.command);
    }
  }
  const known = new Set([...commands.map((entry) => entry.command), 'workbench.view.extension.pitwall']);
  assert.deepEqual(bindings.filter((binding) => !known.has(binding.command)), [], 'every shortcut runs a real command');
  assert.ok(
    (menus['view/title'] ?? []).some((entry) => entry.command === 'pitwall.openKeybindings'),
    'the shortcuts can be changed from the sidebar menu'
  );
});

test('Open in UI is a context-menu item only, never a hover action', () => {
  // One Open in UI command per enabled harness that has a VS Code UI.
  const openUi = [...new Set(rowMenu.map(id))].flatMap((command) => {
    const name = /^pitwall\.open(\w+)Ui$/.exec(command)?.[1];
    return name ? [[command, name.toLowerCase()]] : [];
  });
  assert.ok(openUi.some(([command]) => command === 'pitwall.openClaudeUi'), 'Claude Code has Open in UI');
  for (const [command, ui] of openUi) {
    const entries = rowMenu.filter((entry) => entry.command === command);
    const context = entries.filter((entry) => !isInline(entry));
    const inline = entries.filter(isInline);
    assert.equal(context.length, 1, command);
    assert.ok(!context[0].when?.includes(`${ui}UiInstalled`), `${command} explains a missing extension`);
    assert.equal(inline.length, 0, `${command} is not a hover action: the canvas shows only bell, terminal and fork`);
  }
  const inTerminal = rowMenu.filter((entry) => entry.command === 'pitwall.openChatInTerminal');
  assert.ok(inTerminal.some((entry) => isInline(entry) && entry.when?.includes('chat|starredChat')), 'inline for closed rows');
  assert.ok(inTerminal.some((entry) => !isInline(entry) && entry.when?.includes('runningChat')), 'context menu for running rows');
});

test('dialog commands end in an ellipsis; row-only commands stay out of the palette', () => {
  // pitwall.addRepository is exempt: its tooltip copy is the canvas's "Add a repository".
  for (const command of ['pitwall.cloneRepository', 'pitwall.importSessions', 'pitwall.renameChat']) {
    assert.match(commands.find((entry) => entry.command === command)?.title ?? '', /…$/, command);
  }
  for (const command of ['pitwall.renameChat', 'pitwall.files.delete', 'pitwall.starChat']) {
    assert.ok(
      (menus.commandPalette ?? []).some((entry) => entry.command === command && entry.when === 'false'),
      `${command} is hidden from the palette`
    );
  }
});

test('inbox order replaces the manual repo order: no Move Up / Move Down anywhere (P18)', () => {
  const everywhere = JSON.stringify(pkg.contributes);
  assert.ok(!everywhere.includes('pitwall.moveRepositoryUp'), 'no Move Up command or menu entry');
  assert.ok(!everywhere.includes('pitwall.moveRepositoryDown'), 'no Move Down command or menu entry');
});

test('the list is named Repos, with the canvas empty state once a scan found nothing; FILES asks for a repo or session', () => {
  const views = pkg.contributes.views.pitwall as { id: string; name: string }[];
  assert.equal(views.find((view) => view.id === 'pitwall.workspacesView')?.name, 'Repos');
  const welcome = pkg.contributes.viewsWelcome as { view: string; contents: string; when?: string }[];
  assert.deepEqual(
    welcome.filter((entry) => entry.view === 'pitwall.workspacesView').map(({ contents, when }) => ({ contents, when })),
    [
      { contents: 'Scanning for repositories…', when: '!pitwall.scanned' },
      { contents: 'No repositories yet.\n[Add repository](command:pitwall.addRepository)', when: 'pitwall.scanned' },
    ]
  );
  assert.equal(
    welcome.find((entry) => entry.view === 'pitwall.filesView')?.contents,
    "Open a repo's window to see its files."
  );
  assert.ok(
    (menus['view/title'] ?? []).some((entry) => entry.command === 'pitwall.cloneRepository' && !entry.group?.startsWith('navigation')),
    'Clone stays in the overflow menu'
  );
});
