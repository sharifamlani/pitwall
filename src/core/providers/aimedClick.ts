/**
 * "The aimed row wins" (D21: rows move, but never under the mouse). The list
 * re-sorts live when a chat changes status or a session appears, and the new
 * order reaches the screen about 0.3 s after the change. A click aimed at a
 * row can land on the row that has just slid into its place. The TreeView API
 * reports no pointer, hover or focus, so Pitwall remembers the on-screen order
 * from before each move instead: for `AIM_WINDOW_MS` after the moved rows
 * reach the screen, a click that newly selects a row that moved opens the row
 * that sat in that slot before the move, the one the user aimed at.
 *
 * Only a mouse click is redirected. A click is a selection change followed,
 * within `CLICK_PAIR_MS`, by the row's command: one pointer event sends both.
 * Enter (or any action) on a row already selected runs the command with no
 * selection change; a human's arrow key and Enter are further apart than
 * that; and a reveal or a keyboard move announces its selection first. None
 * of those is ever redirected. Whenever the on-screen order is not known for
 * sure, including after anything that may have scrolled the list (a Pitwall
 * reveal, a collapse, an expansion, a list that got shorter), the clicked row
 * opens, as before.
 *
 * A pair is trusted only when the extension host handled both messages
 * promptly. The gap is measured when the host handles each message, so a
 * host held busy (an import scan, a long redraw) can hand over an arrow key
 * and an Enter pressed 150 ms apart back to back. While a window is open, a
 * heartbeat timer ticks every `HEARTBEAT_MS`; a selection or command handled
 * when the last beat is older than `HEARTBEAT_STALE_MS` came out of a held
 * loop, and the clicked row opens. No timer runs while no window is open.
 */

/** How long after moved rows reach the screen a click still counts as aimed at the old order. */
export const AIM_WINDOW_MS = 800;
/**
 * The longest gap between a selection and its row's command that still
 * counts as one click. A click's selection and command come from one
 * pointer event, back to back; an arrow key then Enter is 100 ms or more.
 */
export const CLICK_PAIR_MS = 50;
/** How long a selection Pitwall asked for (a reveal) is expected. */
export const EXPECTED_SELECTION_MS = 5_000;
/** How long after a keyboard move no selection is taken for a click; at least `AIM_WINDOW_MS`. */
export const KEYBOARD_SELECTION_MS = 1_000;
/** A redraw whose rows the editor has not all asked for within this long is not trusted. */
export const REDRAW_SETTLE_MS = 2_500;
/** After a redirected click, a second click on the same row this soon (a double-click) goes to the same aimed row. */
export const DOUBLE_CLICK_MS = 500;
/** How often the heartbeat ticks while an aim or double-click window is open. */
export const HEARTBEAT_MS = 20;
/** A selection or command handled when the last beat is older than this came out of a held extension host: never redirected. */
export const HEARTBEAT_STALE_MS = 75;

/** Starts a timer that calls `beat` every `everyMs`; returns its stop. */
export type Heartbeat = (beat: () => void, everyMs: number) => () => void;

const intervalHeartbeat: Heartbeat = (beat, everyMs) => {
  const timer = setInterval(beat, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
};

/**
 * The row the user aimed at: the one that sat in the clicked row's slot in
 * `before`. Undefined when the click needs no redirect (the clicked row was
 * already there) or when the slot is unsure: the clicked row is not shown,
 * the old slot held nothing, the old row is no longer shown, or the list got
 * shorter (the editor then scrolls up when it was scrolled to the bottom, so
 * the pointer may still be on the row it aimed at). Slots count visible rows
 * only, so a collapsed repo's sessions take none.
 */
export function aimedRowId(before: readonly string[], after: readonly string[], clicked: string): string | undefined {
  if (after.length < before.length) {
    return undefined;
  }
  const slot = after.indexOf(clicked);
  if (slot < 0 || slot >= before.length) {
    return undefined;
  }
  const aimed = before[slot];
  return aimed !== clicked && after.includes(aimed) ? aimed : undefined;
}

/** A click the row command redirects to `aimed`. */
export interface AimedClick<T> {
  /** The row the click landed on. */
  clicked: string;
  /** The row that sat in that slot before the move. */
  aimed: string;
  /** Milliseconds between the selection and the row's command (0 for a double-click's second command). */
  gapMs: number;
  selection: readonly T[];
  apply: (event: { selection: readonly T[] }) => void;
}

/** A selection held back until its row's command shows whether it was a click. */
interface HeldClick<T> {
  clicked: string;
  aimed: string;
  selection: readonly T[];
  apply: (event: { selection: readonly T[] }) => void;
  selectedAt: number;
  timer: NodeJS.Timeout;
}

interface PendingRedraw {
  /** The rows the screen shows before the redraw, top to bottom; undefined when unsure. */
  before: string[] | undefined;
  /** Whether the editor has still to ask for the repo rows. */
  awaitRoots: boolean;
  /** Repo rows whose session rows the editor has still to ask for. */
  awaitChildren: Set<string>;
  startedAt: number;
}

/**
 * The state behind the rule: the on-screen order before the latest move, the
 * redraw on its way to the screen, the last selection and the selections
 * Pitwall itself asked for. Rows are named by their tree item ids.
 */
export class AimedClicks<T extends { id?: string }> {
  private pending: PendingRedraw | undefined;
  /** The order before the latest move, and when the moved rows reached the screen. */
  private moved: { before: string[]; shownAt: number } | undefined;
  private selected: readonly string[] = [];
  private readonly expected = new Map<string, number>();
  private keyboardUntil = 0;
  private held: HeldClick<T> | undefined;
  /**
   * The latest redirected click, for the second click of a double-click.
   * Spent by any selection applied as it is, other than Pitwall's own reveal
   * of the aimed row: the user has chosen a row since.
   */
  private lastRedirect: { clicked: string; aimed: string; at: number; apply: (event: { selection: readonly T[] }) => void } | undefined;
  /** Stops the heartbeat; set while it runs. */
  private stopBeat: (() => void) | undefined;
  /** When the heartbeat last ticked (or started). */
  private lastBeat = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly heartbeat: Heartbeat = intervalHeartbeat
  ) {}

  dispose(): void {
    clearTimeout(this.held?.timer);
    this.held = undefined;
    this.stopBeat?.();
    this.stopBeat = undefined;
  }

  /**
   * The editor is about to redraw rows. `layout` is what the screen shows
   * now (undefined when unsure); the redraw lands once the editor has asked
   * for the repo rows (`awaitRoots`) and the session rows of `awaitChildren`.
   * A redraw already on its way keeps the order from before it, which the
   * screen still shows.
   */
  willRedraw(layout: readonly string[] | undefined, awaitRoots: boolean, awaitChildren: Iterable<string>): void {
    const pending = this.pending;
    if (pending && this.clock() - pending.startedAt <= REDRAW_SETTLE_MS) {
      pending.awaitRoots ||= awaitRoots;
      for (const id of awaitChildren) {
        pending.awaitChildren.add(id);
      }
      return;
    }
    this.pending = {
      before: layout ? [...layout] : undefined,
      awaitRoots,
      awaitChildren: new Set(awaitChildren),
      startedAt: this.clock(),
    };
  }

  /**
   * The editor asked for rows: the repo rows (`rowId` undefined) or one repo
   * row's session rows. `redrawn` says the provider made it ask (a refreshed
   * repo row). Rows it asks for on its own mean the user expanded a row or
   * the list reappeared: the screen changed in a way no remembered order
   * describes, so it is forgotten. `layout` reads the rows the screen shows
   * once this answer lands.
   */
  fetched(rowId: string | undefined, redrawn: boolean, layout: () => readonly string[] | undefined): void {
    const pending = this.pending;
    if (!pending) {
      if (!redrawn) {
        this.moved = undefined;
        this.syncHeartbeat();
      }
      return;
    }
    if (rowId === undefined) {
      pending.awaitRoots = false;
    } else if (!pending.awaitChildren.delete(rowId) && !redrawn) {
      this.forget();
      return;
    }
    if (pending.awaitRoots || pending.awaitChildren.size > 0) {
      return;
    }
    this.pending = undefined;
    const after = layout();
    if (!pending.before || !after || this.clock() - pending.startedAt > REDRAW_SETTLE_MS) {
      this.moved = undefined;
      this.syncHeartbeat();
      return;
    }
    if (pending.before.length === after.length && pending.before.every((id, index) => id === after[index])) {
      // Nothing moved: an earlier move's order still describes the screen.
      return;
    }
    this.moved = { before: pending.before, shownAt: this.clock() };
    this.syncHeartbeat();
  }

  /**
   * Something changed what the list shows or where it is scrolled (a
   * collapse, a Pitwall reveal), or a redraw was given up on: nothing is
   * remembered.
   */
  forget(): void {
    this.pending = undefined;
    this.moved = undefined;
    this.syncHeartbeat();
  }

  /**
   * Pitwall is about to reveal and select this row itself: its selection is
   * never a click, and the reveal may scroll the list, so the order before
   * the last move is forgotten.
   */
  expectSelection(rowId: string): void {
    this.expected.set(rowId, this.clock() + EXPECTED_SELECTION_MS);
    this.forget();
  }

  /**
   * A keyboard move is about to select a row: no selection is taken for a
   * click for `KEYBOARD_SELECTION_MS`, which outlasts any aim window still
   * open, so a keyboard move needs no forgetting of its own.
   */
  expectKeyboardSelection(): void {
    this.keyboardUntil = this.clock() + KEYBOARD_SELECTION_MS;
  }

  /**
   * The selection changed. A selection that may be a click aimed at the old
   * order is held until its row's command claims it, or for
   * `CLICK_PAIR_MS`, after which it is applied as it is. Every other
   * selection is applied at once. `layout` is what the screen shows now,
   * undefined when unsure.
   */
  select(
    selection: readonly T[],
    layout: readonly string[] | undefined,
    apply: (event: { selection: readonly T[] }) => void
  ): void {
    // A newer selection means the held one was not a click.
    this.release();
    const ids = selection.map((row) => row.id ?? '');
    const previous = this.selected;
    this.selected = ids;
    // A selection Pitwall asked for (a reveal) is never a click.
    const own = ids.length === 1 && this.takeExpected(ids[0]);
    const aimed = own ? undefined : this.aimFor(ids, previous, layout);
    if (aimed === undefined) {
      if (!(own && ids[0] === this.lastRedirect?.aimed)) {
        // A row chosen since the redirect: no later command belongs to that double-click.
        this.spendRedirect();
      }
      apply({ selection });
      return;
    }
    const timer = setTimeout(() => this.release(), CLICK_PAIR_MS);
    timer.unref?.();
    this.held = { clicked: ids[0], aimed, selection, apply, selectedAt: this.clock(), timer };
  }

  /**
   * A row's command ran. Returns the click it completes, which the caller
   * redirects to `aimed`: a held selection of this row made at most
   * `CLICK_PAIR_MS` ago, or the second click of a double-click on a row
   * just redirected. Undefined otherwise (Enter or an action on a row already
   * selected, or a selection made too long before, like an arrow key).
   */
  claim(rowId: string): AimedClick<T> | undefined {
    if (this.stalled()) {
      // The host was held: this command and a selection before it may have waited together.
      this.release();
      return undefined;
    }
    const held = this.held;
    if (held && held.clicked === rowId) {
      const gapMs = this.clock() - held.selectedAt;
      if (gapMs > CLICK_PAIR_MS) {
        this.release();
        return undefined;
      }
      clearTimeout(held.timer);
      this.held = undefined;
      return { clicked: held.clicked, aimed: held.aimed, gapMs, selection: held.selection, apply: held.apply };
    }
    const last = this.lastRedirect;
    if (!held && last && last.clicked === rowId && this.clock() - last.at <= DOUBLE_CLICK_MS) {
      return { clicked: rowId, aimed: last.aimed, gapMs: 0, selection: [], apply: last.apply };
    }
    return undefined;
  }

  /** The caller redirected this click: a quick second click on the same row follows it (a double-click). */
  redirected(click: AimedClick<T>): void {
    this.lastRedirect = { clicked: click.clicked, aimed: click.aimed, at: this.clock(), apply: click.apply };
    this.syncHeartbeat();
  }

  /** A held selection turned out not to be a click: it is applied as it is, which spends the double-click. */
  private release(): void {
    const held = this.held;
    if (!held) {
      return;
    }
    clearTimeout(held.timer);
    this.held = undefined;
    this.spendRedirect();
    held.apply({ selection: held.selection });
  }

  private spendRedirect(): void {
    if (this.lastRedirect) {
      this.lastRedirect = undefined;
      this.syncHeartbeat();
    }
  }

  /** Whether Pitwall asked for this row's selection (a reveal) and it came in time; the expectation is used up. */
  private takeExpected(id: string): boolean {
    const expectedUntil = this.expected.get(id);
    this.expected.delete(id);
    return expectedUntil !== undefined && this.clock() <= expectedUntil;
  }

  /** Whether the extension host was held: the heartbeat has not ticked for `HEARTBEAT_STALE_MS`. */
  private stalled(): boolean {
    return this.clock() - this.lastBeat > HEARTBEAT_STALE_MS;
  }

  /** Runs the heartbeat exactly while an aim window or a double-click window is open. */
  private syncHeartbeat(): void {
    const now = this.clock();
    const open =
      (this.moved !== undefined && now - this.moved.shownAt <= AIM_WINDOW_MS) ||
      (this.lastRedirect !== undefined && now - this.lastRedirect.at <= DOUBLE_CLICK_MS);
    if (open && !this.stopBeat) {
      this.lastBeat = now;
      this.stopBeat = this.heartbeat(() => {
        this.lastBeat = this.clock();
        this.syncHeartbeat();
      }, HEARTBEAT_MS);
    } else if (!open && this.stopBeat) {
      this.stopBeat();
      this.stopBeat = undefined;
    }
  }

  private aimFor(ids: readonly string[], previous: readonly string[], layout: readonly string[] | undefined): string | undefined {
    if (ids.length !== 1) {
      return undefined;
    }
    const [id] = ids;
    const now = this.clock();
    if (now <= this.keyboardUntil || this.stalled()) {
      // A keyboard move, or a selection handled after the host was held.
      return undefined;
    }
    const last = this.lastRedirect;
    if (last && last.clicked === id && now - last.at <= DOUBLE_CLICK_MS) {
      // The second click of a double-click on the row just redirected.
      return last.aimed;
    }
    if (previous.length === 1 && previous[0] === id) {
      // Not newly selected.
      return undefined;
    }
    const moved = this.moved;
    // A redraw on its way means the screen is changing under the click.
    const redrawing = this.pending !== undefined && now - this.pending.startedAt <= REDRAW_SETTLE_MS;
    if (!moved || !layout || redrawing || now < moved.shownAt || now - moved.shownAt > AIM_WINDOW_MS) {
      return undefined;
    }
    return aimedRowId(moved.before, layout, id);
  }
}
