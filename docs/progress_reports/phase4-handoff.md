# Phase 4 handoff: Windows and tabs (v0.5.0)

Release files prepared 2026-11-18. The tag and the ROADMAP flip come from the lead after the independent evaluator passes.

Scorecard: pending the evaluator (docs/progress_reports/phase4-scorecard.md).

## Summary

Phase 4 makes Pitwall a one-window-per-folder tool. A click on any chat lands in its folder's Cursor window (opened if needed) and shows the chat in Claude Code's own chat panel with its history. A repo click opens its newest chats as tabs, Pitwall knows which tab is which chat, and every window shows its repo and branch. FILES follows each window's folder, with copy and paste between repos.

## What shipped

| Row | What | PR |
|---|---|---|
| 4.1 | Chats open in Claude's panel by default; Ctrl+Down keeps the list focused | #47 |
| 4.2 | A click on any chat routes to its folder's window (window registry and handoff inbox, then the router) | #46, #51 |
| 4.2b | Terminal tag spike: no-go, title matching stays (ADR 0009 amended) | #48 |
| 4.3 | A repo click opens up to 8 recent chats, plus "Open the other N chats"; side by side up to 4 panes | #52 |
| 4.4 | Reliable tab-to-chat matching, and the outside-terminal guard | #52 |
| 4.5 | Bottom bar `repo · branch` (⧉ for a worktree) | #44 |
| 4.6 | A chat that moved into a worktree opens in the window of the folder its transcript is filed under | #51 |
| 4.7 | FILES across windows, Copy to another repo, drag onto a repo row, `.env` gitignore offer | #50 |
| 4.8 | "+" starts the chat in that repo's window | #51 |
| 4.9 | Pin, split and reorder left untouched (partial: real drag pending, E12) | #52 |

Also merged: #45 (v0.4.1, drive-letter case fix on Windows) and #49 (load-tolerant event-loop test asserts). Dev commands `pitwall.dev.dumpState` and `pitwall.dev.traceTabs` ship for bug reports. User-facing detail is in [CHANGELOG.md](../../CHANGELOG.md).

## Known issues

- A chat that moved into a worktree keeps its row under the main repo, though it opens in the worktree's window.
- A window with several folders open is not found when looking for a chat's window; the chat opens in the current window.
- Text typed into a new chat before it gets its name can land before the rename.
- A terminal flickers for about a quarter of a second when a chat opens in one.
- A click on a chat that has no transcript yet and belongs to another window's folder does nothing visible; Pitwall won't start it here, and says nothing.
- The needs-you check turns off after a single 5-second timeout.
- If a chat's tab takes longer than 5 seconds to appear, a Claude tab you open in the next 30 seconds can be bound to that chat.
- A chat started with "+" shows no "· open" on its row until you click it.
- Side by side waits a full second once before it splits.
- On a slow machine the lookup of a terminal's parent process can take over 2 seconds, so the chat opens in the current window.
- A default-titled tab opened within 2 seconds of closing another can take that tab's chat binding.
- After a cold click, the "Open the other N chats" pick stays open but has no keyboard focus; the mouse works.
- The drag checks (file onto a repo row, tab reorder) need a human hand and are not covered by automated tests.
- Pop-ups still only cover chats you have open (Phase 5).

## Follow-ups

- Add the QA probes for same-title tabs by place and for re-send then copy as tests.
- Make the raw event-loop block assert in `claude-repo-discovery.test.ts` use `assertNoLongBlock`.
- Give the "Open the other N chats" pick keyboard focus on a cold click.
- Quiet the repeated re-sent model lines in the `traceTabs` output.
- Make the agents service pick up changes without a restart (Phase 5).
- Sort handoff claims by send order so a race test can't flake.
- Re-home a moved chat's row under its worktree.

## Next phase

Phase 5, Status and pop-ups: a pop-up for every session that needs you (not only open chats), sound and counts on the bottom bar, and a needs-you jump list. "Open chat" in a pop-up reuses this phase's router. Entry gate: Phase 4 closed with `v0.5.0`. See ROADMAP §3.
