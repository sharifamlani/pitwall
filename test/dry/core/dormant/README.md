# Dormant tests

Tests for features parked by ROADMAP row 3.6 / ruling P9: the Changes view, worktree create/delete/merge/rebase, PR checkout and badges, and fork-with-changes.

- `test/dry/run.js` skips this folder, so these tests do not run.
- `tsconfig.test.json` still includes it, so `npm run typecheck` keeps them compiling against the parked sources.
- They return to `test/dry/core/` (fix the relative imports) when the feature is restored: re-add its manifest entries and `extension.ts` wiring, then move the test back.

| File | Covers |
|---|---|
| `changes.test.ts` | `ChangesTreeProvider` sections and rows, discard commands |
| `worktree-commands.test.ts` | Create / Delete / Rebase worktree commands |
| `menus.test.ts` | Menu rules for the hidden worktree, PR and fork-with-changes commands |
