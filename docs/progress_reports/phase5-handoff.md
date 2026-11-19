# Phase 5 handoff: Status and pop-ups (v0.6.0)

Release files prepared 2026-11-19 (a Thursday). The tag and the ROADMAP flip come from the lead after the independent evaluator passes.

Scorecard: pending the evaluator (docs/progress_reports/phase5-scorecard.md).

## Summary

Phase 5 gives every listed session a status and tells you when one needs you. Status comes from Claude Code's sessions file alone, so Pitwall writes nothing under `~/.claude`. On Windows a pop-up under Pitwall's own name appears for each change, once across all windows, and "Open chat" opens the chat in the window for its folder. Sounds are off by default, the bottom bar counts chats by status and jumps to them, and a first-run check warns if Windows would hide the pop-ups.

## What shipped

| Row | What | PR (merge sha) |
|---|---|---|
| — (T1, v0.5.0 known issue) | The first Ctrl+↓ onto a restored panel chat keeps list focus (the v0.5.0 known issue) | #58 (`5c2d60a`); follow-up for a re-sent tab model #62 (`ae19051`) |
| 5.1 T2 | Status for every listed session from the sessions file; a new chat is listed from its first turn | #59 (`2e028a8`); live fix, duplicates merge across windows, #64 (`11093f3`) |
| 5.2 T3 | Windows pop-up under Pitwall's sender; click goes through the router to the right window | #60 (`6f97e19`); release-walk fix, click on a panel chat with no matched tab, #68 (`b3abaab`) |
| 5.3 T4 | Sound switches (off by default), Repos-header bell, Test sound | #65 (`01a9b95`) |
| 5.4 T5 | Bottom-bar counts, jump list, `Next ▸`, Ctrl+Alt+0 = longest wait | #61 (`c2d1f06`) |
| 5.5 T6 | First-run Windows notifications check, "Pitwall: Check Windows Notifications" | #63 (`8d5e1d0`); first-run fix #66 (`5f27f95`) |
| — (T7, close) | Release docs: CHANGELOG 0.6.0, README, version 0.6.0, this handoff | this PR |

Also shipped: "Pitwall: Remove Pop-up Registration" and the `vscode:uninstall` script that removes the HKCU entry. User-facing detail is in [CHANGELOG.md](../../CHANGELOG.md).

## Live checks

Release candidate: main `b3abaab`, CI green.

- Smokes S1 to S8: PASS. S1 measured the restored-tab focus steal; S2 showed the sessions file carries every status needed; S3 to S5 and S8 proved the sender, click and router path.
- T1 re-walk on `ae19051`: Down moves 3/3, click inside the hold 0/3 (Q51).
- T2 re-walk after `11093f3`: E2 30/30 per window, E4 12/12. E3 pop-up lag was 8/12 under about 97% CPU load, so it is re-measured on a quiet machine in the release walk.
- Rows 5.3 to 5.5 walked clean live (E7 sound, E10 first-run).
- Release walk on `5f27f95`: W1 to W9 and the ground-truth row PASS, except W4(b): a pop-up click on a panel chat whose tab Pitwall hadn't matched warned "running in another window or terminal" and opened nothing. Fixed in #68 and re-walked on `b3abaab`. On a quiet machine every pop-up showed within 1.8 s (12/12).
- Still open: the evaluator's E1 to E18, and Sharif's one real pop-up click on the default profile (Q49).

## Rulings

- Q45: status from the sessions file only; no hooks in v0.6.0 (opt-in hooks became ROADMAP row 7.6).
- Q46: pop-ups carry Pitwall's name through one per-user HKCU AppUserModelId key, written once per activation, removable.
- Q47: the bell may write `pitwall.sound.*` to user settings, only on your click.
- Q49: `cursor://` belongs to the default profile, so walk clicks are simulated with the retargeted command; Sharif clicks one real pop-up after `v0.6.0` installs.
- Q50: the live criteria run on extension panel chats; a CLI chat appears only in the terminal cases.
- Q51: E11 checks list focus at 1.2 s; the 0.8 s hold stays, and a click into the chat inside it is pulled back once (known limit).

## Known issues

- A click into a just-restored chat within about 0.8 s of the first Ctrl+↓ after launch is pulled back to the list once; click again (Q51).
- Ctrl+Alt+0 and `Next ▸` can re-open the chat already in front when it is a restored tab whose title other chats share.
- Cursor asks "Allow … to open this URI?" on every pop-up click until "Do not ask me again" is ticked.
- A pop-up click can take several seconds on a busy machine, mostly Cursor starting its link handler.
- Pop-up clicks always open in Cursor's default profile; a Cursor started with a separate `--user-data-dir` doesn't receive them.
- A chat running a background agent shows "working" until the agent's result is handled.
- The pop-up registration and the first-run "already asked" marker are shared by all Cursor profiles of the Windows user; removing the registration in one profile turns pop-ups into in-window messages elsewhere until the next start re-registers.
- Pop-ups appear about 1.5 to 3 s after the change (PowerShell start-up per pop-up), slower on a loaded machine.
- Downgrading to an older version shows merged duplicate chats again (nothing was deleted).
- A pop-up click on a chat running in a multi-folder window, or in a Cursor window without Pitwall, shows the "running in another window" warning instead of raising that window. The same happens, rarely, for a Pitwall terminal chat restored in the receiving window but not yet matched. It fails safe: never a second process.

## Follow-ups

Phase 6:

- First installable `.vsix` and GitHub release with the file attached; check the package contents with `out/uninstall.js` included.
- `test/dry/.build/terminal.test.cjs` runs about 52 s against its 60 s per-file limit and fails `verify.sh` on a loaded machine: split it or raise its limit.

Phase 7:

- Opt-in Claude Code hooks (row 7.6) if the sessions file proves too slow or misses a status, such as the background-agent "working" case.
- Cut pop-up latency by keeping one PowerShell process alive instead of starting one per pop-up.
- Share the pop-up registration state per profile, so removing it in one profile doesn't affect the others.
- Find a way to tell which session a restored tab with a shared title belongs to, for Ctrl+Alt+0 and `Next ▸`.
- The remaining Phase 4 flake is `runClaimed opens chats one at a time`; #60 already sorted claims by send order.
