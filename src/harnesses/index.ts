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

/** The modules named in `enabled.json`, in declared order. Throws on an unknown id. */
export function enabledHarnesses(): HarnessModule[] {
  return (enabled as string[]).map((id) => {
    const harnessModule = ALL_HARNESSES[id];
    if (!harnessModule) {
      throw new Error(
        `Unknown harness "${id}" in src/harnesses/enabled.json. Valid ids: ${Object.keys(ALL_HARNESSES).join(', ')}.`
      );
    }
    return harnessModule;
  });
}

/** Check the ids in `enabled.json` against the harnesses that exist; returns them unchanged. */
export function validateEnabled(_ids: unknown[], _all: Record<string, unknown>): string[] {
  throw new Error('not implemented');
}
