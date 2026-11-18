#!/usr/bin/env node
/**
 * Read-only probe of Pitwall's cross-window files (Phase 4, ADR 0020): the
 * window registry and the handoff inbox under the extension's global storage.
 * It imports nothing from src/, so it is an independent check.
 *
 * Usage:
 *   node scripts/dump-pitwall-windows.mjs [--dir <globalStorage>] [--check-privacy]
 *
 * Default folder: the first that exists of Cursor's, then VS Code's,
 * `User/globalStorage/sharifamlani.pitwall` for this OS.
 *
 * Prints one line per window record, `pid folder beatAge open=<n>` (with
 * `stale` or `dead` appended when it no longer counts), then each request:
 * pending, claimed, expired, and its outcome when one was written.
 *
 * --check-privacy also checks that every file holds only its allowed keys
 * (E17): window record `pid, folder, beatAt, openSessionIds`; request
 * `v, kind, sessionIds, folder, at, nonce`; outcome `ok, error, at`; clipboard
 * `path, cut, at`. Lock files must be empty, and no other file may be there.
 *
 * Exit 0; 1 when --check-privacy finds a problem; 2 on bad arguments or a
 * folder that doesn't exist.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXTENSION_ID = 'sharifamlani.pitwall';
const STALE_MS = 45_000;

const ALLOWED = {
  window: ['pid', 'folder', 'beatAt', 'openSessionIds'],
  request: ['v', 'kind', 'sessionIds', 'folder', 'at', 'nonce'],
  outcome: ['ok', 'error', 'at'],
  clipboard: ['path', 'cut', 'at'],
};

function parseArgs(argv) {
  const args = { dir: null, checkPrivacy: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') {
      args.dir = argv[++i];
      if (!args.dir) {
        console.error('--dir needs a folder');
        process.exit(2);
      }
    } else if (arg === '--check-privacy') {
      args.checkPrivacy = true;
    } else {
      console.error(`unknown argument: ${arg}`);
      console.error('usage: node scripts/dump-pitwall-windows.mjs [--dir <globalStorage>] [--check-privacy]');
      process.exit(2);
    }
  }
  return args;
}

/** The editors' user-data folders for this OS, Cursor first. */
function defaultDirs() {
  const home = os.homedir();
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return ['Cursor', 'Code'].map((app) => path.join(base, app, 'User', 'globalStorage', EXTENSION_ID));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function list(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

const problems = [];
let checked = 0;

/** Record a problem when `data` has a key outside `type`'s allow-list. */
function checkKeys(file, type, data) {
  checked++;
  if (data === undefined) {
    return; // Unreadable or half-written (.tmp): it holds nothing Pitwall can read either.
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    problems.push(`${file}: not a JSON object`);
    return;
  }
  const extra = Object.keys(data).filter((key) => !ALLOWED[type].includes(key));
  if (extra.length > 0) {
    problems.push(`${file}: keys outside the ${type} allow-list: ${extra.join(', ')}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const dir = args.dir ?? defaultDirs().find((candidate) => fs.existsSync(candidate)) ?? defaultDirs()[0];
if (!fs.existsSync(dir)) {
  console.error(`no such folder: ${dir}`);
  process.exit(2);
}
console.log(`global storage: ${dir}`);
const now = Date.now();

// Window records.
const windowsDir = path.join(dir, 'pitwall-windows');
console.log('windows:');
let windowCount = 0;
for (const name of list(windowsDir)) {
  const file = path.join(windowsDir, name);
  const record = /^\d+\.json(\.tmp)?$/.test(name) ? readJson(file) : undefined;
  if (args.checkPrivacy) {
    if (/^\d+\.json(\.tmp)?$/.test(name)) checkKeys(file, 'window', record);
    else problems.push(`${file}: not a Pitwall window file`);
  }
  if (!/^\d+\.json$/.test(name) || !record) {
    continue;
  }
  windowCount++;
  const age = Math.round((now - record.beatAt) / 1000);
  const state = !isAlive(record.pid) ? ' dead' : now - record.beatAt >= STALE_MS ? ' stale' : '';
  const open = Array.isArray(record.openSessionIds) ? record.openSessionIds.length : 0;
  console.log(`  ${record.pid} ${record.folder ?? '(no folder)'} ${age}s open=${open}${state}`);
}
if (windowCount === 0) console.log('  (none)');

// Handoff requests.
const handoffDir = path.join(dir, 'pitwall-handoff');
console.log('requests:');
let requestCount = 0;
for (const key of list(handoffDir)) {
  const folderDir = path.join(handoffDir, key);
  if (!fs.statSync(folderDir).isDirectory()) {
    if (args.checkPrivacy) problems.push(`${folderDir}: not a folder inbox`);
    continue;
  }
  const names = list(folderDir);
  for (const name of names) {
    const file = path.join(folderDir, name);
    const match = /^([0-9a-f-]{36})\.(json|claimed-(\d+)|expired|done-(\d+)|lock)(\.tmp)?$/i.exec(name);
    if (!match) {
      if (args.checkPrivacy) problems.push(`${file}: not a Pitwall handoff file`);
      continue;
    }
    const [, nonce, suffix, claimer, doneBy, tmp] = match;
    if (suffix === 'lock') {
      if (args.checkPrivacy) {
        checked++;
        if (fs.statSync(file).size > 0) problems.push(`${file}: a lock file must be empty`);
      }
      continue;
    }
    const data = readJson(file);
    if (args.checkPrivacy) checkKeys(file, doneBy ? 'outcome' : 'request', data);
    if (tmp || doneBy || !data) {
      continue;
    }
    requestCount++;
    const state = suffix === 'json' ? 'pending' : suffix === 'expired' ? 'expired' : `claimed by ${claimer}`;
    const age = typeof data.at === 'number' ? `${Math.round((now - data.at) / 1000)}s` : '?';
    const ids = Array.isArray(data.sessionIds) ? data.sessionIds.map((id) => String(id).slice(0, 8)).join(',') : '';
    const done = names.find((other) => other.startsWith(`${nonce}.done-`) && !other.endsWith('.tmp'));
    const outcome = done ? readJson(path.join(folderDir, done)) : undefined;
    const result = outcome ? (outcome.ok ? ' -> ok' : ` -> failed: ${outcome.error ?? '?'}`) : '';
    console.log(`  ${state} ${nonce.slice(0, 8)} ${data.kind} [${ids}] ${data.folder} age=${age}${result}`);
  }
}
if (requestCount === 0) console.log('  (none)');

// The cross-window clipboard (Phase 4 Task 6), when it exists.
const clipboard = path.join(dir, 'pitwall-clipboard.json');
if (args.checkPrivacy && fs.existsSync(clipboard)) {
  checkKeys(clipboard, 'clipboard', readJson(clipboard));
}

if (args.checkPrivacy) {
  for (const problem of problems) console.log(`PRIVACY ${problem}`);
  console.log(problems.length === 0 ? `privacy ok: ${checked} files checked` : `privacy FAIL: ${problems.length} problems`);
  process.exit(problems.length === 0 ? 0 : 1);
}
