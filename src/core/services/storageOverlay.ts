import { randomInt } from 'crypto';

/**
 * Record-level guard against Cursor's stale storage echo (R33a, F3), by write
 * stamps.
 *
 * Under load the editor can replace Pitwall's whole stored state with an older
 * copy: it echoes each storage change back to the extension host, and a stale
 * echo can land after a newer write. Every write saves the whole state, so the
 * next write of any key would persist the stale copy.
 *
 * Every guarded write carries a stamp: when it was written, plus the writing
 * window's tag (see `StampClock`). Object records (repositories, chats) carry
 * one stamp per field, so two windows editing different fields of one record
 * both keep their edit; other records carry one stamp each. A removal is a
 * tombstone with its stamp. The newest stamp wins, field by field: a stale
 * echo carries older stamps and loses, and another window's newer write wins
 * at once. Stamps live in the store, beside the records, so every window
 * judges by the same times. Records written before stamps count as stamp 0.
 *
 * A `RecordOverlay` holds, in memory and for this window only, the writes and
 * removals this window made, with their stamps, until the store shows a
 * strictly newer stamp for them (another write superseded them). The same
 * stamp proves nothing: an echo of this window's own earlier copy carries it,
 * and an older echo can still land after that. Holding is safe because the
 * merge re-applies a held write only where the store's stamp is older, and a
 * write that changes no stamp writes nothing extra. Memory is bounded by the
 * records and fields this window wrote.
 */

/** A write time: epoch ms × 1000 + the writing window's tag (0–999). */
export type Stamp = number;

/** A record's stamp: one stamp, or one per field (field records). */
export type RecordStamp = number | Record<string, number>;

/** In a field record's stamps, when the record itself was created. */
export const CREATED_FIELD = '#';

/**
 * How long a tombstone is kept. It only has to outlive any stale copy that
 * could still carry the removed record; stale echoes arrive within seconds,
 * so 14 days is far past that while keeping the stamp map bounded.
 */
export const TOMBSTONE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Records with their stamps and tombstones, as one collection stores them. */
export interface Stamped<T> {
  records: Record<string, T>;
  stamps: Record<string, RecordStamp>;
  /** Tombstones: id → the removal's stamp. */
  removed: Record<string, Stamp>;
}

/**
 * Issues this window's stamps. Every window of one editor runs on one machine,
 * so they share one clock and stamps compare without skew. Two windows writing
 * in the same millisecond are ordered by their tags, the same way everywhere.
 * A stamp is always newer than this window's last one and than the stamp it
 * replaces, so a write made after seeing another window's write wins over it.
 */
export class StampClock {
  readonly tag: number;
  private last = 0;

  constructor(
    private readonly now: () => number = Date.now,
    tag?: number
  ) {
    this.tag = tag ?? randomInt(1000);
  }

  next(after = 0): Stamp {
    const floor = Math.max(this.last, after);
    let stamp = this.now() * 1000 + this.tag;
    if (stamp <= floor) {
      stamp = (Math.floor(floor / 1000) + 1) * 1000 + this.tag;
    }
    this.last = stamp;
    return stamp;
  }
}

/** The epoch ms a stamp was written at. */
export function stampTime(stamp: Stamp): number {
  return Math.floor(stamp / 1000);
}

/** When a record was created (field records) or last written (others); 0 if unstamped. */
export function createdStamp(stamp: RecordStamp | undefined): number {
  if (typeof stamp === 'number') {
    return stamp;
  }
  return stamp?.[CREATED_FIELD] ?? 0;
}

function latestStamp(stamp: RecordStamp | undefined): number {
  if (typeof stamp === 'number') {
    return stamp;
  }
  return stamp ? Math.max(0, ...Object.values(stamp)) : 0;
}

function fieldStamps(stamp: RecordStamp | undefined): Record<string, number> {
  return stamp !== undefined && typeof stamp === 'object' ? stamp : {};
}

const hasOwn = (record: object, id: string) => Object.prototype.hasOwnProperty.call(record, id);

/** Stored records with stored tombstones applied: a tombstone newer than a record's creation hides it. */
export function resolveStored<T>(stored: Stamped<T>): Stamped<T> {
  let records = stored.records;
  for (const [id, removedAt] of Object.entries(stored.removed)) {
    if (hasOwn(records, id) && createdStamp(stored.stamps[id]) < removedAt) {
      if (records === stored.records) {
        records = { ...records };
      }
      delete records[id];
    }
  }
  return records === stored.records ? stored : { ...stored, records };
}

export interface RecordOverlayOptions {
  /**
   * Stamp object records field by field: an update stamps only the fields it
   * changed. A record this window created comes back if a stale copy dropped
   * it; one it only edited does not, and an edit never outlives a newer
   * removal.
   */
  fields?: boolean;
  /** The window's clock; one per window, shared by its collections. */
  clock?: StampClock;
}

interface Entry<T> {
  /** `null` = removed by this window. */
  value: T | null;
  /** The removal's stamp, when `value` is null. */
  removedAt: Stamp;
  /** Creation (field records) or write (others) stamp, until the store shows it. */
  created?: Stamp;
  /** Field records: each field this window wrote → its stamp, until the store shows it. */
  fields: Map<string, Stamp>;
}

export class RecordOverlay<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly fields: boolean;
  private readonly clock: StampClock;
  /** The last stored copy merged, for the stamps a new write must beat. */
  private lastStored: Stamped<T> | undefined;

  constructor(options: RecordOverlayOptions = {}) {
    this.fields = options.fields ?? false;
    this.clock = options.clock ?? new StampClock();
  }

  /** Entries still held. */
  get size(): number {
    return this.entries.size;
  }

  /** Ids with a held entry. */
  ids(): string[] {
    return [...this.entries.keys()];
  }

  /** Whether this window wrote `id` (created it, for field records) and still holds the write. */
  wrote(id: string): boolean {
    const entry = this.entries.get(id);
    return entry !== undefined && entry.value !== null && entry.created !== undefined;
  }

  /**
   * Record this window's write of `id`, or its removal (`null`), stamped now.
   * For field records pass the record as it was before an update as
   * `previous`; without it the write is a creation.
   */
  note(id: string, noted: T | null, previous?: T): void {
    const stamp = this.clock.next(this.storedStamp(id));
    // A copy: callers may go on mutating the object they wrote.
    const value = clone(noted);
    if (value === null) {
      this.entries.set(id, { value: null, removedAt: stamp, fields: new Map() });
      return;
    }
    if (!this.fields) {
      this.entries.set(id, { value, removedAt: 0, created: stamp, fields: new Map() });
      return;
    }
    if (previous === undefined) {
      const fields = new Map(Object.keys(value as object).map((field) => [field, stamp] as const));
      this.entries.set(id, { value, removedAt: 0, created: stamp, fields });
      return;
    }
    const changed = changedFields(previous, value);
    if (changed.length === 0) {
      return;
    }
    const existing = this.entries.get(id);
    const entry = existing && existing.value !== null ? existing : { value, removedAt: 0, fields: new Map<string, Stamp>() };
    entry.value = value;
    for (const field of changed) {
      entry.fields.set(field, stamp);
    }
    this.entries.set(id, entry);
  }

  /** `stored` (resolved) with this window's writes applied wherever their stamp is newer. */
  merge(stored: Stamped<T>): Stamped<T> {
    this.lastStored = stored;
    if (this.entries.size === 0) {
      return stored;
    }
    const records: Record<string, T> = { ...stored.records };
    const stamps: Record<string, RecordStamp> = { ...stored.stamps };
    const removed: Record<string, Stamp> = { ...stored.removed };
    for (const [id, entry] of this.entries) {
      const has = hasOwn(records, id);
      if (entry.value === null) {
        if (!has || createdStamp(stamps[id]) < entry.removedAt) {
          delete records[id];
          delete stamps[id];
          removed[id] = Math.max(removed[id] ?? 0, entry.removedAt);
        }
      } else if (!this.fields) {
        const latest = Math.max(has ? createdStamp(stamps[id]) : 0, removed[id] ?? 0);
        if (entry.created !== undefined && entry.created > latest) {
          records[id] = clone(entry.value);
          stamps[id] = entry.created;
          delete removed[id];
        }
      } else if (!has) {
        if (entry.created !== undefined && entry.created > (removed[id] ?? 0)) {
          records[id] = clone(entry.value);
          stamps[id] = { ...Object.fromEntries(entry.fields), [CREATED_FIELD]: entry.created };
          delete removed[id];
        }
      } else {
        const storedStamps = fieldStamps(stamps[id]);
        const own = entry.value as Record<string, unknown>;
        let record: Record<string, unknown> | undefined;
        let nextStamps: Record<string, number> | undefined;
        for (const [field, stamp] of entry.fields) {
          if (stamp > (storedStamps[field] ?? 0)) {
            record ??= { ...(records[id] as Record<string, unknown>) };
            nextStamps ??= { ...storedStamps };
            if (own[field] === undefined) {
              delete record[field];
            } else {
              record[field] = clone(own[field]);
            }
            nextStamps[field] = stamp;
          }
        }
        if (entry.created !== undefined && entry.created > (storedStamps[CREATED_FIELD] ?? 0)) {
          nextStamps ??= { ...storedStamps };
          nextStamps[CREATED_FIELD] = entry.created;
        }
        if (record) {
          records[id] = record as T;
        }
        if (nextStamps) {
          stamps[id] = nextStamps;
        }
      }
    }
    return { records, stamps, removed };
  }

  /**
   * Let go of writes the store has superseded with a strictly newer stamp.
   * An equal stamp never releases: an echo of this window's own earlier copy
   * carries it, and an older echo can still land after that one.
   */
  settle(stored: Stamped<T>): void {
    const shown = (own: number, store: number) => store > own;
    for (const [id, entry] of this.entries) {
      const has = hasOwn(stored.records, id);
      const tombstone = stored.removed[id];
      if (entry.value === null) {
        if ((tombstone !== undefined && shown(entry.removedAt, tombstone)) || (has && createdStamp(stored.stamps[id]) > entry.removedAt)) {
          this.entries.delete(id);
        }
        continue;
      }
      if (!this.fields) {
        if (has || tombstone !== undefined) {
          const latest = Math.max(has ? createdStamp(stored.stamps[id]) : 0, tombstone ?? 0);
          if (shown(entry.created ?? 0, latest)) {
            this.entries.delete(id);
          }
        }
        continue;
      }
      if (!has) {
        // A newer removal wins over everything this window wrote to it.
        const newest = Math.max(entry.created ?? 0, ...entry.fields.values());
        if (tombstone !== undefined && shown(newest, tombstone)) {
          this.entries.delete(id);
        }
        continue;
      }
      const storedStamps = fieldStamps(stored.stamps[id]);
      for (const [field, stamp] of entry.fields) {
        if (shown(stamp, storedStamps[field] ?? 0)) {
          entry.fields.delete(field);
        }
      }
      if (entry.created !== undefined && shown(entry.created, storedStamps[CREATED_FIELD] ?? 0)) {
        entry.created = undefined;
      }
      if (entry.fields.size === 0 && entry.created === undefined) {
        this.entries.delete(id);
      }
    }
  }

  /** The newest stamp the last stored copy has for `id`. */
  private storedStamp(id: string): number {
    const stored = this.lastStored;
    if (!stored) {
      return 0;
    }
    return Math.max(latestStamp(stored.stamps[id]), stored.removed[id] ?? 0);
  }
}

function clone<V>(value: V): V {
  return value === null || typeof value !== 'object' ? value : (JSON.parse(JSON.stringify(value)) as V);
}

function changedFields(previous: unknown, next: unknown): string[] {
  const before = (previous ?? {}) as Record<string, unknown>;
  const after = (next ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (field) => !sameValue(before[field], after[field])
  );
}

/** Equal as stored: JSON-equal, ignoring key order and `undefined` fields. */
export function sameValue(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        return item;
      }
      const record = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
    }) ?? 'undefined'
  );
}
