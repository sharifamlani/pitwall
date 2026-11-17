import { HarnessId } from '../types';
import { StorageService } from '../services/StorageService';
import { WorktreeCatalog } from '../services/WorktreeCatalog';
import { HarnessAdapter, HarnessSessionWatcher } from './types';

/** What the composition root hands every harness when it builds one. */
export interface HarnessDeps {
  storageService: StorageService;
  worktreeCatalog: WorktreeCatalog;
}

/**
 * The one registration point of a harness: a factory for its adapter and, when
 * the agent has session files to watch, its watcher. Core never imports a
 * harness folder; `src/harnesses/index.ts` lists the modules.
 */
export interface HarnessModule {
  readonly id: HarnessId;
  create(deps: HarnessDeps): { adapter: HarnessAdapter; watcher?: HarnessSessionWatcher };
}
