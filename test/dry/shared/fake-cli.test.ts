/** `fakeCli` stands in for a harness CLI on every platform the suite runs on. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { harnessInvocation } from '../../../src/core/harness/cli';
import { fakeCli, tempDir } from '../support';

test('a fake CLI runs its fixture with its environment and arguments on this platform', (t) => {
  const dir = tempDir(t);
  const fixture = path.join(dir, 'echo.js');
  fs.writeFileSync(
    fixture,
    'console.log(JSON.stringify({ args: process.argv.slice(2), v: process.env.FAKE_V }));\n'
  );
  const cli = fakeCli(dir, 'echo', fixture, { FAKE_V: 'a b' });
  const inv = harnessInvocation(cli, ['x y', 'z']);
  const out = spawnSync(inv.command, inv.args, { shell: inv.shell, encoding: 'utf8', timeout: 10_000 });
  assert.deepEqual(JSON.parse(out.stdout), { args: ['x y', 'z'], v: 'a b' });
});
