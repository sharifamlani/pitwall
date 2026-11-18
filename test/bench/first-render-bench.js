#!/usr/bin/env node
/**
 * E16 startup bench, outside the default suite (timing depends on the
 * machine):
 *
 *   node --test test/bench/first-render-bench.js
 *
 * Bundles first-render-bench.entry.ts with the dry-test `vscode` stub, builds
 * a profile of 17 stored repos and 129 Claude chats with realistic
 * transcripts in a temp folder, plus 3 repos only discovery finds and a
 * dismissed folder with 2 long (16 MB) sessions, and three times activates
 * the extension over it twice: a first start with repos and chats already
 * stored (as after an upgrade), then a reload over the state that start
 * left. It reports the median of each measure per kind and asserts E16 for
 * both: the Repos list answers its first request within 1 s of activation.
 *
 * A second test times discovery alone, cold and warm, and asserts it never
 * blocks the extension host for more than 50 ms at a time.
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
const BLOCK_LIMIT_MS = 50;

/** The bench module, bundled once per process over a fixture built once. */
let built;
function bench(t) {
  if (built) return built;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-e16-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
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
  const mod = require(outfile);
  const fixture = mod.buildFixture(dir);
  const megabytes = fixture.transcripts.reduce((sum, t) => sum + t.bytes, 0) / 1e6;
  console.log(
    `[bench] ${fixture.repos.length} stored repos, ${fixture.transcripts.length} transcripts, ${megabytes.toFixed(0)} MB (mean ${(megabytes / fixture.transcripts.length).toFixed(2)} MB); ` +
      `${fixture.discoverable.length} repos to discover (${fixture.discoverableTranscripts.length} transcripts), 1 dismissed folder with 2 x 16 MB`
  );
  built = { ...mod, fixture };
  return built;
}

test('discovery never blocks the extension host for more than 50 ms at a time (E16, discovery on)', async (t) => {
  const { discoveryPass, fixture } = bench(t);
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const run = await discoveryPass(fixture);
    runs.push(run);
    console.log(
      `[bench] discovery run ${i + 1}: ${run.folders} folders; cold ${run.cold.ms.toFixed(0)} ms (longest block ${run.cold.maxBlockMs.toFixed(0)} ms), warm ${run.warm.ms.toFixed(0)} ms (longest block ${run.warm.maxBlockMs.toFixed(0)} ms)`
    );
  }
  const median = (pick) => runs.map(pick).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
  console.log(
    `[bench] median of ${RUNS}, discovery: cold ${median((r) => r.cold.ms).toFixed(0)} ms (longest block ${median((r) => r.cold.maxBlockMs).toFixed(0)} ms), warm ${median((r) => r.warm.ms).toFixed(0)} ms (longest block ${median((r) => r.warm.maxBlockMs).toFixed(0)} ms)`
  );
  const longest = Math.max(...runs.flatMap((r) => [r.cold.maxBlockMs, r.warm.maxBlockMs]));
  assert.ok(longest <= BLOCK_LIMIT_MS, `discovery blocked the host for ${longest.toFixed(0)} ms at once`);
});

test('the Repos list renders within 1 s of activation with 17 repos and 129 chats (E16)', async (t) => {
  const { fixture, runOnce, storedRepos } = bench(t);

  // Each run: the first start over stored repos and chats only (as after an
  // upgrade), then a reload over the state that start left.
  const runs = { 'first start': [], reload: [] };
  const line = (run) =>
    `activate ${run.activateMs.toFixed(0)} ms, first render ${run.firstRenderMs.toFixed(0)} ms (${run.firstRenderRows} rows), longest block ${run.maxBlockMs.toFixed(0)} ms, first scan ${run.scanMs.toFixed(0)} ms, discovery ${run.discoveryMs.toFixed(0)} ms`;
  for (let i = 0; i < RUNS; i++) {
    const first = await runOnce(fixture, await storedRepos(fixture));
    const reload = await runOnce(fixture, first.state);
    runs['first start'].push(first);
    runs.reload.push(reload);
    console.log(`[bench] run ${i + 1} first start: ${line(first)}`);
    console.log(`[bench] run ${i + 1} reload:      ${line(reload)}`);
  }
  for (const [kind, list] of Object.entries(runs)) {
    const median = (key) => [...list.map((run) => run[key])].sort((a, b) => a - b)[Math.floor(list.length / 2)];
    const summary = {
      activateMs: median('activateMs'),
      firstRenderMs: median('firstRenderMs'),
      firstRenderRows: median('firstRenderRows'),
      maxBlockMs: median('maxBlockMs'),
      scanMs: median('scanMs'),
      discoveryMs: median('discoveryMs'),
    };
    console.log(`[bench] median of ${RUNS}, ${kind}: ${line(summary)}`);
    // A reload also shows the repos the first start discovered.
    const rows = kind === 'reload' ? fixture.repos.length + fixture.discoverable.length : fixture.repos.length;
    assert.ok(list.every((run) => run.firstRenderRows === rows), `${kind}: the first render shows every stored repo`);
    assert.ok(summary.firstRenderMs <= E16_LIMIT_MS, `${kind}: first render ${summary.firstRenderMs.toFixed(0)} ms > ${E16_LIMIT_MS} ms`);
  }
  // Timers left by the extension's services must not keep the bench alive.
  setImmediate(() => process.exit(process.exitCode ?? 0));
});
