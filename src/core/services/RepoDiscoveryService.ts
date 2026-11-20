import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DiscoveredFolder, DiscoveryCounts, HarnessAdapter } from '../harness/types';
import { BoundedCache } from '../utils/boundedCache';
import { canonicalRoot, samePath } from '../utils/paths';
import { GitService } from './GitService';
import { StorageService } from './StorageService';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A pass runs this often, besides the first render and window focus. */
const DEFAULT_INTERVAL_MS = 60_000;
/** A folder's repo root is re-asked of git after this long (`git init` can change it). */
const ROOT_TTL_MS = 10 * 60_000;
/** P3: discovery and import share one window. */
const DEFAULT_RETENTION_DAYS = 14;

export interface RepoDiscoveryOptions {
  /** `pitwall.discovery.enabled`. */
  enabled?: () => boolean;
  /** How many days of sessions count; `pitwall.autoImport.retentionDays`. */
  retentionDays?: () => number;
  intervalMs?: number;
  now?: () => number;
  /** Called with the roots a pass stored, so the list and the importer catch up. */
  onAdded?: (roots: string[]) => void;
  /** Called once, when the first pass has ended, however it ended. */
  onFirstPassDone?: () => void;
  /** The Operations log: each pass's start, and its end with counts and time. */
  log?: (line: string) => void;
}

export interface RepoDiscoveryResult {
  /** Roots this pass stored. */
  added: string[];
  /** Session files that named no folder or could not be read, plus folders gone from disk. */
  skipped: number;
}

/**
 * Adds every repo an agent session ran in during the retention window
 * (row 3.1, ADR 0019). A folder maps to its main repository root through the
 * git common dir, so worktree sessions land under their repo; a folder
 * outside git becomes a folder repository. Roots are stored with
 * `origin: 'discovered'` and the deterministic id (P17), so two windows
 * adding one root converge on one record.
 *
 * A dismissed root stays out until a session starts in it after the
 * dismissal (P2), judged by the newest session's first entry; an older
 * session that is still running does not bring it back.
 *
 * Passes run after the list first renders, every minute and on window
 * focus. Activation never waits for one, and a failure is logged, never
 * thrown.
 */
export class RepoDiscoveryService implements vscode.Disposable {
  private readonly enabled: () => boolean;
  private readonly retentionDays: () => number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly onAdded: (roots: string[]) => void;
  private readonly log: (line: string) => void;
  private onFirstPassDone: (() => void) | undefined;
  /** Folder → its repo root (null: not in git), with when git was asked. */
  private readonly roots = new BoundedCache<string, { root: string | null; at: number }>(2_000);
  private inFlight: Promise<RepoDiscoveryResult> | undefined;
  private started = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  constructor(
    private readonly storageService: StorageService,
    private readonly gitService: GitService,
    private readonly adapters: () => HarnessAdapter[],
    options: RepoDiscoveryOptions = {}
  ) {
    this.enabled =
      options.enabled ?? (() => vscode.workspace.getConfiguration('pitwall').get<boolean>('discovery.enabled', true));
    this.retentionDays =
      options.retentionDays ??
      (() => {
        const days = Number(
          vscode.workspace.getConfiguration('pitwall').get<number>('autoImport.retentionDays', DEFAULT_RETENTION_DAYS)
        );
        return Number.isFinite(days) && days >= 1 ? Math.floor(days) : DEFAULT_RETENTION_DAYS;
      });
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.onAdded = options.onAdded ?? (() => undefined);
    this.log = options.log ?? (() => undefined);
    this.onFirstPassDone = options.onFirstPassDone;
  }

  /**
   * Start passes once `firstRender` settles: one at once, then every minute
   * and whenever the window gains focus. Returns immediately.
   */
  start(firstRender: PromiseLike<unknown>): void {
    void Promise.resolve(firstRender).then(
      () => {
        if (this.disposed || this.started) {
          return;
        }
        this.started = true;
        this.wake();
        this.timer = setInterval(() => this.wake(), this.intervalMs);
        this.timer.unref?.();
        this.disposables.push(
          vscode.window.onDidChangeWindowState((state) => {
            if (state.focused) {
              this.wake();
            }
          })
        );
      },
      (error) => console.error('[Pitwall] discovery did not start:', error)
    );
  }

  /** Run a pass in the background, unless one is already running. */
  wake(): void {
    if (!this.started || this.disposed) {
      return;
    }
    void this.scan();
  }

  /**
   * One pass. Concurrent calls share the running pass. Never rejects: a
   * failure is logged and the pass reports what it had done.
   */
  scan(): Promise<RepoDiscoveryResult> {
    this.inFlight ??= this.runScan().finally(() => {
      this.inFlight = undefined;
      const firstPassDone = this.onFirstPassDone;
      this.onFirstPassDone = undefined;
      if (!this.disposed) {
        firstPassDone?.();
      }
    });
    return this.inFlight;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.disposables.forEach((disposable) => disposable.dispose());
    this.disposables.length = 0;
  }

  private async runScan(): Promise<RepoDiscoveryResult> {
    const result: RepoDiscoveryResult = { added: [], skipped: 0 };
    let started: number | undefined;
    try {
      if (!this.enabled()) {
        return result;
      }
      // Timestamped in the Operations log (the view may be hidden), so a
      // pass can be timed and matched to the extension host's CPU.
      started = Date.now();
      this.log('[Pitwall] discovery started');
      const counts: DiscoveryCounts = { skipped: 0, sessions: 0 };
      const sinceMs = this.now() - this.retentionDays() * DAY_MS;
      const folders = await this.discoverFolders(sinceMs, counts);

      // Each folder's root; the newest session start per root (P2).
      const found: { root: string; startedAt: number }[] = [];
      for (const folder of folders) {
        const root = await this.rootFor(folder.cwd);
        if (!root) {
          counts.skipped += 1;
          continue;
        }
        const known = found.find((entry) => samePath(entry.root, root));
        if (known) {
          known.startedAt = Math.max(known.startedAt, folder.firstEntryAt);
        } else {
          found.push({ root, startedAt: folder.firstEntryAt });
        }
      }

      for (const { root, startedAt } of found) {
        if (this.disposed) {
          break;
        }
        if (this.storageService.getRepositories(true).some((repo) => samePath(repo.rootPath, root))) {
          continue;
        }
        const dismissed = this.storageService.getDismissedRepos();
        const dismissedKey = Object.keys(dismissed).find((key) => samePath(key, root));
        if (dismissedKey !== undefined) {
          if (startedAt <= dismissed[dismissedKey]) {
            continue;
          }
          await this.storageService.setDismissed(root, null);
        }
        this.storageService.addRepository(path.basename(root), root, { origin: 'discovered' });
        result.added.push(root);
      }
      result.skipped = counts.skipped;
      // Counts only: paths are the user's folders, not log material.
      this.log(
        `[Pitwall] discovery finished: ${found.length} repos (${result.added.length} new), ` +
          `${counts.sessions ?? 0} sessions, ${result.skipped} skipped, ${Date.now() - started} ms`
      );
      if (result.added.length > 0) {
        this.onAdded(result.added);
      }
    } catch (error) {
      console.error('[Pitwall] discovery failed:', error);
      if (started !== undefined) {
        this.log(`[Pitwall] discovery failed after ${Date.now() - started} ms`);
      }
    }
    return result;
  }

  /** Every adapter's recent folders; one adapter failing leaves the others. */
  private async discoverFolders(sinceMs: number, counts: DiscoveryCounts): Promise<DiscoveredFolder[]> {
    const lists = await Promise.all(
      this.adapters()
        .filter((adapter) => adapter.discoverRecentFolders)
        .map((adapter) =>
          adapter.discoverRecentFolders!(sinceMs, counts).catch((error) => {
            console.error(`[Pitwall] discovery failed for ${adapter.id}:`, error);
            return [] as DiscoveredFolder[];
          })
        )
    );
    return lists.flat();
  }

  /**
   * The root a folder belongs to: its main repository root, or the folder
   * itself outside git. Null when the folder is gone.
   */
  private async rootFor(cwd: string): Promise<string | null> {
    try {
      if (!(await fs.promises.stat(cwd)).isDirectory()) {
        return null;
      }
    } catch {
      return null;
    }
    const cached = this.roots.get(cwd);
    if (cached && this.now() - cached.at < ROOT_TTL_MS) {
      return canonicalRoot(cached.root ?? cwd);
    }
    const root = await this.gitService.getMainRepoRoot(cwd);
    this.roots.set(cwd, { root, at: this.now() });
    return canonicalRoot(root ?? cwd);
  }
}
