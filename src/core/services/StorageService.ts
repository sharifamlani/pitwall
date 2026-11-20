import * as vscode from 'vscode';
import { createHash } from 'crypto';
import * as path from 'path';
import {
  Repository,
  RepositoryWorktrees,
  ChatSession,
  HarnessId,
  SessionSearchEngine,
  SessionSearchRecord,
  STORAGE_KEYS,
  generateId,
} from '../types';
import { harnessSessionKey } from '../harness/sessionUtils';
import { canonicalPath, samePath } from '../utils/paths';
import {
  RecordOverlay,
  RecordStamp,
  Stamp,
  StampClock,
  Stamped,
  TOMBSTONE_TTL_MS,
  resolveStored,
  sameValue,
  stampTime,
} from './storageOverlay';
import { logOperation } from './OperationLog';

/** How long a user removal keeps a session out of auto-import. */
const REMOVED_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Bound for the tombstone list; the oldest entries are evicted first. */
const REMOVED_SESSION_LIMIT = 500;
/** Finished session searches kept; the oldest are dropped first. */
const SESSION_SEARCH_LIMIT = 10;
/** Joins a workspace folder and a chat id into one PID record id. */
const PID_ID_SEPARATOR = '\u0000';

interface RemovedSessionRecord {
  key: string;
  removedAt: number;
}

/** Shape of chats written before multi-harness support. */
type LegacyChatSession = Omit<ChatSession, 'harness' | 'harnessSessionId'> & {
  harness?: HarnessId;
  harnessSessionId?: string | null;
  claudeSessionId?: string | null;
};

/** Optional fields a new chat can start with. */
export type NewChatFields = Partial<
  Pick<
    ChatSession,
    | 'id'
    | 'harnessSessionId'
    | 'forkedFromSessionId'
    | 'pendingUiLaunch'
    | 'autoImported'
    | 'createdAt'
    | 'lastAccessedAt'
    | 'seenAt'
  >
>;

/** How a root was added: by hand, or found from the agent's session history. */
export interface AddRepositoryOptions {
  origin?: 'manual' | 'discovered';
}

/** For tests: the window's clock and its stamp tag (0–999), and the Operations log. */
export interface StorageServiceOptions {
  now?: () => number;
  windowTag?: number;
  /** Where the dedupe logs `[Pitwall] dedupe kept <id8> merged <id8>`. Default: the Operations log. */
  log?: (line: string) => void;
}

/**
 * The id of a discovered repository (P17): two windows discovering one root
 * derive the same id, so their records converge instead of splitting the
 * root's worktree ids and chats.
 */
export function discoveredRepositoryId(rootPath: string): string {
  const canonical = canonicalPath(rootPath);
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  return `repo-${createHash('sha1').update(key).digest('hex').slice(0, 12)}`;
}

/**
 * The chat id of an auto-imported native session: every window importing
 * one session derives the same id, so two imports racing in two windows
 * converge on one record instead of listing the session twice (like
 * `discoveredRepositoryId`, P17). UUID-shaped (a name-based v5 layout), like
 * every other chat id.
 */
export function importedChatId(harness: HarnessId, sessionId: string): string {
  const hex = createHash('sha1').update(`pitwall.import\u0000${harness}\u0000${sessionId}`).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The global state a dedupe ranks by: every window reads the same values. */
interface DedupeContext {
  starred: Set<string>;
  /** Chats with a terminal PID record in any workspace folder. */
  withTerminal: Set<string>;
  active: string | undefined;
}

/**
 * Which of two chats holding one native session is listed (QA, PR #64 round
 * 2): the one holding user state first, so nothing the user did is hidden.
 * In order: not already merged away, starred, renamed, with a Pitwall
 * terminal, the active chat; then a chat the user started over an import,
 * the older, the lower id. Every input is global state, so every window
 * picks the same row.
 */
function listedFirst(a: ChatSession, b: ChatSession, context: DedupeContext): number {
  const rank = (chat: ChatSession): number[] => [
    chat.mergedInto ? 1 : 0,
    context.starred.has(chat.id) ? 0 : 1,
    chat.customName ? 0 : 1,
    context.withTerminal.has(chat.id) ? 0 : 1,
    context.active === chat.id ? 0 : 1,
    chat.autoImported ? 1 : 0,
    chat.createdAt ?? 0,
  ];
  const [ra, rb] = [rank(a), rank(b)];
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) {
      return ra[i] - rb[i];
    }
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The key one native session's chats share, or undefined for a chat with no session yet. */
function sessionKey(chat: ChatSession): string | undefined {
  return chat.harnessSessionId ? `${chat.harness}\u0000${chat.harnessSessionId}` : undefined;
}

/**
 * One collection's stamps in `pitwall.writeStamps`. Kept beside the records,
 * not in them, so stored shapes stay readable by older builds.
 */
interface StampSection {
  /** Record id → its stamp(s). */
  s?: Record<string, RecordStamp>;
  /** Tombstones: record id → the removal's stamp. */
  d?: Record<string, Stamp>;
}

/** A collection's stored value with this window's writes applied, and its stamps. */
interface Merged {
  value: unknown;
  stamped: Stamped<unknown>;
}

/** A guarded collection, for `set` to re-apply before any write. */
interface GuardedCollection {
  key: string;
  held(): boolean;
  merged(): Merged;
  /** The record ids in a stored value of this collection. */
  ids(value: unknown): string[];
}

/**
 * Pitwall's persisted state in VS Code `globalState`. Stored shapes are a
 * compatibility surface: old shapes are read, migrated, and written back here,
 * never in callers.
 *
 * Every collection is read and written through a stamped `RecordOverlay`
 * (R33a, F3): a stale storage echo can neither drop a record this window
 * wrote nor bring back one it removed, and the newest write wins. Order
 * within a list is not guarded.
 */
export class StorageService {
  private readonly now: () => number;
  private readonly clock: StampClock;
  private readonly repositoryOverlay: RecordOverlay<Repository>;
  private readonly chatOverlay: RecordOverlay<LegacyChatSession>;
  private readonly starOverlay: RecordOverlay<string>;
  private readonly removedSessionOverlay: RecordOverlay<RemovedSessionRecord>;
  private readonly sessionSearchOverlay: RecordOverlay<unknown>;
  private readonly dismissedOverlay: RecordOverlay<number>;
  private readonly prWorktreeOverlay: RecordOverlay<number>;
  /**
   * The terminal PID records this window wrote or removed (R33a), by
   * `<workspace folder>\0<chat id>`. Merged into every read and write of the
   * PID records, so a stale copy can neither drop a record this window wrote
   * nor bring back one it removed; a lost record could launch a second agent
   * after a reload. Other windows' records pass through as stored.
   */
  private readonly pidOverlay: RecordOverlay<number>;
  private readonly guarded: GuardedCollection[];
  private readonly log: (line: string) => void;
  /** A dedupe merge is being written; reads inside it must not start another. */
  private merging = false;
  /** Per kept chat, the hidden chats merged into it, as of the last read. */
  private mergedAliases = new Map<string, string[]>();

  /**
   * @param isKnownHarness Whether a stored harness id is enabled in this
   *   build (registry membership). Records naming any other harness are
   *   skipped where a shape is validated.
   */
  constructor(
    private context: vscode.ExtensionContext,
    private readonly isKnownHarness: (id: string) => boolean,
    options: StorageServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? logOperation;
    this.clock = new StampClock(this.now, options.windowTag);
    const clock = this.clock;
    this.repositoryOverlay = new RecordOverlay({ fields: true, clock });
    this.chatOverlay = new RecordOverlay({ fields: true, clock });
    this.starOverlay = new RecordOverlay({ clock });
    this.removedSessionOverlay = new RecordOverlay({ clock });
    this.sessionSearchOverlay = new RecordOverlay({ clock });
    this.dismissedOverlay = new RecordOverlay({ clock });
    this.prWorktreeOverlay = new RecordOverlay({ clock });
    this.pidOverlay = new RecordOverlay({ clock });

    const listIds = (idOf: (record: unknown) => unknown) => (value: unknown) =>
      (Array.isArray(value) ? value : []).map(idOf).filter((id): id is string => typeof id === 'string');
    const recordIds = (value: unknown) => (value && typeof value === 'object' ? Object.keys(value) : []);
    const byId = (record: unknown) => (record as { id?: unknown } | null)?.id;
    this.guarded = [
      {
        key: STORAGE_KEYS.REPOSITORIES,
        held: () => this.repositoryOverlay.size > 0,
        merged: () => this.mergedRepositories(),
        ids: listIds(byId),
      },
      {
        key: STORAGE_KEYS.CHATS,
        held: () => this.chatOverlay.size > 0,
        merged: () => this.mergedChats(),
        ids: listIds(byId),
      },
      {
        key: STORAGE_KEYS.STARRED_CHATS,
        held: () => this.starOverlay.size > 0,
        merged: () => this.mergedStarredChatIds(),
        ids: listIds((id) => id),
      },
      {
        key: STORAGE_KEYS.REMOVED_SESSIONS,
        held: () => this.removedSessionOverlay.size > 0,
        merged: () => this.mergedRemovedSessions(),
        ids: listIds((record) => (record as { key?: unknown } | null)?.key),
      },
      {
        key: STORAGE_KEYS.SESSION_SEARCHES,
        held: () => this.sessionSearchOverlay.size > 0,
        merged: () => this.mergedSessionSearches(),
        ids: listIds(byId),
      },
      {
        key: STORAGE_KEYS.DISMISSED_REPOS,
        held: () => this.dismissedOverlay.size > 0,
        merged: () => this.mergedNumbers(STORAGE_KEYS.DISMISSED_REPOS, this.dismissedOverlay),
        ids: recordIds,
      },
      {
        key: STORAGE_KEYS.PR_WORKTREES,
        held: () => this.prWorktreeOverlay.size > 0,
        merged: () => this.mergedNumbers(STORAGE_KEYS.PR_WORKTREES, this.prWorktreeOverlay),
        ids: recordIds,
      },
      {
        key: STORAGE_KEYS.TERMINAL_PIDS,
        held: () => this.pidOverlay.size > 0,
        merged: () => this.mergedPidRecords(),
        ids: (value) => Object.keys(flattenPids(value)),
      },
    ];
  }

  private get<T>(key: string, fallback: T): T {
    return this.context.globalState.get<T>(key, fallback);
  }

  private storedList<T>(key: string): T[] {
    const stored = this.get<unknown>(key, []);
    return Array.isArray(stored) ? (stored as T[]) : [];
  }

  /** A stored `Record<string, number>`; malformed entries are skipped. */
  private storedNumbers(key: string): Record<string, number> {
    const stored = this.get<unknown>(key, {});
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(stored as Record<string, unknown>).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number'
      )
    );
  }

  // Write stamps (see storageOverlay.ts)

  private storedSections(): Record<string, StampSection> {
    const stored = this.get<unknown>(STORAGE_KEYS.WRITE_STAMPS, {});
    return stored !== null && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, StampSection>)
      : {};
  }

  /**
   * `records` (one collection, as stored) with its stored stamps and this
   * window's writes applied. Held writes the store has superseded with a
   * newer stamp are let go first.
   */
  private stamped<T>(key: string, overlay: RecordOverlay<T>, records: Record<string, T>): Stamped<T> {
    const section = this.storedSections()[key] ?? {};
    const stored = resolveStored<T>({ records, stamps: section.s ?? {}, removed: section.d ?? {} });
    if (overlay.size > 0) {
      overlay.settle(stored);
    }
    return overlay.merge(stored);
  }

  /** A stored list with stamps and this window's writes applied, stored order kept. */
  private mergedList<T>(
    key: string,
    stored: readonly T[],
    overlay: RecordOverlay<T>,
    idOf: (record: T) => unknown,
    newFirst = false
  ): { value: T[]; stamped: Stamped<T> } {
    // A record stored twice under one id (createChat before its fix) reads as
    // its first copy: every update rewrote the first copy, so a later one is
    // stale. Stamps are per id, so they then merge onto that copy (P25). The
    // collapsed list is persisted by the collection's next write, not here.
    const records: Record<string, T> = {};
    let duplicated = false;
    for (const record of stored) {
      const id = idOf(record);
      if (typeof id === 'string') {
        if (Object.prototype.hasOwnProperty.call(records, id)) {
          duplicated = true;
        } else {
          records[id] = record;
        }
      }
    }
    const stamped = this.stamped(key, overlay, records);
    if (stamped.records === records && !duplicated) {
      return { value: [...stored], stamped };
    }
    return { value: orderedList(stored, stamped.records, idOf, newFirst), stamped };
  }

  private mergedNumbers(key: string, overlay: RecordOverlay<number>): { value: Record<string, number>; stamped: Stamped<number> } {
    const stamped = this.stamped(key, overlay, this.storedNumbers(key));
    return { value: { ...stamped.records }, stamped };
  }

  /**
   * The stamp section to store with a collection value: stamps of the records
   * it holds, and tombstones younger than `TOMBSTONE_TTL_MS` (older ones are
   * pruned here, on write, so the map stays bounded).
   */
  private section(stamped: Stamped<unknown>, ids: string[]): StampSection {
    const present = new Set(ids);
    const s: Record<string, RecordStamp> = {};
    for (const id of present) {
      if (Object.prototype.hasOwnProperty.call(stamped.stamps, id)) {
        s[id] = stamped.stamps[id];
      }
    }
    const cutoff = this.now() - TOMBSTONE_TTL_MS;
    const d = Object.fromEntries(
      Object.entries(stamped.removed).filter(([id, removedAt]) => !present.has(id) && stampTime(removedAt) >= cutoff)
    );
    return { s, d };
  }

  /**
   * Every write saves the whole of Pitwall's global state, so a write of any
   * key also saves every other collection as last read. When a stale storage
   * echo has replaced them, put this window's own records back first (see
   * `RecordOverlay`), so the write cannot persist the stale copy. Each
   * collection written also saves its stamps.
   */
  private set(key: string, value: unknown): Thenable<void> {
    const writes: Thenable<void>[] = [];
    const sections = { ...this.storedSections() };
    let sectionsChanged = false;
    const stampWith = (collectionKey: string, section: StampSection) => {
      sections[collectionKey] = section;
      sectionsChanged = true;
    };
    const restamps = (collectionKey: string, section: StampSection) => {
      const old = sections[collectionKey] ?? {};
      return !sameValue({ s: old.s ?? {}, d: old.d ?? {} }, section);
    };
    for (const collection of this.guarded) {
      if (collection.key === key) {
        // A write that adds no stamp (a migration, a reorder, a prune) leaves
        // the stamps as stored.
        const section = this.section(collection.merged().stamped, collection.ids(value));
        if (restamps(key, section)) {
          stampWith(key, section);
        }
        continue;
      }
      if (!collection.held()) {
        continue;
      }
      // Only the stamps are compared: every write of this window's that wins
      // over the stored copy carries a newer stamp, and a record the merge
      // drops or hides loses its stamp, so equal stamps mean equal records.
      const merged = collection.merged();
      const section = this.section(merged.stamped, collection.ids(merged.value));
      if (restamps(collection.key, section)) {
        writes.push(this.context.globalState.update(collection.key, merged.value));
        stampWith(collection.key, section);
      }
    }
    writes.push(this.context.globalState.update(key, value));
    if (sectionsChanged) {
      writes.push(this.context.globalState.update(STORAGE_KEYS.WRITE_STAMPS, sections));
    }
    return Promise.all(writes).then(() => undefined);
  }

  // Repositories. The stored array order is the tree order.

  /**
   * Stored repositories with this window's writes applied, one per root: two
   * windows adding one root at once keep the oldest record (P17).
   */
  private mergedRepositories(): { value: Repository[]; stamped: Stamped<Repository> } {
    const merged = this.mergedList(
      STORAGE_KEYS.REPOSITORIES,
      this.storedList<Repository>(STORAGE_KEYS.REPOSITORIES),
      this.repositoryOverlay,
      (repo) => repo?.id
    );
    return { value: this.withoutDuplicateRoots(merged.value), stamped: merged.stamped };
  }

  /**
   * Drop all but the oldest record of each root (`samePath`). Older means an
   * earlier `addedAt`; records without one predate it and count as oldest;
   * a tie keeps the first listed. A duplicate this window added is withdrawn.
   */
  private withoutDuplicateRoots(repositories: Repository[]): Repository[] {
    // Spellings of one folder share its name, so only same-name roots are
    // compared, which keeps `samePath`'s file system calls off most reads.
    const byName = new Map<string, number[]>();
    repositories.forEach((repo, index) => {
      if (typeof repo.rootPath !== 'string') {
        return;
      }
      const name = path.basename(repo.rootPath).toLowerCase();
      byName.set(name, [...(byName.get(name) ?? []), index]);
    });
    const dropped = new Set<number>();
    for (const indexes of byName.values()) {
      for (let i = 0; i < indexes.length; i++) {
        for (let j = i + 1; j < indexes.length; j++) {
          const [first, second] = [indexes[i], indexes[j]];
          if (dropped.has(first) || dropped.has(second)) {
            continue;
          }
          if (samePath(repositories[first].rootPath, repositories[second].rootPath)) {
            const secondIsOlder = (repositories[second].addedAt ?? 0) < (repositories[first].addedAt ?? 0);
            dropped.add(secondIsOlder ? first : second);
          }
        }
      }
    }
    if (dropped.size === 0) {
      return repositories;
    }
    for (const index of dropped) {
      const id = repositories[index].id;
      if (this.repositoryOverlay.wrote(id)) {
        this.repositoryOverlay.note(id, null);
      }
    }
    return repositories.filter((_repo, index) => !dropped.has(index));
  }

  getRepositories(includeHidden = false): Repository[] {
    const all = this.mergedRepositories().value;
    return includeHidden ? all : all.filter((r) => !r.hidden);
  }

  getRepository(id: string): Repository | undefined {
    return this.getRepositories(true).find((r) => r.id === id);
  }

  /**
   * Add a root, or return the stored one (reviving a legacy hidden entry).
   * Roots are matched with `samePath`. A discovered root gets the
   * deterministic id from `discoveredRepositoryId` (P17).
   */
  addRepository(name: string, rootPath: string, opts: AddRepositoryOptions = {}): Repository {
    const origin = opts.origin ?? 'manual';
    const id = origin === 'discovered' ? discoveredRepositoryId(rootPath) : generateId();
    const repositories = this.getRepositories(true);
    const existing = repositories.find((r) => r.id === id || samePath(r.rootPath, rootPath));
    if (existing) {
      if (existing.hidden) {
        const revived = { ...existing, hidden: false };
        this.repositoryOverlay.note(existing.id, revived, existing);
        void this.set(
          STORAGE_KEYS.REPOSITORIES,
          repositories.map((r) => (r.id === existing.id ? revived : r))
        );
        return revived;
      }
      return existing;
    }

    const repo: Repository = { id, name, rootPath, origin, addedAt: this.now() };
    this.repositoryOverlay.note(id, repo);
    void this.set(STORAGE_KEYS.REPOSITORIES, [...repositories, repo]);
    return repo;
  }

  /**
   * Swap a repository with its nearest visible neighbor. Returns false when
   * there is none in that direction.
   */
  moveRepository(id: string, direction: 'up' | 'down'): boolean {
    const repositories = this.getRepositories(true);
    const index = repositories.findIndex((r) => r.id === id);
    if (index === -1) {
      return false;
    }

    const step = direction === 'up' ? -1 : 1;
    let neighbor = index + step;
    while (repositories[neighbor]?.hidden) {
      neighbor += step;
    }
    if (!repositories[neighbor]) {
      return false;
    }

    [repositories[index], repositories[neighbor]] = [repositories[neighbor], repositories[index]];
    void this.set(STORAGE_KEYS.REPOSITORIES, repositories);
    return true;
  }

  /** Forget a root's record. Callers forget its worktrees' chats first (ADR 0013). */
  removeRepository(id: string): void {
    this.repositoryOverlay.note(id, null);
    void this.set(
      STORAGE_KEYS.REPOSITORIES,
      this.getRepositories(true).filter((r) => r.id !== id)
    );
  }

  // Dismissed repositories (P1): root path → when it was dismissed.

  getDismissedRepos(): Record<string, number> {
    return this.mergedNumbers(STORAGE_KEYS.DISMISSED_REPOS, this.dismissedOverlay).value;
  }

  /**
   * Dismiss a root at `at`, or clear its dismissal with `null`. A stored
   * spelling of the same root (`samePath`) is reused.
   */
  setDismissed(rootPath: string, at: number | null): Promise<void> {
    const dismissed = this.getDismissedRepos();
    const key = Object.keys(dismissed).find((stored) => samePath(stored, rootPath)) ?? rootPath;
    this.dismissedOverlay.note(key, at);
    if (at === null) {
      delete dismissed[key];
    } else {
      dismissed[key] = at;
    }
    return Promise.resolve(this.set(STORAGE_KEYS.DISMISSED_REPOS, dismissed));
  }

  // Worktree listings: a cache of git's answers, so nothing is guarded.

  private storedWorktreeSnapshot(): Record<string, RepositoryWorktrees> {
    const stored = this.get<unknown>(STORAGE_KEYS.WORKTREE_SNAPSHOT, {});
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, RepositoryWorktrees>) : {};
  }

  /** A repository's last stored worktree listing, if it has a usable one. */
  getWorktreeSnapshot(repoId: string): RepositoryWorktrees | undefined {
    const entry = this.storedWorktreeSnapshot()[repoId] as Partial<RepositoryWorktrees> | undefined;
    const usable =
      entry &&
      typeof entry.isGit === 'boolean' &&
      Array.isArray(entry.worktrees) &&
      entry.worktrees.every(
        (worktree) =>
          worktree &&
          typeof worktree.id === 'string' &&
          typeof worktree.path === 'string' &&
          typeof worktree.name === 'string' &&
          worktree.repoId === repoId
      );
    return usable ? (entry as RepositoryWorktrees) : undefined;
  }

  /** Keep a repository's latest worktree listing for the next start; written only when it changed. */
  saveWorktreeSnapshot(repoId: string, listing: RepositoryWorktrees): void {
    const snapshot = this.storedWorktreeSnapshot();
    if (sameValue(snapshot[repoId], listing)) {
      return;
    }
    // Repos no longer stored drop out, so the snapshot stays bounded.
    const repoIds = new Set(this.getRepositories(true).map((repo) => repo.id));
    const kept = Object.fromEntries(Object.entries(snapshot).filter(([id]) => repoIds.has(id) && id !== repoId));
    void this.set(STORAGE_KEYS.WORKTREE_SNAPSHOT, { ...kept, [repoId]: listing });
  }

  // Chats

  /** Stored chats, as stored, with stamps and this window's writes applied. Merged-away duplicates included. */
  private mergedChats(): { value: LegacyChatSession[]; stamped: Stamped<LegacyChatSession> } {
    return this.mergedList(
      STORAGE_KEYS.CHATS,
      this.storedList<LegacyChatSession>(STORAGE_KEYS.CHATS),
      this.chatOverlay,
      (chat) => chat?.id
    );
  }

  /**
   * Every stored chat, hidden duplicates included: what a chats write starts
   * from, so no write ever drops a record. Chats written before multi-harness
   * support only have `claudeSessionId`; they are migrated here so the rest
   * of the extension treats every chat generically. A chat without a "seen"
   * baseline gets the time it is first loaded (P16).
   */
  private allChats(): ChatSession[] {
    const stored = this.mergedChats().value;
    const isMigrated = (chat: LegacyChatSession): chat is ChatSession =>
      chat.harness !== undefined && chat.harnessSessionId !== undefined;

    if (stored.every((chat) => isMigrated(chat) && chat.seenAt !== undefined)) {
      return stored as ChatSession[];
    }

    const now = this.now();
    const chats = stored.map((chat): ChatSession => {
      let migrated: ChatSession;
      if (isMigrated(chat)) {
        migrated = chat;
      } else {
        const { claudeSessionId, ...rest } = chat;
        migrated = {
          ...rest,
          harness: chat.harness ?? 'claude',
          harnessSessionId: chat.harnessSessionId ?? claudeSessionId ?? null,
        };
      }
      return migrated.seenAt === undefined ? { ...migrated, seenAt: now } : migrated;
    });
    void this.set(STORAGE_KEYS.CHATS, chats);
    return chats;
  }

  /**
   * Every listed chat: one per native session. Two windows importing one
   * session at once, before imports had a shared id, stored it under two chat
   * ids, and it was listed, tracked and popped twice. The row holding the
   * user's state is kept (`listedFirst`); the other copies are hidden from
   * every read but stay in the store. The first read that finds a pair not
   * merged yet merges it, in one explicit write (`mergeDuplicates`).
   */
  getChats(): ChatSession[] {
    return this.listedChats(true);
  }

  private listedChats(mayMerge: boolean): ChatSession[] {
    const all = this.allChats();
    const groups = this.duplicateGroups(all);
    if (groups.length === 0) {
      if (this.mergedAliases.size > 0) {
        this.mergedAliases = new Map();
      }
      return all;
    }
    const context = this.dedupeContext();
    const merges = groups.map((group) => {
      const [winner, ...losers] = [...group].sort((a, b) => listedFirst(a, b, context));
      return { winner, losers };
    });
    if (mayMerge && !this.merging && merges.some(({ winner, losers }) => winner.mergedInto || losers.some((loser) => loser.mergedInto !== winner.id))) {
      this.mergeDuplicates(merges, all, context);
      return this.listedChats(false);
    }
    this.mergedAliases = new Map(merges.map(({ winner, losers }) => [winner.id, losers.map((loser) => loser.id)]));
    const hidden = new Set(merges.flatMap(({ losers }) => losers.map((loser) => loser.id)));
    return all.filter((chat) => !hidden.has(chat.id));
  }

  /**
   * Hidden chats merged into a listed one, as of the last read. A terminal a
   * hidden copy still runs is that row's terminal: opening the row must show
   * it, never start a second agent on the session.
   */
  mergedChatIds(chatId: string): readonly string[] {
    return this.mergedAliases.get(chatId) ?? [];
  }

  /** Sessions held by more than one chat. */
  private duplicateGroups(chats: readonly ChatSession[]): ChatSession[][] {
    const bySession = new Map<string, ChatSession[]>();
    let duplicated = false;
    for (const chat of chats) {
      const key = sessionKey(chat);
      if (!key) {
        continue;
      }
      const group = bySession.get(key);
      if (group) {
        group.push(chat);
        duplicated = true;
      } else {
        bySession.set(key, [chat]);
      }
    }
    return duplicated ? [...bySession.values()].filter((group) => group.length > 1) : [];
  }

  private dedupeContext(): DedupeContext {
    const withTerminal = new Set<string>();
    for (const pids of Object.values(this.getTerminalPidRecords())) {
      Object.keys(pids).forEach((chatId) => withTerminal.add(chatId));
    }
    return { starred: this.getStarredChatIds(), withTerminal, active: this.getActiveChatId() };
  }

  /**
   * Merge each duplicate into its kept row, in one explicit write (never as a
   * side effect of another write): the row is starred if either was, takes a
   * custom name only the copy had, and the later seen and last-used times;
   * the star, the active chat and the terminal PID records move to its id.
   * Each copy stays stored, marked `mergedInto`, so nothing is lost for good;
   * a later release can prune them.
   */
  private mergeDuplicates(
    merges: Array<{ winner: ChatSession; losers: ChatSession[] }>,
    all: ChatSession[],
    context: DedupeContext
  ): void {
    this.merging = true;
    try {
      const chats = [...all];
      const indexOf = new Map(chats.map((chat, index) => [chat.id, index]));
      const pidRecords = this.getTerminalPidRecords();
      let nextActive: string | undefined;
      const change = (chat: ChatSession, updates: Partial<ChatSession>) => {
        const index = indexOf.get(chat.id)!;
        const previous = chats[index];
        const next: ChatSession = { ...previous, ...updates };
        if (next.mergedInto === undefined) {
          delete next.mergedInto;
        }
        if (!sameValue(previous, next)) {
          chats[index] = next;
          this.chatOverlay.note(chat.id, next, previous);
        }
      };
      for (const { winner, losers } of merges) {
        const named = losers.find((loser) => loser.customName);
        change(winner, {
          ...(!winner.customName && named ? { name: named.name, customName: true } : {}),
          seenAt: Math.max(winner.seenAt ?? 0, ...losers.map((loser) => loser.seenAt ?? 0)),
          lastAccessedAt: Math.max(winner.lastAccessedAt ?? 0, ...losers.map((loser) => loser.lastAccessedAt ?? 0)),
          mergedInto: undefined,
        });
        for (const loser of losers) {
          change(loser, { mergedInto: winner.id });
          if (context.starred.has(loser.id)) {
            this.starOverlay.note(winner.id, winner.id);
            this.starOverlay.note(loser.id, null);
          }
          if (context.active === loser.id) {
            nextActive = winner.id;
          }
          for (const [workspace, pids] of Object.entries(pidRecords)) {
            const pid = pids[loser.id];
            if (pid === undefined) {
              continue;
            }
            if (pids[winner.id] === undefined) {
              this.pidOverlay.note(pidId(workspace, winner.id), pid);
            }
            this.pidOverlay.note(pidId(workspace, loser.id), null);
          }
          if (loser.mergedInto !== winner.id) {
            this.log(`[Pitwall] dedupe kept ${winner.id.slice(0, 8)} merged ${loser.id.slice(0, 8)}`);
          }
        }
      }
      // The chats write also saves the star and PID records this merge noted.
      void this.set(STORAGE_KEYS.CHATS, chats);
      if (nextActive) {
        void this.context.globalState.update(STORAGE_KEYS.ACTIVE_CHAT, nextActive);
      }
    } finally {
      this.merging = false;
    }
  }

  getChatsByWorktree(worktreeId: string): ChatSession[] {
    return this.getChats().filter((c) => c.worktreeId === worktreeId);
  }

  getChat(id: string): ChatSession | undefined {
    return this.getChats().find((c) => c.id === id);
  }

  /** Create a chat in one write, already carrying whatever it starts with. */
  createChat(
    worktreeId: string,
    harness: HarnessId,
    name: string,
    fields: NewChatFields = {}
  ): ChatSession {
    const now = this.now();
    const chat: ChatSession = {
      id: fields.id ?? generateId(),
      worktreeId,
      name,
      harness,
      harnessSessionId: null,
      createdAt: now,
      lastAccessedAt: now,
      seenAt: now,
      status: 'idle',
      ...withoutUndefined(fields),
    };
    // Read before noting: the merged list includes noted records, and the
    // chat would then be written twice. Hidden duplicates are written too.
    const chats = this.allChats();
    this.chatOverlay.note(chat.id, chat);
    void this.set(STORAGE_KEYS.CHATS, [...chats, chat]);
    return chat;
  }

  updateChat(id: string, updates: Partial<ChatSession>): ChatSession | undefined {
    return this.changeChat(id, updates).chat;
  }

  /** Move a chat's "seen" baseline (P16). */
  async markChatSeen(chatId: string, at: number): Promise<void> {
    await this.changeChat(chatId, { seenAt: at }).written;
  }

  private changeChat(
    id: string,
    updates: Partial<ChatSession>
  ): { chat: ChatSession | undefined; written: Thenable<void> } {
    // From every stored chat, so the write keeps hidden duplicates.
    const chats = this.allChats();
    const index = chats.findIndex((c) => c.id === id);
    if (index === -1) {
      return { chat: undefined, written: Promise.resolve() };
    }
    const previous = chats[index];
    chats[index] = { ...previous, ...updates };
    this.chatOverlay.note(id, chats[index], previous);
    return { chat: chats[index], written: this.set(STORAGE_KEYS.CHATS, chats) };
  }

  touchChat(id: string): void {
    this.updateChat(id, { lastAccessedAt: this.now() });
  }

  deleteChat(id: string, options: { rememberSession?: boolean } = {}): void {
    this.deleteChats([id], options);
  }

  /**
   * Delete chats in one write and return the ids that existed. A user removal
   * leaves a tombstone so auto-import does not bring the session straight
   * back; other callers pass `rememberSession: false`.
   */
  deleteChats(ids: Iterable<string>, options: { rememberSession?: boolean } = {}): string[] {
    const idSet = new Set(ids);
    if (idSet.size === 0) {
      return [];
    }

    // A hidden duplicate goes with the row it was merged into; the rest stay.
    const chats = this.allChats();
    const requested = chats.filter((chat) => idSet.has(chat.id));
    const removed = chats.filter((chat) => idSet.has(chat.id) || (chat.mergedInto !== undefined && idSet.has(chat.mergedInto)));
    removed.forEach((chat) => idSet.add(chat.id));
    if (options.rememberSession !== false) {
      for (const chat of removed) {
        if (chat.harnessSessionId) {
          this.rememberRemovedSession(chat.harness, chat.harnessSessionId);
        }
      }
    }
    for (const chat of removed) {
      this.chatOverlay.note(chat.id, null);
    }
    void this.set(STORAGE_KEYS.CHATS, chats.filter((chat) => !idSet.has(chat.id)));
    // Forget every requested id: a pid record can outlive its chat.
    this.forgetTerminalPids(idSet);
    return requested.map((chat) => chat.id);
  }

  deleteChatsByWorktree(worktreeId: string, options: { rememberSession?: boolean } = {}): string[] {
    return this.deleteChats(this.getChatsByWorktree(worktreeId).map((chat) => chat.id), options);
  }

  // Removal tombstones: auto-import skips these sessions for the TTL.

  getRemovedSessionKeys(): Set<string> {
    return new Set(this.getRemovedSessionRecords().map((record) => record.key));
  }

  rememberRemovedSession(harness: HarnessId, sessionId: string): void {
    const key = harnessSessionKey(harness, sessionId);
    const record = { key, removedAt: this.now() };
    this.removedSessionOverlay.note(key, record);
    void this.set(
      STORAGE_KEYS.REMOVED_SESSIONS,
      [...this.removedRecordsWithout(key), record].slice(-REMOVED_SESSION_LIMIT)
    );
  }

  /** A manual import is the user undoing a removal, so let future scans see it. */
  forgetRemovedSession(harness: HarnessId, sessionId: string): void {
    const key = harnessSessionKey(harness, sessionId);
    this.removedSessionOverlay.note(key, null);
    void this.set(STORAGE_KEYS.REMOVED_SESSIONS, this.removedRecordsWithout(key));
  }

  private removedRecordsWithout(key: string): RemovedSessionRecord[] {
    return this.getRemovedSessionRecords().filter((record) => record.key !== key);
  }

  private mergedRemovedSessions(): { value: RemovedSessionRecord[]; stamped: Stamped<RemovedSessionRecord> } {
    return this.mergedList(
      STORAGE_KEYS.REMOVED_SESSIONS,
      this.storedList<RemovedSessionRecord>(STORAGE_KEYS.REMOVED_SESSIONS),
      this.removedSessionOverlay,
      (record) => record?.key
    );
  }

  /** Valid, unexpired tombstones, oldest first; expired or malformed ones are pruned. */
  private getRemovedSessionRecords(): RemovedSessionRecord[] {
    const stored = this.mergedRemovedSessions().value;
    const cutoff = this.now() - REMOVED_SESSION_TTL_MS;
    const records = stored
      .filter(
        (record) =>
          typeof record?.key === 'string' &&
          typeof record.removedAt === 'number' &&
          record.removedAt >= cutoff
      )
      .sort((a, b) => a.removedAt - b.removedAt)
      .slice(-REMOVED_SESSION_LIMIT);
    if (records.length !== stored.length) {
      void this.set(STORAGE_KEYS.REMOVED_SESSIONS, records);
    }
    return records;
  }

  // Selection, PR checkouts, stars

  getActiveChatId(): string | undefined {
    return this.get<string | undefined>(STORAGE_KEYS.ACTIVE_CHAT, undefined);
  }

  setActiveChatId(chatId: string | undefined): void {
    void this.set(STORAGE_KEYS.ACTIVE_CHAT, chatId);
  }

  /** The PR a worktree was checked out from, by worktree id. */
  getPRWorktree(worktreeId: string): number | undefined {
    return this.mergedNumbers(STORAGE_KEYS.PR_WORKTREES, this.prWorktreeOverlay).value[worktreeId];
  }

  setPRWorktree(worktreeId: string, prNumber: number): void {
    this.prWorktreeOverlay.note(worktreeId, prNumber);
    this.writePRWorktrees();
  }

  removePRWorktree(worktreeId: string): void {
    this.prWorktreeOverlay.note(worktreeId, null);
    this.writePRWorktrees();
  }

  private writePRWorktrees(): void {
    void this.set(STORAGE_KEYS.PR_WORKTREES, this.mergedNumbers(STORAGE_KEYS.PR_WORKTREES, this.prWorktreeOverlay).value);
  }

  private mergedStarredChatIds(): { value: string[]; stamped: Stamped<string> } {
    const stored = this.storedList<unknown>(STORAGE_KEYS.STARRED_CHATS).filter(
      (id): id is string => typeof id === 'string'
    );
    return this.mergedList(STORAGE_KEYS.STARRED_CHATS, stored, this.starOverlay, (id) => id);
  }

  getStarredChatIds(): Set<string> {
    return new Set(this.mergedStarredChatIds().value);
  }

  isStarred(chatId: string): boolean {
    return this.getStarredChatIds().has(chatId);
  }

  /** Returns whether the chat is starred afterwards. */
  toggleStar(chatId: string): boolean {
    const starred = this.getStarredChatIds();
    const nowStarred = !starred.delete(chatId);
    if (nowStarred) {
      starred.add(chatId);
    }
    this.starOverlay.note(chatId, nowStarred ? chatId : null);
    void this.set(STORAGE_KEYS.STARRED_CHATS, Array.from(starred));
    return nowStarred;
  }

  getStarredChats(): ChatSession[] {
    const starredIds = this.getStarredChatIds();
    return this.getChats().filter((c) => starredIds.has(c.id));
  }

  // Session searches

  /** Stored searches, as stored, with this window's saves first. */
  private mergedSessionSearches(): { value: unknown[]; stamped: Stamped<unknown> } {
    return this.mergedList(
      STORAGE_KEYS.SESSION_SEARCHES,
      this.storedList<unknown>(STORAGE_KEYS.SESSION_SEARCHES),
      this.sessionSearchOverlay,
      (search) => (search as { id?: unknown } | null)?.id,
      true
    );
  }

  /** Finished searches, newest first. A malformed record is skipped. */
  getSessionSearches(): SessionSearchRecord[] {
    // A newer build may have stored a harness this one does not know; its
    // sessions cannot be shown or resumed here, so they are left out.
    return this.mergedSessionSearches()
      .value.filter((value) => isSessionSearchRecord(value, this.isHarnessId))
      .map((search) => {
        const matches = search.matches.filter((match) => this.isHarnessId(match.harness));
        return matches.length === search.matches.length ? search : { ...search, matches };
      });
  }

  /**
   * Every well-formed stored search, including those of a harness this build
   * has disabled. Writes start from this, so a build that cannot show a search
   * never erases it.
   */
  private getStoredSessionSearches(): SessionSearchRecord[] {
    return this.mergedSessionSearches().value.filter((value) =>
      isSessionSearchRecord(value, (_id): _id is HarnessId => true)
    );
  }

  /** Keep a finished search ahead of the others, within the limit. */
  saveSessionSearch(search: SessionSearchRecord): Thenable<void> {
    this.sessionSearchOverlay.note(search.id, search);
    const others = this.getStoredSessionSearches().filter((stored) => stored.id !== search.id);
    const searches = [search, ...others];
    for (const evicted of searches.slice(SESSION_SEARCH_LIMIT)) {
      this.sessionSearchOverlay.note(evicted.id, null);
    }
    return this.set(STORAGE_KEYS.SESSION_SEARCHES, searches.slice(0, SESSION_SEARCH_LIMIT));
  }

  removeSessionSearches(ids: Iterable<string>): Thenable<void> {
    const removed = new Set(ids);
    for (const id of removed) {
      this.sessionSearchOverlay.note(id, null);
    }
    return this.set(
      STORAGE_KEYS.SESSION_SEARCHES,
      this.getStoredSessionSearches().filter((search) => !removed.has(search.id))
    );
  }

  /** The harness a saved model/effort choice belongs to. */
  getSessionSearchEngineChoice(): SessionSearchEngine | undefined {
    const stored = this.get<unknown>(STORAGE_KEYS.SESSION_SEARCH_ENGINE_CHOICE, undefined);
    return isSessionSearchEngine(stored, this.isHarnessId) ? stored : undefined;
  }

  saveSessionSearchEngineChoice(engine: SessionSearchEngine): Thenable<void> {
    return this.set(STORAGE_KEYS.SESSION_SEARCH_ENGINE_CHOICE, engine);
  }

  // Restored terminals (ADR 0009)

  /**
   * The workspace folder whose terminals this window owns. Pitwall keeps one
   * workspace folder per window (`autoSwitchWorkspaceFolder` replaces the
   * folder list), so the first folder identifies the workspace.
   */
  private workspaceKey(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  }

  /**
   * Recorded terminal PIDs by workspace folder. Kept in `globalState`, not
   * `workspaceState`: switching the workspace folder gives VS Code a fresh
   * workspace store, which would erase the identity of the terminals Pitwall
   * left running.
   */
  private getTerminalPidRecords(): Record<string, Record<string, number>> {
    return this.mergedPidRecords().value;
  }

  private storedPidRecords(): Record<string, Record<string, number>> {
    return this.get<Record<string, Record<string, number>>>(STORAGE_KEYS.TERMINAL_PIDS, {});
  }

  /**
   * Stored PID records with this window's own writes and removals applied.
   * Every stored workspace folder, and every folder this window holds a
   * record for, keeps its map, even when empty.
   */
  private mergedPidRecords(): { value: Record<string, Record<string, number>>; stamped: Stamped<number> } {
    const stored = this.storedPidRecords();
    const stamped = this.stamped(STORAGE_KEYS.TERMINAL_PIDS, this.pidOverlay, flattenPids(stored));
    const records: Record<string, Record<string, number>> = {};
    for (const workspace of Object.keys(stored)) {
      records[workspace] = {};
    }
    for (const id of this.pidOverlay.ids()) {
      records[splitPidId(id)[0]] ??= {};
    }
    for (const [id, pid] of Object.entries(stamped.records)) {
      const [workspace, chatId] = splitPidId(id);
      (records[workspace] ??= {})[chatId] = pid;
    }
    return { value: records, stamped };
  }

  /**
   * PIDs this workspace last saw for chats it launched, by chat ID. An entry
   * proves the workspace owned the terminal; its PID tells a live agent from
   * a shell VS Code revived after a quit.
   */
  getTerminalPids(): Record<string, number> {
    const key = this.workspaceKey();
    const records = this.getTerminalPidRecords();
    if (records[key]) {
      return records[key];
    }

    // One-time migration from the workspace-scoped shape of earlier builds.
    // Without it the first reload after upgrading would forget every running
    // terminal and could launch a second agent.
    const legacy = this.context.workspaceState.get<Record<string, number>>(STORAGE_KEYS.TERMINAL_PIDS, {});
    if (Object.keys(legacy).length === 0) {
      return {};
    }
    void this.set(STORAGE_KEYS.TERMINAL_PIDS, { ...records, [key]: legacy });
    void this.context.workspaceState.update(STORAGE_KEYS.TERMINAL_PIDS, undefined);
    return legacy;
  }

  /**
   * Record the PID this workspace saw for a chat. Kept on terminal close,
   * because VS Code fires close events on quit and the next activation needs
   * the old PID as proof that a revived shell is not the live agent.
   */
  async rememberTerminalPid(chatId: string, pid: number): Promise<void> {
    // Read first: this also moves a legacy workspace-scoped record over.
    const pids = this.getTerminalPids();
    const workspace = this.workspaceKey();
    this.pidOverlay.note(pidId(workspace, chatId), pid);
    if (pids[chatId] === pid && this.storedPidRecords()[workspace]?.[chatId] === pid) {
      return;
    }
    await this.set(STORAGE_KEYS.TERMINAL_PIDS, this.getTerminalPidRecords());
  }

  /**
   * Forget the PID this workspace recorded for a chat's terminal, when that
   * terminal stops being the chat's (a shell released because its agent
   * exited). Neither a reload's adoption nor a quit's revive then treats the
   * tab as the chat's (QA H1 on #75).
   */
  async forgetTerminalPid(chatId: string): Promise<void> {
    // Read first: this also moves a legacy workspace-scoped record over.
    if (this.getTerminalPids()[chatId] === undefined) {
      return;
    }
    // Kept as a removal, so a stale copy cannot bring the record back.
    this.pidOverlay.note(pidId(this.workspaceKey(), chatId), null);
    await this.set(STORAGE_KEYS.TERMINAL_PIDS, this.getTerminalPidRecords());
  }

  /** Drop terminal identity for deleted chats, in every workspace. */
  private forgetTerminalPids(chatIds: Set<string>): void {
    const records = this.getTerminalPidRecords();
    let changed = false;
    for (const [workspace, pids] of Object.entries(records)) {
      for (const chatId of Object.keys(pids)) {
        if (chatIds.has(chatId)) {
          // Kept as a removal, so a stale copy cannot bring the record back.
          this.pidOverlay.note(pidId(workspace, chatId), null);
          changed = true;
        }
      }
    }
    if (changed) {
      void this.set(STORAGE_KEYS.TERMINAL_PIDS, this.getTerminalPidRecords());
    }
  }

  /** A stored harness id this build has enabled; see the constructor. */
  private readonly isHarnessId = (value: unknown): value is HarnessId =>
    typeof value === 'string' && this.isKnownHarness(value);
}

/**
 * `stored` re-listed from merged `records`: stored order kept, records the
 * store lacks after the stored ones, or before them (newest first) with
 * `newFirst`. A record without an id passes through.
 */
function orderedList<T>(
  stored: readonly T[],
  records: Record<string, T>,
  idOf: (record: T) => unknown,
  newFirst: boolean
): T[] {
  const result: T[] = [];
  const placed = new Set<string>();
  for (const record of stored) {
    const id = idOf(record);
    if (typeof id !== 'string') {
      result.push(record);
    } else if (!placed.has(id)) {
      placed.add(id);
      if (Object.prototype.hasOwnProperty.call(records, id)) {
        result.push(records[id]);
      }
    }
  }
  const added = Object.keys(records)
    .filter((id) => !placed.has(id))
    .map((id) => records[id]);
  return newFirst ? [...added.reverse(), ...result] : [...result, ...added];
}

function pidId(workspace: string, chatId: string): string {
  return `${workspace}${PID_ID_SEPARATOR}${chatId}`;
}

function splitPidId(id: string): [string, string] {
  const index = id.indexOf(PID_ID_SEPARATOR);
  return [id.slice(0, index), id.slice(index + 1)];
}

function flattenPids(value: unknown): Record<string, number> {
  const records: Record<string, number> = {};
  if (value === null || typeof value !== 'object') {
    return records;
  }
  for (const [workspace, pids] of Object.entries(value as Record<string, unknown>)) {
    if (pids === null || typeof pids !== 'object') {
      continue;
    }
    for (const [chatId, pid] of Object.entries(pids as Record<string, unknown>)) {
      if (typeof pid === 'number') {
        records[pidId(workspace, chatId)] = pid;
      }
    }
  }
  return records;
}

function withoutUndefined<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

type HarnessCheck = (value: unknown) => value is HarnessId;

function isSessionSearchRecord(value: unknown, isHarnessId: HarnessCheck): value is SessionSearchRecord {
  const record = value as Partial<SessionSearchRecord> | null;
  return (
    typeof record?.id === 'string' &&
    typeof record.query === 'string' &&
    isHarnessId(record.engine?.harness) &&
    Array.isArray(record.matches) &&
    Array.isArray(record.activity)
  );
}

function isSessionSearchEngine(value: unknown, isHarnessId: HarnessCheck): value is SessionSearchEngine {
  const engine = value as Partial<SessionSearchEngine> | null;
  return (
    isHarnessId(engine?.harness) &&
    typeof engine.model === 'string' &&
    typeof engine.effort === 'string'
  );
}
