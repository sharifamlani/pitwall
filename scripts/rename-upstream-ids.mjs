#!/usr/bin/env node
// Renames Agntree ids to Pitwall across tracked text files. Idempotent: a second run changes nothing.
// Usage: node scripts/rename-upstream-ids.mjs [--dry]
// Skips: whole files in SKIP_FILES / SKIP_PREFIXES, and any line containing "credit-allow" (upstream credit lines).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dry = process.argv.includes('--dry');

// Ordered: specific forms first so the generic ones do not eat them.
const TABLE = [
  ['An Agntree', 'A Pitwall'],
  ['an Agntree', 'a Pitwall'],
  ['github.com/subhashkhileri/agntree', 'github.com/sharifamlani/pitwall'],
  ['subhashkhileri.github.io/agntree', 'sharifamlani.github.io/pitwall'],
  ['subhashkhileri.agntree', 'sharifamlani.pitwall'],
  ['agntree.', 'pitwall.'],
  ['Agntree', 'Pitwall'],
  ['AGNTREE', 'PITWALL'],
  ['agntree', 'pitwall'],
];

const SKIP_FILES = new Set([
  'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CLAUDE.md', 'ROADMAP.md',
  'scripts/rename-upstream-ids.mjs', 'docs/windows-test-triage.md',
]);
const SKIP_PREFIXES = ['docs/superpowers/', 'docs/progress_reports/', 'docs/research/', 'transcripts/', '.packages/', 'node_modules/'];
const TEXT_EXT = /\.(ts|js|mjs|cjs|json|md|yml|yaml|sh|svg|txt|html|css|ps1)$|(^|\/)(Dockerfile|\.gitignore|\.vscodeignore|\.gitattributes)$/;

// Resource files whose names carry the old id (package.json references them by the renamed path).
const FILE_RENAMES = [
  ['resources/icons/agntree-activitybar.svg', 'resources/icons/pitwall-activitybar.svg'],
  ['resources/icons/agntree.png', 'resources/icons/pitwall.png'],
  ['resources/icons/agntree.svg', 'resources/icons/pitwall.svg'],
];

const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const counts = [];
let total = 0;

function applyTable(line) {
  let n = 0;
  let out = line;
  for (const [from, to] of TABLE) {
    const parts = out.split(from);
    n += parts.length - 1;
    out = parts.join(to);
  }
  return [out, n];
}

for (const f of files) {
  if (SKIP_FILES.has(f) || SKIP_PREFIXES.some((p) => f.startsWith(p)) || !TEXT_EXT.test(f)) continue;
  const abs = resolve(root, f);
  if (!existsSync(abs)) continue;
  const text = readFileSync(abs, 'utf8');
  let n = 0;
  const out = text.split(/(\r?\n)/).map((seg) => {
    if (/^\r?\n$/.test(seg) || seg.includes('credit-allow')) return seg;
    const [o, c] = applyTable(seg);
    n += c;
    return o;
  }).join('');
  if (f === 'package-lock.json') {
    // Only the root identity fields; dependency entries are never touched.
    const lock = JSON.parse(text);
    lock.name = 'pitwall'; lock.version = '0.2.0';
    if (lock.packages && lock.packages['']) { lock.packages[''].name = 'pitwall'; lock.packages[''].version = '0.2.0'; }
    const edited = JSON.stringify(lock, null, 2) + '\n';
    if (edited !== text) { n = 1; if (!dry) writeFileSync(abs, edited, 'utf8'); }
  } else if (f === 'package.json') {
    const pkg = JSON.parse(out);
    pkg.publisher = 'sharifamlani';
    pkg.displayName = 'Pitwall';
    pkg.description = 'Every Claude Code session across your repos, in one sidebar.';
    pkg.keywords = ['claude code', 'claude code sessions', 'session manager', 'resume session', 'fork session', 'session history', 'git worktree', 'worktree', 'cursor', 'vs code', 'status', 'notifications', 'ai agent', 'terminal'];
    pkg.version = '0.2.0';
    const edited = JSON.stringify(pkg, null, 2) + (out.endsWith('\n') ? '\n' : '');
    if (edited !== out) n += 1;
    if (n && !dry) writeFileSync(abs, edited, 'utf8');
  } else if (n && !dry) {
    writeFileSync(abs, out, 'utf8');
  }
  if (n) { counts.push([f, n]); total += n; }
}

for (const [from, to] of FILE_RENAMES) {
  if (existsSync(resolve(root, from))) {
    if (!dry) renameSync(resolve(root, from), resolve(root, to));
    counts.push([`${from} -> ${to}`, 1]);
    total += 1;
  }
}

counts.sort((a, b) => b[1] - a[1]);
for (const [f, n] of counts) console.log(`${String(n).padStart(5)}  ${f}`);
console.log(`${String(total).padStart(5)}  TOTAL across ${counts.length} files${dry ? ' (dry run)' : ''}`);
