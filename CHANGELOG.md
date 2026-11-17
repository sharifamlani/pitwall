# Changelog

All notable changes to Pitwall are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Hotkeys: Ctrl+Alt+1 to 9 jump to the nth repo (again opens its next session), Ctrl+Alt+Shift+1 to 9 and Ctrl+Alt+O open a repo in its own window, Ctrl+Alt+0 goes to the session waiting longest, and Ctrl+Down and Ctrl+Up move through the list and open the row.

### Changed

- Ctrl+Alt+F now shows or hides FILES. Find Session is still in the Command Palette. Ctrl+Alt+N stays as an alias of Ctrl+Alt+0.

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
