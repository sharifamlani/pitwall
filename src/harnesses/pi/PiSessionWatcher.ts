import { StorageService } from '../../core/services/StorageService';
import { WorktreeCatalog } from '../../core/services/WorktreeCatalog';
import {
  PiSessionService,
  piSessionIdFromFileName,
} from './PiSessionService';
import {
  ExactIdSessionSource,
  ExactIdSessionWatcher,
} from '../../core/harness/kit/ExactIdSessionWatcher';

/**
 * Links a chat's chosen pending session ID to the Pi record written on the
 * first prompt. Pi accepts `--session-id`, so the record is named with the ID
 * Pitwall chose; there is no claim-the-newest step.
 *
 * The worktree catalog lets restored chats be looked up in their worktree's
 * `sessionDir` override instead of every Pi profile directory.
 */
export class PiSessionWatcher extends ExactIdSessionWatcher {
  constructor(
    storageService: StorageService,
    sessionService: PiSessionService,
    worktrees?: Pick<WorktreeCatalog, 'worktrees'>
  ) {
    super('pi', storageService, piSource(sessionService), worktrees);
  }
}

function piSource(sessionService: PiSessionService): ExactIdSessionSource {
  return {
    watchRoots: (worktreePaths) => sessionService.getWatchRoots(worktreePaths),
    watchDirs: (worktreePaths) =>
      sessionService.getSessionDirsForWatch(worktreePaths),
    sessionIdForFile: piSessionIdFromFileName,
    isResumable: (sessionId, worktreePath) =>
      sessionService.isSessionResumable(sessionId, worktreePath),
    getSummary: async (sessionId, worktreePath) =>
      (await sessionService.getSessionById(sessionId, worktreePath))?.summary ??
      null,
  };
}
