#!/usr/bin/env node
/**
 * E16 startup bench, outside the default suite (timing depends on the
 * machine):
 *
 *   node --test test/bench/first-render-bench.js
 *
 * Bundles first-render-bench.entry.ts with the dry-test `vscode` stub, builds
 * a profile of 17 repos and 129 Claude chats with realistic transcripts in a
 * temp folder, activates the extension over it three times (a reload: repos
 * and chats already stored) and reports the median of each measure. It
 * asserts E16: the Repos list answers its first request within 1 s of
 * activation.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const STUB = path.resolve(__dirname, '..', 'dry', 'vscode-stub.js');
const RUNS = Number(process.env.PITWALL_BENCH_RUNS || 3);
const E16_LIMIT_MS = 1_000;

test('the Repos list renders within 1 s of activation with 17 repos and 129 chats (E16)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-e16-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Never read the developer's Claude profile.
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
  const outfile = path.join(dir, 'first-render-bench.cjs');
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'first-render-bench.entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    alias: { vscode: STUB },
    logLevel: 'error',
  });
  const { buildFixture, runOnce } = require(outfile);
  const fixture = buildFixture(dir);
  const megabytes = fixture.transcripts.reduce((sum, t) => sum + t.bytes, 0) / 1e6;
  console.log(
    `[bench] ${fixture.repos.length} repos, ${fixture.transcripts.length} transcripts, ${megabytes.toFixed(0)} MB (mean ${(megabytes / fixture.transcripts.length).toFixed(2)} MB)`
  );

  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const run = await runOnce(fixture);
    runs.push(run);
    console.log(
      `[bench] run ${i + 1}: activate ${run.activateMs.toFixed(0)} ms, first render ${run.firstRenderMs.toFixed(0)} ms (${run.firstRenderRows} rows), longest block ${run.maxBlockMs.toFixed(0)} ms, first scan ${run.scanMs.toFixed(0)} ms`
    );
  }
  const median = (key) => [...runs.map((run) => run[key])].sort((a, b) => a - b)[Math.floor(runs.length / 2)];
  const summary = {
    activateMs: median('activateMs'),
    firstRenderMs: median('firstRenderMs'),
    maxBlockMs: median('maxBlockMs'),
    scanMs: median('scanMs'),
  };
  console.log(
    `[bench] median of ${RUNS}: activate ${summary.activateMs.toFixed(0)} ms, first render ${summary.firstRenderMs.toFixed(0)} ms, longest block ${summary.maxBlockMs.toFixed(0)} ms, first scan ${summary.scanMs.toFixed(0)} ms`
  );
  assert.ok(runs.every((run) => run.firstRenderRows === fixture.repos.length), 'the first render shows every stored repo');
  assert.ok(summary.firstRenderMs <= E16_LIMIT_MS, `first render ${summary.firstRenderMs.toFixed(0)} ms > ${E16_LIMIT_MS} ms`);
  // Timers left by the extension's services must not keep the bench alive.
  setImmediate(() => process.exit(process.exitCode ?? 0));
});
