/**
 * The manifest is generated: `scripts/build-manifest.mjs` merges
 * `manifest/core.contributes.json` with the `contributes.json` of every
 * harness named in `src/harnesses/enabled.json`. These tests prove the one
 * switch works both ways: a disabled harness contributes nothing, and enabling
 * it brings its commands back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The bundle runs from test/dry/.build, so the repo root is three levels up.
const ROOT = path.resolve(__dirname, '..', '..', '..');
const BUILDER = path.join(ROOT, 'scripts', 'build-manifest.mjs');
const DORMANT = new Set(['codex', 'opencode', 'pi']);

interface Setting {
  enum?: string[];
}
interface Contributes {
  commands: { command: string }[];
  configuration: { title: string; properties: Record<string, Setting> }[];
  menus: Record<string, { command?: string; submenu?: string; when?: string }[]>;
  submenus?: { id: string }[];
  keybindings?: { command: string; when?: string }[];
  views?: Record<string, { id: string; when?: string }[]>;
}

/** Run the builder into a temp file and return the text it wrote. */
function build(args: string[]): { status: number | null; output: string; text?: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-manifest-'));
  try {
    const out = path.join(dir, 'package.json');
    const result = spawnSync(process.execPath, [BUILDER, ...args, '--out', out], { cwd: ROOT, encoding: 'utf8' });
    const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : undefined;
    return { status: result.status, output: `${result.stdout}${result.stderr}`, text };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function contributesFor(enabled: string[]): Contributes {
  const result = build(['--enabled', enabled.join(',')]);
  assert.equal(result.status, 0, result.output);
  return JSON.parse(result.text!).contributes as Contributes;
}

/** The words of an id or `when` clause: `pitwall.newPiChat` → pitwall, new, pi, chat. */
function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** Every command, setting, menu, submenu, view and keybinding id, every `when`, and every enum value. */
function idsAndEnums(contributes: Contributes): string[] {
  const settings = Object.assign({}, ...contributes.configuration.map((section) => section.properties)) as Record<
    string,
    Setting
  >;
  const menuEntries = Object.values(contributes.menus).flat();
  return [
    ...contributes.commands.map((entry) => entry.command),
    ...Object.keys(settings),
    ...Object.values(settings).flatMap((setting) => setting.enum ?? []),
    ...Object.keys(contributes.menus),
    ...menuEntries.flatMap((entry) => [entry.command ?? '', entry.submenu ?? '', entry.when ?? '']),
    ...(contributes.submenus ?? []).map((submenu) => submenu.id),
    ...(contributes.keybindings ?? []).flatMap((binding) => [binding.command, binding.when ?? '']),
    ...Object.values(contributes.views ?? {}).flat().flatMap((view) => [view.id, view.when ?? '']),
  ].filter(Boolean);
}

const settingsOf = (contributes: Contributes): Record<string, Setting> =>
  Object.assign({}, ...contributes.configuration.map((section) => section.properties));
const commandIds = (contributes: Contributes) => new Set(contributes.commands.map((entry) => entry.command));

test('the Claude-only build names no other harness, and keeps every Claude command', () => {
  const contributes = contributesFor(['claude']);
  const offenders = idsAndEnums(contributes).filter((value) => words(value).some((word) => DORMANT.has(word)));
  assert.deepEqual(offenders, [], 'no command, setting, menu id, when clause or enum names codex, opencode or pi');

  const commands = commandIds(contributes);
  for (const command of ['pitwall.newClaudeChat', 'pitwall.newClaudeChatInTerminal', 'pitwall.newClaudeChatInUi', 'pitwall.openClaudeUi']) {
    assert.ok(commands.has(command), command);
  }
  const settings = settingsOf(contributes);
  assert.ok(settings['pitwall.harnessCommands.claude'], 'the Claude command setting');
  assert.deepEqual(settings['pitwall.defaultHarness'].enum, ['', 'claude']);
  assert.deepEqual(settings['pitwall.sessionSearch.harness'].enum, ['claude']);
});

test('enabling Codex is one switch: the claude,codex build has the Codex commands and settings', () => {
  const contributes = contributesFor(['claude', 'codex']);
  const commands = commandIds(contributes);
  for (const command of ['pitwall.newCodexChat', 'pitwall.newCodexChatInTerminal', 'pitwall.newCodexChatInUi', 'pitwall.openCodexUi']) {
    assert.ok(commands.has(command), command);
  }
  const settings = settingsOf(contributes);
  assert.ok(settings['pitwall.harnessCommands.codex'], 'the Codex command setting');
  assert.deepEqual(settings['pitwall.defaultHarness'].enum, ['', 'claude', 'codex']);
  assert.deepEqual(settings['pitwall.sessionSearch.harness'].enum, ['claude', 'codex']);
  assert.ok(
    contributes.menus['pitwall.newSession'].some((entry) => entry.command === 'pitwall.newCodexChat'),
    'Codex is in the New Session menu'
  );
});

test('the shipped package.json is the build of enabled.json, which is Claude only', () => {
  const enabled = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'harnesses', 'enabled.json'), 'utf8'));
  assert.deepEqual(enabled, ['claude']);
  const result = build(['--enabled', 'claude']);
  assert.equal(result.status, 0, result.output);
  const shipped = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(shipped, result.text, 'package.json equals the ["claude"] build');

  const check = spawnSync(process.execPath, [BUILDER, '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(check.status, 0, `${check.stdout}${check.stderr}`);
});

test('--check fails with a diff when the manifest is out of date', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-manifest-'));
  try {
    const stale = path.join(dir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    pkg.contributes.commands.push({ command: 'pitwall.newCodexChat', title: 'New Codex Session', category: 'Pitwall' });
    fs.writeFileSync(stale, `${JSON.stringify(pkg, null, 2)}\n`);
    const check = spawnSync(process.execPath, [BUILDER, '--check', '--out', stale], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(check.status, 1);
    assert.match(check.stdout + check.stderr, /^-.*pitwall\.newCodexChat/m, 'the diff names the stale entry');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
