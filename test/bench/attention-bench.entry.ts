/**
 * The attention tick at 500 chats (E18), bundled by attention-bench.js with
 * the dry-test `vscode` stub. Real StorageService over an in-memory memento,
 * so each tick pays the real cost of reading the chats; the harness is a
 * fake that answers at once, so the number measures Pitwall's own work.
 */
import { SessionAttentionService } from '../../src/core/services/SessionAttentionService';
import { HarnessRegistry } from '../../src/core/harness/HarnessRegistry';
import { HarnessLiveState } from '../../src/core/harness/types';
import { ChatSession, STORAGE_KEYS } from '../../src/core/types';
import { fakeAdapter, makeStorage, memento, worktreeRecord } from '../dry/support';

export interface BenchResult {
  durationsMs: number[];
  /** Session ids the ticks asked live states for, per tick. */
  polledPerTick: number;
}

export async function runBench(chatCount = 500, ticks = 100): Promise<BenchResult> {
  const now = Date.now();
  const globalState = memento();
  const chats: ChatSession[] = Array.from({ length: chatCount }, (_, i) => ({
    id: `chat-${i}`,
    worktreeId: `wt-${i % 25}`,
    name: `Chat ${i}`,
    harness: 'claude',
    harnessSessionId: `s-${i}`,
    createdAt: now - i * 60_000,
    lastAccessedAt: now - i * 60_000,
    seenAt: now - 3_600_000,
    status: 'idle',
  }));
  await globalState.update(STORAGE_KEYS.CHATS, chats);
  const storage = makeStorage(globalState);

  const open = new Set(chats.slice(0, 5).map((chat) => chat.id));
  const live = new Set(chats.slice(5, 15).map((chat) => chat.harnessSessionId!));
  let polled = 0;
  let tick = 0;
  const adapter = fakeAdapter('claude', {
    liveSessionIds: async () => live,
    getLiveStates: async (sessionIds: string[]) => {
      polled += sessionIds.length;
      const states = new Map<string, HarnessLiveState>();
      for (const id of sessionIds) {
        // Statuses move now and then, so some ticks re-judge rows and fire events.
        const busy = (tick + id.length) % 7 !== 0;
        states.set(id, busy
          ? { turnState: 'working', turnEndedAt: null, liveStatus: 'busy' }
          : { turnState: 'done', turnEndedAt: Date.now(), liveStatus: 'idle', statusUpdatedAt: Date.now() });
      }
      return states;
    },
  });
  const service = new SessionAttentionService(
    storage,
    new HarnessRegistry([adapter]),
    { notify: () => true } as never,
    (id) => worktreeRecord({ id, path: `/repo/${id}` }),
    () => undefined,
    (chat) => open.has(chat.id),
    () => false
  );
  service.onDidChangeStatus(() => undefined);
  await service.poll(true);

  const durationsMs: number[] = [];
  polled = 0;
  for (tick = 0; tick < ticks; tick++) {
    const start = performance.now();
    await service.poll();
    durationsMs.push(performance.now() - start);
  }
  service.dispose();
  return { durationsMs, polledPerTick: polled / ticks };
}
