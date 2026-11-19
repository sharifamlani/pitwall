/**
 * What Windows would do with Pitwall's pop-ups (row 5.5, Q42): read-only
 * reads of the all-toasts switch, Pitwall's own switch and Focus assist.
 * Every test but the last injects the spawner; the last runs the real
 * Windows PowerShell (windows CI only).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { notificationState, readersFor } from '../../../../src/core/notify/notificationState';
import { SpawnFn, WindowsToast } from '../../../../src/core/notify/WindowsToast';

class FakeHost extends EventEmitter {
  stdinText = '';
  readonly stdout = new EventEmitter();
  readonly stdin = {
    end: (data?: string | Buffer) => {
      this.stdinText += data === undefined ? '' : String(data);
    },
    on: () => this.stdin,
  };
  kill(): boolean {
    return true;
  }
}

/** A spawner that answers each script by its content: the state script and the setting script. */
function spy(answers: { state?: string; setting?: string; fail?: boolean }) {
  const scripts: string[] = [];
  const argvs: (readonly string[])[] = [];
  const spawn = ((_command: string, args: readonly string[]) => {
    const host = new FakeHost();
    argvs.push(args);
    setImmediate(() => {
      scripts.push(host.stdinText);
      if (answers.fail) {
        host.emit('close', 1);
        return;
      }
      const out = host.stdinText.includes('PushNotifications') ? answers.state : answers.setting;
      host.stdout.emit('data', Buffer.from(`${out ?? ''}\r\n`));
      host.emit('close', 0);
    });
    return host;
  }) as unknown as SpawnFn;
  return { spawn, scripts, argvs };
}

test('on / off / unknown answers map through, and a missing answer is unknown', async () => {
  const cases: [string, string, string, Record<string, string>][] = [
    ['toasts=on focus=off', 'Enabled', 'all on', { toasts: 'on', app: 'on', focus: 'off' }],
    ['toasts=off focus=off', 'Enabled', 'toasts off', { toasts: 'off', app: 'on', focus: 'off' }],
    ['toasts=on focus=off', 'DisabledForUser', 'app off', { toasts: 'on', app: 'off', focus: 'off' }],
    ['toasts=on focus=off', 'DisabledByGroupPolicy', 'policy', { toasts: 'on', app: 'off', focus: 'off' }],
    ['toasts=on focus=priority', 'Enabled', 'priority', { toasts: 'on', app: 'on', focus: 'priority' }],
    ['toasts=on focus=alarms', 'Enabled', 'alarms', { toasts: 'on', app: 'on', focus: 'alarms' }],
    ['toasts=on focus=unknown', 'unknown', 'unreadable', { toasts: 'on', app: 'unknown', focus: 'unknown' }],
    ['toasts=on focus=banana', 'Enabled', 'unrecognised focus', { toasts: 'on', app: 'on', focus: 'unknown' }],
    ['garbage', 'garbage', 'garbage', { toasts: 'unknown', app: 'unknown', focus: 'unknown' }],
  ];
  for (const [state, setting, label, expected] of cases) {
    const { spawn } = spy({ state, setting });
    const result = await notificationState(readersFor(new WindowsToast(spawn, 'win32')));
    assert.deepEqual({ ...result }, expected, label);
  }
});

test('a failing PowerShell or a throwing reader answers unknown, never throws', async () => {
  const { spawn } = spy({ fail: true });
  assert.deepEqual({ ...(await notificationState(readersFor(new WindowsToast(spawn, 'win32')))) }, {
    toasts: 'unknown',
    app: 'unknown',
    focus: 'unknown',
  });
  const result = await notificationState({
    state: async () => {
      throw new Error('boom');
    },
    notifier: async () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual({ ...result }, { toasts: 'unknown', app: 'unknown', focus: 'unknown' });
});

test('app is unknown when the sender never registered', async () => {
  const { spawn, scripts } = spy({ state: 'toasts=on focus=off', setting: 'Enabled' });
  const result = await notificationState(readersFor(new WindowsToast(spawn, 'win32'), Promise.resolve('failed')));
  assert.equal(result.app, 'unknown');
  assert.ok(!scripts.some((s) => s.includes('get_Setting')), 'no setting read before registration');
});

test('nothing writes to the registry: the scripts only read, and argv is the usual host', async () => {
  const { spawn, scripts, argvs } = spy({ state: 'toasts=on focus=off', setting: 'Enabled' });
  await notificationState(readersFor(new WindowsToast(spawn, 'win32')));
  assert.equal(scripts.length, 2);
  for (const script of scripts) {
    assert.doesNotMatch(
      script,
      /New-Item|Set-Item|New-ItemProperty|Set-ItemProperty|Remove-Item|Remove-ItemProperty|Rename-Item|Copy-Item|\breg(\.exe)?\s+(add|delete|import|copy|save|restore|load|unload)|\.SetValue|CreateSubKey|DeleteSubKey|Out-File|Set-Content|Add-Content/i
    );
  }
  assert.ok(scripts.some((s) => /Get-ItemProperty/.test(s)), 'the registry is read with Get-ItemProperty');
  for (const argv of argvs) {
    assert.deepEqual([...argv], ['-NoProfile', '-NonInteractive', '-Command', '-']);
  }
});

test('non-win32 reads nothing', async () => {
  const { spawn, scripts } = spy({});
  const toast = new WindowsToast(spawn, 'linux');
  assert.deepEqual({ ...(await notificationState(readersFor(toast))) }, { toasts: 'unknown', app: 'unknown', focus: 'unknown' });
  assert.equal(scripts.length, 0);
});

test(
  'real Windows PowerShell answers a well-formed state',
  { skip: process.platform !== 'win32' && 'needs Windows PowerShell (windows CI only)', timeout: 30_000 },
  async () => {
    const result = await notificationState(readersFor(new WindowsToast(undefined, 'win32')));
    assert.match(result.toasts, /^(on|off|unknown)$/);
    assert.match(result.app, /^(on|off|unknown)$/);
    assert.match(result.focus, /^(off|priority|alarms|unknown)$/);
  }
);
