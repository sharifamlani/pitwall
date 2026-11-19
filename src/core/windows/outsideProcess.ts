/**
 * Who owns a live process for a chat that is not open here or in another
 * Pitwall window (Q28, QA #52 C1). A terminal the user started is an outsider.
 * A harness panel whose process is a child of this extension host is this
 * window's own (Pitwall never bound its tab): it is not an outsider, so the
 * chat opens here. Any other panel runs in another window: the router hands
 * it to the Pitwall window on its folder (`cwd`, D35) when that is another
 * window, and warns otherwise (no window there, or a second window on this
 * window's folder, where a local open would fork the session).
 */
export interface LiveProcess {
  pid: number;
  /** Started from the harness's own editor panel, not a terminal. */
  panel: boolean;
  /** The process's folder, from the harness's record, when it has one. */
  cwd?: string;
}

export interface OutsideProcessDeps {
  /** This extension host's pid: the parent of this window's panel processes. */
  hostPid: number;
  /** The parent of a pid; undefined when the lookup fails or times out. */
  parentPidOf: (pid: number) => Promise<number | undefined>;
}

/** The outsider to warn about, or undefined to open the chat here. A failed lookup opens here rather than block. */
export async function outsideProcessOf(
  live: LiveProcess | undefined,
  deps: OutsideProcessDeps
): Promise<LiveProcess | undefined> {
  if (!live) {
    return undefined;
  }
  const cwd = live.cwd ? { cwd: live.cwd } : {};
  if (!live.panel) {
    return { pid: live.pid, panel: false, ...cwd };
  }
  const parent = await deps.parentPidOf(live.pid);
  return parent === undefined || parent === deps.hostPid ? undefined : { pid: live.pid, panel: true, ...cwd };
}
