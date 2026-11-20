/**
 * Sound switches and the bell (row 5.3, Q41, Q47). Both switches default to
 * off; a pop-up plays a sound only when its own kind's switch is on; the bell
 * flips them and writes only `pitwall.sound.*` to the user (Global) target.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import pkg from '../../../../package.json';
import { SoundSwitches, registerSoundUi, showSoundMenu } from '../../../../src/core/notify/SoundSwitches';
import { NotificationService, PopupTarget } from '../../../../src/core/services/NotificationService';
import { AUMID, WindowsToast, SpawnFn } from '../../../../src/core/notify/WindowsToast';
import { toastXml, ToastPayload } from '../../../../src/core/notify/toastXml';
import { chatRecord, flush, shownMessages, stub } from '../../support';

const SESSION = '5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

beforeEach(() => stub.__reset());

interface Setting {
  type?: string;
  default?: unknown;
}
const sections = pkg.contributes.configuration as unknown as { title: string; properties: Record<string, Setting> }[];

function target(overrides: Partial<PopupTarget> = {}): PopupTarget {
  return {
    chat: chatRecord({ id: 'chat-a', name: 'Fix map', harnessSessionId: SESSION }),
    context: 'uj-lab-b · main',
    repo: 'uj-lab-b',
    detail: 'permission prompt',
    sessionId: SESSION,
    at: Date.now() - 200,
    ...overrides,
  };
}

/** A pop-up service wired to real switches, with a recording toast host. */
function wired() {
  const switches = new SoundSwitches();
  const shows: ToastPayload[] = [];
  const log: string[] = [];
  const service = new NotificationService(() => undefined, () => false, {
    toast: {
      show: async (p) => {
        shows.push(p);
        return 'shown';
      },
    },
    sound: (kind) => switches.get(kind),
    log: (line) => log.push(line),
  });
  return { switches, service, shows, log };
}

/** A fake settings object that records every write. */
function fakeConfig(initial: Record<string, boolean> = {}) {
  const writes: unknown[][] = [];
  const store: Record<string, boolean> = { ...initial };
  const config = {
    get: (key: string, fallback?: boolean) => store[key] ?? fallback,
    update: async (...args: unknown[]) => {
      writes.push(args);
      store[args[0] as string] = args[1] as boolean;
    },
  } as unknown as vscode.WorkspaceConfiguration;
  return { config, writes };
}

test('both sound settings default to false', () => {
  const props = Object.assign({}, ...sections.map((section) => section.properties)) as Record<string, Setting>;
  for (const key of ['pitwall.sound.needsYou', 'pitwall.sound.finished']) {
    assert.equal(props[key]?.type, 'boolean', `${key} is a boolean`);
    assert.equal(props[key]?.default, false, `${key} is off by default`);
  }
  const switches = new SoundSwitches();
  assert.equal(switches.get('needs'), false);
  assert.equal(switches.get('finished'), false);
  assert.equal(switches.any(), false);
});

test('a needs pop-up carries sound only when sound.needsYou is on; finished follows its own switch', async () => {
  const { service, shows, log } = wired();
  await service.notify('needs-input', target());
  await service.whenDelivered();
  assert.equal(shows[0].sound, false, 'off by default');
  assert.match(log.at(-1) ?? '', /popup needs 5f0c3d4e shown lag=\d+ sound=off via=toast/);

  stub.__setConfiguration('sound.needsYou', true);
  await service.notify('needs-input', target({ at: Date.now() - 100 }));
  await service.notify('finished', target({ at: Date.now() - 100 }));
  await service.whenDelivered();
  assert.equal(shows.filter((p) => p.tag.endsWith('-needs')).at(-1)?.sound, true, 'needs follows sound.needsYou');
  assert.equal(shows.filter((p) => p.tag.endsWith('-finished')).at(-1)?.sound, false, 'finished stays silent while only needsYou is on');
  assert.ok(log.some((line) => /popup needs 5f0c3d4e shown lag=\d+ sound=on via=toast/.test(line)));
  assert.ok(log.some((line) => /popup finished 5f0c3d4e shown lag=\d+ sound=off via=toast/.test(line)));

  stub.__setConfiguration('sound.needsYou', false);
  stub.__setConfiguration('sound.finished', true);
  await service.notify('needs-input', target({ at: Date.now() - 50 }));
  await service.notify('finished', target({ at: Date.now() - 50 }));
  await service.whenDelivered();
  assert.equal(shows.filter((p) => p.tag.endsWith('-needs')).at(-1)?.sound, false);
  assert.equal(shows.filter((p) => p.tag.endsWith('-finished')).at(-1)?.sound, true, 'finished follows sound.finished');
});

test('the bell shows bell-slash with both off and bell with either on', async () => {
  const switches = new SoundSwitches();
  const disposables = registerSoundUi(switches, async () => undefined);
  await flush();
  assert.equal(stub.__contextKeys.get('pitwall.soundOn'), false, 'both off: bell-slash');
  stub.__setConfiguration('sound.finished', true);
  await flush();
  assert.equal(stub.__contextKeys.get('pitwall.soundOn'), true, 'either on: bell');
  stub.__setConfiguration('sound.needsYou', true);
  await flush();
  assert.equal(stub.__contextKeys.get('pitwall.soundOn'), true);
  stub.__setConfiguration('sound.finished', false);
  stub.__setConfiguration('sound.needsYou', false);
  await flush();
  assert.equal(stub.__contextKeys.get('pitwall.soundOn'), false);

  // The two icons are two commands on one handler, told apart by `when` on pitwall.soundOn.
  const commands = pkg.contributes.commands as { command: string; icon?: string }[];
  assert.equal(commands.find((c) => c.command === 'pitwall.soundMenu')?.icon, '$(bell-slash)');
  assert.equal(commands.find((c) => c.command === 'pitwall.soundMenuOn')?.icon, '$(bell)');
  const title = (pkg.contributes.menus as Record<string, { command: string; when?: string; group?: string }[]>)['view/title'];
  const off = title.find((e) => e.command === 'pitwall.soundMenu');
  const on = title.find((e) => e.command === 'pitwall.soundMenuOn');
  assert.equal(off?.when, 'view == pitwall.workspacesView && !pitwall.soundOn');
  assert.equal(on?.when, 'view == pitwall.workspacesView && pitwall.soundOn');
  assert.equal(off?.group, 'navigation@2');
  assert.equal(on?.group, 'navigation@2');
  disposables.forEach((d) => d.dispose());
});

test('the bell quick pick ticks match the settings and Enter applies only changed ones', async () => {
  const { config, writes } = fakeConfig({ 'sound.needsYou': true, 'sound.finished': false });
  const switches = new SoundSwitches(() => config);
  const done = showSoundMenu(switches, async () => undefined);
  const pick = stub.__quickPicks[0];
  assert.equal(pick.title, 'Sound alerts');
  assert.equal(
    pick.placeholder,
    'Off by default. When on, the Windows pop-up plays the system notification sound. Also in Settings → Pitwall → Sound.'
  );
  assert.equal(pick.canSelectMany, true);
  assert.deepEqual(pick.items.map((i) => i.label), ['When a session needs you', 'When a session finishes']);
  assert.deepEqual(pick.selectedItems.map((i) => i.label), ['When a session needs you'], 'ticks match the settings');
  assert.ok(pick.shown);

  // Enter with the ticks kept writes nothing.
  pick.__acceptSelected([pick.items[0]]);
  await done;
  assert.deepEqual(writes, [], 'unchanged ticks write nothing');

  // Tick finishes, untick needs: both change.
  const again = showSoundMenu(switches, async () => undefined);
  const second = stub.__quickPicks[1];
  second.__acceptSelected([second.items[1]]);
  await again;
  assert.deepEqual(
    writes.map((w) => [w[0], w[1]]).sort(),
    [['sound.finished', true], ['sound.needsYou', false]]
  );
  assert.equal(switches.any(), true);

  // Only one changes: only that one is written.
  writes.length = 0;
  const third = showSoundMenu(switches, async () => undefined);
  const last = stub.__quickPicks[2];
  last.__acceptSelected([last.items[0], last.items[1]]);
  await third;
  assert.deepEqual(writes.map((w) => [w[0], w[1]]), [['sound.needsYou', true]]);
});

test('Test sound shows one toast with sound on, whatever the switches, and logs popup test shown sound=on', async () => {
  const { service, shows, log } = wired();
  assert.equal(new SoundSwitches().any(), false, 'both switches off');
  await service.testSound();
  assert.equal(shows.length, 1, 'exactly one toast');
  assert.equal(shows[0].sound, true, 'with sound, whatever the switches');
  assert.equal(shows[0].title, 'Pitwall: test sound');
  assert.equal(shows[0].aumid, AUMID);
  assert.ok(log.includes('[Pitwall] popup test shown sound=on'), `logged: ${log.join(' | ')}`);
  assert.ok(!log.some((line) => /popup (needs|finished)/.test(line)), 'not logged as a real pop-up');

  // The bell's Test sound button calls it and keeps the menu open.
  let tests = 0;
  const done = showSoundMenu(new SoundSwitches(), async () => {
    tests += 1;
  });
  const pick = stub.__quickPicks[0];
  assert.equal(pick.buttons[0]?.tooltip, 'Test sound');
  pick.__triggerButton(0);
  await flush();
  assert.equal(tests, 1);
  assert.equal(pick.hidden, false, 'the menu stays open');
  pick.__acceptSelected([]);
  await done;

  // No Windows host (macOS, Linux, or a failed host): the in-window message stands in.
  stub.__reset();
  const bare = new NotificationService(() => undefined, () => false, { log: (line) => log.push(line) });
  await bare.testSound();
  assert.deepEqual(shownMessages(), ['Pitwall: test sound']);
});

test('the Test sound toast has no launch and only a Dismiss action', async () => {
  const { service, shows } = wired();
  await service.testSound();
  const xml = toastXml(shows[0]);
  assert.ok(!/launch=/.test(xml), 'no launch attribute');
  assert.ok(!/activationType="protocol"/.test(xml), 'no protocol activation');
  assert.ok(!/Open chat|cursor:\/\/|vscode:\/\//.test(xml), 'no Open chat, no link');
  assert.equal((xml.match(/<action /g) ?? []).length, 1, 'one action');
  assert.match(xml, /<action content="Dismiss" activationType="system" arguments="dismiss"\/>/);
  assert.match(xml, /<audio src="ms-winsoundevent:Notification.Default"\/>/);
  // A real pop-up keeps its launch and both buttons.
  const real = toastXml({ ...shows[0], noLaunch: false, openUri: `vscode://sharifamlani.pitwall/open?session=${SESSION}` });
  assert.match(real, /launch="vscode:\/\/sharifamlani\.pitwall\/open\?session=/);
  assert.match(real, /Open chat/);
});

test("the macOS banner plays Glass only when its kind's switch is on", async () => {
  const scripts: string[] = [];
  const switches = new SoundSwitches();
  const log: string[] = [];
  const service = new NotificationService(() => undefined, () => false, {
    platform: 'darwin',
    osascript: (script) => scripts.push(script),
    sound: (kind) => switches.get(kind),
    log: (line) => log.push(line),
  });
  const glass = (script: string) => script.includes('sound name "Glass"');

  await service.notify('needs-input', target({ at: Date.now() - 300 }));
  await service.notify('finished', target({ at: Date.now() - 300 }));
  assert.equal(scripts.length, 2, 'the banner still shows with sound off');
  assert.deepEqual(scripts.map(glass), [false, false], 'silent by default (QA C4)');
  assert.ok(log.some((line) => /popup needs 5f0c3d4e shown lag=\d+ sound=off via=in-window/.test(line)));

  scripts.length = 0;
  stub.__setConfiguration('sound.needsYou', true);
  await service.notify('needs-input', target({ at: Date.now() - 200 }));
  await service.notify('finished', target({ at: Date.now() - 200 }));
  assert.deepEqual(scripts.map(glass), [true, false], 'needs plays Glass, finished stays silent');
  assert.ok(log.some((line) => /popup needs 5f0c3d4e shown lag=\d+ sound=on via=in-window/.test(line)));

  scripts.length = 0;
  stub.__setConfiguration('sound.needsYou', false);
  stub.__setConfiguration('sound.finished', true);
  await service.notify('needs-input', target({ at: Date.now() - 100 }));
  await service.notify('finished', target({ at: Date.now() - 100 }));
  assert.deepEqual(scripts.map(glass), [false, true], 'finished follows its own switch');
});

test('set touches no key outside pitwall.sound', async () => {
  const { config, writes } = fakeConfig();
  const switches = new SoundSwitches(() => config);
  await switches.set('needs', true);
  await switches.set('finished', false);
  assert.deepEqual(
    writes,
    [
      ['sound.needsYou', true, vscode.ConfigurationTarget.Global],
      ['sound.finished', false, vscode.ConfigurationTarget.Global],
    ],
    'only pitwall.sound.* keys, only to the user (Global) target'
  );
});

test('the Settings page groups the two keys under Sound', () => {
  const section = sections.find((s) => s.title === 'Sound');
  assert.ok(section, 'a Sound section');
  assert.deepEqual(Object.keys(section.properties).sort(), ['pitwall.sound.finished', 'pitwall.sound.needsYou']);
  assert.ok(!sections.some((s) => s.title !== 'Sound' && Object.keys(s.properties).some((k) => k.startsWith('pitwall.sound.'))));
});

test('a toast for a removed registration fails as unregistered and falls back to the in-window message', async () => {
  const log: string[] = [];
  let script = '';
  // The warm pop-up host: its script, `ready`, then one answer per pop-up line.
  const spawn = ((_command: string, _args: readonly string[]) => {
    const host = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stdin: {
        write: (data: string) => {
          if (!script) {
            script = data;
            setImmediate(() => host.stdout.emit('data', Buffer.from('ready\r\n')));
          } else {
            setImmediate(() => host.stdout.emit('data', Buffer.from('failed unregistered\r\n')));
          }
          return true;
        },
        end: () => setImmediate(() => host.emit('close', 0)),
        on: () => undefined,
      },
      kill: () => true,
    });
    return host;
  }) as unknown as SpawnFn;
  const toast = new WindowsToast(spawn, 'win32', { log: (line) => log.push(line) });
  const service = new NotificationService(() => undefined, () => false, { toast, log: (line) => log.push(line) });
  await service.notify('needs-input', target());
  await service.whenDelivered();
  await flush();
  assert.ok(log.includes('[Pitwall] toast failed unregistered'), log.join(' | '));
  assert.equal(shownMessages().length, 1, 'the in-window message takes over, once');
  assert.ok(log.some((line) => /popup needs 5f0c3d4e shown lag=\d+ sound=off via=in-window/.test(line)));

  // Per pop-up, the script checks the one constant key before it creates the notifier that shows.
  const perPopup = script.slice(script.indexOf('[Console]::In.ReadLine()'));
  const check = perPopup.indexOf("Test-Path -LiteralPath 'HKCU:\\Software\\Classes\\AppUserModelId\\sharifamlani.pitwall'");
  assert.ok(check > 0, 'the host script tests for the AUMID key');
  assert.ok(check < perPopup.indexOf('CreateToastNotifier([string]$j.aumid)'), 'before CreateToastNotifier');
  assert.match(perPopup, /failed unregistered'; continue/);
  toast.dispose();
});
