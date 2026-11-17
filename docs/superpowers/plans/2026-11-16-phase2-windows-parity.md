# Phase 2 — Windows Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The code inherited from Agntree works on native Windows the way it does on Linux. Windows CI runs the full `npm test` green, and the only skipped tests are env-limit skips that print a stated reason. Tag `v0.3.0`.

**Architecture:** Fix the product only where a listed bug says it is wrong. Paths from git get one canonical native spelling, and editor and git paths are compared through one `samePath()` helper. A pending chat's TTL is re-checked at link time. The line typed into a revived terminal is built for the user's real shell, and activation waits at most one PID timeout. Everything else is test portability: CRLF-proof fixtures, junctions instead of symlinks, `.cmd` fake CLIs, and skip reasons. A hardening track runs alongside: manifest uniqueness checks, a `package.json` `files` allowlist, a CI privacy job, and an Electron-safe launch environment.

**Tech Stack:** TypeScript 5, esbuild, `node --test` dry tests with the `vscode` stub, `@vscode/test-electron` (integration + terminal-restore e2e), `@vscode/vsce@3.2.1`, GitHub Actions (`ubuntu-latest`, `windows-latest`), Python 3.13 stdlib tools under `tools/` (pytest), gitleaks `v8.21.2` (docker), Git Bash on Windows 10.

**Spec:**
- [ROADMAP](../../../ROADMAP.md) v0.10: §3 Phase 2 rows 2.1–2.14; §2 D9 (Claude-only, dormant harnesses), D29 (inherit what Cursor does), D35 (one window per folder), D39 (team flow); §0.5.
- [docs/windows-test-triage.md](../../windows-test-triage.md): 29 rows (12 fail + 17 skip). The file:line refs say "as of 47124cd", but the test lines are unchanged after the Phase 1 reorg. Only the folders moved (see "Triage row → current test" below).
- [docs/progress_reports/phase1-final-review.md](../../progress_reports/phase1-final-review.md): I2 (→2.8), I3 (→2.9), I4 (→2.10), Minors M1–M9 (→2.12).
- [docs/research/2026-11-16-assumption-tests.md](../../research/2026-11-16-assumption-tests.md) side notes: `ELECTRON_RUN_AS_NODE` (→2.4).
- Testing agent UJ run 5 (→2.6) and UJ run 6 (→2.11, "No tree item with id" → 2.12). The UJ run 6 exthost log line is `[error] No tree item with id '1/repository-<uuid>' found.`, about 3.5 s after activation.

## Phase tracker

```
PITWALL — phase plan
─────────────────────────────────
Phase 1 : Import Agntree            [████████████████████] ✅ v0.2.0
Phase 2 : Windows parity            [⏳..................] in progress
Phase 3 : Sidebar v1
Phase 4 : Windows and tabs
Phase 5 : Status + pop-ups
Phase 6 : Package + launch (v1.0.0)
Phase 7 : After v1
```

### Triage row → current test (Phase 1 moved folders, not lines)

| Triage rows | Current file |
|---|---|
| 1, 2 | `test/dry/harnesses/claude/claude-scoping.test.ts:54`, `test/dry/harnesses/claude/claude-watcher.test.ts:84` |
| 3, 4–6, 8, 9–12 | `test/dry/core/files.test.ts:9`, `test/dry/core/git.test.ts:94/106/128`, `test/dry/core/session-search-commands.test.ts:113`, `test/dry/core/worktree-commands.test.ts:50/67/87/99` |
| 7 | `test/dry/harnesses/pi/pi.test.ts:158` |
| 13–16 | `test/dry/harnesses/opencode/opencode.test.ts:31/52/91/118` |
| 17–18, 19–22, 23–29 | `test/dry/shared/session-search-runners.test.ts:29/109`, `test/dry/shared/session-search-sources.test.ts:36/165/194/224`, `test/dry/shared/session-search.test.ts:108/184/215/233/251/275/286` |
| product refs | `GitService.ts` parseWorktrees `:130-171` (id `:158`, path `:162`), `worktreeId` `:568`; `WorkspacesTreeProvider.ts:262` and `:411`; `SessionImportService.ts:407` and `:525`; `extension.ts:207`; `ExactIdSessionWatcher.ts` TTL `:134`, link `:200-213` |

Baseline on this machine at `da8f0d4` (evaluator, Phase 1): Windows `ℹ tests 192 / pass 163 / fail 12 / skipped 17`; Linux `192 / 192 / 0 / 0`.

## Global Constraints

- Phase 2 changes behaviour **only to fix the listed bugs** (triage real-bug rows 2 and 9–12, ROADMAP 2.6, 2.11, the 2.12 items, 2.13 = finding F1, and 2.14 = finding F2). No new features, settings, commands or copy. Any other bug a task finds is written down for the lead, not fixed.
- Never copy, embed or modify the Claude Code extension. Drive it only through its public link and commands.
- Public repo: never touch, read into a PR, or quote `.packages/`, `transcripts/`, `.claude/` (except `.claude/skills/pitwall-*/`), `.superpowers/`, `.env`. A probe file never uses those paths.
- Launch Cursor, VS Code or Electron from a shell only with `env -u ELECTRON_RUN_AS_NODE -u VSCODE_ESM_ENTRYPOINT -u VSCODE_CRASH_REPORTER_PROCESS_TYPE …` (after Task 10: `bash scripts/cursor-cli.sh …`).
- Sharif's everyday Cursor is never reloaded, restarted or driven. Live checks run only in the testing agent's separate profile (`$LOCALAPPDATA/pitwall-uj/profile`, launched with `bash "$LOCALAPPDATA/pitwall-uj/harness/launch.sh" <lab>`).
- Windows default terminal on this machine is **Windows PowerShell 5.1** (no `pwsh` installed): `&&` is a parse error there.
- Build worktree: `C:/Users/Shari/pitwall-build` (outside Dropbox). One branch per task, `phase2/task-N-<slug>` off `origin/main`, and one PR per task. Merge commits only, never squash: the red-test commit must survive. The lead merges only the QA-approved sha with `gh pr merge <N> -R sharifamlani/pitwall --merge --match-head-commit <sha>`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Every PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Pinned tools: Node 22, `@vscode/vsce@3.2.1`, `zricethezav/gitleaks:v8.21.2`, Python 3.13. `unset VIRTUAL_ENV` before any `poetry` command.
- No retries, no raised global timeout, no `sleep` to fix a timing test: wait on an explicit condition or remove the race.
- **Counting skips.** The dry runner uses the spec reporter (`test/dry/run.js:68`). It prints a skipped test as `﹣ <name> (<t>ms) # <reason>` (the first character is U+FE63) and never prints `# SKIP`. Count skips with `grep -cE "^ *﹣ " log`. Every skip has a reason when `grep -E "^ *﹣ " log | grep -cvE " # .+"` prints `0`.
- **Failure counts depend on merge order.** Tasks 1, 2, 3, 4 and 6 each fix different triage rows and merge in any order. Wherever this plan gives a Windows `ℹ fail` count before Task 11, it means: failures on `main` at branch time, minus the rows this task fixes. Every `✖` left must be a triage row another task owns, and the PR lists them by row number.
- Write files with the file tools (UTF-8), not PowerShell `Set-Content`.

## Review Focus

1. **The editor lowercases the drive letter.** `vscode.Uri.fsPath` gives `c:\…` while git prints `C:/…`. Expected: the window's own worktree row still shows `●` / "Active workspace", and `switchWorkspaceFolder` never re-opens the folder it is already in. → Task 1 tests `the window's own worktree is marked active whatever case the editor gives its drive letter` and `samePath matches one folder however the editor or git spells it`.
2. **GitHub's Windows runner TEMP is an 8.3 short path** (`C:\Users\RUNNER~1\…`) that git may print in long form. Expected: worktree tests pass on CI exactly as on this machine. → Task 1 makes `tempDir()` use `fs.realpathSync.native` and `samePath()` compare native real paths on win32; Task 11's CI run proves it.
3. **A revived terminal runs Windows PowerShell 5.1**, where `cd 'x' && claude --resume id` does not parse. Expected: the revived tab resumes, and a copied resume command pastes and runs in the default Windows shell. → Task 6 `commandInDirectory builds a line each shell can run`.
4. **Windows reports a revived terminal's PID later than 2 s.** Expected: activation is not held for 2 s per tab, and the late tab is still resumed, never duplicated by a click. → Task 6 `after a quit, activation waits at most one PID timeout…` and `a revived tab whose PID arrives late is still resumed…`.
5. **CI's Windows git has `core.autocrlf=true`.** Expected: git fixture tests compare LF content regardless of machine config. → Task 3 `makeRepo` sets `core.autocrlf false`; Task 11's CI run proves it.

---

## 1. Folder / file structure (paths this plan touches)

```
pitwall/
├── .github/workflows/ci.yml           MODIFY  T8: privacy job, SHA pins, timeouts, concurrency · T11: windows job runs `npm test`
├── .gitignore                         MODIFY  T8: + .npmrc .netrc id_rsa* id_ed25519* *.p12 *.pfx
├── .vscodeignore                      DELETE  T8: vsce refuses it alongside package.json "files"
├── package.json                       MODIFY  T8: "files" allowlist · T11: version 0.3.0
├── CHANGELOG.md                       MODIFY  T11: 0.3.0 entry
├── ROADMAP.md                         MODIFY  T11: rows 2.1–2.14 ✅ + SHAs, §0 → Phase 3, §6 entry, next version
├── scripts/
│   ├── build-manifest.mjs             MODIFY  T7: --root; duplicate-id, enum and section-identity checks
│   ├── repeat-tests.sh                CREATE  T5: one test file N times on P workers → "RUNS n PASS p FAIL f"
│   ├── run-linux-tests.sh             MODIFY  T5: optional command (default `npm test`)
│   ├── cursor-cli.sh                  CREATE  T10: runs the cursor/code CLI with the Electron vars cleared
│   └── verify.sh                      MODIFY  T8: step 8 calls `tools.check_vsix`
├── tools/
│   ├── check_private_paths.py         MODIFY  T8: + 6 credential patterns (M8)
│   ├── check_vsix.py                  CREATE  T8: exact allowlist over `vsce ls`
│   └── tests/test_check_private_paths.py, tests/test_check_vsix.py   MODIFY/CREATE  T8
├── src/
│   ├── extension.ts                   MODIFY  T1: samePath in switchWorkspaceFolder · T10: reveals wait for whenSettled()
│   ├── harnesses/index.ts             MODIFY  T9: Object.hasOwn, reject duplicates and empty list (M2)
│   ├── harnesses/README.md            MODIFY  T9: re-enabling names SHIPPED_HARNESSES in manifest.test.ts (M5)
│   └── core/
│       ├── utils/paths.ts             MODIFY  T1: + nativePath(), samePath()
│       ├── services/GitService.ts     MODIFY  T1: parseWorktrees stores native paths; export worktreeId
│       ├── services/SessionImportService.ts      MODIFY  T1: samePath at :407, :525
│       ├── providers/WorkspacesTreeProvider.ts   MODIFY  T1: samePath at :262, :411 · T10: whenSettled()
│       ├── harness/kit/ExactIdSessionWatcher.ts  MODIFY  T2: TTL re-checked right before linking
│       ├── services/terminalEvents.ts MODIFY  T6: shellKind(), shell-aware commandInDirectory(), readProcessId(timeout)
│       ├── services/TerminalManager.ts MODIFY T6: one PID wait at activation; late-PID read; closeChat closes orphan tab
│       ├── commands/chat.ts           MODIFY  T6: copyResumeCommand uses commandInDirectory
│       ├── commands/sessionSearch.ts  MODIFY  T6: copySearchMatchCommand uses commandInDirectory
│       └── services/StorageService.ts MODIFY  T9: search writes merge into the raw stored array (M3)
├── test/
│   ├── electronEnv.js                 CREATE  T10: scrubElectronEnv(env)
│   ├── integration/runTest.js         MODIFY  T10: scrub before runTests
│   ├── e2e/terminal-restore/run.js    MODIFY  T6: win32 puts fake-claude on PATH · T10: scrubbed env
│   └── dry/
│       ├── run.js                     MODIFY  T1: PITWALL_TEST_NAME_PATTERN · T5: PITWALL_TEST_BUILD_DIR
│       ├── support.ts                 MODIFY  T1: tempDir native realpath · T3: dirLink() · T4: fakeCli .cmd, skipOnWindows(), posixOnly removed
│       ├── vscode-stub.js             MODIFY  T6: env.shell + __setShell(), terminal __pidDelayMs · T10: tree reveal log
│       ├── core/terminal-events.test.ts   CREATE  T6
│       ├── core/electron-env.test.ts      CREATE  T10
│       ├── shared/fake-cli.test.ts        CREATE  T4
│       ├── core/{git,helpers,tree,worktree-commands}.test.ts       MODIFY  T1 (git also T3)
│       ├── core/{files}.test.ts, harnesses/claude/claude-scoping, harnesses/pi/pi   MODIFY  T3
│       ├── core/{session-search-commands,chat-commands,terminal}.test.ts            MODIFY  T6
│       ├── core/{manifest}.test.ts        MODIFY  T7, T9
│       ├── core/{architecture,registry-safety,storage}.test.ts                     MODIFY  T9
│       ├── shared/exact-id-watcher.test.ts                                         MODIFY  T2
│       ├── shared/session-search{,-sources,-runners}.test.ts, harnesses/opencode/opencode.test.ts   MODIFY  T4, T5
│       └── harnesses/codex/codex-app-server.test.ts                                MODIFY  T5
└── docs/
    ├── windows-test-triage.md         MODIFY  T11: current paths + "Phase 2 resolution" column (29 rows)
    ├── superpowers/plans/2026-11-16-phase1-import-agntree.md   MODIFY  T10: tree + E8 evidence pointer (M9)
    └── progress_reports/phase2-scorecard.md                     CREATE  T11: evaluator scorecard
```

## 2. Flowchart

```
(a) TESTS: where they run
+------------------+    npm test     +---------------------+   bundles each *.test.ts (esbuild,
| test/dry/run.js  |---------------->| node --test (spec)  |   vscode -> stub), env:
|  [file filter]   |                 |  ℹ tests/pass/fail/ |   PITWALL_TEST_NAME_PATTERN (T1)
+--------+---------+                 |  ﹣ skip # reason    |   PITWALL_TEST_BUILD_DIR    (T5)
         |                           +----------+----------+
   +-----+-----------------+------------------+ |
   v                       v                  v v
+---------------+  +----------------+  +---------------------------------------------+
| Windows host  |  | Linux container|  | GitHub Actions ci.yml                       |
| pitwall-build |  | run-linux-     |  |  ubuntu : ci typecheck compile manifest test |
| Git Bash      |  | tests.sh [cmd] |  |  windows: ci typecheck compile manifest TEST |(T11)
+---------------+  +----------------+  |  privacy: path gate · gitleaks · check_vsix  |(T8)
   repeat-tests.sh <file> 100 --parallel 4 (T5) on both                            |
                                       +---------------------------------------------+

(b) PATH CANONICALIZATION (T1)
 git worktree list --porcelain          vscode.Uri.fsPath / stored path / user path
   "worktree C:/x/app-wt"                 "c:\x\app"
          |                                      |
          v                                      |
 GitService.parseWorktrees                       |
   path = nativePath(raw)  -> "C:\x\app-wt"      |
   id   = worktreeId(repo, canonicalPath(raw))   |  (id formula unchanged -> stored chats stay attached)
          |                                      |
          +------------------+-------------------+
                             v
               samePath(a, b)  win32: realpath.native, lowercased
                               posix: canonicalPath equality
                             |
     +-----------+-----------+-----------+------------------+
     v           v                       v                  v
 tree :262   findWorktreeByPath :411   SessionImport      extension.ts :207
 (● active)  (Create/Delete/Rebase)    :407, :525         switchWorkspaceFolder

(c) RESTORE AFTER A QUIT (T6)
 Cursor relaunch -> activate -> beginRestoreSync
   |-- adopted:  read PIDs of title-matched tabs in parallel, ONE 2 s cap total
   |             adopt tab whose PID == recorded PID (reload)  ---> activation continues
   '-- complete (background):
         title-matched revived tab, PID unknown -> hold tab in restoringChats,
             re-read PID (<= 10 s)  [a click meanwhile focuses the held tab]
         PID != recorded -> prepareLaunch -> sendText(commandInDirectory(wt, cmd, vscode.env.shell))
                 posix:      cd '<wt>' && <cmd>
                 powershell: Set-Location -LiteralPath '<wt>'; if ($?) { <cmd> }
                 cmd:        cd /d "<wt>" && <cmd>
         not resumable -> tab left unmanaged ... "Remove from Pitwall"
                          -> closeChat(): mapped tab OR live unmapped tab with the chat's [shortId] title -> dispose

(d) PACKAGING ALLOWLIST (T8)
 package.json "files" (allowlist) -- vsce package / vsce ls --> .vsix holds ONLY:
   package.json README.md LICENSE CHANGELOG.md THIRD_PARTY_NOTICES.md out/extension.js
   resources/icons/*.{png,svg} resources/icons/harness/*.svg
        |
        v
 tools/check_vsix.py (exact set) <-- verify.sh step 8 (local)  and  ci.yml privacy job (every PR)

(e) TEAM FLOW PER TASK (D39)
 build subagent (fresh, task text only)          QA agent pitwall-cd
 branch phase2/task-N-<slug>                     re-runs the task's commands on
 red commit (failing test) -> green commit  ---> PR head merged with origin/main
 PR (body: red sha, ✖/✔ lines, Win+Linux ℹ) <--- CHANGES (repro)   |  APPROVE <sha>
                                                                    v
                         lead: gh pr merge N --merge --match-head-commit <sha>
                                                                    v
                    testing agent pitwall-62: vsix of new main -> test Cursor profile
                    walks the task's scenario -> PASS/FAIL + exthost log + captures
                                   FAIL -> repro to the task's builder (back to top)
 after Task 10 merged: Task 11 -> CI windows full suite -> evaluator (independent) ->
 testing final walk (Smoke 12) -> ROADMAP + tag v0.3.0 -> marketing handoff
```

## 3. UI wireframes

Phase 2 adds no screens, buttons, settings or new copy. Five existing surfaces behave differently on Windows because the bugs are fixed. Each is shown on Windows; Linux is unchanged in every case.

**A. Worktree row in the Pitwall list (window opened on `uj-lab-a`)**
```
BEFORE (Windows)                               AFTER (Windows)
+------------------------------------+         +------------------------------------+
| ▾ uj-lab-a                         |         | ▾ uj-lab-a                         |
|   ⎇ main                           |  ←──    |   ⎇ main                    ●      |  ← active marker now shows
|   ⎇ uj/wt-p2                       |         |   ⎇ uj/wt-p2                       |
+------------------------------------+         +------------------------------------+
 hover main:                                    hover main:
 +-------------------------------------+        +-------------------------------------+
 | C:/Users/Shari/…/lab/uj-lab-a       |        | C:\Users\Shari\…\lab\uj-lab-a       |  ← native separators
 +-------------------------------------+        | Active workspace                    |  ← line now present
                                                +-------------------------------------+
```

**B. Create / Delete Worktree (right-click repo row → Create Worktree; worktree row → Delete Worktree)**
```
BEFORE (Windows)                               AFTER (Windows)
Create: folder made, but the new row is        Create: row "⎇ uj/wt-p2" appears under uj-lab-a;
  not found by path (branch lookups fail)        "Existing branch" hides checked-out branches
Delete: fails, TypeError "reading 'name'"      Delete Worktree & Branch: row, folder and branch gone
  in the log; folder stays                     Rebase: offers origin/main first, not its own remote copy
```

**C. Editor terminal tabs after quitting and reopening Cursor with a live chat (2.11)**
```
BEFORE (Windows)                                     AFTER (Windows)
activation held ~4 s                                 activation held ≤ 2 s
+-----------------------------+                      +-----------------------------+
| [>_ Lab ready [7f3d3b]]     |  revived, NOT        | [>_ Lab ready [7f3d3b]]     |  revived AND resumed:
|  PS C:\…\uj-lab-a>          |  resumed             |  Claude Code  ▸ "Lab ready" |  claude --resume in it
+-----------------------------+                      +-----------------------------+
 click row "Lab ready" →                              click row "Lab ready" →
+-----------------------------+-----------------+    +-----------------------------+
| [>_ Lab ready [7f3d3b]]     | [>_ Lab ready   |    | [>_ Lab ready [7f3d3b]] ◀ focused, no new tab
|                             |      [7f3d3b]]  |    +-----------------------------+
+-----------------------------+-----------------+     Reload Window → same single tab, adopted
  ↑ duplicate tab; after Reload Window the duplicate is lost
```

**D. "Remove from Pitwall" on a chat whose restored tab could not be resumed (2.6)**
```
BEFORE                                               AFTER
dialog: "…its terminal will close…" → Remove         same dialog (copy unchanged) → Remove
+-----------------------------+                      (tab strip)
| [>_ New Session [a1b2c3]]   | ← tab stays open     +-----------------------------+
+-----------------------------+   (orphaned)         | (tab closed)                |
row gone from the list                               +-----------------------------+   row gone
```

**E. Copy Resume Command / Copy command of a Find Session match (info toast + clipboard)**
```
BEFORE (Windows, any shell)
 ⓘ Copied: cd 'C:\…\uj-lab-a' && claude --resume 7f3d3bef-…      ← fails to parse in Windows PowerShell 5.1
AFTER (Windows, default shell Windows PowerShell / pwsh)
 ⓘ Copied: Set-Location -LiteralPath 'C:\…\uj-lab-a'; if ($?) { claude --resume 7f3d3bef-… }
AFTER (Windows, default shell cmd.exe)
 ⓘ Copied: cd /d "C:\…\uj-lab-a" && claude --resume 7f3d3bef-…
AFTER (Git Bash / Linux / macOS): unchanged  cd '<path>' && claude --resume <id>
```

| UI piece | BEFORE (Windows) | AFTER (Windows) |
|---|---|---|
| Active-worktree `●` + "Active workspace" tooltip | missing | shown on the window's own worktree |
| Worktree tooltip path | `C:/…` | `C:\…` |
| Create / Delete / Rebase Worktree | wrong or throws | works as on Linux |
| Activation after restore | ~4 s (2 s × tabs + 2 s) | ≤ 2 s |
| Revived chat tab | plain shell | Claude resumed in it |
| Row click after restore | duplicate tab | focuses the revived tab |
| Remove from Pitwall, unresumable restored tab | tab stays | tab closes |
| Copied resume command (toast + clipboard) | POSIX `&&` line | line for the default shell |
| Toast / dialog wording | — | unchanged |

## 4. Derisking (run in order; don't start N+1 until N passes)

All commands run in Git Bash on Windows unless marked *Linux*. `W=/c/Users/Shari/pitwall-build`. Summary lines: `grep -E "^ℹ (tests|pass|fail|skipped)" <log>`.

**Smoke 0: the baseline reproduces the triage**
- What it proves: the build worktree at `origin/main` shows the triaged Windows failures, so later deltas are meaningful.
- Command: `cd $W && git fetch -q origin && git switch --detach origin/main && npm ci --no-audit --no-fund >/dev/null && npm test > "$TEMP/p2-s0.log" 2>&1; grep -E "^ℹ (tests|fail|skipped)" "$TEMP/p2-s0.log"`
- Expected: `ℹ tests 192`, `ℹ fail 12`, `ℹ skipped 17`.
- If it fails → diff the `✖` names against the triage table. If the triage is stale, update it and get the lead's ruling before Task 1.

**Smoke 1: worktree paths are native and match (Task 1)**
- What it proves: git-derived worktree paths match editor paths on Windows (triage rows 9–12).
- Command: `cd $W && npm test -- worktree-commands > "$TEMP/p2-s1.log" 2>&1; grep -E "^ℹ (fail|pass)" "$TEMP/p2-s1.log"; PITWALL_TEST_NAME_PATTERN="native separators|samePath|marked active" npm test -- core/ 2>&1 | grep -E "^ℹ fail"`
- Expected: first command `ℹ fail 0`; second `ℹ fail 0`.
- If it fails → print `gitService.listWorktrees()` paths next to `path.join(...)` in the failing test. A drive-case or 8.3 difference means `samePath` is not used at that comparison.

**Smoke 2: an expired pending chat is never linked (Task 2)**
- What it proves: the TTL holds across an in-flight check (triage row 2).
- Command: `cd $W && npm test -- exact-id-watcher 2>&1 | grep -E "^ℹ fail"; npm test -- claude-watcher 2>&1 | grep -E "^ℹ fail"`
- Expected: `ℹ fail 0` twice.
- If it fails → log `since`, `Date.now()` and `status` at the link point. The re-check must read the chat from storage, not the pass's snapshot.

**Smoke 3: POSIX-assumption tests are portable (Task 3)**
- What it proves: the POSIX-assumption rows pass on Windows; the only failures left are bug rows other tasks own.
- Command: `cd $W && npm test > "$TEMP/p2-s3.log" 2>&1; grep -E "^ℹ (fail|skipped)" "$TEMP/p2-s3.log"; grep "^✖" "$TEMP/p2-s3.log" | sort -u`
- Expected: `ℹ skipped 17`. `ℹ fail` = how many of these two rows are still open on main, and the `✖` names are exactly their tests: row 2 `a closed chat stops waiting after the TTL, and reopening it starts a new window` (open until Task 2 merges) and row 8 `a found session outside every root resumes in a terminal at its folder, and its command copies with that folder` (open until Task 6 merges). So `ℹ fail` is 2, 1 or 0, and the PR says which rows were open.
- If it fails → the `✖` name maps to a triage row. Re-check that row's fix in Task 3 Step 3.

**Smoke 4: fake CLIs run on Windows (Task 4)**
- What it proves: the Claude search and runner tests execute real product code on Windows, and the only skips left have reasons.
- Command: `cd $W && npm test > "$TEMP/p2-s4.log" 2>&1; grep -E "^ℹ (fail|skipped)" "$TEMP/p2-s4.log"; grep -cE "^ *﹣ " "$TEMP/p2-s4.log"; grep -E "^ *﹣ " "$TEMP/p2-s4.log"; grep -E "^ *﹣ " "$TEMP/p2-s4.log" | grep -cvE " # .+"`
- Expected: `ℹ fail` = the open rows defined in Smoke 3 (rows 2 and 8, whichever are still open on main). `ℹ skipped` = the `﹣` line count = 1 + D, where D = the dormant-harness skips listed in the Task 4 PR. The last command prints `0` (every skip line has a non-empty reason after ` # `), and no test whose name starts `a search runs with the configured model` or `stopping a search ends the agent` is skipped.
- If it fails → run `npm test -- fake-cli` first. If that fails, the `.cmd` shim is wrong. If it passes, classify the failure per Task 4 Step 6.

**Smoke 5: the four flaky tests are stable (Task 5)**
- What it proves: ROADMAP 2.7 tests no longer flake under load.
- Command: `cd $W && bash scripts/repeat-tests.sh session-search-sources 100 --parallel 4 --name "stopping an opencode snapshot|byte budget"; bash scripts/repeat-tests.sh codex-app-server 100 --parallel 4 --name "hung request"; bash scripts/repeat-tests.sh shared/session-search.test 100 --parallel 4 --name "stopping a search ends the agent"`, then *Linux*: `bash scripts/run-linux-tests.sh "bash scripts/repeat-tests.sh session-search-sources 100 --parallel 4 --name 'stopping an opencode snapshot|byte budget' && bash scripts/repeat-tests.sh codex-app-server 100 --parallel 4 --name 'hung request' && bash scripts/repeat-tests.sh shared/session-search.test 100 --parallel 4 --name 'stopping a search ends the agent'"`
- Expected: each run prints `RUNS 100 PASS 100 FAIL 0`. On Windows, a test that Task 4 skipped prints `SKIPPED` instead and is graded on Linux only.
- If it fails → keep the failing iteration's log (the script prints its path) and go back to Task 5 Step 3 for that test.

**Smoke 6: restore and resume line, dry (Task 6)**
- What it proves: activation waits at most 2 s, late-PID tabs resume, orphans close on Remove, and the resume line parses per shell. Windows full suite has 0 failures.
- Command: `cd $W && npm test -- terminal 2>&1 | grep -E "^ℹ fail"; npm test > "$TEMP/p2-s6.log" 2>&1; grep -E "^ℹ (fail|skipped)" "$TEMP/p2-s6.log"`
- Expected: `ℹ fail 0` for `terminal`. Full run: `ℹ fail 0` once Tasks 2–4 have merged; before that, only their open rows `✖` (Global Constraints, "Failure counts"). `ℹ skipped` = Smoke 4's count once Task 4 has merged, 17 before.
- If it fails → the failing test name says which of (b)/(c)/(d)/(e) in Task 6 is wrong.

**Smoke 7: quit/reopen in a real editor on Windows (Task 6)**
- What it proves: revived tabs resume their own sessions after a real quit, with Windows PowerShell 5.1 as the terminal shell.
- Command: `cd $W && mkdir -p /c/p2e2e && PITWALL_E2E_ROOT='C:\p2e2e' env -u ELECTRON_RUN_AS_NODE -u VSCODE_ESM_ENTRYPOINT -u VSCODE_CRASH_REPORTER_PROCESS_TYPE npm run test:e2e 2>&1 | tail -15`
- Expected: last line `TERMINAL RESTORE E2E PASSED`, no line starting `FAIL `.
- If it fails → rerun with `PITWALL_TEST_KEEP=1` and read `log.jsonl` in the kept profile. `is not a valid statement separator` in a terminal means the shell branch is wrong. "did not complete" at stage 1 means the PID re-read is missing.

**Smoke 8: manifest duplicates are refused (Task 7)**
- What it proves: a harness fragment can no longer silently collide with core (2.8).
- Command: `cd $W && npm test -- manifest 2>&1 | grep -E "^ℹ fail"; node scripts/build-manifest.mjs --check`
- Expected: `ℹ fail 0`; `package.json is up to date (harnesses: claude).`
- If it fails → the test names the duplicate class. Check that `--root` reads the temp fragment directory, not the repo.

**Smoke 9: packaging is allowlisted, and CI enforces privacy (Task 8)**
- What it proves: a bare `vsce` from the real main checkout (which holds `.env` and `.packages/`) ships only allowlisted files, and CI fails a PR that tracks a private path.
- Command: `cd "/c/Users/Shari/Dropbox (Personal)/GenAI Company/Projects/pitwall" && git pull -q --ff-only && npx -y @vscode/vsce@3.2.1 ls | tr -d '\r' | sort > "$TEMP/p2-vsix.txt"; wc -l < "$TEMP/p2-vsix.txt"; unset VIRTUAL_ENV; poetry run python -m tools.check_vsix --from-file "$TEMP/p2-vsix.txt"`, then the probe in Task 8 Step 9.
- Expected: `41`; `OK: 41 packaged paths, all allowlisted`; probe run's `privacy` job `failure`, and main's `privacy` job `success`.
- If it fails → print `comm -13` of the expected list and `p2-vsix.txt`. Fix `files`, never the checker.

**Smoke 10: minors closed (Task 9)**
- What it proves: M1, M2, M3, M5 and row 2.5 are pinned by tests.
- Command: `cd $W && npm test -- architecture 2>&1 | grep -E "^ℹ fail"; npm test -- registry-safety 2>&1 | grep -E "^ℹ fail"; npm test -- storage 2>&1 | grep -E "^ℹ fail"; npm test -- manifest 2>&1 | grep -E "^ℹ fail"`
- Expected: `ℹ fail 0` four times.
- If it fails → the test name maps to one M-item in Task 9.

**Smoke 11: Electron-safe launches and settled reveals (Task 10)**
- What it proves: scripts launch the editor even from a shell that inherited `ELECTRON_RUN_AS_NODE=1` (2.4), and the reveal fix is in place.
- Command: `cd $W && ELECTRON_RUN_AS_NODE=1 bash scripts/cursor-cli.sh --version | head -1; ELECTRON_RUN_AS_NODE=1 npm run test:integration 2>&1 | grep -E "INTEGRATION RUN (COMPLETE|FAILED)"; npm test -- electron-env 2>&1 | grep -E "^ℹ fail"`
- Expected: a line matching `^3\.[0-9]+\.[0-9]+$` (Cursor's version, not Node's `v22…`); `INTEGRATION RUN COMPLETE`; `ℹ fail 0`.
- If it fails → `env | grep -E "ELECTRON|VSCODE_"` inside the script; a var that survived is missing from `ELECTRON_VARS`.

**Smoke 12: END-TO-END. The testing agent's live walk on Windows (Task 11)**
- What it proves: the fixed behaviour holds in real Cursor, in the testing agent's separate profile, on the merged main.
- Command (testing agent, never Sharif's Cursor): `cd $W && git switch --detach origin/main && npm ci --no-audit --no-fund >/dev/null && npm run compile && npx -y @vscode/vsce@3.2.1 package -o "dist/pitwall-$(git rev-parse --short HEAD).vsix" && bash scripts/cursor-cli.sh --user-data-dir "$LOCALAPPDATA/pitwall-uj/profile/user-data" --extensions-dir "$LOCALAPPDATA/pitwall-uj/profile/extensions" --install-extension "dist/pitwall-$(git rev-parse --short HEAD).vsix" --force && bash "$LOCALAPPDATA/pitwall-uj/harness/launch.sh" uj-lab-a`. Then walk these scenarios, pinning every CUA step to the printed test-Cursor pid:
  - **W1 worktree paths (triage 9–12):** Pitwall list → right-click `uj-lab-a` → Create Worktree → New branch → base `main` → name `uj/wt-p2`. Expect the row `⎇ uj/wt-p2` within 5 s. Its tooltip path starts `C:\Users\Shari\AppData\Local\pitwall-uj\lab\uj-lab-a-worktrees\uj-wt-p2`, and row `⎇ main` shows `●` with "Active workspace" in its tooltip. Then right-click `uj/wt-p2` → Delete Worktree → "Delete Worktree & Branch". Expect the row gone, `test -d "$LOCALAPPDATA/pitwall-uj/lab/uj-lab-a-worktrees/uj-wt-p2" || echo GONE` → `GONE`, and `git -C "$LOCALAPPDATA/pitwall-uj/lab/uj-lab-a" branch --list uj/wt-p2 | wc -l` → `0`.
  - **R1 quit/restore with a live chat (2.11):** click row "Lab ready" (session `7f3d3bef-3632-4027-99a7-42fba6529521`) and wait for the Claude banner in its terminal tab. Count terminal tabs (`T0`). Quit the test Cursor (File → Exit), relaunch with `launch.sh uj-lab-a`. Expect (a) the exthost log line `Extension activated success: sharifamlani.pitwall — <N>ms` with N < 3000; (b) within 15 s the revived tab shows Claude resumed (its prior "lab ready" turn visible) and the tab has no `is not a valid statement separator` text; (c) click row "Lab ready": terminal tab count stays `T0` and the revived tab is focused; (d) Developer: Reload Window: tab count still `T0`. (e) R33c: with a file open in front, start a new chat whose shell is slow, or watch the startup retitle. A momentary flash of the terminal tab is expected, but within 2 s the file is back in front with keyboard focus unchanged.
  - **R2 orphan on Remove (2.6):** "+" on `uj-lab-a` → New Claude Code Session (terminal), type nothing. Quit and relaunch as in R1. Then right-click that chat's row → Remove from Pitwall → confirm. Expect the terminal tab count to drop by exactly 1 within 3 s, and the row to be gone.
  - **R3 copied command (row 8 note):** right-click "Lab ready" → Copy Resume Command. Expect the clipboard to equal `Set-Location -LiteralPath '<uj-lab-a path>'; if ($?) { claude --resume 7f3d3bef-3632-4027-99a7-42fba6529521 }`. Paste it into a new PowerShell terminal in the test Cursor: Claude resumes, with no parse error.
  - **N1 full-path Claude command (2.13, F1):** in the test profile's user `settings.json`, set `"pitwall.harnessCommands.claude"` to a full path to the claude executable (`claude.exe`, or npm's `claude.cmd`): the first line of `where.exe claude | tr -d '\r' | grep -iE '\.(exe|cmd)$' | head -1`. Expect a non-empty path ending in `.exe` or `.cmd` before writing the setting (an empty value would test the default `claude` and prove nothing). Never the extensionless npm shim, which PowerShell cannot run. A quoted `.cmd` path is still the F1 case: it needs `&` just like an `.exe`. "+" on `uj-lab-a` → New Claude Code Session (terminal). Expect the Claude banner in the new tab within 15 s, and none of `Unexpected token`, `is not recognized`, `is not a valid statement separator` in that tab. Then remove the setting again.
  - **S1 needs you (2.14, F2):** click row "Lab ready" and, in its Claude terminal, ask Claude to run a shell command (e.g. `run git status`), so it stops at a permission prompt. Expect the row to show Pitwall's needs-you state (the inherited agents signal, ADR 0006) within 15 s, and `grep -cE "spawn .*claude.*(ENOENT|EINVAL)" <exthost.log>` → `0`. Answer the prompt (deny) afterwards.
  - **L1 log:** across the whole walk, `grep -cE "No tree item with id|TypeError|\[error\].*pitwall" <newest exthost.log>` → `0`.
- Expected: W1, R1(a–d), R2, R3, N1, S1 and L1 each PASS, with one capture per scenario in `$LOCALAPPDATA/pitwall-uj/captures/uj-p2-*.png` and the exthost log path in the report.
- If it fails → the testing agent sends the scenario id, the repro steps, the capture and the log lines to the lead, who routes them to the owning task (W1 → Task 1, R1–R3 and N1 → Task 6, S1 → Task 12, L1 → Task 10).

**Ground truth after Smoke 12** (system-says-pass ≠ correct): `git ls-remote --tags origin v0.3.0 'v0.3.0^{}'` shows an annotated tag that peels to the close commit. `gh run list -R sharifamlani/pitwall --branch main --limit 1 --json headSha,conclusion` returns that sha with `success`. `gh run view <id> --json jobs --jq '.jobs[]|[.name,.conclusion]|@tsv'` lists `ubuntu success`, `windows success` and `privacy success`. In the windows job log, `ℹ fail 0` appears.

## 5. Evaluation criteria (definition of done; graded by an independent evaluator sub-agent on a fresh clone)

N for flaky tests = **100 runs, 4 parallel workers.** Why 100: R9 measured about 7/60 (11.7 %) failures for one of these tests. If that rate survived, 100 straight passes has probability 0.883^100 ≈ 4·10⁻⁶. 100 clean runs also bounds the remaining failure rate below 3 % at 95 % confidence (rule of three, 3/N), which is below one chance red per ~30 CI runs. 300 runs (a 1 % bound) would cost about 45 min per test per platform for little extra signal. Four workers reproduce the "under load" condition the flakes were seen in.

| # | Criterion | Metric + threshold | How measured | Evidence |
|---|---|---|---|---|
| E1 | Windows suite green, skips explained | Windows `npm test`: `ℹ fail 0`; `ℹ skipped` = number of `﹣` skip lines (Global Constraints, "Counting skips"); every skip line has a non-empty reason after ` # `; the skipped set equals the triage doc's rows marked `skip (reason)` in "Phase 2 resolution" (row 26 plus Task 4's dormant-harness skips) | fresh clone on this machine: `npm ci && npm test > log`; `grep -E "^ *﹣ " log` vs `docs/windows-test-triage.md` | log summary + SKIP list in scorecard |
| E2 | Linux suite green | `ℹ fail 0`, `ℹ skipped 0`, `ℹ tests` ≥ 192 + tests added in Tasks 1–10 | `bash scripts/run-linux-tests.sh` on the fresh clone | `ℹ` lines |
| E3 | CI windows job runs the full suite | `ci.yml` windows job has a step `run: npm test` with no filter argument; the close commit's run shows windows `success`, its log has `ℹ fail 0` and the same `ℹ tests` count as E1 | `gh run view <id> --log --job <windows-job-id> \| grep -E "ℹ (tests\|fail)"` | run id + lines |
| E4 | Each real bug has a test that failed before the fix | For triage row 2 and rows 9–12 (and any bug Task 4 surfaced): the PR's red commit (sha in the PR body) shows the named test `✖` on Windows (row 2 test `✖` on any platform). The same test is `✔` at the close commit | `git checkout <red-sha> && PITWALL_TEST_NAME_PATTERN="<name>" npm test -- <file>`; repeat at close | red sha, ✖ line, ✔ line per bug |
| E5 | Flaky tests are stable | Each of `stopping an opencode snapshot ends the session listing and unblocks preparation`, `the opencode snapshot stops at its byte budget and says so`, `server errors keep their JSON-RPC code, and a hung request times out`, `stopping a search ends the agent and everything it started, and keeps nothing`: `RUNS 100 PASS 100 FAIL 0` on Linux (container), and on Windows unless skipped there with a reason | Smoke 5 commands | 5–8 `RUNS` lines |
| E6 | Packaging allowlisted by construction | `package.json` `files` = the 8 globs in Task 8; `.vscodeignore` absent; `vsce ls` from Sharif's main checkout (with `.env`, `.packages/` present) lists exactly 41 paths (package.json, README.md, LICENSE, CHANGELOG.md, THIRD_PARTY_NOTICES.md, out/extension.js, 3 icons, 32 harness SVGs), all accepted by `tools.check_vsix`, 0 `.map`. Runs in Sharif's main checkout, not the fresh clone, and needs `out/extension.js` there (`npm run compile` first if it is missing, or the count is 40) | Smoke 9 first command | count + OK line |
| E7 | CI privacy gate | `ci.yml` has a `privacy` job running `tools.check_private_paths`, gitleaks `v8.21.2` with `fetch-depth: 0`, the Python tests and `tools.check_vsix`; it is `success` on the close commit, and its log has `<N> commits scanned` with N ≥ the clone's `git rev-list --count --no-merges HEAD` (R26), and its `check_vsix` step prints `OK: 41 packaged paths, all allowlisted`; the probe PR's `privacy` job is `failure` at the path-gate step | `gh run view` on both runs | run ids + step conclusions |
| E8 | Manifest refuses duplicates | Tests pass for each class: duplicate command, submenu, view, viewsContainer, setting key (incl. across differently titled sections), keybinding `(key, mac, when)`; untitled sections matched by identity; enum default not in enum; unequal enum arrays. Each exits 2 naming the offending fragment path; `--check` exit 0 on main | `npm test -- manifest`; `node scripts/build-manifest.mjs --check` | test lines |
| E9 | Restore bugs fixed (2.6, 2.11); full-path launch fixed (2.13) | Task 6 dry tests pass, including Step 8b's; e2e `TERMINAL RESTORE E2E PASSED` on Windows; testing agent R1(a–d), R2 and N1 PASS | Smokes 6, 7, 12 | ✔ lines, e2e line, UJ report |
| E10 | Worktree paths fixed live (rows 9–12) | testing agent W1 PASS (row appears, `●` + "Active workspace", delete leaves `GONE` and 0 branches) | Smoke 12 W1 | UJ report + capture |
| E11 | Electron-safe launches (2.4) | `electron-env` test passes; `ELECTRON_RUN_AS_NODE=1 bash scripts/cursor-cli.sh --version` first line matches `^3\.\d+\.\d+$`; integration run from that shell prints `INTEGRATION RUN COMPLETE` | Smoke 11 | outputs |
| E12 | Minors and 2.5 closed | Tests named in Task 9 Steps 1–5 and Task 10 Step 4 pass; testing agent L1 count = 0; Phase 1 plan tree no longer shows `docs/upstream/`, and its E8 evidence cell names `phase1-scorecard.md` | `npm test`; Smoke 12 L1; `grep -c "docs/upstream/" docs/superpowers/plans/2026-11-16-phase1-import-agntree.md` → 0, and `sed -n '/^## 1\./,/^## 2\./p' docs/superpowers/plans/2026-11-16-phase1-import-agntree.md | grep -c "upstream/ "` → 0 | lines |
| E13 | Verify + CI green on the close commit | `bash scripts/verify.sh` exit 0 on this machine; ubuntu, windows and privacy jobs `success` for the close sha | run + `gh run view` | outputs |
| E14 | ROADMAP + release | Rows 2.1–2.14 ✅ each with PR + merge sha; §0 → Phase 3 (Sidebar v1); §6 entry and stamp at the next ROADMAP version after the one current at close (v0.17 today, so ≥ v0.18); `package.json` 0.3.0; `CHANGELOG.md` 0.3.0; annotated tag `v0.3.0` on origin peels to the close commit; triage doc has 29 rows each with a "Phase 2 resolution" | grep + `git ls-remote --tags origin v0.3.0 'v0.3.0^{}'` + `git cat-file -t v0.3.0` → `tag` | outputs |
| E15 | Claude agents poll runs on Windows (2.14, finding F2) | Task 12 tests pass on Windows (regression guards per R31: no red sha; the PR shows them `✖` with the `harnessInvocation` wrapper removed); testing agent S1 PASS (needs-you within 15 s, 0 `spawn … claude … ENOENT/EINVAL` log lines) | `PITWALL_TEST_NAME_PATTERN="real claude CLI" npm test -- claude-agents` at close, plus the PR #16 ✖ evidence with `harnessInvocation` removed (R31: no red sha); Smoke 12 S1 | ✖/✔ lines, UJ report |

Smoke → criterion map: S0→E1 baseline · S1→E4/E10 · S2→E4 · S3, S4→E1 · S5→E5 · S6, S7→E9 · S8→E8 · S9→E6/E7 · S10→E12 · S11→E11 · S12→E9/E10/E12/E15 · ground truth→E3/E13/E14.

## 6. Implementation tasks

Every task begins with:
```bash
cd /c/Users/Shari/pitwall-build && git fetch -q origin && git switch -c phase2/task-N-<slug> origin/main && npm ci --no-audit --no-fund
```
**Red-commit rule.** `test/dry/run.js:50-64` bundles every test file before any test runs, and one bundle error aborts the whole run with no `✖` and no `ℹ` lines. So a red commit that imports something not yet written also adds a minimal stub for it, e.g. `export function samePath(_a: string, _b: string): boolean { throw new Error('not implemented'); }`. The run then compiles and the new tests fail as assertions. Python works the same way: a stub module whose functions raise `NotImplementedError`, so pytest collects and fails instead of erroring. The green commit replaces the stubs.

Every task ends the same way: the full Windows suite and the Linux suite, each summary pasted into the PR body; push; `gh pr create -R sharifamlani/pitwall --base main`, with a body that lists the red sha, the `✖`/`✔` lines, the ROADMAP rows closed and the triage rows resolved; then QA. These closing steps are not repeated below.

```bash
npm test > "$TEMP/pN-win.log" 2>&1; grep -E "^ℹ (tests|pass|fail|skipped)" "$TEMP/pN-win.log"
bash scripts/run-linux-tests.sh 2>&1 | grep -E "^ℹ (tests|pass|fail|skipped)"
git push -u origin HEAD
```

Waves (independent work runs in parallel; QA tests every open PR merged together): **A** = Tasks 1, 2, 7, 8 · **B** = Tasks 3, 6, 9, 10 (after 1 merges: support.ts) · **C** = Task 4 · **D** = Tasks 5, 12 · **E** = Task 11.

### Task 1: Worktree paths: one native spelling, one comparison (`phase2/task-1-worktree-paths`)

**Closes:** ROADMAP 2.1 (triage rows 9, 10, 11, 12). **Files:**
- Modify: `src/core/utils/paths.ts`, `src/core/services/GitService.ts:130-171,568`, `src/core/providers/WorkspacesTreeProvider.ts:262,411`, `src/core/services/SessionImportService.ts:407,525`, `src/extension.ts:207`, `test/dry/support.ts` (`tempDir`), `test/dry/run.js`
- Test: `test/dry/core/git.test.ts`, `test/dry/core/helpers.test.ts`, `test/dry/core/tree.test.ts`; existing `test/dry/core/worktree-commands.test.ts:50,67,87,99` become green

**Interfaces — Produces:**
- `nativePath(value: string): string` in `src/core/utils/paths.ts`: `path.normalize(value)` (on win32 `C:/a/b` → `C:\a\b`).
- `samePath(a: string, b: string): boolean` in `src/core/utils/paths.ts`. On win32: `fs.realpathSync.native(x)` (falling back to `path.resolve(x)` when the path is missing), lowercased, compared. Elsewhere: `canonicalPath(a) === canonicalPath(b)`.
- `export function worktreeId(repoId: string, worktreePath: string): string` (now exported from `GitService.ts`; formula unchanged, so ids already stored stay valid).
- `test/dry/run.js` forwards `PITWALL_TEST_NAME_PATTERN` as `--test-name-pattern=<value>` when set. Later tasks use it.

- [ ] **Step 1: Write the failing tests**
  - `git.test.ts`: `test('worktree paths from git use native separators and keep their ids', …)`. Build `makeRepo` plus `git worktree add -q -b linked <scratch>/linked`. Assert `service.listWorktrees(root, 'repo-1').map(w => w.path)` deep-equals `[root, path.join(scratch, 'linked')]`. Assert every `w.path === path.normalize(w.path)`. Assert `worktreeId('repo-1', root.replace(/\\/g, '/')) === worktreeId('repo-1', root)`.
  - `helpers.test.ts`: `test('samePath matches one folder however the editor or git spells it', …)` with `dir = tempDir(t)`. On win32: `samePath(dir[0].toLowerCase() + dir.slice(1), dir.replace(/\\/g, '/'))` is `true`. On other platforms: `samePath(dir, dir + '/')` is `true` and `samePath(dir, dir.toUpperCase())` is `false`. Both: `samePath(dir, path.join(dir, 'x'))` is `false`. One test, a platform branch, no skip.
  - `tree.test.ts`: `test('the window\'s own worktree is marked active whatever case the editor gives its drive letter', …)`. A git repo row with `stub.workspace.workspaceFolders = [{ uri: { fsPath: lowerDrive(repoPath) } }]`, where `lowerDrive = (p) => process.platform === 'win32' ? p[0].toLowerCase() + p.slice(1) : p`. The main worktree row's `description` contains `●` and its `tooltip` contains `Active workspace`.
  - `run.js`: forward `PITWALL_TEST_NAME_PATTERN`.
- [ ] **Step 2: Run to verify they fail (Windows)**
  Run: `PITWALL_TEST_NAME_PATTERN="native separators|samePath|marked active" npm test -- core/ 2>&1 | grep -E "^(✖|ℹ fail)"`
  Expected: `✖ worktree paths from git use native separators and keep their ids`, `✖ samePath matches…` (its stub throws `not implemented`), `✖ the window's own worktree is marked active…`. The red commit carries the stubs `nativePath` and `samePath` (red-commit rule) and adds `export` to `worktreeId` (no behaviour change). Commit `test: worktree paths match on Windows (fails)` and record its sha as the red sha.
- [ ] **Step 3: Implement** `nativePath`, `samePath`, export `worktreeId`. In `parseWorktrees`, apply `nativePath()` to the porcelain path before it is used for `path`, `name` and `isMain` (the `id` formula stays as it is). Replace the five raw comparisons with `samePath` (`:262` guards an undefined `currentFolder`; `extension.ts:207` compares only when `folders[0]` exists). `tempDir()` → `fs.realpathSync.native(fs.mkdtempSync(...))`.
- [ ] **Step 4: Run to verify they pass**
  Run: Smoke 1 commands. Expected: `ℹ fail 0` twice; `npm test -- worktree-commands` shows `✔` for the four row-9–12 tests.
- [ ] **Step 5: Commit** `fix: compare worktree paths through samePath; git paths are native` and run the closing block. Windows expectation: `ℹ fail` = main's count at branch time − 4 (8 if Task 2 has not merged, 7 if it has; say which in the PR), `ℹ skipped 17`.

### Task 2: A pending chat's TTL holds across an in-flight check (`phase2/task-2-pending-ttl`)

**Closes:** ROADMAP 2.1 (triage row 2). **Files:**
- Modify: `src/core/harness/kit/ExactIdSessionWatcher.ts` (`checkPending`, `:200-213`)
- Test: `test/dry/shared/exact-id-watcher.test.ts`; existing `test/dry/harnesses/claude/claude-watcher.test.ts:84` becomes green

**Interfaces — Consumes:** the gated `ExactIdSessionSource` already in `exact-id-watcher.test.ts` (`setup()` returns `blocked`, `release`). **Produces:** no API change.

- [ ] **Step 1: Root cause first** (superpowers:systematic-debugging). On Windows, add temporary `console.log`s in `checkPending` and `pendingChats` and run `PITWALL_TEST_NAME_PATTERN="stops waiting after the TTL" npm test -- claude-watcher`. Record in the PR which pass links `00000005-…` and its `window.since` vs `Date.now()`. Expected hypothesis: the pass started by the first `registerPendingChat` took its snapshot before the fake clock moved, awaited `isResumable`, and linked after the TTL. If the log shows a different cause, stop and report to the lead before Step 3.
- [ ] **Step 2: Write the failing test** `test('an abandoned chat whose TTL ends during a resumability check is not linked', …)`. Create a chat with `status: 'idle'` and `pendingHarnessSessionId: 'first'` (the gated id), fake `Date.now` (restore it in `t.after`), and call `watcher.registerPendingChat(chat.id, '/wt')`. `await blocked`, set `now += 5 * 60_000 + 1`, then `release()`. Register a second chat with pending id `'second'` and `await waitFor(() => storage.getChat(second.id)?.harnessSessionId, 'the barrier chat to link')`. Assert `storage.getChat(chat.id)!.harnessSessionId === null`.
  Run: `PITWALL_TEST_NAME_PATTERN="TTL ends during" npm test -- exact-id-watcher`. Expected: `✖` on every platform. Commit `test: TTL holds across an in-flight check (fails)`; this is the red sha.
- [ ] **Step 3: Implement.** In `checkPending`, immediately before `this.linkSession(...)`, re-read `this.storageService.getChat(chat.id)`. If it is not `'active'` and `Date.now() - (this.pending.get(chat.id)?.since ?? 0) >= PENDING_TTL_MS`, delete it from `this.pending` and `continue` (without counting it as linked).
- [ ] **Step 4: Run** Smoke 2. Expected: `ℹ fail 0` twice.
- [ ] **Step 5: Commit** `fix: never link an abandoned chat after its TTL, even mid-check`. Closing block. Windows: one fewer failure than main at that time.

### Task 3: POSIX-assumption tests made portable (`phase2/task-3-portable-tests`)

**Closes:** ROADMAP 2.2 (triage rows 1, 3, 4, 5, 6, 7; row 26 keeps its existing reason `counts open files in /proc`). Depends on Task 1 (support.ts). **Files:**
- Modify: `test/dry/support.ts` (+`dirLink`), `test/dry/harnesses/claude/claude-scoping.test.ts:54-75`, `test/dry/core/files.test.ts:31`, `test/dry/core/git.test.ts:14-25,128-138`, `test/dry/harnesses/pi/pi.test.ts:158-185`

**Interfaces — Produces:** `dirLink(target: string, link: string): void` in `support.ts`: `fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')`. Junctions need no Developer Mode, and `fs.realpathSync` resolves them.

- [ ] **Step 1: Confirm the failures** on Windows: `for f in claude-scoping files.test git.test pi.test; do npm test -- $f 2>&1 | grep "^✖"; done`. Expected `✖` names: triage rows 1, 3, 4, 5, 6, 7.
- [ ] **Step 2: Decide the product rule for row 3** (no product change): tooltips show the platform's separator, as Cursor's own explorer does (D29). The assertion becomes `assert.equal(nested.tooltip, path.join('src', 'a.ts'), …)`.
- [ ] **Step 3: Make each test portable:**
  - row 1: both `fs.symlinkSync(..., 'dir')` calls → `dirLink(...)`.
  - rows 4–5: in `makeRepo`, `git(root, 'config', 'core.autocrlf', 'false')` right after `init` (before the first `add`).
  - row 6: `const quotedName = process.platform === 'win32' ? [] : ['notes "draft".txt'];` create the file only when the list is non-empty, and expect `untracked: ['build output/', ...quotedName]` (NTFS forbids `"`). Keep a space-containing name.
  - row 7: expected strings use `quoteShellArgument(source)` / `quoteShellArgument(subSource)` from `src/core/harness/cli` (the product's own POSIX rule; Pi is dormant).
- [ ] **Step 4: Run** Smoke 3. Expected as written there.
- [ ] **Step 5: Commit** `test: make POSIX-assumption tests portable (junctions, LF fixtures, native tooltips)`. Closing block. Linux must stay `ℹ fail 0`, `ℹ skipped 0`.

### Task 4: Fake CLIs that run on Windows (`phase2/task-4-windows-fake-clis`)

**Closes:** ROADMAP 2.2 (triage rows 13–25, 27–29). Also 2.1 for any Claude-path bug this exposes. Depends on Task 3. **Files:**
- Modify: `test/dry/support.ts` (`fakeCli`, remove `posixOnly`, add `skipOnWindows`), `test/dry/harnesses/opencode/opencode.test.ts`, `test/dry/shared/session-search{,-sources,-runners}.test.ts`
- Create: `test/dry/shared/fake-cli.test.ts`

**Interfaces — Produces:**
- `fakeCli(dir, name, fixture, env): string`. POSIX is unchanged. On win32 it writes `<dir>\<name>.cmd` with CRLF lines: `@echo off`, then one `set "KEY=value"` per env entry, then `"<process.execPath>" "<fixture>" %*`. It returns that `.cmd` path, and throws if any env value contains `"`, `%`, `\r` or `\n`.
- `skipOnWindows(reason: string): { skip: string | false }`, which replaces `posixOnly`. `posixOnly` is deleted, so no test is skipped without its own reason.

- [ ] **Step 1: Write the failing test** `fake-cli.test.ts`: `test('a fake CLI runs its fixture with its environment and arguments on this platform', …)`. Write a temp fixture `echo.js` that prints `JSON.stringify({ args: process.argv.slice(2), v: process.env.FAKE_V })`, and `cli = fakeCli(dir, 'echo', fixture, { FAKE_V: 'a b' })`. Run it with `const inv = harnessInvocation(cli, ['x y', 'z']); spawnSync(inv.command, inv.args, { shell: inv.shell, encoding: 'utf8' })`. Assert the parsed stdout is `{ args: ['x y', 'z'], v: 'a b' }`. Run: `npm test -- fake-cli`. Expected on Windows: `✖` (the `#!/bin/sh` file cannot run). Commit as the red sha.
- [ ] **Step 2: Implement** the win32 branch of `fakeCli`. Run `npm test -- fake-cli` → `ℹ fail 0` on Windows and Linux.
- [ ] **Step 3: Remove `posixOnly`** from all 16 tests listed for rows 13–25 and 27–29 (row 26 keeps its `/proc` skip).
- [ ] **Step 4: Run** `npm test > "$TEMP/p4.log" 2>&1; grep "^✖" "$TEMP/p4.log"` on Windows.
- [ ] **Step 5: Process-tree check.** Row 24 (`stopping a search ends the agent and everything it started`) exercises `stopProcessTree`'s `taskkill /T /F` branch (`src/core/harness/cli.ts:307`). It must pass on Windows, or be handled by Step 6(a).
- [ ] **Step 6: Classify every remaining `✖`** (write the table in the PR):
  - (a) the failure is in `src/core/**` or `src/harnesses/claude/**` → **real bug, ROADMAP 2.1**. The failing test is the red test; fix it in this PR. If the fix is more than ~50 changed lines or changes behaviour beyond a win32 branch, stop and send the lead the test name and the error. The lead rules (a separate task, or a new ROADMAP row).
  - (b) the failure is only in a dormant harness's code (`src/harnesses/{codex,opencode,pi}/**`, D9) → `skipOnWindows('dormant <id> harness: <one-line cause>; revisit when <id> is enabled (D9)')`.
  - (c) the failure is in the fixture or test only → fix the test.
- [ ] **Step 7: Run** Smoke 4. Expected as written there.
- [ ] **Step 8: Commit** `test: Windows fake CLIs; every skip states its reason` (plus `fix: …` commits for (a)). Closing block.

### Task 5: De-flake the four flaky tests (`phase2/task-5-deflake`)

**Closes:** ROADMAP 2.7. Depends on Task 4 (same test files). **Files:**
- Create: `scripts/repeat-tests.sh`
- Modify: `test/dry/run.js` (`PITWALL_TEST_BUILD_DIR`), `scripts/run-linux-tests.sh` (optional command), `.gitignore` (`test/dry/.build-*/`), `test/dry/shared/session-search-sources.test.ts:165-252`, `test/dry/harnesses/codex/codex-app-server.test.ts:44-52`, `test/dry/shared/session-search.test.ts:184` (and its fake CLI fixture), and the product only if Step 3 proves a product race

**Interfaces — Produces:**
- `bash scripts/repeat-tests.sh <file-filter> <runs> [--parallel P] [--name <pattern>]`. P workers, each with its own build dir `PITWALL_TEST_BUILD_DIR=test/dry/.build-<worker>`, run `PITWALL_TEST_NAME_PATTERN=<pattern> node test/dry/run.js <file-filter>` until `<runs>` runs are done in total. It prints `RUNS n PASS p FAIL f` (or `SKIPPED` when every run reported only skips) and the log path of each failed run, and exits 1 when f > 0. It classifies only test-level `✔`/`✖`/`﹣` lines, never node's file-level `<file>.cjs (<n>ms)` line. A run that exits 0 with no test-level line is NOMATCH: then it prints `RUNS n NOMATCH (pattern matched no test)` and exits 2 (QA PR #17).
- `test/dry/run.js` reads `PITWALL_TEST_BUILD_DIR` (default `test/dry/.build`). It exits 2 if the directory's parent is not `test/dry/`: bundles locate fixtures and the repo root through `path.resolve(__dirname, '..', …)` (12 uses in `test/dry`), so a `mktemp -d` directory would make `..` the temp root and fail with ENOENT. Parallel runs no longer delete each other's bundles.
- `bash scripts/run-linux-tests.sh [command]` runs `command` in place of `npm test` after `npm ci` in the container. The command goes in as a positional argument, never pasted inside the single-quoted script, so commands containing single quotes survive: `docker run -i --rm pitwall-dev sh -c 'mkdir -p /tmp/w && tar -xf - -C /tmp/w && cd /tmp/w && npm ci --no-audit --no-fund && eval "$1"' _ "${1:-npm test}"`.

- [ ] **Step 1: Write the script and the two run.js/run-linux-tests.sh options.** Checks: `bash scripts/repeat-tests.sh helpers 4 --parallel 2` → `RUNS 4 PASS 4 FAIL 0`; `bash scripts/repeat-tests.sh codex-app-server 2 --name zzz-no-such-test` → exit 2 and `RUNS 2 NOMATCH (pattern matched no test)`. Then Smoke 5's exact Linux line with 2 runs in place of 100: `bash scripts/run-linux-tests.sh "bash scripts/repeat-tests.sh session-search-sources 2 --parallel 2 --name 'stopping an opencode snapshot|byte budget' && bash scripts/repeat-tests.sh codex-app-server 2 --parallel 2 --name 'hung request'"` → two `RUNS 2 …` lines, and no `ENOENT` in any kept log. This proves the quoting and that the worker build dirs still find the fixtures.
- [ ] **Step 2: Measure the baseline (the failing "test" for this task).** *Linux:* `bash scripts/run-linux-tests.sh "bash scripts/repeat-tests.sh session-search-sources 60 --parallel 4 --name 'byte budget'"` and the same for `'stopping an opencode snapshot'` and for `codex-app-server` with `'hung request'`, and for `shared/session-search.test` with `'stopping a search ends the agent'`. Record the four `RUNS` lines in the PR. At least one should show `FAIL ≥ 1` (R9: 7/60). If none fails in 60 runs, raise to 200 runs before claiming no baseline.
- [ ] **Step 3: Root-cause each test** (systematic-debugging, on the kept log of a failing run). Starting hypotheses:
  - byte budget: under load, the snapshot's default time budget expires before the first file is written, so `files.length > 0` fails. Fix: pass `{ maxBytes: 500, budgetMs: 60_000 }`, so only the byte budget can stop it.
  - stopping a snapshot: `waitFor(... 'the listing process to stop')` uses the 2 s default while the fake opencode is killed through a process tree. Fix: `waitFor(..., 15_000)`, a condition poll and not a sleep.
  - hung request: the 200 ms per-request timeout can expire while the server process is still starting under load, so the error arrives on a different request. Fix: warm the server first (`await server.request('test/echo', { n: 0 })`) before the timeout assertion.
  - stopping a search (added after wave A; QA saw it on Linux as `SyntaxError: Unexpected end of JSON input`, and two implementers saw an unnamed `fail 1` that matches it): a JSON file is read while it is still being written, either by the fake CLI fixture or by the product's search-result write. Fix: make that writer atomic (write a temp file in the same folder, then rename). If the writer is product code, first add a failing test where a reader races the writer. On Windows this is triage row 24, skipped until Task 4; its Windows proof comes after Task 4 unskips it.
  - If the log points elsewhere, fix that cause. A product change needs its own failing test first.
- [ ] **Step 4: Run** Smoke 5 (100 runs × 4 tests × 2 platforms). Expected: `RUNS 100 PASS 100 FAIL 0` each (or `SKIPPED` on Windows for a Task 4 skip).
- [ ] **Step 5: Commit** `test: de-flake opencode snapshot, codex timeout and search-stop tests (100/100 under load)`. Closing block.

### Task 6: Restore after a quit, and a resume line every shell can run (`phase2/task-6-restore`)

**Closes:** ROADMAP 2.11 and 2.6; triage row 8 (and its `&&` note). Depends on Task 1. **Files:**
- Modify: `src/core/services/terminalEvents.ts:42-44,74-79`, `src/core/services/TerminalManager.ts:429-431,575-667,674-713,723-840`, `src/core/commands/chat.ts:887`, `src/core/commands/sessionSearch.ts:321`, `test/dry/vscode-stub.js`, `test/e2e/terminal-restore/run.js:192-216`
- Test: create `test/dry/core/terminal-events.test.ts`; modify `test/dry/core/terminal.test.ts`, `test/dry/core/session-search-commands.test.ts:113-125`, `test/dry/core/chat-commands.test.ts` (copy resume)

**Interfaces — Produces:**
- `type ShellKind = 'posix' | 'powershell' | 'cmd'` and `shellKind(shellPath: string | undefined): ShellKind` in `terminalEvents.ts`. It takes `path.win32.basename(shellPath).toLowerCase()`: `powershell.exe`, `powershell`, `pwsh.exe` and `pwsh` → `powershell`; `cmd.exe` and `cmd` → `cmd`; anything else → `posix`. Empty or undefined → `powershell` on win32, `posix` elsewhere.
- `commandInDirectory(directory: string, command: string, shellPath: string | undefined = vscode.env.shell): string`:
  - posix: `cd ${quoteShellArgument(directory)} && ${command}` (unchanged)
  - powershell: `Set-Location -LiteralPath '${directory.replace(/'/g, "''")}'; if ($?) { ${cmd} }`, where `cmd` = `& ${command}` when `command` starts with `'` or `"`, else `command`
  - cmd: `cd /d "${directory}" && ${command}`
- `readProcessId(terminal, timeoutMs = PROCESS_ID_TIMEOUT_MS)`.
- Stub: `vscode.env.shell` (default `'/bin/bash'`) and `__setShell(path)` (reset by `__reset`). `createTerminal({ __pidDelayMs })` makes `processId` resolve after that many ms; `Infinity` means it never resolves. Each stub terminal counts reads of its `processId` getter in `__pidReads`.

- [ ] **Step 1: Write the failing tests**
  - `terminal-events.test.ts`: `test('commandInDirectory builds a line each shell can run', …)` with these exact cases:
    `('/w s', 'claude --resume s1', '/bin/bash')` → `cd '/w s' && claude --resume s1`;
    `('C:\\Users\\o\'brien\\repo', 'claude --resume s1', 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')` → `Set-Location -LiteralPath 'C:\\Users\\o''brien\\repo'; if ($?) { claude --resume s1 }`;
    `('C:\\repo', 'claude --resume s1', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')` → `Set-Location -LiteralPath 'C:\\repo'; if ($?) { claude --resume s1 }`;
    `('C:\\repo', "'C:\\x\\claude.cmd' --resume s1", 'powershell.exe')` → `Set-Location -LiteralPath 'C:\\repo'; if ($?) { & 'C:\\x\\claude.cmd' --resume s1 }`;
    `('C:\\repo', 'claude --resume s1', 'C:\\WINDOWS\\system32\\cmd.exe')` → `cd /d "C:\\repo" && claude --resume s1`.
  - `terminal.test.ts`: `test('after a quit, activation waits at most one PID timeout however many revived tabs never report a PID', …)`. Two revived tabs with `__pidDelayMs: Infinity`, titled for two chats with recorded PIDs. `await manager.beginRestoreSync(getWt).adopted;` then assert `tabs.map(t => t.__pidReads)` deep-equals `[1, 1]`: each tab's PID was awaited once, in the shared parallel read. Today the adoption loop reads again, which gives 2 + 1 waits (≈ 6 s). No wall-clock assertion.
  - `terminal.test.ts`: `test('a revived tab whose PID arrives late is still resumed in the background, and a click focuses it', …)`. One revived tab with `__pidDelayMs: 2_500` for a linked chat `s1`. After `await restore.complete`: `terminal.sent` deep-equals `[\`cd ${quoteShellArgument(wt)} && claude --resume s1\`]`, and `manager.isActive(chat.id)` is `true`. Then `await manager.openChat(chat, worktree)` leaves `stub.window.terminals.length` unchanged.
  - `terminal.test.ts`: `test('Remove closes a restored tab Pitwall could not resume, and only that tab', …)`. A revived tab for an unlinked fork chat (restore skips it), plus an unrelated tab with another chat's short id. `manager.closeChat(forkChat.id)` → the fork's tab has `disposed === true` and the other tab stays `false`. Tabs whose short id is ambiguous are never disposed.
  - `session-search-commands.test.ts:113`: keep the bash expectation as `cd ${quoteShellArgument(outside)} && claude --resume s2`. Add `stub.__setShell('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')`, copy again, and expect `Set-Location -LiteralPath '${outside.replace(/'/g, "''")}'; if ($?) { claude --resume s2 }`. Make the same pair of assertions for `pitwall.copyResumeCommand` in `chat-commands.test.ts`.
- [ ] **Step 2: Run to verify they fail.** `npm test -- terminal 2>&1 | grep "^✖"` and `npm test -- session-search-commands 2>&1 | grep "^✖"`. Expected: all five new or changed tests `✖`. Commit as the red sha.
- [ ] **Step 3: Implement (b) activation.** In `beginRestoreSync`'s adoption loop, a terminal whose PID the parallel read already tried (`pids.has(terminal)`) is never read again. `adoptRestoredTerminal` re-reads only when it is called from `onDidOpenTerminal` (no known PID).
- [ ] **Step 4: Implement (c) late PID.** In `resumeRevivedTerminals`, collect the title-matched tabs (recorded PID exists, harness enabled, not an unlinked fork) whose PID is still `undefined`. Put each in `restoringChats` first, so a click focuses it, then read their PIDs in parallel with `readProcessId(terminal, RESTORED_SHELL_TIMEOUT_MS)`. Judge them as candidates, and release from `restoringChats` any that do not become candidates.
- [ ] **Step 5: Implement (d) orphan close.** `closeChat(chatId)` disposes the mapped terminal. If there is none, it disposes every live terminal not in `terminalToChatId` whose `titleShortId(name) === chatId.substring(0, 6)`, provided no other stored chat shares that short id.
- [ ] **Step 6: Implement (e) resume line.** `shellKind`, the new `commandInDirectory`, and switch `chat.ts:887` and `sessionSearch.ts:321` to it. One comment line at the `vscode.env.shell` default: a revived tab keeps the shell it was created with, and this uses the current default profile because Pitwall creates its tabs with it (a default changed between sessions is out of scope for v1).
- [ ] **Step 7: e2e on Windows.** In `test/e2e/terminal-restore/run.js` `writeFakeCommand`, on win32: return the bare name `fake-claude` and prepend `root` to `PATH` in the launch `env`. Comment: the bare name keeps this e2e about restore alone; the quoted full-path case (finding F1) is covered by Step 8b's dry test and Smoke 12 N1. Run Smoke 7.
- [ ] **Step 8: Run** Smoke 6. Expected as written there.
- [ ] **Step 8b (F1, ROADMAP 2.13, lead ruling R20):** new-chat launches with a custom full-path Claude command must also run in PowerShell. When the target shell is PowerShell and the command is a quoted path, prefix the call operator `& `; cmd.exe and bash keep today's form. TDD: a dry test builds the launch line for `C:\Program Files\Claude\claude.exe` with a PowerShell shell and asserts it starts with `& '`. Watch it fail first, then implement. The live check is in Smoke 12 (the testing agent sets `pitwall.harnessCommands.claude` to the full path of `claude.exe` in its own profile and starts a new chat).
- [ ] **Step 8c (lead rulings from the build, R29–R33):**
  - R29: a PID or shell-integration report that arrives after the short wait is still recorded in the background; no wait is raised.
  - R32: a revived tab is resumed after its shell reports integration, in the background, with a cap after which the line is still sent; integration off → sent at once. (Revived tabs report integration restored from the previous session, so this is a no-op for them.)
  - R33a: Cursor can echo a stale copy of `globalState` back over a newer write. `StorageService` keeps an in-memory copy of the PID records this window wrote or removed and merges it into every read and write of that key, so neither a record nor a removal is lost.
  - R33b: the revived-tab retitle runs when the command actually starts, even after its 10 s bound, in the background.
  - R33c: the editor can rename only the active terminal, and deferring until the user visits the tab would lose restore. So a background retitle briefly activates the tab (no keyboard focus), then immediately re-shows what the user had in front (the previous terminal, else the text editor with `preserveFocus`). This is a deliberate, momentary behaviour change.
- [ ] **Step 9: Commit** `fix: resume revived tabs on Windows (one PID wait, late PIDs, shell-aware resume line); Remove closes orphaned tabs`. Closing block. Message the testing agent for R1–R3 on the merged sha.

### Task 7: Manifest builder refuses duplicates (`phase2/task-7-manifest-uniqueness`)

**Closes:** ROADMAP 2.8 (final review I2) and 2.12 (M4). **Files:**
- Modify: `scripts/build-manifest.mjs:36-57,71-160`
- Test: `test/dry/core/manifest.test.ts`

**Interfaces — Produces:** `node scripts/build-manifest.mjs --root <dir> [--enabled …] [--out …] [--check]` reads `<dir>/manifest/core.contributes.json` and `<dir>/src/harnesses/<id>/contributes.json` (default root = repo). On a duplicate it exits 2 with a stderr line of the exact form `build-manifest: duplicate <kind> "<key>" in <relative fragment path> (already declared by <relative path>)`. `<kind>` is one of `command`, `submenu`, `view`, `viewsContainer`, `setting`, `keybinding`; a keybinding key is `<key>|<mac>|<when>`.

- [ ] **Step 1: Write the failing tests.** Add a helper `fixtureRoot(t, core, fragments)` that writes a temp `--root` tree from the real core fragment plus a `dup` harness fragment. Then one test per row, each asserting exit `2` and the stderr substring:
  - `test('a fragment that re-declares a core command is refused', …)` → `duplicate command "pitwall.refreshWorkspaces" in src/harnesses/dup/contributes.json`
  - `test('a setting re-declared under a differently titled section is refused', …)` (`pitwall.autoImport.enabled` under title `"Dup"`) → `duplicate setting "pitwall.autoImport.enabled"`
  - `test('a keybinding on a key core already binds with the same when is refused', …)` (core's `ctrl+alt+n` entry) → `duplicate keybinding`
  - `test('duplicate submenu, view and viewsContainer ids are refused', …)`, three sub-asserts
  - `test('untitled configuration sections are matched by identity, not undefined === undefined', …)`
  - `test('a filled x-harness-enum whose default is not in its enum is refused', …)` (core default `"claude"`, `--enabled dup` only) → `default "claude" is not in the enum`
  - `test('core enum, enumItemLabels and enumDescriptions of unequal length are refused', …)`
  - Run `npm test -- manifest` → the seven new tests `✖`. Commit as the red sha.
- [ ] **Step 2: Implement** `--root`. After the merge, check uniqueness across all sources for `commands[].command`, `submenus[].id`, `views.*[].id`, `viewsContainers.*[].id`, setting keys across all sections, and keybindings by `(key, mac, when)`; untitled sections merge only with the same object identity; then the two enum checks. Each error names the fragment that added the second entry.
- [ ] **Step 3: Run** Smoke 8. Expected as written there.
- [ ] **Step 4: Commit** `fix: build-manifest refuses duplicate ids, keys and keybindings across fragments`. Closing block.

### Task 8: Packaging allowlist and the CI privacy gate (`phase2/task-8-packaging-ci`)

**Closes:** ROADMAP 2.9 (I3), 2.10 (I4), 2.12 (M6, M7, M8). **Files:**
- Modify: `package.json` (`files`), `.github/workflows/ci.yml`, `scripts/verify.sh:73-80`, `tools/check_private_paths.py:18-26`, `tools/tests/test_check_private_paths.py`, `.gitignore`
- Delete: `.vscodeignore` (vsce 3 refuses a `.vscodeignore` next to `files`)
- Create: `tools/check_vsix.py`, `tools/tests/test_check_vsix.py`

**Interfaces — Produces:**
- `package.json` `"files": ["out/extension.js", "resources/icons/*.png", "resources/icons/*.svg", "resources/icons/harness/*.svg", "README.md", "LICENSE", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md"]`.
- `python -m tools.check_vsix [--from-file PATH]` (stdlib only). It runs `npx -y @vscode/vsce@3.2.1 ls` (or reads PATH) and accepts only paths matching `^(package\.json|README\.md|LICENSE|CHANGELOG\.md|THIRD_PARTY_NOTICES\.md|out/extension\.js|resources/icons/[^/]+\.(png|svg)|resources/icons/harness/[^/]+\.svg)$`. On success it prints `OK: <n> packaged paths, all allowlisted` and exits 0. Otherwise it prints `STRAY <path>` lines and exits 1. If `vsce` fails, it exits 2.

- [ ] **Step 1: Write the failing tests** (pytest): `test_allowlisted_listing_passes`, `test_source_map_is_stray` (`out/extension.js.map`), `test_env_local_is_stray` (`.env.local`), `test_transcripts_file_is_stray` (`transcripts/a.md`), `test_nested_resource_dir_is_stray` (`resources/icons/harness/base/x.svg`). Then `test_npmrc_flagged`, `test_netrc_flagged`, `test_id_rsa_flagged` (`keys/id_rsa.pub` too), `test_id_ed25519_flagged`, `test_p12_flagged`, `test_pfx_flagged` in `test_check_private_paths.py`. The red commit adds a stub `tools/check_vsix.py` whose functions raise `NotImplementedError` (red-commit rule). Run: `unset VIRTUAL_ENV; poetry run pytest -q tools/tests` → the 11 new tests fail (failures, not collection errors). Commit as the red sha.
- [ ] **Step 2: Implement** `check_vsix.py`, and add the 6 patterns (`(^|/)\.npmrc$`, `(^|/)\.netrc$`, `(^|/)id_rsa[^/]*$`, `(^|/)id_ed25519[^/]*$`, `\.p12$`, `\.pfx$`) to `_PRIVATE` and to `.gitignore`. Run pytest → all pass.
- [ ] **Step 3: Allowlist by construction.** Add `files`, delete `.vscodeignore`, and point `verify.sh` step 8 at `poetry run python -m tools.check_vsix`. Run Smoke 9's first command from the build worktree, then from Sharif's main checkout after merge. Expected `41` and the OK line.
- [ ] **Step 4: CI hygiene (M6).** Resolve the commit sha of each action with `gh api repos/actions/checkout/commits/v4 --jq .sha`, `gh api repos/actions/setup-node/commits/v4 --jq .sha` and `gh api repos/actions/setup-python/commits/v5 --jq .sha`, and pin `uses: actions/checkout@<sha> # v4` (and the same for the others). Add `timeout-minutes: 20` per job and top-level `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`.
- [ ] **Step 5: Privacy job (I4).** `privacy` on `ubuntu-latest`: checkout with `fetch-depth: 0`; setup-python `3.13`; `python -m tools.check_private_paths`; `pip install -q pytest python-dotenv && python -m pytest -q tools/tests`; `docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/repo" zricethezav/gitleaks:v8.21.2 git /repo --no-banner --gitleaks-ignore-path /repo/.gitleaksignore 2>&1 | tee gitleaks.log` (the runner uid owns the checkout, so git inside the container does not refuse it as "dubious ownership"), followed by a step that fails unless `gitleaks.log` has `<N> commits scanned` with N ≥ `git rev-list --count --no-merges HEAD` (gitleaks skips diffless merges; ruling R26); setup-node 22; `npm ci`; `npm run compile` (so `vsce ls` sees `out/extension.js`); `python -m tools.check_vsix` → `OK: 41 packaged paths, all allowlisted`.
- [ ] **Step 6: Commit** `build: package from a files allowlist; CI privacy job; pinned actions; credential path patterns`.
- [ ] **Step 7: Push and watch.** `gh run watch -R sharifamlani/pitwall $(gh run list -R sharifamlani/pitwall --branch phase2/task-8-packaging-ci --limit 1 --json databaseId --jq '.[0].databaseId')` → ubuntu, windows and privacy `success`.
- [ ] **Step 8:** Closing block.
- [ ] **Step 9: Privacy probe (after merge, by the lead).** `git switch -c phase2/privacy-probe origin/main && mkdir -p probe && printf 'not-a-key\n' > probe/dummy.key && git add -f probe/dummy.key && git commit -m "probe: CI privacy gate must fail (do not merge)" && git push -u origin HEAD && gh pr create -R sharifamlani/pitwall --draft --title "probe: privacy gate" --body "Probe for Phase 2 E7. Do not merge."`. (`-f`: `.gitignore` already blocks `*.key`; the probe forces it past, as a careless contributor could. Ruling R28.) Expected: the `privacy` job is `failure`, at step `python -m tools.check_private_paths` with `LEAKED probe/dummy.key`. Then `gh pr close <N> -R sharifamlani/pitwall --delete-branch`. Record the run id for E7.

### Task 9: Registry, storage and architecture minors; 2.5 regression (`phase2/task-9-minors`)

**Closes:** ROADMAP 2.5, 2.12 (M1, M2, M3, M5). **Files:**
- Modify: `test/dry/core/architecture.test.ts`, `src/harnesses/index.ts:22-33`, `src/core/services/StorageService.ts:350-362`, `src/harnesses/README.md` ("Turn a dormant harness back on"), `test/dry/core/manifest.test.ts:114-116`
- Test: `test/dry/core/registry-safety.test.ts`, `test/dry/core/storage.test.ts`, `test/dry/core/architecture.test.ts`, `test/dry/core/manifest.test.ts`

**Interfaces — Produces:** `enabledHarnesses()` throws `Unknown harness "<id>" in src/harnesses/enabled.json. Valid ids: …` (uses `Object.hasOwn`), `Duplicate harness "<id>" in src/harnesses/enabled.json.`, and `src/harnesses/enabled.json must name at least one harness.`. A pure helper `validateEnabled(ids: unknown[], all: Record<string, unknown>): string[]` in `src/harnesses/index.ts` makes this testable. Manifest test constant: `const SHIPPED_HARNESSES = ['claude'];`.

- [ ] **Step 1 (2.5): failing-or-pinning test** in `registry-safety.test.ts`: `test('Find Session with an off-enum stored harness falls back to the first enabled harness', …)`. With `stub.__setConfiguration('sessionSearch.harness', 'codex')` and a Claude-only registry, `await new SessionSearchService(storage, registry, dir).engine()` resolves without throwing, with `.harness === 'claude'`. The reviewer believes this already holds: if it passes at once, record "pinned, already fixed" in the PR (no red commit needed for 2.5).
- [ ] **Step 2 (M2): failing tests** in `manifest.test.ts`: `test('enabled.json validation rejects unknown, inherited, duplicate and empty ids', …)`. `validateEnabled(['toString'], ALL_HARNESSES)` throws `Unknown harness "toString"`; `['claude','claude']` throws `Duplicate harness "claude"`; `[]` throws `must name at least one harness`. The red commit stubs `validateEnabled` (red-commit rule). Also `test('harness folders with a contributes.json, ALL_HARNESSES keys and module ids agree', …)`: the set of `src/harnesses/*/contributes.json` folders equals `Object.keys(ALL_HARNESSES)`, and `ALL_HARNESSES[k].id === k` for every k.
- [ ] **Step 3 (M3): failing test** in `storage.test.ts`: `test('saving a search keeps stored searches of a disabled harness', …)`. Use `makeStorage(g, w, (id) => id === 'claude')` with raw global state seeded with one codex search record. After `saveSessionSearch(claudeSearch)`, the raw `g.get(<SESSION_SEARCHES key>)` still contains the codex record, while `getSessionSearches()` omits it. Do the same for `removeSessionSearches([claudeSearch.id])`.
- [ ] **Step 4 (M1): stronger architecture test.** `test('core reaches no harness folder, directly or transitively, in any import syntax', …)`: esbuild `build({ stdin: { contents: <one import per src/core/**/*.ts>, resolveDir: ROOT }, bundle: true, write: false, metafile: true, platform: 'node', external: ['vscode'] })`, then assert no `metafile.inputs` key starts with `src/harnesses/` and none is `src/extension.ts`. Add `test('src/ holds only core, harnesses and extension.ts', …)`, which asserts `fs.readdirSync(SRC).sort()` deep-equals `['core', 'extension.ts', 'harnesses']`. Prove the first test can fail: in a scratch commit, add ``void import(`../../harnesses/claude`)`` to a core file, see `✖`, then drop the commit (paste the `✖` line in the PR).
- [ ] **Step 5 (M5):** replace the literal in `manifest.test.ts:116` with `SHIPPED_HARNESSES`. README sentence: "Then change `SHIPPED_HARNESSES` in `test/dry/core/manifest.test.ts` to the same list, or `npm test` fails by design."
- [ ] **Step 6: Run** to see the red tests fail (commit the red sha), implement M2 and M3, then run Smoke 10. Expected as written there.
- [ ] **Step 7: Commit** `fix: validate enabled.json fully; keep disabled-harness searches on write; transitive architecture test`. Closing block.

### Task 10: Electron-safe launches, settled reveals, Phase 1 doc refresh (`phase2/task-10-launch-env`)

**Closes:** ROADMAP 2.4, 2.12 (M9 and the "No tree item with id" log line). **Files:**
- Create: `test/electronEnv.js`, `scripts/cursor-cli.sh`, `test/dry/core/electron-env.test.ts`
- Modify: `test/integration/runTest.js:22-24`, `test/e2e/terminal-restore/run.js:418`, `src/core/providers/WorkspacesTreeProvider.ts`, `src/extension.ts:215-229,430-445`, `test/dry/vscode-stub.js`, `docs/superpowers/plans/2026-11-16-phase1-import-agntree.md` (§1 tree, Smoke 7, E8)
- Test: `test/dry/core/electron-env.test.ts`, `test/dry/core/tree.test.ts`

**Interfaces — Produces:**
- `test/electronEnv.js`: `ELECTRON_VARS = ['ELECTRON_RUN_AS_NODE', 'VSCODE_ESM_ENTRYPOINT', 'VSCODE_CRASH_REPORTER_PROCESS_TYPE', 'VSCODE_IPC_HOOK', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_PID', 'VSCODE_CWD']` and `scrubElectronEnv(env = process.env): NodeJS.ProcessEnv`, which deletes them in place and returns `env`. The last four stop the CLI from handing off to the Cursor that spawned the shell (testing agent fixture notes).
- `scripts/cursor-cli.sh "$@"`: `exec env -u ELECTRON_RUN_AS_NODE -u VSCODE_ESM_ENTRYPOINT -u VSCODE_CRASH_REPORTER_PROCESS_TYPE -u VSCODE_IPC_HOOK -u VSCODE_IPC_HOOK_CLI -u VSCODE_PID -u VSCODE_CWD "${PITWALL_EDITOR_CLI:-cursor}" "$@"`.
- `WorkspacesTreeProvider.whenSettled(): Promise<void>` resolves after the first `getChildren(undefined)` that completes after the latest `refresh()` or `softRefresh()`, and resolves at once when there is no refresh pending.

- [ ] **Step 1: Failing tests.** `electron-env.test.ts`: `test('scrubElectronEnv removes every variable that turns the editor into Node or hands off to the running window', …)` (all 7 deleted, `PATH` kept). `test('every script that launches an editor scrubs its environment first', …)` reads `test/integration/runTest.js` and `test/e2e/terminal-restore/run.js` and asserts each contains `scrubElectronEnv(`. `tree.test.ts`: `test('whenSettled waits for the render that follows a refresh', …)`: after `provider.refresh()`, a `whenSettled()` promise is still pending after `flush()`, and resolves after `await provider.getChildren()`. The red commit stubs `test/electronEnv.js` (`ELECTRON_VARS = []`, `scrubElectronEnv` throws `not implemented`) per the red-commit rule. Run → `✖`. Commit the red sha.
- [ ] **Step 2: Root cause of the log line** (systematic-debugging). The handle `1/repository-<uuid>` is the explicit id of a repository row. Confirm with the testing agent's log of a reload in uj-lab-a (`$LOCALAPPDATA/pitwall-uj/profile/user-data/logs/<newest>/window1/exthost/exthost.log`) that it comes from `reveal()` racing a refresh during startup. If not, report the real source to the lead before Step 3.
- [ ] **Step 3: Implement.** `scrubElectronEnv(process.env)` at the top of `runTest.js` `main()`, and the e2e `env` built from a scrubbed copy; `cursor-cli.sh`; `whenSettled()`; `activateChat` and the start-worktree reveal `await workspacesProvider.whenSettled()` before `reveal`.
- [ ] **Step 4: M9.** In the Phase 1 plan's §1 tree, replace the `docs/upstream/` line with `docs/reference …  KEEP in place (Ruling R8)`, and note fixtures stay in `test/dry/fixtures/` (Ruling R13). Change Smoke 7's screenshot path and the E8 evidence cell to "testing agent UJ run 6 (see `docs/progress_reports/phase1-scorecard.md`, E8 part 2)". Also replace every remaining `docs/upstream/` (Task 1's and Task 3's **Files:** lists, Phase 1 plan lines 274 and 291) with where those docs stayed: `docs/` (kept in place, R8).
- [ ] **Step 5: Run** Smoke 11. Expected as written there.
- [ ] **Step 6: Commit** `fix: scrub Electron env in editor launches; reveal only after the tree settles; refresh Phase 1 plan evidence`. Closing block. Testing agent: reload uj-lab-a twice; `grep -c "No tree item with id"` in the newest exthost.log → `0`.

### Task 12: The Claude agents poll runs on Windows (`phase2/task-12-claude-agents-exec`)

**Closes:** ROADMAP 2.14 (finding F2, QA, while auditing spawn sites for Task 4). Depends on Task 4 (`fakeCli` on win32). Runs in parallel with Task 5. **Files:**
- Modify: `src/harnesses/claude/ClaudeAgentsService.ts:32-46` (`execClaudeAgents`)
- Test: `test/dry/harnesses/claude/claude-agents.test.ts`

**Ruling R31 (after the builder's check):** F2 does not reproduce through the service. `fetchStates` (`ClaudeAgentsService.ts:171-177`) already wraps the command in `harnessInvocation` and passes `shell` before calling `execClaudeAgents`; QA's repro called raw `execFile` outside the service. Task 12 therefore lands the two real-exec tests as regression guards (no red sha; the builder showed both fail on Windows when the wrapper is removed), like row 2.5. S1 still runs live, since "needs you" has never been seen on Windows. **Original concern:** `execClaudeAgents` calls `execFile(command, args, options)` directly. On Windows an npm-installed Claude is `claude.cmd`. A bare `claude` gives `spawn claude ENOENT`, and `claude.cmd` without a shell throws `EINVAL` (Node 22, CVE-2024-27980 guard). So the `claude agents --json` poll behind "needs you" (ADR 0006) never runs for Windows users. The existing tests inject `exec`, which is why none caught it.

**Interfaces — Consumes:** `harnessInvocation(command: string, args: string[]): { command: string; args: string[]; shell: boolean }` from `src/core/harness/cli.ts` (win32: cmd-quoted, `shell: true`; elsewhere unchanged), and `fakeCli(dir, name, fixture, env)` from `test/dry/support.ts`. **Produces:** no API change.

- [ ] **Step 1: Write the failing tests** in `claude-agents.test.ts`, using the service's REAL default exec (no injected `exec`):
  - `test('the agents poll runs a real claude CLI on this platform, by full path', …)`: a fixture that prints the agents JSON shape the existing tests feed the parser; `cli = fakeCli(dir, 'claude', fixture, {})`; the service's command is `cli`. Assert the poll resolves and parses to the fixture's agents.
  - `test('the agents poll runs a real claude CLI on this platform, by bare name on PATH', …)`: the same fixture, command `'claude'`, and `dir` prepended to `PATH` in the exec options' `env`. Assert the same.
  Run `PITWALL_TEST_NAME_PATTERN="real claude CLI" npm test -- claude-agents`. Expected on Windows: both `✖` (EINVAL / ENOENT). On Linux they may already pass. Commit `test: the Claude agents poll runs a real CLI (fails on Windows)`; this is the red sha.
- [ ] **Step 2: Implement.** In `execClaudeAgents`: `const inv = harnessInvocation(command, args); execFile(inv.command, inv.args, { ...options, shell: inv.shell }, …)`. No other change.
- [ ] **Step 3: Run** the Step 1 command → `ℹ fail 0` on Windows and Linux; then `npm test -- claude-agents` → `ℹ fail 0`.
- [ ] **Step 4: Commit** `fix: run the Claude agents poll through harnessInvocation so it works on Windows`. Closing block. The live check is Smoke 12 S1.

### Task 11: Close: Windows CI full suite, evaluator, live walk, v0.3.0 (`phase2/task-11-close`)

**Closes:** ROADMAP 2.3; closes Phase 2. Depends on Tasks 1–10 merged. **Files:** `.github/workflows/ci.yml` (windows job), `docs/windows-test-triage.md`, `package.json` (version), `CHANGELOG.md`, `ROADMAP.md`, `docs/progress_reports/phase2-scorecard.md`.

- [ ] **Step 1: Turn on Windows tests.** In the `windows` job, replace the comment "Windows runs the build only…" with nothing, and add `- run: npm test` after the manifest check. Push; `gh run watch` → windows `success`, and its log has `ℹ fail 0`. If CI fails where local passes, it is Review Focus #2 or #5: fix in the owning task's file with a test, in this PR.
- [ ] **Step 2: Triage doc.** Update the header (current paths, "resolved in Phase 2"). Add a column `Phase 2 resolution` to all 29 rows, each one of `fixed (product, Task N, PR #x)`, `fixed (test, Task N, PR #x)`, `runs on Windows (Task 4)`, or `skip (reason: "<exact reason string>")`. Append the final Windows `ℹ` summary.
- [ ] **Step 3: Commit** `ci: Windows runs the full test suite; triage resolutions` → PR → QA → merge.
- [ ] **Step 4: Smoke 12** by the testing agent on the merged main; the report goes to the lead.
- [ ] **Step 5: Independent evaluator** (fresh sub-agent, given only §5 and the repo URL) grades E1–E13 and E15 on a fresh clone and writes `docs/progress_reports/phase2-scorecard.md` as `| Criterion | Threshold | Result | Evidence | PASS/FAIL |`. FAILs go back to the owning task with the evaluator's repro. Re-grade only the affected criteria. After 3 rounds stalled on one criterion → `docs/progress_reports/SHARIF_ACTION_ITEMS.md`. The evaluator measures every criterion itself (for E5, it re-runs Smoke 5 with the fixed `repeat-tests.sh`; for E9, E10, E12 and E15, it reads the testing agent's captures and logs and re-greps them). QA, builder and lead numbers may be cross-checked but are never cited as a result (Sharif rule 2026-10-28).
- [ ] **Step 6: Release** (only when E1–E13 and E15 PASS). `package.json` `"version": "0.3.0"`; `node scripts/build-manifest.mjs --check` → up to date. `CHANGELOG.md` `## 0.3.0 — Windows parity` (3 bullets: what works on Windows now, the restore fixes, and the packaging and CI guards). ROADMAP: rows 2.1–2.14 → `✅ | — | 2026-11-<dd> · PR #x <sha> → merge <sha>`; Phase 2 Status `✅ done · tag v0.3.0`; Plan → this file; §0 → Phase 3 Sidebar v1; §6 `v<next> · <date> · Phase 2 closed, tag v0.3.0.` (<next> = the next ROADMAP version after the one current at close (v0.17 today, so ≥ v0.18)) with what shipped, what is now unblocked and the findings; stamp `v<next>`. Commit `roadmap v<next>: Phase 2 closed (evaluator E1-E13 + E15 PASS); v0.3.0`, push to main, then `git tag -a v0.3.0 -m "Phase 2: Windows parity" && git push origin v0.3.0`. Push the tag by name only, never `--tags`.
- [ ] **Step 7:** Evaluator grades E14 and the ground-truth probes. Lead hands marketing the tag, sha, PASS-only scorecard, 1–3 user-facing bullets and 1–2 testing captures with demo repo names (D39).

## Out of scope (later phases)

- **Phase 3 Sidebar v1:** repos from `~/.claude` with no repo open, inbox order, branch on every row, status dots, "+" and history, hiding Changes/worktree/PR panels, hotkeys, search, brand (D12–D14, D17–D19, D21, D24, D28, D33, D34, D36, D37). The upstream copy pass ("for main" → "for <repo> / main").
- **Phase 4 Windows and tabs:** `vscode.env.uriScheme` instead of the hardcoded `vscode://` (4.1), one window per folder (D35, D36), tab matching (T10), repo + branch under tabs (D26), FILES across repos (D22, D23), Claude Code's "Trust this folder?" prompt.
- **Phase 5 Status + pop-ups:** hooks and status files, Windows pop-ups, sound, jump list, first-run notification check.
- **Phase 6 Package + launch:** `package.json` author/contributors (R10), the first public `.vsix` and GitHub release, `main` protection (D30), the launch post. A harness-id namespace rule for manifest fragments (final review I2's optional part) waits until a second harness is enabled.
- **Phase 7:** in-chat instant search, card panel, Remote Control, one-window hub.
