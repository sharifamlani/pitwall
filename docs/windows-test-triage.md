# Windows test triage (Phase 1, Task 2)

Every failure and skip from `npm test` on Windows 10 (Git Bash, Node test runner). Nothing here is fixed; Phase 2 does the fixing.

File paths and line numbers are as of upstream Agntree 47124cd (Pitwall main 70c344a). Later tasks move files, and Phase 2 maps them.

Command: `npm test > "$TEMP/pitwall-win-test.log" 2>&1` (one run, nothing else heavy running).

```
ℹ tests 182
ℹ suites 0
ℹ pass 153
ℹ fail 12
ℹ cancelled 0
ℹ skipped 17
ℹ todo 0
```

Rows below: 12 fail + 17 skipped = **29**, which equals `fail + skipped`.

## Summary by class

| Class | Meaning | Fail | Skip | Total |
|---|---|---|---|---|
| env-limit | Windows or this machine cannot do it (symlink EPERM, `"` in a filename, POSIX fake CLIs, `/proc`) | 2 | 17 | 19 |
| POSIX-assumption | Test expects POSIX quoting, paths or line endings | 5 | 0 | 5 |
| real-bug | Product behavior is wrong on Windows (rows 2, 9-12 suspected) | 5 | 0 | 5 |
| flaky | Passed on rerun | 0 | 0 | 0 |
| **Total** | | **12** | **17** | **29** |

Reruns: each of the 12 failing files was rerun alone (`npm test -- <name>`). All 12 failed again with the same errors, so none is flaky. Skips are unconditional (`posixOnly` or an explicit skip), so they do not vary.

## Failures (12)

| # | Test | File:line | Out | Class | Error (one line) | Hypothesis for Phase 2 |
|---|---|---|---|---|---|---|
| 1 | paths encode every non-alphanumeric character, resolve symlinks, and match long names by prefix | test/dry/claude-scoping.test.ts:54 | fail | env-limit | `EPERM: operation not permitted, symlink` | Creating symlinks needs Developer Mode or admin. Fall back to a directory junction (`fs.symlinkSync(..., 'junction')`) in the test, or skip the symlink part without Developer Mode. |
| 2 | a closed chat stops waiting after the TTL, and reopening it starts a new window | test/dry/claude-watcher.test.ts:84 | fail | real-bug | `actual '00000005-1111-...' expected null`: the abandoned chat was linked after the 5-minute TTL | Suspected, not investigated. The fake clock moves `Date.now`, but the watcher likely decides on a Windows-specific signal (file mtime or poll order). Read `ExactIdSessionWatcher.ts` (TTL at line 134) and check which clock it uses. |
| 3 | All Files lists folders first in natural order, hides build and VCS output, and keys rows by path | test/dry/files.test.ts:9 | fail | POSIX-assumption | tooltip `'src\\a.ts'` expected `'src/a.ts'` | The tooltip shows the native separator. Decide the product rule (show `/` everywhere, or accept native) and make the test or the tree match. |
| 4 | discard restores a tracked file from the index and refuses paths outside the repository | test/dry/git.test.ts:94 | fail | POSIX-assumption | `'original\r\n'` expected `'original\n'` | `core.autocrlf=true` on this machine rewrites checkouts to CRLF. Make the test repos set `core.autocrlf=false` (or compare normalized). |
| 5 | copying uncommitted work carries binary edits and unusual untracked names, never overwriting | test/dry/git.test.ts:106 | fail | POSIX-assumption | `'original\r\nedited\r\n'` expected `'original\nedited\n'` | Same CRLF cause as row 4; same fix in the shared test repo setup. |
| 6 | the discard summary counts tracked changes and lists exactly what git clean deletes | test/dry/git.test.ts:128 | fail | env-limit | `ENOENT ... repo\notes "draft".txt` | NTFS forbids `"` in filenames. Drop the quoted-name case on win32 and keep other unusual names (spaces, unicode). |
| 7 | launch commands choose the new ID, resume by record path, and fork under a chosen ID | test/dry/pi.test.ts:158 | fail | POSIX-assumption | command is `pi --session 'C:\...jsonl'` (single-quoted), expected unquoted | The product quotes a path that contains backslashes. Decide the Windows shell quoting (PowerShell vs cmd) and assert it; single quotes break in cmd.exe. |
| 8 | a found session outside every root resumes in a terminal at its folder, and its command copies with that folder | test/dry/session-search-commands.test.ts:113 | fail | POSIX-assumption | `cd 'C:\...\elsewhere' && claude --resume s2` expected without quotes | Same quoting rule as row 7; fix both together. Also: this string is the clipboard copy text, and `&&` is a parse error in Windows PowerShell 5.1, so the copied command does not paste into the default Windows shell either. |
| 9 | Create Worktree puts a new branch under <repo>-worktrees and hides branches already checked out | test/dry/worktree-commands.test.ts:50 | fail | real-bug (suspected) | `worktreeAt(created)?.branch` is `undefined` | Product-side: canonicalize the path in GitService.parseWorktrees (:162, and the id at :158), so every consumer sees native paths. `git worktree list --porcelain` prints `C:/...`; GitService.ts:162 stores it raw as `path` (id at :158), then WorkspacesTreeProvider.ts:402 (`worktree.path === targetPath`) and SessionImportService.ts:407 (`candidate.path === expectation.worktreePath`) compare raw strings against native backslash paths. Confirm after the fix.
| 10 | Delete Worktree closes its sessions before removing the directory, and a detached worktree never deletes a branch | test/dry/worktree-commands.test.ts:67 | fail | real-bug (suspected) | `TypeError: Cannot read properties of undefined (reading 'name')` | Same product-side cause as row 9; expected to clear with the parseWorktrees fix.
| 11 | Delete Worktree & Branch removes the worktree and its branch | test/dry/worktree-commands.test.ts:87 | fail | real-bug (suspected) | `true !== false` (the worktree still existed when it was forgotten) | Same product-side cause as row 9; expected to clear with the parseWorktrees fix.
| 12 | Rebase offers the remote branches, recommended main first, but not the branch’s own remote copy | test/dry/worktree-commands.test.ts:99 | fail | real-bug (suspected) | `actual [] expected ['origin/main','origin/zeta']` | Probably the same cause; confirm whether row 12 clears once parseWorktrees canonicalizes (if not, investigate separately). See row 9.

## Skips (17)

| # | Test | File:line | Out | Class | Skip reason | Hypothesis for Phase 2 |
|---|---|---|---|---|---|---|
| 13 | discovery follows the API cursor once for concurrent callers and keeps top-level sessions in the worktree | test/dry/opencode.test.ts:31 | skip | env-limit | fake CLIs are POSIX shell wrappers | Generate `.cmd` or node-script fake CLIs on win32 in `test/dry/support`, then drop `posixOnly`. |
| 14 | previews come from one export, and metadata only uses an export that is already cached | test/dry/opencode.test.ts:52 | skip | env-limit | fake CLIs are POSIX shell wrappers | Same fake-CLI helper as row 13. |
| 15 | a fork into a new worktree is forked, then moved; a failed move deletes the orphan fork | test/dry/opencode.test.ts:91 | skip | env-limit | fake CLIs are POSIX shell wrappers | Same fake-CLI helper as row 13. |
| 16 | a down background service falls back to a standalone API server | test/dry/opencode.test.ts:118 | skip | env-limit | fake CLIs are POSIX shell wrappers | Same fake-CLI helper as row 13. |
| 17 | the Codex runner keeps the user config, disables MCP servers, and re-runs for a correction | test/dry/session-search-runners.test.ts:29 | skip | env-limit | fake CLIs are POSIX shell wrappers | Same fake-CLI helper as row 13. |
| 18 | the Pi runner uses only read-only tools, keeps its session under the search cwd, and resumes it for a correction | test/dry/session-search-runners.test.ts:109 | skip | env-limit | fake CLIs are POSIX shell wrappers | Same fake-CLI helper as row 13. |
| 19 | one search reads Claude, Codex, opencode, and Pi records and keeps only what each harness confirms | test/dry/session-search-sources.test.ts:36 | skip | env-limit | fake CLIs are POSIX shell wrappers | Same fake-CLI helper as row 13. |
| 20 | stopping an opencode snapshot ends the session listing and unblocks preparation | test/dry/session-search-sources.test.ts:165 | skip | env-limit | fake CLIs are POSIX shell wrappers | Same fake-CLI helper as row 13. |
| 21 | the opencode preparation budget covers the session listing | test/dry/session-search-sources.test.ts:194 | skip | env-limit | fake CLIs are POSIX shell wrappers | Same fake-CLI helper as row 13. |
| 22 | the opencode snapshot stops at its byte budget and says so | test/dry/session-search-sources.test.ts:224 | skip | env-limit | fake CLIs are POSIX shell wrappers | Same fake-CLI helper as row 13. |
| 23 | a search runs with the configured model and effort, read-only, with no saved session, and keeps only sessions Claude confirms | test/dry/session-search.test.ts:108 | skip | env-limit | fake CLIs are POSIX shell wrappers | Same fake-CLI helper as row 13. |
| 24 | stopping a search ends the agent and everything it started, and keeps nothing | test/dry/session-search.test.ts:184 | skip | env-limit | fake CLIs are POSIX shell wrappers | Same fake-CLI helper as row 13; the child-process-tree kill needs `taskkill /T` on Windows. |
| 25 | a new question stops the running search, and one overtaken while waiting never starts | test/dry/session-search.test.ts:215 | skip | env-limit | fake CLIs are POSIX shell wrappers | Same fake-CLI helper as row 13. |
| 26 | confirming a quote reads the transcript in one pass and leaves no file open | test/dry/session-search.test.ts:233 | skip | env-limit | counts open files in /proc | Windows has no `/proc`. Replace the open-handle count with a spy on `fs.open` and `fs.close` calls. |
| 27 | a reply that breaks the schema goes back to the same agent with what is wrong, and the fixed reply is kept | test/dry/session-search.test.ts:251 | skip | env-limit | fake CLIs are POSIX shell wrappers | Same fake-CLI helper as row 13. |
| 28 | an agent that never fixes its reply fails the search after two corrections | test/dry/session-search.test.ts:275 | skip | env-limit | fake CLIs are POSIX shell wrappers | Same fake-CLI helper as row 13. |
| 29 | a CLI that fails without an answer leaves a failed search carrying its error | test/dry/session-search.test.ts:286 | skip | env-limit | fake CLIs are POSIX shell wrappers | Same fake-CLI helper as row 13. |

## Notes

- 4 of 12 failures share two test-side causes (CRLF checkout, shell quoting of Windows paths); 4 more (rows 9-12) share one product-side cause, forward-slash worktree paths from git.
- Suspected product bugs: row 2 (needs real investigation) and rows 9-12 (one shared cause in GitService.parseWorktrees; confirm row 12 clears with it).
- `core.autocrlf=true` here is this machine's Git setting; a CI Windows runner may differ.
