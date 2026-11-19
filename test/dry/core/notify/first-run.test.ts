/**
 * The first-run Windows notifications check (row 5.5, Q42, §3e): a warning
 * message, once per profile, never a change to a Windows setting.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FirstRunCheck, NOTIFY_CHECK_KEY, NOTIFY_CHECK_LOCK, runAfterRegistration } from '../../../../src/core/notify/FirstRunCheck';
import type { NotificationState } from '../../../../src/core/notify/notificationState';
import { memento, shownMessages, stub, tempDir } from '../../support';

beforeEach(() => stub.__reset());

const ALL_ON: NotificationState = { toasts: 'on', app: 'on', focus: 'off' };

function make(t: { after(fn: () => void): void }, state: NotificationState, platform: NodeJS.Platform = 'win32') {
  const dir = tempDir(t);
  const log: string[] = [];
  let reads = 0;
  const read = async () => {
    reads++;
    return state;
  };
  const make = (m = memento()) => new FirstRunCheck(m, dir, read, { platform, log: (line) => log.push(line) });
  return { dir, log, make, reads: () => reads };
}

test('all on shows nothing and logs notify-check', async (t) => {
  const { make: build, log } = make(t, ALL_ON);
  assert.equal(await build().run(), 'quiet');
  assert.deepEqual(shownMessages(), []);
  assert.deepEqual(log, ['[Pitwall] notify-check toasts=on app=on focus=off']);
});

test("toasts off, app off and Focus assist on each show their §3e text and button", async (t) => {
  const cases: [NotificationState, string, string][] = [
    [{ toasts: 'off', app: 'on', focus: 'off' }, "Windows notifications are off, so Pitwall's pop-ups can't show.", 'Open notification settings'],
    [{ toasts: 'on', app: 'off', focus: 'off' }, "Pitwall's pop-ups are turned off in Windows settings.", 'Open notification settings'],
    [{ toasts: 'on', app: 'on', focus: 'priority' }, "Focus assist is on, so Windows hides Pitwall's pop-ups.", 'Open Focus assist settings'],
    [{ toasts: 'on', app: 'on', focus: 'alarms' }, "Focus assist is on, so Windows hides Pitwall's pop-ups.", 'Open Focus assist settings'],
  ];
  for (const [state, text, button] of cases) {
    stub.__reset();
    const { make: build, log } = make(t, state);
    assert.equal(await build().run(), 'shown');
    const call = stub.__messages.at(-1) as unknown[];
    assert.equal(call[0], text);
    assert.deepEqual(call.slice(1), [button, 'Not now']);
    assert.doesNotMatch(String(call[0]), /!/);
    assert.equal(log.length, 1);
    assert.match(log[0], /^\[Pitwall\] notify-check toasts=(on|off) app=(on|off) focus=(off|priority|alarms)$/);
  }
});

test('the button opens ms-settings:notifications or ms-settings:quiethours via openExternal', async (t) => {
  for (const [state, page] of [
    [{ toasts: 'off', app: 'on', focus: 'off' }, 'ms-settings:notifications'],
    [{ toasts: 'on', app: 'off', focus: 'off' }, 'ms-settings:notifications'],
    [{ toasts: 'on', app: 'on', focus: 'priority' }, 'ms-settings:quiethours'],
  ] as [NotificationState, string][]) {
    stub.__reset();
    stub.__warningResponses.push(state.focus === 'off' ? 'Open notification settings' : 'Open Focus assist settings');
    const { make: build } = make(t, state);
    await build().run();
    // The dry stub's Uri.parse keeps a scheme-only link whole in its path; real VS Code splits it.
    assert.deepEqual(stub.__openExternalCalls.map((u) => u.toString().replace('://', '')), [page]);
  }
  // Not now opens nothing.
  stub.__reset();
  stub.__warningResponses.push('Not now');
  await make(t, { toasts: 'off', app: 'on', focus: 'off' }).make().run();
  assert.equal(stub.__openExternalCalls.length, 0);
});

test('it runs once per profile; two windows starting together show one prompt', async (t) => {
  const { make: build, reads, dir } = make(t, { toasts: 'off', app: 'on', focus: 'off' });
  const profile = memento();
  const results = await Promise.all([build(profile).run(), build(profile).run(), build(profile).run()]);
  assert.deepEqual(results.slice().sort(), ['shown', 'skipped', 'skipped']);
  assert.equal(shownMessages().length, 1);
  assert.equal(reads(), 1);
  assert.equal(profile.get(NOTIFY_CHECK_KEY, false), true);
  assert.ok(fs.existsSync(path.join(dir, NOTIFY_CHECK_LOCK)), 'the file stays as the durable once-asked marker');
  // Next start of the same profile: skipped, no read.
  assert.equal(await build(profile).run(), 'skipped');
  assert.equal(reads(), 1);
  // A fresh lock held by another window (taken, marker not yet written) also skips.
  fs.rmSync(path.join(dir, NOTIFY_CHECK_LOCK));
  fs.writeFileSync(path.join(dir, NOTIFY_CHECK_LOCK), '');
  assert.equal(await build(memento()).run(), 'skipped');
});

test('force re-runs and says "Windows pop-ups are on." when all is on', async (t) => {
  const { make: build } = make(t, ALL_ON);
  const profile = memento();
  assert.equal(await build(profile).run(), 'quiet');
  assert.deepEqual(shownMessages(), []);
  assert.equal(await build(profile).run({ force: true }), 'quiet');
  assert.deepEqual(shownMessages(), ['Windows pop-ups are on.']);

  // Force also re-prompts a profile that already ran.
  stub.__reset();
  const bad = make(t, { toasts: 'off', app: 'on', focus: 'off' });
  const done = memento();
  await done.update(NOTIFY_CHECK_KEY, true);
  assert.equal(await bad.make(done).run({ force: true }), 'shown');
  assert.equal(shownMessages().length, 1);
});

test('unknown Focus assist never prompts', async (t) => {
  for (const state of [
    { toasts: 'on', app: 'on', focus: 'unknown' },
    { toasts: 'unknown', app: 'unknown', focus: 'unknown' },
  ] as NotificationState[]) {
    stub.__reset();
    const { make: build, log } = make(t, state);
    assert.equal(await build().run(), 'quiet');
    assert.deepEqual(shownMessages(), []);
    assert.equal(log.length, 1);
  }
  // A forced run on unknowns does not claim everything is on.
  stub.__reset();
  await make(t, { toasts: 'on', app: 'on', focus: 'unknown' }).make().run({ force: true });
  assert.ok(!shownMessages().includes('Windows pop-ups are on.'));
});

test('non-win32 never runs', async (t) => {
  const { make: build, reads, log, dir } = make(t, { toasts: 'off', app: 'off', focus: 'priority' }, 'linux');
  const profile = memento();
  assert.equal(await build(profile).run(), 'skipped');
  assert.equal(await build(profile).run({ force: true }), 'skipped');
  assert.equal(reads(), 0);
  assert.deepEqual(log, []);
  assert.deepEqual(shownMessages(), []);
  assert.equal(profile.get(NOTIFY_CHECK_KEY, false), false);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test("two windows whose globalState hasn't synced (separate mementos, one dir) show one prompt", async (t) => {
  const { make: build, reads } = make(t, { toasts: 'off', app: 'on', focus: 'off' });
  // Staggered starts: the later windows' globalState still reads the flag as false.
  assert.equal(await build(memento()).run(), 'shown');
  assert.equal(await build(memento()).run(), 'skipped');
  assert.equal(await build(memento()).run(), 'skipped');
  assert.equal(shownMessages().length, 1);
  assert.equal(reads(), 1);
});

test('a lock holding done, older than 60 s, still skips a window with an empty memento', async (t) => {
  const { make: build, dir, reads } = make(t, { toasts: 'off', app: 'on', focus: 'off' });
  const lock = path.join(dir, NOTIFY_CHECK_LOCK);
  // claim() leaves the marker behind: a first window asks once and writes done.
  assert.equal(await build(memento()).run(), 'shown');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'done', 'claim writes the done marker');
  // Aged past the stale limit, the marker still wins over "an old empty lock is a crashed window's".
  const old = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(await build(memento()).run(), 'skipped', 'a later window with an empty memento is skipped');
  assert.equal(shownMessages().length, 1);
  assert.equal(reads(), 1);
  // Written by hand too: done, old, empty memento.
  fs.writeFileSync(lock, 'done');
  fs.utimesSync(lock, old, old);
  assert.equal(await build(memento()).run(), 'skipped');
  assert.equal(shownMessages().length, 1);
});

test('a stale lock with no marker is replaced, and the check runs once', async (t) => {
  const { make: build, dir, reads } = make(t, { toasts: 'off', app: 'on', focus: 'off' });
  const lock = path.join(dir, NOTIFY_CHECK_LOCK);
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(await build(memento()).run(), 'shown');
  assert.equal(await build(memento()).run(), 'skipped');
  assert.equal(shownMessages().length, 1);
  assert.equal(reads(), 1);
});

test('a failed registration defers the first-run check without claiming the marker', async (t) => {
  const { make: build, log, dir, reads } = make(t, { toasts: 'on', app: 'off', focus: 'off' });
  assert.equal(await runAfterRegistration(Promise.resolve('failed'), build(), (l) => log.push(l)), 'deferred');
  assert.equal(reads(), 0);
  assert.deepEqual(shownMessages(), []);
  assert.equal(fs.existsSync(path.join(dir, NOTIFY_CHECK_LOCK)), false);
  assert.ok(log.includes('[Pitwall] notify-check deferred register-failed'));
  // The next activation registers fine and the check still has its one run.
  assert.equal(await runAfterRegistration(Promise.resolve('ok'), build(), (l) => log.push(l)), 'shown');
  assert.equal(shownMessages().length, 1);
});

test('the force command runs even when registration failed', async (t) => {
  const { make: build } = make(t, { toasts: 'on', app: 'off', focus: 'off' });
  assert.equal(await build().run({ force: true }), 'shown');
});
