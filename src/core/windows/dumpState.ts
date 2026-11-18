import * as fs from 'fs';
import * as path from 'path';
import { NativeUiTabGroupState } from '../harness/types';
import { Repository } from '../types';

/** What the hidden `pitwall.dev.dumpState` command needs; wired by the extension. */
export interface DumpDeps {
  /** `<globalStorage>/pitwall-dump`. */
  dir: string;
  pid: number;
  /** Every tab group of this window, with each tab's bound session. */
  tabs: () => NativeUiTabGroupState[];
  windowFolder: () => string | undefined;
}

/**
 * The file `scripts/dump-tabs.mjs` reads, `<dir>/<pid>.json`. The shape is
 * versioned and stable (the evaluator's E5 and E13 diff it):
 *
 *   { version: 1, pid, windowFolder: string | null,
 *     tabGroups: [{ index, isActive, tabs: [{ label, pinned, active, sessionId: string | null }] }],
 *     repos: [{ name, rootPath, sidebarMainChatIds: string[] }] }
 *
 * Only ids, labels, folders and flags: never transcript text.
 */
export function writeDump(
  deps: DumpDeps,
  repos: { repo: Repository; sidebarMainChatIds: string[] }[]
): string {
  const dump = {
    version: 1,
    pid: deps.pid,
    windowFolder: deps.windowFolder() ?? null,
    tabGroups: deps.tabs().map((group) => ({
      ...group,
      tabs: group.tabs.map((tab) => ({ ...tab, sessionId: tab.sessionId ?? null })),
    })),
    repos: repos.map(({ repo, sidebarMainChatIds }) => ({ name: repo.name, rootPath: repo.rootPath, sidebarMainChatIds })),
  };
  fs.mkdirSync(deps.dir, { recursive: true });
  const file = path.join(deps.dir, `${deps.pid}.json`);
  const partial = `${file}.tmp`;
  fs.writeFileSync(partial, `${JSON.stringify(dump, null, 2)}\n`);
  fs.renameSync(partial, file);
  return file;
}
