/**
 * Record-level guard against Cursor's stale storage echo (R33a, F3).
 *
 * Under load the editor can replace Pitwall's whole stored state with an older
 * copy: it echoes each storage change back to the extension host, and a stale
 * echo can land after a newer write. Every write saves the whole state, so the
 * next write of any key would persist the stale copy.
 *
 * A `RecordOverlay` remembers, in memory and for this window only, the records
 * this window wrote (`note(id, value)`) or removed (`note(id, null)`). Merged
 * into every read and every write of its collection, it keeps a stale copy from
 * dropping a record this window wrote or bringing back one it removed. Other
 * windows' records pass through as stored.
 *
 * `settle` lets go of entries the store has echoed back unchanged, so other
 * windows' later writes win. An entry is held for at least `holdMs` first: right
 * after a write the store shows it only because the write was local, and a
 * stale echo can still be on its way. Entries the store does not show are kept
 * and keep being merged in, so a write is never dropped unconfirmed.
 */

export interface RecordOverlayOptions {
  /**
   * How long an entry is kept before the store may confirm it. `Infinity`
   * keeps every entry for the window's lifetime (the terminal PID records).
   */
  holdMs?: number;
  /**
   * Merge object records field by field: an update guards only the fields it
   * changed, so two windows editing different fields of one record both keep
   * their edit. A record this window created is also brought back if a stale
   * copy dropped it; one it only edited is not, because another window may
   * have removed it.
   */
  fields?: boolean;
  /** Clock, for tests. */
  now?: () => number;
}

/** How long a write is held before the store may confirm it, by default. */
export const STALE_ECHO_HOLD_MS = 30_000;

interface Entry<T> {
  /** `null` = removed by this window. */
  value: T | null;
  at: number;
  /** Field mode: this window created the record. */
  created: boolean;
  /** Field mode: the fields this window changed. Unused for whole records. */
  changed: Set<string>;
}

export class RecordOverlay<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly holdMs: number;
  private readonly fields: boolean;
  private readonly now: () => number;

  constructor(options: RecordOverlayOptions = {}) {
    this.holdMs = options.holdMs ?? STALE_ECHO_HOLD_MS;
    this.fields = options.fields ?? false;
    this.now = options.now ?? Date.now;
  }

  /** Entries still held. */
  get size(): number {
    return this.entries.size;
  }

  /** Whether this window created or wrote `id` and still guards it. */
  wrote(id: string): boolean {
    const entry = this.entries.get(id);
    return entry !== undefined && entry.value !== null && entry.created;
  }

  /**
   * Record this window's write of `id`, or its removal (`null`). In field mode
   * pass the record as it was before an update as `previous`; without it the
   * write is a creation and guards the whole record.
   */
  note(id: string, noted: T | null, previous?: T): void {
    const at = this.now();
    const existing = this.entries.get(id);
    // A copy: callers may go on mutating the object they wrote.
    const value = clone(noted);
    if (value === null) {
      this.entries.set(id, { value: null, at, created: false, changed: new Set() });
      return;
    }
    if (!this.fields) {
      this.entries.set(id, { value, at, created: true, changed: new Set() });
      return;
    }
    if (previous === undefined) {
      const keep = existing && existing.value !== null && existing.created;
      this.entries.set(id, { value, at, created: true, changed: keep ? existing.changed : new Set() });
      return;
    }
    const changed = changedFields(previous, value);
    if (existing && existing.value !== null) {
      for (const field of changed) {
        existing.changed.add(field);
      }
      existing.value = value;
      existing.at = at;
      return;
    }
    if (changed.size > 0) {
      this.entries.set(id, { value, at, created: false, changed });
    }
  }

  /** `stored` with this window's writes and removals applied. */
  merge(stored: Record<string, T>): Record<string, T> {
    if (this.entries.size === 0) {
      return stored;
    }
    const merged: Record<string, T> = { ...stored };
    for (const [id, entry] of this.entries) {
      const has = Object.prototype.hasOwnProperty.call(stored, id);
      // Copies, so a caller mutating a read cannot change what is held.
      if (entry.value === null) {
        delete merged[id];
      } else if (!this.fields) {
        merged[id] = clone(entry.value);
      } else if (has) {
        merged[id] = withFields(stored[id], clone(entry.value), entry.changed);
      } else if (entry.created) {
        merged[id] = clone(entry.value);
      }
    }
    return merged;
  }

  /** Let go of held entries that `stored` already shows unchanged. */
  settle(stored: Record<string, T>): void {
    if (this.entries.size === 0 || !Number.isFinite(this.holdMs)) {
      return;
    }
    const cutoff = this.now() - this.holdMs;
    for (const [id, entry] of this.entries) {
      if (entry.at > cutoff) {
        continue;
      }
      const has = Object.prototype.hasOwnProperty.call(stored, id);
      let shown: boolean;
      if (entry.value === null) {
        shown = !has;
      } else if (!this.fields) {
        shown = has && sameValue(stored[id], entry.value);
      } else if (!has) {
        // An edit of a record that is gone: another window removed it.
        shown = !entry.created;
      } else {
        shown = [...entry.changed].every((field) => sameValue(fieldOf(stored[id], field), fieldOf(entry.value, field)));
      }
      if (shown) {
        this.entries.delete(id);
      }
    }
  }
}

/**
 * A stored list with `overlay` applied, records keyed by `idOf`. Stored order
 * is kept; records this window added and the store lacks go after the stored
 * ones, or before them (newest first) with `newFirst`. A record without an id
 * passes through unguarded.
 */
export function mergeList<T>(
  stored: readonly T[],
  overlay: RecordOverlay<T>,
  idOf: (record: T) => unknown,
  newFirst = false
): T[] {
  if (overlay.size === 0) {
    return [...stored];
  }
  const byId: Record<string, T> = {};
  for (const record of stored) {
    const id = idOf(record);
    if (typeof id === 'string' && !Object.prototype.hasOwnProperty.call(byId, id)) {
      byId[id] = record;
    }
  }
  overlay.settle(byId);
  const merged = overlay.merge(byId);
  const result: T[] = [];
  const placed = new Set<string>();
  for (const record of stored) {
    const id = idOf(record);
    if (typeof id !== 'string') {
      result.push(record);
    } else if (!placed.has(id)) {
      placed.add(id);
      if (Object.prototype.hasOwnProperty.call(merged, id)) {
        result.push(merged[id]);
      }
    }
  }
  const added = Object.keys(merged)
    .filter((id) => !placed.has(id))
    .map((id) => merged[id]);
  return newFirst ? [...added.reverse(), ...result] : [...result, ...added];
}

function clone<V>(value: V): V {
  return value === null || typeof value !== 'object' ? value : (JSON.parse(JSON.stringify(value)) as V);
}

function fieldOf(record: unknown, field: string): unknown {
  return record !== null && typeof record === 'object' ? (record as Record<string, unknown>)[field] : undefined;
}

function changedFields(previous: unknown, next: unknown): Set<string> {
  const before = (previous ?? {}) as Record<string, unknown>;
  const after = (next ?? {}) as Record<string, unknown>;
  const changed = new Set<string>();
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!sameValue(before[field], after[field])) {
      changed.add(field);
    }
  }
  return changed;
}

/** `stored` with `fields` taken from `own`; a field `own` lacks is deleted. */
function withFields<T>(stored: T, own: T, fields: Set<string>): T {
  if (fields.size === 0) {
    return stored;
  }
  const result = { ...(stored as Record<string, unknown>) };
  const source = own as Record<string, unknown>;
  for (const field of fields) {
    if (source[field] === undefined) {
      delete result[field];
    } else {
      result[field] = source[field];
    }
  }
  return result as T;
}

/** Equal as stored: JSON-equal, ignoring key order and `undefined` fields. */
export function sameValue(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return item;
    }
    const record = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  }) ?? 'undefined';
}
