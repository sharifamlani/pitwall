# Phase 1 — Import Agntree, Harness-Modular, Claude-Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Agntree's code into Pitwall with its history and MIT credit. Rename it to Pitwall, and reorganize it so every agent ("harness") lives in its own folder behind one registration point. Ship with **only Claude Code enabled**, while Codex, opencode and Pi stay in the tree, dormant and tested, re-enabled by one line.

**Architecture:** `src/core/` holds everything agent-agnostic. `src/core/harness/` holds the harness contract, the registries, and a `kit/` of reusable building blocks. `src/harnesses/<id>/` holds one self-contained folder per agent, each exporting a `HarnessModule` and a `contributes.json` manifest fragment. `src/harnesses/enabled.json` (`["claude"]`) is **the one switch**: activation code reads it to decide which modules to construct, and `scripts/build-manifest.mjs` reads it to decide which fragments get merged into `package.json`. Core never imports a harness folder, and a dry test enforces that.

**Tech Stack:** TypeScript 5, esbuild, VS Code API ^1.93, `node --test` dry tests with a `vscode` stub, `@vscode/test-electron` integration tests, `@vscode/vsce` for packaging. Python/Poetry tooling (`tools/`) from Phase 0 stays.

**Spec:**
- Sharif 2026-11-16: *"initial POC should be Claude Code but write the code in a generic way such that it will be easy to integrate plus Codex, opencode and Pi down the road. also make sure the folder organization is organized and easy, generic and additive"*
- [ROADMAP](../../../ROADMAP.md) v0.9, Phase 1 (rows 1.1–1.6) and decisions D1–D38 in §2.
- Spec canvas + brand book (decision log rows 1–25): https://claude.ai/artifact/XhYy9L747DwQzBsQDpaFF2
- Live assumption tests and Claude Code recon: [docs/research/2026-11-16-assumption-tests.md](../../research/2026-11-16-assumption-tests.md)
- Coupling map of upstream `47124cd` (research, 2026-11-16): summarized in the Review Focus and Task 3–5 decisions below.

## Phase tracker

```
PITWALL — phase plan (ROADMAP v0.9)
─────────────────────────────────
Phase 0 : Foundation + spec + live tests     [████████████████████] ✅ v0.1.0
Phase 1 : Import Agntree, harness-modular    [⏸...................] waiting on you (plan review)
Phase 2 : Windows parity
Phase 3 : Sidebar v1: repos and sessions
Phase 4 : Windows and tabs (one window per folder)
Phase 5 : Status + pop-ups
Phase 6 : Package + launch (v1.0.0)
Phase 7 : After v1 (backlog)
```

**What changed since the first draft (2026-11-16):** the phases were re-cut in ROADMAP v0.9 after the live tests (see its §0.5). Phase 1 itself keeps the same six tasks; this revision adds the lessons from the tests (launching Cursor from scripts, the `vscode://` bug, `THIRD_PARTY_NOTICES.md`) and points every later decision at the phase that builds it. **Phase 1 stays behaviour-neutral**: no D11–D37 features land here.

## Global Constraints

- Upstream: `https://github.com/subhashkhileri/agntree` at `47124cd` (v4.0.0, MIT). Import with full history (`--allow-unrelated-histories`). Keep `Copyright (c) Subhash Khileri` in `LICENSE` and a "Forked from Agntree" credit in the README.
- Product id `pitwall`, publisher `sharifamlani`, displayName `Pitwall`, version `0.2.0`. All `agntree.` command, setting, view and context-key ids become `pitwall.`. Storage keys are renamed too (a fresh namespace, so no legacy records).
- No "Claude" in the product name. The Claude Code extension is driven only through its public command `claude-vscode.editor.open` and the URI `vscode://anthropic.claude-code/open`.
- Supported Claude Code CLI ≥ 2.1.310 (upstream ADR 0002). This machine has CLI 2.1.325 and extension 2.1.296.
- **Lift-and-shift:** files are moved with `git mv`, and content changes are limited to imports, the id rename, the registration seam, and the manifest split. No refactors, "cleanups", or behavior changes beyond what this plan lists.
- `.claude/` stays git-ignored except `.claude/skills/pitwall-*/` (upstream's 4 extension skills, renamed). `check_private_paths` allows exactly that prefix.
- **Launching Cursor from a script or test:** clear `ELECTRON_RUN_AS_NODE` (and `VSCODE_ESM_ENTRYPOINT`, `VSCODE_CRASH_REPORTER_PROCESS_TYPE`) first. Shells started from Cursor's extension host inherit them, and `cursor`/`Cursor.exe` then starts with no window (found in the live tests).
- **Known upstream bug, not fixed here:** Agntree's link fallback hardcodes `vscode://`, which opens VS Code instead of Cursor. Phase 4 (row 4.1) fixes it with `vscode.env.uriScheme`. Phase 1 is a lift-and-shift and leaves behaviour alone.
- Nothing private enters any container: tests run in a container on a `git ls-files`-filtered copy, so `.packages/`, `.env`, and `transcripts/` never reach it.

## Review Focus

1. **A stored chat or search record for a disabled harness** crashes the sidebar: `registry.get()` throws synchronously inside `Promise.all` at upstream `WorkspacesTreeProvider.ts:322`. Expected: the row is hidden and the tree renders. → Task 5 test `disabled harness records are skipped, not thrown`.
2. **Palette shows commands for disabled harnesses**, which then fail with "command not found". Expected: the shipped `package.json` contributes zero Codex/opencode/Pi commands. → Task 5 manifest test.
3. **The legacy `agntree.newChat` alias hardcodes `'claude'`** (upstream `chat.ts:515`). Expected: it uses the first enabled harness. → Task 5.
4. **Core quietly re-imports a harness folder** in a later phase, so modularity rots. Expected: a test fails. → Task 4 `architecture.test.ts`.
5. **Test runner silently skips moved tests** (upstream `run.js` only globs `test/dry/*.test.ts`, not subfolders). Expected: the test count after the reorg equals the count before. → Task 4 Step "count parity".

---

## 1. Folder / file structure (paths this plan touches)

```
pitwall/
├── LICENSE                         MODIFY  + upstream copyright line, verbatim, above ours
├── README.md                       MODIFY  Pitwall README + "Forked from Agntree" credit (upstream README not kept)
├── CHANGELOG.md                    REPLACE "0.2.0 — forked from Agntree 4.0.0 (47124cd)"
├── THIRD_PARTY_NOTICES.md          CREATE  Agntree (MIT) notice now; later lifts (e.g. claude-code-manager, Apache-2.0) append here
├── AGENTS.md                       KEEP    upstream agent guide; ids renamed; layout section rewritten for core/harnesses
├── CLAUDE.md / ROADMAP.md          MODIFY  ours win; ROADMAP rows 1.1–1.6 flipped at close, §0 → Phase 2
├── package.json                    MODIFY  name/publisher/version; `contributes` GENERATED by build-manifest
├── manifest/
│   └── core.contributes.json       CREATE  agent-agnostic contributions (views, generic commands/menus/settings)
├── scripts/
│   ├── build-manifest.mjs          CREATE  core + enabled harness fragments → package.json; `--check` mode
│   ├── verify.sh                   RENAME  from verify-foundation.sh; + npm checks + containerized Linux tests
│   ├── generate-harness-icons.mjs  KEEP    (upstream)
│   └── dropbox-ignore.ps1          KEEP
├── src/
│   ├── extension.ts                MODIFY  composition root: builds enabled modules, no harness imports
│   ├── core/
│   │   ├── types.ts                MOVE    (was src/types.ts); HarnessId becomes string-backed
│   │   ├── commands/  providers/   MOVE    (was src/commands, src/providers)
│   │   ├── services/               MOVE    agnostic services only (Storage, Git, GitHub, Terminal*, WorktreeCatalog,
│   │   │                                   SessionAttention, Notification, SessionImport, SessionSearch, OperationLog)
│   │   ├── utils/                  MOVE    (paths.ts minus Claude/Pi encoders)
│   │   └── harness/
│   │       ├── types.ts  HarnessRegistry.ts  HarnessWatcherRegistry.ts  sessionUtils.ts  treeIcons.ts   MOVE
│   │       ├── cli.ts              MOVE    (was harnesses/commandUtils.ts) — fixes core→harness dependency
│   │       ├── module.ts           CREATE  HarnessModule factory interface
│   │       └── kit/                MOVE    ExactIdSessionWatcher, PendingSessionWatcher, NativeUiTabSurfaceService,
│   │                                       nativeUiWorkspace, jsonlAppendReader, recordCache
│   └── harnesses/
│       ├── index.ts                CREATE  ALL_HARNESSES map + enabledHarnesses() (reads enabled.json)
│       ├── enabled.json            CREATE  ["claude"]   ← THE ONE SWITCH
│       ├── README.md               CREATE  "Adding a harness" checklist (folder + fragment + 1 line)
│       ├── claude/                 MOVE    index.ts(new) contributes.json(new) ClaudeHarness claudeUi claudeSearch
│       │                                   ClaudeSessionService ClaudeSessionWatcher ClaudeTurnState ClaudeAgentsService
│       │                                   claudeConfig paths.ts(encoders moved from utils/paths)
│       ├── codex/                  MOVE    dormant: same shape (CodexHarness codexUi codexSearch CodexAppServer CodexRollout CodexSessionWatcher)
│       ├── opencode/               MOVE    dormant: OpencodeHarness opencodeSearch OpencodeSessionService OpencodeSessionWatcher
│       └── pi/                     MOVE    dormant: PiHarness piSearch PiSessionService PiSessionWatcher paths.ts
├── test/dry/
│   ├── run.js                      MODIFY  recurse into subfolders
│   ├── core/*.test.ts              MOVE    16 core tests + architecture.test.ts, manifest.test.ts, registry-safety.test.ts (new)
│   ├── harnesses/<id>/*.test.ts    MOVE    per-harness tests + fixtures beside them
│   └── shared/*.test.ts            MOVE    kit tests (native-ui, pending/exact-id watchers, jsonl reader, search sources)
├── docs/
│   ├── adr/                        MOVE    (was adr/) upstream decision records, ids renamed
│   ├── reference …                   KEEP in place (Ruling R8); fixtures stay in test/dry/fixtures/ (Ruling R13)
│   ├── windows-test-triage.md      CREATE  every Windows-failing/skipped test, classified (feeds Phase 2)
│   └── superpowers/plans/…         this plan
├── .claude/skills/pitwall-*/       MOVE    upstream's 4 skills renamed (add-feature, build-extension, debug-extension, inspect-runtime-state)
├── .github/
│   ├── workflows/ci.yml            CREATE  ubuntu: ci+typecheck+compile+manifest-check+test; windows: typecheck+compile
│   ├── workflows/pages.yml, release.yml   DELETE (upstream's site deploy + Marketplace publish with their secrets)
│   └── ISSUE_TEMPLATE/, PULL_REQUEST_TEMPLATE.md   KEEP, renamed
├── tools/check_private_paths.py    MODIFY  allow .claude/skills/pitwall-*/ only (+ tests)
└── DELETED from tree (still in history): site/, media/, CODE_OF_CONDUCT/CONTRIBUTING/SECURITY reworded not deleted
```

## 2. Flowchart

```
BUILD TIME
+--------------------------+     +---------------------------------+
| src/harnesses/enabled.json|---->| scripts/build-manifest.mjs      |
|   ["claude"]             |     |  manifest/core.contributes.json |
+------------+-------------+     |  + harnesses/<enabled>/          |
             |                   |      contributes.json            |
             |                   +----------------+----------------+
             |                                    v
             |                   +---------------------------------+     +-----------------+
             |                   | package.json (contributes)      |---->| vsce package    |
             |                   |  --check fails if out of sync   |     | pitwall-0.2.0   |
             |                   +---------------------------------+     |   .vsix         |
             |                                                           +--------+--------+
RUN TIME (Cursor)                                                                  |
             v                                                                     v
+--------------------------+   create(deps)   +------------------------+   +----------------+
| src/extension.ts         |----------------->| harnesses/claude/      |   | Cursor installs|
|  enabledHarnesses()      |   per enabled    |  index.ts (module)     |   | --install-ext  |
+------------+-------------+                  +-----------+------------+   +----------------+
             |                                 adapter    | watcher
             v                                            v
+--------------------------+     +-------------------------------------------+
| core/harness/            |<----| HarnessRegistry  +  HarnessWatcherRegistry|
|  registry.has() guards   |     +-------------------------------------------+
+------------+-------------+
             v
+------------------------------------------------------------------------+
| core services: SessionAttention (4 s poll) -> Notification -> tree rows |
| providers/WorkspacesTree  ·  commands/chat (UI handoff to Claude Code)  |
+------------------------------------------------------------------------+

VERIFY (scripts/verify.sh)
host: eol -> poetry -> privacy -> env -> npm ci/typecheck/compile -> manifest --check
      -> docker: git ls-files copy -> npm ci -> npm test (Linux) -> docker toolchain
GitHub: ci.yml  ubuntu(full)  +  windows(typecheck+compile)
```

## 3. UI wireframes

**Activity bar + sidebar title**
```
BEFORE (upstream)                         AFTER
+--+---------------------------+          +--+---------------------------+
|🌳| AGNTREE            [+][⟳] |          |•●•○| PITWALL          [+][⟳] |  ← name + status-row mark (D17; final art Phase 3)
|  | ▸ job-market              |          |  | ▸ job-market              |
|  |   ● fix scraper   claude  |          |  |   ● fix scraper           |  ← behavior unchanged in Phase 1
+--+---------------------------+          +--+---------------------------+
```

**"+" New Session menu (`pitwall.newSession` submenu)**
```
BEFORE                                    AFTER (Claude-only build)
+--------------------------------+        +--------------------------------+
| New Claude Code Session        |        | New Claude Code Session        |
| New Claude Code Session in UI  |        | New Claude Code Session in UI  |
| New Codex Session              |  ←─x   | ────────────────────────────── |
| New Codex Session in UI        |  ←─x   | Set Default Agent…             |
| New opencode Session           |  ←─x   +--------------------------------+
| New Pi Session                 |  ←─x
| ────────────────────────────── |
| Set Default Agent…             |
+--------------------------------+
```

**Empty state (`viewsWelcome`)**
```
BEFORE: "Manage Claude Code, opencode, Codex, and Pi sessions…"   [Add Repository]
AFTER:  "Every Claude Code session across your repos, in one sidebar."   [Add Repository]
```

**Command palette (`Ctrl+Shift+P`, type "pitwall")**
```
BEFORE: Agntree: New Codex Session · Agntree: New Pi Session · … (always shown, 83 commands)
AFTER:  Pitwall: New Claude Code Session · … (0 Codex/opencode/Pi entries)
```

| UI piece | BEFORE | AFTER |
|---|---|---|
| Activity-bar title | AGNTREE | PITWALL |
| New-session menu | 8 agent entries | 2 Claude entries |
| Palette agent commands | 4 agents | Claude only |
| Settings section | "Agntree", 4 agent commands | "Pitwall", `pitwall.harnessCommands.claude` only |
| Welcome text | 4 agents named | Claude Code tagline |
| Row behavior / status icons | upstream | unchanged (Phases 4–5) |

## 4. Derisking (run in order; don't start N+1 until N passes)

**Smoke 0 — Windows spikes: done before this plan** (live tests, 2026-11-16). The sessions file reports "waiting" (T1). Hooks fire in the Cursor panel (T11). Maximizing an editor group works in Cursor (T3). Opening a chat never duplicates its tab (T6). One window can't resume another folder's chat (T5, T17), which shapes Phase 4, not Phase 1. Windows notifications are now on (needed in Phase 5).

**Smoke 1 — history imported intact**
- Proves: upstream's 104 commits and authorship are reachable.
- Command: `git merge-base --is-ancestor 47124cd HEAD && echo OK ; git log --format=%an | grep -c "Subhash"`
- Expected: `OK`, and the count ≥ 1. (No commit-count check: `main` already has our own commits and two root commits, so a count doesn't measure the import.)
- If it fails → re-run the merge from a clean tree with `git fetch upstream` first.

**Smoke 2 — unmodified import builds and matches the Linux baseline**
- Proves: the merge itself broke nothing. Run before any rename or move.
- Command: `bash scripts/verify.sh --skip-docker` (npm part) and `bash scripts/run-linux-tests.sh`
- Expected: typecheck/compile exit 0; Linux `ℹ pass 183`, `ℹ fail ≤ 1`, and the only allowed failure is the known timing test "stopping an opencode snapshot ends the session listing and unblocks preparation".
- If it fails → diff against the clean clone in `%TEMP%/agntree-src`; a merge resolution dropped something.

**Smoke 3 — rename is complete and behavior-neutral**
- Proves: no `agntree` id survives; tests unchanged.
- Command: `git grep -niE "agntree" -- src test package.json manifest | grep -v "credit-allow" | wc -l` then the Linux tests
- Expected: `0`; Linux pass count identical to Smoke 2.
- If it fails → grep output names the file; re-run the scripted rename on it.

**Smoke 4 — reorg moved everything and lost no test**
- Proves: core/harness layout compiles; every test still runs.
- Command: `npm run typecheck && npm run compile && bash scripts/run-linux-tests.sh`
- Expected: `ℹ tests` = Smoke 3's total + k (k = test cases in `architecture.test.ts`); pass count = Smoke 3's pass count + k; `architecture.test.ts` passes.
- If it fails → count mismatch = run.js recursion; type error = a missed import path.

**Smoke 5 — the one switch works both ways (additivity proof)**
- Proves: enabling a dormant harness is a one-line change.
- Command: `node scripts/build-manifest.mjs --check` (expect pass), then `node scripts/build-manifest.mjs --enabled claude,codex --out $TEMP/pkg.json && node -e "…count codex commands…"`
- Expected: `--check` exit 0; shipped manifest has 0 codex/opencode/pi ids; the `claude,codex` build has the 4 codex commands.
- If it fails → fragment split put a codex entry in core.contributes.json.

**Smoke 6 — extension activates in a real VS Code (Windows host)**
- Proves: activation, view registration and command registration under the real API.
- Command: `env -u ELECTRON_RUN_AS_NODE -u VSCODE_ESM_ENTRYPOINT -u VSCODE_CRASH_REPORTER_PROCESS_TYPE npm run test:integration` (shells started from Cursor inherit `ELECTRON_RUN_AS_NODE=1`, which stops Electron from starting)
- Expected: integration suite passes (assertions trimmed to Claude-only); exit 0.
- If it fails → read the Extension Host log the runner prints; most likely an id still `agntree.*` in a `when` clause.

**Smoke 7 — END-TO-END: installed in Sharif's Cursor, it activates and lists this repo**
- Proves: the packaged `.vsix` works in the real editor.
- Command: `npx -y @vscode/vsce@3.2.1 package -o dist/pitwall-0.2.0.vsix && env -u ELECTRON_RUN_AS_NODE -u VSCODE_ESM_ENTRYPOINT -u VSCODE_CRASH_REPORTER_PROCESS_TYPE cursor --install-extension dist/pitwall-0.2.0.vsix --force`, reload Cursor, then `grep -h "sharifamlani.pitwall" "$APPDATA/Cursor/logs/<newest>/window*/exthost/exthost.log"`
- Expected: `cursor --list-extensions --show-versions` shows `sharifamlani.pitwall@0.2.0`; exthost log shows activation and 0 lines matching `pitwall.*(Error|failed)`. Screenshot evidence: testing agent UJ run 6 (see `docs/progress_reports/phase1-scorecard.md`, E8 part 2).
- If it fails → the exthost log names the throwing module.

**Ground truth after Smoke 7:** Phase 1 still builds rows only from Pitwall's own stored chats (upstream `WorkspacesTreeProvider` reads `storageService.getChatsByWorktree`), and the renamed storage starts empty. Upstream auto-import (`pitwall.autoImport.enabled`, default **true**, scans every 2 min) adds a repo's recent Claude chats on its own, so check two things on a test repo with one known chat: (1) **auto path:** with defaults, after adding the repo, exactly **1 row** appears within ~2 minutes, titled with that chat's `ai-title`; (2) **manual path:** with `pitwall.autoImport.enabled = false`, remove and re-add the repo → **0 rows** held for 150 s, then *Pitwall: Import Existing Sessions…* imports it → exactly **1 row** with the same title. (Found by the testing agent, UJ run 1.) Reading every chat across all repos with no repo added is Phase 3 (rows 3.1–3.2).

## 5. Evaluation criteria (definition of done; graded by an independent evaluator sub-agent)

| # | Criterion | Metric + threshold | How measured | Evidence |
|---|---|---|---|---|
| E1 | Agntree's history and credit are kept | `47124cd` is an ancestor of `main`; LICENSE has both copyright lines; README has the credit + link | `git merge-base --is-ancestor`; `grep` | outputs |
| E2 | Linux suite green | all tests pass except at most the one known-flaky test "stopping an opencode snapshot ends the session listing and unblocks preparation" (any other failure = FAIL), in a fresh clone | `bash scripts/run-linux-tests.sh` on a fresh clone | `ℹ` summary lines |
| E3 | Core is agent-agnostic | `architecture.test.ts` passes: no file under `src/core/` imports `src/harnesses/**`; only `src/extension.ts` imports `src/harnesses/index.ts` | `npm test` | test line |
| E4 | Adding an agent is one switch | `--enabled claude,codex` build yields Codex commands + settings; `["claude"]` yields none; dormant harness tests still run and pass | Smoke 5 + test counts per folder | outputs |
| E5 | Shipped build is Claude-only | 0 occurrences of `codex`, `opencode`, `"pi"` / `Pi ` agent ids in shipped `package.json` contributes | `node -e` scan of package.json | count |
| E6 | Renamed completely | 0 `agntree` hits in `src/ test/ manifest/ package.json` outside the explicit credit lines | `git grep -ni agntree` | count |
| E7 | Disabled-agent records can't break the sidebar | `registry-safety.test.ts` passes (stored codex chat + search record with codex disabled → tree renders, no throw) | `npm test` | test line |
| E8 | It runs in a real editor | integration suite exit 0 on Windows host **and** Cursor exthost log shows `sharifamlani.pitwall` activated with 0 errors | Smokes 6–7 | log lines + testing agent UJ run 6 (see `docs/progress_reports/phase1-scorecard.md`, E8 part 2) |
| E9 | Windows failures are triaged | `docs/windows-test-triage.md` lists every Windows fail+skip (count = Windows `fail + skipped`) with a class: env-limit / POSIX-assumption / real-bug | count rows vs Windows run | file + run summary |
| E10 | Verify + CI green | `scripts/verify.sh` exit 0 on host; GitHub Actions `ci.yml` green on both jobs for the closing commit | run + `gh run list --limit 1` | outputs |
| E11 | Privacy holds | `check_private_paths` OK; gitleaks no leaks on fresh clone; only `.claude/skills/pitwall-*/` tracked under `.claude/` | commands | outputs |
| E12 | ROADMAP + release | ROADMAP rows 1.1–1.6 ✅ with SHAs, §0 → Phase 2 (Windows parity), §6 entry, version bumped; annotated tag `v0.2.0` on GitHub; `package.json` version `0.2.0` | grep + `git ls-remote --tags` | outputs |

## 6. Implementation tasks

### Task 1: Import upstream with history; resolve root collisions
**Files:** merge commit; modify LICENSE, README.md, .gitignore, CHANGELOG.md, CLAUDE.md; create THIRD_PARTY_NOTICES.md; modify tools/check_private_paths.py + tests; delete site/, media/, .github/workflows/{pages,release}.yml; move adr/→docs/adr/, upstream docs/*.md stay in docs/ (kept in place, R8), .claude/skills/<x>→.claude/skills/pitwall-<x>.
- [ ] `git remote add upstream https://github.com/subhashkhileri/agntree && git fetch upstream && git merge --allow-unrelated-histories --no-commit upstream/main`.
- [ ] Resolve: ours for ROADMAP/CLAUDE.md/.gitignore (union upstream's ignore lines); LICENSE = MIT text with upstream's copyright line followed by ours; README = ours + "Forked from [Agntree](…) by Subhash Khileri (MIT), at `47124cd`".
- [ ] `THIRD_PARTY_NOTICES.md`: one section per upstream project. Agntree: name, URL, commit `47124cd`, licence MIT, full licence text. A header line says later lifts append here with their licence.
- [ ] **TDD:** add `test_pitwall_skill_folder_allowed` (`.claude/skills/pitwall-add-feature/SKILL.md` → not flagged) and `test_other_claude_skill_still_flagged` (`.claude/skills/account-recovery/SKILL.md` → flagged). Watch them fail, then allow `^\.claude/skills/pitwall-[^/]+/` in `check_private_paths.py`. `.gitignore`: `/.claude/*`, `!/.claude/skills/`, `/.claude/skills/*`, `!/.claude/skills/pitwall-*/`.
- [ ] Create `scripts/run-linux-tests.sh`: `git ls-files -co --exclude-standard -z | tar --null -T - -cf - | docker run -i --rm pitwall-dev sh -c 'mkdir -p /tmp/w && tar -xf - -C /tmp/w && cd /tmp/w && npm ci --no-audit --no-fund && npm test'`. Only tracked and unignored files reach the container.
- [ ] Rename `scripts/verify-foundation.sh` → `scripts/verify.sh` (update README/CLAUDE.md refs); add checks `npm` (ci, typecheck, compile) and `linux-tests` (calls run-linux-tests.sh; host only).
- [ ] Run Smokes 1–2. Record the Linux baseline numbers in the commit body.
- [ ] Commit: merge commit `merge: import Agntree 4.0.0 (47124cd) with history`, then `repo: resolve Agntree root files for Pitwall` (+ privacy allowlist commit separately).

### Task 2: Windows triage (no fixes)
**Files:** create `docs/windows-test-triage.md`.
- [ ] `npm test > $TEMP/win-test.log` on the host. For each `✖` and each skipped test: name, file:line, error class. **env-limit:** symlink EPERM, POSIX fake CLIs. **POSIX-assumption:** a test expects POSIX quoting or paths. **real-bug:** product behavior is wrong on Windows. Add a one-line hypothesis for each.
- [ ] Row count must equal `fail + skipped` from the summary (E9).
- [ ] Commit `docs: triage upstream's Windows test failures for Phase 2`.

### Task 3: Rename agntree → pitwall
**Files:** package.json, src/**, test/**, docs/adr/**, docs/** (kept in place, R8), AGENTS.md, .claude/skills/pitwall-*/**, .github templates, scripts/generate-harness-icons.mjs, resources (if ids appear).
- [ ] Add a committed rename script `scripts/rename-upstream-ids.mjs`: an explicit replacement table (`agntree.` → `pitwall.`, `Agntree` → `Pitwall`, `agntree` → `pitwall`, `subhashkhileri` publisher → `sharifamlani`, `4.0.0` → `0.2.0` in package.json only). It skips LICENSE, CHANGELOG credit lines, and README credit lines, which carry a `credit-allow` marker comment. It is idempotent and prints counts per file.
- [ ] package.json: `name: "pitwall"`, `displayName: "Pitwall"`, `description: "Every Claude Code session across your repos, in one sidebar."`, `publisher: "sharifamlani"`, `version: "0.2.0"`, repository/bugs/homepage → sharifamlani/pitwall. Keywords trimmed to Claude Code + Cursor + session terms.
- [ ] Run Smoke 3. Commit `rename: agntree ids → pitwall (scripted, behavior-neutral)`.

### Task 4: Reorganize into core/ + harnesses/<id>/ (moves only)
**Files:** every `src/**` move per §1; test/dry moves + `run.js` recursion; create `test/dry/core/architecture.test.ts`.

**Interfaces — Produces:**
- `src/core/harness/module.ts`: `export interface HarnessModule { readonly id: HarnessId; create(deps: HarnessDeps): { adapter: HarnessAdapter; watcher?: HarnessSessionWatcher } }` and `export interface HarnessDeps { storageService: StorageService; worktreeCatalog: WorktreeCatalog }`.
- `src/harnesses/<id>/index.ts`: `export const <id>Module: HarnessModule`. Its `create` contains exactly the construction lines for that harness, lifted from upstream `extension.ts:55-71`. Claude's builds the shared `ClaudeSessionService` internally; Pi's builds the shared `PiSessionService`.
- `src/harnesses/index.ts`: `export const ALL_HARNESSES: Record<string, HarnessModule>` and `export function enabledHarnesses(): HarnessModule[]`. The latter reads `./enabled.json`, keeps declared order, and throws at activation on an unknown id, with the message listing valid ids.

- [ ] **Write the failing test** `architecture.test.ts`: walk `src/core/**/*.ts`, parse import specifiers, and assert none resolves under `src/harnesses/`. Assert that `src/extension.ts` imports from `./harnesses` only `./harnesses/index` (or `./harnesses`). Run → FAIL (layout not there yet).
- [ ] Record `ℹ tests N` before moving. `git mv` files per §1. Move `commandUtils.ts` → `core/harness/cli.ts`, Claude encoders → `harnesses/claude/paths.ts`, Pi encoders → `harnesses/pi/paths.ts`. Keep `import type` for the StorageService ↔ sessionUtils cycle.
- [ ] Update `test/dry/run.js` to collect `*.test.ts` recursively. Move tests to `core/`, `shared/`, `harnesses/<id>/` with their fixtures. Fix relative imports.
- [ ] Create `module.ts`, the four `index.ts` modules, `harnesses/index.ts`, and `enabled.json` = `["claude","codex","opencode","pi"]` **for this task only**, so behavior is identical. Rewrite `extension.ts:55-71` to `enabledHarnesses().map(m => m.create(deps))` feeding both registries.
- [ ] Run Smoke 4: `ℹ tests` equals **N + k**, where N was recorded before any move and before `architecture.test.ts` existed, and k is the number of `test(` cases in `architecture.test.ts` (state k in the PR). Architecture test passes. (Review Focus #5.) Commit `refactor: core/ + harnesses/<id>/ layout behind HarnessModule (moves only)`.

### Task 5: Claude-only switch, manifest fragments, registry safety
**Files:** `enabled.json` → `["claude"]`; create `manifest/core.contributes.json`, `src/harnesses/{claude,codex,opencode,pi}/contributes.json`, `scripts/build-manifest.mjs`, `src/harnesses/README.md`, tests `test/dry/core/manifest.test.ts`, `test/dry/core/registry-safety.test.ts`; modify `HarnessRegistry.ts` (+`has(id)`), callers listed in Review Focus #1, `core/types.ts`, `StorageService.ts:469`, `SessionSearchService.ts:136`, `chat.ts:515`, `package.json`, integration suite assertions.

**Interfaces — Produces:**
- `HarnessRegistry.has(id: string): boolean`; `get()` keeps throwing (programmer error), and callers that read stored data use `has()` first.
- `scripts/build-manifest.mjs [--check] [--enabled a,b] [--out path]`. It merges `contributes` = core fragment + enabled fragments in `enabled.json` order: object keys merge, arrays concatenate, and `menus.<id>` arrays concatenate. Enums marked `"x-harness-enum": true` in core (`defaultHarness`, `sessionSearch.harness`) are filled with the enabled ids. Default output is `package.json`, rewritten with 2-space JSON plus a trailing newline. `--check` exits 1 with a unified diff if out of sync.
- Row-menu `when` regexes `(ClaudeUi|CodexUi)?` become `(\w+Ui)?`, so a future UI harness touches no row menus.

- [ ] **Failing tests first:**
  - `manifest.test.ts`: build with `["claude"]` → no command/setting/menu id or enum containing `codex|opencode|pi`, and the Claude commands exist. Build with `["claude","codex"]` → `pitwall.newCodexChat` exists. Shipped `package.json` equals the `["claude"]` build.
  - `registry-safety.test.ts`: registry with only Claude, storage seeded with one `harness:'codex'` chat and one codex search record → `WorkspacesTreeProvider.getChildren(worktree)` resolves without throwing and omits the codex row. `TerminalManager` restore skips it. `SessionSearchTreeProvider` omits it. `pitwall.newChat` creates a session with the first enabled harness.
  - Run → FAIL.
- [ ] Split upstream contributes into fragments: every entry whose id, `when`, or enum names one harness goes to that harness's `contributes.json`, and the rest go to `core.contributes.json`. Run the builder and replace `package.json` contributes.
- [ ] Add `has()`; guard the call sites (`WorkspacesTreeProvider` 322/340/379, `TerminalManager` 244/544, `SessionSearchTreeProvider` 95/123/152, `commands/sessionImport.ts:81`, `chat.ts` paths reading stored chats). Switch `isHarnessId` validation to registry membership. `HarnessId` = `string` branded via `HARNESS_IDS` from `ALL_HARNESSES` keys. Point `chat.ts:515` at `enabledHarnesses()[0].id`. Trim the integration suite's per-harness assertions to enabled harnesses (loop over the enabled list rather than hardcoding).
- [ ] `src/harnesses/README.md`: the "Add an agent" checklist. (1) Create `src/harnesses/<id>/` with `index.ts` exporting a `HarnessModule` and a `contributes.json`. (2) Add it to `ALL_HARNESSES`. (3) Add its id to `enabled.json`. (4) Run `node scripts/build-manifest.mjs`. (5) Icons: `node scripts/generate-harness-icons.mjs`. (6) Put tests in `test/dry/harnesses/<id>/`.
- [ ] Tests GREEN; run Smoke 5 and Smoke 6. Commit in two: `feat: Claude-only build via enabled.json + manifest fragments` and `fix: skip stored records of disabled harnesses instead of throwing`.

### Task 6: CI, package, install, close
**Files:** create `.github/workflows/ci.yml`; `.vscodeignore` (exclude tools/, docs/, test/, .devcontainer/, scripts/, manifest/); `docs/evidence/phase1-sidebar.png`; ROADMAP.md.
- [ ] `ci.yml` has two jobs. `ubuntu-latest`: `npm ci`, `npm run typecheck`, `npm run compile`, `node scripts/build-manifest.mjs --check`, `npm test`. `windows-latest`: `npm ci`, `npm run typecheck`, `npm run compile`, `node scripts/build-manifest.mjs --check`; Windows tests join in Phase 2. Push and confirm both jobs green with `gh run watch`.
- [ ] Run Smoke 7 (package, install into Cursor, exthost log, screenshot).
- [ ] Full `bash scripts/verify.sh` exit 0 on the host.
- [ ] Independent evaluator grades E1–E11. Fix and re-grade until all PASS. Then flip ROADMAP rows 1.1–1.6 with SHAs, refresh §0 to Phase 2 (Windows parity), add a §6 entry, bump the stamp, commit, `git tag -a v0.2.0 -m "Phase 1: Agntree import, harness-modular, Claude-only"`, and push the tag. The evaluator then grades E12.

## Out of scope (later phases, per ROADMAP v0.9)
- **Phase 2 Windows parity:** fixing the Windows failures triaged in Task 2; Windows CI running the full suite.
- **Phase 3 Sidebar v1:** repos from `~/.claude` with no repo open (D13, D36); inbox order (D21); branch on every row and ⧉ on worktrees (D14); status dots (D4, D18); "+" and 🕘 history (D28, D34); hiding Changes/worktree/PR panels while keeping FILES (D19); hotkeys (D12, D15, D37); search (D24); brand mark and colours (D17).
- **Phase 4 Windows and tabs:** chat panel by default plus the `vscode://` fix (D3); one window per folder, with Pitwall opening and focusing windows (D35, D36); repo click opens all chats and clicks add tabs (D11); tab matching (T10); repo + branch under tabs (D26); FILES across repos (D22, D23).
- **Phase 5 Status + pop-ups:** hooks and status files, Windows pop-ups, sound, jump list, first-run notification check (D20, D25, D27).
- **Phase 6:** icon art, `.vsix` release, protected `main`, launch post. **Phase 7:** backlog (instant in-chat search, card panel, Remote Control, one-window hub).
- Upstream sync after the reorg: cherry-pick, not merge.
