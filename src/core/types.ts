import { randomUUID } from 'crypto';

/** A workspace root the user added: a git repository or a plain folder. */
export interface Repository {
  id: string;
  /** Folder name, shown in the tree. */
  name: string;
  /** Absolute path the user added; contains `.git` when it is a repository. */
  rootPath: string;
  /**
   * Soft-removed by pre-1.0 builds. Still honored so re-adding the
   * folder revives its id, which every worktree id (and chat) derives from.
   */
  hidden?: boolean;
  /**
   * How the root got here: added by hand, or found from the agent's session
   * history (P1). Absent on records written before Phase 3 (manual).
   */
  origin?: 'manual' | 'discovered';
  /**
   * When this window added the record. Two windows can add one root at once;
   * the merge keeps the oldest record (P17). Absent on older records, which
   * count as oldest. So a manual root added in two windows inside the echo
   * window drops the newer record (rare; discovered repos avoid it via P17).
   */
  addedAt?: number;
}

export interface Worktree {
  /** Deterministic: derived from the repository id and the canonical path. */
  id: string;
  repoId: string;
  /** Branch name, or the folder name when detached or not git. */
  name: string;
  /** The checked-out branch; absent when detached or not git. */
  branch?: string;
  path: string;
  isMain: boolean;
}

/**
 * The worktrees sessions can run in for a workspace root. A plain folder is
 * its own single worktree (`isGit: false`), so chats can attach before
 * `git init`.
 */
export interface RepositoryWorktrees {
  isGit: boolean;
  worktrees: Worktree[];
}

/**
 * A harness id: a key of `ALL_HARNESSES` (listed as `HARNESS_IDS` in
 * src/harnesses/index.ts). Core never enumerates them: whether an id is usable
 * is `HarnessRegistry.has(id)`, because stored records can name a harness this
 * build has switched off.
 */
export type HarnessId = string;

/** A session row Pitwall stores. The native session lives in the harness. */
export interface ChatSession {
  id: string;
  worktreeId: string;
  name: string;
  harness: HarnessId;
  /** Native session ID used to resume in the owning harness. */
  harnessSessionId: string | null;
  /**
   * ID chosen at launch for a harness that accepts one, before its transcript
   * exists. Cleared when the watcher links the native session.
   */
  pendingHarnessSessionId?: string | null;
  /**
   * Source session for an unlinked terminal fork. Reopening the chat before
   * the first prompt repeats the fork instead of starting a fresh session.
   */
  forkedFromSessionId?: string | null;
  /**
   * A chat started in the agent's VS Code UI. The UI assigns the native ID,
   * so the session importer links this chat when the session first appears.
   */
  pendingUiLaunch?: boolean;
  /**
   * Native sessions that already existed when the UI launch began, newest
   * first and bounded. Persisted so a reload between the launch and the first
   * prompt cannot make the importer claim an older session in the worktree.
   */
  pendingUiKnownSessionIds?: string[];
  /**
   * Imported automatically rather than created or imported by the user. Its
   * name may follow the harness's later title.
   */
  autoImported?: boolean;
  /** The user renamed this chat, so automatic naming must leave it alone. */
  customName?: boolean;
  /**
   * The "seen" baseline (P16): a turn that ended after it shows as finished.
   * Set at creation; records written before Phase 3 get it on first load.
   */
  seenAt?: number;
  /**
   * Another chat of the same native session that this one was merged into
   * (two windows imported the session at once). Kept in the store, hidden
   * from every read; its state moved to that chat.
   */
  mergedInto?: string;
  createdAt: number;
  lastAccessedAt: number;
  status: 'active' | 'idle' | 'closed';
}

/** One file in the Changes panel, relative to the worktree root. */
export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}

export interface PRInfo {
  number: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  url: string;
  /** The PR's source branch. */
  headRefName?: string;
}

export type TreeItemType = 'repository' | 'worktree' | 'chat';

/** Keys in VS Code `globalState`. Renaming one orphans users' stored data. */
export const STORAGE_KEYS = {
  REPOSITORIES: 'pitwall.repositories',
  CHATS: 'pitwall.chats',
  ACTIVE_CHAT: 'pitwall.activeChat',
  PR_WORKTREES: 'pitwall.prWorktrees',
  STARRED_CHATS: 'pitwall.starredChats',
  /**
   * Sessions the user removed from the tree. Auto-import must not resurrect
   * them while they are still inside the retention window.
   */
  REMOVED_SESSIONS: 'pitwall.removedSessions',
  /**
   * The pty PID each workspace last saw for a chat it launched. A matching
   * PID is the live agent after a reload; a different PID means VS Code
   * revived the tab as a new shell that needs resuming.
   */
  TERMINAL_PIDS: 'pitwall.terminalPids',
  /** Finished session searches, newest first and bounded. */
  SESSION_SEARCHES: 'pitwall.sessionSearches',
  /**
   * The model and effort the Find Session settings last described, with the
   * harness they belong to. Used to drop a choice when the harness changes.
   */
  SESSION_SEARCH_ENGINE_CHOICE: 'pitwall.sessionSearchEngineChoice',
  /** Repository roots the user dismissed, with when, by root path (P1). */
  DISMISSED_REPOS: 'pitwall.dismissedRepos',
  /**
   * Write stamps and removal tombstones for every guarded collection, by
   * collection key (see src/core/services/storageOverlay.ts).
   */
  WRITE_STAMPS: 'pitwall.writeStamps',
  /**
   * Each repository's last worktree listing, by repository id. The list
   * draws its first rows from it while git lists them again (E16).
   */
  WORKTREE_SNAPSHOT: 'pitwall.worktreeSnapshot',
} as const;

/** The harness, model, and effort that run a session search. */
export interface SessionSearchEngine {
  harness: HarnessId;
  /** Empty means the model configured in the harness. */
  model: string;
  /** Empty means the effort configured in the harness. */
  effort: string;
}

/**
 * A session a search found, as the harness's own record describes it. The
 * agent only names the session and quotes a prompt; everything else is read
 * back from the harness, so a match never carries a guessed folder or date.
 */
export interface SessionSearchMatch {
  harness: HarnessId;
  sessionId: string;
  cwd: string;
  title: string;
  lastUpdated: number | null;
  /** The agent's one-line reason. */
  reason: string;
  /** The user's prompt the agent quoted, when it is one of theirs. */
  prompt?: { text: string; timestamp: number | null };
}

/** One question asked of the session finder, and what it answered. */
export interface SessionSearchRecord {
  id: string;
  query: string;
  engine: SessionSearchEngine;
  startedAt: number;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  /** The agent's answer in plain text. */
  answer?: string;
  matches: SessionSearchMatch[];
  /** Sessions the agent named that the harness does not have. */
  discarded?: number;
  /** What the agent searched, oldest first and bounded. */
  activity: string[];
  error?: string;
  durationMs?: number;
}

/**
 * A random UUID v4. Chat IDs and the session IDs Pitwall chooses
 * (`--session-id`) both use it, so it must come from a secure source.
 */
export function generateId(): string {
  return randomUUID();
}
