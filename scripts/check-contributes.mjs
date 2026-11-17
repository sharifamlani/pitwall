#!/usr/bin/env node
/**
 * E9 check on the built package.json (ROADMAP row 3.6 / ruling P9):
 * the hidden Agntree extras are absent, the keepers are present, FILES is collapsed.
 *
 *   node scripts/check-contributes.mjs [--root <dir>]   # exit 0 ok, 1 violation
 */
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const argRoot = process.argv.indexOf('--root');
const root = argRoot > -1 ? resolve(process.argv[argRoot + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contributes = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).contributes;

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
const KEPT_COMMANDS = ['pitwall.findSession', 'pitwall.forkChat'];

const text = JSON.stringify(contributes);
const problems = [];

for (const id of HIDDEN) {
  if (text.includes(id)) problems.push(`${id} is still contributed`);
}
const commands = new Set(contributes.commands.map((entry) => entry.command));
for (const id of KEPT_COMMANDS) {
  if (!commands.has(id)) problems.push(`${id} is missing`);
}
const files = Object.values(contributes.views).flat().find((view) => view.id === 'pitwall.filesView');
if (!files) problems.push('pitwall.filesView is missing');
else if (files.visibility !== 'collapsed') problems.push(`pitwall.filesView visibility is ${files.visibility ?? 'unset'}, expected collapsed`);

console.log(`checked: ${HIDDEN.length} hidden ids absent, ${KEPT_COMMANDS.join(' + ')} present, pitwall.filesView collapsed`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  process.exit(1);
}
console.log('OK');
