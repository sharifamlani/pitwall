#!/usr/bin/env node
/**
 * Ground-truth recorder for Phase 5 (smokes S2 and S7, criteria E2 and E3):
 * samples Claude Code's live sessions folder every 100 ms and writes one JSON
 * line each time a session's status, waiting reason or status stamp changes.
 *
 * Usage:
 *   node scripts/watch-sessions.mjs [--out <file.jsonl>] [--dir <sessions folder>]
 *                                   [--interval <ms>] [--duration <ms>]
 *
 * Default folder: $CLAUDE_CONFIG_DIR/sessions, else ~/.claude/sessions.
 * Without --out, lines go to stdout. Without --duration it runs until Ctrl+C.
 *
 * Each line: {"t":<ms>,"sid8":"<first 8 of sessionId>","status":"busy|waiting|idle|gone",
 *             "waitingFor":<string|null>,"statusUpdatedAt":<ms|null>}
 *   t                when the sample that saw the change started
 *   status "gone"    the session's file disappeared, or its pid is no longer alive
 *   statusUpdatedAt  null when the file has no stamp (S2 records whether that happens)
 *
 * The same rules as src/harnesses/claude/ClaudeSessionsFile.ts: only live pids
 * of this machine's pidDomain count, a torn (unparsable) file keeps its last
 * state for that sample, and the newest statusUpdatedAt wins for a session
 * under two pids.
 *
 * Privacy: only `*.json` files are opened. The `.key` files beside them are
 * never opened, read or stat-ed. Only the five fields above are written; never
 * a cwd, a title or a full session ID. Exit 0 at the end of --duration or on
 * Ctrl+C; 2 on bad arguments.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIVE_STATUSES = new Set(['busy', 'waiting', 'idle']);

function parseArgs(argv) {
  const args = { out: null, dir: null, interval: 100, duration: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) {
        console.error(`${arg} needs a value`);
        process.exit(2);
      }
      return next;
    };
    if (arg === '--out') args.out = value();
    else if (arg === '--dir') args.dir = value();
    else if (arg === '--interval') args.interval = Number(value());
    else if (arg === '--duration') args.duration = Number(value());
    else {
      console.error(`unknown argument: ${arg}`);
      console.error('usage: node scripts/watch-sessions.mjs [--out <file.jsonl>] [--dir <sessions folder>] [--interval <ms>] [--duration <ms>]');
      process.exit(2);
    }
  }
  if (!(args.interval >= 10) || (args.duration !== null && !(args.duration >= 0))) {
    console.error('--interval must be >= 10 and --duration >= 0');
    process.exit(2);
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

const args = parseArgs(process.argv.slice(2));
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const dir = path.resolve(args.dir ?? path.join(configDir, 'sessions'));
const domain = localPidDomain();
const out = args.out ? fs.createWriteStream(args.out, { flags: 'a' }) : process.stdout;

/** Last written state per full session ID (kept in memory only). */
const last = new Map();
/** Last good parse per file, so a torn read keeps its state for one sample. */
const lastParsed = new Map();

function write(t, sessionId, state) {
  out.write(
    `${JSON.stringify({ t, sid8: sessionId.slice(0, 8), status: state.status, waitingFor: state.waitingFor, statusUpdatedAt: state.statusUpdatedAt })}\n`
  );
}

function sample() {
  const t = Date.now();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  const now = new Map();
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      lastParsed.set(name, record);
    } catch {
      record = lastParsed.get(name);
    }
    if (
      !record ||
      typeof record !== 'object' ||
      typeof record.sessionId !== 'string' ||
      !record.sessionId ||
      !Number.isInteger(record.pid) ||
      record.pid <= 1 ||
      record.pidDomain !== domain ||
      !isPidAlive(record.pid) ||
      !LIVE_STATUSES.has(record.status)
    ) {
      continue;
    }
    const stamp = typeof record.statusUpdatedAt === 'number' ? record.statusUpdatedAt : null;
    const existing = now.get(record.sessionId);
    if (existing && (existing.statusUpdatedAt ?? 0) >= (stamp ?? 0)) {
      continue;
    }
    const waitingFor =
      record.status === 'waiting' ? (typeof record.waitingFor === 'string' && record.waitingFor.trim()) || 'input needed' : null;
    now.set(record.sessionId, { status: record.status, waitingFor, statusUpdatedAt: stamp });
  }
  for (const name of [...lastParsed.keys()]) {
    if (!names.includes(name)) {
      lastParsed.delete(name);
    }
  }
  for (const [sessionId, state] of now) {
    const previous = last.get(sessionId);
    if (
      !previous ||
      previous.status !== state.status ||
      previous.waitingFor !== state.waitingFor ||
      previous.statusUpdatedAt !== state.statusUpdatedAt
    ) {
      write(t, sessionId, state);
      last.set(sessionId, state);
    }
  }
  for (const sessionId of [...last.keys()]) {
    if (!now.has(sessionId)) {
      write(t, sessionId, { status: 'gone', waitingFor: null, statusUpdatedAt: null });
      last.delete(sessionId);
    }
  }
}

const timer = setInterval(sample, args.interval);
sample();

function stop() {
  clearInterval(timer);
  if (out === process.stdout) {
    process.exit(0);
  }
  out.end(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (args.duration !== null) {
  setTimeout(stop, args.duration);
}
