/**
 * Who owns a live process for a chat that is not open here or in another
 * Pitwall window (Q28, QA #52 C1). A terminal the user started is an outsider.
 * A harness panel whose process is a child of this extension host is this
 * window's own (`here`): its tab is open in this window even when Pitwall
 * never bound it (a title that names no chat, or one two chats share), so the
 * router brings that tab forward and never starts a second process (v0.6.0).
 * Any other panel runs in another window: the router hands it to the Pitwall
 * window on its folder (`cwd`, D35) when that is another window, and warns
 * otherwise (no window there, or a second window on this window's folder,
 * where a local open would fork the session).
 */
export interface LiveProcess {
  pid: number;
  /** Started from the harness's own editor panel, not a terminal. */
  panel: boolean;
  /** The process's folder, from the harness's record, when it has one. */
  cwd?: string;
  /** A panel process that is a child of this extension host: its tab is in this window. */
  here?: boolean;
}

export interface OutsideProcessDeps {
  /** This extension host's pid: the parent of this window's panel processes. */
  hostPid: number;
  /** The parent of a pid; undefined when the lookup fails or times out. */
  parentPidOf: (pid: number) => Promise<number | undefined>;
}

/**
 * The live process, marked `here` when it is this window's own panel, or
 * undefined only when there is none. A failed parent lookup leaves a panel
 * unmarked: a live process of an unknown window is never opened a second time.
 */
export async function classifyLiveProcess(
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
  return { pid: live.pid, panel: true, ...cwd, ...(parent === deps.hostPid ? { here: true } : {}) };
}
