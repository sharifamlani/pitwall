# Phase 4 — Windows and Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking anything in Pitwall lands you in the right Cursor window, with the chat open in Claude Code's chat panel. Each repo and each worktree has its own window, which Pitwall opens or brings forward. Tabs never duplicate, and files and tabs behave like Cursor's. Tag `v0.5.0`.

**Architecture:**
- **Window registry.** Every Pitwall window writes a small heartbeat file (its folder, extension-host pid, open session IDs) into the extension's shared `globalStorageUri`. All windows of one Cursor profile share that folder. The registry answers "does repo X have a window?" and "is chat Y open anywhere?".
- **Handoff inbox.** Chat C lives in folder F. If F is this window's folder, the chat opens here through `claude-vscode.editor.open` (ADR 0010). Otherwise:
  1. Pitwall writes a request file into F's inbox in the same shared folder.
  2. It calls `vscode.openFolder(F, {forceNewWindow: true})`. That brings F's window forward if one exists, or opens one.
  3. F's Pitwall claims the request (an atomic rename) and opens the chat locally.

  The Claude link alone is not enough: it goes to whichever window is focused (T6), so it races against a window that is still starting.
- **Tab binding.** Pitwall opens Claude tabs one at a time and binds each new `claudeVSCodePanel` tab to the session it just asked for. Unmatched tabs stay unknown (T10 rule).
- **Window folder.** The bottom bar shows the window's `repo · ⎇ branch` (T9: nothing can be written under Claude's tabs). FILES shows the window's folder. One clipboard is shared across windows.

**Tech Stack:** TypeScript 5, esbuild, `node --test` dry tests with the `vscode` stub (`test/dry/run.js`), `@vscode/test-electron` (integration + terminal-restore e2e), GitHub Actions (`ubuntu-latest`, `windows-latest`, privacy job). No new runtime dependencies.

**Spec:**
- [ROADMAP](../../../ROADMAP.md) v0.50 §3, Phase 4, rows 4.1–4.9 including 4.2b. §2 decisions:
  - Window and tab design: D3, D11, D16, D19, D22, D23, D26, D28, D32, D35, D36, D37.
- Spec canvas https://claude.ai/artifact/XhYy9L747DwQzBsQDpaFF2, boards Navigation, NavigationSteps, Decisions, Hotkeys, Inherited and Fallback. UI strings below are copied verbatim from it unless marked *(new copy)*.
- [Assumption tests](../../research/2026-11-16-assumption-tests.md):
  - T5 and T17 FAIL: the panel only resumes chats of the window's first folder, and a worktree is its own folder.
  - T6 PASS: re-opening focuses the existing tab, and the link brings the window that holds the chat forward.
  - T9: no label is possible under Claude tabs.
  - T10: tabs carry only a truncated title.
  - Code recon, lines 42–61.
- [Phase 3 handoff](../../progress_reports/phase3-handoff.md): known issues (Ctrl+↓ focus), P10–P12 (open-in-own-window keys), P23 (redraw on focus).
- [Phase 2 handoff](../../progress_reports/phase2-handoff.md): F4 and R48 (terminal identity, restore race) → row 4.2b.

## Phase tracker

```
PITWALL PHASE 4 — task plan
─────────────────────────────────────────────
S0 : No-code smokes S3, S1, S1b      [..........⏸.........] waiting on Sharif's go
T1 : Window registry + handoff inbox
T2 : Claude panel by default + Ctrl+↓
T5 : Bottom bar repo · branch
T7 : Terminal tag spike (4.2b)
T3 : Click → its folder's window
T6 : FILES across windows
T4 : Repo click = all chats as tabs
T8 : Close: walk, evaluator, v0.5.0
```

## Rulings made while planning (lead; spec silent or ambiguous)

| # | Ruling | Why | Cost if wrong |
|---|---|---|---|
| Q1 | Cross-window opens go through a file inbox in `globalStorageUri`, plus `vscode.openFolder` to raise the window. The Claude link stays as the in-window fallback only | T6: the link lands in the focused window, which races against a new window that is still starting; a claimed file request is deterministic and survives that startup | One extra module; if `globalStorageUri` turned out not to be shared, S2 fails first and we fall back to a `~/.pitwall` folder |
| Q2 | A chat's window folder is its **launch folder**: the first transcript entry that has a `cwd` (read line by line, up to 1 MB), confirmed with `claudeProjectDirMatches(candidate, transcript's project folder)` (`src/harnesses/claude/paths.ts:19`). On a mismatch (fork, resume), the repo or worktree that matches the project folder wins, because that is the folder Claude's panel resumes from (T5/T17). The local open checks availability against this folder, never the latest `cwd` (QA C1, C2) | T18 and recon item 4: a chat that moved into a worktree mid-session stays in the main repo's window | A T18 chat opens blank; E10 catches it |
| Q3 | `pitwall.defaultSessionSurface` default flips `terminal` → `ui`. The terminal stays one click away (hover icon, setting) | Row 4.1, R48 (Sharif: move off the terminal path) | Users who liked terminals change one setting |
| Q4 | Ctrl+↓/↑ keep list focus when the chat opens **in this window**, on both surfaces. When it opens in another window, focus goes with that window. Mechanism (QA B1): `moveAndOpen` can't await the row command (the workbench fires it from `list.select` without awaiting), so it sets a one-shot `keepListFocus` marker (expires after 2 s) before `list.select`. The next `openChatPrimary` consumes it: the terminal path uses `show(true)`, and the UI path refocuses the list after the awaited open, or after the next focus or tab event if the S1b repro shows the webview grabs focus late. Never a timer | You can't keep focus in a window that just went behind another; #43 failed on a timer | None; a second Ctrl+↓ in the new window works there |
| Q5 | Clicking a repo (or pressing Enter on it) opens that repo's **main-folder** chats from the sidebar list (the 14-day set) as tabs in its window. Worktree chats are not opened there. Cap: the 8 most recent, then a quick pick "Open the other {n} chats" (Q18, Sharif). `openSerially` is cancellable. When the repo is this window's and its chats are already open, the click reveals only the last-open tab | D11 says "all"; canvas line 609 keeps worktree chats in their own windows | A busy repo's 20–30 chats load slowly |
| Q6 | No toast when a window opens or comes forward (the canvas has none). Log lines only, and a warning only on failure (copy in §3f) | Canvas: the "last action" line is prototype narration, and the only real toast is the needs-you pop-up (Phase 5) | None |
| Q7 | Repo + branch shows as a bottom-bar item in every window. Pitwall writes no settings (`window.title`, `workbench.editor.labelFormat`) | T9 rules out labels under Claude tabs. D26's fallback is the window title + bottom bar; Cursor's title already names the folder. Writing workspace settings would create `.vscode/settings.json` in the user's repo | The branch is in the bottom bar, not the title |
| Q8 | FILES always shows **this window's** folder | Row 4.7 replaces Phase 3's "follows the clicked repo", because a click now raises that repo's own window | None |
| Q9 | One clipboard for all windows, stored in `globalStorageUri/pitwall-clipboard.json`. A cut clears it after the paste | Canvas line 722: "Pitwall keeps one clipboard across all its windows" | None |
| Q10 | "Copy to another repo (Pitwall)" opens a quick pick of the other repos, and the file lands in the target repo's root | Native menus can't list repos dynamically; the root is the canvas's default paste target | A file meant for a subfolder needs a move afterwards |
| Q11 | The .gitignore offer covers copied files named `.env` or `.env.*`, except `.env.example`, `.env.sample` and `.env.template`. It is decided by `git check-ignore -q` in the target repo | D23; template files are meant to be committed | A missed secret name; the rule is one list to extend |
| Q12 | The ` · open` marker means open as a tab in **any** window (from the registry) | Phase 3 deferred other windows' tabs to Phase 4 | None |
| Q13 | Row 4.2b is a time-boxed spike (Task 7). A go retires title matching for tagged terminals; a no-go records the evidence in ADR 0009 and keeps titles | Panel by default (Q3) makes terminal identity secondary | Terminal identity stays fragile; terminals are opt-in now |
| Q14 | Row 4.9 is verify-only. Pitwall never closes, moves or rebuilds a tab, except the one move the user asks for with "Show its open chats side by side" | D16, D32 | None |
| Q15 | "Show its open chats side by side" puts that repo's open Claude tabs side by side in its window, using Cursor's own split (one group per tab, up to 4) | Canvas: "Side by side · {n} panes (Cursor's own split)", "Only this folder's chats can be split together." | More than 4 tabs: the rest stay as tabs in the last pane |
| Q16 | Handoff lifecycle (QA B2–B4):<br>• **Expire:** the sender expires an unclaimed request at 120 s by renaming `<nonce>.json` → `<nonce>.expired`. Claim and expire race on the same rename, so exactly one wins (ENOENT = the other won).<br>• **Outcome:** the claimer writes `<nonce>.done-<pid>` with `{ok:true}` or `{ok:false,error}`. The sender warns once unless it sees `ok` within 20 s, so "claimed but failed to open" warns too.<br>• **Sweep:** on activation, every window deletes `.claimed-*`, `.done-*`, `.expired` and `.tmp` files older than 10 min, and `.json` requests older than 120 s, across all folderKey folders.<br>• **Orphans (QA D1):** a claimer treats a request whose `at` is older than 120 s as expired: it renames it to `.expired`, logs `handoff expired` and does not open it. So a request whose sender closed or crashed never opens hours later.<br>• **Dedupe:** while a request for the same (folder, kind, sessionIds) is pending, the sender writes no second file and only calls `openFolder` again. A double-click, or a re-click after the warning, never makes a second "+" chat or a second openAll | A Cursor cold start is about 10 s; 20 s covers it with margin | A slow machine sees a false warning while the chat still opens |
| Q17 | Only a **single-folder window** (`workspace.workspaceFile === undefined` and exactly 1 folder) claims requests and counts toward `hasWindow` and ` · {k} windows`. A multi-root or `.code-workspace` window still opens its own `[0]`-folder chats locally when they're clicked there (QA B6) | `vscode.openFolder(F)` never raises a workspace window; it opens a new F window, and two claimers would leave one window blank | A user who works in a multi-root window gets a second, single-folder window for routed chats |
| Q19 | Request files are validated on claim and deleted if: `at` is older than 120 s (expired, Q16); `v ≠ 1`; kind is unknown; any sessionId isn't a UUID; or the folder doesn't `samePath` this window's (QA C5) | Any local process can write into the inbox, and the IDs flow into a command | None |
| Q20 | Drops onto a repo row accept only FILES' own drag mime (`application/vnd.code.tree.pitwall.filesview`), not Explorer's `text/uri-list` (QA C11) | Matches the canvas (drag from FILES); avoids accidental drops of whole folders from the OS | Dragging from Explorer does nothing |
| Q21 | Row 4.2b's O2 item (after a restart, a row click left two `[shortId]` tabs, one blank) goes into T7's runs: each reload trial also clicks one un-restored row and counts `[shortId]` tabs. If it doesn't reproduce in 10+10 runs, it moves to the Phase 4 handoff's known issues (QA C10) | Its repro is uncertain, and terminals are opt-in after Q3 | A rare duplicate terminal tab survives |

| Q23 | Chats whose transcript `entrypoint` is not `cli` or `claude-vscode` (e.g. `sdk-cli` from `claude -p` / the SDK) open in the terminal, not Claude's panel, and are never routed for a UI open. They are also never used as UI lab fixtures (S3 finding F2: Claude's UI doesn't list them, and `editor.open(<id>)` opens a blank "Untitled" tab on every call, so it duplicates every time) | Claude's panel can't resume them; the terminal (`claude --resume`) can | An SDK chat opens in a terminal; that's the only way to resume it |
| Q24 | Opening a chat (UI or terminal), or closing its Claude tab, must not turn its row "working" or "finished" when no turn ran (S1b/T5 walk, 3/3: closing a Claude tab showed "working · now · open" then "finished" with no `~/.claude/sessions` entry) (S3 finding F3: a UI resume flipped an idle row to "finished · now"; resuming likely appends a non-turn line to the transcript). T2 finds the line type from a before/after transcript diff and makes turn-state ignore it | A row should change only when Claude actually took a turn (D21) | A false green "finished" after every open |

| Q25 | Dropping a FILES file from a worktree window onto its own repo's row copies it into the repo's main folder; "That file is already in {repo}…" shows only when the file is already under the repo's main folder (QA #50) | The file really is in a different folder; copying from a worktree to main is a real use | None |

**Sharif's answers (2026-11-17):** Q18 = cap at 8 (approved). Q22 = expand only (approved; D37 amended). Q7a: Sharif asked whether tabs in one window can be on different branches. Answer: no, a folder has one checked-out branch at a time, and a different branch at the same time means a worktree, which is its own folder and window with its own bottom bar. Waiting on his confirmation; no code depends on it.

| # | Question | Recommended | Changes |
|---|---|---|---|
| Q18 ✅ | Repo click: open all its chats, or cap? | Cap at the 8 most recent, then a quick pick "Open the other {n} chats" *(new copy)* | T4 `openRepoChats` limit; E5 |
| Q22 ✅ | Ctrl+↓ walking past a repo row: open all its chats (D37 as written), or expand only (Phase 3 P20)? | Expand only; click and Enter open all. Otherwise a keyboard walk pulls each repo's window forward and opens every chat | D37 amendment; T4 navigation tests |
| Q7a | Row 4.5 says file tabs show repo + branch "via label setting". Drop that (one folder per window, so every tab shares the bottom-bar repo · branch; changing the label setting means writing user settings)? | Drop it; amend row 4.5 | ROADMAP row 4.5 text |

## Global Constraints

- **Privacy:**
  - `~/.claude` stays read-only, and the Phase 3 rules for `~/.claude/sessions` hold (never read `*.key`).
  - Registry, inbox and clipboard files hold only session IDs, folder paths, pids, timestamps and (clipboard) one file path. They never hold transcript text.
  - These files live only in `globalStorageUri`. `docs/privacy.md` lists all three.
- **Never track** `.packages/`, `transcripts/`, `.claude/` (except `.claude/skills/pitwall-*`), `.superpowers/` or `.env`. Run `bash scripts/verify.sh` before every push.
- **Claude Code** is driven only through `claude-vscode.editor.open` and its `/open` link built from `vscode.env.uriScheme`. It is never copied, embedded or modified. No "Claude" in the product name.
- **User files and settings:** Pitwall writes into a user's repo only when the user pastes, copies or drops a file, or accepts the .gitignore offer. It writes no user or workspace settings.
- **Tabs (D16):** switching repos never closes, reorders or rebuilds tabs. Pin, split and drag-reorder stay Cursor's own.
- **Window folder:**
  - This window's folder is `workspaceFolders[0]`, Claude's own rule.
  - An empty window has none, so it routes every chat elsewhere and never claims a request.
  - Only a single-folder window claims requests or counts as a repo's window (Q17).
  - Paths compare with `samePath()` and key with a new `pathKey()` in `src/core/utils/paths.ts`. `pathKey()` uses the same spelling `samePath` does (`fs.realpathSync.native`, lower-cased on win32), so `\\?\C:\…` and `C:\…` give one key. `canonicalPath()` (JS `realpathSync`) throws EISDIR on `\\?\` paths, so it is not used for keys (QA B5).
- **Exact values:**
  - heartbeat every 15 s and on every change; a window is stale after 45 s without a beat or when its pid is dead;
  - a request expires after 120 s; the sender warns after 20 s with no claim;
  - side by side is at most 4 panes;
  - inbox and registry paths:
    - `<globalStorage>/pitwall-windows/<pid>.json`;
    - `<globalStorage>/pitwall-handoff/<folderKey>/<nonce>.json`, where `folderKey` = the first 16 hex characters of sha1(`pathKey(folder)`). The same folder holds `<nonce>.claimed-<pid>`, `<nonce>.done-<pid>` and `<nonce>.expired` (Q16);
  - renames treat EPERM, EBUSY and EACCES as "retry" (3 × 50 ms) and only ENOENT as "lost", through one helper (QA C3);
  - stray files are swept after 10 min.
- **Log lines** (to the "Pitwall Operations" channel, which the evaluator greps):
  - `[Pitwall] handoff sent <id8> → <folder>`
  - `[Pitwall] handoff claimed <id8> after <ms> ms`
  - `[Pitwall] handoff opened <id8> after <ms> ms` (measured from `sent`; also logged when an open chat is only revealed)
  - `[Pitwall] handoff failed <id8> <reason>`
  - `[Pitwall] handoff expired <id8>`
  - `[Pitwall] tab bound <id8> "<label>"`
  - `[Pitwall] window registry <n> windows`
- **Activation:** the registry and inbox start after first render. `[Pitwall] activate` → `[Pitwall] first render` stays ≤ 1 s with real `~/.claude` (E16 from Phase 3 is held).
- **Copy:** UI strings in §3 are verbatim from the canvas or marked *(new copy)*. Sentence case, no exclamation marks.
- **Windows parity:** every new test passes on the windows CI job; skips ≤ 9.
- **Timing asserts** use `assertNoLongBlock(fn, maxMs, { runs: 3 })` from `test/dry/support.ts` (PR #49), never a bare `watchEventLoopBlocks` threshold.
- **Flywheel:**
  - one PR per task on branch `phase4/task-N-<slug>`;
  - QA approves an exact sha, and the lead merges only with `gh pr checks` green at that sha, using `--match-head-commit`, then confirms main CI;
  - the testing agent walks each merge in its isolated profile (`$LOCALAPPDATA/pitwall-uj`), never in Sharif's windows;
  - `package.json` is generated: on a merge conflict, take main's copy, rerun `node scripts/build-manifest.mjs`, then `--check` (QA C9).

## Review Focus

1. **The target window closes, cold-starts slowly, or claims and then fails to open** (Claude not active yet, open refused):
   - the sender warns once unless it sees a `done` with `ok` within 20 s;
   - an unclaimed request is expired by the sender at 120 s, and claim and expire can't both win;
   - nothing opens twice when the window finally arrives.

   Test in Task 1 and Task 3.
2. **Two claimers, or two requests** (two windows on one folder, a double-click, a re-click after the warning): exactly one claim wins the rename, and the sender's dedupe writes no second request, so one tab and at most one new "+" chat. Tests in Task 1 (including a 2-process × 20-request claim test on the windows CI job) and Task 3.
3. **A chat whose folder is gone** (deleted worktree or repo): no window opens; the warning in §3f shows instead. Test in Task 3.
4. **Path spellings:**
   - drive-letter case, trailing slash, `\\?\` prefix, forward slashes;
   - each gives one `folderKey` through `pathKey()`, and the registry match uses `samePath`.

   Test in Task 1, on real temp dirs, not a stub.
5. **Empty window or multi-root workspace:** an empty window claims nothing and routes everything elsewhere. A multi-root or `.code-workspace` window claims nothing either (Q17), but still opens its own `[0]`-folder chats locally. Test in Task 1 and Task 3.

---

## 1. Folder / file structure (paths this plan touches)

```
pitwall/
├── src/
│   ├── core/windows/                         NEW folder: one-window-per-folder machinery
│   │   ├── WindowRegistry.ts                 T1 heartbeat files; windowsFor(folder), openSessionIds(), isStale()
│   │   ├── HandoffInbox.ts                   T1 folderKey(), send(), claim() via atomic rename, expiry sweep
│   │   ├── ChatRouter.ts                     T3 launchFolder(chat) → local open | send + openFolder; failure warnings
│   │   └── RepoStatusBar.ts                  T5 bottom-bar "$(repo) {repo} · ⎇ {branch}" for this window
│   ├── core/files/
│   │   ├── SharedClipboard.ts                T6 cross-window clipboard file (copy/cut, clear after cut-paste)
│   │   ├── RepoDropController.ts             T6 TreeDragAndDropController: file dropped on a repo row → copy
│   │   └── envIgnoreCheck.ts                 T6 isEnvLike(name), checkIgnored(repo, rel) via git check-ignore
│   ├── core/commands/
│   │   ├── chat.ts                           T2 default ui; T3 openChatPrimary → ChatRouter
│   │   ├── navigation.ts                     T2 moveAndOpen refocuses the list; T3 window keys use the registry
│   │   ├── repository.ts                     T3 "+" via router, window label flip; T4 open all, side by side
│   │   └── files.ts                          T6 shared clipboard, cross-repo paste, "Copy to another repo"
│   ├── core/harness/kit/NativeUiTabSurfaceService.ts   T4 serial open + bind-next-new-tab
│   ├── core/providers/WorkspacesTreeProvider.ts        T3 " · {k} windows", open-anywhere, hasWindow; T4 repo click command; T6 drop
│   ├── core/providers/FilesTreeProvider.ts             T6 this window's folder; clipboard banner (view.message)
│   ├── harnesses/claude/claudeUi.ts          T2 link uses vscode.env.uriScheme
│   ├── core/terminal/TerminalManager.ts      T2 show(true) when keepListFocus is set (:238,:254,:266,:291); T7 (go only) env tag
│   ├── core/utils/paths.ts                   T1 pathKey(): realpathSync.native spelling, lower-cased on win32
│   └── extension.ts                          T1/T3/T5 wiring after first render; T6 dragAndDropController in createTreeView (:151)
├── manifest/core.contributes.json            T2 setting default; T3/T4/T6 commands, menus, when-clauses
├── package.json                              generated by scripts/build-manifest.mjs
├── test/dry/core/windows/                    NEW
│   ├── window-registry.test.ts               T1
│   ├── handoff-inbox.test.ts                 T1
│   ├── handoff-claim-processes.test.ts       T1 2 child processes × 20 requests (real OS rename race)
│   ├── chat-router.test.ts                   T3
│   └── repo-status-bar.test.ts               T5
├── test/dry/core/files-cross-repo.test.ts    T6 NEW
├── test/dry/shared/native-ui-surface.test.ts T4 serial binding cases
├── test/dry/core/{chat-commands,navigation,menus,manifest,tree}.test.ts   updated per task
├── scripts/dump-pitwall-windows.mjs          T1 NEW: prints registry + pending inbox (walk + ground truth), --check-privacy
├── scripts/dump-tabs.mjs                     T4 NEW: prints the JSON that the hidden command pitwall.dev.dumpState writes per window
│                                               into globalStorage (tab groups, labels, pinned, bound ids, sidebar chat ids per repo) (E5, E13, GT)
├── docs/adr/0020-window-per-folder-handoff.md          T1 NEW
├── docs/adr/0009-restored-terminals-keep-their-chat.md T7 amended (go or no-go evidence)
├── docs/privacy.md                           T1/T6 new local files listed
├── docs/progress_reports/phase4-scorecard.md T8 NEW (evaluator)
├── docs/progress_reports/phase4-handoff.md   T8 NEW
├── CHANGELOG.md, README.md                   T8 [0.5.0]
└── ROADMAP.md                                every merge: row flip, §0, §6, version
```

## 2. Flowchart

```
 click chat row / Ctrl+↓ / Enter / "+" / repo click        (window A)
            |
            v
 +------------------------+   launchFolder(chat) = first transcript cwd (Q2)
 | ChatRouter.route()     |---------------------------------------------+
 +------------------------+                                             |
    | F == A's folder?                                                  |
    | yes                                no                             |
    v                                    v                              |
 +-------------------------+   +-------------------------------+  folder gone?
 | open here:              |   | HandoffInbox.send(F, request) |  -> warning (§3f)
 | claude-vscode.editor    |   |  globalStorage/pitwall-handoff|
 | .open (serial, bind tab)|   |  /<folderKey>/<nonce>.json    |
 +-------------------------+   +-------------------------------+
    |                                    |
    | keepListFocus marker? (Q4)         v
    v                          vscode.openFolder(F, forceNewWindow)
 tab bound -> registry beat       |                    |
 (open IDs) -> rows " · open"     | F has window       | no window
                                  v                    v
                        window B comes forward   Cursor opens window B
                                  |                    | Pitwall activates
                                  +---------+----------+ (after first render)
                                            v
                         B (single-folder window only, Q17):
                         claim() = rename <nonce>.json -> .claimed-<pid>
                            (fs.watch | window focus | activation | 15 s beat backstop)
                         validate (Q19) -> bad request deleted
                                            |
                                            v
                         B: open here (same box as left; availability vs launch folder)
                                            |
                                            v
                         B: write <nonce>.done-<pid> {ok | error}; "handoff opened" / "handoff failed"
                            registry beat -> every window's rows refresh

 sender A: dedupes a pending (folder, kind, ids); no done{ok} in 20 s -> one warning;
           at 120 s renames unclaimed <nonce>.json -> .expired ("handoff expired"; claim and expire can't both win)
 every window: heartbeat 15 s -> pitwall-windows/<pid>.json (deleted on dispose) -> " · {k} windows", label flip
 every activation: sweep .claimed/.done/.expired/.tmp older than 10 min and .json older than 120 s
 claimer: a request older than 120 s is expired, never opened (sender may be gone)
```

## 3. UI wireframes

### 3a. Pitwall sidebar (repo row and session rows)

```
BEFORE (v0.4.0)                                   AFTER (v0.5.0)
+----------------------------------------------+  +----------------------------------------------+
| v job-market     1 needs you · 2 open        |  | v job-market     1 needs you · 3 open · 2 windows |  <- " · {k} windows" when k > 1
|    ● One-off apply   ⎇ main  needs you · 2m  |  |    ● One-off apply   ⎇ main  needs you · 2m  |
|    ● Networking…     ⎇ main  working · now · open |  |    ● Networking…  ⎇ main  working · now · open |  <- open = open in ANY window (Q12)
|    ○ Wt test  ⧉ ⎇ feat/wt  idle · 1h         |  |    ○ Wt test  ⧉ ⎇ feat/wt  idle · 1h · open  |  <- open in its own window counts
+----------------------------------------------+  +----------------------------------------------+
 click repo label = expand + FILES follows         click repo label = open its main-folder chats as tabs
                                                   in its window (Q5); the twistie still only expands
 click chat = terminal in THIS window              click chat = Claude panel tab in ITS folder's window
```

### 3b. Repo right-click menu (label flip)

```
BEFORE                                  AFTER (repo has no window)        AFTER (repo has a window)
+------------------------------+        +------------------------------+  +------------------------------+
| New Claude Code session      |        | New Claude Code session      |  | New Claude Code session      |
| Session history…             |        | Session history…             |  | Session history…             |
| Open in New Window           |        | Show its open chats side by side |  | Show its open chats side by side |
| Copy Path                    |        | Open its window              |  | Bring its window forward     |  <- flips on registry
| Reveal in File Explorer      |        | Copy Path                    |  | Copy Path                    |
| Dismiss from Pitwall         |        | Reveal in File Explorer      |  | Reveal in File Explorer      |
+------------------------------+        | Dismiss from Pitwall         |  | Dismiss from Pitwall         |
                                        +------------------------------+  +------------------------------+
```
"Show its open chats side by side" is hidden when the repo has fewer than 2 open chats. Two command ids with `when` clauses on `viewItem =~ /hasWindow/` give the flip.

### 3c. Window journey (NavigationSteps board)

```
STEP 1  window job-market                STEP 2  click "Fix map" (wynwood)       STEP 3  click a job-market chat
+--------------------------------+       +--------------------------------+      +--------------------------------+
| PITWALL  | [Apply][Network][Wt]|       | PITWALL  | [Fix map]           |      | PITWALL  | [Apply][Network][Wt]|
| ...      |  Claude panel tabs  |  -->  | ...      | wynwood window,     | -->  | ...      | job-market window   |
|          |  job-market only    |       |          | brought forward or  |      |          | back in front, same |
+--------------------------------+       |          | opened by Pitwall   |      |          | tabs, chats kept    |
| $(repo) job-market · ⎇ main    |       +--------------------------------+      +--------------------------------+
+--------------------------------+       | $(repo) wynwood · ⎇ main       |      | $(repo) job-market · ⎇ main    |
                                         +--------------------------------+      +--------------------------------+
 job-market's window is untouched in step 2: nothing closes, its chats keep running (D16).
```

### 3d. Bottom bar (row 4.5, Q7)

```
BEFORE: [⎇ main ⟳] [⊗ 0 ⚠ 0]                          (Cursor's own git item)
AFTER:  [$(repo) job-market · ⎇ main] [⎇ main ⟳] ...    main-folder window
        [$(repo) job-market · ⎇ feat/wt ⧉] ...           worktree window
tooltip: the folder path, e.g. C:\code\job-market-wt      click: focus the Pitwall list
hidden: empty window or folder outside git
```

### 3e. FILES (row 4.7)

```
BEFORE                                             AFTER
> FILES  job-market ⎇ main  C:\code\job-market     > FILES  job-market ⎇ main  C:\code\job-market   <- always this window's folder (Q8)
  (follows the clicked repo / chat)                  On the clipboard: notes.md from wynwood. Right-click → Paste,
                                                     or Ctrl+V, in any repo.                        <- view.message banner (canvas line 94)
right-click a file                                 right-click a file
  Copy · Cut · Paste · ...                           Copy · Cut · Paste · Copy to another repo (Pitwall) · ...
                                                       └─ quick pick, placeholder (new copy): "Copy {file} to which repo?"
                                                          items: one per other repo, "{repoName}", detail = path
drag a FILES row onto a Pitwall repo row          -> copy into that repo's root
  same repo -> info: "That file is already in {repo}. Drop it on a different repo to copy it there."
```

### 3f. Messages (info / warning, no modals)

| Moment | Text | Kind |
|---|---|---|
| Copy / cut | `Copied {file} ({repo}). Now click another repo: its window comes up and the copy waits on the clipboard (Pitwall keeps one clipboard across all its windows). Right-click in FILES → Paste, or press Ctrl+V.` (cut: `Cut … the cut waits …`) | status bar 5 s |
| Paste / move done | `Pasted {name} from {repo} into {winName} ({path}).` / `Moved {name} from {repo} into {winName} ({path}).` | info |
| Name clash | appended: ` A file with that name was already there, so it was saved as '{destName}'.` | same message |
| .env not ignored | `⚠ {repo}'s .gitignore does not cover {destName}, so it could get committed.` buttons `Add to .gitignore` *(new copy)* · `Not now` *(new copy)* | warning |
| Added | `Added {destName} to {repo}'s .gitignore.` *(new copy)* | info |
| No claim after 20 s | `Pitwall couldn't reach the {repo} window. Click the chat again.` *(new copy)* | warning |
| Folder gone | `That chat's folder is gone: {path}` *(new copy)* | warning |

### State summary

| UI piece | BEFORE | AFTER |
|---|---|---|
| Chat click | terminal in this window | Claude panel tab in its folder's window |
| Repo label click | expand + FILES follows | all main-folder chats as tabs in its window |
| Ctrl+↓ after opening | focus lost to the chat | stays in the list (same window) |
| ` · open` | open in this window | open in any window |
| Repo description | `{k} need you · {n} open` | + ` · {k} windows` when k > 1 |
| Repo menu | Open in New Window | Open its window / Bring its window forward; Show its open chats side by side |
| "+" on a repo | new chat in this window | new chat in that repo's window |
| Bottom bar | Cursor's git item only | + `$(repo) {repo} · ⎇ {branch}` |
| FILES folder | clicked repo / chat | this window's folder |
| Clipboard | per window, paste only in active worktree | one across windows, banner, paste anywhere |
| File menu | Copy · Cut · Paste | + Copy to another repo (Pitwall) |
| Drag file onto repo row | nothing | copies into that repo |
| .env copy | nothing | warning with Add to .gitignore |

### 3g. Canvas coverage check (window and tab elements → where they land)

| Canvas element | Phase 4 | Where |
|---|---|---|
| Chat opens in its folder's window, brought forward or opened (NavigationSteps 2) | ✅ | T1, T3 |
| Other window untouched, chats keep running (NavigationSteps 2, D16) | ✅ | T3, E13 |
| Back to a window = its tabs, last chat (NavigationSteps 3) | ✅ (Cursor native) | E13 |
| Already open → jump to its tab, no duplicate (D10) | ✅ | T3, T4 |
| Repo click → all chats as tabs; worktree chats in own window (line 609) | ✅ | T4 |
| Repo row ` · {k} windows` (line 799) | ✅ | T3 |
| Menu "Open its window" / "Bring its window forward" (line 973) | ✅ | T3 |
| Menu "Show its open chats side by side" (line 970s) | ✅ | T4 |
| "+" starts the chat in that repo's window (line 682) | ✅ | T3 |
| Search meta "· this window" / "· its own window" (line 955) | ✅ | T3 |
| Ctrl+↓ keeps the list focused (line 848) | ✅ | T2 |
| Bottom bar repo + branch (D26 fallback, lines 241–242) | ✅ (one item) | T5 |
| FILES clipboard banner, toasts, "Copy to another repo", drag onto a repo row, .env warning | ✅ | T6 |
| Taskbar strip "YOUR CURSOR WINDOWS ({n})" (lines 295–296) | ✗ prototype-only; Windows' own taskbar | — |
| Needs-you jump list (line 892) | → Phase 5 (bottom-bar counts) | — |
| Windows pop-up "Open chat" opens the repo's window (line 1044) | → Phase 5 (uses T3's router) | — |

## 4. Derisking (run in order; don't start N+1 until N passes)

S3, S1 and S1b need no code and run before wave A (QA C8).


| # | What it proves | Command | Expected | If it fails → |
|---|---|---|---|---|
| S3 | `claude-vscode.editor.open` resumes a same-folder chat with history and doesn't duplicate, on today's Claude extension (no code) | Testing agent: in `uj-lab-a`, run "Pitwall: Open in UI" on a lab chat twice | Panel tab shows the chat's last message; tab count +1 then +0 | Re-run T6 by link; if the command changed, update `claudeUi.ts` before T2 |
| S1 | `vscode.openFolder(F, {forceNewWindow:true})` **raises** an existing F window that is behind, and opens one only when none exists (no code; Phase 3 S5 showed the count once, not the foreground) | Testing agent, own profile: window A on `uj-lab-a`, window B on `uj-lab-b` behind A; in A press Ctrl+Alt+Shift+{pos of uj-lab-b}; 3 trials with B behind + 1 with B minimised; then once for `uj-lab-c` (no window) | Window count unchanged AND B in the foreground (CUA `list_windows` + foreground check) 4/4; `uj-lab-c` press: count +1 | Skip `openFolder` when the registry has F's window and raise it with the Claude link on a chat it holds (T6); ruling recorded before T3 |
| S1b | Where focus lands after an open, on both surfaces (input to Q4) (no code) | Testing agent: Ctrl+↓ on a session row with surface `ui`, then `terminal`; log the focus owner every 150 ms for 3 s | `captures/t2-focus-repro/` shows, per surface, when focus leaves the list: before or after the open call returns | If the webview takes focus after `editor.open` resolves, T2 refocuses on the next focus or tab event (never a timer) |
| S2 | Two windows share `globalStorageUri`, and B sees A's file fast | T1's dry tests, then live: `node scripts/dump-pitwall-windows.mjs --dir <profile globalStorage>` with 2 windows open; click a lab-b chat in A | 2 windows listed with the right folders; B's `handoff claimed` ≤ 1 s after A's `handoff sent` | Move the shared dir to `~/.pitwall` (Q1 fallback), ruling recorded |
| S2b | Cold-start claim: the window Pitwall opens claims right after first render and Claude still opens the chat (riskiest path) | With no `uj-lab-c` window, click a lab-c chat in A; 3 trials (close the lab-c window between trials) | 3/3: lab-c window opens showing the chat's history; `handoff opened` ≤ 20 s after `handoff sent`; `first render` not delayed by the claim | Wait for the Claude extension's activation (`extensions.getExtension(...).activate()`) before opening; re-run |
| S4 | Serial opens bind the right tab, even for two "Claude Code" new chats | T4 dry tests + live: "+" twice in `uj-lab-a`, then open 3 existing chats | 5 `tab bound` lines, each id matching the chat opened; 0 binds to a tab Pitwall didn't open | Keep tabs unknown (T10 rule); ` · open` falls back to registry-reported launches only |
| S5 | Repo label click runs the command and the twistie only expands | Testing agent: click the twistie of `uj-lab-b`, then its label | Twistie: 0 tabs opened; label: its main-folder chats open | Move "open all" to Enter and the menu only; ruling recorded |
| S6 | Each task's code is green on both OSes | `npm test` locally + `gh pr checks <N>` | 0 fail; skips ≤ 9; ubuntu + windows + privacy green | Fix in the task's PR; no merge |
| S7 | End to end in real Cursor (E15, exit gate) | Testing agent walk W1–W12 (Task 8) on the release sha | Every step PASS with evidence files | Route each FAIL to its task owner; re-walk |
| GT | System-says ≠ correct | After S7: `dump-pitwall-windows.mjs` vs CUA `list_windows` vs `dump-tabs.mjs` vs each window's tab strip screenshot | Registry windows = real windows (folder by folder); each tab's chat = the session the registry says is open there; 0 extra | Open a finding; Phase 4 stays open |

## 5. Evaluation criteria (definition of done; graded by an independent evaluator sub-agent on a fresh clone)

| # | Criterion | Metric + threshold | How measured | Evidence |
|---|---|---|---|---|
| E1 | The full suite passes on both OSes | 0 fail on ubuntu + windows; skips ≤ 9, each with a reason | `gh run view` of main CI at the release sha | run id |
| E2 | A chat opens in Claude's panel by default, with its history | 3/3 same-folder chats open as `claudeVSCodePanel` tabs showing the transcript's last message; 0 new terminals | walk W1 | captures |
| E3 | **Exit gate:** from one window, chats in 3 repos + 1 worktree each land in their folder's window | Start: exactly 1 window, on `uj-lab-a`. Open one chat each in uj-lab-a, uj-lab-b, uj-lab-c and uj-lab-a-wt. End: exactly 4 windows (a, b, c, a-wt), each showing its chat with history, 4/4; 0 blank "Claude Code" chats | walk W2 + `dump-pitwall-windows.mjs` + CUA `list_windows` | captures + dump |
| E4 | Nothing ever duplicates | Re-clicking each of the 4 chats and re-clicking 2 repos: tab count in every window unchanged, 6/6; concurrent double-click → 1 tab (dry + live) | walk W3 + dry `handoff-inbox` claim race test | captures; test name |
| E5 | Repo click opens its main-folder chats, and only those | The id set of bound tabs opened in the repo's window = the id set `dump-tabs.mjs --repo uj-lab-a` prints for the sidebar's main-folder chats (within the Q18 cap), exact set match; 0 worktree chat ids | walk W4 + `dump-tabs.mjs` | dump diff (empty) |
| E6 | Handoffs are quick | Existing window: `handoff sent` → `handoff opened` ≤ 3 s, 10/10 trials. New window: ≤ 20 s, 3/3 | Operations-channel log lines from both windows | log excerpt |
| E7 | Pitwall knows which tab is which chat | Dry: serial binding, two "Claude Code" new chats, user-opened tab stays unknown, 3/3. Live: rows marked ` · open` = chats with a tab in any window, exact match over 5 tabs in 2 windows, 0 false | `npm test -- native-ui-surface` + walk W5 | test names; captures |
| E8 | Ctrl+↓ keeps the list focused, on both surfaces | Ctrl+↓ ×3 opens 3 same-window chats with no click between: 3/3 with surface `ui` and 3/3 with surface `terminal` | walk W6 | captures |
| E9 | Every window shows its repo + branch | Bottom bar text = `{repo} · ⎇ {branch}` in 4/4 windows (worktree shows its branch and `⧉`); updates ≤ 5 s after `git switch` | walk W7 | screenshots |
| E10 | A chat that moved into a worktree mid-session opens in the main window with history (T18) | 1/1 lab chat; dry test `launch folder is the first transcript cwd` | walk W8 + `npm test -- chat-router` | capture; test name |
| E11 | "+" starts the chat in that repo's window | "+" on `uj-lab-b` from the uj-lab-a window: 1 new transcript under lab-b's project dir, 0 under lab-a's | walk W9 + evaluator's own `~/.claude/projects` count (read-only) | counts |
| E12 | Files move between repos like the canvas says | 7/7 checks, each in walk W10 with `sha256sum` and `git check-ignore` output: FILES = window folder (4/4 windows), file click = editor tab, copy in A + paste in B (sha256 equal), cut = moved, clash → `{name} copy{.ext}`, "Copy to another repo" + drag each copy 1 file, .env offer → accepted → `git check-ignore` exit 0 | walk W10 + `npm test -- files-cross-repo` | outputs |
| E13 | Cursor's own tab behaviour is untouched | In a window with 3 Claude tabs + 1 file: pin 1, split right, drag-reorder; visit 2 other repos and return → tab order, pins and groups identical | walk W11: `pitwall.dev.dumpState` + `node scripts/dump-tabs.mjs` before and after, diff empty; plus 2 screenshots | dump diff + screenshots |
| E14 | Menu flip and window count are right | Dry: label flip on `hasWindow`, ` · {k} windows` only when k > 1. Live: flip within 20 s of opening/closing the window, 2/2 | `npm test -- tree menus` + walk W12 | test names; captures |
| E15 | End to end: the Phase 4 flows work in real Cursor | Walk W1–W12 all PASS on the release sha (lab repos; real `~/.claude` read-only for W1 timing only) | testing agent walk | `captures/phase4-walk-evidence/` |
| E16 | Startup stays fast | `[Pitwall] activate` → `[Pitwall] first render` ≤ 1 s, 5/5 starts with real `~/.claude`, quiet machine, with ≥ 3 other Pitwall windows open; 1 of the 5 is a cold start triggered by a handoff, where the claim must not delay first render. Gated on the testing agent's live run, not the dry bench (#38 lesson) | exthost log | log excerpt |
| E17 | New local files carry no private content | `node scripts/dump-pitwall-windows.mjs --check-privacy` exit 0. Allowed keys, per file type: window record `pid, folder, beatAt, openSessionIds`; request `v, kind, sessionIds, folder, at, nonce`; outcome `ok, error, at`; clipboard `path, cut, at`. `docs/privacy.md` names all four file types | script + grep | output |
| E18 | 4.2b decided with evidence | ADR 0009 has a dated amendment with ≥ 5 reload and ≥ 5 quit trials in Cursor and in VS Code, and states go or no-go | file check | ADR diff |
| E19 | The package ships only what it should | `npm run package` on windows CI: archive check reports 51 entries (49 payload + `[Content_Types].xml` + `extension.vsixmanifest`; new TS bundles into `extension.js`), or the PR states why the count changed; privacy job green | CI run | run id |

## 6. Implementation tasks

Waves (parallel within a wave, one PR per task):
- **A:** T1, T2, T5, T7
- **B:** T3 (consumes T1 + T2), T6 (consumes T1's shared dir helper)
- **C:** T4 (consumes T3's router)
- **D:** T8

Rebase order where files overlap (QA C9):
- T1 before T5 (`extension.ts` after-first-render block).
- T2 before T7 (`TerminalManager.ts`).
- T2 before T3 (`chat.ts`, `navigation.ts`).
- T3 before T6 (`WorkspacesTreeProvider.ts`, `extension.ts`, manifest).
- T3 before T4 (`repository.ts`, tree, manifest).

Each later PR rebases on main after the earlier merge. `package.json` conflicts follow the Flywheel rule.

### Task 1: Window registry and handoff inbox (row 4.2 foundation, `phase4/task-1-registry-inbox`)

**Files:** Create `src/core/windows/WindowRegistry.ts`, `src/core/windows/HandoffInbox.ts`, `scripts/dump-pitwall-windows.mjs`, `docs/adr/0020-window-per-folder-handoff.md`, and these tests in `test/dry/core/windows/`: `window-registry.test.ts`, `handoff-inbox.test.ts`, `handoff-claim-processes.test.ts`. Modify `src/core/utils/paths.ts` (`pathKey`), `src/extension.ts` (start both after first render), `docs/privacy.md`.

**Interfaces:**
- Produces:
  - `pathKey(p: string): string` (`realpathSync.native` spelling, lower-cased on win32; falls back to the normalised input when the path doesn't exist).
  - `sharedDir(context): string` (= `context.globalStorageUri.fsPath`, created if missing).
  - `ownsFolder(): string | undefined`: this window's folder only when it is a single-folder window (Q17).
  - `class WindowRegistry`:
    - `constructor(dir: string, self: { pid: number; folder: string | undefined }, clock?: () => number)`.
    - `beat(openSessionIds: string[]): Promise<void>` and `start(): Disposable` (15 s timer; deletes its own file on dispose).
    - `windows(): Promise<WindowRecord[]>` (non-stale only).
    - `windowsFor(folder: string): Promise<WindowRecord[]>`.
    - `openSessionIds(): Promise<Set<string>>`.
    - `onDidChange: Event<void>`: fires only when a window's (pid, folder, openSessionIds) changes or a window appears or goes stale, never on a beat that only moves `beatAt`.
  - `WindowRecord = { pid: number; folder: string | undefined; beatAt: number; openSessionIds: string[] }`.
  - `class HandoffInbox`:
    - `constructor(dir: string, self: { pid: number; folder: string | undefined }, clock?)`.
    - `folderKey(folder: string): string`.
    - `send(folder: string, req: { kind; sessionIds }): Promise<string /*nonce*/>`.
    - `pending(folder, kind, sessionIds): Promise<string | undefined>` (for the sender's dedupe).
    - `outcome(folder, nonce): Promise<{ ok: boolean; error?: string } | undefined>`.
    - `expire(folder, nonce): Promise<boolean>` (rename to `.expired`; false = it was already claimed).
    - `claimAll(): Promise<HandoffRequest[]>` (own folder only, rename-to-claim, validated per Q19).
    - `complete(nonce, result: { ok: boolean; error?: string }): Promise<void>` (writes `.done-<pid>`).
    - `sweep(): Promise<void>` (Q16).
    - `watch(onRequests: (r: HandoffRequest[]) => void): Disposable` (creates the folder, fs.watch, `onDidChangeWindowState` focused, and the 15 s backstop).
  - `HandoffRequest = { v: 1; kind: 'open' | 'openAll' | 'new' | 'sideBySide'; sessionIds: string[]; folder: string; at: number; nonce: string }`.
  - `renameRetrying(from, to): Promise<'ok' | 'lost'>` (EPERM, EBUSY and EACCES → retry 3 × 50 ms; ENOENT → `lost`).

- [ ] **Step 1: Write failing tests**. Use real temp dirs and an injected clock.

  `window-registry.test.ts`:
  - `a window appears after one beat and disappears 45 s after its last beat`;
  - `a dead pid is stale at once`;
  - `dispose deletes the window's own file`;
  - `a beat with no change fires no onDidChange`;
  - `windowsFor matches C:\Code\Lab and c:/code/lab/ as one folder`;
  - `openSessionIds unions every live window`;
  - `a multi-root window owns no folder` (`ownsFolder` with 2 folders, and with `workspaceFile` set).

  `handoff-inbox.test.ts`:
  - `pathKey gives one key for drive-case, trailing-slash, \\?\ and forward-slash spellings of a real temp dir`;
  - `only the window whose folder matches claims a request`;
  - `two concurrent claimAll calls return the request exactly once`;
  - `claim and expire racing on one request: exactly one wins`;
  - `a request for a folder that never opens is expired by the sender`;
  - `an empty window claims nothing`;
  - `a multi-root window whose first folder matches does not claim`;
  - `complete writes an outcome the sender reads`;
  - `old claimed, done, expired and tmp files are swept after 10 min, and requests after 120 s`;
  - `a request whose sender died is not opened by a window that arrives after 120 s`;
  - `a malformed request is deleted and ignored` (bad v, unknown kind, non-UUID id, other folder);
  - `rename retries EPERM once and succeeds` (injected fs);
  - `pending finds an open request for the same folder, kind and ids`;
  - `watch creates a missing folder and the beat backstop claims without an fs event`.

  `handoff-claim-processes.test.ts`:
  - `2 processes × 20 requests: each claimed exactly once` (child `node` processes; runs on both CI jobs).
- [ ] **Step 2:** `npm run test:dry -- windows` → FAIL (modules missing).
- [ ] **Step 3:** Implement.
  - Writes go to `<name>.tmp`, then `renameRetrying`.
  - Log lines exactly as in Global Constraints.
  - Wire in `extension.ts` after `[Pitwall] first render`; nothing on the activation path awaits them.
- [ ] **Step 4:** `npm run test:dry -- windows` → PASS. `npm test` → 0 fail, skips ≤ 9.
- [ ] **Step 5:** Write `scripts/dump-pitwall-windows.mjs [--dir <globalStorage>] [--check-privacy]`.
  - It prints `pid folder beatAge open=<n>` per window, then pending, claimed and expired requests.
  - `--check-privacy` exits 1 on any key outside E17's per-file allow-list.
  - Write ADR 0020 (Q1, Q16, Q17; alternatives: link-only, `~/.pitwall`). Update `docs/privacy.md`.
- [ ] **Step 6:** Run `bash scripts/verify.sh`, then commit, push and open the PR.

### Task 2: Claude's panel by default, link scheme, Ctrl+↓ keeps focus (row 4.1, `phase4/task-2-panel-default`)

**Files:** Modify:
- `manifest/core.contributes.json`: `pitwall.defaultSessionSurface` default `"ui"`.
- `src/harnesses/claude/claudeUi.ts:11`: build `${vscode.env.uriScheme}://anthropic.claude-code/open`.
- `src/core/commands/navigation.ts:107-128` (`moveAndOpen`): sets the marker.
- `src/core/commands/chat.ts`: `openChatPrimary` consumes the marker.
- `src/core/terminal/TerminalManager.ts:238,254,266,291`: `show(preserveFocus)`.
- (F1, the drive-letter case refusal, shipped separately as v0.4.1, PR #45; T2 keeps its regression test only if one is missing.)

Tests: `test/dry/core/chat-commands.test.ts`, `test/dry/core/navigation.test.ts`, `test/dry/core/terminal.test.ts`, `test/dry/core/manifest.test.ts`, and the Claude native-UI test that covers the URI.

**Interfaces:**
- Produces:
  - `keepListFocusOnce(): void` and `consumeKeepListFocus(): boolean` (one-shot, expires after 2 s; module in `navigation.ts`).
  - `openChatPrimary(chat): Promise<'here' | 'routed' | 'terminal'>`. T3 adds `'routed'`; T2 returns `'here' | 'terminal'`.
- Consumes: S1b evidence (where focus lands per surface).

- [ ] **Step 0 (F3):** in a lab chat, diff the transcript before and after (a) a UI open with no prompt and (b) closing its Claude tab (testing agent evidence: `captures\phase4-s3-s1-s1b\`). Name the appended line type(s) in the report.
- [ ] **Step 1: Failing tests:**
  - `default surface is ui`;
  - `an sdk-cli chat opens in the terminal even with surface ui` (Q23);
  - `closing a Claude tab with no turn leaves the row idle, never working or finished` (Q24);
  - `resuming a chat appends <the line type found in Step 0> and the row stays idle, not finished` (Q24; fixture copied from the S3 before/after transcript diff, anonymised);
  - `a chat whose cwd is C:\lab\a opens in the UI of a window whose folder is c:\lab\a` (F1; also for new-session availability);
  - `the link fallback uses vscode.env.uriScheme (cursor in Cursor)` (stub `uriScheme = 'cursor'`);
  - `Ctrl+Down sets the marker and the row command, fired without await by a fake list.select, refocuses pitwall.workspacesView after the UI open`;
  - `the marker is consumed once: a later plain click does not refocus`;
  - `the marker expires after 2 s`;
  - `terminal path calls show(true) only when the marker is set`;
  - `Ctrl+Down on a repo row still only reveals it` (Q22, Sharif).

  S1b result (2026-11-18, 3 terminal + 5 ui trials): focus leaves at the open itself (terminal `show()`; webview +65–134 ms, together with the tab), never late. A refocus at about 220 ms or 550 ms held for 6 s. So terminal = `show(true)`, and UI = refocus right after the awaited `openSession`; no event fallback needed.
- [ ] **Step 2:** `npm run test:dry -- chat-commands navigation terminal manifest` → FAIL.
- [ ] **Step 3:** Implement. Regenerate `package.json` with `node scripts/build-manifest.mjs`, then run `--check`.
- [ ] **Step 4:** PASS, then `npm test`. Commit, push, PR.

### Task 3: Click a chat → its folder's window (rows 4.2, 4.6, 4.8, `phase4/task-3-router`)

**Files:** Create `src/core/windows/ChatRouter.ts` and `test/dry/core/windows/chat-router.test.ts`. Modify:
- `src/core/commands/chat.ts`: `openChatPrimary` → router.
- `src/core/commands/repository.ts`: "+" via router; "Open its window" / "Bring its window forward".
- `src/core/commands/navigation.ts`: the open-in-own-window keys keep `openFolder`, per S1.
- `src/core/providers/WorkspacesTreeProvider.ts`:
  - ` · {k} windows`, counting single-folder windows of the repo and its worktrees;
  - ` · open` from `registry.openSessionIds()`;
  - `hasWindow` in the repo row's contextValue.
- The search meta `· this window` / `· its own window`.
- `src/extension.ts`: claimed requests → `router.runClaimed`.
- Manifest: two menu entries with `when` on `viewItem =~ /hasWindow/`; "Open in New Window" leaves the repo menu.

Tests: `tree.test.ts`, `menus.test.ts`, `search.test.ts`.

**Interfaces:**
- Consumes:
  - T1: `HandoffInbox`, `WindowRegistry`, `ownsFolder`, `pathKey`.
  - T2: `openChatPrimary` (the local path).
  - `claudeProjectDirMatches` (`src/harnesses/claude/paths.ts:19`).
- Produces:
  - `class ChatRouter`:
    - `launchFolder(chat: ChatSession): Promise<string | undefined>` (Q2: first entry with a `cwd`, line by line up to 1 MB, confirmed against the project folder).
    - `route(req: { kind: HandoffRequest['kind']; chats: ChatSession[]; folder?: string }): Promise<'here' | 'routed' | 'gone'>` (dedupes pending requests; watches for `done{ok}` for 20 s, then warns once; expires at 120 s).
    - `runClaimed(reqs: HandoffRequest[]): Promise<void>` (opens serially in this window, checks availability against the launch folder, then `inbox.complete(...)`).

- [ ] **Step 1: Failing tests** in `chat-router.test.ts`:
  - `same-folder chat opens here without writing a request`;
  - `other-folder chat writes one request and calls vscode.openFolder with forceNewWindow`;
  - `launch folder skips leading entries with no cwd`;
  - `launch folder finds a cwd after a first line over 64 KB`;
  - `launch folder is the first cwd, not the latest` (T18 fixture: first cwd main, later cwd worktree → main);
  - `a first cwd that doesn't match the transcript's project folder falls back to the matching repo or worktree`;
  - `worktree chat routes to the worktree folder` (T17);
  - `a T18 chat claimed in the main window opens there` (availability checked against the launch folder);
  - `missing folder shows "That chat's folder is gone: {path}" and opens no window`;
  - `no done{ok} within 20 s warns once with "Pitwall couldn't reach the {repo} window. Click the chat again."`;
  - `a claim whose open fails still warns the sender`;
  - `a second route for the same chat while pending writes no second file and calls openFolder again`;
  - `"+" twice on a slow-starting window starts one chat`;
  - `"+" on another repo sends kind new to that repo`;
  - `an empty window routes every chat`;
  - `a multi-root window opens its own first-folder chat locally and routes others`;
  - `runClaimed opens chats one at a time in request order and logs handoff opened`.

  In `tree.test.ts`:
  - `repo description adds " · 2 windows" only when k > 1`;
  - `" · open" counts tabs in other windows`.

  In `menus.test.ts`: `repo menu shows "Open its window" without a window and "Bring its window forward" with one`.

  In `search.test.ts`: `chat meta says "· this window" or "· its own window"`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement. `launchFolder` reads through the existing Claude harness transcript reader. The registry's `onDidChange` triggers a tree refresh, debounced to 500 ms.
- [ ] **Step 4:** PASS, then `npm test`. Commit, push, PR.

### Task 4: Repo click opens all its chats as tabs; reliable tab binding; side by side (rows 4.3, 4.4, 4.9, `phase4/task-4-repo-tabs`)

**Files:** Modify:
- `src/core/harness/kit/NativeUiTabSurfaceService.ts`;
- `src/core/commands/repository.ts` (`pitwall.openRepoChats`, `pitwall.showRepoChatsSideBySide`, hidden `pitwall.dev.dumpState`);
- `src/core/providers/WorkspacesTreeProvider.ts` (repo item `command` = `pitwall.openRepoChats`);
- `src/core/commands/navigation.ts` (Enter on a repo → `openRepoChats`; Ctrl+↓ per Q22);
- the manifest.

Create `scripts/dump-tabs.mjs`. Tests: `test/dry/shared/native-ui-surface.test.ts`, `test/dry/core/navigation.test.ts`, `test/dry/core/menus.test.ts`.

**Interfaces:**
- Consumes: T3 `ChatRouter.route({kind:'openAll' | 'sideBySide'})` and `runClaimed`.
- Produces:
  - `NativeUiTabSurfaceService.openSerially(ids: string[], open: (id) => Promise<void>, token?: CancellationToken): Promise<Map<string, Tab | undefined>>`. It opens one, waits ≤ 5 s for a new `claudeVSCodePanel` tab or a reveal of the bound one, binds it, then opens the next, and stops on cancel.
  - `pitwall.dev.dumpState` writes `<globalStorage>/pitwall-dump/<pid>.json` with tab groups, labels, pinned flags, bound ids and each repo's sidebar main-folder chat ids. It is hidden from the palette.

- [ ] **Step 1: Failing tests:**
  - `serial opens bind each new tab to the session just requested`;
  - `two new chats both titled "Claude Code" bind to the right sessions`;
  - `a Claude tab the user opened stays unknown`;
  - `an already-bound session is revealed, not reopened`;
  - `a 5 s timeout leaves the session unbound and continues`;
  - `cancel stops before the next open`;
  - `repo click opens the repo's main-folder sidebar chats and no worktree chats`;
  - `repo click opens at most the Q18 cap, newest first, and offers the rest`;
  - `repo click in its own window with all chats open reveals only the last-open tab`;
  - `Enter on a repo runs openRepoChats`;
  - `side by side splits up to 4 open tabs, one group each, and is hidden below 2`;
  - `serial bind replaces T2's interim title re-match: two "Claude Code" tabs survive a group rebuild without swapping bindings` (QA #47 note: T2 re-matches by title and kind on group rebuilds as an interim);
  - `no code path calls tabGroups.close or moveEditor outside side by side` (an architecture test greps `src/`).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement. Side by side uses `workbench.action.moveEditorToNextGroup` / `splitEditorRight` on the bound tabs in that window only. Log `tab bound` per bind.
- [ ] **Step 4:** PASS, then `npm test`. Commit, push, PR.

### Task 5: Bottom bar repo · branch (row 4.5, `phase4/task-5-status-bar`)

**Files:** Create `src/core/windows/RepoStatusBar.ts` and `test/dry/core/windows/repo-status-bar.test.ts`. Modify `src/extension.ts`; rebases after T1.

**Interfaces:**
- Consumes: the existing git branch reader (the one the tree uses for `⎇`) and `workspaceFolders[0]`.
- Produces: `class RepoStatusBar { constructor(folder, repoInfo); refresh(): Promise<void>; dispose() }`.

- [ ] **Step 1: Failing tests:**
  - `main folder shows "$(repo) {repo} · ⎇ {branch}"`;
  - `worktree folder adds " ⧉" and shows its own branch`;
  - `worktree status bar watches the gitdir HEAD` (real temp worktree: `.git` is a file, HEAD lives at `<main>/.git/worktrees/<name>/HEAD`; a `git switch` in the worktree refreshes the text);
  - `tooltip is the folder path`;
  - `hidden in an empty window and outside git`;
  - `click runs pitwall.workspacesView.focus`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. It is a left-aligned item; it watches the resolved HEAD path. **Step 4:** PASS, then `npm test`. Commit, push, PR.

### Task 6: FILES across windows (row 4.7, `phase4/task-6-files`)

**Files:** Create `src/core/files/SharedClipboard.ts`, `src/core/files/RepoDropController.ts`, `src/core/files/envIgnoreCheck.ts` and `test/dry/core/files-cross-repo.test.ts`. Modify:
- `src/core/providers/FilesTreeProvider.ts`: root = this window's folder; `view.message` banner; drag mime.
- `src/core/commands/files.ts`: clipboard → `SharedClipboard`; remove the "Refusing to paste outside the active worktree" guard (the target is always this window's folder); add `pitwall.files.copyToRepo`.
- `src/extension.ts:151`: pass `dragAndDropController` to `createTreeView('pitwall.workspacesView', …)`.
- The manifest and `docs/privacy.md`.

**Interfaces:**
- Consumes: T1 `sharedDir()`; T3 registry (for `{winName}`).
- Produces:
  - `SharedClipboard`: `set(path, cut)`, `get()`, `clear()`, `onDidChange`;
  - `isEnvLike(name): boolean`;
  - `checkIgnored(repoRoot, relPath): Promise<boolean | 'error'>`;
  - `copyInto(repoRoot, srcPath): Promise<{ dest: string; clashed: boolean }>`.

- [ ] **Step 1: Failing tests:**
  - `FILES shows this window's folder, not the clicked repo`;
  - `FILES is empty in an empty window`;
  - `copy in window A is visible to paste in window B` (two `SharedClipboard` instances, one dir);
  - `cut then paste moves the file and clears the clipboard`;
  - `paste after the source file is gone warns and clears the clipboard`;
  - `name clash saves as "{name} copy{.ext}"`;
  - `Copy to another repo lists other repos only and copies into the chosen root`;
  - `dropping a FILES row on a repo row copies it there`;
  - `an Explorer text/uri-list drop is not accepted` (Q20);
  - `dropping on the same repo shows "That file is already in {repo}. Drop it on a different repo to copy it there."`;
  - `isEnvLike: .env, .env.local yes; .env.example, .env.sample, .env.template, env.txt no`;
  - `an un-ignored .env copy warns with Add to .gitignore and Not now; accepting appends "/{rel}" with forward slashes, adds a newline first when the file lacks one, and re-checks`;
  - `git check-ignore exit 128 makes no offer and logs it`;
  - `banner text matches §3e`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. Copy strings come from §3f exactly. **Step 4:** PASS, then `npm test`. Commit, push, PR.

### Task 7: Terminal tag spike (row 4.2b, `phase4/task-7-terminal-tag`)

**Files:** Spike notes go in the PR body. Amend `docs/adr/0009-restored-terminals-keep-their-chat.md`. On a go only: `src/core/terminal/TerminalManager.ts` (rebases after T2) and `test/dry/core/terminal.test.ts`.

- [ ] **Step 1:** In the testing profile, create Pitwall terminals with `env: { PITWALL_CHAT_ID: <id> }`. After a reload, read `terminal.creationOptions.env` on each revived terminal.
  - Run 5 reloads + 5 quits in Cursor and the same in VS Code, with a file in front at quit on half the runs.
  - Each reload trial also clicks one un-restored row and counts `[shortId]` tabs (Q21).
- [ ] **Step 2:** Decide go or no-go.
  - **Go**, if the tag survives in ≥ 9/10 per editor: match revived terminals by tag first and fall back to the title. Tests:
    - `a revived terminal with PITWALL_CHAT_ID binds to that chat regardless of its title`;
    - `an untagged terminal falls back to title matching`.
  - **No-go:** amend ADR 0009 with the table and keep titles.
  - Either way, record the O2 count (Q21).
- [ ] **Step 3:** Commit the ADR amendment (and the code on a go), then push and open the PR.

### Task 8: Close: walk, evaluator, v0.5.0 (`phase4/task-8-close`)

**Files:** `docs/progress_reports/phase4-scorecard.md`, `docs/progress_reports/phase4-handoff.md`, `CHANGELOG.md` [0.5.0], `README.md`, `package.json` version `0.5.0`, ROADMAP.

- [ ] **Step 1:** Testing agent walk on the merged sha. Lab repos: `uj-lab-a`, `uj-lab-b`, `uj-lab-c`, plus worktree `uj-lab-a-wt` (create any that are missing), plus one T18 chat.
  - **W1** — Panel default and startup timing (E2, E16).
  - **W2** — 3 repos + 1 worktree from one window (E3, E6).
  - **W3** — Re-clicks and a double-click (E4).
  - **W4** — Repo click opens all chats (E5).
  - **W5** — ` · open` matches tabs (E7).
  - **W6** — Ctrl+↓ ×3 (E8).
  - **W7** — Bottom bar (E9), including a `git switch` inside the worktree window: the bar updates ≤ 5 s (its HEAD lives outside that window's folder, QA #44).
  - **W8** — T18 chat (E10).
  - **W9** — "+" in another repo (E11).
  - **W10** — FILES (E12).
  - **W11** — Pin, split and reorder survive (E13).
  - **W12** — Menu flip and ` · {k} windows`, plus negative paths (E14 and Review Focus 1–5):
    - close the target window mid-handoff;
    - a stale request;
    - a deleted worktree;
    - an empty window.
- [ ] **Step 2:** Run the GT row of §4.
- [ ] **Step 3:** The independent evaluator grades E1–E19 on a fresh clone and writes `phase4-scorecard.md`. The loop repeats until 19/19 PASS; after 3 rounds stuck on one criterion, escalate to Sharif.
- [ ] **Step 4:** Release PR (CHANGELOG, README, version 0.5.0). After the merge, tag the annotated `v0.5.0`, push it, and flip ROADMAP Phase 4 (rows, §0, §6, version). Then send the marketing handoff.

## Out of scope (later phases)

- Pop-ups, sound and bottom-bar counts, including the needs-you jump list: Phase 5. That phase reuses T3's router for "Open chat".
- Everything in one window (terminal mode, a Claude feature request): v2.
- Search inside chats: 7.1.
