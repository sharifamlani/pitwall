# Changelog

All notable changes to Pitwall are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-11-19

Status and pop-ups (ROADMAP Phase 5).

### Added

- Every listed session now shows its status (needs you, working, finished, idle), read from Claude Code's sessions file. A new chat is listed and tracked from its first turn.
- Windows pop-ups under Pitwall's own name. One pop-up per change, even with several windows open. "Open chat" opens the chat in the window for its folder.
- Sound switches for "needs you" and "finished", off by default (Settings → Pitwall → Sound), a bell in the Repos header, and a Test sound button.
- The bottom bar counts chats that need you, are working or are finished. A click on a count opens a jump list. `Next ▸` steps through the chats that need you, and Ctrl+Alt+0 opens the one that has waited longest.
- A check the first time Pitwall starts on Windows: if Windows would hide Pitwall's pop-ups, it offers the Settings page to turn them on. "Pitwall: Check Windows Notifications" runs it again.
- "Pitwall: Remove Pop-up Registration" removes the one per-user Windows entry Pitwall adds for its pop-ups. Uninstalling the extension removes it too.

### Fixed

- The first Ctrl+↓ after launch onto a restored panel chat keeps the list focused (the 0.5.0 known issue).
- A session was listed twice when two windows imported it at once. Duplicates now merge without losing stars, names or terminal links.
- `pitwall.dev.traceTabs` logs a tab model Cursor re-sends unchanged once, not on every re-send.

### Known issues

- A click into a just-restored chat within about 0.8 s of the first Ctrl+↓ after launch is pulled back to the list once. Click again. VS Code gives no event for clicks inside Claude's panel.
- Ctrl+Alt+0 and `Next ▸` can re-open the chat already in front when it is a restored tab whose title is shared by other chats. Pitwall can't tell which session that tab is.
- Cursor asks "Allow 'Pitwall' extension to open this URI?" on every pop-up click until you tick "Do not ask me again".
- A pop-up click can take several seconds on a busy machine, mostly Cursor starting its link handler. Pitwall's own part is fast.
- Pop-up clicks always open in Cursor's default profile, because Windows sends `cursor://` links there. A Cursor started with a separate `--user-data-dir` doesn't receive them.
- A chat running a background agent shows "working" until the agent's result is handled.
- The pop-up registration and the first-run "already asked" marker are shared by all Cursor profiles of the Windows user. Removing the registration in one profile turns pop-ups into in-window messages in the others until the next start registers it again.
- Pop-ups appear about 1.5 to 3 s after the change (PowerShell starts for each one), and slower on a heavily loaded machine.
- Downgrading to an older version shows merged duplicate chats again. Nothing was deleted.

## [0.5.0] - 2026-11-18

Windows and tabs: one window per folder (ROADMAP Phase 4).

### Added

- A click on any chat opens it in the Cursor window for its folder, and opens that window if it isn't open. A chat that is already open stays where it is.
- A repo click opens the repo's 8 newest chats as tabs, and the row "Open the other N chats" offers the rest. Chats never open twice.
- Side by side: the chats open in up to 4 panes, one move at a time.
- "+" on a repo row starts the chat in that repo's window.
- The bottom bar shows `repo · ⎇ branch` in every window, with ⧉ for a worktree, and updates within 5 seconds of a branch switch.
- FILES follows the window's folder. Copy and paste files between repos, "Copy to another repo", drag a file onto a repo row, and an offer to add `.env` files to `.gitignore`.
- A guard for chats already running in a terminal outside the editor.
- Developer commands `pitwall.dev.dumpState` and `pitwall.dev.traceTabs` (output goes to the Pitwall Operations channel) for bug reports.

### Changed

- A chat opens in Claude Code's chat panel by default, with its history. Set `pitwall.defaultSessionSurface` to Terminal to prefer terminals.
- Ctrl+Down keeps the list focused after it opens a chat, in the panel and in a terminal.
- Pitwall matches each Claude tab to its chat reliably, even when titles are cut off or every new chat says "Claude Code". Tabs Cursor restores after a reload or restart, and tabs opened in a window a handoff started, are recognised by their title.
- If a chat's window doesn't come up, Pitwall asks for it once more, and the "couldn't reach" message has an **Open its window** button.
- A chat that moved into a worktree opens in the window of the folder its transcript is filed under now.
- A repo row shows "· N windows" when more than one window has that repo or one of its worktrees open.

### Known issues

- The first Ctrl+↓ onto a restored panel chat after launch moves focus out of the list (Claude's panel takes focus as it loads). Later visits are fine. Fix planned for 0.5.1.

## [0.4.1] - 2026-11-17

### Fixed

- On Windows, opening a chat in Claude Code's chat panel no longer fails with "runs in the first folder open" because of the drive letter's case.

## [0.4.0] - 2026-11-17

Sidebar v1: repos and sessions (ROADMAP Phase 3).

### Added

- Repos are found automatically from the Claude Code sessions in `~/.claude` (the last 14 days). Dismiss or Remove from Pitwall takes a repo off the list; it returns if you add it again or a new session starts in it.
- A repo, then chat list. Chat rows in a git repo show their branch, and a worktree chat is marked with ⧉.
- Four status dots on every chat: needs you, working, finished and idle. The repo that needs you sits on top, rows move only when a status changes, and the needs-you count shows as a badge on the Pitwall icon.
- Hover icons on a chat row: the bell (needs you), open in terminal and fork.
- A "+" on the repo row to start a chat, 🕘 session history for the repo, and a right-click menu on the repo row.
- Hotkeys: Ctrl+Alt+1 to 9 jump to the nth repo (again opens its next chat), Ctrl+Alt+0 goes to the chat waiting longest, Ctrl+Alt+O and Ctrl+Alt+Shift+1 to 9 open a repo in its own window, Ctrl+Alt+F shows or hides FILES, Ctrl+Alt+R searches. In the list, Down and Up move, Ctrl+Down and Ctrl+Up move and open the row, and Enter opens it.
- A search box (Ctrl+Alt+R) over repos and chats; Enter picks the first result.
- A fast start: the list draws within a second, and "Scanning for repositories..." shows instead of a false empty state.

### Changed

- Ctrl+Alt+F now shows or hides FILES. Find Session is still in the Command Palette and the search box. Ctrl+Alt+N stays as an alias of Ctrl+Alt+0.
- Chat status is read live from Claude Code's session files, with `claude agents --json` as the fallback.
- Session history shows each chat's age from its last message, as the row does.
- Starred chats show a star on the row.
- Package author is now Sharif Amlani; Agntree credit stays in LICENSE and README.

### Fixed

- Chats saved twice no longer appear twice.
- Sessions started from a lowercase drive letter on Windows are imported.
- FILES actions work on Windows when the drive letter's case differs.
- A chat in a linked worktree opens and restores before git has listed it.

### Removed

- Worktree create and delete, PR badges and the Changes view are hidden. The code stays for a later release.

## [0.3.0] - 2026-11-17

Windows parity (ROADMAP Phase 2).

### Fixed

- Windows: worktree paths, the active-worktree marker, and resume commands that run in Windows PowerShell and cmd (including a custom full-path `claude` command).
- After a quit or reload, chats come back resumed in their own tabs: no duplicate tabs, no swapped tab names, and Pitwall starts in well under a second.
- "Needs you" now appears when Claude is waiting: an orange row mark, Ctrl+Alt+N, and one pop-up only for a wait that began while you were looking elsewhere.

### Added

- Windows CI runs the full test suite and builds and checks the `.vsix` on every change; a CI privacy gate (private paths, full-history gitleaks, packaging allowlist).
- `npm run package` builds the `.vsix` on every platform.

## [0.2.0] - 2026-11-16

### Added

- Forked from Agntree 4.0.0 (`47124cd`, MIT) by Subhash Khileri, with its full git history. <!-- credit-allow -->
  See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
