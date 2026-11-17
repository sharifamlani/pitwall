# 0019 — Repos are found from `~/.claude` and dismissed by right-click

- **Status:** Proposed
- **Date:** 2026-11-17

## Context

Until Phase 3, a repo appeared in Pitwall only after the user added it with the folder icon.
The sidebar is meant to show every Claude Code session across all repos (canvas decision 19,
D18), so a repo with recent sessions should be there without being added. The user also
needs a way to take a repo off the list that does not come straight back.

Claude Code keeps one transcript per session at
`<configDir>/projects/<encoded cwd>/<session>.jsonl`. Its head starts with
`queue-operation` entries that carry no `cwd`; the first entry with a `cwd` names the folder
the session ran in, and the first entry's `timestamp` is when the session started. An
attachment line can exceed 64 KB. On 2026-11-17 this machine had 129 session transcripts
written in 14 days (529 counting subagent transcripts), across 30 project directories and
15 repo roots.

## Decision

- **Found automatically (P13).** A pass lists every transcript written in the last
  `pitwall.autoImport.retentionDays` days (default 14, shared with import, P3), reads each
  line by line up to its first entry with a `cwd` (at most 1 MB), and maps that folder to a
  root. Every root found is added; there is no "choose repos" prompt. Files with no `cwd`,
  malformed or unreadable, are skipped and counted. `pitwall.discovery.enabled` turns it off.
- **One root per repo.** A folder maps to its main repository root through
  `git rev-parse --path-format=absolute --git-common-dir` (the parent of a `.git` common
  dir), so a worktree's sessions sit under their repo. Git before 2.31 has no
  `--path-format`; the relative common dir is then asked from the working tree's top level.
  A folder outside a working tree becomes a folder repository. A folder gone from disk is
  skipped. Roots use Phase 2's native spelling and compare with `samePath`.
- **Stored like any repo (P1, P17).** Discovered roots go into `pitwall.repositories` with
  `origin: 'discovered'` and the deterministic id
  `repo-<first 12 hex of sha1(canonical root, lower-cased on Windows)>`, so two windows adding
  one root at once converge on one record and worktree ids and chats do not split.
- **Dismissed (P1, P2).** **Dismiss from Pitwall** replaces **Remove from Pitwall…** on repo
  rows. It records `{rootPath: dismissedAt}` in `pitwall.dismissedRepos`, removes the repo and
  its rows without closing terminals, and deletes its chats without removal tombstones, so
  they import again when it returns. Nothing on disk changes. A dismissed root comes back
  only when a session **starts** in it after `dismissedAt`, judged by the newest transcript's
  first entry, or when the user adds it with the folder icon, which clears the dismissal. A
  session that started earlier and is still running does not bring it back. **Remove from
  Pitwall…** stays in the Command Palette. It also records a dismissal, so discovery does not
  add a removed repo straight back; it returns on the same terms. Unlike a dismissal, it
  asks first and closes the repo's terminals, as before.
- **Never in the way.** Passes run after the list first renders, every 60 s and on window
  focus, and are never awaited by activation. A failure is logged, never thrown. Concurrent
  calls share one pass. Transcript heads are cached by path, mtime and size; a folder's root
  is cached for 10 minutes.
- **Read-only, quiet.** `~/.claude/projects` is only read. Logs carry counts, not paths.

## Alternatives

- **A "Pitwall found N repos: Show them all / Choose repos…" prompt on first run.** Drawn on
  the canvas as a variant; the canvas log locks "found automatically" (P13).
- **Virtual discovered repos beside the stored ones.** Worktrees, chats, import and ids all
  hang off stored repositories; a parallel path would fork every consumer (P1).
- **Bring a dismissed repo back on any new activity.** A long-running session would undo
  the dismissal minutes after it; canvas decision 19 says it returns when a new session
  starts (P2).
- **Decode the project directory name instead of reading the transcript.** The encoding is
  lossy (`/x/repo-other` encodes like `/x/repo/other`) and truncated past 200 characters.
- **`--show-toplevel` only.** Maps a worktree to itself, so each worktree would become a
  repo of its own.

## Consequences

- A user with many repos gets all of them on first run and dismisses some by hand.
- A dismissed repo is hidden from every window: the record is in global state.
- Remove from Pitwall, now palette-only, records a dismissal too: without one, discovery would
  add a removed repo back within a minute whenever it had a session in the window.
- Discovery adds at most one `git` spawn per new folder per 10 minutes (three on git before
  2.31), off the extension host's thread.
- Privacy: [privacy.md](../privacy.md) lists `~/.claude/projects` as read for discovery.
