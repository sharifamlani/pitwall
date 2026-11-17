/**
 * E16 startup bench, bundled by first-render-bench.js with the dry-test
 * `vscode` stub. The real extension activates over a synthetic profile shaped
 * like the one the live bug was measured on: 17 stored repos (12 git repos,
 * 3 of them with a linked worktree, and 5 plain folders), 129 stored Claude
 * chats, and their transcripts at realistic sizes (about 1 MB on average,
 * from 50 KB to 5 MB). Real git, real files; only the editor is a stub.
 *
 * What it measures, from the moment `activate()` is called:
 *   - activateMs: until `activate()` settles (the exthost "activate call").
 *   - firstRenderMs: until the Repos list answers the workbench's first
 *     request for its rows. The workbench asks over IPC, so the request is a
 *     new macrotask posted right after `activate()` returns.
 *   - maxBlockMs: the longest the event loop was blocked (the largest gap
 *     between runs of a 1 ms interval) until the first import scan ended. Nothing else, a
 *     render included, can run while the loop is blocked.
 *   - scanMs: until every transcript has been parsed once (the first scan).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate } from '../../src/extension';
import { worktreeId } from '../../src/core/services/GitService';
import { encodeClaudeProjectPath } from '../../src/harnesses/claude/paths';
import { disposeOperationLog } from '../../src/core/services/OperationLog';
import { makeStorage, memento } from '../dry/support';

interface FixtureRepo {
  name: string;
  root: string;
  /** Where its sessions ran: the root, then any linked worktree. */
  worktrees: string[];
}

export interface Fixture {
  dir: string;
  configDir: string;
  repos: FixtureRepo[];
  transcripts: { sessionId: string; cwd: string; file: string; bytes: number }[];
}

export interface BenchRun {
  activateMs: number;
  firstRenderMs: number;
  firstRenderRows: number;
  maxBlockMs: number;
  scanMs: number;
}

const GIT_REPOS = 12;
const PLAIN_FOLDERS = 5;
const LINKED_WORKTREES = 3;
const CHATS = 129;

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
  return { dir, configDir, repos, transcripts };
}

/** Storage as a reload finds it: every repo and chat already stored. */
async function reloadStorage(fixture: Fixture) {
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
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { globalState, workspaceState };
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

export async function runOnce(fixture: Fixture): Promise<BenchRun> {
  process.env.CLAUDE_CONFIG_DIR = fixture.configDir;
  delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  const stub = vscode as unknown as {
    __reset(): void;
    __treeViews: { id: string; visible: boolean; options: { treeDataProvider: { getChildren(): Promise<unknown[]> } } }[];
    window: { createTreeView: (...args: unknown[]) => { visible: boolean } };
  };
  stub.__reset();
  disposeOperationLog();
  // The sidebar is showing, as on a reload with Pitwall open. The workbench
  // asks for rows over IPC, so the stub's synchronous first render is off.
  const createTreeView = stub.window.createTreeView;
  stub.window.createTreeView = (...args: unknown[]) => {
    const view = createTreeView(...args);
    view.visible = true;
    return view;
  };
  const { globalState, workspaceState } = await reloadStorage(fixture);
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
    while (watch.reads.size < fixture.transcripts.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const scanMs = performance.now() - start;
    // Let the interval take its sample after the last block.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { activateMs, firstRenderMs: rendered.at - start, firstRenderRows: rendered.rows, maxBlockMs, scanMs };
  } finally {
    clearInterval(lag);
    watch.restore();
    stub.window.createTreeView = createTreeView;
    context.subscriptions.forEach((subscription) => subscription.dispose());
    disposeOperationLog();
  }
}
