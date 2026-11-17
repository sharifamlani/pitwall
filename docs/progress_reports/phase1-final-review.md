# Phase 1 final whole-branch review (import merge 1864a47 .. main d5b54ba)

Reviewer: final whole-branch seat (Ruling R5). Read-only. Method: superpowers `requesting-code-review/code-reviewer.md`.
Inputs: plan `docs/superpowers/plans/2026-11-16-phase1-import-agntree.md`, ROADMAP §2 (D9), focused package `final-review-focused.diff`, ledger `progress.md` (R1–R17).
Passes: (1) the focused package top to bottom; (2) the repo at d5b54ba for every `registry.get(` call site, StorageService, chat/sessionSearch commands, verify.sh, .gitignore, tags/remotes; (3) executable probes in the scratchpad (no repo writes):
- `node scripts/build-manifest.mjs --check` → `package.json is up to date (harnesses: claude).`
- Losslessness: built `--enabled claude,opencode,codex,pi` and diffed `contributes` against `git show 718b855:package.json` (pre-Task-5). Only differences: the 16 row-menu `when` regexes `(ClaudeUi|CodexUi)?` → `(\w+Ui)?` (planned), the welcome text, and 3 reworded setting descriptions (R16). Every command, submenu, keybinding, view and other menu entry is identical. **The split is lossless and deterministic.**
- Collision probe: a copy of the builder with a doctored codex fragment (duplicate core command, a core setting key re-declared under a new section title with a different default, a keybinding on a key core already binds) → exit 0, all three duplicates in the output.
- Architecture-test regex probe on 8 import shapes (results in Minor 1).

I did not re-run the test suites; the independent evaluator is grading E1–E11 on a fresh clone in parallel.

---

## Strengths

- **The manifest split is good engineering.** `scripts/build-manifest.mjs` is small, dependency-free, deterministic (insertion order: core, then `enabled.json` order), CRLF-tolerant in `--check`, prints a real unified diff, and separates exit codes (1 stale / 2 bad input). The `x-harness-enum` mechanism (core marks the setting, each fragment brings its own label/description) is a clean answer to "enums that list harnesses", and an unmarked fill is rejected. My losslessness diff confirms QA's proof.
- **Registry safety is thorough, not just the Review Focus lines.** Every `harnessRegistry.get(` reached from stored data is behind a `has()` filter or comes from an already-filtered list: `WorkspacesTreeProvider.chatRows` filters first (`:320-322`), `getChatTreeItem` and `resolveTreeItem` guard, `resolveChat` (`chat.ts:129-130`), `showStarredSessions` (`:910`), `openNextSessionNeedingYou` (`:899`), `TerminalManager` launch/fork (`:245`, `:548`), `SessionAttentionService.groupByWorktree` (try/catch), `hasOpenNativeUi` in `extension.ts`, and `defaultHarness()` / `SessionSearchService.engine()` both fall back instead of throwing on an off-enum setting. I found **no remaining path where a stored disabled-harness record throws.**
- **`registry-safety.test.ts` tests behaviour through real providers** (tree, terminal restore with revived PIDs, Find Session view, `newChat` alias with opencode first to prove it is not hardcoded). That is the right level.
- **Core really is agnostic at the import level** and nearly at the string level: the only literal harness id left in `src/core` is the legacy-chat migration default `'claude'` (`StorageService.ts:145`), which is correct.
- **Privacy work is layered**: path gate with prefix-only exemption (the R-fix from Task 1 QA is correct: content beneath `.claude/skills/pitwall-*/` is still checked), gitleaks on a fresh clone with one documented exception (R17), and verify.sh's positive allowlist over `vsce ls`, which is the strongest of the three.
- Deviations were ruled and recorded (R7–R17) instead of drifting silently. `src/harnesses/README.md` is a genuinely usable "add an agent" page.

---

## Issues

### Critical (must fix)

None.

### Important (should fix)

**I1. Upstream Agntree's 13 release tags sit in the local repo and will collide with Pitwall's own versions.** *Fix before tagging v0.2.0.*
- Where: local refs `v1.0.0 v1.0.1 v1.0.2 v1.1.0 v1.2.0 v1.2.1 v1.3.0 v1.4.0 v2.0.0 v2.0.1 v2.1.0 v3.0.0 v4.0.0` (fetched with `git fetch upstream` in Task 1). `git ls-remote --tags origin` shows only `v0.1.0`, so nothing has leaked yet. The `upstream` remote also still has a live push URL.
- Why it matters: one `git push --tags` / `--follow-tags` (a common habit, and some tooling does it) publishes Agntree's v1–v4 on Pitwall's public repo. GitHub would then show "v4.0.0" as Pitwall's latest version, which misleads users and the launch post. Separately, Phase 6's `git tag -a v1.0.0` fails with "tag already exists" in this clone and in the `pitwall-build` worktree, which shares refs.
- Fix (no code): `git tag -d v1.0.0 v1.0.1 v1.0.2 v1.1.0 v1.2.0 v1.2.1 v1.3.0 v1.4.0 v2.0.0 v2.0.1 v2.1.0 v3.0.0 v4.0.0`; `git config remote.upstream.tagOpt --no-tags`; `git remote set-url --push upstream DISABLED`. Push the release tag by name only (`git push origin v0.2.0`, as CLAUDE.md says). Add one line to CLAUDE.md "Versions and tags" so later sessions keep it that way.

**I2. `build-manifest.mjs` lets a harness fragment silently collide with core.** *Can wait until before any second harness is enabled (no shipped impact today). Cheap enough to do in Phase 2.*
- Where: `scripts/build-manifest.mjs:79` (arrays are concatenated with no identity check) and `:130` (settings from all sections are flattened with `Object.assign`, so a key declared in two differently titled sections collapses to the last one).
- Reproduced (scratch copy, exit 0): a codex fragment that re-declares `pitwall.refreshWorkspaces` produces a duplicate command; `pitwall.autoImport.enabled` re-declared under a new `"Codex"` section produces two definitions with conflicting defaults (`true` and `false`); a keybinding on `ctrl+alt+n`, which core already binds, is added without complaint. A same-key, same-section clash *is* caught by the scalar check, and a cross-section clash on an `x-harness-enum` key is caught, but by accident and with the wrong file blamed (`:134` reported `claude/contributes.json` when the bad entry was in codex's).
- Why it matters: D9's promise is "additive: a folder plus one line". With a future harness, the user would see duplicate palette entries, a setting whose effective default depends on load order, or a hotkey that fires the wrong command. None of that would fail `--check` or CI.
- Fix: after merging, assert uniqueness of `commands[].command`, `submenus[].id`, `views.*[].id`, `viewsContainers.*[].id`, and setting keys across *all* sections, and of `keybindings` by `(key, mac, when)`. Optionally add a namespace rule: every id a harness fragment adds must contain that harness's id, which also hard-guards E5. Also match untitled sections by identity rather than `undefined === undefined` (`:91`). Add one manifest test per rule, using a temp fragment dir. That needs a `--root` option or making `HARNESSES_DIR` injectable.

**I3. Packaging is safe only when verify.sh runs. A bare `vsce package` can ship local secrets.** *Must fix before the first public .vsix (Phase 6, or Phase 5 if releases start then). Not a v0.2.0 blocker, because Phase 1 publishes no .vsix.*
- Where: `.vscodeignore` is a denylist. It lists `.env` and `.env.example` (`:33-34`) but not `.env.*`, `*.pem`, `*.key`, `token.json`, `credentials.json`, `.credentials.json`, all of which `.gitignore` covers. vsce ignores `.gitignore` (verify.sh's own comment says so). The positive allowlist exists only in `scripts/verify.sh` step 8, while the plan's packaging command (Smoke 7, plan `:248`) and CLAUDE.md's release step (`gh release create … .vsix`) call `vsce package` directly.
- Why it matters: Sharif's main checkout holds `.env` and `.packages/`, and could hold `.env.local` or a `token.json`. Packaging from there without verify would put that file in a .vsix that gets attached to a public GitHub release.
- Fix: make packaging allowlisted by construction. Add `"files": ["out/**", "resources/**", "README.md", "LICENSE", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md"]` to `package.json`; vsce treats `files` as an include list. Then keep verify's check as a second net. Or add `scripts/package.sh`, which packages and then runs the same allowlist regex over `unzip -Z1` of the produced .vsix, and make it the only documented packaging command. At minimum, mirror the `.gitignore` secrets block in `.vscodeignore` and drop the duplicate `.claude/**` / `.superpowers/**` lines (`:44-45`).

**I4. CI enforces none of the privacy gates in this public repo.** *Should fix before contributors arrive (README and the launch post invite them). Recommended in Phase 2. Not a v0.2.0 blocker.*
- Where: `.github/workflows/ci.yml` runs build, typecheck, manifest-check and dry tests only. `check_private_paths`, gitleaks, the Python tests and the vsix allowlist run only in local `verify.sh`, which is voluntary ("run before every push") and not wired to a hook.
- Why it matters: a contributor PR, or a hurried direct push, that adds `.claude/settings.local.json`, a `.env.local` or a token goes green in CI. The plan's §5 E11 is measured once at close, but privacy has to hold on every later PR.
- Fix: add a `privacy` job: `python -m tools.check_private_paths`. It is stdlib-only, so it needs `actions/setup-python` and no Poetry. Also run `gitleaks/gitleaks-action` (or the gitleaks binary) with `fetch-depth: 0`, and a vsix-allowlist step (`npx @vscode/vsce@3.2.1 ls` + the same regex, ideally moved into a shared script that verify.sh also calls). This was a gap in the plan, not the implementation: plan Task 6 listed only the build steps.

### Minor (nice to have)

**M1. The architecture test can be bypassed.** `test/dry/core/architecture.test.ts:24-30`. Probed: these are caught: `export * from`, `import type`, multi-line imports, `import x = require()`. These pass undetected: `import {a}from '../../harnesses/claude'` (no space before `from`), ``import(`../../harnesses/claude`)`` (template literal), `require('../../harnesses/' + id)` (computed), and any *transitive* route, e.g. a core file importing `../../extension`, or a new top-level `src/shared/` that re-exports a harness. Only `.ts` files are scanned (`:18`). The direct rule E3 asks for holds today; the risk is slow rot, the exact Review Focus #4 concern. Fix: add two cheap assertions, that the top-level entries of `src/` are exactly `{core, harnesses, extension.ts}` and that no core file imports `extension`. Better: derive the graph with esbuild's metafile (already a devDependency). Bundle a synthetic entry that imports every `src/core/**/*.ts` with `external: ['vscode']`, `metafile: true`, and assert that no input lies under `src/harnesses/`. That is transitive and independent of syntax.

**M2. `enabledHarnesses()` validation has gaps, no test, and drifts from the builder's validation.** `src/harnesses/index.ts:22-23`.
- It accepts duplicates (`["claude","claude"]` builds two `ClaudeSessionWatcher`s while the registry keeps one), and it accepts an empty list.
- It looks up ids with a plain object index, so `"toString"` returns `Object.prototype.toString` and activation dies with "create is not a function" instead of the "Valid ids" message.
- The builder (`build-manifest.mjs:101`) checks the opposite set: it rejects duplicates but only checks that a fragment *file* exists, never that the id is in `ALL_HARNESSES`. So a harness folder with a `contributes.json` but no `ALL_HARNESSES` line ships menu entries, while `enabledHarnesses()` throws and the whole extension fails to activate, and CI stays green (it runs no integration tests).
- No dry test covers the unknown-id throw that plan Task 4 specifies, or `ALL_HARNESSES[key].id === key`.
- Fix: use `Object.hasOwn(ALL_HARNESSES, id)`, reject duplicates and an empty list. Add a dry test that asserts the folders that have a `contributes.json` == `ALL_HARNESSES` keys == each module's `id`, and that `enabledHarnesses()` throws with the valid-id list for an unknown id.

**M3. Disabled-harness search records are deleted on the next save, which contradicts the docs.** `StorageService.ts:351-362`. `saveSessionSearch` and `removeSessionSearches` rewrite storage from `getSessionSearches()`, which already filters out disabled harnesses and strips their matches from mixed records. So the first Find Session in a Claude-only build permanently erases stored Codex searches. `src/harnesses/README.md:17` says they "stay in storage", and chats really do stay (the registry-safety test asserts that). The shipped build has no impact (fresh namespace), but a developer toggling `enabled.json` loses data, and the doc is wrong. Fix: filter on read only; on write, merge the new record into the *raw* stored array. Or change the README sentence to say searches are dropped.

**M4. `x-harness-enum` edge cases in the builder.** `build-manifest.mjs:134-150`. The "core does not mark" error names the wrong fragment when the real cause is a cross-section duplicate (see I2). No check that a filled setting's `default` is still in its `enum`: `pitwall.sessionSearch.harness` keeps `default: "claude"` and gets `enum: []` in a build without Claude and Codex/Pi (for example opencode only). No check that core's `enum`/`enumItemLabels`/`enumDescriptions` arrays have equal length before appending. Fix: after filling, assert `enum.includes(default)` when an enum exists, and that the three arrays have equal length.

**M5. The "one switch" also needs a test edit, and the README doesn't say so.** `test/dry/core/manifest.test.ts:116` pins `enabled.json` to `['claude']`. That is a reasonable Phase 1 ship guard for E5, but `src/harnesses/README.md` "Turn a dormant harness back on" says to change `enabled.json`, run the builder, and commit, and `npm test` then fails. Fix: one sentence in the README, or make that assertion read an `EXPECTED_SHIPPED` constant beside the README instructions.

**M6. ci.yml hygiene.** `.github/workflows/ci.yml:15-16,30-31`: actions are pinned to the moving `@v4` tags, not commit SHAs (cheap supply-chain hardening for a public repo; Dependabot can bump SHAs). No `timeout-minutes` (default 6 h) and no `concurrency: cancel-in-progress`. The ubuntu job's `npm test` (`:24`) runs the known timing flakes (R9 measured ~7/60 on one test alone), so unrelated PRs will go red by chance until ROADMAP 2.7 lands. QA already needed one rerun at Task 6.

**M7. `.vscodeignore` details.** `!out/**` (`:15`) comes after `**/*.map` (`:13`), so it re-includes `out/extension.js.map`. This is inherited, harmless (`sourcesContent: false`, public source) and still passes the allowlist, but it is probably unintended. Duplicate lines are at `:44-45`.

**M8. Private-path patterns.** `tools/check_private_paths.py:18-26` covers `.env*`, token/credentials JSON and `*.pem`/`*.key`, but not `.npmrc` (npm auth tokens), `.netrc`, `id_rsa*`/`id_ed25519*`, `*.p12`/`*.pfx`. gitleaks would catch most of these by content, but the path gate is the one that runs at zero cost. Add them, plus a test each.

**M9. Plan/evidence alignment.** Plan §1 still shows `docs/upstream/` (R8 kept the docs in place) and fixtures beside the per-harness tests (R13). Smoke 7 and E8 name `docs/evidence/phase1-sidebar.png`, but under R4 the screenshots live in the testing agent's `%LOCALAPPDATA%\pitwall-uj\captures`, which is not durable or reviewable from the repo. Fix: refresh the plan tree, and either commit one sanitized screenshot or point E8's evidence cell at the UJ report.

---

## Triage of the ledger's carried, deferred and ruled items

| Item (ledger) | Status at d5b54ba | Verdict |
|---|---|---|
| Carry→T6: `mkdir -p dist`; `.vscodeignore` exclusions for tools/, .devcontainer/, CLAUDE.md, poetry files, .env.example | Done (`.vscodeignore:26-41`; verify step 8 allowlist) | Closed. Residual gap → I3 |
| Carry→T6: README public-ready, gitleaks fresh clone (E11) | Done, QA-approved; R17 exception documented | Closed |
| Carry→T6: ci.yml runs `build-manifest --check` | Done on both jobs | Closed. Privacy steps missing → I4 |
| Carry→T5: AGENTS.md / docs layout refresh to core/ + harnesses/<id>/ | Done; no stale `src/services`-style paths found in AGENTS/ARCHITECTURE/docs/skills | Closed |
| Codex ENOENT console errors to vanish at T5 | Smoke 6 + UJ 5 report none | Closed |
| **Upstream tags fetched in T1** (not in the ledger) | 13 tags local, not on origin | **Fix before tagging v0.2.0 → I1** |
| E12: ROADMAP rows 1.1–1.6 flips, §0 → Phase 2, §6, version bump, annotated `v0.2.0` | Pending (controller step after evaluator) | **Must do before close**, after I1 |
| ROADMAP 2.5 Find Session off-enum `sessionSearch.harness` | My read: `SessionSearchService.engine()` falls back to the first runner and `engineSettings` returns early on `!registry.has`, so it no longer throws | Wait for Phase 2, but turn 2.5 into a regression test and close it. Not a blocker |
| ROADMAP 2.6 orphaned restored terminal (UJ 5) | Inherited; the registry-safety test shows a revived disabled-harness tab is likewise left as a plain shell | Phase 2. Not a blocker |
| ROADMAP 2.7 / R9 de-flake list | Open; makes CI flaky (M6) | Phase 2, early. Not a blocker |
| T2 rows 9–12 real-bug (GitService raw `C:/` paths vs native compares) | Unreproduced in UJ 1–5 | Phase 2 (Windows parity). Not a blocker; keep "likely/flagged" wording in public copy |
| `vscode://` hardcoded fallback opens VS Code from Cursor | Known, plan Global Constraints | Phase 4 row 4.1. Not a blocker; README's honest-status section should keep naming it |
| Phase 3 copy pass ("for main" → "for <repo> / main"; "from extension" → "from Pitwall") | Upstream wording | Phase 3 |
| Phase 4 + docs: Claude Code "Trust this folder?" on first window open | External behaviour | Phase 4 |
| R10 `package.json` author = Subhash Khileri | Still upstream's (`package.json:7-8`) | Phase 6 as ruled. Not shown as the publisher in the editor; fine for v0.2.0 |
| R15 `HarnessId` plain string | Accepted. Runtime membership is enforced, and the safety audit above found no gap | Accept; revisit only if a typed-id bug appears |
| R12/R13/R7/R8/R16/R17 | Verified consistent with code (order = claude, opencode, codex, pi; R16 merge rules match my losslessness diff) | Accept |
| R4 screenshot evidence location | Outside the repo | M9 (doc-only) |
| T1 note: d95bfd6 message over-claims | History; rewriting would break the merged SHAs | Leave |
| UJ 5: mis-targeted CUA click in Sharif's window | Process, now pid-pinned | No code action |

**Bottom line for v0.2.0:** only I1 (delete the local upstream tags and stop fetching them) must happen before the tag is cut, along with the E12 steps themselves. I2–I4 and all the Minors can ride into Phase 2 as rows. I recommend adding three: "2.8 manifest builder uniqueness and namespace checks (I2, M4)", "2.9 CI privacy job: path gate, gitleaks, vsix allowlist (I4)", and "2.10 packaging allowlisted by construction (I3)". I3 is required before any public .vsix.

---

## Declined to judge (set aside as outside the plan or spec)

- The bulk rename (1612 replacements) and the git-mv moves, line by line: these are not in the focused package, and QA graded both. I spot-checked with `git grep -i agntree` on docs/adr (0 uncredited hits) and the core-string grep above.
- Upstream behaviour carried over unchanged (lift-and-shift): terminal restore semantics, auto-import cadence, the `vscode://` fallback, and Windows path handling. Each is assigned to a later phase.
- `run-linux-tests.sh` sending untracked-but-unignored files into the container: this is the plan's literal command (Task 1), and the container has no credentials (verify `isolation`).
- README/marketing copy and UI wording: QA approved the README; copy is a Phase 3 matter.
- Re-running the dry, integration and Linux suites and the CI status: the independent evaluator owns E2, E8 and E10 on a fresh clone.
- Whether dormant harness code should be tree-shaken out of `out/extension.js`: D9 says dormant and tested; shipping the code inert is consistent with it, and no constructor runs.

---

## Assessment

**Ready to tag v0.2.0? With fixes.** Only I1 needs to happen first (about 2 minutes, no code). Then the E12 steps.

**Reasoning:** The harness-modular architecture, the lossless manifest split and the registry-safety guards are correct and well tested for the shipped Claude-only build. I found no path where a disabled-harness record throws. The remaining issues are guardrails for the *next* harness and the *next* contributor: silent fragment collisions, privacy gates not running in CI, and packaging that is not allowlisted by construction. They should become Phase 2 rows rather than block this release.
