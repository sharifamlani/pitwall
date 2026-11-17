import { HarnessSession } from '../harness/types';
import { Worktree } from '../types';
import { canonicalPath, deepestContainingRoot } from '../utils/paths';
import { GitService } from './GitService';
import { StorageService } from './StorageService';

/** A workspace root and the worktrees git lists for it. */
export interface Scope {
  repoRoot: string;
  worktrees: Worktree[];
}

/** Listing worktrees is a git call per root; pollers ask often. */
const TTL_MS = 15_000;

/**
 * Every worktree Pitwall knows across all workspace roots, and which of them
 * owns a session: the deepest one containing the session's directory. Roots
 * can nest (a `Documents` root holding a repository that is a root of its
 * own), and a harness lists a parent directory's sessions with those of its
 * subdirectories, so a per-root view would hand the inner root's sessions to
 * the outer one.
 */
export class WorktreeCatalog {
  private cache: { fetchedAt: number; scopes: Scope[] } | undefined;
  /** The asynchronous listing in flight, shared by concurrent callers. */
  private listing: Promise<Scope[]> | undefined;

  constructor(
    private readonly storageService: StorageService,
    private readonly gitService: GitService
  ) {}

  /**
   * Every root's worktrees. Lists synchronously when the cache is stale,
   * which blocks the extension host for one git call per root: startup and
   * the session scan use `scopesAsync`, and commands find the cache warm.
   */
  scopes(force = false): Scope[] {
    if (!force && this.cache && Date.now() - this.cache.fetchedAt < TTL_MS) {
      return this.cache.scopes;
    }
    const scopes: Scope[] = [];
    for (const repo of this.storageService.getRepositories()) {
      const { worktrees } = this.gitService.listRepositoryWorktrees(repo.rootPath, repo.id);
      if (worktrees.length > 0) {
        scopes.push({ repoRoot: repo.rootPath, worktrees });
      }
    }
    this.cache = { fetchedAt: Date.now(), scopes };
    return scopes;
  }

  /**
   * `scopes` without blocking: git lists every root at once as child
   * processes. Concurrent callers share one listing; it fills the cache the
   * synchronous lookups read.
   */
  scopesAsync(force = false): Promise<Scope[]> {
    if (!force && this.cache && Date.now() - this.cache.fetchedAt < TTL_MS) {
      return Promise.resolve(this.cache.scopes);
    }
    if (!force && this.listing) {
      return this.listing;
    }
    const listing = Promise.all(
      this.storageService.getRepositories().map(async (repo) => ({
        repoRoot: repo.rootPath,
        // A listing the list made within the TTL is as good as a new one.
        worktrees: (await this.gitService.listRepositoryWorktreesAsync(repo.rootPath, repo.id, { maxAgeMs: TTL_MS })).worktrees,
      }))
    ).then((listed) => {
      const scopes = listed.filter((scope) => scope.worktrees.length > 0);
      // A listing overtaken by `invalidate` or a forced one is not cached.
      if (this.listing === listing) {
        this.listing = undefined;
        this.cache = { fetchedAt: Date.now(), scopes };
      }
      return scopes;
    });
    this.listing = listing;
    return listing;
  }

  /** Forget the cached worktrees, e.g. after a repository was added; the next lookup lists again. */
  invalidate(): void {
    this.cache = undefined;
    this.listing = undefined;
  }

  worktrees(): Worktree[] {
    return this.scopes().flatMap((scope) => scope.worktrees);
  }

  /** The worktree a session started in `cwd` belongs to, if any. */
  owner(cwd: string): Worktree | undefined {
    return deepestContainingRoot(this.worktrees(), cwd);
  }

  /**
   * Whether a session started in `cwd` belongs to `worktreePath` itself rather
   * than to a root nested inside it. A worktree the catalog does not know
   * keeps every session.
   */
  owns(worktreePath: string, cwd: string): boolean {
    const target = canonicalPath(worktreePath);
    const worktrees = this.worktrees();
    if (!worktrees.some((worktree) => canonicalPath(worktree.path) === target)) {
      return true;
    }
    const owner = deepestContainingRoot(worktrees, cwd);
    return !owner || canonicalPath(owner.path) === target;
  }

  ownedSessions<T extends Pick<HarnessSession, 'cwd'>>(worktreePath: string, sessions: T[]): T[] {
    return sessions.filter((session) => this.owns(worktreePath, session.cwd));
  }
}
