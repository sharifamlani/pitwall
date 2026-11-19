import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { pathKey, samePath } from '../utils/paths';

/**
 * The handoff inbox (ADR 0020). A window that can't open a chat itself (the
 * chat belongs to another folder) writes a request file under
 * `<globalStorage>/pitwall-handoff/<folderKey>/<nonce>.json` and raises that
 * folder's window. The one single-folder window on that folder claims the
 * request by renaming it to `<nonce>.claimed-<pid>`; the sender expires one
 * by renaming it to `<nonce>.expired`.
 *
 * A rename alone is not exclusive on Windows: two processes that open the
 * file before either renames it both succeed, and the file ends up under the
 * second name. So every rename of a request first creates `<nonce>.lock`
 * with O_EXCL, which exactly one caller can do, and deletes it once the
 * rename is done. Two windows, or a claim racing the sender's expiry, never
 * both win. Files hold only ids, a folder path, a pid and timestamps.
 */

/** The sender expires an unclaimed request after this long, and a claimer never opens an older one (Q16). */
export const EXPIRE_MS = 120_000;
/** The sender warns once when no `done` with `ok` arrives within this long (Q16). */
export const WARN_MS = 20_000;
/** Claimed, done, expired and temporary files are swept after this long (Q16). */
export const SWEEP_AGE_MS = 10 * 60_000;
/** A claim runs this often even without a file or focus event. */
export const BACKSTOP_MS = 15_000;
/** The inbox folder under global storage. */
export const HANDOFF_DIR = 'pitwall-handoff';

export type HandoffKind = 'open' | 'openAll' | 'new' | 'sideBySide';

export interface HandoffRequest {
  v: 1;
  kind: HandoffKind;
  sessionIds: string[];
  folder: string;
  at: number;
  nonce: string;
}

export interface HandoffOutcome {
  ok: boolean;
  error?: string;
}

const KINDS: ReadonlySet<string> = new Set<HandoffKind>(['open', 'openAll', 'new', 'sideBySide']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Windows reports a file another process holds open, or is renaming, as one of these; they pass. */
const RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRIES = 3;
const RENAME_RETRY_MS = 50;

type Rename = (from: string, to: string) => Promise<void>;

/**
 * Rename `from` to `to`. EPERM, EBUSY and EACCES are retried 3 times, 50 ms
 * apart; ENOENT means another caller renamed it first (`lost`). Anything else,
 * or a lock that outlasts the retries, throws.
 */
export async function renameRetrying(from: string, to: string, rename: Rename = fs.promises.rename): Promise<'ok' | 'lost'> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return 'ok';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code === 'ENOENT') {
        return 'lost';
      }
      if (!RETRY_CODES.has(code) || attempt >= RENAME_RETRIES) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS));
    }
  }
}

/**
 * Rename request file `from` to `to` while holding `<nonce>.lock`, so exactly
 * one caller wins (see the header). `lost` when another caller holds the lock
 * or already renamed the request.
 */
async function renameExclusive(dir: string, nonce: string, from: string, to: string): Promise<'ok' | 'lost'> {
  const lock = path.join(dir, `${nonce}.lock`);
  try {
    await (await fs.promises.open(lock, 'wx')).close();
  } catch {
    // EEXIST: another window holds it. EPERM/EACCES: its lock is being deleted, so its rename is done.
    return 'lost';
  }
  try {
    return await renameRetrying(from, to);
  } finally {
    await fs.promises.rm(lock, { force: true }).catch(() => undefined);
  }
}

/** Write JSON to `<file>.tmp`, then rename it into place, so a reader never sees half a file. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data));
  if ((await renameRetrying(tmp, file)) === 'lost') {
    throw new Error(`${path.basename(tmp)} vanished before it was renamed`);
  }
}

const id8 = (nonce: string): string => nonce.slice(0, 8);
const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

export interface WatchOptions {
  /** How often the backstop claim runs; `Infinity` turns it off (tests). */
  backstopMs?: number;
  /** `false` claims on focus and the backstop only (tests). */
  watchFs?: boolean;
  /**
   * Called once, when the first claim pass is done, with what `onRequests`
   * returned for it (settled when the claimed chats have opened), so a
   * window's other startup work can wait for its handoff (I3).
   */
  onFirstPass?: (handled: Promise<unknown>) => void;
}

export class HandoffInbox {
  private readonly root: string;
  /** When each request this window claimed was sent, for the "opened after" log line. */
  private readonly sentAt = new Map<string, number>();

  constructor(
    dir: string,
    private readonly self: { pid: number; folder: string | undefined },
    private readonly clock: () => number = Date.now,
    private readonly log: (line: string) => void = () => undefined
  ) {
    this.root = path.join(dir, HANDOFF_DIR);
  }

  /** The first 16 hex characters of sha1(`pathKey(folder)`): one inbox per folder, whatever its spelling. */
  folderKey(folder: string): string {
    return createHash('sha1').update(pathKey(folder)).digest('hex').slice(0, 16);
  }

  private folderDir(folder: string): string {
    return path.join(this.root, this.folderKey(folder));
  }

  /** Ask the window on `folder` to open chats; returns the request's nonce. */
  async send(folder: string, req: { kind: HandoffKind; sessionIds: string[] }): Promise<string> {
    const nonce = randomUUID();
    const request: HandoffRequest = { v: 1, kind: req.kind, sessionIds: [...req.sessionIds], folder, at: this.clock(), nonce };
    const dir = this.folderDir(folder);
    await fs.promises.mkdir(dir, { recursive: true });
    await writeJsonAtomic(path.join(dir, `${nonce}.json`), request);
    this.log(`[Pitwall] handoff sent ${id8(nonce)} → ${folder}`);
    return nonce;
  }

  /** The nonce of an unclaimed, unexpired request for the same folder, kind and ids (the sender's dedupe). */
  async pending(folder: string, kind: HandoffKind, sessionIds: string[]): Promise<string | undefined> {
    const dir = this.folderDir(folder);
    for (const name of await this.list(dir)) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const request = await this.read(path.join(dir, name), name.slice(0, -'.json'.length));
      if (
        request &&
        request.kind === kind &&
        sameIds(request.sessionIds, sessionIds) &&
        this.clock() - request.at < EXPIRE_MS &&
        samePath(request.folder, folder)
      ) {
        return request.nonce;
      }
    }
    return undefined;
  }

  /** What the claiming window reported for `nonce`, once it has. */
  async outcome(folder: string, nonce: string): Promise<HandoffOutcome | undefined> {
    const dir = this.folderDir(folder);
    const done = (await this.list(dir)).find((name) => /^[^.]+\.done-\d+$/.test(name) && name.startsWith(`${nonce}.`));
    if (!done) {
      return undefined;
    }
    try {
      const data = JSON.parse(await fs.promises.readFile(path.join(dir, done), 'utf8')) as Record<string, unknown>;
      return typeof data.error === 'string' ? { ok: data.ok === true, error: data.error } : { ok: data.ok === true };
    } catch {
      return undefined;
    }
  }

  /** The sender gives up on an unclaimed request. False when a window claimed it first. */
  async expire(folder: string, nonce: string): Promise<boolean> {
    const dir = this.folderDir(folder);
    const result = await renameExclusive(dir, nonce, path.join(dir, `${nonce}.json`), path.join(dir, `${nonce}.expired`));
    if (result === 'ok') {
      this.log(`[Pitwall] handoff expired ${id8(nonce)}`);
    }
    return result === 'ok';
  }

  /**
   * Claim every request for this window's folder. Only a single-folder window
   * has a folder (Q17), so an empty or multi-root window claims nothing. A
   * claimed request is validated (Q19): a malformed one is deleted, and one
   * older than 120 s is expired, never returned, since its sender may be gone.
   */
  async claimAll(): Promise<HandoffRequest[]> {
    const folder = this.self.folder;
    if (!folder) {
      return [];
    }
    const dir = this.folderDir(folder);
    const claimed: HandoffRequest[] = [];
    for (const name of await this.list(dir)) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const nonce = name.slice(0, -'.json'.length);
      const claimedFile = path.join(dir, `${nonce}.claimed-${this.self.pid}`);
      try {
        if ((await renameExclusive(dir, nonce, path.join(dir, name), claimedFile)) === 'lost') {
          continue;
        }
        const request = await this.read(claimedFile, nonce);
        if (!request || !samePath(request.folder, folder)) {
          await fs.promises.rm(claimedFile, { force: true });
          continue;
        }
        const age = this.clock() - request.at;
        if (age >= EXPIRE_MS) {
          await renameRetrying(claimedFile, path.join(dir, `${nonce}.expired`));
          this.log(`[Pitwall] handoff expired ${id8(nonce)}`);
          continue;
        }
        this.sentAt.set(nonce, request.at);
        this.log(`[Pitwall] handoff claimed ${id8(nonce)} after ${age} ms`);
        claimed.push(request);
      } catch (error) {
        this.log(`[Pitwall] handoff failed ${id8(nonce)} ${(error as Error).message}`);
      }
    }
    return claimed;
  }

  /** Report how a claimed request went, as `<nonce>.done-<pid>`, which the sender reads. */
  async complete(nonce: string, result: HandoffOutcome): Promise<void> {
    const folder = this.self.folder;
    if (!folder) {
      return;
    }
    const outcome = { ok: result.ok, ...(result.error !== undefined ? { error: result.error } : {}), at: this.clock() };
    await writeJsonAtomic(path.join(this.folderDir(folder), `${nonce}.done-${this.self.pid}`), outcome);
    const sentAt = this.sentAt.get(nonce);
    this.sentAt.delete(nonce);
    if (result.ok) {
      this.log(`[Pitwall] handoff opened ${id8(nonce)} after ${sentAt === undefined ? 0 : this.clock() - sentAt} ms`);
    } else {
      this.log(`[Pitwall] handoff failed ${id8(nonce)} ${result.error ?? 'unknown error'}`);
    }
  }

  /**
   * Delete stray files in every folder's inbox (Q16): requests older than
   * 120 s, and claimed, done, expired, lock and temporary files older than
   * 10 min.
   */
  async sweep(): Promise<void> {
    let folders: fs.Dirent[];
    try {
      folders = await fs.promises.readdir(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    const now = this.clock();
    for (const folder of folders) {
      if (!folder.isDirectory() || !/^[0-9a-f]{16}$/.test(folder.name)) {
        continue;
      }
      const dir = path.join(this.root, folder.name);
      for (const name of await this.list(dir)) {
        const maxAge = name.endsWith('.json')
          ? EXPIRE_MS
          : /\.(claimed-\d+|done-\d+|expired|lock|tmp)$/.test(name)
            ? SWEEP_AGE_MS
            : undefined;
        if (maxAge === undefined) {
          continue;
        }
        const file = path.join(dir, name);
        try {
          if (now - (await fs.promises.stat(file)).mtimeMs >= maxAge) {
            await fs.promises.rm(file, { force: true });
          }
        } catch {
          // Claimed or swept by another window meanwhile.
        }
      }
    }
  }

  /**
   * Claim this window's requests now, on every change in its inbox folder,
   * whenever the window gains focus, and every 15 s as a backstop, handing
   * each batch to `onRequests`. Creates the folder so it can be watched.
   */
  watch(onRequests: (requests: HandoffRequest[]) => unknown, options: WatchOptions = {}): vscode.Disposable {
    const folder = this.self.folder;
    let firstPass = options.onFirstPass;
    const passDone = (handled: unknown): void => {
      const report = firstPass;
      firstPass = undefined;
      report?.(Promise.resolve(handled).catch(() => undefined));
    };
    if (!folder) {
      passDone(undefined);
      return { dispose: () => undefined };
    }
    this.log('[Pitwall] handoff watch started');
    const dir = this.folderDir(folder);
    const disposables: { dispose(): unknown }[] = [];
    let disposed = false;
    let running = false;
    let again = false;
    const claim = (): void => {
      if (disposed) {
        return;
      }
      if (running) {
        again = true;
        return;
      }
      running = true;
      void (async () => {
        do {
          again = false;
          const requests = await this.claimAll().catch(() => []);
          let handled: unknown;
          if (requests.length > 0 && !disposed) {
            try {
              handled = onRequests(requests);
            } catch (error) {
              this.log(`[Pitwall] handoff failed ${id8(requests[0].nonce)} ${(error as Error).message}`);
            }
          }
          passDone(handled);
        } while (again && !disposed);
      })().finally(() => (running = false));
    };

    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // The backstop retries the claim; a missing folder holds no requests.
    }
    if (options.watchFs !== false) {
      try {
        const watcher = fs.watch(dir, () => claim());
        watcher.on('error', () => watcher.close());
        disposables.push({ dispose: () => watcher.close() });
      } catch {
        // No file events (network drive, deleted folder): focus and the backstop still claim.
      }
    }
    disposables.push(vscode.window.onDidChangeWindowState((state) => state.focused && claim()));
    const backstopMs = options.backstopMs ?? BACKSTOP_MS;
    if (Number.isFinite(backstopMs)) {
      const timer = setInterval(claim, backstopMs);
      timer.unref?.();
      disposables.push({ dispose: () => clearInterval(timer) });
    }
    claim();
    return {
      dispose: () => {
        disposed = true;
        disposables.forEach((disposable) => disposable.dispose());
      },
    };
  }

  private async list(dir: string): Promise<string[]> {
    try {
      return await fs.promises.readdir(dir);
    } catch {
      return [];
    }
  }

  /** The request in `file` when it is well formed (Q19) and names `nonce`; otherwise undefined. */
  private async read(file: string, nonce: string): Promise<HandoffRequest | undefined> {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const valid =
      data !== null &&
      typeof data === 'object' &&
      data.v === 1 &&
      typeof data.kind === 'string' &&
      KINDS.has(data.kind) &&
      Array.isArray(data.sessionIds) &&
      data.sessionIds.every((id) => typeof id === 'string' && UUID.test(id)) &&
      typeof data.folder === 'string' &&
      data.folder.length > 0 &&
      typeof data.at === 'number' &&
      Number.isFinite(data.at) &&
      data.nonce === nonce &&
      UUID.test(nonce);
    if (!valid) {
      return undefined;
    }
    return {
      v: 1,
      kind: data.kind as HandoffKind,
      sessionIds: [...(data.sessionIds as string[])],
      folder: data.folder as string,
      at: data.at as number,
      nonce,
    };
  }
}
