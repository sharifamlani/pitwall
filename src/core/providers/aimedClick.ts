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
 * Only a mouse click is redirected. A click is a selection change followed at
 * once by the row's command; Enter (or any action) on a row already selected
 * runs the command with no selection change, and a reveal or a keyboard move
 * announces its selection first, so neither is ever redirected. Whenever the
 * on-screen order is not known for sure, the clicked row opens, as before.
 */

/** How long after moved rows reach the screen a click still counts as aimed at the old order. */
export const AIM_WINDOW_MS = 800;
/**
 * How long a selection waits for its row's command before it counts as a
 * plain selection (an arrow key). A click's selection and command arrive
 * back to back from one pointer event.
 */
export const CLICK_PAIR_MS = 250;
/** How long a selection Pitwall asked for (a reveal) is expected. */
export const EXPECTED_SELECTION_MS = 5_000;
/** How long a keyboard move's selection is expected. */
export const KEYBOARD_SELECTION_MS = 1_000;
/** A redraw whose rows the editor has not all asked for within this long is not trusted. */
export const REDRAW_SETTLE_MS = 1_500;

/**
 * The row the user aimed at: the one that sat in the clicked row's slot in
 * `before`. Undefined when the click needs no redirect (the clicked row was
 * already there) or when the slot is unsure: the clicked row is not shown,
 * the old slot held nothing, or the old row is no longer shown. Slots count
 * visible rows only, so a collapsed repo's sessions take none.
 */
export function aimedRowId(before: readonly string[], after: readonly string[], clicked: string): string | undefined {
  const slot = after.indexOf(clicked);
  if (slot < 0 || slot >= before.length) {
    return undefined;
  }
  const aimed = before[slot];
  return aimed !== clicked && after.includes(aimed) ? aimed : undefined;
}

/** A selection held back until its row's command shows whether it was a click. */
export interface HeldClick<T> {
  /** The row the click landed on. */
  clicked: string;
  /** The row that sat in that slot before the move. */
  aimed: string;
  selection: readonly T[];
  apply: (event: { selection: readonly T[] }) => void;
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

  constructor(private readonly clock: () => number = Date.now) {}

  dispose(): void {
    clearTimeout(this.held?.timer);
    this.held = undefined;
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
      return;
    }
    if (pending.before.length === after.length && pending.before.every((id, index) => id === after[index])) {
      // Nothing moved: an earlier move's order still describes the screen.
      return;
    }
    this.moved = { before: pending.before, shownAt: this.clock() };
  }

  /** The user changed what the list shows (a collapse), or a redraw was given up on: nothing is remembered. */
  forget(): void {
    this.pending = undefined;
    this.moved = undefined;
  }

  /** Pitwall is about to select this row itself (a reveal): its selection is never a click. */
  expectSelection(rowId: string): void {
    this.expected.set(rowId, this.clock() + EXPECTED_SELECTION_MS);
  }

  /** A keyboard move is about to select a row: its selection is never a click. */
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
    const aimed = this.aimFor(ids, previous, layout);
    if (aimed === undefined) {
      apply({ selection });
      return;
    }
    const timer = setTimeout(() => this.release(), CLICK_PAIR_MS);
    timer.unref?.();
    this.held = { clicked: ids[0], aimed, selection, apply, timer };
  }

  /**
   * A row's command ran. Returns the held click it completes, which the
   * caller redirects to `aimed`; undefined for a row whose selection was not
   * held (Enter or an action on a row already selected).
   */
  claim(rowId: string): HeldClick<T> | undefined {
    const held = this.held;
    if (!held || held.clicked !== rowId) {
      return undefined;
    }
    clearTimeout(held.timer);
    this.held = undefined;
    return held;
  }

  private release(): void {
    const held = this.held;
    if (!held) {
      return;
    }
    clearTimeout(held.timer);
    this.held = undefined;
    held.apply({ selection: held.selection });
  }

  private aimFor(ids: readonly string[], previous: readonly string[], layout: readonly string[] | undefined): string | undefined {
    if (ids.length !== 1) {
      return undefined;
    }
    const [id] = ids;
    const now = this.clock();
    const expectedUntil = this.expected.get(id);
    this.expected.delete(id);
    if ((expectedUntil !== undefined && now <= expectedUntil) || now <= this.keyboardUntil) {
      return undefined;
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
