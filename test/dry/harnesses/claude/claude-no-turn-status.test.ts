/**
 * Q24: opening a chat, or closing its Claude tab, must not turn its row
 * "working" or "finished" when no turn ran (S1b/T5 walk 3/3, S3 finding F3).
 *
 * Step 0 (before/after transcript diff of the uj-lab-a chats): a resume
 * appends `last-prompt`, `ai-title`, `mode`, `permission-mode`,
 * `session-owner` and `atis-latch`; closing the process appends `cost-state`,
 * `last-prompt` and `tools-used`. None is a conversation entry. Both lab
 * chats rest on Claude's `[Request interrupted by user for tool use]` marker
 * after a rejected tool call, which the tail read as a turn still running.
 *
 * Fixtures: test/dry/fixtures/claude-lab-no-turn (anonymised).
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeHarness } from '../../../../src/harnesses/claude/ClaudeHarness';
import { ClaudeSessionService } from '../../../../src/harnesses/claude/ClaudeSessionService';
import { ClaudeSessionsFile } from '../../../../src/harnesses/claude/ClaudeSessionsFile';
import { ClaudeAgentsService } from '../../../../src/harnesses/claude/ClaudeAgentsService';
import { HarnessRegistry } from '../../../../src/core/harness/HarnessRegistry';
import { SessionAttentionService } from '../../../../src/core/services/SessionAttentionService';
import { NotificationService } from '../../../../src/core/services/NotificationService';
import { SessionStatus } from '../../../../src/core/providers/sessionStatus';
import { makeStorage, stub, worktreeRecord } from '../../support';
import { claudeProfile } from './claudeFixture';

beforeEach(() => stub.__reset());

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DOMAIN = 'test:pitwall-domain';
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'claude-lab-no-turn');

/** Fixture lines as objects; `write()` stamps the profile's cwd and session ID on each. */
const fixture = (name: string): Record<string, unknown>[] =>
  fs
    .readFileSync(path.join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/**
 * A lab chat at rest, the real Claude harness over a synthetic profile, and
 * the attention service that keeps the rows.
 */
function labChat(t: Parameters<typeof claudeProfile>[0]) {
  const profile = claudeProfile(t);
  const repo = profile.dir('lab-a');
  const before = fixture('transcript-before.jsonl');
  const transcript = profile.write(SESSION_ID, repo, before);
  const sessionsDir = path.join(profile.root, 'sessions');
  const harness = new ClaudeHarness({
    sessionService: new ClaudeSessionService(),
    sessionsFile: new ClaudeSessionsFile({ dir: () => sessionsDir, isAlive: () => true, pidDomain: async () => DOMAIN }),
    agentsService: new ClaudeAgentsService({ command: () => 'fake-claude', enabled: () => false }),
  });

  const storage = makeStorage();
  // Listed after the lab turn, as an import does (P16).
  const chat = storage.createChat('wt-lab', 'claude', 'Lab ready', { harnessSessionId: SESSION_ID });
  const open = new Set<string>();
  const visible = new Set<string>();
  const isVisible = (chatId: string) => visible.has(chatId);
  const service = new SessionAttentionService(
    storage,
    new HarnessRegistry([harness]),
    new NotificationService(() => undefined, isVisible),
    (id) => worktreeRecord({ id, path: repo }),
    () => undefined,
    (entry) => open.has(entry.id),
    isVisible
  );
  // Ticks are 4 s apart, as in the extension: no folder read is reused across them.
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  t.after(() => {
    Date.now = realNow;
  });
  const statuses: SessionStatus[] = [];
  const tick = async () => {
    offset += 4_000;
    await service.poll();
    statuses.push(service.statusOf(chat.id).status);
  };

  return {
    chat,
    open,
    visible,
    statuses,
    tick,
    service,
    /** Append fixture lines the way Claude does (no cwd stamp on metadata lines). */
    append: (name: string) =>
      fs.appendFileSync(transcript, fixture(name).map((line) => `${JSON.stringify({ ...line, sessionId: SESSION_ID })}\n`).join('')),
    /** The process Claude's panel (or `claude --resume`) starts: idle, just now. */
    startProcess: (pid = 4242) => {
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionsDir, `${pid}.json`),
        JSON.stringify({ pid, sessionId: SESSION_ID, cwd: repo, pidDomain: DOMAIN, status: 'idle', statusUpdatedAt: Date.now() + 1_000, entrypoint: 'claude-vscode' })
      );
    },
    stopProcess: (pid = 4242) => fs.rmSync(path.join(sessionsDir, `${pid}.json`), { force: true }),
  };
}

test('closing a Claude tab with no turn leaves the row idle, never working or finished', async (t) => {
  const lab = labChat(t);
  await lab.service.poll(true);
  assert.equal(lab.service.statusOf(lab.chat.id).status, 'idle', 'at rest');

  // Open in Claude's panel: the tab is bound and in front, its process idle.
  lab.append('resume-appends.jsonl');
  lab.startProcess();
  lab.open.add(lab.chat.id);
  lab.visible.add(lab.chat.id);
  await lab.tick();

  // Close the tab, one order: the process leaves before the tab-close event
  // lands, so for a tick the chat still counts as open with no live status.
  lab.visible.delete(lab.chat.id);
  lab.stopProcess();
  lab.append('close-appends.jsonl');
  await lab.tick();
  lab.open.delete(lab.chat.id);
  await lab.tick();

  // Reopen, then close in the other order: the tab goes first and the
  // process restamps its idle status while it shuts down.
  lab.append('resume-appends.jsonl');
  lab.startProcess();
  lab.open.add(lab.chat.id);
  lab.visible.add(lab.chat.id);
  await lab.tick();
  lab.open.delete(lab.chat.id);
  lab.visible.delete(lab.chat.id);
  lab.startProcess();
  await lab.tick();
  lab.stopProcess();
  lab.append('close-appends.jsonl');
  await lab.tick();
  await lab.tick();

  assert.deepEqual(lab.statuses, Array(7).fill('idle'), 'never "working · now · open", never "finished"');
});

test('resuming a chat appends last-prompt, ai-title, mode, permission-mode, session-owner and atis-latch, and the row stays idle, not finished', async (t) => {
  const lab = labChat(t);
  await lab.service.poll(true);
  assert.equal(lab.service.statusOf(lab.chat.id).status, 'idle', 'at rest');

  // S3: Claude's panel resumed the chat with no prompt. Pitwall did not open
  // it (no bound tab), so the row is fed by the sessions file alone.
  lab.append('resume-appends.jsonl');
  lab.startProcess();
  await lab.tick();
  await lab.tick();

  // The same resume while the row's tab is open but not in front.
  lab.open.add(lab.chat.id);
  await lab.tick();

  assert.deepEqual(lab.statuses, ['idle', 'idle', 'idle'], 'never "finished · now"');
});
