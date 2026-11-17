# Pitwall — Step-by-Step Build Plan (LIVING)

> **Single source of truth. Update checkboxes as work lands. Status flips one cell.**
>
> This is CANON. All forward direction flows from here. Plan-creation order in [`docs/superpowers/plans/`](docs/superpowers/plans/) follows §3 Phase order. Before creating any new plan, verify the work has a Phase in §3. If it doesn't, propose a §3 edit first.

> v0.39 · 2026-11-17

---

## §0 You are here

- **Current phase:** Phase 3 — Sidebar v1 (planning). Development resumed by Sharif on 2026-11-17.
- **Current step:** Phase 3 Wave A merged (3.0, 3.6, 3.3 source, 3.10 icons); Wave B in flight: T3 repo discovery (3.1), T5 rows + status + inbox order (3.2/3.3/3.4). Fix PR #30 (Files actions on Windows) merged `7f4a18a`.
- **Last update:** 2026-11-17
- **Next action:** QA + merge T3 before T5; then Wave C (T7 repo row, T8 keys).

Update §0 every working session. Any commit touching ROADMAP edits §0.

---

## §1 The North Star

**What Pitwall is.** A Cursor / VS Code extension that shows every Claude Code session across all your repos in one sidebar. Each session has a live status dot (working / needs you / finished / idle). Clicking a session opens it in the official Claude Code extension's chat panel, not a terminal. Source: `transcripts/inital_idea.md` (local).

**Who it serves.** A developer running Claude Code in several repos at once, across several Cursor windows, who loses minutes to an hour each time a session finishes or needs approval unnoticed. User zero is Sharif, on Windows.

**What v1 done delivers.** An installable `.vsix` (`v1.0.0`). Its sidebar lists repos and sessions with status dots. A click opens the chat panel directly, and Windows pop-ups fire on "finished" and "needs you". It is free, MIT, and works on native Windows.

**What later feels like.** You never hunt for windows. You open one Cursor window; Pitwall opens and focuses the rest for you (D35, D36), and the session that has waited longest is one key away. One window for every repo's chats is a v2 hope (7.4).

---

## §2 Locked architectural decisions

| # | Decision | Source |
|---|---|---|
| D1 | Runs inside Cursor as a second extension next to the official Claude Code extension; never copies, embeds or modifies it | `transcripts/inital_idea.md` (license: all rights reserved) |
| D2 | Fork Agntree (MIT), keeping its LICENSE line and a README credit; don't build from scratch | `transcripts/inital_idea.md` |
| D3 | Open sessions via Claude Code's link (`<vscode.env.uriScheme>://anthropic.claude-code/open?session=<id>`, i.e. `cursor://` in Cursor) or `claude-vscode.editor.open`, in the window of the chat's folder (D35) | `transcripts/inital_idea.md` |
| D4 | Status dot colors: blue = working, orange = needs you, green = finished, gray = idle | wireframe artifact `XhYy9L747DwQzBsQDpaFF2` |
| D5 | Name is Pitwall; no "Claude" in the name | `transcripts/inital_idea.md` |
| D6 | Extension = TypeScript/npm at the repo root; Python dev tooling = `tools/` via Poetry | [foundation plan](docs/superpowers/plans/2026-11-16-foundation.md) |
| D7 | Public repo; `.packages/`, `transcripts/`, `.claude/`, `.env` are never tracked | [foundation plan](docs/superpowers/plans/2026-11-16-foundation.md) |
| D8 | SemVer annotated tags on every version bump; Phase N closes as `v0.(N+1).0`; Phase 6 (first installable release) = `v1.0.0` (after the v0.9 renumber) | Sharif 2026-11-16, [CLAUDE.md](CLAUDE.md) |
| D9 | Claude Code only for v1; every agent lives in its own `src/harnesses/<id>/` folder, switched on by one `enabled.json` (Codex / opencode / Pi kept dormant) | Sharif 2026-11-16 |
| D10 | Sidebar = standard VS Code list (TreeView) for v1; the custom card panel is v2 | Sharif 2026-11-16, spec canvas Decision 1 |
| D11 | Two ways into a chat: click a repo → **all** of that repo's chats open as tabs in its window (close any you don't need); click a session → its tab is **added** to its window's tabs, never replacing them. Worktree chats open in their own window (D35) | Sharif 2026-11-16, spec canvas "Two ways into a chat" |
| D12 | Hotkeys jump to repos by their position in the sidebar (1st, 2nd, 3rd…). Keys are latent: not printed on rows, shown in the hover tooltip (D28). Exact keys + repo order = spec canvas Decisions 11–12 | Sharif 2026-11-16 |
| D13 | Repos are found automatically (any repo with a Claude session in the last 14 days); any repo can be removed (stays hidden until re-added); repos can be added by hand (title-bar folder icon or "Pitwall: Add Repository") | Sharif 2026-11-16, spec canvas Decision 2 |
| D14 | No worktree level: sessions sit under the repo, and every row always shows its branch/worktree (even main); hover shows the worktree folder; the bottom-bar corner shows the open chat's branch | Sharif 2026-11-16, spec canvas Decision 6 |
| D15 | Hotkey to open a repo itself in its own Cursor window (proposed Ctrl+Alt+Shift+1–9 by position, Ctrl+Alt+O for the current repo; focuses the existing window if one is open) | Sharif 2026-11-16 |
| D16 | Claude Code chats stay ordinary Cursor tabs: drag-to-reorder, split and pin keep working; switching repos never closes or rebuilds tabs, so tab order is preserved | Sharif 2026-11-16 |
| D17 | Brand: dark-first with a light mode; Inter + JetBrains Mono; Pitwall orange #f0883e only for "needs you"; status colors per the brand book (all pairs WCAG-checked); logo = the status row (four dots: working, needs you, finished, idle), one-color with an enlarged needs-you dot at ≤24px | Sharif 2026-11-16, brand book page |
| D18 | Sessions: every session from the last 14 days; Finished turns Idle when its chat is opened; in-repo order Needs you → Working → Finished → Idle | Sharif 2026-11-16, decision log 3–5 |
| D19 | Keep a FILES section under the repo list inside Pitwall (Agntree's files view), collapsed by default, Ctrl+Alt+F; follows the selected repo / the open session's worktree. Hide Changes, worktree create/delete, PR badges; keep Find Session + Fork | Sharif 2026-11-16, decision log 7 |
| D20 | Pop-ups for Needs you + Finished (silent); click a session open elsewhere → that window comes forward; a repo's chats show as tabs (side-by-side on right-click) | Sharif 2026-11-16, decision log 8–10 |
| D21 | Repo order is inbox-style and moving: attention rises to the top, hotkeys follow position; rows move only on status change, never under the mouse. rank Needs you → Finished → Working → Idle, newest first (confirmed) | Sharif 2026-11-16, decision log 11–12 |

| D22 | Clicking a file in FILES opens it as a normal Cursor editor tab in that repo's tab group, next to its chats (preview tabs and editing inherited) | Sharif 2026-11-16, decision log 13 |
| D23 | Copy files between repos: copy/cut in one repo, switch, paste (Agntree's clipboard survives switching; paste lands in the shown repo/worktree; name clashes get " copy"). New: right-click "Copy to another repo" and drag a file onto a repo row. A copied `.env` that the target's `.gitignore` doesn't cover triggers an offer to add it | Sharif 2026-11-16, decision log 14 |
| D24 | Search (Ctrl+Alt+R), one box: v1 = repos + chats by name/branch (instant) + Agntree's Find Session (agent reads transcripts). Instant text search inside chats → row 7.1 | Sharif 2026-11-16, decision log 15 |
| D25 | Bottom-bar counts are buttons: click "N need you" (or working / finished) → a list of those sessions; Pitwall jumps you to each in turn (Next ▸). Side by side only within one folder (amended by D35) | Sharif 2026-11-16, decision log 16 |
| D26 | Every tab shows its repo + branch underneath (Sharif: keep). File tabs: Cursor's tab-label setting. Claude's chat tabs belong to Claude Code: test 4.5 must find a way; fallback is the window title + bottom bar showing "repo · ⎇ branch" | Sharif 2026-11-16, decision log 17 |
| D27 | Sound: off by default (refines D20). Two switches, "needs you" and "finished"; when on, the Windows pop-up plays the system sound. Bell in the sidebar header + Settings | Sharif 2026-11-16, decision log 18 |
| D28 | Repo rows: no printed hotkeys; a "+" on each repo starts a new Claude Code chat there; the header keeps only the folder icon (add repo). Right-click → "Dismiss from Pitwall" hides the repo (nothing on disk changes); it returns when re-added or when a new session starts in it | Sharif 2026-11-16, decision log 19 |
| D29 | Principle: inherit everything Cursor already does (tabs, editor, menus, quick-pick box, keybinding editor, themes); never rebuild it. Canvas board "What Pitwall gets from Cursor" | Sharif 2026-11-16, decision log 20 |
| D30 | Until contributions open, `main` stays unprotected so Sharif and his Claude push directly. Before the contributor call goes out (6.6), `main` gets a GitHub ruleset: changes only through a pull request with 1 approving review and passing CI, no force-push or deletion; only the repo admin (Sharif, and his Claude using his login) may bypass | Sharif 2026-11-16 |
| D31 | ~~Tabs from several repos at once~~ (superseded by D35): session clicks keep adding tabs from any repo, all on screen and each labelled with its repo; clicking a repo name filters to that repo; an "All open tabs" row brings everything back; switching never closes tabs. Depends on the one-window test (2.6) | Sharif 2026-11-16, decision log 21 |
| D32 | Pin tabs with Cursor's own Pin Tab (right-click → Pin, Ctrl+K Shift+Enter): pinned tabs sit left and survive "Close Others" | Sharif 2026-11-16, decision log 22 |
| D33 | Sidebar never scrolls sideways (rows truncate with "…"); its edge drags to resize or hide, and the line above FILES drags to resize it, like any Cursor panel | Sharif 2026-11-16, decision log 23 |
| D34 | Each repo row gets a session-history button (clock) next to "+": lists every past Claude Code chat in that repo, beyond the 14-day list, and resumes the one you pick in Claude's panel | Sharif 2026-11-16 |
| D35 | **One window per folder (v1)** — the "one-repo-per-window rule". Claude's panel only resumes chats from its window's folder, and a git worktree counts as its own folder (tests T5, T17). Every window runs the same Pitwall sidebar; clicking a chat from another repo or worktree brings that folder's window forward (opening it if needed) with the chat open. A window's tabs only ever hold its own folder's chats. Supersedes the cross-repo parts of D15, D25, D26 (chat tabs), D31 | Sharif 2026-11-16 · [tests](docs/research/2026-11-16-assumption-tests.md) |
| D36 | **No repo needs to be open.** You open one Cursor window; Pitwall reads Claude Code's own files (`~/.claude/sessions`, `~/.claude/projects`) to show every repo, chat, status, history and pop-up. Windows for other folders are opened by Pitwall on demand (D35), never by hand. Option "everything in one window via terminal mode" rejected (that is what a switchboard does) | Sharif 2026-11-16 |
| D37 | Keyboard in the Pitwall list (only while the list has focus): ↓/↑ move the highlight without opening; Ctrl+↓/Ctrl+↑ move and open (chat → added tab; repo → all its chats); Enter opens the highlighted row. Side by side stays Cursor's own split (split button, Split Right, drag a tab) | Sharif 2026-11-16 |
| D38 | **Later (backlog 7.3, Sharif: not needed right away).** Remote Control per chat: right-click a Claude chat tab ("Claude: Turn on Remote Control") or a chat row, or press Ctrl+Alt+M on the highlighted row / the chat in front. Rows and tabs show 📡 while on (read from `bridgeSessionId` in the sessions file). Claude Code has no public command for it; route = its own `/remote-control` sent through the link's `prompt` (test T19, in 7.3) | Sharif 2026-11-16 |
| D39 | **Team + phase-close flow.** Build subagents write code on branches → the Pitwall QA agent reviews it and approves an exact commit → the lead merges that commit to `main` → the Pitwall testing agent runs the real extension in Cursor and tests each feature → when a phase closes, the lead hands it to the Pitwall marketing agent, who drafts a progress post for **LinkedIn and X** (problem first, Sharif's voice, says Pitwall is independent of Anthropic, credits Agntree). The draft goes to the lead, who gets Sharif's approval (Sharif coordinates only through the lead); once approved, the marketing agent posts it **live** on both. Series: a problem-only kickoff post (before Phase 1), one post per phase close, and the v1.0.0 launch post (6.6). Phase-close handoff to marketing: tag + SHA + evaluator scorecard (PASS features only); 1–3 plain bullets of what a user can now do + what still doesn't work; 1–2 screenshots/GIF from the testing agent with demo repo names only; one honest number or moment; anything not to mention yet | Sharif 2026-11-16 |
---

## §0.5 Phase renumbering map (v0.9, 2026-11-16)

The live tests of 2026-11-16 answered the old "one-window test" (one window per folder, D35), so the phases were re-cut around what is left to build. Old → new:

| Old | New | What happened |
|---|---|---|
| Phase 1 Import Agntree (1.1–1.4) | Phase 1 (1.1–1.6) | Same goal; rows now match the plan's six tasks |
| — | **Phase 2 Windows parity** | New: fix Agntree's Windows test failures (12 fail / 17 skipped on this machine) |
| Phase 2 One-window test | absorbed | 2.1–2.3 answered by tests T5/T6/T17 → D35; 2.4 and 2.6 dropped with D31; 2.5 → 4.5; 2.7 → 4.6 |
| — | **Phase 3 Sidebar v1** | New: the repo/session list as designed (D12–D14, D17–D19, D21, D24, D28, D33, D34, D36, D37) |
| Phase 3 Chat panel by default | Phase 4 Windows and tabs | 3.1 → 4.1; 3.2 → 4.2 (one window per folder) |
| Phase 4 Status dots + pop-ups | Phase 5 Status + pop-ups | 4.1 → 3.3 (dots live in the sidebar); 4.2 → 5.1; 4.3 → 5.2; 4.4 → 5.3 |
| Phase 5 Package + install | Phase 6 Package + launch | 5.1–5.6 → 6.1–6.6 |
| Phase 6 After v1 | Phase 7 After v1 | 6.1–6.3 → 7.1–7.3 |

Version rule after the renumber: Phase N closes as `v0.(N+1).0`; Phase 6 (first installable release) is `v1.0.0`.

---

## §3 The Checklist — every Phase from start to v1.0.0

```
Phase 0 Foundation ✅ → 1 Import Agntree → 2 Windows parity → 3 Sidebar v1
                     → 4 Windows and tabs → 5 Status + pop-ups → 6 Package + launch (v1.0.0) → 7 After v1
```

### Phase 0 — Foundation
**Goal:** Clean, public repo with Poetry, `.env`, a dev container and a one-command verify script.
**Entry gate:** N/A.
**Exit gate:** Evaluator scorecard all PASS; tag `v0.1.0` pushed.
**Status:** ✅ done · tag `v0.1.0`.
**Plan:** [2026-11-16-foundation.md](docs/superpowers/plans/2026-11-16-foundation.md)

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 0.1 | Rewrite `.gitignore`, add `.gitattributes` + MIT `LICENSE` | ✅ | — | 2026-11-16 · `b78bf86` | plan Task 1 |
| 0.2 | Poetry project, `.env.example`, `tools/check_env.py` (6 tests) | ✅ | — | 2026-11-16 · `cca13ac` | plan Task 2 |
| 0.3 | Dev container (Python 3.13, Node 22, Poetry 2.3.4) | ✅ | — | 2026-11-16 · `4b0f06a` | plan Task 3 |
| 0.4 | `scripts/verify-foundation.sh` | ✅ | — | 2026-11-16 · `f27b8f8` | plan Task 4 |
| 0.5 | README, CLAUDE.md, this ROADMAP | ✅ | — | 2026-11-16 · `f27b8f8` | plan Task 4 |
| 0.6 | Secret scan of git history (gitleaks) | ✅ | — | 2026-11-16 · `f27b8f8` (no leaks, 9 commits) | plan Task 5 |
| 0.7 | Create public GitHub repo + push | ✅ | — | 2026-11-16 · `f27b8f8` · github.com/sharifamlani/pitwall | plan Task 5 |
| 0.8 | Fresh-clone end-to-end verify | ✅ | — | 2026-11-16 · `29a78a3` | plan Task 5 |
| 0.9 | Review fix pass: check_env missing template, privacy check any depth/casing, container isolation | ✅ | — | 2026-11-16 · `0c295ae` | whole-branch review |
| 0.10 | Independent evaluator scorecard (E1–E10) all PASS | ✅ | — | 2026-11-16 · E1–E8 @ `29a78a3`; E2/E3/E5/E7 + isolation re-graded @ `0c295ae`; E9–E10 @ `32214f9`. All 10 PASS | plan §4 |
| 0.11 | Tag `v0.1.0` | ✅ | — | 2026-11-16 · tag `v0.1.0` → `32214f9` | D8 |
| 0.12 | Spec canvas + brand book; decisions D9–D38 locked | ✅ | — | 2026-11-16 · canvas v42 | [canvas](https://claude.ai/artifact/XhYy9L747DwQzBsQDpaFF2) |
| 0.13 | Live assumption tests T1–T17 (status files, hooks, one window per folder, maximize, pop-ups) | ✅ | — | 2026-11-16 · `afd4993`, `15c16b6`, `b2a42b2` | [tests](docs/research/2026-11-16-assumption-tests.md) |

### Phase 1 — Import Agntree (harness-modular, Claude-only)
**Goal:** Agntree's code in this repo with its history and MIT credit, renamed to Pitwall, reorganized so each agent lives in its own folder, shipping with only Claude Code enabled. Behaviour otherwise unchanged.
**Entry gate:** Phase 0 ✅ (`v0.1.0`); Sharif approves the plan.
**Exit gate:** Evaluator scorecard E1–E12 all PASS; `.vsix` installs and activates in Cursor; tag `v0.2.0`.
**Status:** ✅ done · tag `v0.2.0` (2026-11-16).
**Plan:** [2026-11-16-phase1-import-agntree.md](docs/superpowers/plans/2026-11-16-phase1-import-agntree.md)

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 1.1 | Import Agntree `47124cd` with full history; resolve root files; keep both copyright lines; `THIRD_PARTY_NOTICES.md`; allow only `.claude/skills/pitwall-*/` | ✅ | — | 2026-11-16 · PR #1 `4e26461` → merge `ea78755` (QA APPROVE; Linux 182/182) | D2, D7 |
| 1.2 | Triage every Windows-failing/skipped upstream test into `docs/windows-test-triage.md` (no fixes) | ✅ | — | 2026-11-16 · PR #2 `6911dd3` → merge `efa93e6` (29 rows = 12 fail + 17 skip; 5 suspected product bugs incl. Windows worktree paths) | tests doc T16 |
| 1.3 | Scripted rename `agntree` → `pitwall` (ids, package, docs); `version` → `0.2.0` | ✅ | — | 2026-11-16 · PR #3 `ee6e36a` → merge `f94f66f` (1612 replacements, idempotent; behaviour-neutral proven by reverse-map) | D5, D8 |
| 1.4 | Reorganize into `src/core/` + `src/harnesses/<id>/` behind `HarnessModule` (moves only); architecture test | ✅ | — | 2026-11-16 · PR #4 `88ea364` → merge `85d14d7` (182 → 184 tests, 0 dropped by name; architecture test proven to catch violations) | D9 |
| 1.5 | One switch `enabled.json = ["claude"]`; manifest fragments; disabled-agent records can't crash the tree | ✅ | — | 2026-11-16 · PR #5 `3b3d316` → merge `5caa2cb` (192 tests; 77 commands, 0 non-Claude; manifest split proven lossless; integration suite passes) | D9 |
| 1.6 | CI (ubuntu + windows), package, install in Cursor, evaluator E1–E12, tag `v0.2.0` | ✅ | — | 2026-11-16 · PR #6 `d5355fb` → merge `d5b54ba`; independent evaluator E1–E11 PASS on a fresh clone; testing UJ run 6 PASS 14/14 (E8); final review 0 Critical; tag `v0.2.0` | D8 |

### Phase 2 — Windows parity
**Goal:** The inherited code works on native Windows, the way it does on Linux.
**Entry gate:** Phase 1 ✅ (`v0.2.0`), with the triage doc.
**Exit gate:** Windows CI runs the full test suite green (env-limit tests skip with a stated reason); tag `v0.3.0`.
**Status:** ✅ done · tag `v0.3.0` (2026-11-17). Evaluator: E1–E13 + E15 PASS ([phase2-scorecard.md](docs/progress_reports/phase2-scorecard.md)).
**Plan:** [2026-11-16-phase2-windows-parity.md](docs/superpowers/plans/2026-11-16-phase2-windows-parity.md)

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 2.1 | Fix every "real bug" in the triage, each with a failing test first | ✅ (triage rows 2, 9–12; reopens if Task 4 surfaces a Claude-path bug) | ✅ | 2026-11-17 · PR #8 `daa68fa` → merge `704948f` (rows 9–12) · PR #10 `cece25c` → merge `8a1085f` (row 2) | Phase 1 triage |
| 2.2 | Make POSIX-assumption tests portable; mark env-limit tests (e.g. symlink EPERM) as skips with a reason | ✅ (rows 1, 3–7 Task 3; rows 13–25, 27–29 Task 4; row 26 and 8 dormant-opencode tests skip with reasons) | ✅ | 2026-11-17 · PR #11 `0a67e7f` → `23623d2` · PR #15 `5194a10` → `b4c85bb` | Phase 1 triage |
| 2.3 | Windows CI job runs `npm test` | ✅ (windows job runs the full suite, builds the .vsix via `npm run package` and checks the archive; R35) | ✅ | 2026-11-17 · PR #19 `b000545` → merge `f8ea023` | D8 |
| 2.4 | Script launches of Cursor clear `ELECTRON_RUN_AS_NODE` (inherited from the extension host) | ✅ | ✅ | 2026-11-17 · PR #12 `61dd65e` → merge `0095508` | tests doc side notes |
| 2.5 | (Reviewer: looks already handled; add a regression test and close) Find Session with an off-enum stored setting (e.g. `pitwall.sessionSearch.harness: "codex"`) falls back to the first enabled harness instead of throwing (QA PR #5 note) | ✅ (pinned: already fixed; regression test added) | ✅ | 2026-11-17 · PR #13 `36efa55` → merge `0d520bb` | D9 |
| 2.6 | After a Cursor restart, a restored chat terminal whose session never wrote a transcript is orphaned: "Remove from Pitwall" leaves it open although the dialog says terminals close (testing UJ run 5; inherited) — re-adopt or close restored tabs | ✅ (Remove closes an orphaned restored tab; never a user terminal) | ✅ | 2026-11-17 · PR #18 `8cac588` → merge `1914f21` | testing UJ run 5 |
| 2.7 | De-flake timing tests seen under load: "stopping an opencode snapshot ends the session listing…", "the opencode snapshot stops at its byte budget…", "server errors keep their JSON-RPC code, and a hung request times out", and (found in wave A) "stopping a search ends the agent and everything it started, and keeps nothing" (`Unexpected end of JSON input`: a JSON file read mid-write) | ✅ (atomic fixture writes, SIGTERM-handler order, explicit budget; repeat-tests.sh fails closed on zero matches) | ✅ | 2026-11-17 · PR #17 `82a6860` → merge `dd0e1ea` | R9, QA PR #6, QA wave A |
| 2.8 | `build-manifest.mjs`: fail on duplicate command ids, setting keys or keybindings between core and harness fragments (final review I2) | ✅ | ✅ | 2026-11-17 · PR #9 `2a5bef8` → merge `1830558` | final review |
| 2.9 | `package.json` `files` allowlist so any `vsce package` (not only verify.sh) ships only out/, resources/, the manifest and licence docs; must land before the first public `.vsix` (final review I3) | ✅ | ✅ | 2026-11-17 · PR #7 `186a384` → merge `131a2d5` | final review |
| 2.10 | CI runs the privacy gate, gitleaks and the vsix allowlist check (final review I4) | ✅ | ✅ | 2026-11-17 · PR #7 `186a384` → merge `131a2d5`; probe PR #14 run `44025011704`: privacy failure at path gate | final review |
| 2.11 | Windows quit/restore with a live chat: ~4 s activation wait, revived tab not resumed, row click opens a duplicate tab, reload then loses the duplicate (testing UJ run 6) | ✅ (restore after quit and reload, live UJ run 12; file-in-front restore is an editor limitation → 4.2b, R48) | ✅ | 2026-11-17 · PR #18 `8cac588` → merge `1914f21` · PR #22 `cd8ebd3` → merge `68ad3d2` | testing UJ run 6 |
| 2.12 | 9 Minor findings from the Phase 1 final review (`docs/progress_reports/phase1-final-review.md`) and the "No tree item with id" log line after reload | ✅ (M1–M3, M5 PR #13; M4 PR #9; M6–M8 PR #7; M9 + log line PR #12, live-verified UJ run 8: 0 "No tree item" in 5 starts + hidden-view start) | ✅ | 2026-11-17 · merges `1830558`, `0d520bb`, `131a2d5`, `0095508` | final review, UJ run 6 |
| 2.13 | New-chat launch with a custom full-path Claude command (`C:\...\claude.exe`) fails in PowerShell (a single-quoted path needs the call operator `&`); finding F1 from the Phase 2 plan | ✅ (`& ` before a quoted command in PowerShell, for new chats and Find Session resume) | ✅ | 2026-11-17 · PR #18 `8cac588` → merge `1914f21` | Phase 2 plan F1 |
| 2.14 | The Claude agents poll (`claude agents --json`, behind "needs you", ADR 0006) runs on Windows: `ClaudeAgentsService` calls `execFile` directly, so an npm `claude.cmd` fails (ENOENT / EINVAL); route it through `harnessInvocation` (finding F2, QA). Ruling R31: already routed through `harnessInvocation` at `fetchStates`; F2 did not reproduce through the service, so guards only | ✅ (needs-you live S1-a/b/c + new chat PASS, UJ run 12; R36–R45) | ✅ | 2026-11-17 · PR #16 `d255e13` → `34003bd` (guards) · PR #20 `655e1aa` → merge `a82f0f5` (R36/R38) · PR #21 `f4c5df5` → merge `3d0bd98` (R40/R41) | QA wave B, rulings R30, R31 |

### Phase 3 — Sidebar v1: repos and sessions
**Goal:** The Pitwall list as designed on the canvas: every repo and chat from one window, sorted by who needs you.
**Entry gate:** Phase 2 ✅ (`v0.3.0`).
**Exit gate:** Walkthrough of the canvas prototype's sidebar flows passes in real Cursor against Sharif's real repos; tag `v0.4.0`.
**Status:** ⏳ in flight (Wave B).
**Plan:** ✅ [2026-11-17-phase3-sidebar-v1.md](docs/superpowers/plans/2026-11-17-phase3-sidebar-v1.md) (QA pre-flight OK `e955a7e`)

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 3.0 | Every `globalState` record survives Cursor's stale storage echo (finding F3, Task 6 build): first reproduce it live on a non-PID key (chats, stars, repos, dismissals, searches), then generalize the R33a in-memory overlay across `StorageService` keys, with two-window tests | ✅ (live repro S1: not reproduced on non-PID keys; overlay generalised with write stamps, P25) | ✅ | 2026-11-17 · PR #28 `bd6dfeb` → merge `d12c906` (QA APPROVE after 3 rounds; main CI green; 4/4 QA two-window probes pass) | Phase 2 Task 6 report, ruling R34 |
| 3.1 | Repos found from `~/.claude` (sessions in the last 14 days), added by folder icon, dismissed by right-click; no repo needs to be open | ⏸ | ⏸ | — | D13, D28, D36 |
| 3.2 | Sessions from the last 14 days (incl. the Cursor panel's); branch on every row; ⧉ on worktree chats | ⏸ | ⏸ | — | D14, D18, D35 |
| 3.3 | Status dots from `~/.claude/sessions` (busy / waiting / idle) + finished → seen when opened. Note: the needs-you (waiting) mark, orange #f0883e, landed early in Phase 2 (row 2.14, ruling R38); 3.3 adds the rest | ~ (source ✅ Task 2; dots for every row in Task 5) | ✅ | 2026-11-17 · PR #29 `0d36976` → merge `03e4313` (QA APPROVE; main CI green; ADR 0018; real data 10/10 agree with `claude agents`) | D4, D18, T1 |
| 3.4 | Inbox order: repos Needs you → Finished → Working → Idle; in-repo order; rows move only on status change | ⏸ | ⏸ | — | D18, D21 |
| 3.5 | Repo row: "+" new chat, 🕘 session history (older + worktree chats; resume) | ⏸ | ⏸ | — | D28, D34 |
| 3.6 | Hide Changes, worktree create/delete, PR badges; keep FILES, Find Session, Fork | ✅ | ✅ | 2026-11-17 · PR #26 `f0e1bce` → merge `16a2d12` (QA APPROVE; main CI green; 8+3 tests parked in `test/dry/core/dormant/`) · fix PR #30 `976aed8` → merge `7f4a18a`: Files actions refused on Windows (drive-letter case), found by the testing walk | D19 |
| 3.7 | Hotkeys Ctrl+Alt+1–9 / 0 / R / F / O / Shift+1–9, latent (hover); confirm Ctrl+Alt+F beats Cursor's `list.find` | ⏸ | ⏸ | — | D12, D15, T13 |
| 3.8 | List keyboard: ↓/↑ highlight, Ctrl+↓/↑ open, Enter | ⏸ | ⏸ | — | D37 |
| 3.9 | Search box (Ctrl+Alt+R): repos, chats, Find Session | ⏸ | ⏸ | — | D24 |
| 3.10 | Brand: status-row activity icon, D17 colors; no sideways scroll, resizable | ~ (icons ✅; scroll/resize checked by E17 at close) | ✅ | 2026-11-17 · PR #27 `3ded3ef` → merge `c0814b0` (QA APPROVE; main CI green; circles only, no Claude mark, P24) | D17, D33 |

### Phase 4 — Windows and tabs (one window per folder)
**Goal:** Clicking anything in Pitwall lands you in the right Cursor window with the chat open in Claude's panel; files and tabs behave like Cursor.
**Entry gate:** Phase 3 ✅ (`v0.4.0`).
**Exit gate:** Live walk: from one window, open chats in 3 repos + 1 worktree; each lands in its folder's window, no duplicates, no blank chats; tag `v0.5.0`.
**Status:** ⏸ planned.
**Plan:** ⏸ to write

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 4.1 | Chats open in Claude's panel by default; link uses `vscode.env.uriScheme` (Agntree hardcodes `vscode://`) (was 3.1) | ⏸ | ⏸ | — | D3 |
| 4.2 | Click a chat → Pitwall focuses (or opens) its folder's window, then opens the chat there (was 3.2) | ⏸ | ⏸ | — | D35, D36, T5, T6 |
| 4.2b | Terminal ↔ chat identity without titles (finding F4, Phase 2 Task 6b): `renameWithArg` renames the terminal with keyboard focus, not the target, so title-based identity is fragile. Spike tagging Pitwall terminals (e.g. `creationOptions.env`) and whether revived terminals keep it on reload and quit, in Cursor and VS Code; if so, match on the tag and retire title matching (amends ADR 0009). Also: chats don't restore when a FILE is in front at quit, because VS Code and Cursor drop the revived terminals' names (editor limitation, reproduced without Pitwall); and a plain panel terminal in front can leave the last chat in front. Parked branch `phase2/task-6d-restore-file-front` has the e2e coverage (R48). Also (Phase 3 testing, T2 walk O2): after a Cursor restart where a chat's Claude wasn't restored, clicking its row left two tabs with the same `[shortId]` title, one live and one blank terminal (repro uncertain; evidence `phase3-t2-evidence\duplicate-fork-tabs.*`). Data points: the name drop is a race, not deterministic. Live, it kept the name once (UJ run 11 on `9765de0`) and lost it 3/3 (run 12 on `718068a`). In the e2e, 1/5 (`9765de0`) vs 0/6 (`718068a`) restores kept the names, and only failed runs carry the editor's "Attach to process failed" warning | ⏸ | ⏸ | — | Task 6b/6d reports, rulings R39, R48 |
| 4.3 | Repo click opens all its chats as tabs; chat clicks add tabs; never duplicates | ⏸ | ⏸ | — | D11, T6 |
| 4.4 | Match Claude tabs to chats reliably (titles are truncated, new chats all say "Claude Code") | ⏸ | ⏸ | — | T10 |
| 4.5 | Repo + branch under tabs: file tabs via label setting; find a way for Claude tabs, else window title + bottom bar (was 2.5) | ⏸ | ⏸ | — | D26, T9 |
| 4.6 | T18: a worktree entered mid-chat from main still opens in the main window (was 2.7) | ⏸ | ⏸ | — | D35 |
| 4.7 | FILES follows the window's folder; file click = normal tab; copy/paste across repos, "Copy to another repo", drag onto a repo row, `.env` gitignore check | ⏸ | ⏸ | — | D19, D22, D23, T14 |
| 4.8 | "+" starts the chat in that repo's window | ⏸ | ⏸ | — | D28, T15 |
| 4.9 | Pin, split, drag-reorder: confirm Cursor's own behaviour is untouched | ⏸ | ⏸ | — | D16, D32 |

### Phase 5 — Status + pop-ups
**Goal:** You find out the moment a chat needs you or finishes, without looking.
**Entry gate:** Phase 4 ✅ (`v0.5.0`).
**Exit gate:** Status matches ground truth across 3 live sessions; pop-ups fire for needs-you and finished, and a click lands on the right chat; tag `v0.6.0`.
**Status:** ⏸ planned.
**Plan:** ⏸ to write

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 5.1 | "Needs you" / "finished" from the sessions file + hooks (PermissionRequest, Notification, Stop) (was 4.2) | ⏸ | ⏸ | — | T1, T11 |
| 5.2 | Windows pop-up under Pitwall's own sender; click → right window + chat (was 4.3) | ⏸ | ⏸ | — | D20, T2 |
| 5.3 | Sound switches, off by default (was 4.4) | ⏸ | ⏸ | — | D27, T12 |
| 5.4 | Bottom-bar counts → jump list; Ctrl+Alt+0 = longest wait | ⏸ | ⏸ | — | D25 |
| 5.5 | First-run check: Windows notifications off / Focus assist on → offer `ms-settings:notifications` | ⏸ | ⏸ | — | tests doc T2 |

### Phase 6 — Package + launch
**Goal:** An installable `.vsix`, running in Sharif's daily Cursor, and the repo ready for contributors.
**Entry gate:** Phase 5 ✅ (`v0.6.0`).
**Exit gate:** `.vsix` installed in Cursor and used across real repos for a day; GitHub release `v1.0.0` with the `.vsix` attached.
**Status:** ⏸ planned.
**Plan:** ⏸ to write

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 6.1 | `vsce package` → `pitwall-1.0.0.vsix` (was 5.1) | ⏸ | ⏸ | — | D8 |
| 6.2 | Install via *Extensions: Install from VSIX…* (was 5.2) | ⏸ | ⏸ | — | `transcripts/inital_idea.md` |
| 6.3 | `gh release create v1.0.0` with the `.vsix` attached (was 5.3) | ⏸ | ⏸ | — | D8 |
| 6.4 | (Optional) Publish to Open VSX with `OVSX_PAT` (was 5.4) | ⏸ | ⏸ | — | `.env.example` |
| 6.5 | Protect `main` before inviting contributors: PR + 1 approving review + green CI, no force-push/deletion, admin-only bypass; `CONTRIBUTING.md`, `.github/CODEOWNERS`; verify a non-admin push is rejected (was 5.5) | ⏸ | ⏸ | — | D30 |
| 6.6 | LinkedIn launch post: problem first, then what Pitwall does, then the call for contributors; only after 6.5 (was 5.6) | ⏸ | ⏸ | — | Sharif 2026-11-16 |

### Phase 7 — After v1 (backlog)
**Goal:** Improvements agreed during spec work but deliberately left out of v1.
**Entry gate:** Phase 6 ✅ (`v1.0.0`).
**Exit gate:** Per row.
**Status:** ⏸ backlog.
**Plan:** ⏸ to write

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 7.1 | Instant search of the text inside chats (was 6.1) | ⏸ | ⏸ | — | D24 |
| 7.2 | Custom card panel for the sidebar, v2 look (was 6.2) | ⏸ | ⏸ | — | D10 |
| 7.3 | Remote Control per chat + its test T19 (was 6.3) | ⏸ | ⏸ | — | D38 |
| 7.4 | One-window hub (all repos' chats in one window), if Claude Code ever resumes chats from other folders | ⏸ | ⏸ | — | D35, tests doc recon |
| 7.5 | Feature request to Anthropic for per-session folders (parked by Sharif) | ⏸ | ⏸ | — | tests doc recon |

---

## §4 Open decisions still to make

| # | Decision | Deadline / Trigger | Phase impact |
|---|---|---|---|
| Q1 | ~~One-window vs jump-to-window~~ Resolved → D35 (one window per folder) | — | — |
| Q2 | ~~Keep Agntree's other agents?~~ Resolved → D9 | — | — |
| Q4 | ~~Spec canvas decisions 2–12~~ Resolved → D13–D21 (all locked 2026-11-16); 13–20 → D22–D29 | — | — |
| Q3 | Publish to Open VSX / Marketplace, or `.vsix` only | Phase 6 | 6.4 |

---

## §5 Reference index

- [Foundation plan](docs/superpowers/plans/2026-11-16-foundation.md): Phase 0 tasks, smokes, evaluation criteria
- [CLAUDE.md](CLAUDE.md): project rules, never-track list, versioning and tags
- [Agntree](https://github.com/subhashkhileri/agntree): upstream (MIT)
- **Spec canvas** (wireframes, buildability, status rules, decisions) + **Brand Book** page: https://claude.ai/artifact/XhYy9L747DwQzBsQDpaFF2
- [Reuse survey](docs/research/2026-11-16-reuse-survey.md): what code to lift from which repo, licenses, Windows spikes
- [Phase 1 plan](docs/superpowers/plans/2026-11-16-phase1-import-agntree.md): import Agntree, harness-modular, Claude-only
- [Assumption tests round 1](docs/research/2026-11-16-assumption-tests.md): T1–T16 live results (status, hooks, maximize, one-window, tabs, pop-ups)
- `transcripts/inital_idea.md`: origin conversation (local only, never committed)

---

## §6 Changelog

- **v0.1 · 2026-11-16.** Roadmap created. Phases 0–5 laid out from the origin conversation. Phase 0 rows 0.1–0.3 shipped. Versioning rule D8 locked (annotated tag on every bump).
- **v0.2 · 2026-11-16.** Phase 0 closed and tagged `v0.1.0`. Public repo at github.com/sharifamlani/pitwall. A whole-branch review found four Important issues, all fixed in `ab838e2`/`cdd42b3`/`0c295ae`: the env check passed with no template, the privacy check only caught top-level exact-case paths, the container's `node_modules` was root-owned, and the container could read the Claude login and `.packages/`. Phase 1 is unblocked. Machine note: Windows long paths are disabled (`LongPathsEnabled=0`), so enable them before Phase 1's npm install.
- **v0.3 · 2026-11-16.** Spec decisions D9–D29 locked. D22–D29 came from the prototype review: files open as tabs, copying between repos, one search box, clickable bottom-bar counts, repo under each tab, sound switches, repo-row "+" and Dismiss, and inherit-from-Cursor as a rule. New rows 2.4–2.5 (one-window tests for cross-repo side by side and tab labels), 4.4 (sound), and a Phase 6 backlog (6.1 instant in-chat search, 6.2 custom panel).
- **v0.4 · 2026-11-16.** D30: `main` stays open for Sharif and his Claude for now; row 5.5 protects it (PR + review + CI, admin-only bypass) before the contributor call, which moves to 5.6.
- **v0.5 · 2026-11-16.** D31–D33: tabs from several repos stay on screen together (repo click filters, "All open tabs" restores; amends D11), Cursor's own tab pinning, resizable sidebar with no sideways scroll. New row 2.6 tests the repo filter over a shared tab set.
- **v0.6 · 2026-11-16.** Assumption tests round 1. PASS: status files show "waiting" (T1), hooks fire in the panel (T11), maximize/restore editor groups in Cursor (T3), no duplicate tabs (T6), US keyboard (T4). FAIL: one window can't resume another repo's chat (T5) → Q1 reopened for Sharif. Blocked: pop-ups (Windows notifications off on this machine, T2/T12). Risk confirmed: tab-to-chat matching by title (T10). D34: session-history button per repo.
- **v0.7 · 2026-11-16.** Q1 resolved → D35: one window per folder, worktrees included (T17 also FAILED: a worktree chat won't open in the main repo window). D25 amended to a jump list; D31 superseded. Code recon recorded in the tests doc.
- **v0.8 · 2026-11-16.** D36: no repo needs to be open; Pitwall opens folder windows on demand (option A; terminal-mode single window rejected). Prototype rebuilt for one window per folder (canvas v36): window title + taskbar strip, worktree chats in their own windows, session-history button, bottom-bar jump list, no mixed tabs.
- **v0.8.1 · 2026-11-16.** D11 clarified by Sharif: a repo click opens all its chats as tabs; session clicks add tabs. Prototype demo data moved to main (matches Sharif's real usage); one worktree example kept.
- **v0.8.2 · 2026-11-16.** D26 restored (Sharif keeps "repo · ⎇ branch" under every tab; Claude tabs need test 2.5, fallback window title + bottom bar). New test row 2.7 (T18).
- **v0.8.3 · 2026-11-16.** D37: list keyboard (↓/↑ highlight, Ctrl+↓/↑ open, Enter). Prototype: split button and Split Right inside the window; outer toggle removed; bigger tab close button.
- **v0.8.4 · 2026-11-16.** D38: Remote Control per chat (tab/row right-click, Ctrl+Alt+M, 📡 mark). Test row 2.8 (T19) for the route.
- **v0.8.5 · 2026-11-16.** Remote Control (D38) moved to backlog row 6.3 per Sharif; test T19 moved with it.
- **v0.9 · 2026-11-16.** Phases re-cut around the live-test findings (§0.5 crosswalk): new Phase 2 Windows parity and Phase 3 Sidebar v1; old one-window test absorbed (answered by D35); Chat panel → Phase 4 Windows and tabs; Status + pop-ups → Phase 5; Package + launch → Phase 6 (`v1.0.0`); backlog → Phase 7. Every decision D9–D37 now has a home row. Windows notifications turned on on Sharif's machine (app toasts, Cursor, Focus assist off).
- **v0.9.1 · 2026-11-16.** D39: team flow (build → QA approves exact commit → lead merges → testing agent walks the real extension) and a LinkedIn progress post drafted at every phase close (Sharif approves each; 6.6 stays the launch post).
- **v0.9.2 · 2026-11-16.** Sharif: go for the autonomous build. D39 updated: posts go live on LinkedIn **and X** after Sharif approves each draft via the lead; kickoff post added to the series. Pitwall gets installed into Sharif's Cursor but windows are never reloaded by us.
- **2026-11-16 · Kickoff post live** (problem only, no product name; Sharif approved): [LinkedIn](https://www.linkedin.com/feed/update/urn:li:activity:7528288767141552128/) · [X](https://x.com/SharifAmlani/status/2122523753594978617). Later posts reply in the same X thread.
- **2026-11-16 · Phase 1 post live** (Sharif approved): [LinkedIn](https://www.linkedin.com/feed/update/urn:li:activity:7528304693920538624/) · [X reply 1](https://x.com/SharifAmlani/status/2122539952831607019). The repo-link posts wait for the Task 6 README refresh.
- **2026-11-16 · Repo-link posts live:** [LinkedIn](https://www.linkedin.com/feed/update/urn:li:activity:7528309644751077376/) · [X reply 2](https://x.com/SharifAmlani/status/2122544270699888801).
- **v0.10 · 2026-11-16 · Phase 1 closed, tag `v0.2.0`.** Agntree imported with history (credit kept), renamed to Pitwall 0.2.0, reorganized into `src/core/` + `src/harnesses/<id>/`, Claude-only via `enabled.json` + generated manifest, CI on Linux + Windows, privacy-hardened packaging, honest public README. 6 PRs, each QA-approved (≤1 fix round each); independent evaluator E1–E11 PASS on a fresh clone; testing agent 6 live walks, last 14/14; final review 0 Critical / 4 Important (1 fixed, 3 → Phase 2) / 9 Minor. Found along the way: a likely Windows worktree-path bug, two restore bugs, three flaky timing tests (all Phase 2). Posts: kickoff, Phase 1, repo link (LinkedIn + X). Phase 2 unblocked.
- **v0.11 · 2026-11-17.** Phase 2 plan approved by QA after two pre-flight rounds (fixes `c0dd3a5`, N1 `73ea80a`/`298f44d`). Wave A: Task 1 (Windows worktree paths, triage rows 9–12) merged, PR #8 → `704948f`; row 2.1 partial until Task 2 (PR #10) merges. Ruling R25: row 2 root cause was TTL expiry re-creating the window as "restored", not an in-flight check.
- **v0.12 · 2026-11-17.** Task 2 (triage row 2, ruling R25) merged → `8a1085f`, closing row 2.1. Task 7 (manifest refuses duplicates; I2 + M4) merged → `1830558`, closing row 2.8. QA found a fourth flaky test ("stopping a search ends the agent and everything it started, and keeps nothing", a JSON file read mid-write); added to row 2.7 and plan Task 5.
- **v0.13 · 2026-11-17.** Task 3 (POSIX-assumption tests portable; triage rows 1, 3–7) merged → `23623d2`; row 2.2 partial until Task 4. Windows failures on main: 1 (row 8, Task 6). UJ run 7: W1 + 4 worktree negatives PASS on Windows.
- **v0.14 · 2026-11-17.** Task 10 (Electron-safe launches, settled reveals, Phase 1 doc refresh) merged → `0095508`, closing row 2.4. Task 9 (enabled.json validation, disabled-harness searches kept, transitive architecture test, 2.5 pinned) merged → `0d520bb`, closing row 2.5. Windows failures on main: 1 (row 8). The 2.7 timing flakes now fail Linux runs often under load (main CI red once at `23623d2`).
- **v0.15 · 2026-11-17.** Task 8 merged → `131a2d5`, closing rows 2.9 and 2.10. The `.vsix` is built from a `files` allowlist: 41 paths from the real checkout, with `.env` and `.packages/` present, all allowlisted; `check_vsix` also fails on missing required files. CI has a `privacy` job (path gate, full-history gitleaks, tool tests, `check_vsix`) with SHA-pinned actions. Probe PR #14 (force-added `probe/dummy.key`) failed at the path gate (`LEAKED: probe/dummy.key`), then closed.
- **v0.16 · 2026-11-17.** Row 2.12 closed: UJ run 8 on `6adf95e` showed 0 "No tree item with id" lines across 5 starts (view hidden and visible) and a hidden-view start that reveals when the view opens; `ELECTRON_RUN_AS_NODE=1 scripts/cursor-cli.sh --version` → Cursor 3.14.27. Note for Phase 3 (D36): Cursor opens on the Explorer unless `pitwall.focusOnStartup` is on.
- **v0.17 · 2026-11-17.** Task 4 (Windows fake CLIs; triage rows 13–25, 27–29) merged → `b4c85bb`. Windows skips 17 → 9 (8 dormant opencode, 1 `/proc`), each with a reason. QA finding F2 becomes row 2.14 (ruling R30): the "needs you" poll never runs on Windows. Backlog for when D9 enables opencode: its spawns hit the same EINVAL.
- **v0.18 · 2026-11-17.** Task 12 merged: row 2.14 closed as a regression guard (R31; F2 did not reproduce through `ClaudeAgentsService`, whose poll already runs through `harnessInvocation`). Left in Phase 2: Task 6 (restore), Task 5 (de-flake), Task 11 (close).
- **v0.19 · 2026-11-17.** Task 5 merged → `dd0e1ea`, closing row 2.7: the four flaky tests were fixture races (two non-atomic writes, a SIGTERM handler registered late) and a default time budget; no product change. `scripts/repeat-tests.sh` gives 100-run proofs and fails closed when a pattern matches no test. Left in Phase 2: Task 6 (restore), Task 11 (close).
- **v0.20 · 2026-11-17.** Finding F3 (Task 6 build) is placed as Phase 3 row 3.0 (ruling R34): Cursor can echo a stale copy of `globalState` over a newer write, which can revert any Pitwall record. Phase 2 fixes it only for terminal PID records (R33a). R34 also accepts that Claude's chat panel can't be re-shown without focus after a background retitle (Phase 4 revisit).
- **v0.21 · 2026-11-17.** Task 6 merged → `1914f21`, closing rows 2.6, 2.11 and 2.13. Revived tabs resume after a quit on Windows PowerShell 5.1 (Smoke 7 15/15, incl. 5 under CPU load). Rulings R29–R34. The Windows dry suite is fully green (234 tests, 0 fail, 9 reasoned skips).
- **v0.22 · 2026-11-17.** Task 11 Steps 1–3 merged → `f8ea023`, closing row 2.3: CI windows runs all 234 dry tests (0 fail, 9 reasoned skips) and builds and checks the .vsix. R35: `vsce package` fails on Windows without `--allow-unused-files-pattern`, so `npm run package` carries it. The archive check fails closed on STRAY and MISSING entries. All 29 triage rows record their resolution. Row 2.14 reopened: the testing agent saw needs-you never appear live.
- **v0.23 · 2026-11-17.** Ruling R38: the needs-you row mark (orange, D17) is pulled forward from row 3.3 into Phase 2 row 2.14. Without it, needs-you is invisible except as a toast. The waiting-only rule is in plan wireframe F.
- **v0.24 · 2026-11-17.** Needs-you fix merged → `a82f0f5` (R36 + R38): a waiting chat is listed until answered or truly in front, including after a reload; one toast per wait; orange row mark. Row 2.14 closes after the testing agent re-walks S1 live.
- **v0.25 · 2026-11-17.** Finding F4 is placed as Phase 4 row 4.2b: terminal identity rests on tab titles, and the editor renames the focused terminal rather than the target, so Phase 2 contains it with check-and-undo (R39) and Phase 4 spikes a title-free identity.
- **v0.26 · 2026-11-17.** Needs-you timing fix merged → `3d0bd98` (R40/R41): a toast fires only if the chat was not in front after the prompt appeared (anchored on the transcript write, clamped to the last no-wait poll); no stale re-mark after a deny. Row 2.14 closes after the live S1 re-walk, which waits for Task 6b.
- **v0.27 · 2026-11-17.** Task 6b merged → `68ad3d2`. Root cause: `renameWithArg` renames the keyboard-focused terminal, not the target. Fixes: check-and-undo renames with event-triggered retries; no second terminal per chat; activation never waits on terminals; the hidden-view reveal is deferred; a leading space guards resume lines typed into revived tabs (R42); Pitwall's own background shows don't count as the user looking (R43). Smoke 7 15/15 plus QA 5/5. Finding F4 (title-free identity) is row 4.2b.
- **v0.28 · 2026-11-17.** Main CI green again at `dad160c` (hotfix PR #24: transcript mtime compared at ms resolution; main had been red since `3e6434a` on a same-ms race the local runs missed). PR #23 merged earlier (R45: a wait pending at activation never toasts). Rule added: no merge without green PR checks, and main CI confirmed after every merge. R46: the command-start focus yank is Claude Code's IDE integration (out of scope). R1-x (restore front-tab steal) confirmed as Pitwall's, fix in Task 6c.
- **v0.29 · 2026-11-17.** Task 6c merged → `ae775fc` (R44). Restore puts back the group's real front tab, not `activeTerminal`, which differs in Cursor. Reveals wait for render and hold refreshes, so no more "No tree item". Pitwall's own shows never select or reveal. e2e asserts both; Smoke 7 10/10 (builder 5 + QA 5). Main CI green.
- **v0.30 · 2026-11-17.** Sharif: move off the terminal path as fast as possible (the product is Claude's panel). R48: terminal restore stops in Phase 2. Restore with a file in front at quit fails because VS Code itself drops the revived terminals' names (reproduced with no Pitwall) → known issue, Phase 4 row 4.2b. R1(b) is timed from Pitwall's activation (lead, delegated).
- **v0.31 · 2026-11-17 · Phase 2 closed, tag `v0.3.0`.** Independent evaluator: E1–E13 + E15 PASS (round 2, after R49 updated the packaged count to 49). Windows: 0 dry-test failures (was 12), full suite + `.vsix` build on Windows CI, privacy gate. Restore after quit/reload, needs-you (orange mark, Ctrl+Alt+N, one pop-up per unseen wait). Rulings R20–R50 in the plan. Unblocked: Phase 3. Deferred: 3.0 (F3), 4.2b (F4 + the file-in-front editor race), the opencode Windows spawn (when D9 enables it). Development paused by Sharif after this release.
- **v0.32 · 2026-11-17.** Phase 2 posts live, approved by Sharif (hook B, orange needs-you image): LinkedIn https://www.linkedin.com/feed/update/urn:li:activity:7528489595731095552/ · X (reply 3 in the thread) https://x.com/SharifAmlani/status/2122724368136442262. Evaluator final: E1–E15 PASS. Development paused.
- **v0.33 · 2026-11-17.** Sharif resumed development. Phase 3 (Sidebar v1) planning started; plan `docs/superpowers/plans/2026-11-17-phase3-sidebar-v1.md`.
- **v0.34 · 2026-11-17.** Phase 3 plan passed QA pre-flight after one revision round (7 blocking findings fixed: wait-drop, first-run "finished", duplicate repos, wave conflicts). Rulings P1–P20, criteria E1–E18. Waiting on Sharif's go.
- **v0.35 · 2026-11-17.** Row 3.6 ✅ (PR #26 → `16a2d12`): Changes view, worktree create/delete/merge/rebase, PR badges and fork-with-changes hidden; FILES collapsed; docs marked "hidden in v1". S1: F3 not reproduced live on non-PID keys (overlay generalised anyway); new finding P23 (other window's list doesn't redraw) → Task 5.
- **v0.36 · 2026-11-17.** Row 3.10 icons merged (PR #27 → `c0814b0`): D17 status dots (circles only), "new" is a dashed grey ring (P24, brand book), four-dot activity icon. PR #28 (T1) reworked to write stamps (P25) after QA caught a lost-write race.
- **v0.37 · 2026-11-17.** Row 3.3 source merged (PR #29 → `03e4313`): live status read from `~/.claude/sessions/*.json` (2–3 ms vs ~0.7 s for the CLI), `claude agents` kept as fallback (ADR 0018). Wave B (T3 discovery, T5 rows) waits on T1 (PR #28).
- **v0.38 · 2026-11-17.** Row 3.0 ✅ (PR #28 → `d12c906`): every storage collection protected by write stamps; newest change wins, outdated copies can't revert it (3 QA rounds). Wave B started (T3, T5). Testing found an inherited Windows bug (Files actions refused, drive-letter case) → fix PR #30.
- **v0.39 · 2026-11-17.** Fix PR #30 → `7f4a18a` (rides on row 3.6, FILES kept): on Windows every Files action on a selected row was refused because the "inside this repo" check compared drive letters case-sensitively (inherited since v0.3.0); New File on a file row now creates next to it.
