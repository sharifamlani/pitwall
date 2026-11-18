# 0020 — One window per folder, with a file handoff between windows

- **Status:** Proposed
- **Date:** 2026-11-17

## Context

Phase 4 gives each repo or worktree its own Cursor window (row 4.2). A chat opens in the
window whose folder it belongs to, because Claude Code's panel resumes a session only from
the folder it ran in. So a click in window A on a chat from folder F has to open the chat in
F's window, which may be open already, or may not exist yet.

Claude Code's `/open` link lands in whichever window has focus. When F's window is still
starting (a Cursor cold start is about 10 s), the link races it and can land in A (T6). Each
window also needs to know which other windows exist, which folder each has, and which chats
each has open as tabs, so rows can say ` · open` and ` · {k} windows`.

Windows of one editor share the extension's `globalStorageUri` folder on disk. They share no
memory and no extension API.

## Decision

- **A window registry (Q12).** Every window beats a record into
  `<globalStorage>/pitwall-windows/<pid>.json`: `{pid, folder, beatAt, openSessionIds}`. It
  beats every 15 s and on every change, and deletes its record when it closes. A record is
  stale 45 s after its last beat, or at once when its pid is dead. Readers fire a change only
  when a window appears, goes stale, or changes its folder or open chats; a beat that only
  moves `beatAt` fires nothing.
- **A file inbox for cross-window opens (Q1).** The sender writes
  `<globalStorage>/pitwall-handoff/<folderKey>/<nonce>.json`
  (`{v: 1, kind, sessionIds, folder, at, nonce}`) and calls `vscode.openFolder(F)` to raise or
  start F's window. `folderKey` is the first 16 hex characters of sha1(`pathKey(F)`).
  `pathKey()` uses the spelling `samePath` compares (`fs.realpathSync.native`, lower-cased on
  Windows), so drive case, a trailing slash, forward slashes and a `\\?\` prefix give one
  inbox. The window on F claims the request on activation, on a file event in its inbox, on
  window focus, and every 15 s as a backstop. The Claude link stays as the in-window path only.
- **Claim by rename, under a lock.** A window claims by renaming `<nonce>.json` to
  `<nonce>.claimed-<pid>`; the sender expires an unclaimed request by renaming it to
  `<nonce>.expired`. A rename alone is not exclusive on Windows: two processes that both open
  the file before either renames it both succeed, and the file ends up under the second name
  (the two-process claim test saw 25 claims of 20 requests). So each of these renames first
  creates `<nonce>.lock` with O_EXCL (`CREATE_NEW` on Windows), which exactly one caller can
  do, and deletes it after the rename. A caller that can't create the lock, or whose rename
  finds no file, has lost. Renames retry EPERM, EBUSY and EACCES 3 × 50 ms through one helper;
  only ENOENT means lost.
- **Lifecycle (Q16).** The claimer writes `<nonce>.done-<pid>` with `{ok, error?, at}`. The
  sender warns once unless it sees `ok` within 20 s, and expires an unclaimed request at
  120 s. A claimer treats a request older than 120 s as expired and never opens it, so a
  request whose sender closed never opens hours later. Every window sweeps, on activation,
  requests older than 120 s and claimed, done, expired, lock and temporary files older than
  10 min. While a request for the same folder, kind and ids is pending, the sender writes no
  second one.
- **Validated on claim (Q19).** A claimed request is deleted unless `v` is 1, its kind is
  known, every session id is a UUID, `nonce` matches its file name and its folder is this
  window's (`samePath`). Any local process can write into the inbox, and the ids flow into a
  command.
- **Only single-folder windows claim (Q17).** A window owns a folder only when it has exactly
  one folder and no `.code-workspace` file. Empty, multi-root and workspace-file windows never
  claim and never count as a repo's window, because `vscode.openFolder(F)` opens a new F
  window rather than raising a workspace window, and two claimers would leave one blank.
- **Started after first render.** Neither the registry nor the inbox is on the activation
  path (E16).
- **Private by construction.** Every file holds only session ids, folder paths, pids and
  timestamps, never transcript text. `scripts/dump-pitwall-windows.mjs --check-privacy`
  checks each file's keys against an allow-list (E17). `docs/privacy.md` lists the files.

## Alternatives

- **Link only.** Send the Claude `/open` link and let it land. It lands in the focused window,
  which races a window that is still starting (T6), so a cold-start open lands in the wrong
  window or nowhere.
- **A `~/.pitwall` folder.** Works across editors, but it is a dotfolder in the user's home
  that outlives the extension, and editors already give each extension a shared global
  storage folder. Kept as the fallback if `globalStorageUri` turned out not to be shared
  between windows (Smoke S2).
- **Rename without a lock.** Exclusive on POSIX, not on Windows (see above).
- **Claim in every window on the folder, including multi-root ones.** Two claimers on one
  folder can't both open the chat; one would stay blank.

## Consequences

- One request costs a few small files and at most a 15 s wait when file events are missed.
- A slow machine can see the 20 s warning while the chat still opens.
- A user who works in a multi-root window gets a second, single-folder window for routed
  chats.
- Tests: `test/dry/core/windows/` (`window-registry`, `handoff-inbox`,
  `handoff-claim-processes`, the last with two real `node` processes on both CI jobs).
