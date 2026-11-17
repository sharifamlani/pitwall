// Skeleton for the red step; implementation follows.
export type ClaudeLiveStatus = 'busy' | 'waiting' | 'idle';
export interface ClaudeSessionFileState {
  status: ClaudeLiveStatus;
  waitingFor?: string;
  statusUpdatedAt: number;
  pid: number;
  cwd: string;
}
export interface ClaudeSessionsSnapshot {
  available: boolean;
  observedAt: number;
  states: Map<string, ClaudeSessionFileState>;
  unknownStatus: Set<string>;
  partial: boolean;
}
export interface ClaudeSessionsFileOptions {
  dir?: () => string;
  isAlive?: (pid: number) => boolean;
  pidDomain?: () => Promise<string | undefined>;
}
export async function localPidDomain(): Promise<string> {
  return '';
}
export class ClaudeSessionsFile {
  constructor(_options: ClaudeSessionsFileOptions = {}) {}
  async snapshot(): Promise<ClaudeSessionsSnapshot> {
    return { available: false, observedAt: Date.now(), states: new Map(), unknownStatus: new Set(), partial: false };
  }
}
