#!/usr/bin/env node
/**
 * Read-only probe of Claude Code's live sessions folder (ADR 0018), applying
 * the same rules as src/harnesses/claude/ClaudeSessionsFile.ts.
 *
 * Usage:
 *   node scripts/probe-claude-sessions.mjs [--dir <sessions folder>]
 *
 * Default folder: $CLAUDE_CONFIG_DIR/sessions, else ~/.claude/sessions.
 *
 * Prints one line per file:
 *   <sessionId> <status> <pid> <statusUpdatedAt>     a live file on this machine
 *   <sessionId> dropped (pid not alive)               a crashed or exited session
 *   <sessionId> skipped (unknown status)              falls back to `claude agents`
 *   <file> skipped (other pidDomain)                  a pid this machine cannot check
 *   <file> skipped (unreadable)                       malformed or mid-write
 *
 * Privacy: only `*.json` files are opened. The `.key` files beside them are
 * never opened, read or stat-ed, and no field other than sessionId, pid,
 * status and statusUpdatedAt is printed. Exits 1 when the folder is missing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIVE_STATUSES = new Set(['busy', 'waiting', 'idle']);

function parseArgs(argv) {
  const args = { dir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') {
      args.dir = argv[++i];
    } else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return args;
}

/** Mirrors localPidDomain() in ClaudeSessionsFile.ts. */
function localPidDomain() {
  if (process.platform === 'win32') {
    return `win32:${os.hostname().toLowerCase()}`;
  }
  if (process.platform !== 'linux') {
    return process.platform;
  }
  let machineId = '';
  let pidNamespace = '';
  try {
    machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim();
  } catch {}
  try {
    pidNamespace = fs.readlinkSync('/proc/self/ns/pid');
  } catch {}
  return `linux:${machineId}:${pidNamespace}`;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

const { dir: dirArg } = parseArgs(process.argv.slice(2));
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const dir = path.resolve(dirArg ?? path.join(configDir, 'sessions'));

let names;
try {
  names = fs.readdirSync(dir);
} catch {
  console.log(`sessions folder: ${dir}`);
  console.log('missing: Pitwall falls back to `claude agents --json` for every session');
  process.exit(1);
}

const domain = localPidDomain();
const files = names.filter((name) => name.endsWith('.json')).sort();
const counts = { live: 0, dropped: 0, unknown: 0, foreign: 0, unreadable: 0 };
console.log(`sessions folder: ${dir}`);
console.log(`observedAt: ${Date.now()}`);
console.log('sessionId status pid statusUpdatedAt');

for (const name of files) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  } catch {
    record = null;
  }
  const valid =
    record &&
    typeof record === 'object' &&
    !Array.isArray(record) &&
    typeof record.sessionId === 'string' &&
    record.sessionId &&
    Number.isInteger(record.pid) &&
    record.pid > 1;
  if (!valid) {
    counts.unreadable++;
    console.log(`${name} skipped (unreadable)`);
    continue;
  }
  if (record.pidDomain !== domain) {
    counts.foreign++;
    console.log(`${name} skipped (other pidDomain)`);
    continue;
  }
  if (!isPidAlive(record.pid)) {
    counts.dropped++;
    console.log(`${record.sessionId} dropped (pid not alive)`);
    continue;
  }
  if (typeof record.status !== 'string' || !LIVE_STATUSES.has(record.status)) {
    counts.unknown++;
    console.log(`${record.sessionId} skipped (unknown status)`);
    continue;
  }
  counts.live++;
  const updated = typeof record.statusUpdatedAt === 'number' ? record.statusUpdatedAt : 0;
  console.log(`${record.sessionId} ${record.status} ${record.pid} ${updated}`);
}

console.log(
  `summary: ${counts.live} live, ${counts.dropped} dropped, ${counts.unknown} unknown status, ` +
    `${counts.foreign} other pidDomain, ${counts.unreadable} unreadable; ` +
    `available: ${counts.live > 0}`
);
