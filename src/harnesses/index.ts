import { HarnessModule } from '../core/harness/module';
import { HarnessId } from '../core/types';
import { claudeModule } from './claude';
import { opencodeModule } from './opencode';
import { codexModule } from './codex';
import { piModule } from './pi';
import enabled from './enabled.json';

/** Every harness that exists in this repo, enabled or not. Adding one is a folder plus one line here. */
export const ALL_HARNESSES: Record<string, HarnessModule> = {
  claude: claudeModule,
  opencode: opencodeModule,
  codex: codexModule,
  pi: piModule,
};

/** Every harness id in this repo, enabled or not. */
export const HARNESS_IDS: readonly HarnessId[] = Object.keys(ALL_HARNESSES);

/**
 * Check the ids in `enabled.json` against the harnesses that exist and return them.
 * Throws on an unknown id (inherited names such as `toString` are unknown), a
 * duplicate, or an empty list.
 */
export function validateEnabled(ids: unknown[], all: Record<string, unknown>): string[] {
  if (ids.length === 0) {
    throw new Error('src/harnesses/enabled.json must name at least one harness.');
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || !Object.hasOwn(all, id)) {
      throw new Error(
        `Unknown harness "${String(id)}" in src/harnesses/enabled.json. Valid ids: ${Object.keys(all).join(', ')}.`
      );
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate harness "${id}" in src/harnesses/enabled.json.`);
    }
    seen.add(id);
  }
  return ids as string[];
}

/** The modules named in `enabled.json`, in declared order. Throws on an unknown or duplicate id, or an empty list. */
export function enabledHarnesses(): HarnessModule[] {
  return validateEnabled(enabled as unknown[], ALL_HARNESSES).map((id) => ALL_HARNESSES[id]);
}
