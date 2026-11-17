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
import { ALL_HARNESSES, validateEnabled } from '../../../src/harnesses';

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

// ---- Duplicates across fragments are refused (Phase 2, Task 7) ----

type Json = Record<string, any>;

const readRepoJson = (...parts: string[]): Json => JSON.parse(fs.readFileSync(path.join(ROOT, ...parts), 'utf8'));

/**
 * Write a temp `--root` tree: the real core fragment (optionally edited by `editCore`),
 * a repo-shaped package.json, and a `dup` harness fragment. Returns the root.
 */
function fixtureRoot(dupFragment: Json, editCore?: (core: Json) => void): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-manifest-root-'));
  const core = readRepoJson('manifest', 'core.contributes.json');
  editCore?.(core);
  fs.mkdirSync(path.join(root, 'manifest'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'harnesses', 'dup'), { recursive: true });
  fs.writeFileSync(path.join(root, 'manifest', 'core.contributes.json'), JSON.stringify(core, null, 2));
  fs.writeFileSync(path.join(root, 'src', 'harnesses', 'dup', 'contributes.json'), JSON.stringify(dupFragment, null, 2));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
  return root;
}

/** Build the fixture with the `dup` harness enabled; the temp tree is removed afterwards. */
function buildFixture(
  dupFragment: Json,
  options: { editCore?: (core: Json) => void; enabled?: string } = {}
): { status: number | null; output: string; contributes?: Json } {
  const root = fixtureRoot(dupFragment, options.editCore);
  try {
    const out = path.join(root, 'out.json');
    const result = spawnSync(
      process.execPath,
      [BUILDER, '--root', root, '--enabled', options.enabled ?? 'dup', '--out', out],
      { cwd: ROOT, encoding: 'utf8' }
    );
    const contributes = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')).contributes : undefined;
    return { status: result.status, output: `${result.stdout}${result.stderr}`, contributes };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const DUP = 'src/harnesses/dup/contributes.json';

test('a fragment that re-declares a core command is refused', () => {
  const result = buildFixture({ commands: [{ command: 'pitwall.refreshWorkspaces', title: 'Again' }] });
  assert.equal(result.status, 2, result.output);
  assert.ok(
    result.output.includes(
      `duplicate command "pitwall.refreshWorkspaces" in ${DUP} (already declared by manifest/core.contributes.json)`
    ),
    result.output
  );
});

test('a setting re-declared under a differently titled section is refused', () => {
  const result = buildFixture({
    configuration: [{ title: 'Dup', properties: { 'pitwall.autoImport.enabled': { type: 'boolean', default: true } } }],
  });
  assert.equal(result.status, 2, result.output);
  assert.ok(result.output.includes(`duplicate setting "pitwall.autoImport.enabled" in ${DUP}`), result.output);
});

test('a keybinding on a key core already binds with the same when is refused', () => {
  const result = buildFixture({ keybindings: [{ command: 'pitwall.dupOnly', key: 'ctrl+alt+n', mac: 'ctrl+cmd+n' }] });
  assert.equal(result.status, 2, result.output);
  assert.ok(result.output.includes(`duplicate keybinding "ctrl+alt+n|ctrl+cmd+n|" in ${DUP}`), result.output);

  const otherWhen = buildFixture({
    keybindings: [{ command: 'pitwall.dupOnly', key: 'ctrl+alt+n', mac: 'ctrl+cmd+n', when: 'editorFocus' }],
  });
  assert.equal(otherWhen.status, 0, 'the same key under a different when is not a duplicate');
});

test('duplicate submenu, view and viewsContainer ids are refused', () => {
  const submenu = buildFixture({ submenus: [{ id: 'pitwall.newSession', label: 'Again' }] });
  assert.equal(submenu.status, 2, submenu.output);
  assert.ok(submenu.output.includes(`duplicate submenu "pitwall.newSession" in ${DUP}`), submenu.output);

  const view = buildFixture({ views: { pitwall: [{ id: 'pitwall.filesView', name: 'Again' }] } });
  assert.equal(view.status, 2, view.output);
  assert.ok(view.output.includes(`duplicate view "pitwall.filesView" in ${DUP}`), view.output);

  const container = buildFixture({ viewsContainers: { activitybar: [{ id: 'pitwall', title: 'Again', icon: 'x.svg' }] } });
  assert.equal(container.status, 2, container.output);
  assert.ok(container.output.includes(`duplicate viewsContainer "pitwall" in ${DUP}`), container.output);
});

test('untitled configuration sections are matched by identity, not undefined === undefined', () => {
  // Core and the fragment each own an untitled section with a different setting: both survive as separate sections.
  const separate = buildFixture(
    { configuration: [{ properties: { 'pitwall.dupOnly': { type: 'boolean', default: false } } }] },
    { editCore: (core) => core.configuration.push({ properties: { 'pitwall.coreUntitled': { type: 'boolean', default: false } } }) }
  );
  assert.equal(separate.status, 0, separate.output);
  const untitled = (separate.contributes!.configuration as Json[]).filter((section) => section.title === undefined);
  assert.equal(untitled.length, 2, 'two untitled sections stay two');
  assert.deepEqual(untitled.map((section) => Object.keys(section.properties)), [['pitwall.coreUntitled'], ['pitwall.dupOnly']]);

  // The same setting key in both untitled sections is still a duplicate.
  const clash = buildFixture(
    { configuration: [{ properties: { 'pitwall.coreUntitled': { type: 'boolean', default: false } } }] },
    { editCore: (core) => core.configuration.push({ properties: { 'pitwall.coreUntitled': { type: 'boolean', default: false } } }) }
  );
  assert.equal(clash.status, 2, clash.output);
  assert.ok(clash.output.includes(`duplicate setting "pitwall.coreUntitled" in ${DUP}`), clash.output);
});

test('a filled x-harness-enum whose default is not in its enum is refused', () => {
  const result = buildFixture({
    'x-harness-enum': { 'pitwall.sessionSearch.harness': { label: 'Dup', description: 'Only dup' } },
  });
  assert.equal(result.status, 2, result.output);
  assert.ok(result.output.includes('pitwall.sessionSearch.harness'), result.output);
  assert.ok(result.output.includes('default "claude" is not in the enum'), result.output);
});

test('core enum, enumItemLabels and enumDescriptions of unequal length are refused', () => {
  const result = buildFixture(
    { 'x-harness-enum': { 'pitwall.sessionSearch.harness': { label: 'Dup', description: 'Dup' } } },
    { editCore: (core) => {
        const section = core.configuration.find((entry: Json) => entry.properties['pitwall.defaultHarness']);
        section.properties['pitwall.defaultHarness'].enumItemLabels.push('Extra label');
      } }
  );
  assert.equal(result.status, 2, result.output);
  assert.ok(result.output.includes('pitwall.defaultHarness'), result.output);
  assert.match(result.output, /unequal length|same length/);
});

test('enabled.json validation rejects unknown, inherited, duplicate and empty ids', () => {
  assert.throws(() => validateEnabled(['toString'], ALL_HARNESSES), /Unknown harness "toString"/);
  assert.throws(() => validateEnabled(['nope'], ALL_HARNESSES), /Unknown harness "nope".*Valid ids: claude/);
  assert.throws(() => validateEnabled(['claude', 'claude'], ALL_HARNESSES), /Duplicate harness "claude"/);
  assert.throws(() => validateEnabled([], ALL_HARNESSES), /must name at least one harness/);
  assert.throws(() => validateEnabled([7], ALL_HARNESSES), /Unknown harness "7"/);
  assert.deepEqual(validateEnabled(['claude', 'codex'], ALL_HARNESSES), ['claude', 'codex']);
});

test('harness folders with a contributes.json, ALL_HARNESSES keys and module ids agree', () => {
  const harnessesDir = path.join(ROOT, 'src', 'harnesses');
  const folders = fs
    .readdirSync(harnessesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(harnessesDir, entry.name, 'contributes.json')))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(folders, Object.keys(ALL_HARNESSES).sort());
  for (const [key, module] of Object.entries(ALL_HARNESSES)) {
    assert.equal(module.id, key, `ALL_HARNESSES.${key}.id`);
  }
});
