import { DiscoveredFolder, DiscoveryCounts } from '../../core/harness/types';

/** Folders Claude Code sessions ran in, from the transcripts' heads (ADR 0019). */
export class ClaudeRepoDiscovery {
  constructor(private readonly projectsDir: string) {}

  async discoverRecentFolders(_sinceMs: number, _counts?: DiscoveryCounts): Promise<DiscoveredFolder[]> {
    throw new Error(`not implemented: ${this.projectsDir}`);
  }
}
