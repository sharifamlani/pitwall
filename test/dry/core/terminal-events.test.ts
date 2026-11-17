/**
 * terminalEvents: the shell line that changes into a chat's worktree and runs
 * its command, for each kind of shell a terminal or a paste can land in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandInDirectory } from '../../../src/core/services/terminalEvents';

test('commandInDirectory builds a line each shell can run', () => {
  const cases: [string, string, string, string][] = [
    ['/w s', 'claude --resume s1', '/bin/bash', "cd '/w s' && claude --resume s1"],
    [
      "C:\\Users\\o'brien\\repo",
      'claude --resume s1',
      'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      "Set-Location -LiteralPath 'C:\\Users\\o''brien\\repo'; if ($?) { claude --resume s1 }",
    ],
    [
      'C:\\repo',
      'claude --resume s1',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      "Set-Location -LiteralPath 'C:\\repo'; if ($?) { claude --resume s1 }",
    ],
    [
      'C:\\repo',
      "'C:\\x\\claude.cmd' --resume s1",
      'powershell.exe',
      "Set-Location -LiteralPath 'C:\\repo'; if ($?) { & 'C:\\x\\claude.cmd' --resume s1 }",
    ],
    ['C:\\repo', 'claude --resume s1', 'C:\\WINDOWS\\system32\\cmd.exe', 'cd /d "C:\\repo" && claude --resume s1'],
  ];
  for (const [directory, command, shell, expected] of cases) {
    assert.equal(commandInDirectory(directory, command, shell), expected, shell);
  }
});
