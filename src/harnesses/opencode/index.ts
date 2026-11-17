import { HarnessModule } from '../../core/harness/module';
import { OpencodeHarness } from './OpencodeHarness';
import { OpencodeSessionWatcher } from './OpencodeSessionWatcher';

export const opencodeModule: HarnessModule = {
  id: 'opencode',
  create({ storageService, worktreeCatalog }) {
    const opencodeHarness = new OpencodeHarness();
    return {
      adapter: opencodeHarness,
      watcher: new OpencodeSessionWatcher(storageService, opencodeHarness, worktreeCatalog),
    };
  },
};
