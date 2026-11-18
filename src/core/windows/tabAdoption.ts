import * as vscode from 'vscode';
import { ChatSession } from '../types';
import { HarnessAdapter, HarnessSession, NativeUiTitleCandidate } from '../harness/types';
import { samePath } from '../utils/paths';

/** Candidates are rebuilt at most this often: the tracker asks on every tab event. */
const CANDIDATES_TTL_MS = 500;

export interface TabAdoptionDeps {
  /** This window's folder (`workspaceFolders[0]`): the only folder its agent panel runs sessions in. */
  folder: string | undefined;
  adapters: readonly Pick<HarnessAdapter, 'id' | 'nativeUi' | 'listSessionsForWorktree'>[];
  /** Every chat row. */
  chats: () => readonly ChatSession[];
  /** A chat's worktree folder, when the list knows it. */
  worktreePathOf: (chat: ChatSession) => string | undefined;
  /** Each session listing a scan makes (the importer's), for titles that change later. */
  onSessionsListed?: vscode.Event<HarnessSession[]>;
  /** The folder's listing starts once this settles (after the first handoff claim, I3). */
  listAfter?: PromiseLike<unknown>;
  now?: () => number;
}

/**
 * Adopt the agent tabs Pitwall did not open (live I1): tabs restored after a
 * reload or a relaunch, reopened by the editor's session restore, or opened
 * before activation. A panel here only runs sessions of this window's folder,
 * so the candidates are that folder's sessions: their agent titles (Claude's
 * `ai-title`, which is the tab's title) from the folder's listing and later
 * scans, and their row names. The tracker binds a tab only when its title
 * names exactly one of them. Started after the first render; nothing here
 * blocks: the listing runs in the background and the tracker adopts when it
 * lands. An empty window has no folder and adopts nothing.
 */
export function startTabAdoption(deps: TabAdoptionDeps): vscode.Disposable {
  const folder = deps.folder;
  const disposables: vscode.Disposable[] = [];
  if (!folder) {
    return { dispose: () => undefined };
  }
  const now = deps.now ?? (() => Date.now());
  for (const adapter of deps.adapters) {
    const surfaces = adapter.nativeUi?.surfaces;
    if (!surfaces?.setTitleSource) {
      continue;
    }
    /** Agent titles of this folder's sessions, by session id. */
    const agentTitles = new Map<string, string>();
    let cached: { at: number; candidates: NativeUiTitleCandidate[] } | undefined;
    const note = (sessions: readonly HarnessSession[]): boolean => {
      let changed = false;
      for (const session of sessions) {
        const title = session.summary?.trim();
        if (session.harness === adapter.id && title && samePath(session.cwd, folder) && agentTitles.get(session.sessionId) !== title) {
          agentTitles.set(session.sessionId, title);
          changed = true;
        }
      }
      if (changed) {
        cached = undefined;
      }
      return changed;
    };
    const source = (): readonly NativeUiTitleCandidate[] => {
      if (cached && now() - cached.at < CANDIDATES_TTL_MS) {
        return cached.candidates;
      }
      const titles = new Map<string, Set<string>>();
      const add = (sessionId: string, title: string) => titles.set(sessionId, (titles.get(sessionId) ?? new Set()).add(title));
      for (const [sessionId, title] of agentTitles) {
        add(sessionId, title);
      }
      for (const chat of deps.chats()) {
        const worktreePath = chat.harness === adapter.id && chat.harnessSessionId ? deps.worktreePathOf(chat) : undefined;
        if (worktreePath && samePath(worktreePath, folder)) {
          add(chat.harnessSessionId!, chat.name);
        }
      }
      cached = { at: now(), candidates: [...titles].map(([sessionId, set]) => ({ sessionId, titles: [...set] })) };
      return cached.candidates;
    };
    const ready = Promise.resolve(deps.listAfter)
      .then(() => adapter.listSessionsForWorktree(folder))
      .then((sessions) => void note(sessions))
      .catch(() => undefined);
    // The tracker adopts once the listing has landed, not before: a title
    // only proves a tab's chat against the folder's whole list of sessions.
    surfaces.setTitleSource(source, ready);
    if (deps.onSessionsListed) {
      disposables.push(
        deps.onSessionsListed((sessions) => {
          if (note(sessions)) {
            surfaces.adopt?.();
          }
        })
      );
    }
  }
  return { dispose: () => disposables.forEach((disposable) => disposable.dispose()) };
}
