#!/usr/bin/env node
/**
 * Status polls beside scans, at the owner's scale, outside the default suite
 * (it writes about 3.4 GB and its timing depends on the machine):
 *
 *   node test/bench/poll-scan-bench.js [scenario ...]
 *
 * The fixture is sized from the owner's profile (2026-11-20, counts and sizes
 * only, no transcript was read): 250 transcripts, 3.4 GB, 42 project folders
 * under 21 repositories plus the home folder (a discovered folder repo whose
 * listing matches every project folder), chats of 678, 326, 274 and 249 MB,
 * 133 transcripts over 1 MB. Four live chats are appended to all along, as the
 * agent team's are, and 17 session records sit in the sessions folder.
 *
 * A stand-in status poll (the sessions folder read, then ten open chats'
 * transcript paths and tail readings, as `getLiveStates` does) runs every
 * 250 ms beside each scenario, and the bench prints the slowest poll:
 *
 *   idle      no scan (the floor)
 *   warm      a settled window's 60 s import scan
 *   discovery a settled window's discovery pass
 *   cold      a window's first import scan
 *   rewritten a settled window's scan after its 678 MB chat lost its parse
 *   other     a settled window's polls while another process (a window
 *             opening) runs its first scan
 *
 * PITWALL_BENCH_DIR=<dir> keeps the fixture there and reuses it on the next
 * run (it is regenerated when missing). Otherwise it goes to a temp folder
 * that is removed afterwards.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const esbuild = require('esbuild');

const STUB = path.resolve(__dirname, '..', 'dry', 'vscode-stub.js');
const REPOS = 21;
const PROJECT_DIRS = 42;
const SESSIONS = 250;
/** The owner's largest chats, MB (2026-11-20). The first four are the live ones. */
const BIG_MB = [678, 326, 274, 249, 121, 108, 107, 76, 62, 48, 48, 45];
const LIVE = 4;
const OPEN_CHATS = 10;
const RECORDS = 17;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const CODE = Array.from({ length: 400 }, (_, i) => `  const value${i} = compute("${'x'.repeat(i % 40)}", { index: ${i}, label: 'line ${i}' }); // "quoted" \\ path\\to\\file`).join('\n');

/** One session's transcript, shaped like Claude Code's, written until it reaches `bytes`. */
async function writeTranscript(file, { sessionId, cwd, bytes, random, mtime }) {
  const out = fs.createWriteStream(file);
  let written = 0;
  let t = mtime - 3_600_000;
  let uuid = 0;
  const base = () => ({ parentUuid: `u-${uuid}`, isSidechain: false, userType: 'external', cwd, sessionId, version: '2.1.296', gitBranch: 'main', entrypoint: 'claude-vscode', uuid: `u-${++uuid}`, timestamp: new Date((t += 10)).toISOString() });
  const write = async (entry) => {
    const line = `${JSON.stringify(entry)}\n`;
    written += Buffer.byteLength(line);
    if (!out.write(line)) {
      await new Promise((resolve) => out.once('drain', resolve));
    }
  };
  let turn = 0;
  while (written < bytes) {
    turn++;
    await write({ ...base(), type: 'user', message: { role: 'user', content: `Please look at module ${turn} and fix the failing test "${turn}". It says: expected 3, got 4.` } });
    const tools = 2 + Math.floor(random() * (bytes > 1e8 ? 12 : 4));
    for (let i = 0; i < tools && written < bytes; i++) {
      const id = `toolu_${turn}_${i}`;
      await write({ ...base(), type: 'assistant', message: { id: `msg_${turn}_${i}`, role: 'assistant', model: 'claude', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `${cwd}\\src\\module${i}.ts` } }], stop_reason: 'tool_use' } });
      const text = CODE.slice(0, 2_000 + Math.floor(random() * (bytes > 1e8 ? 120_000 : 30_000)));
      await write({ ...base(), type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: text }] }, toolUseResult: { type: 'text', file: { filePath: `${cwd}\\src\\module${i}.ts`, content: text } } });
    }
    await write({ ...base(), type: 'assistant', message: { id: `msg_${turn}_end`, role: 'assistant', model: 'claude', content: [{ type: 'text', text: `Fixed module ${turn}.` }], stop_reason: 'end_turn' } });
    if (turn === 2) {
      await write({ type: 'ai-title', aiTitle: `Fix module tests ${sessionId.slice(0, 4)}`, sessionId });
    }
  }
  await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return written;
}

/** The fixture profile; returns the repositories, the home folder, and the session ids by role. */
async function makeFixture(dir) {
  const home = path.join(dir, 'home');
  const repos = Array.from({ length: REPOS }, (_, i) => path.join(home, `repo-${String(i + 1).padStart(2, '0')}`));
  const marker = path.join(dir, 'fixture.json');
  if (fs.existsSync(marker)) {
    return JSON.parse(fs.readFileSync(marker, 'utf8'));
  }
  const random = rng(79);
  // Two project folders per repo: its root, and a subfolder sessions started in.
  const folders = Array.from({ length: PROJECT_DIRS }, (_, i) => (i < REPOS ? repos[i] : path.join(repos[i - REPOS], 'sub')));
  const ids = [];
  let total = 0;
  const now = Date.now();
  for (let n = 0; n < SESSIONS; n++) {
    const cwd = folders[n % PROJECT_DIRS];
    fs.mkdirSync(cwd, { recursive: true });
    const project = path.join(dir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(project, { recursive: true });
    const sessionId = `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const bytes = n < BIG_MB.length ? BIG_MB[n] * 1048576 : n < 133 ? 1048576 + random() * 22e6 : 2e4 + random() * 1e6;
    // Half the transcripts were written in the last 14 days (discovery's window).
    const mtime = n < LIVE ? now : now - (n % 2 ? 1 : 20) * 86_400_000 * random();
    total += await writeTranscript(path.join(project, `${sessionId}.jsonl`), { sessionId, cwd, bytes, random, mtime });
    ids.push(sessionId);
  }
  const sessions = path.join(dir, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  for (let n = 0; n < RECORDS; n++) {
    fs.writeFileSync(path.join(sessions, `${1000 + n}.json`), JSON.stringify({ pid: 1000 + n, pidDomain: 'bench', sessionId: ids[n], cwd: home, status: n % 3 ? 'idle' : 'busy', statusUpdatedAt: now, entrypoint: 'claude-vscode' }));
  }
  const fixture = { home, repos, ids, total };
  fs.writeFileSync(marker, JSON.stringify(fixture));
  return fixture;
}

/** Appends to the live chats as busy agents do: a small line every 100 ms, a 40 KB tool result every second. */
function startAppends(dir, fixture) {
  const files = fixture.ids.slice(0, LIVE).map((id, n) => {
    const cwd = fixture.repos[n % REPOS];
    return path.join(dir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);
  });
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    for (const file of files) {
      const big = tick % 10 === 0;
      const line = big
        ? { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ tool_use_id: `toolu_live_${tick}`, type: 'tool_result', content: CODE.slice(0, 40_000) }] } }
        : { type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: `step ${tick}` }], stop_reason: tick % 7 ? 'tool_use' : 'end_turn' } };
      fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
    }
  }, 100);
  return () => clearInterval(timer);
}

function bundle() {
  const outfile = path.join(os.tmpdir(), `pitwall-poll-scan-bench-${process.pid}.cjs`);
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'poll-scan-bench.entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    alias: { vscode: STUB },
    logLevel: 'error',
  });
  return outfile;
}

function show(label, stats) {
  console.log(
    `[bench] ${label.padEnd(10)} work ${(stats.workMs / 1000).toFixed(2).padStart(6)} s | ${String(stats.polls).padStart(4)} polls, ` +
      `slowest ${stats.maxPollMs.toFixed(0).padStart(5)} ms, p95 ${stats.p95PollMs.toFixed(0).padStart(4)} ms, >=500 ms: ${stats.slowPolls}, loop held ${stats.maxLoopDelayMs.toFixed(0)} ms`
  );
}

async function main() {
  const wanted = process.argv.slice(2);
  const runs = (name) => wanted.length === 0 || wanted.includes(name);
  const keep = process.env.PITWALL_BENCH_DIR;
  const dir = keep ? path.resolve(keep) : fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-poll-bench-'));
  fs.mkdirSync(dir, { recursive: true });
  try {
    const started = Date.now();
    const fixture = await makeFixture(dir);
    console.log(`[bench] fixture: ${SESSIONS} transcripts, ${(fixture.total / 1073741824).toFixed(2)} GB (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    process.env.CLAUDE_CONFIG_DIR = dir;
    const outfile = bundle();
    const bench = require(outfile);
    // Every repository plus the home folder, as discovery stores them.
    const roots = [...fixture.repos, fixture.home];
    const open = [...fixture.ids.slice(0, LIVE), ...fixture.ids.slice(200, 200 + OPEN_CHATS - LIVE)];
    const stopAppends = startAppends(dir, fixture);
    try {
      const service = bench.newService();
      const poll = bench.makePoll(service, path.join(dir, 'sessions'), open);
      if (runs('cold')) {
        show('cold', await bench.pollsDuring(poll, () => bench.scan(service, roots)));
      } else {
        await bench.scan(service, roots);
      }
      if (runs('idle')) {
        show('idle', await bench.pollsDuring(poll, () => new Promise((resolve) => setTimeout(resolve, 5_000))));
      }
      if (runs('warm')) {
        show('warm', await bench.pollsDuring(poll, () => bench.scan(service, roots)));
      }
      if (runs('discovery')) {
        const pass = bench.discovery(path.join(dir, 'projects'), service);
        await pass();
        show('discovery', await bench.pollsDuring(poll, pass));
      }
      if (runs('rewritten')) {
        // A window that has parsed everything but the 678 MB chat (its parse
        // was lost), whose next scan must read that chat again whole.
        const fresh = bench.newService();
        await bench.scan(fresh, roots.slice(1, -1));
        show('rewritten', await bench.pollsDuring(bench.makePoll(fresh, path.join(dir, 'sessions'), open), () => bench.scan(fresh, roots)));
      }
      if (runs('other')) {
        // Another window opening: a separate process runs its first scan.
        const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(outfile)});const b=require(${JSON.stringify(outfile)});b.scan(b.newService(),${JSON.stringify(roots)}).then(()=>process.exit(0))`], {
          env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
          stdio: 'inherit',
        });
        show('other', await bench.pollsDuring(poll, () => new Promise((resolve) => child.on('exit', resolve))));
      }
      if (runs('storm')) {
        // The #79 gate's 16:25 moment: a window opens (its first scan) while
        // it loads 8 chats at once (each Claude process reads its transcript
        // whole), beside a second window doing the same.
        const exits = [];
        for (let w = 0; w < 2; w++) {
          exits.push(
            spawn(process.execPath, ['-e', `const b=require(${JSON.stringify(outfile)});b.scan(b.newService(),${JSON.stringify(roots)}).then(()=>process.exit(0))`], {
              env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
              stdio: 'inherit',
            })
          );
        }
        const chats = fixture.ids.slice(4, 12).map((id, n) => path.join(dir, 'projects', fixture.repos[(4 + n) % REPOS].replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`));
        for (const chat of chats) {
          exits.push(
            spawn(process.execPath, ['-e', `const rl=require('readline').createInterface({input:require('fs').createReadStream(${JSON.stringify(chat)})});let n=0;rl.on('line',(l)=>{n+=JSON.parse(l)?1:0});rl.on('close',()=>process.exit(0))`], { stdio: 'inherit' })
          );
        }
        show('storm', await bench.pollsDuring(poll, () => Promise.all(exits.map((child) => new Promise((resolve) => child.on('exit', resolve))))));
      }
    } finally {
      stopAppends();
      fs.rmSync(outfile, { force: true });
    }
  } finally {
    if (!keep) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
