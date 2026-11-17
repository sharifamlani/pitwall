#!/usr/bin/env node
/**
 * Read-only probe for Smoke S3 (Phase 3 Task 3, ADR 0019): the repo roots
 * Claude Code sessions ran in. It imports nothing from src/, so it is an
 * independent check of discovery, not the evaluator's ground truth (QA C1).
 *
 * Usage:
 *   node scripts/list-claude-repos.mjs [--days N] [--dir <projects folder>]
 *   node scripts/list-claude-repos.mjs --repo <root> [--all] [--days N]
 *
 * Default folder: $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects.
 * Default window: 14 days, by transcript mtime.
 *
 * Without --repo: prints one canonical repo root per line, sorted. A folder
 * maps to its main repo root through `git rev-parse --git-common-dir` (parent
 * of a `.git` common dir), else `--show-toplevel`; a folder outside git is its
 * own root, as is one in a bare repository. With --repo: prints every transcript whose folder maps to that
 * root, in the window, or of any age with --all.
 *
 * Each transcript's cwd is its first entry that has one, read up to 1 MB.
 * A summary goes to stderr: transcripts read, skipped (no cwd, unreadable),
 * folders gone from disk, roots. Exit 0; 2 on bad arguments.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const HEAD_MAX_BYTES = 1024 * 1024;

function parseArgs(argv) {
  const args = { days: 14, dir: null, repo: null, all: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--days') {
      args.days = Number(argv[++i]);
      if (!Number.isFinite(args.days) || args.days <= 0) {
        console.error('--days needs a positive number');
        process.exit(2);
      }
    } else if (arg === '--dir') {
      args.dir = argv[++i];
    } else if (arg === '--repo') {
      args.repo = argv[++i];
    } else if (arg === '--all') {
      args.all = true;
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (args.all && !args.repo) {
    console.error('--all needs --repo <root>');
    process.exit(2);
  }
  return args;
}

/** The comparison key for a folder: one string per folder, case-folded on Windows. */
function folderKey(value) {
  let real;
  try {
    real = fs.realpathSync.native(value);
  } catch {
    real = path.resolve(value);
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** The cwd and first timestamp of a transcript's head, or null. */
function readHead(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(HEAD_MAX_BYTES);
    const bytes = fs.readSync(fd, buffer, 0, HEAD_MAX_BYTES, 0);
    for (const line of buffer.subarray(0, bytes).toString('utf8').split('\n')) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry && typeof entry.cwd === 'string' && entry.cwd) {
        return entry.cwd;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** The main repo root a folder belongs to; the folder itself outside git. */
function rootFor(cwd, cache) {
  const cached = cache.get(cwd);
  if (cached !== undefined) return cached;
  let root;
  const top = git(['rev-parse', '--show-toplevel'], cwd)?.[0];
  if (top) {
    // Relative to the top level when asked from it, on any git version.
    const common = git(['rev-parse', '--git-common-dir'], top)?.[0];
    const commonDir = common ? path.resolve(top, common) : null;
    root = path.normalize(commonDir && path.basename(commonDir) === '.git' ? path.dirname(commonDir) : top);
  } else {
    // Outside a working tree (no git, or a bare repository): a folder repo.
    root = fs.realpathSync(cwd);
  }
  cache.set(cwd, root);
  return root;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const projectsDir = args.dir || path.join(configDir, 'projects');
  const since = args.all ? -Infinity : Date.now() - args.days * DAY_MS;
  const wanted = args.repo ? folderKey(args.repo) : null;

  const counts = { read: 0, skipped: 0, missing: 0 };
  const roots = new Map();
  const matches = [];
  const rootCache = new Map();
  let projects = [];
  try {
    projects = fs.readdirSync(projectsDir);
  } catch {
    console.error(`No projects folder at ${projectsDir}`);
  }
  for (const project of projects) {
    if (project.startsWith('.')) continue;
    const dir = path.join(projectsDir, project);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl') || name.startsWith('agent-')) continue;
      const file = path.join(dir, name);
      let stats;
      try {
        stats = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stats.isFile() || stats.mtimeMs < since) continue;
      counts.read += 1;
      const cwd = readHead(file);
      if (!cwd) {
        counts.skipped += 1;
        continue;
      }
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        counts.missing += 1;
        continue;
      }
      const root = rootFor(cwd, rootCache);
      if (wanted) {
        if (folderKey(root) === wanted) matches.push(file);
      } else if (![...roots.keys()].includes(folderKey(root))) {
        roots.set(folderKey(root), root);
      }
    }
  }

  const lines = wanted ? matches.sort() : [...roots.values()].sort((a, b) => a.localeCompare(b));
  for (const line of lines) console.log(line);
  console.error(
    `${counts.read} transcripts read, ${counts.skipped} skipped (no cwd or unreadable), ` +
      `${counts.missing} with a folder gone from disk; ` +
      (wanted ? `${matches.length} transcripts for that repo` : `${roots.size} roots`)
  );
}

main();
