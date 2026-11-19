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
 *                                   [--dump <pitwall-dump folder>] [--max-lag <ms>] [--sessions <id8,id8,...>]
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
 * `[Pitwall] popup click <id8> outside`. Each change of the mapped status is
 * one expected transition. Log lines dated before the recording's first
 * sample are ignored. --sessions limits the check to those id8s (default:
 * every id8 in the recording).
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
  const args = { truth: null, log: null, dump: null, maxLag: null, sessions: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) fail(2, `${arg} needs a value`);
      return next;
    };
    if (arg === '--truth') args.truth = value();
    else if (arg === '--log') args.log = value();
    else if (arg === '--dump') args.dump = value();
    else if (arg === '--max-lag') args.maxLag = Number(value());
    else if (arg === '--sessions') args.sessions = new Set(value().split(',').filter(Boolean));
    else fail(2, `unknown argument: ${arg}`);
  }
  if (!args.truth || !args.log) fail(2, 'usage: --truth <truth.jsonl> --log <ops.log> [--dump <dir>] [--max-lag <ms>] [--sessions <id8,...>]');
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
const opened = new Map(sessions.map((sid8) => [sid8, []]));
for (const raw of readText(args.log).split(/\r?\n/)) {
  const line = LINE.exec(raw.trim());
  if (!line) continue;
  const t = Date.parse(line[1]);
  if (!(t >= start)) continue;
  const status = STATUS.exec(line[2]);
  if (status && logged.has(status[1])) {
    logged.get(status[1]).push({ t, from: status[2], to: status[3], lag: Number(status[4]) });
    continue;
  }
  const open = OPENED.exec(line[2]);
  const sid8 = open && (open[1] ?? open[2]);
  if (sid8 && opened.has(sid8)) opened.get(sid8).push(t);
}

/** The expected transitions of one session, by the mapping above, and its final status. */
function expectedFor(sid8) {
  const events = [
    ...truth.filter((entry) => entry.sid8 === sid8).map((entry) => ({ t: entry.t, kind: 'sample', status: entry.status })),
    ...opened.get(sid8).map((t) => ({ t, kind: 'opened' })),
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

const problems = [];
const lags = [];
const finals = new Map();
for (const sid8 of sessions) {
  const { transitions: expected, final } = expectedFor(sid8);
  finals.set(sid8, final);
  const actual = logged.get(sid8);
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

for (const problem of problems) console.log(`PROBLEM ${problem}`);
const sorted = [...lags].sort((a, b) => a - b);
const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : 0;
console.log(
  `${problems.length === 0 ? 'compare ok' : `compare FAIL: ${problems.length} problems`}; ` +
    `${lags.length} transitions matched; lag p95=${p95} max=${sorted.at(-1) ?? 0}`
);
process.exit(problems.length === 0 ? 0 : 1);
