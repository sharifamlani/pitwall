#!/usr/bin/env node
/**
 * Ground-truth diff for Phase 5 (smoke S7, criteria E2 and E3): the
 * transitions `scripts/watch-sessions.mjs` recorded from ~/.claude/sessions
 * against the `[Pitwall] status <id8> <from>→<to> lag=<ms>` lines Pitwall
 * logged, and optionally against each window's state dump. It imports
 * nothing from src/, so it is an independent check.
 *
 * Usage:
 *   node scripts/compare-status.mjs --truth <truth.jsonl> --log <Pitwall Operations log>
 *                                   [--opened-from <log> [<log> ...]] [--dump <pitwall-dump folder>]
 *                                   [--max-lag <ms>] [--sessions <id8,id8,...>]
 *
 * The mapping (plan §5, QA C7). The recording starts with every session idle
 * and seen. Per session, in time order:
 *   recorder busy                         → working
 *   recorder waiting                      → needs
 *   recorder idle, a busy since the last open → finished
 *   recorder idle, no busy since then     → idle
 *   recorder gone (the process exited)    → idle from working or needs; otherwise unchanged
 *   an "opened" log line                  → finished becomes idle; the "busy since" mark resets
 * An opened line is `[Pitwall] route <id8> …`, `[Pitwall] popup click <id8>` or
 * `[Pitwall] popup click <id8> outside`, read from --log and from every
 * --opened-from log: the route or click line is logged only in the window the
 * user clicked, but every window then logs finished→idle, so checking a window
 * that did not click needs the clicking window's log too (pass all of them).
 * Status lines are read from --log only. Each change of the mapped status is
 * one expected transition. Log lines dated before the recording's first
 * sample are ignored. --sessions limits the check to those id8s (default:
 * every id8 in the recording).
 *
 * A brand-new chat is listed only once its first turn has started: when the
 * recording's first idle→working→needs spans at most one attention tick (4 s)
 * and Pitwall's first line is idle→needs, that line matches both and a NOTE
 * says so; it is not a problem.
 *
 * --dump compares each window's `statuses` (from `pitwall.dev.dumpState`,
 * taken after the walk) with the final mapped status of every session.
 * --max-lag fails any matched status line whose lag is over it (E3: 2000).
 *
 * Prints one line per session (`<id8> expected=<n> logged=<m> ok|FAIL`) and
 * one per problem, then a summary with the lag p95 and max. Exit 0 when every
 * expected transition is logged once, in order, with nothing extra; 1 on a
 * missing, extra or mismatched transition, a dump mismatch or a lag over the
 * limit; 2 on bad arguments or unreadable input.
 */
import fs from 'node:fs';
import path from 'node:path';

function fail(code, message) {
  process.stderr.write(`compare-status: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { truth: null, log: null, openedFrom: [], dump: null, maxLag: null, sessions: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) fail(2, `${arg} needs a value`);
      return next;
    };
    if (arg === '--truth') args.truth = value();
    else if (arg === '--log') args.log = value();
    else if (arg === '--opened-from') {
      const logs = [];
      while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) logs.push(argv[++i]);
      if (logs.length === 0) fail(2, '--opened-from needs at least one log');
      args.openedFrom.push(...logs);
    }
    else if (arg === '--dump') args.dump = value();
    else if (arg === '--max-lag') args.maxLag = Number(value());
    else if (arg === '--sessions') args.sessions = new Set(value().split(',').filter(Boolean));
    else fail(2, `unknown argument: ${arg}`);
  }
  if (!args.truth || !args.log) {
    fail(2, 'usage: --truth <truth.jsonl> --log <ops.log> [--opened-from <log> ...] [--dump <dir>] [--max-lag <ms>] [--sessions <id8,...>]');
  }
  if (args.maxLag !== null && !(args.maxLag >= 0)) fail(2, '--max-lag must be a number of ms');
  return args;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    fail(2, `cannot read ${file}: ${error.message}`);
  }
}

const args = parseArgs(process.argv.slice(2));

// The recorder's samples, in time order.
const truth = readText(args.truth)
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      fail(2, `${args.truth}:${index + 1} is not JSON`);
    }
  })
  .filter((entry) => typeof entry.t === 'number' && typeof entry.sid8 === 'string')
  .sort((a, b) => a.t - b.t);
if (truth.length === 0) fail(2, `${args.truth} has no samples`);
const start = truth[0].t;
const sessions = [...new Set(truth.map((entry) => entry.sid8))].filter((sid8) => !args.sessions || args.sessions.has(sid8));

// The Operations log: `[<ISO time>] <message>`.
const LINE = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\] (.*)$/;
const STATUS = /^\[Pitwall\] status ([0-9A-Za-z-]{1,8}) (needs|working|finished|idle)→(needs|working|finished|idle) lag=(\d+)$/;
const OPENED = /^\[Pitwall\] (?:route ([0-9A-Za-z-]{1,8}) |popup click ([0-9A-Za-z-]{1,8})(?: outside)?$)/;
const logged = new Map(sessions.map((sid8) => [sid8, []]));
const opened = new Map(sessions.map((sid8) => [sid8, new Set()]));
/** One log's dated lines from the recording's start on. */
function* datedLines(file) {
  for (const raw of readText(file).split(/\r?\n/)) {
    const line = LINE.exec(raw.trim());
    if (!line) continue;
    const t = Date.parse(line[1]);
    if (t >= start) yield { t, message: line[2] };
  }
}
for (const { t, message } of datedLines(args.log)) {
  const status = STATUS.exec(message);
  if (status && logged.has(status[1])) {
    logged.get(status[1]).push({ t, from: status[2], to: status[3], lag: Number(status[4]) });
  }
}
// Opened lines from every window's log; a file passed twice counts once.
for (const file of new Set([args.log, ...args.openedFrom].map((name) => path.resolve(name)))) {
  for (const { t, message } of datedLines(file)) {
    const open = OPENED.exec(message);
    const sid8 = open && (open[1] ?? open[2]);
    if (sid8 && opened.has(sid8)) opened.get(sid8).add(t);
  }
}

/** The expected transitions of one session, by the mapping above, and its final status. */
function expectedFor(sid8) {
  const events = [
    ...truth.filter((entry) => entry.sid8 === sid8).map((entry) => ({ t: entry.t, kind: 'sample', status: entry.status })),
    ...[...opened.get(sid8)].map((t) => ({ t, kind: 'opened' })),
  ].sort((a, b) => a.t - b.t || (a.kind === 'sample' ? -1 : 1));
  let state = 'idle';
  let busySinceOpened = false;
  const transitions = [];
  for (const event of events) {
    let next = state;
    if (event.kind === 'opened') {
      busySinceOpened = false;
      if (state === 'finished') next = 'idle';
    } else if (event.status === 'busy') {
      busySinceOpened = true;
      next = 'working';
    } else if (event.status === 'waiting') {
      next = 'needs';
    } else if (event.status === 'idle') {
      next = busySinceOpened ? 'finished' : 'idle';
    } else if (event.status === 'gone') {
      next = state === 'working' || state === 'needs' ? 'idle' : state;
    }
    if (next !== state) {
      transitions.push({ t: event.t, from: state, to: next });
      state = next;
    }
  }
  return { transitions, final: state };
}

/** The attention tick: a working phase shorter than this can fall between two looks. */
const TICK_MS = 4_000;

const problems = [];
const notes = [];
const lags = [];
const finals = new Map();
for (const sid8 of sessions) {
  const { transitions: recorded, final } = expectedFor(sid8);
  finals.set(sid8, final);
  const actual = logged.get(sid8);
  // A brand-new chat is listed once its first turn has started; when that
  // turn reaches its wait within a tick, Pitwall's first line is idle→needs.
  // That is a note, not a missing working.
  let expected = recorded;
  const [first, second] = recorded;
  if (
    first?.from === 'idle' && first.to === 'working' && second?.from === 'working' && second.to === 'needs' &&
    second.t - first.t <= TICK_MS && actual[0]?.from === 'idle' && actual[0].to === 'needs'
  ) {
    expected = [{ t: second.t, from: 'idle', to: 'needs' }, ...recorded.slice(2)];
    notes.push(`${sid8} #1: first turn shorter than a tick (${second.t - first.t} ms working), logged idle→needs for idle→working→needs`);
  }
  let ok = true;
  const count = Math.max(expected.length, actual.length);
  for (let i = 0; i < count; i++) {
    const want = expected[i];
    const got = actual[i];
    if (!got) {
      problems.push(`${sid8} missing #${i + 1}: ${want.from}→${want.to} (recorded at ${new Date(want.t).toISOString()})`);
      ok = false;
    } else if (!want) {
      problems.push(`${sid8} extra #${i + 1}: ${got.from}→${got.to} (logged at ${new Date(got.t).toISOString()})`);
      ok = false;
    } else if (want.from !== got.from || want.to !== got.to) {
      problems.push(`${sid8} mismatch #${i + 1}: expected ${want.from}→${want.to}, logged ${got.from}→${got.to}`);
      ok = false;
    } else {
      lags.push(got.lag);
      if (args.maxLag !== null && got.lag > args.maxLag) {
        problems.push(`${sid8} lag #${i + 1}: ${got.from}→${got.to} lag=${got.lag} > ${args.maxLag}`);
        ok = false;
      }
    }
  }
  console.log(`${sid8} expected=${expected.length} logged=${actual.length} ${ok ? 'ok' : 'FAIL'}`);
}

// Each window's dump: its statuses must equal the final mapped statuses.
if (args.dump) {
  let names;
  try {
    names = fs.readdirSync(args.dump).filter((name) => /^\d+\.json$/.test(name));
  } catch (error) {
    fail(2, `cannot read ${args.dump}: ${error.message}`);
  }
  for (const name of names) {
    let dump;
    try {
      dump = JSON.parse(fs.readFileSync(path.join(args.dump, name), 'utf8'));
    } catch {
      problems.push(`dump ${name}: unreadable`);
      continue;
    }
    const statuses = dump && typeof dump.statuses === 'object' && dump.statuses ? dump.statuses : {};
    for (const sid8 of sessions) {
      const entry = Object.entries(statuses).find(([sessionId]) => sessionId.startsWith(sid8));
      const shown = entry ? entry[1] : 'unlisted';
      if (shown !== finals.get(sid8)) {
        problems.push(`dump ${name}: ${sid8} shows ${shown}, expected ${finals.get(sid8)}`);
      }
    }
    console.log(`dump ${name}: ${sessions.length} sessions checked`);
  }
}

for (const note of notes) console.log(`NOTE ${note}`);
for (const problem of problems) console.log(`PROBLEM ${problem}`);
const sorted = [...lags].sort((a, b) => a - b);
const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : 0;
console.log(
  `${problems.length === 0 ? 'compare ok' : `compare FAIL: ${problems.length} problems`}; ` +
    `${lags.length} transitions matched; lag p95=${p95} max=${sorted.at(-1) ?? 0}`
);
process.exit(problems.length === 0 ? 0 : 1);
