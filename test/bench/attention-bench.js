#!/usr/bin/env node
/**
 * E18 timing bench, outside the default suite (the suite asserts the poll
 * count; timing depends on the machine):
 *
 *   node --test test/bench/attention-bench.js
 *
 * Bundles attention-bench.entry.ts with the dry-test `vscode` stub, runs 100
 * attention ticks over 500 chats (5 open, 10 live in the sessions file) and
 * asserts the p95 tick time is at most 50 ms.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const STUB = path.resolve(__dirname, '..', 'dry', 'vscode-stub.js');
const P95_LIMIT_MS = 50;

test('the attention tick stays at p95 ≤ 50 ms over 100 ticks with 500 chats (E18)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-bench-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Never read the developer's Claude profile.
  process.env.CLAUDE_CONFIG_DIR = dir;
  const outfile = path.join(dir, 'attention-bench.cjs');
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'attention-bench.entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    alias: { vscode: STUB },
    logLevel: 'error',
  });
  const { runBench } = require(outfile);
  const { durationsMs, polledPerTick } = await runBench(500, 100);
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1];
  const p50 = sorted[Math.ceil(0.5 * sorted.length) - 1];
  console.log(`[bench] 500 chats, 100 ticks: p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${sorted.at(-1).toFixed(2)} ms, ${polledPerTick} sessions polled per tick`);
  assert.equal(polledPerTick, 15, 'open ∪ live only');
  assert.ok(p95 <= P95_LIMIT_MS, `p95 ${p95.toFixed(2)} ms > ${P95_LIMIT_MS} ms`);
});
