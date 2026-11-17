import { HarnessModule } from '../../core/harness/module';
import { ClaudeHarness } from './ClaudeHarness';
import { ClaudeSessionService } from './ClaudeSessionService';
import { ClaudeSessionWatcher } from './ClaudeSessionWatcher';

export const claudeModule: HarnessModule = {
  id: 'claude',
  create({ storageService }) {
    const claudeSessionService = new ClaudeSessionService();
    return {
      adapter: new ClaudeHarness({ sessionService: claudeSessionService }),
      watcher: new ClaudeSessionWatcher(storageService, claudeSessionService),
    };
  },
};
