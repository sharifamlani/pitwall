#!/usr/bin/env node
/**
 * First-scan bench at the owner's scale, outside the default suite (it writes
 * about 2 GB and its timing depends on the machine):
 *
 *   node --test test/bench/scan-bench.js
 *
 * Generates a Claude profile of 21 repositories and 200 sessions (three
 * transcripts of 700, 400 and 300 MB, the rest 0.1-80 MB; about 2 GB), shaped
 * like Claude Code's transcripts: prompts, tool calls with large results,
 * replies, titles. Then it runs the import scan's listing (every repository
 * at once, through ClaudeSessionService) as a window's first scan and again
 * as its next, and prints wall time, main-thread CPU and how long the event
 * loop was held, which is how late a status poll would run meanwhile.
 *
 * PITWALL_BENCH_DIR=<dir> keeps the fixture there and reuses it on the next
 * run (it is regenerated when missing). Otherwise it goes to a temp folder
 * that is removed afterwards.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const STUB = path.resolve(__dirname, '..', 'dry', 'vscode-stub.js');
const REPOS = 21;
const SESSIONS = 200;
const BIG_MB = [700, 400, 300];
/** The first scan must never hold the event loop longer than this at once. */
const MAX_LOOP_DELAY_MS = 100;
/** A status poll's file reads during the first scan must finish within this (the PR #76 gate: polls < 500 ms). */
const MAX_POLL_MS = 250;
/** Nor take longer than this, or burn more main-thread CPU than this. */
const FIRST_SCAN_MS = 8_000;
const FIRST_SCAN_CPU_MS = 8_000;

/** A seeded generator, so every run writes the same fixture. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const CODE = Array.from({ length: 400 }, (_, i) => `  const value${i} = compute("${'x'.repeat(i % 40)}", { index: ${i}, label: 'line ${i}' }); // "quoted" \\ path\\to\\file`).join('\n');

/** One session's transcript, written line by line until it reaches `bytes`. */
async function writeTranscript(file, { sessionId, cwd, bytes, random, titled, summary }) {
  const out = fs.createWriteStream(file);
  let written = 0;
  let t = Date.UTC(2026, 10, 1) + Math.floor(random() * 1e9);
  let uuid = 0;
  const base = () => ({ parentUuid: `u-${uuid}`, isSidechain: false, userType: 'external', cwd, sessionId, version: '2.1.296', gitBranch: 'main', entrypoint: 'claude-vscode', uuid: `u-${++uuid}`, timestamp: new Date((t += 1500)).toISOString() });
  const write = async (entry) => {
    const line = `${JSON.stringify(entry)}\n`;
    written += Buffer.byteLength(line);
    if (!out.write(line)) {
      await new Promise((resolve) => out.once('drain', resolve));
    }
  };
  let turn = 0;
  while (written < bytes) {
    turn++;
    await write({ ...base(), type: 'user', message: { role: 'user', content: `Please look at module ${turn} and fix the failing test "${turn}". It says: expected 3, got 4.` } });
    const tools = 2 + Math.floor(random() * (bytes > 1e8 ? 12 : 4));
    for (let i = 0; i < tools && written < bytes; i++) {
      const id = `toolu_${turn}_${i}`;
      await write({ ...base(), type: 'assistant', message: { id: `msg_${turn}_${i}`, role: 'assistant', model: 'claude', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `${cwd}\\src\\module${i}.ts` } }], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 20 } } });
      const size = 2_000 + Math.floor(random() * (bytes > 1e8 ? 120_000 : 30_000));
      const text = CODE.slice(0, size);
      await write({ ...base(), type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: text }] }, toolUseResult: { type: 'text', file: { filePath: `${cwd}\\src\\module${i}.ts`, content: text, numLines: 400 } } });
    }
    await write({ ...base(), type: 'assistant', message: { id: `msg_${turn}_end`, role: 'assistant', model: 'claude', content: [{ type: 'text', text: `Fixed module ${turn}: the off-by-one in the loop.` }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } } });
    await write({ type: 'system', subtype: 'turn_duration', durationMs: 4000, timestamp: new Date((t += 10)).toISOString(), sessionId, cwd });
    if (turn === 2) {
      await write({ type: 'ai-title', aiTitle: `Fix module tests ${sessionId.slice(0, 4)}`, sessionId });
    }
    if (titled && turn === 5) {
      await write({ type: 'custom-title', customTitle: `Renamed ${sessionId.slice(0, 4)}`, sessionId });
    }
    if (summary && turn === 7) {
      await write({ type: 'summary', summary: `Summary ${sessionId.slice(0, 4)}`, leafUuid: `u-${uuid}` });
    }
  }
  await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  return written;
}

/** The fixture profile; returns the repository paths the scan lists. */
async function makeFixture(dir) {
  const repos = Array.from({ length: REPOS }, (_, i) => path.join(dir, 'work', `repo-${String(i + 1).padStart(2, '0')}`));
  const marker = path.join(dir, 'fixture.json');
  if (fs.existsSync(marker)) {
    return JSON.parse(fs.readFileSync(marker, 'utf8')).repos;
  }
  const random = rng(76);
  let total = 0;
  for (let n = 0; n < SESSIONS; n++) {
    const repo = repos[n % REPOS];
    fs.mkdirSync(repo, { recursive: true });
    const project = path.join(dir, 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(project, { recursive: true });
    const sessionId = `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const bytes = n < BIG_MB.length ? BIG_MB[n] * 1e6 : n % 20 === 0 ? 20e6 + random() * 60e6 : 1e5 + random() * 6e6;
    total += await writeTranscript(path.join(project, `${sessionId}.jsonl`), { sessionId, cwd: repo, bytes, random, titled: n % 3 === 0, summary: n % 7 === 0 });
  }
  fs.writeFileSync(marker, JSON.stringify({ repos, total }));
  console.log(`[bench] fixture: ${REPOS} repos, ${SESSIONS} sessions, ${(total / 1e6).toFixed(0)} MB`);
  return repos;
}

test('a window\'s first import scan at the owner\'s scale stays cheap and never holds the event loop', { timeout: 30 * 60_000 }, async (t) => {
  const keep = process.env.PITWALL_BENCH_DIR;
  const dir = keep ? path.resolve(keep) : fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-scan-bench-'));
  if (!keep) {
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  }
  fs.mkdirSync(dir, { recursive: true });
  const repos = await makeFixture(dir);
  process.env.CLAUDE_CONFIG_DIR = dir;
  const outfile = path.join(os.tmpdir(), `pitwall-scan-bench-${process.pid}.cjs`);
  t.after(() => fs.rmSync(outfile, { force: true }));
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'scan-bench.entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    alias: { vscode: STUB },
    logLevel: 'error',
  });
  const { scanPass, newService } = require(outfile);
  const service = newService();
  // A small transcript stands in for a live chat the status poll reads meanwhile.
  const project = path.join(dir, 'projects', repos[REPOS - 1].replace(/[^A-Za-z0-9]/g, '-'));
  const liveTranscript = fs.readdirSync(project).map((name) => path.join(project, name)).sort((a, b) => fs.statSync(a).size - fs.statSync(b).size)[0];
  const show = (label, pass) =>
    console.log(
      `[bench] ${label}: ${pass.sessions} sessions, ${(pass.ms / 1000).toFixed(2)} s, CPU ${(pass.cpuMs / 1000).toFixed(2)} s, ` +
        `event loop held max ${pass.maxLoopDelayMs.toFixed(0)} ms (p99 ${pass.p99LoopDelayMs.toFixed(0)} ms), 100 ms timer late by ${pass.maxTimerLateMs.toFixed(0)} ms, ` +
        `slowest of ${pass.polls} status-poll reads ${pass.maxPollMs.toFixed(0)} ms`
    );
  const first = await scanPass(service, repos, liveTranscript);
  show('first scan', first);
  const second = await scanPass(service, repos, liveTranscript);
  show('next scan', second);
  assert.equal(first.sessions, SESSIONS);
  assert.ok(first.maxPollMs <= MAX_POLL_MS, `a status poll's reads took ${first.maxPollMs.toFixed(0)} ms during the first scan`);
  assert.ok(first.maxLoopDelayMs <= MAX_LOOP_DELAY_MS, `the first scan held the event loop ${first.maxLoopDelayMs.toFixed(0)} ms at once`);
  assert.ok(first.ms <= FIRST_SCAN_MS, `the first scan took ${first.ms.toFixed(0)} ms`);
  assert.ok(first.cpuMs <= FIRST_SCAN_CPU_MS, `the first scan used ${first.cpuMs.toFixed(0)} ms of CPU`);
  assert.ok(second.ms <= 2_000, `the next scan took ${second.ms.toFixed(0)} ms`);
});
