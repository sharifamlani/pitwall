import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import * as vscode from 'vscode';
import type { build as esbuildBuild } from 'esbuild';
import { activate } from '../../../src/extension';
import { STORAGE_KEYS } from '../../../src/core/types';
import { chatRecord, memento, stub, waitFor } from '../support';

// The bundle runs from test/dry/.build, so the repo root is three levels up.
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src');
const CORE = path.join(SRC, 'core');
const HARNESSES = path.join(SRC, 'harnesses');

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return tsFiles(full);
    }
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Every static `from '...'`, side-effect `import '...'`, `require('...')` and dynamic `import('...')` specifier. */
function importSpecifiers(source: string): string[] {
  const patterns = [
    /\b(?:import|export)\s[^'"]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  return patterns.flatMap((re) => [...source.matchAll(re)].map((m) => m[1]));
}

test('core never imports from a harness folder', () => {
  assert.ok(fs.existsSync(CORE), 'src/core/ must exist');
  const files = tsFiles(CORE);
  assert.ok(files.length > 0, 'src/core/ must contain source files');
  const offenders: string[] = [];
  for (const file of files) {
    for (const spec of importSpecifiers(fs.readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) {
        continue;
      }
      const resolved = path.resolve(path.dirname(file), spec);
      if (resolved === HARNESSES || resolved.startsWith(HARNESSES + path.sep)) {
        offenders.push(`${path.relative(ROOT, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('extension.ts reaches harnesses only through harnesses/index', () => {
  const file = path.join(SRC, 'extension.ts');
  const harnessImports = importSpecifiers(fs.readFileSync(file, 'utf8')).filter((spec) => {
    if (!spec.startsWith('.')) {
      return false;
    }
    const resolved = path.resolve(path.dirname(file), spec);
    return resolved === HARNESSES || resolved.startsWith(HARNESSES + path.sep);
  });
  assert.ok(harnessImports.length > 0, 'extension.ts must import enabledHarnesses from ./harnesses');
  for (const spec of harnessImports) {
    assert.ok(spec === './harnesses' || spec === './harnesses/index', `forbidden harness import in extension.ts: ${spec}`);
  }
});

test('core reaches no harness folder, directly or transitively, in any import syntax', async () => {
  // Loaded at run time: the dry runner bundles this file, and esbuild cannot be bundled.
  const { build } = createRequire(__filename)('esbuild') as { build: typeof esbuildBuild };
  const files = tsFiles(CORE).map((file) => path.relative(ROOT, file).split(path.sep).join('/'));
  assert.ok(files.length > 0, 'src/core/ must contain source files');
  const result = await build({
    stdin: { contents: files.map((file) => `import './${file}';`).join('\n'), resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    external: ['vscode'],
    logLevel: 'silent',
  });
  const inputs = Object.keys(result.metafile.inputs).map((input) => input.split(path.sep).join('/'));
  assert.ok(inputs.some((input) => input.startsWith('src/core/')), 'the graph includes core files');
  const reached = inputs.filter((input) => input.startsWith('src/harnesses/') || input === 'src/extension.ts');
  assert.deepEqual(reached, []);
});

test('src/ holds only core, harnesses and extension.ts', () => {
  assert.deepEqual(fs.readdirSync(SRC).sort(), ['core', 'extension.ts', 'harnesses']);
});

// ---------------------------------------------------------------------------
// Q45 = A: Pitwall writes nothing under the Claude config dir, and opens only
// `*.json` in its sessions folder. A static grep can't resolve paths (QA C6),
// so these spy on fs at run time across a real activation, the first render
// and a sessions-file-triggered poll, with CLAUDE_CONFIG_DIR on a temp dir.
// ---------------------------------------------------------------------------

/** fs calls that create, change or delete something, with the argument positions that name a path. */
const WRITES: Record<string, number[]> = {
  writeFile: [0], appendFile: [0], mkdir: [0], rename: [0, 1], copyFile: [1], cp: [1], rm: [0], rmdir: [0], unlink: [0],
  truncate: [0], utimes: [0], symlink: [1], link: [1], chmod: [0], open: [0],
  writeFileSync: [0], appendFileSync: [0], mkdirSync: [0], renameSync: [0, 1], copyFileSync: [1], cpSync: [1], rmSync: [0],
  rmdirSync: [0], unlinkSync: [0], truncateSync: [0], utimesSync: [0], symlinkSync: [1], linkSync: [1], chmodSync: [0],
  openSync: [0], createWriteStream: [0],
};
/** fs calls that open, read or stat a file. */
const READS = ['readFile', 'readFileSync', 'open', 'openSync', 'createReadStream', 'stat', 'statSync', 'lstat', 'lstatSync', 'access', 'accessSync', 'existsSync'];

/** An open flag that can change the file: anything but plain read. */
function writesFlag(flags: unknown): boolean {
  if (typeof flags === 'number') {
    return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0;
  }
  return typeof flags === 'string' && /[wax+]/.test(flags);
}

interface FsCall {
  method: string;
  file: string;
}

/** Wraps the real fs (sync, callback and promises APIs) and records every write and read; returns the restore. */
function spyOnFs(writes: FsCall[], reads: FsCall[]): () => void {
  // The real module object: the bundled `import * as fs` reads its members through getters.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realFs = require('fs') as Record<string, unknown> & { promises: Record<string, unknown> };
  const restore: (() => void)[] = [];
  const wrap = (target: Record<string, unknown>, method: string, label: string) => {
    const original = target[method];
    if (typeof original !== 'function') {
      return;
    }
    target[method] = function (this: unknown, ...args: unknown[]) {
      const opens = method === 'open' || method === 'openSync';
      if (method in WRITES && (!opens || writesFlag(args[1]))) {
        for (const index of WRITES[method]) {
          if (args[index] !== undefined) writes.push({ method: label, file: String(args[index]) });
        }
      }
      if (READS.includes(method) && (!opens || !writesFlag(args[1]))) {
        reads.push({ method: label, file: String(args[0]) });
      }
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    restore.push(() => (target[method] = original));
  };
  for (const method of new Set([...Object.keys(WRITES), ...READS])) {
    wrap(realFs, method, method);
    wrap(realFs.promises, method, `promises.${method}`);
  }
  return () => restore.forEach((undo) => undo());
}

const under = (dir: string, file: string) => {
  const resolved = path.resolve(file).toLowerCase();
  const root = path.resolve(dir).toLowerCase();
  return resolved === root || resolved.startsWith(root + path.sep);
};

let activationRun: Promise<{ claudeDir: string; writes: FsCall[]; reads: FsCall[] }> | undefined;
const cleanups: (() => unknown)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

/** One activation over a temp Claude profile with a live session, its first render, and a poll the sessions watcher triggers. */
function activateOverTempClaude(): Promise<{ claudeDir: string; writes: FsCall[]; reads: FsCall[] }> {
  activationRun ??= (async () => {
    stub.__reset();
    stub.__setTreeViewsVisible(true);
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-arch-')));
    cleanups.push(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
    const claudeDir = path.join(root, 'claude');
    const sessions = path.join(claudeDir, 'sessions');
    fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
    fs.mkdirSync(sessions, { recursive: true });
    const sessionId = '5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
    const record = (status: string, stamp: number) =>
      JSON.stringify({ pid: process.pid, sessionId, pidDomain: localPidDomainSync(), cwd: root, status, statusUpdatedAt: stamp });
    fs.writeFileSync(path.join(sessions, `${process.pid}.json`), record('busy', Date.now()));
    fs.writeFileSync(path.join(sessions, `${process.pid}.0123456789abcdef.key`), 'not for pitwall');
    const savedEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    cleanups.push(() => (savedEnv === undefined ? delete process.env.CLAUDE_CONFIG_DIR : (process.env.CLAUDE_CONFIG_DIR = savedEnv)));

    const globalState = memento();
    await globalState.update(STORAGE_KEYS.CHATS, [chatRecord({ id: 'arch-chat', harnessSessionId: sessionId, status: 'idle', seenAt: 1 })]);
    const context = {
      subscriptions: [] as { dispose(): unknown }[],
      globalState,
      workspaceState: memento(),
      extensionUri: vscode.Uri.file('/extension'),
      extension: { id: 'sharifamlani.pitwall' },
      globalStorageUri: vscode.Uri.file(path.join(root, 'globalStorage')),
    };
    cleanups.push(() => context.subscriptions.forEach((subscription) => subscription.dispose()));

    const writes: FsCall[] = [];
    const reads: FsCall[] = [];
    let restore = spyOnFs(writes, reads);
    cleanups.push(() => restore());
    try {
      await activate(context as never);
      const list = stub.__treeViews.find((view) => view.id === 'pitwall.workspacesView')!;
      await list.options.treeDataProvider!.getChildren();
      const operations = () => stub.__outputChannels.find((channel) => channel.name === 'Pitwall Operations')?.lines ?? [];
      await waitFor(() => operations().some((line) => line.includes('[Pitwall] first render')), 'the first render', 5_000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // A status change (Claude's write, not Pitwall's: the spy is off for it). The watcher re-polls within 150 ms.
      restore();
      fs.writeFileSync(path.join(sessions, `${process.pid}.json`), record('waiting', Date.now()));
      restore = spyOnFs(writes, reads);
      await new Promise((resolve) => setTimeout(resolve, 800));
    } finally {
      restore();
    }
    return { claudeDir, writes, reads };
  })();
  return activationRun;
}

/** Mirrors localPidDomain() for this machine, synchronously (the fixture is written before activation). */
function localPidDomainSync(): string {
  if (process.platform === 'win32') {
    return `win32:${os.hostname().toLowerCase()}`;
  }
  if (process.platform !== 'linux') {
    return process.platform;
  }
  const machineId = (() => {
    try {
      return fs.readFileSync('/etc/machine-id', 'utf8').trim();
    } catch {
      return '';
    }
  })();
  const pidNamespace = (() => {
    try {
      return fs.readlinkSync('/proc/self/ns/pid');
    } catch {
      return '';
    }
  })();
  return `linux:${machineId}:${pidNamespace}`;
}

test('no write call targets claudeConfigDir', async () => {
  const { claudeDir, writes, reads } = await activateOverTempClaude();
  assert.ok(writes.length > 0, 'the spy saw Pitwall write its own files (global storage), so it is live');
  assert.ok(reads.some((call) => call.file.endsWith('.json') && under(path.join(claudeDir, 'sessions'), call.file)), 'a poll read the sessions folder');
  assert.deepEqual(
    writes.filter((call) => under(claudeDir, call.file)).map((call) => `${call.method} ${path.relative(claudeDir, call.file)}`),
    [],
    'nothing created, changed or deleted under the Claude config dir'
  );
});

test('sessions folder reads filter on .json before open', async () => {
  const { claudeDir, reads } = await activateOverTempClaude();
  const sessions = path.join(claudeDir, 'sessions');
  const opened = reads.filter((call) => under(sessions, call.file) && path.resolve(call.file) !== path.resolve(sessions));
  assert.ok(opened.length > 0, 'the poll opened session files');
  assert.deepEqual(opened.filter((call) => !call.file.endsWith('.json')).map((call) => `${call.method} ${path.basename(call.file)}`), [], 'only *.json is ever opened, read or stat-ed');
});

test('no code path calls tabGroups.close or moveEditor outside side by side and the user-requested closes', () => {
  // Q14: Pitwall never closes, moves or rebuilds a tab unless the user asked: the split, "switch to terminal" (closeSurface) and the changes view's own tab.
  const allowed = new Set(['src/core/windows/sideBySide.ts', 'src/core/harness/kit/NativeUiTabSurfaceService.ts', 'src/core/commands/changes.ts']);
  const offenders = tsFiles(SRC)
    .map((file) => path.relative(ROOT, file).split(path.sep).join('/'))
    .filter((file) => !allowed.has(file) && /tabGroups\s*\.\s*close|moveEditor/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
  assert.deepEqual(offenders, []);
  const split = fs.readFileSync(path.join(SRC, 'core', 'windows', 'sideBySide.ts'), 'utf8');
  assert.ok(/moveEditor/.test(split) && !/tabGroups\s*\.\s*close/.test(split), 'the split only moves editors, never closes them');
  const tracker = fs.readFileSync(path.join(SRC, 'core', 'harness', 'kit', 'NativeUiTabSurfaceService.ts'), 'utf8');
  assert.equal((tracker.match(/tabGroups\s*\.\s*close/g) ?? []).length, 1, 'the tracker closes a tab only in closeSurface');
  assert.ok(!/moveEditor/.test(tracker));
});
