# Changelog

All notable changes to Pitwall are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- Pitwall matches each Claude tab to its chat reliably, even when titles are cut off or every new chat says "Claude Code".
- A chat that moved into a worktree opens in the window of the folder its transcript is filed under now.
- The context menu shows the window count when more than one window is open.

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
