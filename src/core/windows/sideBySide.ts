/**
 * "Show its open chats side by side" (Q14, Q15): the one move Pitwall makes to
 * a tab, and only because the user asked. It puts a repo's open Claude tabs in
 * a group each, using the editor's own move commands, up to 4 panes; further
 * tabs stay as tabs in the last pane. It never closes a tab.
 */

/** The most panes one split makes (Q15). */
export const SIDE_BY_SIDE_MAX = 4;

/** How long side by side waits for one move to land before it goes on (a move that changes nothing never does). */
export const SIDE_BY_SIDE_MOVE_WAIT_MS = 1_000;

const MOVE_TO_LAST_GROUP = 'workbench.action.moveEditorToLastGroup';
const MOVE_TO_RIGHT_GROUP = 'workbench.action.moveEditorToRightGroup';
const EVEN_WIDTHS = 'workbench.action.evenEditorWidths';

export interface SideBySideDeps {
  /** Bring this session's tab to the front of its group (it becomes the active editor). */
  reveal: (sessionId: string) => Promise<unknown>;
  /** Run an editor command on the active editor. */
  exec: (command: string) => Promise<unknown>;
  /**
   * Called just before each move; resolves when that move has landed (its
   * tab event) or a short wait ran out. The tab tracker's `whenTabMoved`.
   */
  whenMoved?: () => Promise<unknown>;
}

/**
 * The first tab stays where it is. Each of the next three is brought to the
 * front, moved to the last group, then right of it, which makes a new group
 * (a group with one tab already there is never joined). Any tab after the
 * fourth joins the last pane. Fewer than two sessions moves nothing.
 *
 * One move at a time: each waits for the last to land, since moves fired
 * back to back left Cursor drawing the webviews one pane off, over the
 * sidebar (live F2). Even pane widths at the end force a relayout and are
 * the look a side by side wants.
 */
export async function splitSideBySide(sessionIds: string[], deps: SideBySideDeps): Promise<{ panes: number; stacked: number }> {
  if (sessionIds.length < 2) {
    return { panes: 0, stacked: 0 };
  }
  const move = async (command: string) => {
    const landed = deps.whenMoved?.();
    await deps.exec(command);
    await landed;
  };
  for (const [index, sessionId] of sessionIds.entries()) {
    await deps.reveal(sessionId);
    if (index === 0) {
      continue;
    }
    await move(MOVE_TO_LAST_GROUP);
    if (index < SIDE_BY_SIDE_MAX) {
      await move(MOVE_TO_RIGHT_GROUP);
    }
  }
  await deps.exec(EVEN_WIDTHS);
  return { panes: Math.min(sessionIds.length, SIDE_BY_SIDE_MAX), stacked: Math.max(0, sessionIds.length - SIDE_BY_SIDE_MAX) };
}
