import * as fs from 'fs';
import * as path from 'path';
import { DiscoveredFolder, DiscoveryCounts } from '../../core/harness/types';
import { StatCache } from '../../core/harness/kit/recordCache';
import { ClaudeSessionService } from './ClaudeSessionService';
import { parseJsonLine, scanJsonlLines } from '../../core/utils/jsonlTail';

/**
 * How far into a transcript the cwd is looked for. Heads start with
 * `queue-operation` entries without one, and an attachment line can exceed
 * 64 KB, but a cwd past the first megabyte means the file is not a session.
 */
const HEAD_MAX_BYTES = 1024 * 1024;

/** Transcripts remembered across passes; 14 days of sessions is ~500 (2026-11-17). */
const CACHE_LIMIT = 5_000;

/** What a transcript's head says: the session's folder and when it started. */
interface TranscriptHead {
  cwd: string;
  startedAt: number;
}

/**
 * Folders Claude Code sessions ran in, from the heads of the transcripts
 * under `<configDir>/projects/<encoded cwd>/<session>.jsonl` (ADR 0019).
 * Only files written in the window are opened, each only up to its first
 * entry with a `cwd` and back from its end to its last user entry, never in
 * full: a pass looks at every recent transcript, and a whole-file parse
 * blocks the extension host (E16). Read-only; nothing from a file is logged.
 */
export class ClaudeRepoDiscovery {
  /** Heads keyed by transcript path, reused while mtime and size hold. */
  private readonly heads = new StatCache<TranscriptHead | null>(CACHE_LIMIT);

  constructor(
    private readonly projectsDir: string,
    /** Dates a transcript by its last message, as import does, from its tail. */
    private readonly sessions: ClaudeSessionService
  ) {}

  async discoverRecentFolders(sinceMs: number, counts?: DiscoveryCounts): Promise<DiscoveredFolder[]> {
    let projects: string[];
    try {
      projects = await fs.promises.readdir(this.projectsDir);
    } catch {
      return [];
    }

    const byCwd = new Map<string, DiscoveredFolder>();
    for (const project of projects) {
      if (project.startsWith('.')) {
        continue;
      }
      const dir = path.join(this.projectsDir, project);
      let files: string[];
      try {
        files = await fs.promises.readdir(dir);
      } catch {
        // A stray file beside the project directories.
        continue;
      }
      for (const file of files) {
        // `agent-*` transcripts are subagents of a session, not sessions.
        if (!file.endsWith('.jsonl') || file.startsWith('agent-')) {
          continue;
        }
        const filePath = path.join(dir, file);
        let stats: fs.Stats;
        try {
          stats = await fs.promises.stat(filePath);
        } catch {
          continue;
        }
        if (stats.mtimeMs < sinceMs) {
          continue;
        }
        // The file's mtime only says it was touched; import goes by the last
        // message. The mtime stays the cheap prefilter above.
        const lastMessageAt = await this.sessions.lastActivityOfFile(filePath);
        if (lastMessageAt !== null && lastMessageAt < sinceMs) {
          continue;
        }
        const head = await this.readHead(filePath, stats);
        if (!head) {
          if (counts) {
            counts.skipped += 1;
          }
          continue;
        }
        if (counts) {
          counts.sessions = (counts.sessions ?? 0) + 1;
        }
        const folder = byCwd.get(head.cwd);
        if (!folder) {
          byCwd.set(head.cwd, { cwd: head.cwd, firstEntryAt: head.startedAt, lastActivity: stats.mtimeMs });
        } else {
          // The newest session's start decides whether a dismissed repo returns (P2).
          folder.firstEntryAt = Math.max(folder.firstEntryAt, head.startedAt);
          folder.lastActivity = Math.max(folder.lastActivity, stats.mtimeMs);
        }
      }
    }
    return [...byCwd.values()];
  }

  /** The head of one transcript, or null when it names no folder or cannot be read. */
  private async readHead(filePath: string, stats: fs.Stats): Promise<TranscriptHead | null> {
    const cached = this.heads.peek(filePath, stats);
    if (cached) {
      return cached.value;
    }
    // Set inside the line callback, so declared without narrowing to null.
    let head = null as TranscriptHead | null;
    if (stats.isFile()) {
      let startedAt = NaN;
      try {
        await scanJsonlLines(
          filePath,
          (line) => {
            const entry = parseJsonLine(line) as { cwd?: unknown; timestamp?: unknown } | undefined;
            if (!entry || typeof entry !== 'object') {
              return false;
            }
            if (isNaN(startedAt) && typeof entry.timestamp === 'string') {
              startedAt = new Date(entry.timestamp).getTime();
            }
            if (typeof entry.cwd === 'string' && entry.cwd) {
              // A head without any timestamp dates the session by the file's creation.
              head = { cwd: entry.cwd, startedAt: isNaN(startedAt) ? stats.birthtimeMs || stats.mtimeMs : startedAt };
              return true;
            }
            return false;
          },
          { maxBytes: HEAD_MAX_BYTES }
        );
      } catch {
        head = null;
      }
    }
    this.heads.set(filePath, stats, head);
    return head;
  }
}
