/**
 * E16 startup bench, bundled by first-render-bench.js with the dry-test
 * `vscode` stub. The real extension activates over a synthetic profile shaped
 * like the one the live bug was measured on: 17 stored repos (12 git repos,
 * 3 of them with a linked worktree, and 5 plain folders), 129 stored Claude
 * chats, and their transcripts at realistic sizes (about 1 MB on average,
 * from 50 KB to 5 MB). Real git, real files; only the editor is a stub.
 *
 * Discovery is on, as installed: besides the stored repos, the profile has 3
 * repos only discovery finds (5 transcripts each) and a dismissed folder with
 * 2 long sessions (16 MB each) that discovery looks at on every pass and the
 * importer never reads. `discoveryPass` times discovery alone.
 *
 * What it measures, from the moment `activate()` is called:
 *   - activateMs: until `activate()` settles (the exthost "activate call").
 *   - firstRenderMs: until the Repos list answers the workbench's first
 *     request for its rows. The workbench asks over IPC, so the request is a
 *     new macrotask posted right after `activate()` returns.
 *   - maxBlockMs: the longest the event loop was blocked (the largest gap
 *     between runs of a 1 ms interval) until the first import scan ended. Nothing else, a
 *     render included, can run while the loop is blocked.
 *   - scanMs: until every stored chat's transcript has been parsed once (the first scan).
 *   - discoveryMs: until discovery's first pass ends (`pitwall.scanned`).
 *   maxBlockMs runs until both the scan and discovery's first pass ended.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate } from '../../src/extension';
import { worktreeId } from '../../src/core/services/GitService';
import { encodeClaudeProjectPath } from '../../src/harnesses/claude/paths';
import { ClaudeRepoDiscovery } from '../../src/harnesses/claude/ClaudeRepoDiscovery';
import { ClaudeSessionService } from '../../src/harnesses/claude/ClaudeSessionService';
import { disposeOperationLog } from '../../src/core/services/OperationLog';
import { makeStorage, memento, watchEventLoopBlocks } from '../dry/support';

interface FixtureRepo {
  name: string;
  root: string;
  /** Where its sessions ran: the root, then any linked worktree. */
  worktrees: string[];
}

export interface Fixture {
  dir: string;
  configDir: string;
  /** The stored repos. */
  repos: FixtureRepo[];
  /** The stored chats' transcripts. */
  transcripts: { sessionId: string; cwd: string; file: string; bytes: number }[];
  /** Repos only discovery finds, and their transcripts. */
  discoverable: FixtureRepo[];
  discoverableTranscripts: { file: string; bytes: number }[];
  /** A dismissed folder with long sessions: discovery reads them, the importer never does. */
  dismissed: string;
}

/** Pitwall's stored state, carried from one activation to the next like a reload. */
export interface BenchState {
  globalState: ReturnType<typeof memento>;
  workspaceState: ReturnType<typeof memento>;
}

export interface BenchRun {
  /** The state this activation left, for a following reload. */
  state: BenchState;
  activateMs: number;
  firstRenderMs: number;
  firstRenderRows: number;
  maxBlockMs: number;
  scanMs: number;
  discoveryMs: number;
}

const GIT_REPOS = 12;
const PLAIN_FOLDERS = 5;
const LINKED_WORKTREES = 3;
const CHATS = 129;
const DISCOVERABLE_REPOS = 3;
const DISCOVERABLE_TRANSCRIPTS_EACH = 5;
const DISMISSED_LONG_TRANSCRIPTS = 2;
const LONG_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

const git = (args: string[], cwd: string) =>
  execFileSync('git', ['-c', 'user.email=bench@example.com', '-c', 'user.name=Bench', ...args], { cwd, stdio: 'pipe' });

/** A deterministic size in bytes: half small, a third medium, the rest large (mean about 1 MB). */
function transcriptBytes(i: number): number {
  const r = ((i * 2654435761) >>> 0) / 2 ** 32;
  if (r < 0.5) return Math.round(50_000 + r * 2 * 350_000);
  if (r < 0.85) return Math.round(500_000 + ((r - 0.5) / 0.35) * 1_500_000);
  return Math.round(2_000_000 + ((r - 0.85) / 0.15) * 3_000_000);
}

/** Transcript lines like Claude Code's: prompts, replies, and long tool results. */
function transcript(sessionId: string, cwd: string, bytes: number, startedAt: number): string {
  const lines: string[] = [];
  let size = 0;
  let turn = 0;
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(60);
  const push = (value: object) => {
    const line = JSON.stringify({ cwd, sessionId, ...value });
    lines.push(line);
    size += line.length + 1;
  };
  push({ type: 'ai-title', aiTitle: `Bench session ${sessionId.slice(0, 8)}` });
  while (size < bytes) {
    const at = new Date(startedAt + turn * 60_000).toISOString();
    push({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: `Prompt ${turn}: ${filler.slice(0, 200)}` }] } });
    push({ type: 'assistant', timestamp: at, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${turn}`, name: 'Read', input: { file_path: `${cwd}/src/file${turn}.ts` } }] } });
    push({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${turn}`, content: filler.repeat(1 + (turn % 6)) }] } });
    push({ type: 'assistant', timestamp: at, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `Reply ${turn}: ${filler.slice(0, 400)}` }] } });
    turn += 1;
  }
  return `${lines.join('\n')}\n`;
}

export function buildFixture(dir: string): Fixture {
  const configDir = path.join(dir, 'claude');
  const projects = path.join(configDir, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  const work = path.join(dir, 'Dropbox (Personal)', 'GenAI Company', 'Projects');
  const repos: FixtureRepo[] = [];
  for (let i = 0; i < GIT_REPOS + PLAIN_FOLDERS; i++) {
    const name = i < GIT_REPOS ? `repo-${String(i).padStart(2, '0')}` : `folder-${i - GIT_REPOS}`;
    const root = path.join(work, name);
    fs.mkdirSync(root, { recursive: true });
    const worktrees = [root];
    if (i < GIT_REPOS) {
      git(['init', '-q', '-b', 'main'], root);
      git(['commit', '-q', '--allow-empty', '-m', 'init'], root);
      if (i < LINKED_WORKTREES) {
        const linked = path.join(work, `${name}-feature`);
        git(['worktree', 'add', '-q', '-b', `feat/${name}`, linked], root);
        worktrees.push(linked);
      }
    }
    repos.push({ name, root, worktrees });
  }
  const now = Date.now();
  const transcripts: Fixture['transcripts'] = [];
  for (let i = 0; i < CHATS; i++) {
    const repo = repos[i % repos.length];
    const cwd = repo.worktrees[i % repo.worktrees.length];
    const sessionId = `${String(i).padStart(8, '0')}-bench-4000-8000-000000000000`;
    const projectDir = path.join(projects, encodeClaudeProjectPath(cwd));
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    const bytes = transcriptBytes(i);
    fs.writeFileSync(file, transcript(sessionId, cwd, bytes, now - (i + 1) * 3_600_000));
    transcripts.push({ sessionId, cwd, file, bytes: fs.statSync(file).size });
  }
  // Repos only discovery finds, and a dismissed folder with long sessions.
  const discoverable: FixtureRepo[] = [];
  const discoverableTranscripts: Fixture['discoverableTranscripts'] = [];
  const writeSession = (cwd: string, id: string, bytes: number, startedAt: number) => {
    const projectDir = path.join(projects, encodeClaudeProjectPath(cwd));
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, `${id}.jsonl`);
    fs.writeFileSync(file, transcript(id, cwd, bytes, startedAt));
    return { file, bytes: fs.statSync(file).size };
  };
  for (let i = 0; i < DISCOVERABLE_REPOS; i++) {
    const root = path.join(work, `found-${i}`);
    fs.mkdirSync(root, { recursive: true });
    discoverable.push({ name: `found-${i}`, root, worktrees: [root] });
    for (let j = 0; j < DISCOVERABLE_TRANSCRIPTS_EACH; j++) {
      const n = CHATS + i * DISCOVERABLE_TRANSCRIPTS_EACH + j;
      discoverableTranscripts.push(
        writeSession(root, `${String(n).padStart(8, '0')}-found-4000-8000-000000000000`, transcriptBytes(n), now - (n + 1) * 3_600_000)
      );
    }
  }
  const dismissed = path.join(work, 'dismissed');
  fs.mkdirSync(dismissed, { recursive: true });
  for (let i = 0; i < DISMISSED_LONG_TRANSCRIPTS; i++) {
    writeSession(dismissed, `${String(i).padStart(8, '0')}-long-4000-8000-000000000000`, LONG_TRANSCRIPT_BYTES, now - 2 * 86_400_000);
  }
  return { dir, configDir, repos, transcripts, discoverable, discoverableTranscripts, dismissed };
}

/**
 * Storage as a reload of a build without this one's caches finds it: every
 * repo and chat already stored, nothing else.
 */
export async function storedRepos(fixture: Fixture): Promise<BenchState> {
  const globalState = memento();
  const workspaceState = memento();
  const storage = makeStorage(globalState, workspaceState);
  const ids = new Map<string, string>();
  for (const repo of fixture.repos) {
    ids.set(repo.root, storage.addRepository(repo.name, repo.root, { origin: 'discovered' }).id);
  }
  for (const t of fixture.transcripts) {
    const repo = fixture.repos.find((candidate) => candidate.worktrees.includes(t.cwd))!;
    storage.createChat(worktreeId(ids.get(repo.root)!, t.cwd), 'claude', `Bench session ${t.sessionId.slice(0, 8)}`, {
      harnessSessionId: t.sessionId,
      autoImported: true,
    });
  }
  await storage.setDismissed(fixture.dismissed, Date.now());
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { globalState, workspaceState };
}

/**
 * The longest the event loop is blocked while `run` runs (counted as far as
 * this process burned CPU, so other load on the machine does not count), how
 * long it takes, and the CPU time this process spent on it.
 */
async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number; maxBlockMs: number; cpuMs: number }> {
  const blocks = watchEventLoopBlocks();
  try {
    const cpu = process.cpuUsage();
    const start = performance.now();
    const value = await run();
    const ms = performance.now() - start;
    const used = process.cpuUsage(cpu);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { value, ms, maxBlockMs: blocks.stop().maxBlockMs, cpuMs: (used.user + used.system) / 1000 };
  } finally {
    blocks.stop();
  }
}

export interface DiscoveryBench {
  folders: number;
  cold: { ms: number; maxBlockMs: number; cpuMs: number };
  warm: { ms: number; maxBlockMs: number; cpuMs: number };
}

/** Discovery alone over the profile: a cold pass, as after a start, then a warm one, as every minute. */
export async function discoveryPass(fixture: Fixture): Promise<DiscoveryBench> {
  process.env.CLAUDE_CONFIG_DIR = fixture.configDir;
  const discovery = new ClaudeRepoDiscovery(path.join(fixture.configDir, 'projects'), new ClaudeSessionService());
  const since = Date.now() - 14 * 86_400_000;
  const cold = await timed(() => discovery.discoverRecentFolders(since));
  const warm = await timed(() => discovery.discoverRecentFolders(since));
  return { folders: cold.value.length, cold, warm };
}

/** Records the transcripts read in full, by path. */
function watchTranscriptReads(): { reads: Set<string>; restore: () => void } {
  // The module object itself: an ES import binding cannot be reassigned.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeFs = require('fs') as typeof fs;
  const reads = new Set<string>();
  const note = (file: unknown) => {
    if (typeof file === 'string' && file.endsWith('.jsonl')) reads.add(file);
  };
  const readFileSync = nodeFs.readFileSync;
  const readFile = nodeFs.promises.readFile;
  (nodeFs as { readFileSync: unknown }).readFileSync = (file: unknown, ...rest: unknown[]) => {
    note(file);
    return (readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  };
  (nodeFs.promises as { readFile: unknown }).readFile = (file: unknown, ...rest: unknown[]) => {
    note(file);
    return (readFile as (...args: unknown[]) => unknown)(file, ...rest);
  };
  return {
    reads,
    restore: () => {
      (nodeFs as { readFileSync: unknown }).readFileSync = readFileSync;
      (nodeFs.promises as { readFile: unknown }).readFile = readFile;
    },
  };
}

/** One activation over `state`, which it updates as the real storage would. */
export async function runOnce(fixture: Fixture, state: BenchState): Promise<BenchRun> {
  process.env.CLAUDE_CONFIG_DIR = fixture.configDir;
  delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  const stub = vscode as unknown as {
    __reset(): void;
    __treeViews: { id: string; visible: boolean; options: { treeDataProvider: { getChildren(): Promise<unknown[]> } } }[];
    window: { createTreeView: (...args: unknown[]) => { visible: boolean } };
    __contextKeys: Map<string, unknown>;
  };
  stub.__reset();
  const contextKeys = stub.__contextKeys;
  disposeOperationLog();
  // The sidebar is showing, as on a reload with Pitwall open. The workbench
  // asks for rows over IPC, so the stub's synchronous first render is off.
  const createTreeView = stub.window.createTreeView;
  stub.window.createTreeView = (...args: unknown[]) => {
    const view = createTreeView(...args);
    view.visible = true;
    return view;
  };
  const { globalState, workspaceState } = state;
  const context = {
    subscriptions: [] as { dispose(): unknown }[],
    globalState,
    workspaceState,
    extensionUri: vscode.Uri.file('/extension'),
    extension: { id: 'sharifamlani.pitwall' },
  };
  const watch = watchTranscriptReads();
  // The loop's worst delay: a 1 ms interval's largest gap between runs.
  let maxBlockMs = 0;
  let last = performance.now();
  const lag = setInterval(() => {
    const now = performance.now();
    maxBlockMs = Math.max(maxBlockMs, now - last);
    last = now;
  }, 1);

  try {
    const start = performance.now();
    let firstRender: Promise<{ at: number; rows: number }> | undefined;
    const activation = activate(context as never);
    // The workbench's first request for the rows arrives as its own message.
    setImmediate(() => {
      const view = stub.__treeViews.find((candidate) => candidate.id === 'pitwall.workspacesView')!;
      firstRender = view.options.treeDataProvider.getChildren().then((rows) => ({ at: performance.now(), rows: rows.length }));
    });
    await activation;
    const activateMs = performance.now() - start;
    while (!firstRender) await new Promise((resolve) => setImmediate(resolve));
    const rendered = await firstRender;
    const deadline = Date.now() + 300_000;
    const stored = fixture.transcripts.map((t) => t.file);
    let scanMs: number | undefined;
    let discoveryMs: number | undefined;
    while ((scanMs === undefined || discoveryMs === undefined) && Date.now() < deadline) {
      if (scanMs === undefined && stored.every((file) => watch.reads.has(file))) scanMs = performance.now() - start;
      if (discoveryMs === undefined && contextKeys.get('pitwall.scanned') === true) discoveryMs = performance.now() - start;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Let the interval take its sample after the last block.
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Let background listings and writes that follow the scan land, as they
    // would before a later reload.
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      state,
      activateMs,
      firstRenderMs: rendered.at - start,
      firstRenderRows: rendered.rows,
      maxBlockMs,
      scanMs: scanMs ?? NaN,
      discoveryMs: discoveryMs ?? NaN,
    };
  } finally {
    clearInterval(lag);
    watch.restore();
    stub.window.createTreeView = createTreeView;
    context.subscriptions.forEach((subscription) => subscription.dispose());
    disposeOperationLog();
  }
}
