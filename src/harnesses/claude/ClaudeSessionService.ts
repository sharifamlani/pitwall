import * as fs from 'fs';
import * as path from 'path';
import { lastTextBlock, promptMatcher, truncateName } from '../../core/utils/text';
import { isWithin } from '../../core/utils/paths';
import { claudeProjectDirMatches, encodeClaudeProjectPath } from './paths';
import { HarnessSession, PreviewMessage, TurnState } from '../../core/harness/types';
import {
  ClaudeTurnReading,
  ClaudeTurnSignals,
  deriveClaudeTurnState,
  observeClaudeTurnEntry,
  readTurnStateTail,
} from './ClaudeTurnState';
import { RecordPathCatalog, StatCache } from '../../core/harness/kit/recordCache';
import { BoundedCache } from '../../core/utils/boundedCache';
import { parseJsonLine, readJsonlTail, scanJsonlLines } from '../../core/utils/jsonlTail';
import { claudeConfigDir, claudeProjectDirOverride } from './claudeConfig';

/**
 * A Claude Code session parsed from its JSONL transcript. Deliberately lean
 * (ADR 0007): naming, previews, last activity, and turn state. Recap,
 * model/token usage, git branch, and message counts have no cheap native
 * source and are absent.
 */
export interface ClaudeSession {
  /** The transcript's file name without `.jsonl`. */
  sessionId: string;
  /** Where the session runs; a `relocated` entry overrides the first stamp. */
  cwd: string;
  /**
   * The latest `custom-title` (the user's /rename, the name Claude's tab
   * shows), else the latest `ai-title`, else the last `summary`, else the
   * first prompt.
   */
  summary: string | null;
  /** Whether `summary` is a name the user gave the session in Claude (a `custom-title`). */
  userTitled: boolean;
  /** The transcript's mtime. */
  lastUpdated: Date | null;
  lastPromptAt: number | null;
  filePath: string;
  /** Whether the transcript has a main-chain user or assistant entry; required to resume. */
  hasMessages: boolean;
  turnState: TurnState;
  /** When the last completed turn ended; null while working. */
  turnEndedAt: number | null;
  /** The last three user prompts, oldest first. */
  recentUserPrompts: PreviewMessage[];
  lastAsk: PreviewMessage | null;
  /** Most recent assistant text; tool-only turns are skipped. */
  lastReply: PreviewMessage | null;
  /**
   * Where the session was started, from the transcript's first `entrypoint`:
   * `cli` (a terminal), `claude-vscode` (Claude's panel), `sdk-cli`
   * (`claude -p` or the SDK). Null when no line carries one.
   */
  entrypoint: string | null;
}

/**
 * Discovers Claude Code sessions under the profile's `projects/` directory.
 * Transcripts only append, so parses are cached by mtime+size.
 */
export class ClaudeSessionService {
  private static readonly CACHE_LIMIT = 500;
  /** Discovery dates every transcript of the last 14 days each pass: ~500 on a busy profile (2026-11-17). */
  private static readonly ACTIVITY_CACHE_LIMIT = 5_000;
  /**
   * How far from a transcript's end its last user entry is looked for. A
   * window this size parses in a few milliseconds; past it the file counts as
   * recent (its mtime is), never as a full read on the extension host (E16).
   */
  private static readonly ACTIVITY_TAIL_MAX_BYTES = 1024 * 1024;
  /** How much of a transcript a parse reads between yields to the extension host. */
  private static readonly PARSE_CHUNK_BYTES = 1024 * 1024;
  /** Bytes before a parse's end kept to tell an append from a rewrite. */
  private static readonly PARSE_CHECK_BYTES = 64;
  /** A first parse of a transcript larger than this decodes only the lines that matter (`skimFirstParse`). */
  private static readonly SKIM_MIN_BYTES = 1024 * 1024;
  /** How far into a line a tool result's `"tool_use_id"` is looked for (owner's profile: p99 728 bytes, max 47 KB). */
  private static readonly TOOL_RESULT_KEY_BYTES = 64 * 1024;
  /** How many of a listing's parses run at once (`inScanSlot`). */
  private static readonly SCAN_PARSES = 2;

  private readonly claudeDir: string;
  private readonly projectsDir: string;
  private readonly projectDirOverride: string | null;
  /** Parsed sessions keyed by file path, invalidated by mtime+size. */
  private readonly sessionFileCache = new StatCache<ClaudeSession | null>(
    ClaudeSessionService.CACHE_LIMIT
  );
  /**
   * Each transcript's parse so far, resumed when the file has only grown, so
   * a live transcript of hundreds of MB is parsed once, then only its new
   * lines (0.6.0 walk).
   */
  private readonly parseProgress = new BoundedCache<string, ParseProgress>(
    ClaudeSessionService.CACHE_LIMIT
  );
  /** The parse running for each transcript path, so a second caller waits for it instead of starting over. */
  private readonly parsing = new Map<string, Promise<ClaudeSession | null>>();
  /**
   * What the reads have done so far (`readCounters`): transcripts a listing
   * looked at and its wait for a parse slot; parses by any caller, first
   * (skimmed) or resumed, with the bytes each had to read and its time; reads
   * that failed.
   */
  private readonly counters = {
    files: 0,
    slotWaitMs: 0,
    firstParses: 0,
    firstParseBytes: 0,
    resumes: 0,
    resumeBytes: 0,
    parseMs: 0,
    failedReads: 0,
  };
  /** Listing parses running now, and the ones waiting for a slot. */
  private scanParses = 0;
  private readonly scanWaiting: Array<() => void> = [];
  /** Session ID to transcript path, refreshed when a cached path disappears. */
  private readonly sessionPaths = new RecordPathCatalog(
    ClaudeSessionService.CACHE_LIMIT
  );
  /** Tail readings keyed by file path, invalidated by mtime+size. */
  private readonly tailCache = new StatCache<ClaudeTurnReading | null>(
    ClaudeSessionService.CACHE_LIMIT
  );
  /** Last-activity readings keyed by file path, invalidated by mtime+size. */
  private readonly activityCache = new StatCache<number | null>(
    ClaudeSessionService.ACTIVITY_CACHE_LIMIT
  );

  /** Transcripts larger than this get a skimmed first parse. */
  private readonly skimMinBytes: number;

  constructor(options: { skimMinBytes?: number } = {}) {
    // Tests compare a skimmed parse with a whole one: 0 skims every file, Infinity none.
    this.skimMinBytes = options.skimMinBytes ?? ClaudeSessionService.SKIM_MIN_BYTES;
    // Read at construction time so a test can point the service at a temp
    // profile without changing the process environment mid-run.
    this.claudeDir = claudeConfigDir();
    this.projectsDir = path.join(this.claudeDir, 'projects');
    this.projectDirOverride = claudeProjectDirOverride();
  }

  /** A copy of the read counters, cumulative since the service started. */
  readCounters(): Readonly<Record<string, number>> {
    return { ...this.counters };
  }

  /** Whether a Claude profile directory exists. */
  isClaudeInstalled(): boolean {
    return fs.existsSync(this.claudeDir);
  }

  /**
   * Every project directory. Claude writes real directories, but a user may
   * symlink one in, so an entry that is not plainly a directory or a file is
   * followed instead of trusting the `Dirent`. Blocks while it reads: the
   * session scan uses `listProjectDirs`.
   */
  getProjectDirs(): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const dirs: string[] = [];
    for (const entry of entries) {
      const dir = this.projectDirFor(entry);
      if (dir === undefined) {
        continue;
      }
      if (dir !== null) {
        dirs.push(dir);
        continue;
      }
      try {
        if (fs.statSync(path.join(this.projectsDir, entry.name)).isDirectory()) {
          dirs.push(path.join(this.projectsDir, entry.name));
        }
      } catch {
        // A broken symlink is not a project directory.
      }
    }
    return dirs;
  }

  /** `getProjectDirs` without blocking the extension host, for the session scan (E16). */
  private async listProjectDirs(): Promise<string[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const dirs: string[] = [];
    for (const entry of entries) {
      const dir = this.projectDirFor(entry);
      if (dir === undefined) {
        continue;
      }
      if (dir !== null) {
        dirs.push(dir);
        continue;
      }
      try {
        if ((await fs.promises.stat(path.join(this.projectsDir, entry.name))).isDirectory()) {
          dirs.push(path.join(this.projectsDir, entry.name));
        }
      } catch {
        // A broken symlink is not a project directory.
      }
    }
    return dirs;
  }

  /** A listing entry's project directory; undefined when it is not one, null when only a stat can tell (a link). */
  private projectDirFor(entry: fs.Dirent): string | null | undefined {
    if (entry.name.startsWith('.') || entry.isFile()) {
      return undefined;
    }
    return entry.isDirectory() ? path.join(this.projectsDir, entry.name) : null;
  }

  /** The directory that holds one subdirectory per encoded project path. */
  getProjectsDirectory(): string {
    return this.projectsDir;
  }

  private async getSessionsInDir(projectDir: string): Promise<ClaudeSession[]> {
    const sessions: ClaudeSession[] = [];

    let files: string[];
    try {
      files = (await fs.promises.readdir(projectDir))
        .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
    } catch {
      return [];
    }

    for (const file of files) {
      const filePath = path.join(projectDir, file);
      const sessionId = file.replace('.jsonl', '');

      this.counters.files += 1;
      const asked = Date.now();
      try {
        const session = await this.inScanSlot(() => {
          this.counters.slotWaitMs += Date.now() - asked;
          return this.parseSessionFileCached(filePath, sessionId);
        });
        if (session) {
          sessions.push(session);
        }
      } catch (err) {
        console.error(`Failed to parse session ${file}:`, err);
      }
    }

    return sessions;
  }

  /**
   * Run one of a listing's parses when one of SCAN_PARSES slots is free. A
   * scan lists every repository at once, and each parse reads its transcript
   * in 1 MB chunks back to back: 21 of them filled libuv's four file threads,
   * so a status poll's small reads (and discovery's) queued behind them (PR
   * #76 live gate: polls of 0.5–5 s). A lookup of one session
   * (`getSessionById`, new-chat pickup, the tree) never waits for a slot.
   */
  private async inScanSlot<T>(run: () => Promise<T>): Promise<T> {
    if (this.scanParses >= ClaudeSessionService.SCAN_PARSES) {
      await new Promise<void>((resolve) => this.scanWaiting.push(resolve));
    } else {
      this.scanParses++;
    }
    try {
      return await run();
    } finally {
      // Hand the slot straight to the next waiter, or give it back.
      const next = this.scanWaiting.shift();
      if (next) {
        next();
      } else {
        this.scanParses--;
      }
    }
  }

  /**
   * A parsed transcript; the tree can re-render without re-reading any.
   *
   * One parse per file at a time: a caller that arrives while one runs waits
   * for it, then takes the cached result, or resumes from where it ended when
   * the file grew meanwhile. Before, the second caller started a parse of
   * its own from byte 0 (the first had taken the resume point), so the scan,
   * the tree and a live import asking about one 700 MB transcript at once
   * each parsed all of it (QA on #76).
   */
  private async parseSessionFileCached(filePath: string, sessionId: string): Promise<ClaudeSession | null> {
    for (let running = this.parsing.get(filePath); running; running = this.parsing.get(filePath)) {
      await running.catch(() => undefined);
    }
    // No await between the check above and this set: no second parse can start in between.
    // A read that fails is not cached: the last good parse stands in (the
    // session stays listed), and the next call tries again from the parse's
    // resume point (`parseSessionFile`).
    const parse = this.sessionFileCache
      .get(filePath, (stats) => this.parseSessionFile(filePath, sessionId, stats))
      .catch(() => this.sessionFileCache.last(filePath)?.value ?? null);
    this.parsing.set(filePath, parse);
    try {
      return await parse;
    } finally {
      if (this.parsing.get(filePath) === parse) {
        this.parsing.delete(filePath);
      }
    }
  }

  /**
   * When a transcript's last message was written: the value import and
   * listing use (`toHarnessSession`'s `lastActivity`), the last user entry's
   * time, else the file's mtime. Read from the transcript's tail, never the
   * whole file: discovery asks this of every recent transcript each pass,
   * and a full parse blocked the extension host for the largest file's
   * length (E16). Null when it cannot tell: the file cannot be read, or no
   * user entry is in its last megabyte.
   */
  async lastActivityOfFile(filePath: string): Promise<number | null> {
    return this.activityCache.get(filePath, async (stats) => {
      // A parse the scan already made answers it as import would.
      const parsed = this.sessionFileCache.peek(filePath, stats);
      if (parsed) {
        return parsed.value ? toHarnessSession(parsed.value).lastActivity : null;
      }
      return readJsonlTail(
        filePath,
        (entries) => {
          for (let i = entries.length - 1; i >= 0; i--) {
            const promptAt = promptClockOf(entries[i]);
            if (promptAt !== null) {
              return { value: promptAt, decided: true };
            }
          }
          // No user entry up to the file's start: the mtime, as a parse gives.
          return { value: stats.mtimeMs, decided: false };
        },
        { maxBytes: ClaudeSessionService.ACTIVITY_TAIL_MAX_BYTES }
      );
    });
  }

  /**
   * Read without blocking the extension host: a scan parses every transcript
   * of every repository (129 at 1 MB each on the E16 profile), and a
   * synchronous read held the list's first render behind all of them.
   *
   * The file is read in 1 MB chunks with a yield between each, and never held
   * as one string: a whole-file read blocked the host for about a second per
   * 250 MB, and a transcript past V8's string limit (~512 MB) could not be
   * read at all. Transcripts only append, so a file that has only grown
   * since its last parse resumes where that parse ended; a file that shrank
   * or changed before that point is parsed again from the start.
   *
   * A read that fails (the file busy for a moment, an I/O error) rejects, so
   * the caller neither caches it nor loses the session: the transcript's
   * resume point is kept, advanced to the last whole line this attempt fed
   * (`parseFrom` keeps its check current), and the next parse goes on from
   * there. Before, a failure dropped it and was cached as "no session" until
   * the file changed, and the next parse read the whole transcript again.
   */
  private async parseSessionFile(filePath: string, sessionId: string, stats: fs.Stats): Promise<ClaudeSession | null> {
    // `parseSessionFileCached` runs one parse per file at a time, so nothing
    // else feeds this progress while it runs.
    const previous = this.parseProgress.get(filePath);
    if (stats.size === 0) {
      this.parseProgress.delete(filePath);
      return null;
    }
    const started = Date.now();
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(filePath, 'r');
    } catch (error) {
      this.counters.failedReads += 1;
      throw error;
    }
    let progress: ParseProgress | undefined;
    try {
      if (previous && (await this.continues(handle, previous, stats.size))) {
        progress = previous;
        this.counters.resumes += 1;
        this.counters.resumeBytes += stats.size - previous.offset;
      } else {
        // A rewritten file: the old resume point no longer holds.
        this.parseProgress.delete(filePath);
        progress = { parser: new TranscriptParser(sessionId, filePath), offset: 0, check: Buffer.alloc(0), checkAt: 0 };
        this.counters.firstParses += 1;
        this.counters.firstParseBytes += stats.size;
        await this.skimFirstParse(handle, progress, stats.size);
      }
      await this.parseFrom(handle, progress, stats.size);
      this.parseProgress.set(filePath, progress);
      return progress.parser.finish(stats.mtime);
    } catch (error) {
      this.counters.failedReads += 1;
      // The lines fed so far are a prefix of the file (a skim passes over only
      // lines that cannot matter; what follows is decoded in full later), so a
      // resume point whose check names bytes the file holds is kept.
      if (progress && progress.check.length > 0) {
        this.parseProgress.set(filePath, progress);
      }
      throw error;
    } finally {
      this.counters.parseMs += Date.now() - started;
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * A first parse of a large transcript reads every byte but decodes only the
   * lines that can still change the result, and leaves `progress` where the
   * full parse takes over. Every window parsed all of the owner's 3.4 GB at
   * startup (one transcript is 711 MB), holding the extension host at 1–2.3
   * cores for 40–85 s while status polls took up to 5 s (PR #76 live gate).
   *
   * What a session needs from lines before its tail: its first cwd,
   * entrypoint and typed prompt, whether it has messages, every title,
   * summary and relocation, and its last three typed prompts. The rest
   * (last activity, last reply, turn state) comes from the latest such lines,
   * which `tailMarks` finds from the end. A line is decoded when it can be
   * one of those: Claude writes compact JSON, so an entry's `"type":"user"`,
   * its keys and its title or summary type appear verbatim in its bytes, and
   * only in an entry's structure (a quote inside a string is escaped). A
   * line with the key `"tool_use_id":` is a tool result, never a typed prompt:
   * a prompt, title or summary is a flat string, where a quote is escaped, so
   * it can hold that word as a value but never as a key.
   * Small files are parsed whole: it costs less than two passes.
   */
  private async skimFirstParse(handle: fs.promises.FileHandle, progress: ParseProgress, size: number): Promise<void> {
    if (size <= this.skimMinBytes) {
      return;
    }
    // A transcript not written as compact JSON would hide the patterns: it is parsed whole.
    if (!(await this.writtenCompact(handle, size))) {
      return;
    }
    const marks = await this.tailMarks(handle, size);
    // From here on every line is decoded: it holds the last conversation entry, the last user entry and all after them.
    const tail = Math.min(marks.conversation, marks.userEntry, size);
    const parser = progress.parser;
    await this.parseFrom(handle, progress, tail, (line, start) => {
      const head = !parser.hasMessages || !parser.hasCwd || !parser.hasEntrypoint;
      // A tool result (its key comes within the first few hundred bytes): never a typed prompt, a title, a
      // summary or a relocation, whose flat fields can't hold the key unescaped. Half the owner's bytes are
      // tool results; this spares them the full search below. Only user and api-request-blob entries held
      // the key on the owner's profile (117,020 lines, 2026-11-20).
      if (!head && start < marks.reply && line.subarray(0, ClaudeSessionService.TOOL_RESULT_KEY_BYTES).indexOf(TOOL_USE_ID) >= 0) {
        return false;
      }
      const types = entryTypes(line);
      return (
        types.rare ||
        (types.assistant && start >= marks.reply) ||
        (types.user && line.indexOf(TOOL_USE_ID) < 0) ||
        (!parser.hasMessages && (types.user || types.assistant)) ||
        (!parser.hasCwd && line.indexOf(CWD_KEY) >= 0) ||
        (!parser.hasEntrypoint && line.indexOf(ENTRYPOINT_KEY) >= 0)
      );
    });
  }

  /** Whether the transcript's first entry carries its type as compact JSON writes it (`"type":"<type>"`). */
  private async writtenCompact(handle: fs.promises.FileHandle, size: number): Promise<boolean> {
    const head = Buffer.allocUnsafe(Math.min(size, ClaudeSessionService.PARSE_CHUNK_BYTES));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const newline = head.subarray(0, bytesRead).indexOf(10);
    if (newline < 0) {
      return false;
    }
    const line = head.subarray(0, newline);
    const entry = parseJsonLine(line.toString('utf8')) as TranscriptEntry | undefined;
    return Boolean(entry && typeof entry === 'object' && typeof entry.type === 'string' && line.includes(`"type":${JSON.stringify(entry.type)}`));
  }

  /**
   * Where the last lines a session's tail fields come from begin, read from
   * the end: the last main-chain conversation entry (turn state), the last
   * user entry with a time (last activity), and the last assistant entry with
   * text (last reply). Infinity for one the file has none of. Only lines that
   * can be one of those are decoded, so the walk back past a long run of tool
   * results to the last reply stays cheap.
   */
  private async tailMarks(handle: fs.promises.FileHandle, size: number): Promise<{ conversation: number; userEntry: number; reply: number }> {
    const marks = { conversation: Infinity, userEntry: Infinity, reply: Infinity };
    const open = () => marks.conversation === Infinity || marks.userEntry === Infinity || marks.reply === Infinity;
    const visit = (line: Buffer, start: number) => {
      const { user, assistant } = entryTypes(line);
      if (!user && !assistant) {
        return;
      }
      if (!(marks.conversation === Infinity || (user && marks.userEntry === Infinity) || (assistant && marks.reply === Infinity))) {
        return;
      }
      const entry = parseJsonLine(line.toString('utf8')) as TranscriptEntry | undefined;
      if (!entry || typeof entry !== 'object') {
        return;
      }
      const main = (entry.type === 'user' || entry.type === 'assistant') && !entry.isSidechain;
      if (main && marks.conversation === Infinity) {
        marks.conversation = start;
      }
      if (marks.userEntry === Infinity && promptClockOf(entry) !== null) {
        marks.userEntry = start;
      }
      if (main && entry.type === 'assistant' && marks.reply === Infinity && entry.message && lastTextBlock(entry.message.content)) {
        marks.reply = start;
      }
    };
    // Back from the end in chunks, yielding between them. `carry` is the head of the line the later chunk began inside.
    let position = size;
    let carry: Buffer[] = [];
    while (position > 0 && open()) {
      const from = Math.max(0, position - ClaudeSessionService.PARSE_CHUNK_BYTES);
      // Only the bytes read are used, so no need to zero it first.
      const buffer = Buffer.allocUnsafe(position - from);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
      const chunk = buffer.subarray(0, bytesRead);
      position = from;
      // Inside one long line: keep the pieces, and join them once its start is found.
      if (from > 0 && chunk.indexOf(10) < 0) {
        carry.unshift(chunk);
        continue;
      }
      const data = carry.length > 0 ? Buffer.concat([chunk, ...carry]) : chunk;
      let end = data.length;
      // The trailing line with no newline after it (a write in progress) counts only if it is JSON, as in a parse.
      for (let newline = data.lastIndexOf(10, end - 1); newline >= 0 && open(); newline = data.lastIndexOf(10, end - 1)) {
        if (newline + 1 < end) {
          visit(data.subarray(newline + 1, end), from + newline + 1);
        }
        end = newline;
      }
      if (!open()) {
        break;
      }
      if (from === 0) {
        if (end > 0) {
          visit(data.subarray(0, end), 0);
        }
        break;
      }
      carry = end > 0 ? [data.subarray(0, end)] : [];
    }
    return marks;
  }

  /** Whether the file still holds what a parse read, so it may resume at its end. */
  private async continues(handle: fs.promises.FileHandle, progress: ParseProgress, size: number): Promise<boolean> {
    if (size < progress.offset) {
      return false;
    }
    const length = progress.check.length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, progress.checkAt - length);
    return bytesRead === length && buffer.equals(progress.check);
  }

  /**
   * Feed the parser every line from the progress offset to `size`, chunk by
   * chunk. A line is cut at its newline byte, which never occurs inside a
   * UTF-8 sequence. A last line without its newline is read as a whole-file
   * parse reads it; one that is not JSON yet (a write in progress) is left
   * for the next parse. With `wanted`, a line it turns down (by its bytes and
   * where it starts) is passed over undecoded (`skimFirstParse`); `size` is
   * then a line start, so no line is cut there.
   */
  private async parseFrom(
    handle: fs.promises.FileHandle,
    progress: ParseProgress,
    size: number,
    wanted?: (line: Buffer, start: number) => boolean
  ): Promise<void> {
    let position = progress.offset;
    let pending: Buffer[] = [];
    while (position < size) {
      // Only the bytes read are used, so no need to zero it first.
      const buffer = Buffer.allocUnsafe(Math.min(ClaudeSessionService.PARSE_CHUNK_BYTES, size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      position += bytesRead;
      let start = 0;
      for (let newline = chunk.indexOf(10); newline >= 0; newline = chunk.indexOf(10, start)) {
        pending.push(chunk.subarray(start, newline));
        const line = pending.length === 1 ? pending[0] : Buffer.concat(pending);
        if (!wanted || wanted(line, progress.offset)) {
          progress.parser.add(line.toString('utf8'));
        }
        pending = [];
        start = newline + 1;
        progress.offset = position - chunk.length + start;
      }
      // The bytes before the last whole line fed, kept as the parse goes: a
      // read that fails later leaves a resume point that can still be checked.
      if (start >= ClaudeSessionService.PARSE_CHECK_BYTES) {
        progress.check = Buffer.from(chunk.subarray(start - ClaudeSessionService.PARSE_CHECK_BYTES, start));
        progress.checkAt = progress.offset;
      }
      if (start < chunk.length) {
        pending.push(chunk.subarray(start));
      }
    }
    const rest = Buffer.concat(pending).toString('utf8');
    if (rest && parseJsonLine(rest) !== undefined) {
      progress.parser.add(rest);
      progress.offset = position;
    }
    const checkStart = Math.max(0, progress.offset - ClaudeSessionService.PARSE_CHECK_BYTES);
    const check = Buffer.alloc(progress.offset - checkStart);
    const { bytesRead } = await handle.read(check, 0, check.length, checkStart);
    progress.check = check.subarray(0, bytesRead);
    progress.checkAt = checkStart + bytesRead;
  }

  /**
   * Claude stores each session under `<projects>/<encoded cwd>`. A worktree's
   * sessions live in its own project dir, and sessions started in a
   * subdirectory encode as `<worktree>-<subdir>`, so only those dirs need to
   * be parsed.
   *
   * The name match is deliberately a superset: the encoding is lossy
   * (`/x/repo-other` encodes like `/x/repo/other`), and callers still verify
   * the parsed `cwd`.
   */
  private async getProjectDirsForPaths(paths: string[]): Promise<string[]> {
    const encodedRoots = paths.map(encodeClaudeProjectPath);

    return (await this.listProjectDirs()).filter((dir) => {
      const name = path.basename(dir);
      // An explicit project-dir name overrides Claude's path encoding.
      if (this.projectDirOverride && name === this.projectDirOverride) {
        return true;
      }
      return encodedRoots.some((root) => claudeProjectDirMatches(root, name));
    });
  }

  /**
   * Parse sessions from the given project dirs, most recently updated first.
   */
  private async getSessionsInDirs(dirs: string[]): Promise<ClaudeSession[]> {
    const byId = new Map<string, ClaudeSession>();
    for (const dir of dirs) {
      for (const session of await this.getSessionsInDir(dir)) {
        // A relocated session can leave a transcript in its old project dir;
        // the newest one is the live transcript.
        const existing = byId.get(session.sessionId);
        if (
          !existing ||
          (session.lastUpdated?.getTime() ?? 0) >
            (existing.lastUpdated?.getTime() ?? 0)
        ) {
          byId.set(session.sessionId, session);
        }
      }
    }

    // The tree looks each session up by ID next; the scan already found it.
    for (const session of byId.values()) {
      this.sessionPaths.remember(session.sessionId, session.filePath);
    }

    return [...byId.values()].sort((a, b) => {
      if (!a.lastUpdated) return 1;
      if (!b.lastUpdated) return -1;
      return b.lastUpdated.getTime() - a.lastUpdated.getTime();
    });
  }

  /** Sessions whose cwd is the worktree or inside it. */
  async findSessionsForWorktree(worktreePath: string): Promise<ClaudeSession[]> {
    const sessions = await this.getSessionsInDirs(
      await this.getProjectDirsForPaths([worktreePath])
    );

    // The directory match can over-include when encoding is ambiguous; keep
    // the exact cwd check as the source of truth.
    return sessions.filter((session) => isWithin(session.cwd, worktreePath));
  }

  /** Sessions whose cwd is inside the repository root or any of its worktrees. */
  async findSessionsForRepository(repoRootPath: string, worktreePaths: string[]): Promise<ClaudeSession[]> {
    const roots = [repoRootPath, ...worktreePaths];
    const sessions = await this.getSessionsInDirs(
      await this.getProjectDirsForPaths(roots)
    );

    return sessions.filter((session) =>
      roots.some((root) => isWithin(session.cwd, root))
    );
  }

  /**
   * Locate a session's transcript by ID.
   *
   * The ID does not reveal which project directory the session started in, so
   * the first lookup scans project dirs and the result is cached. A cached
   * path that no longer exists is refreshed before falling back to a scan.
   * When a session was relocated, the old project dir can still hold a
   * transcript with the same ID, so the newest file wins.
   *
   * `missTtlMs` memoizes a miss, so a caller that polls for a transcript that
   * does not exist yet does not rescan every project dir on each pass.
   */
  getSessionFilePath(sessionId: string, missTtlMs = 0): string | null {
    return this.sessionPaths.find(
      sessionId,
      () => {
        let newest: { filePath: string; mtimeMs: number } | null = null;
        for (const dir of this.getProjectDirs()) {
          const filePath = path.join(dir, `${sessionId}.jsonl`);
          let stats: fs.Stats;
          try {
            stats = fs.statSync(filePath);
          } catch {
            continue;
          }
          if (stats.isFile() && (!newest || stats.mtimeMs > newest.mtimeMs)) {
            newest = { filePath, mtimeMs: stats.mtimeMs };
          }
        }
        return newest?.filePath ?? null;
      },
      missTtlMs
    );
  }

  /**
   * Turn state from a transcript tail, cached by mtime+size. The attention
   * tick reads the same transcripts every few seconds; without this it would
   * re-read unchanged files.
   */
  async readTurnState(filePath: string): Promise<ClaudeTurnReading | null> {
    // A null reading is a transient read failure; caching it would pin a
    // stale turn state until the transcript next changes.
    return this.tailCache.get(filePath, () => readTurnStateTail(filePath), { cacheNull: false });
  }

  /** When the transcript was last written (its mtime in ms), or null if it cannot be read. */
  async transcriptWrittenAt(filePath: string): Promise<number | null> {
    try {
      return (await fs.promises.stat(filePath)).mtimeMs;
    } catch {
      return null;
    }
  }

  async getSessionById(sessionId: string): Promise<ClaudeSession | null> {
    const filePath = this.getSessionFilePath(sessionId);
    return filePath ? this.parseSessionFileCached(filePath, sessionId) : null;
  }

  /**
   * Whether a session can be resumed. This reuses the parsed transcript, so
   * after a tree render (or the first call) it costs nothing.
   */
  async isSessionResumable(sessionId: string): Promise<boolean> {
    const filePath = this.getSessionFilePath(sessionId);
    if (!filePath) {
      return false;
    }

    const session = await this.parseSessionFileCached(filePath, sessionId);
    return session !== null && session.hasMessages;
  }

  /**
   * The transcript's first `entrypoint`, from the cached parse; undefined
   * when there is no transcript.
   */
  async getEntrypoint(sessionId: string): Promise<string | null | undefined> {
    const session = await this.getSessionById(sessionId);
    return session ? session.entrypoint : undefined;
  }

  /** The last few user prompts, from the cached parse. */
  async getSessionPreview(sessionId: string, maxMessages = 3): Promise<PreviewMessage[]> {
    const session = await this.getSessionById(sessionId);
    if (!session) {
      return [];
    }
    return session.recentUserPrompts.slice(-maxMessages);
  }

  /**
   * A session and the earliest prompt the user typed in it that begins with
   * `opening`, ignoring case and whitespace. The transcript is streamed once:
   * an uncached one is parsed on the same pass and the parse is cached, and a
   * cached one is read only until the prompt turns up.
   */
  async findSessionPrompt(
    sessionId: string,
    opening: string
  ): Promise<{ session: ClaudeSession; prompt?: PreviewMessage } | null> {
    const filePath = this.getSessionFilePath(sessionId);
    if (!filePath) {
      return null;
    }
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(filePath);
    } catch {
      return null;
    }
    const matches = promptMatcher(opening);
    const fresh = this.sessionFileCache.peek(filePath, stats);
    if (fresh && (!fresh.value || !matches)) {
      return fresh.value ? { session: fresh.value } : null;
    }

    const parser = fresh ? undefined : new TranscriptParser(sessionId, filePath);
    let prompt: PreviewMessage | undefined;
    try {
      await scanJsonlLines(filePath, (line) => {
        const entry = parser ? parser.add(line) : parseJsonLine(line);
        const text: string | null = prompt || !matches ? null : claudeUserPrompt(entry);
        if (text && matches!(text)) {
          const timestamp = new Date((entry as { timestamp?: string }).timestamp ?? NaN).getTime();
          prompt = { text, timestamp: isNaN(timestamp) ? null : timestamp };
          // A fresh parse reads on to the end; a cached one can stop here.
          return !parser;
        }
      });
    } catch {
      // An unreadable transcript confirms nothing.
      return null;
    }

    const session = parser ? parser.finish(stats.mtime) : fresh!.value;
    if (parser) {
      this.sessionFileCache.set(filePath, stats, session);
    }
    return session ? { session, prompt } : null;
  }
}

/**
 * Byte patterns `skimFirstParse` looks for in a line before decoding it. Claude
 * writes compact JSON, so each appears verbatim wherever its entry does, and a
 * quote inside a string is escaped, so `"type":"` starts a real type field.
 */
const TYPE_FIELD = Buffer.from('"type":"');
/**
 * The tool_use_id key, with its colon: a string value of exactly `tool_use_id`
 * (a /rename, a prompt, a git branch) is followed by `,` `}` or `]`, never `:`
 * (QA on #78).
 */
const TOOL_USE_ID = Buffer.from('"tool_use_id":');
const CWD_KEY = Buffer.from('"cwd"');
const ENTRYPOINT_KEY = Buffer.from('"entrypoint"');
const USER = Buffer.from('user"');
const ASSISTANT = Buffer.from('assistant"');
/** The entry types that can sit anywhere and still name or place the session. */
const RARE_TYPES = ['custom-title"', 'ai-title"', 'summary"', 'relocated"'].map((value) => Buffer.from(value));
/** The first bytes of every type value above. */
const TYPE_FIRST_BYTES = new Set([USER, ASSISTANT, ...RARE_TYPES].map((value) => value[0]));

/**
 * Which type values a line holds, from one pass over its `"type":"` fields
 * (nested ones too, so it may say more than the entry is, never less). One
 * search instead of one per pattern: the searches cost more than the decoding
 * they saved (700 MB: 2.6 s for seven, against 3.2 s to decode).
 */
function entryTypes(line: Buffer): { user: boolean; assistant: boolean; rare: boolean } {
  const types = { user: false, assistant: false, rare: false };
  for (let at = line.indexOf(TYPE_FIELD); at >= 0; at = line.indexOf(TYPE_FIELD, at + TYPE_FIELD.length)) {
    const value = at + TYPE_FIELD.length;
    // Most hits are nested blocks (text, tool_use, image, thinking): one byte rules them out.
    if (!TYPE_FIRST_BYTES.has(line[value])) {
      continue;
    }
    if (startsWithAt(line, value, USER)) {
      types.user = true;
    } else if (startsWithAt(line, value, ASSISTANT)) {
      types.assistant = true;
    } else if (RARE_TYPES.some((rare) => startsWithAt(line, value, rare))) {
      types.rare = true;
    }
  }
  return types;
}

/** Whether `line` holds `pattern` at `at`. */
function startsWithAt(line: Buffer, at: number, pattern: Buffer): boolean {
  return at + pattern.length <= line.length && line.compare(pattern, 0, pattern.length, at, at + pattern.length) === 0;
}

/**
 * A transcript's parse so far: the parser, the bytes it has read, and bytes
 * it read (`check`, ending at `checkAt`, at most a chunk before `offset`) that
 * the file must still hold for the parse to resume.
 */
interface ParseProgress {
  parser: TranscriptParser;
  offset: number;
  check: Buffer;
  checkAt: number;
}

/** A transcript line's fields, as Claude writes them; any may be missing or odd. */
type TranscriptEntry = Record<string, any>;

/**
 * Builds a `ClaudeSession` from transcript lines fed in order, so a whole-file
 * read and a stream share one parse.
 */
class TranscriptParser {
  private readonly session: ClaudeSession;
  private firstUserPrompt: string | null = null;
  // Claude stores the name it generates as `ai-title` entries and the user's
  // /rename as `custom-title` entries, rewritten all through the transcript.
  // A custom title is what Claude's tab shows, so the latest one outranks the
  // latest ai-title, which outranks a summary or the first prompt.
  private customTitle: string | null = null;
  private aiTitle: string | null = null;
  // The shared turn observer reads the last conversational entry and the
  // authoritative pending-agent count the attention tick also uses.
  private readonly turnSignals: ClaudeTurnSignals = { lastConversation: null, pendingBackgroundAgents: null };

  constructor(sessionId: string, filePath: string) {
    this.session = {
      sessionId,
      cwd: '',
      summary: null,
      lastUpdated: null,
      lastPromptAt: null,
      filePath,
      hasMessages: false,
      turnState: 'working',
      turnEndedAt: null,
      recentUserPrompts: [],
      lastAsk: null,
      lastReply: null,
      entrypoint: null,
      userTitled: false,
    };
  }

  /** A main-chain user or assistant entry has been read. */
  get hasMessages(): boolean {
    return this.session.hasMessages;
  }

  /** A line has placed the session in a folder. */
  get hasCwd(): boolean {
    return Boolean(this.session.cwd);
  }

  /** A line has said where the session started. */
  get hasEntrypoint(): boolean {
    return this.session.entrypoint !== null;
  }

  /** Read one line; returns its entry, or undefined for a blank or corrupt line. */
  add(line: string): unknown {
    // A partial or corrupt line does not invalidate the transcript.
    const entry = parseJsonLine(line);
    if (entry && typeof entry === 'object') {
      try {
        this.observe(entry as TranscriptEntry);
      } catch {
        // One odd entry does not invalidate the transcript.
      }
    }
    return entry;
  }

  private observe(entry: TranscriptEntry): void {
    const session = this.session;

    if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
      // An empty one keeps the previous rename, as Claude's own reader does
      // (`|| previous`), so the name matches the title on Claude's tab.
      this.customTitle = entry.customTitle.trim() || this.customTitle;
    }

    if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') {
      const title = entry.aiTitle.trim();
      if (title) {
        this.aiTitle = title;
      }
    }

    // The last summary is usually the most descriptive.
    if (entry.type === 'summary' && entry.summary) {
      session.summary = entry.summary;
    }

    observeClaudeTurnEntry(entry, this.turnSignals);

    const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : NaN;

    if ((entry.type === 'user' || entry.type === 'assistant') && !entry.isSidechain) {
      session.hasMessages = true;
    }

    // Only prompts the user typed name the session and fill previews.
    const prompt = claudeUserPrompt(entry);
    if (prompt) {
      this.firstUserPrompt ??= prompt;
      const message: PreviewMessage = { text: prompt, timestamp: isNaN(timestamp) ? null : timestamp };
      session.lastAsk = message;
      session.recentUserPrompts.push(message);
      // Only the newest few are ever shown.
      if (session.recentUserPrompts.length > 3) {
        session.recentUserPrompts.shift();
      }
    }

    const promptAt = promptClockOf(entry);
    if (promptAt !== null) {
      session.lastPromptAt = promptAt;
    }

    // Assistant text is the closest thing to a "last reply"; tool-only turns
    // have no text block and are skipped. Sidechain entries are subagent
    // traffic, not the main conversation.
    if (entry.type === 'assistant' && entry.message && !entry.isSidechain) {
      const text = lastTextBlock((entry.message as { content?: unknown })?.content);
      if (text) {
        session.lastReply = { text, timestamp: isNaN(timestamp) ? null : timestamp };
      }
    }

    // A relocation entry names the session's current directory. It outranks
    // the cwd stamped on earlier entries, and the transcript may still sit
    // under the old project dir.
    if (entry.type === 'relocated' && typeof entry.relocatedCwd === 'string') {
      session.cwd = entry.relocatedCwd;
    }

    // The session's cwd is the source of truth for discovery.
    if (entry.cwd && !session.cwd) {
      session.cwd = entry.cwd;
    }

    // The first entrypoint is how the session started; a later resume from
    // another surface stamps its own on new lines.
    if (session.entrypoint === null && typeof entry.entrypoint === 'string' && entry.entrypoint) {
      session.entrypoint = entry.entrypoint;
    }
  }

  /**
   * The session as of the lines read so far, or null when no line placed it
   * in a folder. A new object each call, so the parse can go on after it.
   */
  finish(mtime: Date): ClaudeSession | null {
    // The tail reader and the full parser share this derivation so the
    // attention tick and the tree cannot disagree about a session's state.
    const turn = deriveClaudeTurnState(this.turnSignals);
    const session: ClaudeSession = {
      ...this.session,
      lastUpdated: mtime,
      recentUserPrompts: [...this.session.recentUserPrompts],
      turnState: turn.turnState,
      turnEndedAt: turn.turnEndedAt,
    };

    // The user's own name for the session, then Claude's, then a summary,
    // then the first prompt.
    if (this.customTitle) {
      session.summary = this.customTitle;
      session.userTitled = true;
    } else if (this.aiTitle) {
      session.summary = this.aiTitle;
    } else if (!session.summary && this.firstUserPrompt) {
      session.summary = truncateName(this.firstUserPrompt);
    }
    // Discovery maps sessions by cwd; one without it cannot be placed.
    return session.cwd ? session : null;
  }
}

/**
 * The time a user entry dates its session by (`lastPromptAt`, the session's
 * last activity), or null for any other entry. Any user entry counts, tool
 * results included; the full parse and the tail reader share this rule.
 */
function promptClockOf(entry: unknown): number | null {
  const record = entry as { type?: unknown; timestamp?: unknown } | null;
  if (!record || typeof record !== 'object' || record.type !== 'user' || !record.timestamp) {
    return null;
  }
  const timestamp = new Date(record.timestamp as string).getTime();
  return isNaN(timestamp) ? null : timestamp;
}

/**
 * The text of a prompt the user typed, or null for any other transcript line.
 * Claude also stores as user messages: tool results, subagent traffic
 * (`isSidechain`), injected context such as skills and reminders (`isMeta`),
 * compaction summaries (`isCompactSummary`), and command output (`<...>`).
 * Slash commands (`/model`) are the user's but do not describe the session.
 */
function claudeUserPrompt(entry: unknown): string | null {
  const record = entry as {
    type?: unknown;
    message?: unknown;
    isSidechain?: unknown;
    isMeta?: unknown;
    isCompactSummary?: unknown;
  } | null;
  if (
    record?.type !== 'user' ||
    !record.message ||
    record.isSidechain ||
    record.isMeta ||
    record.isCompactSummary
  ) {
    return null;
  }
  const text = messageText(record.message).trim();
  return text && !text.startsWith('/') && !text.startsWith('<') ? text : null;
}

/** First text block of a message, or its plain string form. */
function messageText(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }
  const content = (message as { content?: unknown })?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
    }
  }
  return '';
}

/** A parsed transcript in the shape every harness reports. */
export function toHarnessSession(session: ClaudeSession): HarnessSession {
  return {
    harness: 'claude',
    sessionId: session.sessionId,
    cwd: session.cwd,
    summary: session.summary,
    gitBranch: null,
    lastUpdated: session.lastUpdated,
    lastActivity: session.lastPromptAt ?? session.lastUpdated?.getTime() ?? null,
    messageCount: 0,
    turnState: session.turnState,
    turnEndedAt: session.turnEndedAt,
    ...(session.userTitled ? { userTitled: true } : {}),
  };
}
