# Phase 3 handoff: Sidebar v1, repos and sessions (v0.4.0)

Release files prepared 2026-11-17. The tag and the ROADMAP flip come from the lead after the independent evaluator passes.

Scorecard: docs/progress_reports/phase3-scorecard.md (independent evaluator, release sha `ce03203`: E1–E19 19 PASS / 0 FAIL).

## What shipped

| PR | Merge | What |
|---|---|---|
| #26 | `16a2d12` | Task 4: hide Agntree extras (worktree create/delete, PR badges, Changes) |
| #27 | `c0814b0` | Task 6: status icons (four dots, status-row activity icon) |
| #28 | `d12c906` | Task 1: storage overlay for every collection (write stamps) |
| #29 | `03e4313` | Task 2: live status from `~/.claude/sessions` (ADR 0018) |
| #30 | `7f4a18a` | Fix: FILES actions on Windows (drive-letter case) |
| #31 | `6698045` | Task 3: repos discovered from `~/.claude`, dismiss (ADR 0019) |
| #32 | `af1bd26` | Task 5: repo to session rows, four statuses, inbox order |
| #33 | `6e71472` | Task 7: repo row, history, menus, session inline actions |
| #34 | `7e1cbab` | Task 8: hotkeys and list keyboard |
| #35 | `2be4ecb` | Fix: import sessions started from a lowercase drive |
| #36 | `8815d82` | Task 9: search box (Ctrl+Alt+R) |
| #37 | `1522010` | Fix: fast first render, no false empty state (E16) |
| #38 | `4648997` | Polish: discovery clock, matching ages, Remove wording, star mark, lookup retry |

User-facing detail is in [CHANGELOG.md](../../CHANGELOG.md).

## What doesn't work yet

- **Phase 4:** chats open in a terminal tab, not Claude Code's chat panel; no window-per-folder or all-chats-as-tabs (rows 4.2, 4.3); Ctrl+Down/Enter on a repo only expands and selects it.
- **Phase 5:** pop-ups for every session (toasts stay limited to open chats); the header sound bell.
- Hidden, code kept dormant: worktree create/delete, PR badges, Changes view.

## Known issues

- The needs-you badge shows on Cursor's vertical activity bar, not the default horizontal icon row.
- Chats open in a terminal tab until Phase 4.
- Native list limits accepted for v1 (plan P22): the status word uses Cursor's muted description colour, and the selected row uses Cursor's selection colour.
- Native hover-text limits accepted (plan P26): the repo row "+" and 🕘 hover text say "this repo" rather than the repo's name; the FILES header has no hover text.
- After Ctrl+↓/↑ opens a chat, keyboard focus moves into the chat, so a second Ctrl+↓ needs a click back in the list. Fix planned in Phase 4 (row 4.1).
- On a first start, when discovery adds repos with sessions, the importer writes chats one at a time (a ~0.25 s extension-host pause after the list appears). Batching is a follow-up.
- Inherited from Phase 2: Claude Code pulls its terminal to the front; quitting with a file in front can drop terminal chats (Phase 4 row 4.2b).

## Rulings made

Full text in `docs/superpowers/plans/2026-11-17-phase3-sidebar-v1.md` (P1-P26, criteria E1-E19). In short:

- **P1-P3, P13, P17:** discovered repos are stored with `origin: 'discovered'`; a dismissal returns only when a session starts after it; 14-day retention; all discovered repos are added on first run; one deterministic id per root.
- **P4-P6, P16:** live status from `~/.claude/sessions`, with `claude agents --json` as the per-session fallback; rows sort by when they entered their status, so order changes only on a status change; every chat has a "seen" baseline so old chats don't show "finished".
- **P7-P9, P18:** the branch comes from the worktree record; the worktree level leaves the view only; hidden extras stay as dormant code; manual repo order is removed.
- **P10-P12, P20:** Ctrl+Alt+F toggles FILES; Ctrl+Alt+1-9 reveal and select the repo (again opens its next chat); Ctrl+Alt+Shift+1-9 and Ctrl+Alt+O open the repo in its own window.
- **P19, P21-P22:** the header keeps search and folder icons; native list limits accepted.
- **P23, P25:** a window redraws on focus and on each 60 s scan; conflicts between windows resolve by write stamps.
- **P24:** claude status icons are circles only, with no brand mark and no clay colour.
- **P5, P14, P15:** toasts stay on open chats; no header sound bell; the live walk on the real `~/.claude` is read-only.

## Next phase

Phase 4, Windows and tabs (ROADMAP rows 4.1–4.7, including 4.2b): clicking a chat lands you in the right Cursor window with it open in Claude Code's chat panel. See ROADMAP §3.
