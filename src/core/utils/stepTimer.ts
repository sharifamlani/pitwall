/**
 * Per-step timing for the jobs the Operations log times (a status poll, an
 * import scan, a discovery pass), so a slow one names the step that took the
 * time, and how much of it this process spent on the CPU (#79 gate: polls of
 * 0.75–2.6 s and scans of 15–27 s that a whole-job time could not explain).
 */
export class StepTimer {
  private readonly started = Date.now();
  private last = this.started;
  private readonly cpu = process.cpuUsage();
  private readonly steps: Array<[string, number]> = [];

  /** End the step that ran since the previous one (or the start). */
  step(name: string): void {
    const now = Date.now();
    this.steps.push([name, now - this.last]);
    this.last = now;
  }

  /** Wall time since the start, in ms. */
  elapsed(): number {
    return Date.now() - this.started;
  }

  /**
   * CPU this process used since the start, in ms: the whole extension host,
   * every extension in it. Far less than the wall time means the job waited
   * (on files, a child process, or a busy machine), not that it computed.
   */
  cpuMs(): number {
    const used = process.cpuUsage(this.cpu);
    return Math.round((used.user + used.system) / 1000);
  }

  /** "name 12 ms, other 3 ms". */
  describe(): string {
    return this.steps.map(([name, ms]) => `${name} ${ms} ms`).join(', ');
  }
}

/**
 * Cumulative counters as one adapter reports them (`readCounters`), shown as
 * what changed between two readings: `…Bytes` keys in MB, `…Ms` keys in ms.
 * Keys that did not change are left out.
 */
export function describeCounters(before: Readonly<Record<string, number>>, after: Readonly<Record<string, number>>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(after)) {
    const delta = value - (before[key] ?? 0);
    if (delta === 0) {
      continue;
    }
    if (key.endsWith('Bytes')) {
      parts.push(`${key.slice(0, -'Bytes'.length)} ${(delta / 1048576).toFixed(1)} MB`);
    } else if (key.endsWith('Ms')) {
      parts.push(`${key.slice(0, -'Ms'.length)} ${Math.round(delta)} ms`);
    } else {
      parts.push(`${key} ${delta}`);
    }
  }
  return parts.join(', ');
}
