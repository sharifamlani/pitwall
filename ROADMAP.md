# Pitwall — Step-by-Step Build Plan (LIVING)

> **Single source of truth. Update checkboxes as work lands. Status flips one cell.**
>
> This is CANON. All forward direction flows from here. Plan-creation order in [`docs/superpowers/plans/`](docs/superpowers/plans/) follows §3 Phase order. Before creating any new plan, verify the work has a Phase in §3. If it doesn't, propose a §3 edit first.

> v0.8.2 · 2026-11-16

---

## §0 You are here

- **Current phase:** Phase 1 — Import Agntree
- **Current step:** 1.1 — write the Phase 1 plan (merge Agntree with history via an `upstream` remote)
- **Last update:** 2026-11-16
- **Next action:** Sharif verifies the updated prototype (canvas v36). Then fold D9–D36 + the assumption-test results into the Phase 1 plan (Sharif reviews), then start the import.

Update §0 every working session. Any commit touching ROADMAP edits §0.

---

## §1 The North Star

**What Pitwall is.** A Cursor / VS Code extension that shows every Claude Code session across all your repos in one sidebar. Each session has a live status dot (working / needs you / finished / idle). Clicking a session opens it in the official Claude Code extension's chat panel, not a terminal. Source: `transcripts/inital_idea.md` (local).

**Who it serves.** A developer running Claude Code in several repos at once, across several Cursor windows, who loses minutes to an hour each time a session finishes or needs approval unnoticed. User zero is Sharif, on Windows.

**What v1 done delivers.** An installable `.vsix` (`v1.0.0`). Its sidebar lists repos and sessions with status dots. A click opens the chat panel directly, and Windows pop-ups fire on "finished" and "needs you". It is free, MIT, and works on native Windows.

**What later feels like.** You never hunt for windows. Ideally every repo's chat lives in one Cursor window (decided in Phase 2), and the session that has waited longest is one key away.

---

## §2 Locked architectural decisions

| # | Decision | Source |
|---|---|---|
| D1 | Runs inside Cursor as a second extension next to the official Claude Code extension; never copies, embeds or modifies it | `transcripts/inital_idea.md` (license: all rights reserved) |
| D2 | Fork Agntree (MIT), keeping its LICENSE line and a README credit; don't build from scratch | `transcripts/inital_idea.md` |
| D3 | Open sessions via `vscode://anthropic.claude-code/open?session=<id>` / `claude-vscode.editor.open` | `transcripts/inital_idea.md` |
| D4 | Status dot colors: blue = working, orange = needs you, green = finished, gray = idle | wireframe artifact `XhYy9L747DwQzBsQDpaFF2` |
| D5 | Name is Pitwall; no "Claude" in the name | `transcripts/inital_idea.md` |
| D6 | Extension = TypeScript/npm at the repo root; Python dev tooling = `tools/` via Poetry | [foundation plan](docs/superpowers/plans/2026-11-16-foundation.md) |
| D7 | Public repo; `.packages/`, `transcripts/`, `.claude/`, `.env` are never tracked | [foundation plan](docs/superpowers/plans/2026-11-16-foundation.md) |
| D8 | SemVer annotated tags on every version bump; Phase N closes as `v0.(N+1).0`, Phase 5 = `v1.0.0` | Sharif 2026-11-16, [CLAUDE.md](CLAUDE.md) |
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
| D24 | Search (Ctrl+Alt+R), one box: v1 = repos + chats by name/branch (instant) + Agntree's Find Session (agent reads transcripts). Instant text search inside chats → row 6.1 | Sharif 2026-11-16, decision log 15 |
| D25 | Bottom-bar counts are buttons: click "N need you" (or working / finished) → a list of those sessions; Pitwall jumps you to each in turn (Next ▸). Side by side only within one folder (amended by D35) | Sharif 2026-11-16, decision log 16 |
| D26 | Every tab shows its repo + branch underneath (Sharif: keep). File tabs: Cursor's tab-label setting. Claude's chat tabs belong to Claude Code: test 2.5 must find a way; fallback is the window title + bottom bar showing "repo · ⎇ branch" | Sharif 2026-11-16, decision log 17 |
| D27 | Sound: off by default (refines D20). Two switches, "needs you" and "finished"; when on, the Windows pop-up plays the system sound. Bell in the sidebar header + Settings | Sharif 2026-11-16, decision log 18 |
| D28 | Repo rows: no printed hotkeys; a "+" on each repo starts a new Claude Code chat there; the header keeps only the folder icon (add repo). Right-click → "Dismiss from Pitwall" hides the repo (nothing on disk changes); it returns when re-added or when a new session starts in it | Sharif 2026-11-16, decision log 19 |
| D29 | Principle: inherit everything Cursor already does (tabs, editor, menus, quick-pick box, keybinding editor, themes); never rebuild it. Canvas board "What Pitwall gets from Cursor" | Sharif 2026-11-16, decision log 20 |
| D30 | Until contributions open, `main` stays unprotected so Sharif and his Claude push directly. Before the contributor call goes out (5.6), `main` gets a GitHub ruleset: changes only through a pull request with 1 approving review and passing CI, no force-push or deletion; only the repo admin (Sharif, and his Claude using his login) may bypass | Sharif 2026-11-16 |
| D31 | ~~Tabs from several repos at once~~ (superseded by D35): session clicks keep adding tabs from any repo, all on screen and each labelled with its repo; clicking a repo name filters to that repo; an "All open tabs" row brings everything back; switching never closes tabs. Depends on the one-window test (2.6) | Sharif 2026-11-16, decision log 21 |
| D32 | Pin tabs with Cursor's own Pin Tab (right-click → Pin, Ctrl+K Shift+Enter): pinned tabs sit left and survive "Close Others" | Sharif 2026-11-16, decision log 22 |
| D33 | Sidebar never scrolls sideways (rows truncate with "…"); its edge drags to resize or hide, and the line above FILES drags to resize it, like any Cursor panel | Sharif 2026-11-16, decision log 23 |
| D34 | Each repo row gets a session-history button (clock) next to "+": lists every past Claude Code chat in that repo, beyond the 14-day list, and resumes the one you pick in Claude's panel | Sharif 2026-11-16 |
| D35 | **One window per folder (v1)** — the "one-repo-per-window rule". Claude's panel only resumes chats from its window's folder, and a git worktree counts as its own folder (tests T5, T17). Every window runs the same Pitwall sidebar; clicking a chat from another repo or worktree brings that folder's window forward (opening it if needed) with the chat open. A window's tabs only ever hold its own folder's chats. Supersedes the cross-repo parts of D15, D25, D26 (chat tabs), D31 | Sharif 2026-11-16 · [tests](docs/research/2026-11-16-assumption-tests.md) |
| D36 | **No repo needs to be open.** You open one Cursor window; Pitwall reads Claude Code's own files (`~/.claude/sessions`, `~/.claude/projects`) to show every repo, chat, status, history and pop-up. Windows for other folders are opened by Pitwall on demand (D35), never by hand. Option "everything in one window via terminal mode" rejected (that is what a switchboard does) | Sharif 2026-11-16 |
---

## §3 The Checklist — every Phase from start to v1.0.0

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

### Phase 1 — Import Agntree
**Goal:** Agntree's code in this repo, with its history and MIT credit kept, building as Pitwall.
**Entry gate:** Phase 0 ✅ (`v0.1.0`).
**Exit gate:** `npm ci && npm run compile && npm test` green on host and in the container; tag `v0.2.0`.
**Status:** ⏸ planned.
**Plan:** ⏸ to write

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 1.1 | Add `upstream` remote → `subhashkhileri/agntree`; merge with `--allow-unrelated-histories` | ⏸ | ⏸ | — | D2 |
| 1.2 | Resolve root collisions (README, ROADMAP, `.gitignore`, LICENSE). Agntree tracks `.claude/`, which `check_private_paths` blocks: drop it or move it | ⏸ | ⏸ | — | D2, D7 |
| 1.3 | Rename to Pitwall in `package.json` (name, displayName, publisher); `version` → `0.2.0` | ⏸ | ⏸ | — | D5, D8 |
| 1.4 | `npm ci`, compile, dry tests green; add an npm step to `verify-foundation.sh` | ⏸ | ⏸ | — | D6 |

### Phase 2 — One-window test
**Goal:** Decide whether every repo's chat can live in one Cursor window, or a click must jump to that repo's window.
**Entry gate:** Phase 1 ✅.
**Exit gate:** Written verdict with evidence; tag `v0.3.0`.
**Status:** ⏸ planned.
**Plan:** ⏸ to write

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 2.1 | Multi-root workspace with 3 repos; open a session per repo via the link handler; record which folder each runs in | ~ | — | spike 2026-11-16: **FAIL**, another repo's chat opens as a new empty chat in the window's folder ([tests](docs/research/2026-11-16-assumption-tests.md) T5) | `transcripts/inital_idea.md` |
| 2.2 | Check the "already-open session opens a duplicate tab" bug | ~ | — | spike 2026-11-16: PASS, re-open focuses the existing tab, even in another window (T6) | `transcripts/inital_idea.md` |
| 2.3 | Record the verdict: one-window vs jump-to-window | ⏸ | ⏸ | — | — |
| 2.4 | Open two sessions from different repos side by side in one window (the "N need you" view) | ⏸ | ⏸ | — | D25 |
| 2.5 | Can Claude Code chat tabs show their repo (description, tooltip, title)? Record what is possible | ⏸ | ⏸ | — | D26 |
| 2.6 | Keep tabs from several repos open together, then show only one repo's tabs and switch back without closing any (repo filter over a shared tab set) | ⏸ | ⏸ | — | D31 |
| 2.7 | T18: a chat started in the main folder that creates or enters a worktree mid-chat (Claude's own worktree feature) still opens in the main window | ⏸ | ⏸ | — | D35 |

### Phase 3 — Chat panel by default
**Goal:** Clicking a session opens the Claude Code chat panel directly, with no terminal step.
**Entry gate:** Phase 2 verdict.
**Exit gate:** Playwright/visual check: click → chat panel opens for the right session; tag `v0.4.0`.
**Status:** ⏸ planned.
**Plan:** ⏸ to write

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 3.1 | Find Agntree's "move to chat panel" code path; make it the default for Claude Code sessions | ⏸ | ⏸ | — | D3 |
| 3.2 | Handle the cross-window case per the Phase 2 verdict | ⏸ | ⏸ | — | Phase 2 |

### Phase 4 — Status dots + Windows pop-ups
**Goal:** Live working / needs-you / finished / idle dots, plus Windows notifications driven by Claude Code hooks.
**Entry gate:** Phase 3 ✅.
**Exit gate:** Status matches ground truth across 3 live sessions; pop-up fires on Stop and Notification; tag `v0.5.0`.
**Status:** ⏸ planned.
**Plan:** ⏸ to write

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 4.1 | Map Agntree's status labels to the D4 colors | ⏸ | ⏸ | — | D4 |
| 4.2 | Hook-driven "needs you" on native Windows | ⏸ | ⏸ | — | `transcripts/inital_idea.md` |
| 4.3 | Windows toast on finish / needs-you; clicking it focuses the session | ⏸ | ⏸ | — | `transcripts/inital_idea.md` |
| 4.4 | Sound switches (needs you / finished), off by default; toast plays the system sound when on | ⏸ | ⏸ | — | D27 |

### Phase 5 — Package + install
**Goal:** An installable `.vsix`, running in Sharif's daily Cursor.
**Entry gate:** Phase 4 ✅.
**Exit gate:** `.vsix` installed in Cursor and used across real repos for a day; GitHub release `v1.0.0` with the `.vsix` attached.
**Status:** ⏸ planned.
**Plan:** ⏸ to write

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 5.1 | `vsce package` → `pitwall-1.0.0.vsix` | ⏸ | ⏸ | — | D8 |
| 5.2 | Install via *Extensions: Install from VSIX…* | ⏸ | ⏸ | — | `transcripts/inital_idea.md` |
| 5.3 | `gh release create v1.0.0` with the `.vsix` attached | ⏸ | ⏸ | — | D8 |
| 5.4 | (Optional) Publish to Open VSX with `OVSX_PAT` | ⏸ | ⏸ | — | `.env.example` |
| 5.5 | Protect `main` before inviting contributors (D30): ruleset requiring a PR + 1 approving review + green CI, blocking force-push and deletion, bypass for the admin only; add `CONTRIBUTING.md` (fork → branch → PR) and `.github/CODEOWNERS` (@sharifamlani). Verify: a non-admin test account's direct push to `main` is rejected | ⏸ | ⏸ | — | D30 |
| 5.6 | LinkedIn launch post: opens with the problem (idle sessions unnoticed in other windows), then what Pitwall does, then asks developers to contribute to the MIT repo. Posts only after 5.5 | ⏸ | ⏸ | — | Sharif 2026-11-16 |


### Phase 6 — After v1 (backlog)
**Goal:** Improvements agreed during spec work but deliberately left out of v1.
**Entry gate:** Phase 5 ✅ (`v1.0.0`).
**Exit gate:** Per row.
**Status:** ⏸ backlog.
**Plan:** ⏸ to write

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 6.1 | Instant search of the text inside chats (index the transcripts; results in the Ctrl+Alt+R box) | ⏸ | ⏸ | — | D24 |
| 6.2 | Custom card panel for the sidebar (v2 look) | ⏸ | ⏸ | — | D10 |

---

## §4 Open decisions still to make

| # | Decision | Deadline / Trigger | Phase impact |
|---|---|---|---|
| Q1 | ~~One-window vs jump-to-window~~ Resolved → D35 (one window per folder) | — | — |
| Q2 | ~~Keep Agntree's other agents?~~ Resolved → D9 | — | — |
| Q4 | ~~Spec canvas decisions 2–12~~ Resolved → D13–D21 (all locked 2026-11-16); 13–20 → D22–D29 | — | — |
| Q3 | Publish to Open VSX / Marketplace, or `.vsix` only | Phase 5 | 5.4 |

---

## §5 Reference index

- [Foundation plan](docs/superpowers/plans/2026-11-16-foundation.md): Phase 0 tasks, smokes, evaluation criteria
- [CLAUDE.md](CLAUDE.md): project rules, never-track list, versioning and tags
- [Agntree](https://github.com/subhashkhileri/agntree): upstream (MIT)
- **Spec canvas** (wireframes, buildability, status rules, decisions) + **Brand Book** page: https://claude.ai/artifact/XhYy9L747DwQzBsQDpaFF2
- [Reuse survey](docs/research/2026-11-16-reuse-survey.md): what code to lift from which repo, licenses, Windows spikes
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
