import { HarnessModule } from '../../core/harness/module';
import { PiHarness } from './PiHarness';
import { PiSessionService } from './PiSessionService';
import { PiSessionWatcher } from './PiSessionWatcher';

export const piModule: HarnessModule = {
  id: 'pi',
  create({ storageService, worktreeCatalog }) {
    const piSessionService = new PiSessionService();
    return {
      adapter: new PiHarness({ sessionService: piSessionService }),
      watcher: new PiSessionWatcher(storageService, piSessionService, worktreeCatalog),
    };
  },
};
