/**
 * The Windows pop-up host (row 5.2, Q46 = A, QA B2/N7): one short-lived
 * `powershell.exe -NoProfile -NonInteractive -Command -` per pop-up, fed a
 * constant script whose only variable part is one base64 literal. Pop-up text
 * never reaches argv or PowerShell code. Every test but the last injects the
 * spawner; the last runs the real Windows PowerShell (windows CI only).
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { toastXml, ToastPayload } from '../../../../src/core/notify/toastXml';
import {
  AUMID,
  AUMID_KEY,
  HOST_SCRIPT_PREFIX,
  HOST_SCRIPT_SUFFIX,
  POWERSHELL,
  POWERSHELL_ARGS,
  SpawnFn,
  TOAST_TIMEOUT_MS,
  WindowsToast,
} from '../../../../src/core/notify/WindowsToast';
import { NotificationService, PopupTarget } from '../../../../src/core/services/NotificationService';
import { removeRegistration } from '../../../../src/uninstall';
import { chatRecord, flush, shownMessages, stub } from '../../support';

const SESSION = '5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const ICON = 'C:\\Users\\uj-tester\\.cursor\\extensions\\sharifamlani.pitwall-0.6.0\\resources\\icons\\pitwall.png';

beforeEach(() => stub.__reset());

/** A host process that does nothing until the test finishes it. */
class FakeHost extends EventEmitter {
  stdinText = '';
  killed = false;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = {
    end: (data?: string | Buffer) => {
      this.stdinText += data === undefined ? '' : String(data);
    },
    on: () => this.stdin,
  };
  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.emit('close', null));
    return true;
  }
  finish(out: string, code = 0): void {
    this.stdout.emit('data', Buffer.from(out));
    this.emit('close', code);
  }
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: { windowsHide?: boolean };
  host: FakeHost;
}

/** A spawner that records every call; `answer` finishes each host (or leaves it running). */
function spy(answer: ((call: SpawnCall) => void) | 'hang' = (call) => setImmediate(() => call.host.finish('shown\r\n'))) {
  const calls: SpawnCall[] = [];
  const spawn = ((command: string, args: readonly string[], options: { windowsHide?: boolean }) => {
    const call = { command, args, options, host: new FakeHost() };
    calls.push(call);
    if (answer !== 'hang') {
      answer(call);
    }
    return call.host;
  }) as unknown as SpawnFn;
  return { spawn, calls };
}

function payload(overrides: Partial<ToastPayload> = {}): ToastPayload {
  return {
    aumid: AUMID,
    title: 'uj-lab-b needs you',
    body: 'Fix map: Claude is waiting for you.',
    attribution: 'permission prompt',
    sound: false,
    openUri: `cursor://sharifamlani.pitwall/open?session=${SESSION}`,
    tag: '5f0c3d4e-needs',
    ...overrides,
  };
}

/** The base64 literal between the constant prefix and suffix, or a failure naming what differs. */
function literalOf(stdin: string): string {
  assert.ok(stdin.startsWith(HOST_SCRIPT_PREFIX + "'"), 'stdin starts with the constant prefix, byte for byte');
  assert.ok(stdin.endsWith("'" + HOST_SCRIPT_SUFFIX), 'stdin ends with the constant suffix, byte for byte');
  return stdin.slice(HOST_SCRIPT_PREFIX.length + 1, stdin.length - HOST_SCRIPT_SUFFIX.length - 1);
}

test('show spawns powershell with a constant script and the payload on stdin only', async () => {
  const { spawn, calls } = spy();
  const toast = new WindowsToast(spawn, 'win32');
  const p = payload();
  assert.equal(await toast.show(p), 'shown');

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.command, POWERSHELL);
  assert.equal(POWERSHELL, 'powershell.exe');
  assert.deepEqual([...call.args], ['-NoProfile', '-NonInteractive', '-Command', '-']);
  assert.deepEqual([...POWERSHELL_ARGS], [...call.args]);
  assert.equal(call.options.windowsHide, true, 'windowsHide hides the console; no -WindowStyle Hidden');
  const argv = [call.command, ...call.args].join(' ');
  for (const banned of ['-ExecutionPolicy', '-WindowStyle', 'Bypass', 'Hidden', 'uj-lab-b', 'Fix map', 'permission', 'cursor://', SESSION]) {
    assert.ok(!argv.includes(banned), `argv carries no ${banned}`);
  }

  const literal = literalOf(call.host.stdinText);
  assert.match(literal, /^[A-Za-z0-9+/=]*$/);
  const decoded = JSON.parse(Buffer.from(literal, 'base64').toString('utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(decoded).sort(), ['aumid', 'tag', 'xml']);
  assert.deepEqual(decoded, { aumid: AUMID, xml: toastXml(p), tag: '5f0c3d4e-needs' });
  // The constant script names no pop-up text and builds nothing from it.
  for (const text of ['uj-lab-b', 'Fix map', 'permission prompt']) {
    assert.ok(!HOST_SCRIPT_PREFIX.includes(text) && !HOST_SCRIPT_SUFFIX.includes(text));
  }
  assert.ok(!/Invoke-Expression|\biex\b|ScriptBlock|Add-Type/i.test(HOST_SCRIPT_PREFIX + HOST_SCRIPT_SUFFIX), 'the script evaluates no text');
});

test("hostile titles ('@, ', $(calc), newline, backtick) cannot change the script", async () => {
  const { spawn, calls } = spy();
  const toast = new WindowsToast(spawn, 'win32');
  const hostile = ["'@", "'", '$(calc)', 'line one\nline two', 'back`tick', "'; Start-Process calc; '", '"@\n$(calc)\n@"', 'é ü 日本 🚀'];
  for (const title of hostile) {
    assert.equal(await toast.show(payload({ title, body: title, attribution: title })), 'shown');
  }
  assert.equal(calls.length, hostile.length);
  calls.forEach((call, i) => {
    const literal = literalOf(call.host.stdinText);
    assert.match(literal, /^[A-Za-z0-9+/=]*$/, `payload ${i} is one base64 literal`);
    const argv = [call.command, ...call.args].join(' ');
    assert.ok(!argv.includes(hostile[i]) && !argv.includes('calc'), `argv ${i} has no title`);
    const decoded = JSON.parse(Buffer.from(literal, 'base64').toString('utf8')) as { xml: string };
    assert.equal(decoded.xml, toastXml(payload({ title: hostile[i], body: hostile[i], attribution: hostile[i] })), 'the text arrives as data, unchanged');
  });
});

test('a host that runs past 10 s is killed and reports failed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { spawn, calls } = spy('hang');
  const log: string[] = [];
  const toast = new WindowsToast(spawn, 'win32', { log: (line) => log.push(line) });
  assert.equal(TOAST_TIMEOUT_MS, 10_000);
  const result = toast.show(payload());
  await flush();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(TOAST_TIMEOUT_MS - 1);
  assert.equal(calls[0].host.killed, false, 'not before 10 s');
  t.mock.timers.tick(1);
  assert.equal(calls[0].host.killed, true, 'killed at 10 s');
  t.mock.timers.reset();
  assert.equal(await result, 'failed');
  assert.deepEqual(log, ['[Pitwall] toast failed timeout']);
});

test('at most one host in flight; a second show queues', async () => {
  const { spawn, calls } = spy('hang');
  const toast = new WindowsToast(spawn, 'win32');
  const first = toast.show(payload({ tag: 'aaaaaaaa-needs' }));
  const second = toast.show(payload({ tag: 'bbbbbbbb-finished' }));
  await flush();
  await flush();
  assert.equal(calls.length, 1, 'the second waits for the first');
  calls[0].host.finish('shown\r\n');
  assert.equal(await first, 'shown');
  await flush();
  await flush();
  assert.equal(calls.length, 2, 'then the second spawns');
  calls[1].host.finish('failed DisabledForUser\r\n', 2);
  assert.equal(await second, 'failed');
  const tags = calls.map((call) => (JSON.parse(Buffer.from(literalOf(call.host.stdinText), 'base64').toString('utf8')) as { tag: string }).tag);
  assert.deepEqual(tags, ['aaaaaaaa-needs', 'bbbbbbbb-finished'], 'in order');
});

/** A notification service whose pop-up host answers `result`; every in-window message is recorded. */
function popupService(result: 'shown' | 'failed') {
  const shows: ToastPayload[] = [];
  const log: string[] = [];
  const service = new NotificationService(() => undefined, () => false, {
    toast: {
      show: async (p) => {
        shows.push(p);
        return result;
      },
    },
    log: (line) => log.push(line),
  });
  const target = (overrides: Partial<PopupTarget> = {}): PopupTarget => ({
    chat: chatRecord({ id: 'chat-a', name: 'Fix map', harnessSessionId: SESSION }),
    context: 'uj-lab-b · main',
    repo: 'uj-lab-b',
    detail: 'permission prompt',
    sessionId: SESSION,
    at: Date.now() - 200,
    ...overrides,
  });
  return { service, shows, log, target };
}

test('failed falls back to the in-window message once', async () => {
  const failing = popupService('failed');
  assert.equal(await failing.service.notify('needs-input', failing.target()), 'shown');
  await failing.service.whenDelivered();
  await flush();
  assert.equal(failing.shows.length, 1, 'the pop-up host is asked once, never retried');
  assert.deepEqual(failing.shows[0], {
    aumid: AUMID,
    title: 'uj-lab-b needs you',
    body: 'Fix map: Claude is waiting for you.',
    attribution: 'permission prompt',
    sound: false,
    openUri: `vscode://sharifamlani.pitwall/open?session=${SESSION}`,
    tag: '5f0c3d4e-needs',
  });
  const messages = shownMessages();
  assert.equal(messages.length, 1, 'exactly one in-window message');
  assert.match(messages[0], /^Fix map needs your input \(uj-lab-b · main\) — permission prompt$/);
  assert.equal(failing.log.length, 1);
  assert.match(failing.log[0], /^\[Pitwall\] popup needs 5f0c3d4e shown lag=\d+ sound=off via=in-window$/);

  stub.__reset();
  const working = popupService('shown');
  assert.equal(await working.service.notify('finished', working.target({ detail: undefined })), 'shown');
  await working.service.whenDelivered();
  assert.deepEqual(shownMessages(), [], 'a shown pop-up replaces the in-window message (Q35)');
  assert.equal(working.shows[0].title, 'uj-lab-b: finished');
  assert.equal(working.shows[0].body, 'Fix map: Your turn.');
  assert.equal(working.shows[0].attribution, undefined);
  assert.equal(working.shows[0].tag, '5f0c3d4e-finished');
  assert.match(working.log[0], /^\[Pitwall\] popup finished 5f0c3d4e shown lag=\d+ sound=off via=toast$/);

  // A session ID the open link can't carry (not a UUID) keeps the in-window message, whose Open works.
  stub.__reset();
  const other = popupService('shown');
  await other.service.notify('needs-input', other.target({ sessionId: 'ses_opencode1', chat: chatRecord({ id: 'chat-o', name: 'Other', harnessSessionId: 'ses_opencode1' }) }));
  await other.service.whenDelivered();
  assert.equal(other.shows.length, 0);
  assert.equal(shownMessages().length, 1);
});

test('register writes DisplayName Pitwall under HKCU and unregister removes it', async () => {
  const { spawn, calls } = spy((call) => setImmediate(() => call.host.finish('written\r\n')));
  const toast = new WindowsToast(spawn, 'win32');
  assert.equal(AUMID_KEY, 'HKCU:\\Software\\Classes\\AppUserModelId\\sharifamlani.pitwall');

  assert.equal(await toast.registerAumid(ICON), 'ok');
  assert.equal(calls.length, 1);
  const script = calls[0].host.stdinText;
  assert.ok(script.includes(`'${AUMID_KEY}'`), 'the per-user key');
  assert.ok(!/HKLM|HKEY_LOCAL_MACHINE|Policies/i.test(script), 'nothing outside HKCU');
  assert.ok(/DisplayName/.test(script) && script.includes("'Pitwall'"), 'DisplayName Pitwall');
  assert.ok(/IconUri/.test(script));
  const argv = [calls[0].command, ...calls[0].args].join(' ');
  assert.ok(!argv.includes('uj-tester') && !argv.includes('pitwall.png'), 'the icon path rides stdin, not argv');
  const literal = script.match(/'([A-Za-z0-9+/=]+)'/g)?.map((quoted) => quoted.slice(1, -1)) ?? [];
  assert.ok(
    literal.some((value) => {
      try {
        return (JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as { icon?: string }).icon === ICON;
      } catch {
        return false;
      }
    }),
    'the icon path is the base64 literal'
  );

  // Once per activation: the same icon does not spawn again; a moved extension refreshes IconUri.
  assert.equal(await toast.registerAumid(ICON), 'ok');
  assert.equal(calls.length, 1, 'idempotent within an activation');
  const moved = ICON.replace('0.6.0', '0.6.1');
  assert.equal(await toast.registerAumid(moved), 'ok');
  assert.equal(calls.length, 2, 'a new extension path writes the new IconUri');

  await toast.unregisterAumid();
  assert.equal(calls.length, 3);
  const removal = calls[2].host.stdinText;
  assert.ok(removal.includes(`Remove-Item -LiteralPath '${AUMID_KEY}'`), 'the key is removed');

  // A pop-up after removal does not spawn a host: the in-window message takes over.
  assert.equal(await toast.show(payload()), 'failed');
  assert.equal(calls.length, 3);

  // The first pop-up of an activation waits for registration.
  const slow = spy('hang');
  const fresh = new WindowsToast(slow.spawn, 'win32');
  const registering = fresh.registerAumid(ICON);
  const shown = fresh.show(payload());
  await flush();
  assert.equal(slow.calls.length, 1, 'the pop-up waits behind registration');
  slow.calls[0].host.finish('unchanged\r\n');
  assert.equal(await registering, 'ok');
  await flush();
  await flush();
  assert.equal(slow.calls.length, 2);
  assert.ok(slow.calls[1].host.stdinText.startsWith(HOST_SCRIPT_PREFIX));
  slow.calls[1].host.finish('shown\r\n');
  assert.equal(await shown, 'shown');

  // The extension registers after the first render, never on the activation path, and never from a test host.
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'extension.ts'), 'utf8');
  assert.match(source, /process\.platform === 'win32' && realRun \? new WindowsToast\(/);
  const afterRender = source.slice(source.indexOf('afterFirstRender(() => {\n    context.subscriptions.push(attentionService.watchLive());'));
  assert.match(afterRender.slice(0, 600), /windowsToast\.registerAumid\(/, 'registration starts in the after-first-render block');
  assert.equal((source.match(/\.registerAumid\(/g) ?? []).length, 1, 'and nowhere else');
});

test("unregister removes the AppUserModelId key and Windows' Notifications\\Settings entry for Pitwall only", async () => {
  const { spawn, calls } = spy((call) => setImmediate(() => call.host.finish('removed\r\n')));
  await new WindowsToast(spawn, 'win32').unregisterAumid();
  assert.equal(calls.length, 1);
  const script = calls[0].host.stdinText;
  const removed = [...script.matchAll(/Remove-Item -LiteralPath '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(removed, [
    'HKCU:\\Software\\Classes\\AppUserModelId\\sharifamlani.pitwall',
    'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\sharifamlani.pitwall',
  ]);
  assert.equal((script.match(/Remove-Item/g) ?? []).length, 2, 'two keys, nothing else');
  assert.ok(!/[*?]|HKLM|Get-ChildItem|\$/.test(script.replace(/-ErrorAction SilentlyContinue/g, '')), 'constant paths: no wildcard, no variable, no other hive');
});

test('the uninstall script removes the key', async () => {
  const { spawn, calls } = spy((call) => setImmediate(() => call.host.finish('')));
  await removeRegistration(new WindowsToast(spawn, 'win32'));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].host.stdinText.includes(`Remove-Item -LiteralPath '${AUMID_KEY}'`));

  const root = path.join(__dirname, '..', '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
    files: string[];
    activationEvents: string[];
  };
  assert.equal(pkg.scripts['vscode:uninstall'], 'node ./out/uninstall.js');
  assert.ok(pkg.files.includes('out/uninstall.js'), 'the uninstall script ships');
  assert.ok(pkg.activationEvents.includes('onUri'));
  assert.match(fs.readFileSync(path.join(root, 'esbuild.js'), 'utf8'), /src\/uninstall\.ts/, 'esbuild builds it');
});

test('non-win32 never spawns', async () => {
  for (const platform of ['linux', 'darwin'] as NodeJS.Platform[]) {
    const { spawn, calls } = spy();
    const toast = new WindowsToast(spawn, platform);
    assert.equal(await toast.show(payload()), 'failed');
    assert.equal(await toast.registerAumid(ICON), 'failed');
    await toast.unregisterAumid();
    assert.equal(await toast.notifierSetting(), 'unknown');
    await removeRegistration(toast);
    assert.equal(calls.length, 0, `${platform}: no process`);
  }
});

test('notifierSetting reads ToastNotifier.Setting for the AUMID', async () => {
  const answers: Record<string, string> = {
    'Enabled\r\n': 'enabled',
    'DisabledForUser\r\n': 'disabledForUser',
    'DisabledForApplication\r\n': 'disabledForApplication',
    'DisabledByGroupPolicy\r\n': 'disabledByGroupPolicy',
    'DisabledByManifest\r\n': 'unknown',
    'unknown 0x80070490\r\n': 'unknown',
  };
  for (const [out, expected] of Object.entries(answers)) {
    const { spawn, calls } = spy((call) => setImmediate(() => call.host.finish(out)));
    assert.equal(await new WindowsToast(spawn, 'win32').notifierSetting(), expected, out.trim());
    assert.ok(calls[0].host.stdinText.includes(`CreateToastNotifier('${AUMID}').get_Setting()`));
  }
});

test(
  'real PowerShell renders the XML without error',
  { skip: process.platform !== 'win32' && 'needs Windows PowerShell (windows CI only)', timeout: 30_000 },
  async () => {
    const log: string[] = [];
    const toast = new WindowsToast(undefined, 'win32', { log: (line) => log.push(line) });
    const hostile = `uj-lab-b <needs> & "you" 'now' $(calc) \`n '@`;
    // A dry run builds the toast from the XML and stops before Show: nothing pops on CI or a dev machine.
    assert.equal(await toast.show(payload({ title: hostile, sound: true }), { dryRun: true }), 'shown', log.join('\n'));
    assert.equal(await toast.show(payload({ sound: false }), { dryRun: true }), 'shown', log.join('\n'));
    assert.deepEqual(log, []);
  }
);
