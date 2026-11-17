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
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const esbuild = require('esbuild');

const TEST_DIR = __dirname;
const BUILD_DIR = path.resolve(TEST_DIR, process.env.PITWALL_TEST_BUILD_DIR || '.build');
// Bundles find fixtures and the repo root relative to their own folder, so the build dir must be a child of test/dry/.
if (path.dirname(BUILD_DIR) !== TEST_DIR) {
  console.error(`PITWALL_TEST_BUILD_DIR must be a child of ${TEST_DIR}, got ${BUILD_DIR}`);
  process.exit(2);
}
const STUB = path.join(TEST_DIR, 'vscode-stub.js');
const TIMEOUT_MS = Number(process.env.PITWALL_TEST_TIMEOUT_MS || 60_000);

const filter = process.argv[2];
/** Every `*.test.ts` under TEST_DIR, recursively, as paths relative to it (forward slashes). */
function collectTests(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return entry.name.startsWith('.build') || entry.name === 'fixtures' ? [] : collectTests(path.join(dir, entry.name), rel);
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

// Tests never read the developer's Claude profile. A test that builds a
// ClaudeHarness without a fixture would otherwise see the real
// ~/.claude/sessions (live sessions on this machine) and change behaviour from
// one machine to the next. Fixtures still set their own CLAUDE_CONFIG_DIR.
const CLAUDE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-dry-claude-'));
const testEnv = { ...process.env, CLAUDE_CONFIG_DIR: CLAUDE_HOME };
delete testEnv.CLAUDE_CODE_PROJECT_DIR_NAME;

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
      ...(process.env.PITWALL_TEST_NAME_PATTERN
        ? [`--test-name-pattern=${process.env.PITWALL_TEST_NAME_PATTERN}`]
        : []),
      ...bundles,
    ],
    { stdio: 'inherit', env: testEnv }
  );
  status = result.status ?? 1;
} catch (error) {
  console.error(error.message || error);
  status = 1;
} finally {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  fs.rmSync(CLAUDE_HOME, { recursive: true, force: true });
}

process.exit(status);
