import * as fs from 'fs';
import * as path from 'path';
import { NativeUiTabGroupState } from '../harness/types';
import { SessionStatus } from '../providers/sessionStatus';
import { Repository } from '../types';

/** What the hidden `pitwall.dev.dumpState` command needs; wired by the extension. */
export interface DumpDeps {
  /** `<globalStorage>/pitwall-dump`. */
  dir: string;
  pid: number;
  /** Every tab group of this window, with each tab's bound session. */
  tabs: () => NativeUiTabGroupState[];
  windowFolder: () => string | undefined;
  /** Every listed session's row status, by native session ID (Phase 5 GT: compare-status --dump). */
  statuses?: () => Record<string, SessionStatus>;
  /** The needs / working / finished counts over the sidebar list (Phase 5 E8). */
  counts?: () => { needs: number; working: number; finished: number };
}

/**
 * The file `scripts/dump-tabs.mjs` reads, `<dir>/<pid>.json`. The shape is
 * versioned and stable (the evaluator's E5 and E13 diff it); Phase 5 adds two
 * keys without changing the others:
 *
 *   { version: 1, pid, windowFolder: string | null,
 *     tabGroups: [{ index, isActive, tabs: [{ label, pinned, active, sessionId: string | null }] }],
 *     repos: [{ name, rootPath, sidebarMainChatIds: string[] }],
 *     statuses: { [sessionId]: 'needs' | 'working' | 'finished' | 'idle' },
 *     counts: { needs, working, finished } }
 *
 * Only ids, labels, folders, statuses and flags: never transcript text.
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
    statuses: deps.statuses?.() ?? {},
    counts: deps.counts?.() ?? { needs: 0, working: 0, finished: 0 },
  };
  fs.mkdirSync(deps.dir, { recursive: true });
  const file = path.join(deps.dir, `${deps.pid}.json`);
  const partial = `${file}.tmp`;
  fs.writeFileSync(partial, `${JSON.stringify(dump, null, 2)}\n`);
  fs.renameSync(partial, file);
  return file;
}
