/**
 * How late the extension host is when it handles a message (a row's
 * command): the `lag=<ms>ms` word on a row command's route and open lines.
 *
 * A clock ticks every `HOST_TICK_MS`. A message handled when the last tick is
 * older than that waited behind a held host by about the overdue part: a
 * click delivered after a 26 s stall logs `lag=` near 26000 ms, a prompt one
 * `lag=0ms`. A probe started when the message arrives (a `setImmediate`)
 * cannot see a stall that came before it: the queued selection and command
 * are then handled in one turn, before any probe runs. The tick can.
 *
 * Each tick also records how late it itself fired. A stall inside a timer
 * callback leaves the interval overdue, and libuv runs the overdue timer
 * before the queued input: the tick then reads 0 ms old when the command is
 * handled, but its own lateness still shows the stall.
 *
 * One unref'd timer, four times a second: no work beyond storing two numbers.
 */

/** How often the host clock ticks. */
export const HOST_TICK_MS = 250;

/** Starts a repeating beat every `everyMs`; returns what stops it. */
export type StartBeat = (beat: () => void, everyMs: number) => () => void;

/** A real, unref'd interval timer. */
const intervalBeat: StartBeat = (beat, everyMs) => {
  const timer = setInterval(beat, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
};

export class HostLag {
  private lastTick: number;
  /** How far past `HOST_TICK_MS` the latest tick itself fired. */
  private lastLate = 0;
  private readonly stop: () => void;

  constructor(
    private readonly clock: () => number = Date.now,
    start: StartBeat = intervalBeat
  ) {
    this.lastTick = clock();
    this.stop = start(() => this.tick(), HOST_TICK_MS);
  }

  /**
   * How late the host is now: how far past `HOST_TICK_MS` the next tick is
   * overdue, or how late the latest tick fired, whichever is more. 0 for a
   * prompt host.
   */
  lateMs(): number {
    return Math.max(0, this.clock() - this.lastTick - HOST_TICK_MS, this.lastLate);
  }

  dispose(): void {
    this.stop();
  }

  private tick(): void {
    const now = this.clock();
    this.lastLate = Math.max(0, now - this.lastTick - HOST_TICK_MS);
    this.lastTick = now;
  }
}
