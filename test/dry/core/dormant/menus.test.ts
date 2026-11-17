/**
 * Parked by ROADMAP row 3.6 / ruling P9. These are the menus.test.ts assertions
 * about the hidden worktree, PR and fork-with-changes commands, moved verbatim.
 * They return to ../menus.test.ts when the manifest contributes those commands again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pkg from '../../../../package.json';

interface MenuEntry {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}

const menus = pkg.contributes.menus as Record<string, MenuEntry[]>;
const commands = pkg.contributes.commands as { command: string; title: string }[];
const rowMenu = (menus['view/item/context'] ?? []).filter((entry) => entry.when?.includes('pitwall.workspacesView'));
const isInline = (entry: MenuEntry) => entry.group?.split('@')[0] === 'inline';
const id = (entry: MenuEntry) => entry.command ?? entry.submenu ?? '';

test('the hover row never carries Delete Worktree or Fork Session to New Worktree', () => {
  const inline = new Set(rowMenu.filter(isInline).map(id));
  for (const command of ['pitwall.deleteWorktree', 'pitwall.forkChatWithChanges']) {
    assert.ok(!inline.has(command), `${command} is not a hover action`);
  }
});

test('a plain folder row offers no git-only worktree or PR actions', () => {
  const folderActions = new Set(rowMenu.filter((entry) => entry.when?.includes('folderRepository')).map(id));
  for (const gitOnly of ['pitwall.addWorktree', 'pitwall.checkoutPR', 'pitwall.deleteWorktree', 'pitwall.mergeWorktree', 'pitwall.rebaseWorktree', 'pitwall.openPRInBrowser']) {
    assert.ok(!folderActions.has(gitOnly), gitOnly);
  }
});

test('Fork Session to New Worktree ends in an ellipsis and Delete Worktree is hidden from the palette', () => {
  assert.match(commands.find((entry) => entry.command === 'pitwall.forkChatWithChanges')?.title ?? '', /…$/);
  assert.ok((menus.commandPalette ?? []).some((entry) => entry.command === 'pitwall.deleteWorktree' && entry.when === 'false'));
});
