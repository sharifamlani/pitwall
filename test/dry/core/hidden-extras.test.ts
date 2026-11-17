/**
 * ROADMAP row 3.6 / ruling P9: the Agntree extras are hidden, the keepers stay.
 * The same ids are checked on the built package.json by scripts/check-contributes.mjs (E9).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import pkg from '../../../package.json';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HIDDEN = [
  'pitwall.changesView',
  'pitwall.addWorktree',
  'pitwall.deleteWorktree',
  'pitwall.mergeWorktree',
  'pitwall.rebaseWorktree',
  'pitwall.checkoutPR',
  'pitwall.openPRInBrowser',
  'pitwall.forkChatWithChanges',
];

test('the manifest contributes no Changes view, worktree create/delete/merge/rebase, PR or fork-with-changes entries', () => {
  const text = JSON.stringify(pkg.contributes);
  for (const hidden of HIDDEN) {
    assert.ok(!text.includes(hidden), `${hidden} is still contributed`);
  }
});

test('the Files view is collapsed by default and Find Session and Fork are still contributed', () => {
  const views = (pkg.contributes.views as Record<string, { id: string; name: string; visibility?: string }[]>).pitwall;
  const files = views.find((view) => view.id === 'pitwall.filesView');
  assert.equal(files?.name, 'Files');
  assert.equal(files?.visibility, 'collapsed');
  const commands = new Set((pkg.contributes.commands as { command: string }[]).map((entry) => entry.command));
  assert.ok(commands.has('pitwall.findSession'));
  assert.ok(commands.has('pitwall.forkChat'));
});

test('the tree never calls GitHubService', () => {
  for (const file of ['src/core/providers/WorkspacesTreeProvider.ts', 'src/extension.ts']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!/GitHubService|gitHubService/.test(source), `${file} still references GitHubService`);
  }
});
