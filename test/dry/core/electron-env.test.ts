import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

// The bundle runs from test/dry/.build, so the repo root is three levels up.
const ROOT = path.resolve(__dirname, '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ELECTRON_VARS, scrubElectronEnv } = require(path.join(ROOT, 'test', 'electronEnv.js'));

test('scrubElectronEnv removes every variable that turns the editor into Node or hands off to the running window', () => {
  const env: NodeJS.ProcessEnv = { PATH: '/bin' };
  const expected = [
    'ELECTRON_RUN_AS_NODE',
    'VSCODE_ESM_ENTRYPOINT',
    'VSCODE_CRASH_REPORTER_PROCESS_TYPE',
    'VSCODE_IPC_HOOK',
    'VSCODE_IPC_HOOK_CLI',
    'VSCODE_PID',
    'VSCODE_CWD',
  ];
  assert.deepEqual([...ELECTRON_VARS], expected);
  for (const name of expected) {
    env[name] = '1';
  }
  const result = scrubElectronEnv(env);
  assert.equal(result, env, 'scrubs in place and returns the same object');
  for (const name of expected) {
    assert.equal(name in env, false, `${name} is gone`);
  }
  assert.equal(env.PATH, '/bin');
});

test('every script that launches an editor scrubs its environment first', () => {
  for (const file of ['test/integration/runTest.js', 'test/e2e/terminal-restore/run.js']) {
    const text = fs.readFileSync(path.join(ROOT, ...file.split('/')), 'utf8');
    assert.ok(text.includes('scrubElectronEnv('), `${file} calls scrubElectronEnv(`);
  }
});
