/**
 * The shared exact-ID linkage loop, isolated from any harness's storage. A
 * chat registered while a pass is awaiting its resumability check must be
 * checked when that pass ends, not dropped with the snapshot it started from.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExactIdSessionSource,
  ExactIdSessionWatcher,
} from '../../../src/core/harness/kit/ExactIdSessionWatcher';
import { StorageService } from '../../../src/core/services/StorageService';
import { makeStorage, waitFor } from '../support';

class TestWatcher extends ExactIdSessionWatcher {
  constructor(storage: StorageService, source: ExactIdSessionSource) {
    super('pi', storage, source);
  }
}

function setup(t: { after(fn: () => void): void }) {
  const storage = makeStorage();
  let releaseGate: (() => void) | undefined;
  let signalBlocked: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    signalBlocked = resolve;
  });

  /** Session IDs whose record does not exist yet. */
  const notYet = new Set<string>();
  const source: ExactIdSessionSource = {
    watchRoots: () => [],
    watchDirs: () => [],
    sessionIdForFile: (filename) =>
      filename.endsWith('.jsonl')
        ? filename.slice(0, -'.jsonl'.length)
        : null,
    isResumable: async (sessionId) => {
      if (sessionId === 'first') {
        signalBlocked?.();
        await gate;
      }
      return !notYet.has(sessionId);
    },
    getSummary: async () => null,
  };

  const watcher = new TestWatcher(storage, source);
  t.after(() => watcher.dispose());
  return { storage, watcher, blocked, notYet, release: () => releaseGate?.() };
}

test('a chat registered during an in-flight check is linked when the check ends', async (t) => {
  const { storage, watcher, blocked, release } = setup(t);

  const pendingChat = (pendingSessionId: string) => {
    const chat = storage.createChat('wt-1', 'pi', 'New Session');
    return storage.updateChat(chat.id, {
      status: 'active',
      pendingHarnessSessionId: pendingSessionId,
    })!;
  };

  const first = pendingChat('first');
  const second = pendingChat('second');

  watcher.startWatching();
  watcher.registerPendingChat(first.id, '/worktree');

  // The first pass is now awaiting `first`; register the second chat inside
  // that window and then let the pass finish.
  await blocked;
  watcher.registerPendingChat(second.id, '/worktree');
  release();

  assert.equal(
    await waitFor(
      () => storage.getChat(first.id)!.harnessSessionId,
      'the first chat to link',
      5_000
    ),
    'first'
  );
  assert.equal(
    await waitFor(
      () => storage.getChat(second.id)!.harnessSessionId,
      'the second chat to link',
      5_000
    ),
    'second'
  );
});

/** Fake `Date.now`, restored when the test ends. */
function fakeClock(t: { after(fn: () => void): void }) {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });
  return { advance: (ms: number) => (now += ms) };
}

const PENDING_TTL = 5 * 60_000;

test('an abandoned chat whose TTL ends during a resumability check is not linked', async (t) => {
  const { storage, watcher, blocked, release } = setup(t);
  const clock = fakeClock(t);
  const pendingChat = (pendingSessionId: string, status: 'idle' | 'active') => {
    const chat = storage.createChat('wt-1', 'pi', 'New Session');
    return storage.updateChat(chat.id, {
      status,
      pendingHarnessSessionId: pendingSessionId,
    })!;
  };

  const abandoned = pendingChat('first', 'idle');
  watcher.startWatching();
  watcher.registerPendingChat(abandoned.id, '/wt');
  await blocked;
  clock.advance(PENDING_TTL + 1);
  release();

  const barrier = pendingChat('second', 'active');
  watcher.registerPendingChat(barrier.id, '/wt');
  await waitFor(
    () => storage.getChat(barrier.id)?.harnessSessionId,
    'the barrier chat to link',
    5_000
  );
  assert.equal(storage.getChat(abandoned.id)!.harnessSessionId, null);
});

test('an expired pending chat is not given a fresh window on the next pass', async (t) => {
  const { storage, watcher, notYet } = setup(t);
  const clock = fakeClock(t);
  const pendingChat = (pendingSessionId: string, status: 'idle' | 'active') => {
    const chat = storage.createChat('wt-1', 'pi', 'New Session');
    return storage.updateChat(chat.id, {
      status,
      pendingHarnessSessionId: pendingSessionId,
    })!;
  };

  notYet.add('late');
  const abandoned = pendingChat('late', 'idle');
  watcher.startWatching();
  watcher.registerPendingChat(abandoned.id, '/wt');
  clock.advance(PENDING_TTL + 1);

  // Pass one expires the chat; its record then appears; pass two must not
  // treat it as a restored chat with a new window.
  const barrier1 = pendingChat('b1', 'active');
  watcher.registerPendingChat(barrier1.id, '/wt');
  await waitFor(
    () => storage.getChat(barrier1.id)?.harnessSessionId,
    'the first barrier chat to link',
    5_000
  );
  notYet.delete('late');
  const barrier2 = pendingChat('b2', 'active');
  watcher.registerPendingChat(barrier2.id, '/wt');
  await waitFor(
    () => storage.getChat(barrier2.id)?.harnessSessionId,
    'the second barrier chat to link',
    5_000
  );
  assert.equal(storage.getChat(abandoned.id)!.harnessSessionId, null);
});
