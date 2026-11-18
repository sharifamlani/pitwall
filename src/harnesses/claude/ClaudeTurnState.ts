import { TurnState } from '../../core/harness/types';
import { JsonlTailScan, readJsonlTail } from '../../core/utils/jsonlTail';

/** The last conversational entry in a transcript. */
export interface ClaudeConversationEntry {
  type: string;
  stopReason: string | null;
  timestamp: number | null;
  /** A user entry that is Claude's own interrupt marker: the turn ended there. */
  interrupted?: boolean;
}

/** The two transcript facts that decide whether a Claude turn is over. */
export interface ClaudeTurnSignals {
  lastConversation: ClaudeConversationEntry | null;
  /** `turn_duration.pendingBackgroundAgentCount`; null when absent. */
  pendingBackgroundAgents: number | null;
}

export interface ClaudeTurnReading {
  turnState: TurnState;
  turnEndedAt: number | null;
}

interface ClaudeTranscriptEntry {
  type?: unknown;
  subtype?: unknown;
  isSidechain?: unknown;
  timestamp?: unknown;
  pendingBackgroundAgentCount?: unknown;
  message?: { stop_reason?: unknown; content?: unknown };
}

/**
 * The text Claude writes as a user entry when the user stops a turn: Esc
 * while it streams, or a rejected tool call ("... for tool use"). Claude
 * writes no assistant entry or `turn_duration` after it, and the process goes
 * idle, so the turn ended at this entry (Q24).
 */
const INTERRUPT_MARKERS: ReadonlySet<string> = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]);

/** Whether a user entry's content is only Claude's interrupt marker. */
function isInterruptMarker(content: unknown): boolean {
  if (typeof content === 'string') {
    return INTERRUPT_MARKERS.has(content.trim());
  }
  if (!Array.isArray(content) || content.length !== 1) {
    return false;
  }
  const [block] = content as { type?: unknown; text?: unknown }[];
  return block?.type === 'text' && typeof block.text === 'string' && INTERRUPT_MARKERS.has(block.text.trim());
}

/**
 * Fold one decoded transcript entry into the turn signals. The tail reader and
 * the full parser share this so both read `stop_reason`, sidechains, and
 * `turn_duration` the same way.
 */
export function observeClaudeTurnEntry(
  entry: unknown,
  signals: ClaudeTurnSignals
): void {
  if (!entry || typeof entry !== 'object') {
    return;
  }
  const record = entry as ClaudeTranscriptEntry;

  // Claude writes this at every turn end and omits the count when nothing is
  // pending, so a missing field means zero.
  if (record.type === 'system' && record.subtype === 'turn_duration') {
    signals.pendingBackgroundAgents =
      typeof record.pendingBackgroundAgentCount === 'number'
        ? record.pendingBackgroundAgentCount
        : 0;
  }

  if (
    (record.type === 'user' || record.type === 'assistant') &&
    !record.isSidechain
  ) {
    const stopReason = record.message?.stop_reason;
    const timestamp = record.timestamp
      ? new Date(record.timestamp as string | number).getTime()
      : NaN;
    signals.lastConversation = {
      type: record.type,
      stopReason: typeof stopReason === 'string' ? stopReason : null,
      timestamp: Number.isNaN(timestamp) ? null : timestamp,
      ...(record.type === 'user' && isInterruptMarker(record.message?.content) ? { interrupted: true } : {}),
    };
  }
}

/** Whether the last conversation entry closes a turn: a final assistant reply or an interrupt. */
function endsTurn(last: ClaudeConversationEntry | null): boolean {
  if (!last) {
    return false;
  }
  if (last.interrupted) {
    return true;
  }
  return last.type === 'assistant' && Boolean(last.stopReason) && last.stopReason !== 'tool_use';
}

/**
 * Turn state from the transcript's deciding entries. A user entry (including
 * a tool result) or a still-streaming/tool-using assistant entry means the
 * turn is open. A terminal assistant entry, or Claude's interrupt marker,
 * means done unless a background agent is still pending.
 */
export function deriveClaudeTurnState(
  signals: ClaudeTurnSignals
): ClaudeTurnReading {
  const pending = signals.pendingBackgroundAgents ?? 0;
  const last = signals.lastConversation;
  if (pending <= 0 && last && endsTurn(last)) {
    return { turnState: 'done', turnEndedAt: last.timestamp };
  }
  return { turnState: 'working', turnEndedAt: null };
}

function scanEntries(entries: unknown[]): JsonlTailScan<ClaudeTurnReading> {
  const signals: ClaudeTurnSignals = {
    lastConversation: null,
    pendingBackgroundAgents: null,
  };

  for (const entry of entries) {
    observeClaudeTurnEntry(entry, signals);
  }

  const lastConversation = signals.lastConversation;

  return {
    value: deriveClaudeTurnState(signals),
    decided:
      lastConversation !== null &&
      (!endsTurn(lastConversation) || signals.pendingBackgroundAgents !== null),
  };
}

/**
 * Read only the tail of a transcript, growing the window until the latest
 * conversation entry is complete and, for a finished assistant turn, a
 * `turn_duration` is visible. If the deciding entries are not found, the same
 * reader expands to the start of the file rather than falling back to a full
 * parse.
 *
 * Returns null when the file cannot be read; an empty or not-yet-conversational
 * transcript is `working`, matching the full parser's default.
 */
export async function readTurnStateTail(
  filePath: string
): Promise<ClaudeTurnReading | null> {
  return readJsonlTail(filePath, scanEntries);
}
