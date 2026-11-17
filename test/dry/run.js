#!/usr/bin/env node
/**
 * Dry-test runner.
 *
 * Bundles every `*.test.ts` under test/dry (recursively) with esbuild, aliases the `vscode`
 * module to a stub, and runs the bundles with Node's built-in test runner. Each
 * file runs in its own process; tests within a file run in order. No extension
 * install and no extension host required.
 *
 * Usage:
 *   npm run test:dry             # run everything
 *   npm run test:dry -- claude   # run files whose name contains "claude"
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const esbuild = require('esbuild');

const TEST_DIR = __dirname;
const BUILD_DIR = path.join(TEST_DIR, '.build');
const STUB = path.join(TEST_DIR, 'vscode-stub.js');
const TIMEOUT_MS = Number(process.env.PITWALL_TEST_TIMEOUT_MS || 60_000);

const filter = process.argv[2];
/** Every `*.test.ts` under TEST_DIR, recursively, as paths relative to it (forward slashes). */
function collectTests(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return entry.name === '.build' || entry.name === 'fixtures' ? [] : collectTests(path.join(dir, entry.name), rel);
    }
    return entry.name.endsWith('.test.ts') ? [rel] : [];
  });
}

const testFiles = collectTests(TEST_DIR)
  .filter((file) => !filter || file.includes(filter))
  .sort();

if (testFiles.length === 0) {
  console.error(`No dry tests matched${filter ? ` "${filter}"` : ''}.`);
  process.exit(1);
}

fs.rmSync(BUILD_DIR, { recursive: true, force: true });
fs.mkdirSync(BUILD_DIR, { recursive: true });

let status = 0;
try {
  const bundles = testFiles.map((file) => {
    // Flat output: tests locate fixtures and the repo root relative to test/dry/.build.
    const outfile = path.join(BUILD_DIR, path.basename(file).replace(/\.ts$/, '.cjs'));
    esbuild.buildSync({
      entryPoints: [path.join(TEST_DIR, file)],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      outfile,
      alias: { vscode: STUB },
      sourcemap: 'inline',
      logLevel: 'error',
    });
    return outfile;
  });

  const result = spawnSync(
    process.execPath,
    [
      '--enable-source-maps',
      '--test',
      '--test-reporter=spec',
      `--test-timeout=${TIMEOUT_MS}`,
      ...bundles,
    ],
    { stdio: 'inherit', env: process.env }
  );
  status = result.status ?? 1;
} catch (error) {
  console.error(error.message || error);
  status = 1;
} finally {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}

process.exit(status);
