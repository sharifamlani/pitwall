# Phase 2 handoff: Windows parity (v0.3.0)

Closed 2026-11-17, tag `v0.3.0`. Development is **paused** by Sharif after this release. Read this, then ROADMAP §0, before resuming.

## What shipped

- **Windows parity.** 0 Windows dry-test failures (12 at the start of the phase). Windows CI runs the full suite, builds the `.vsix` with `npm run package` and checks the archive. A CI privacy gate covers private paths, full-history gitleaks and the packaging allowlist.
- **Restore.** After a quit or reload, chats come back resumed in their own tabs. There are no duplicates or swapped names, activation takes ~0.2–0.6 s, and resume lines work in Windows PowerShell and cmd.
- **Needs you.** A waiting chat gets an orange row mark and is found by Ctrl+Alt+N. One pop-up fires, and only for a wait that began while you were looking elsewhere: none after a reload, none for a wait you saw start.
- **Evidence.** The independent evaluator passed E1–E13 + E15 ([phase2-scorecard.md](phase2-scorecard.md)). The testing agent's live walks are UJ runs 7–12, plus the N1 evidence folder.

## Decisions to know (full text in the plan, Task 6 Step 8c and Task 12)

| Ruling | What it says |
|---|---|
| R36–R45 | needs-you: true visibility (window focused + tab in front), checked every tick; a toast only if the chat wasn't in front after the prompt appeared (anchored on the transcript write, clamped to the last no-wait poll); no stale re-mark after a deny; none for waits pending at activation; new chats can toast |
| R37–R44 | restore: check-and-undo renames (the editor renames the *focused* terminal); never a second terminal per chat; activation never waits on terminals; a leading space guards resume lines typed into revived tabs; Pitwall's own background shows don't count as the user looking; the real front tab is put back; reveals wait for render |
| R46 | the terminal jumping to the front when a Claude turn starts is the Claude Code extension, not Pitwall (out of scope) |
| R48 | Sharif: move off the terminal path. Terminal-restore work stopped. Restore with a file in front at quit is a VS Code/Cursor race → Phase 4 row 4.2b. R1(b) is timed from Pitwall's activation |
| R49, R50 | the packaged count is 49 (the needs icons); N1 timing excludes PowerShell's cold first start |

## Open items, by phase

- **Phase 3, row 3.0 (F3):** Cursor can echo a stale `globalState` copy over a newer write. Phase 2 protects only terminal PID records; reproduce it live on another key first.
- **Phase 4, row 4.2b (F4):** terminal identity rests on tab titles. Also: the file-in-front restore race, and a plain panel terminal in front at quit leaving the last chat in front. The parked branch `phase2/task-6d-restore-file-front` has the parameterized front-at-quit e2e and the `[shortId]`-at-quit invariant.
- **Backlog:**
  - `revealWhenSettled` has no upper bound on holding refreshes (add a ~5 s race);
  - opencode spawns hit EINVAL on Windows (fix when D9 enables opencode);
  - a new chat's row renames to the prompt but its tab keeps "New Session" (cosmetic);
  - `pitwall.focusOnStartup` is probably worth defaulting on for D36.

## Process lessons (now standing rules)

- No merge without `gh pr checks` green at the approved sha; confirm main's CI after every merge. Main was red across #21–#23 because local runs missed a same-millisecond race.
- Live walks log the active tab and focus owner every 150 ms; that's how R39 and R1-x were isolated.
- Isolate external causes with the extension disabled before coding a fix (R46, R1-x).
