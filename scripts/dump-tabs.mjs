#!/usr/bin/env node
/**
 * Prints the tab state each Pitwall window wrote with `pitwall.dev.dumpState`
 * (hidden from the palette; run it from the command line with
 * `cursor --command` or the "Developer: Run Command" quick input). The
 * evaluator's E5 and E13 diff this output, so its shape is stable.
 *
 *   node scripts/dump-tabs.mjs --repo <name> [--dir <pitwall-dump folder>]
 *   node scripts/dump-tabs.mjs [--dir <pitwall-dump folder>]
 *   add --include-dead to list dumps from windows that have closed
 *
 * --dir     The `pitwall-dump` folder in the extension's global storage. Default:
 *           $PITWALL_DUMP_DIR, else the newest `*\pitwall-dump` under
 *           %APPDATA%\Cursor\User\globalStorage (or ~/.config on other systems).
 * --repo    A repo's name or root folder. Exits 1 if no window's dump lists it.
 * --include-dead
 *           Also list dumps whose window process is gone (by default a dump is
 *           listed only while its pid is alive).
 *
 * With --repo, stdout is one JSON object:
 *
 *   { "repo": "<name>", "rootPath": "<folder>",
 *     "sidebarMainChatIds": ["<session id>", ...],   // the repo's main-folder sidebar chats, newest first
 *     "windows": [                                   // windows whose folder is the repo's main folder
 *       { "pid": 1234, "windowFolder": "<folder>",
 *         "boundTabIds": ["<session id>", ...],      // tab order across groups; unbound tabs are left out
 *         "tabGroups": [ { "index": 0, "isActive": true,
 *                          "tabs": [ { "label": "...", "pinned": false, "active": true, "sessionId": "<id>" | null } ] } ] } ] }
 *
 * Without --repo: { "windows": [ { pid, windowFolder, boundTabIds, tabGroups, repos } ] } for every dump.
 * `repos` in a dump is [{ name, rootPath, sidebarMainChatIds }]. Ids, labels,
 * folders and flags only; never transcript text. Exit codes: 0 ok, 1 not
 * found, 2 bad input.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

function fail(code, message) {
  process.stderr.write(`dump-tabs: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const options = { dir: undefined, repo: undefined, includeDead: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--include-dead') {
      options.includeDead = true;
    } else if (arg === '--dir' || arg === '--repo') {
      const value = argv[++i];
      if (!value) {
        fail(2, `${arg} needs a value`);
      }
      options[arg.slice(2)] = value;
    } else {
      fail(2, `unknown argument: ${arg}`);
    }
  }
  return options;
}

/** The newest `pitwall-dump` folder under the editor's global storage. */
function findDumpDir() {
  const roots =
    process.platform === 'win32'
      ? [path.join(process.env.APPDATA ?? '', 'Cursor', 'User', 'globalStorage'), path.join(process.env.APPDATA ?? '', 'Code', 'User', 'globalStorage')]
      : [path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage'), path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage')];
  const found = [];
  for (const root of roots) {
    for (const entry of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      const dir = path.join(root, entry, 'pitwall-dump');
      if (fs.existsSync(dir)) {
        found.push({ dir, at: fs.statSync(dir).mtimeMs });
      }
    }
  }
  found.sort((a, b) => b.at - a.at);
  return found[0]?.dir;
}

/** Whether a process with this pid is running (signal 0 tests without sending anything). */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

const key = (folder) => (folder ? path.resolve(folder).replace(/[\\/]+$/, '').toLowerCase() : '');

const options = parseArgs(process.argv.slice(2));
const dir = options.dir ?? process.env.PITWALL_DUMP_DIR ?? findDumpDir();
if (!dir || !fs.existsSync(dir)) {
  fail(2, 'no pitwall-dump folder found; pass --dir or run pitwall.dev.dumpState first');
}

const dumps = fs
  .readdirSync(dir)
  .filter((name) => /^\d+\.json$/.test(name))
  .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
  .filter((dump) => dump.version === 1)
  .filter((dump) => options.includeDead || isAlive(dump.pid))
  .sort((a, b) => a.pid - b.pid);

const boundTabIds = (dump) => [
  ...new Set(dump.tabGroups.flatMap((group) => group.tabs.flatMap((tab) => (tab.sessionId ? [tab.sessionId] : [])))),
];
const windowOf = (dump) => ({ pid: dump.pid, windowFolder: dump.windowFolder, boundTabIds: boundTabIds(dump), tabGroups: dump.tabGroups });

if (!options.repo) {
  process.stdout.write(`${JSON.stringify({ windows: dumps.map((dump) => ({ ...windowOf(dump), repos: dump.repos })) }, null, 2)}\n`);
} else {
  const isRepo = (repo) => repo.name === options.repo || key(repo.rootPath) === key(options.repo);
  const repo = dumps.flatMap((dump) => dump.repos.filter(isRepo))[0];
  if (!repo) {
    fail(1, `no dump in ${dir} lists a repo "${options.repo}"`);
  }
  const windows = dumps.filter((dump) => key(dump.windowFolder) === key(repo.rootPath)).map(windowOf);
  process.stdout.write(
    `${JSON.stringify({ repo: repo.name, rootPath: repo.rootPath, sidebarMainChatIds: repo.sidebarMainChatIds, windows }, null, 2)}\n`
  );
}
