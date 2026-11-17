import * as vscode from 'vscode';
import { HarnessAdapter } from '../harness/types';
import { GitService } from './GitService';
import { StorageService } from './StorageService';

export interface RepoDiscoveryOptions {
  enabled?: () => boolean;
  retentionDays?: () => number;
  intervalMs?: number;
  now?: () => number;
  onAdded?: (roots: string[]) => void;
}

export interface RepoDiscoveryResult {
  added: string[];
  skipped: number;
}

/** Adds the repos the agents' sessions ran in (ADR 0019). */
export class RepoDiscoveryService implements vscode.Disposable {
  constructor(
    private readonly storageService: StorageService,
    private readonly gitService: GitService,
    private readonly adapters: () => HarnessAdapter[],
    private readonly options: RepoDiscoveryOptions = {}
  ) {}

  start(_firstRender: PromiseLike<unknown>): void {
    throw new Error('not implemented');
  }

  wake(): void {
    throw new Error('not implemented');
  }

  scan(): Promise<RepoDiscoveryResult> {
    throw new Error('not implemented');
  }

  dispose(): void {
    void this.storageService;
    void this.gitService;
    void this.adapters;
    void this.options;
  }
}
