#!/usr/bin/env node
/**
 * Integration-test runner.
 *
 * Launches a real VS Code instance (Extension Development Host) with this
 * extension loaded, points it at the temp profile below, and runs the suite in
 * test/integration/suite. No extension is installed permanently.
 *
 * Usage:
 *   npm run test:integration
 *
 * Environment:
 *   VSCODE_EXECUTABLE  path to the VS Code executable (optional; defaults are
 *                      probed per platform below)
 *   PITWALL_TEST_KEEP  set to 1 to keep the temp user-data/extensions dirs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');
const { resolveVSCodeExecutable } = require('../vscodeExecutable');
const { scrubElectronEnv } = require('../electronEnv');
const enabledHarnesses = require('../../src/harnesses/enabled.json');

async function main() {
  // An inherited ELECTRON_RUN_AS_NODE makes the editor start as plain Node.
  scrubElectronEnv(process.env);
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-vscode-test-'));
  const userDataDir = path.join(profileRoot, 'user-data');
  const extensionsDir = path.join(profileRoot, 'extensions');

  // A command override saved as one object by an earlier version; the suite
  // checks it still applies now that each harness has its own setting. It
  // targets the last enabled harness (pi when all four are on).
  const legacyHarness = enabledHarnesses[enabledHarnesses.length - 1];
  fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, 'User', 'settings.json'),
    JSON.stringify({ 'pitwall.harnessCommands': { [legacyHarness]: `${legacyHarness}-legacy` } })
  );

  console.log(`VS Code:      ${resolveVSCodeExecutable()}`);
  console.log(`Profile:      ${profileRoot}`);

  try {
    await runTests({
      vscodeExecutablePath: resolveVSCodeExecutable(),
      extensionDevelopmentPath: path.resolve(__dirname, '..', '..'),
      extensionTestsPath: path.join(__dirname, 'suite', 'index.js'),
      launchArgs: [
        '--disable-extensions',
        '--disable-gpu',
        '--skip-welcome',
        '--skip-release-notes',
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
      ],
    });
    console.log('INTEGRATION RUN COMPLETE');
  } finally {
    if (process.env.PITWALL_TEST_KEEP === '1') {
      console.log(`Kept profile at ${profileRoot}`);
    } else {
      fs.rmSync(profileRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error('INTEGRATION RUN FAILED', error);
  process.exit(1);
});
