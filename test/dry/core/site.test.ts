/**
 * The reference docs describe files in this repository. These tests keep them
 * from drifting: every setting, command, and shortcut the manifest contributes
 * must be documented. (The upstream website build and IndexNow tests were removed
 * with site/ in Pitwall Phase 1 Task 1.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import pkg from '../../../package.json';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const sections = pkg.contributes.configuration as unknown as { properties: Record<string, unknown> }[];
const commands = pkg.contributes.commands as { command: string; title: string }[];
const keybindings = pkg.contributes.keybindings as { key: string; mac?: string }[];

test('the settings reference documents every setting the manifest contributes', () => {
  const doc = read('docs/reference/settings.md');
  const settings = sections.flatMap((section) => Object.keys(section.properties));
  assert.deepEqual(settings.filter((key) => !doc.includes(`\`${key}\``)), []);
});

test('the commands reference names every command the manifest contributes', () => {
  const doc = read('docs/reference/commands.md');
  assert.deepEqual(commands.map((command) => command.title).filter((title) => !doc.includes(title)), []);
});

test('the shortcuts reference lists every default key binding for both platforms', () => {
  const doc = read('docs/reference/keyboard-shortcuts.md');
  const NAMES: Record<string, string> = { ctrl: 'Ctrl', alt: 'Alt', cmd: 'Cmd', shift: 'Shift', enter: 'Enter', delete: 'Delete', backspace: 'Backspace' };
  const written = (key: string) => key.split('+').map((part) => NAMES[part] ?? part.toUpperCase()).join('+');
  const keys = new Set(keybindings.flatMap((binding) => [binding.key, binding.mac ?? binding.key]).map(written));
  assert.deepEqual([...keys].filter((key) => !doc.includes(`\`${key}\``)), []);
});
