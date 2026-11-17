import { HarnessModule } from '../../core/harness/module';
import { CodexHarness } from './CodexHarness';
import { CodexSessionWatcher } from './CodexSessionWatcher';

export const codexModule: HarnessModule = {
  id: 'codex',
  create({ storageService, worktreeCatalog }) {
    const codexHarness = new CodexHarness();
    return {
      adapter: codexHarness,
      watcher: new CodexSessionWatcher(storageService, codexHarness, worktreeCatalog),
    };
  },
};
