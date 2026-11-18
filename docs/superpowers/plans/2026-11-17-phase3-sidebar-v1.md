# Phase 3 — Sidebar v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Pitwall list matches the canvas. From any one Cursor window you see every repo with a Claude Code session in the last 14 days, and each repo's sessions with branch, status dot and age. The list is sorted by who needs you, rows move only when a status changes, and hotkeys and search reach everything. Tag `v0.4.0`.

**Architecture:**
- **Data.** Two new read-only readers of Claude Code's own files, both in the Claude harness (D9). `ClaudeRepoDiscovery` lists the folders that had sessions in the last 14 days from `~/.claude/projects`. `ClaudeSessionsFile` reads live status (busy / waiting / idle) from `~/.claude/sessions/*.json`, replacing the `claude agents --json` spawn as the needs-you source, with that spawn kept as a fallback.
- **Status.** The attention service now tracks every sidebar session, not only open ones, so every row gets one of four statuses (D4). Finished turns idle once you look at the chat; the "seen" time is stored on the chat record.
- **Tree.** It loses its worktree level: repo → session, with `⎇ branch` and `⧉` on each row (D14). Order comes from one pure module whose sort key changes only when a status changes (D21).
- **Storage.** Every `globalState` collection gets the record-level stale-echo overlay that R33a gave the PID records (F3).
- **Hidden extras.** Changes, worktree create/delete/merge/rebase, PR badges and checkout-PR are hidden by removing their contributions and wiring. Their source stays in the tree, dormant.

**Tech Stack:** TypeScript 5, esbuild, `node --test` dry tests with the `vscode` stub, `@vscode/test-electron` (integration + terminal-restore e2e), `@vscode/vsce@3.2.1`, GitHub Actions (`ubuntu-latest`, `windows-latest`, privacy job). No new runtime dependencies.

**Spec:**
- [ROADMAP](../../../ROADMAP.md) v0.33: §3 Phase 3 rows 3.0–3.10. §2 decisions:
  - D4, D12–D14, D17–D19, D21, D24, D28, D29, D33, D34, D36, D37: the sidebar design.
  - D9: Claude-only.
  - D35: one window per folder; the opener is Phase 4.
  - D39: team flow.
- Spec canvas https://claude.ai/artifact/XhYy9L747DwQzBsQDpaFF2, boards Navigation, SidebarOptions, StatusRules, Menus, Hotkeys, Decisions and Brand. All UI strings below are copied verbatim from it. Its decision numbers ("decision 12") are the canvas log's, not ROADMAP D-numbers.
- [Assumption tests](../../research/2026-11-16-assumption-tests.md):
  - T1: the sessions file reports `waiting` + `waitingFor`, with transitions idle → busy → waiting → busy → idle.
  - T13: the Ctrl+Alt+F clash with Cursor's `list.find`.
- [Phase 2 handoff](../../progress_reports/phase2-handoff.md): F3 → row 3.0; R33a/R34 (PID overlay); R36–R45 (needs-you rules that must keep holding).

## Phase tracker

```
PITWALL — phase plan
─────────────────────────────────
Phase 1 : Import Agntree            [████████████████████] ✅ v0.2.0
Phase 2 : Windows parity            [████████████████████] ✅ v0.3.0
Phase 3 : Sidebar v1                [███.................] ⏳ plan revised after QA pre-flight
Phase 4 : Windows and tabs
Phase 5 : Status + pop-ups
Phase 6 : Package + launch (v1.0.0)
Phase 7 : After v1
```

## Rulings made while planning (lead; spec silent or ambiguous)

| # | Ruling | Why | Cost if wrong |
|---|---|---|---|
| P1 | Discovered repos are written into `pitwall.repositories` with `origin: 'discovered'`; a dismissal is a record `{rootPath, dismissedAt}` in a new key `pitwall.dismissedRepos` | Worktrees, chats, import and ids all hang off stored repositories; a parallel "virtual repo" path would fork every consumer | A dismissed repo needs both records consistent; Task 3 tests pin it |
| P2 | A dismissed repo comes back only when a session **starts** in it after `dismissedAt`, judged by the transcript's first entry timestamp, or when it is added by hand | Canvas decision 19: "it comes back if you add it again or a new session starts in it". An old session that is still active must not resurrect it | A long-running session started before dismissal keeps the repo hidden; acceptable, matches the words |
| P3 | Retention default becomes 14 days (`pitwall.autoImport.retentionDays` 15 → 14), shared by discovery and import | D18 / canvas decision 3 say 14 | none |
| P4 | Live status reads `~/.claude/sessions/*.json` (`.json` only; pid alive in this `pidDomain`). `claude agents --json` stays as the fallback, per session, when the folder is missing or a file has no known status. The file is read fresh each tick, so its status is current truth: `observedAt` = the snapshot's read time, and the R40 stale-wait drop applies only to fallback (cached `claude agents`) samples. `statusUpdatedAt` is used only as `writtenAt`, the wait-start anchor; the R45 floor (`lastClearAt`) stays the fetch time. Amends ADR 0006 via new ADR 0018 (QA pre-flight B1) | No CLI spawn every 10 s; covers panel sessions (T1); `statusUpdatedAt` is the real wait start, which R40/R41 had to approximate from transcript mtime. A drop keyed on `statusUpdatedAt` would hide a real wait for as long as it lasts, because it doesn't move while waiting | Older CLIs without the folder fall back; Smoke 2 checks both agree live |
| P5 | Toasts stay limited to open chats in Phase 3 (no behaviour change to R36–R45); every row gets a dot. Pop-ups for all sessions are Phase 5 (5.1/5.2) | Keeps the hard-won needs-you rules untouched while the source changes | none in this phase |
| P6 | "Rows move only on a status change": the in-group sort key is `statusSince` (when the row entered its current status), not last activity. The order is recomputed only when a status changes or a row is added/removed | A working session writes every few seconds; sorting by activity would reshuffle on every tick, under the mouse | Two rows entering the same status in the same tick tie-break by title, stable |
| P7 | Session row branch = its worktree record's live branch (`Worktree.branch`), not the transcript's `gitBranch`; plain-folder repos show no `⎇`. `⧉` iff the worktree is not the repo's main worktree | The worktree's current branch is what "working on" means; the transcript stamp is per-message history | A detached HEAD shows the short sha, like the worktree row does today |
| P8 | The worktree level is removed from the **view only**; chats keep their `worktreeId` in storage | Smallest change; worktree records still drive branch, ⧉, FILES-follow and Phase 4's window-per-folder | none |
| P9 | Hidden D19 extras: contributions removed from `manifest/core.contributes.json`, construction removed from `extension.ts` (Changes provider, PR timer, `GitHubService` fetches), source files kept dormant with a header comment | Restoring is a manifest + wiring change; deleting code now would make a later restore a rewrite | Dormant files can rot; the architecture test keeps them compiling |
| P10 | Ctrl+Alt+F moves from Find Session to "toggle FILES" (D12/D19). Find Session stays reachable from the search box footer, the view title overflow and the Command Palette. Ctrl+Alt+N stays as an alias of Ctrl+Alt+0 | Canvas hotkey table; avoids losing a shipped key | Muscle memory for Ctrl+Alt+F → Find Session breaks; noted in the changelog |
| P11 | Ctrl+Alt+1–9 / a repo pick from search **reveal, expand and select** the repo in the list; the same key again opens its next chat through today's opener (terminal). "All its chats as tabs" is Phase 4 row 4.3 | Phase 4 owns windows and tabs | none |
| P12 | Ctrl+Alt+Shift+1–9 and Ctrl+Alt+O call `vscode.openFolder(uri, {forceNewWindow: true})`; VS Code / Cursor focus an existing window that already has that folder open | No window registry needed until Phase 4 | If Cursor opens a duplicate window instead, S5's window-count check catches it and the keys move to Phase 4 |
| P13 | First run auto-adds every discovered repo (no "Show them all / Choose repos…" prompt) | Canvas log locks "found automatically"; the prompt was a drawn variant | A user with many repos dismisses some by hand |
| P14 | The header bell (sound) is not added in Phase 3; sound is row 5.3 | Avoids a control that does nothing | none |
| P16 | Every chat record has a "seen" baseline: `createChat` and import set `seenAt` = now, and records loaded without one get `seenAt` = first time this version lists them. Finished = turn ended after `seenAt` (QA B2) | Otherwise ~500 imported sessions show green "finished" on first run and every repo ranks finished | A turn that ended just before first listing shows idle, not finished; acceptable |
| P17 | Discovered repos get a deterministic id `repo-<first 12 hex of sha1(canonical root, lower-cased on Windows)>`; `addRepository` checks existing roots with `samePath`; the repositories overlay merge dedupes by `samePath`, keeping the oldest record (QA B3) | Two windows adding the same root must converge on one record, or worktree ids and chats split | Legacy manual repos keep their random ids |
| P18 | Inbox order replaces the stored repo order: `moveRepositoryUp/Down` commands and menu entries are removed (code parked dormant), done in Task 5 (QA S9) | D21: position = urgency; manual order would fight it | none |
| P19 | The header keeps a search icon next to the folder icon: the canvas Navigation board's header shows search (tooltip `Search repos and chats (Ctrl+Alt+R)`), bell and folder; D28 dropped only the header "+" (QA D-a) | The canvas is the spec for header icons | none |
| P20 | Ctrl+↓/↑ or Enter on a **repo** row expands and selects it (P11); "all its chats" is Phase 4 row 4.3 (QA D-c) | Phase 4 owns tabs | none |
| P21 | Header naming: Cursor shows the container title `PITWALL` on top and, because FILES sits below, gives the list its own header. The list's header reads `REPOS` with the description `sorted by who needs you` and the search + folder icons, the closest native form of the canvas header `PITWALL  sorted by who needs you [search][bell][folder]` | A container with two sections always shows per-section headers; naming the list `Pitwall` would print `PITWALL` twice | One word differs from the canvas |
| P22 | Native limits of the standard list (canvas decision 1, D10, D29), accepted for v1 and listed in §3i: the status word uses Cursor's muted description colour (the dot carries the colour, the word the meaning, so the brand's "never colour alone" holds); the selected row uses Cursor's selection, not the orange edge; high-contrast themes get the dark/light SVGs | TreeItem descriptions and selection can't be styled per row; the custom card panel that can is v2 (7.2) | none for v1 |
| P23 | A window's list redraws from storage when the window gains focus and on each 60 s scan, so stars, names and dismissals written by another window show up (testing S1 finding: window B kept stale stars and names until it wrote or reloaded; the stored data was current) | `globalState` has no cross-window change event; refreshing on focus covers the moment a user can act on a row | A window left unfocused shows other windows' edits up to 60 s late |
| P24 | The claude status icons are circles only (no brand mark), and the `new` icon becomes a dashed hollow ring in the idle grey (canvas brand book Don'ts: no Claude mark, no Claude clay #D97757; row anatomy = 9 px status dot). Checks assert circles-only and no #D97757 (QA PR #27) | Today's `new` icon is the Claude mark in #D97757, which the brand book forbids | none |
| P25 | The overlay resolves conflicts by write stamps, not a hold time: per-field stamps on chats, per-record stamps elsewhere, timed tombstones for removals (pruned after 14 days); the newest stamp wins, and an own write is released once the store shows a stamp ≥ its own (QA PR #28: the 30 s hold let an earlier write from one window permanently revive over a later one from another) | One machine, one clock, so stamps order writes correctly; stale echoes carry older stamps and lose | Equal-ms ties break by a per-window id |
| P26 | Native limits of row-icon and FILES hover text (Sharif, 2026-11-17, approved after the canvas page "Phase 3 decisions"): the repo row hover icons show fixed text, "New Claude Code session in this repo" and "Session history for this repo: every past chat", where the canvas names the repo (and the 🕘 text drops the canvas's trailing "in this repo" so it isn't said twice); the FILES header has no hover text, so "Show or hide files" with Ctrl+Alt+F appears in the Command Palette and the keyboard shortcuts list. E19 grades the rest of §3i byte for byte | A contributed action's title is static and a view header has no tooltip API; the repo-named versions return with the custom card panel (7.2) | Three hover strings differ from the canvas |
| P15 | The live walk on Sharif's real `~/.claude` is **read-only**: list, order, status, search and history only. Open / new-chat / dismiss flows run on the testing agent's lab repos | Resuming a real session appends to its transcript; the testing agent must not touch Sharif's work | none |

## Global Constraints

- **Privacy:** read only `~/.claude/sessions/*.json`. Never open, stat-read or log `*.key` files or anything else in that folder. Log only `sessionId`, `pid`, `status`, `statusUpdatedAt`. `~/.claude` is read-only for Pitwall. `docs/privacy.md` lists both new sources (Task 2, Task 3).
- **Never track** `.packages/`, `transcripts/`, `.claude/` (except `.claude/skills/pitwall-*`), `.superpowers/`, `.env`. Run `bash scripts/verify.sh` before every push.
- **Claude Code** is driven only through its public link and commands; never copied, embedded or modified. No "Claude" in the product name.
- **Exact values:**
  - Retention is 14 days.
  - Status words on rows: `working`, `needs you`, `finished`, `idle`.
  - Repo rank: needs you → finished → working → idle. Session rank: needs you → working → finished → idle.
  - Within each group: newest `statusSince` first.
  - D17 dot colours. Dark theme: working `#4c9aff`, needs you `#f0883e`, finished `#3fb950`, idle `#6b6f76`. Light theme: `#2f7cf6`, `#e0701c`, `#2da44e`, `#818b98`.
  - Dot shapes: working = solid with glow ring; needs you = solid with glow; finished = solid; idle = hollow ring.
- **Copy:** every UI string in §3 is verbatim from the canvas. Sentence case. No exclamation marks or emoji except `⎇`, `⧉`, `🕘`, `✨` where the canvas uses them.
- **Activation:** discovery and the first status read never block activation. Activation to first render stays ≤ 1 s with Sharif's real `~/.claude` (521 transcripts in 14 days, 1,606 total, 30 project dirs on 2026-11-17).
- **Windows parity:** every new test passes on the windows CI job. Paths are compared with `samePath()`, and repo roots get one canonical native spelling (Phase 2 Task 1).
- **Opener unchanged:** a chat still opens through today's opener (terminal default). Claude's panel by default is Phase 4 row 4.1, which needs 4.2's window-per-folder (T5).
- **R36–R45** needs-you behaviour must keep passing: existing attention tests unchanged, except where a test names `claude agents` as the source. Toast state (open chats only, P5) is kept separate from row-status state (all chats).
- **Performance:** the attention tick stats transcripts only for open chats and live sessions-file sessions; other chats' transcript changes come from the 60 s discovery scan (QA S5). Tick p95 ≤ 50 ms with 500 chats, measured by a bench outside the default suite (E18).
- **Flywheel:**
  - One PR per task on branch `phase3/task-N-<slug>`.
  - QA approves an exact sha. The lead merges only with `gh pr checks` green at that sha, then confirms main CI before the next merge.
  - The testing agent walks each merge in its own profile.

## Review Focus

1. **Huge or odd `~/.claude/projects`** (thousands of transcripts, multi-MB files, unreadable or locked files, a transcript with no `cwd`): discovery finishes in the background, skips bad files, and never throws into activation. Test in Task 3.
2. **A transcript whose `cwd` no longer exists, or sits on another drive or casing:** it is skipped, or matched through `samePath`, with no duplicate repo rows. Two windows discovering the same repo at once produce one stored repo. Test in Task 3.
3. **A sessions file for a dead pid** (crashed CLI, killed Cursor): never shown as working or waiting forever. The pid-alive check drops it. Test in Task 2.
4. **A worktree `cwd`:** maps to its main repo via the git common dir, so worktree sessions sit under the main repo with `⧉`. A non-git folder becomes a folder repo with no `⎇`. Test in Task 3 and Task 5.
5. **Two windows writing the same collection** (star in A, rename in B, dismissal in A) through a stale echo: no write is lost or revived. Test in Task 1.

---

## 1. Folder / file structure (paths this plan touches)

```
pitwall/
├── manifest/core.contributes.json            T3 T4 T7 T8 T9 T10  views/menus/keys/settings (package.json regenerated)
├── package.json                              regenerated by scripts/build-manifest.mjs; version 0.4.0 at close
├── src/
│   ├── extension.ts                          T3 T4 T5 T8 T9  wire discovery, drop Changes/PR wiring, new commands
│   ├── core/
│   │   ├── types.ts                          T1 T5     STORAGE_KEYS.DISMISSED_REPOS, Repository.origin, ChatSession.seenAt
│   │   ├── services/
│   │   │   ├── storageOverlay.ts             T1  NEW RecordOverlay<T>: record-level stale-echo guard
│   │   │   ├── StorageService.ts             T1     every collection through the overlay; dismissals, seenAt, P17 ids
│   │   │   ├── RepoDiscoveryService.ts       T3  NEW cwd → repo root, dedupe, dismissals, add
│   │   │   ├── GitService.ts                 T3  getMainRepoRoot(cwd) via --git-common-dir
│   │   │   └── SessionAttentionService.ts    T5  track every sidebar chat; seenAt; statusSince
│   │   ├── harness/types.ts                  T2 T3 T6  HarnessLiveState.liveStatus, discoverRecentFolders, icon states
│   │   ├── harness/treeIcons.ts, sessionUtils.ts   T6  icon state rename
│   │   ├── providers/SessionSearchTreeProvider.ts  T6  'closed' literal → 'idle'
│   │   ├── providers/
│   │   │   ├── WorkspacesTreeProvider.ts     T5 T7  repo → session rows, descriptions, ordering, "+" and 🕘
│   │   │   ├── sessionStatus.ts              T5  NEW four-status derivation (pure)
│   │   │   ├── inboxOrder.ts                 T5  NEW rank + frozen-key ordering (pure)
│   │   │   ├── chatTooltip.ts                T5  worktree folder line, status word
│   │   │   └── ChangesTreeProvider.ts        T4  dormant (header comment), no longer constructed
│   │   └── commands/
│   │       ├── repository.ts                 T3 T7  dismissRepository, session history, copy path, reveal
│   │       ├── navigation.ts                 T8  NEW goToRepo(n), openRepoWindow(n), toggleFiles, list move-and-open
│   │       └── search.ts                     T9  NEW Ctrl+Alt+R quick pick
│   └── harnesses/claude/
│       ├── ClaudeSessionsFile.ts             T2  NEW reads ~/.claude/sessions/*.json (status, pid-alive)
│       ├── ClaudeRepoDiscovery.ts            T3  NEW recent folders from ~/.claude/projects
│       └── ClaudeHarness.ts                  T2 T3  live states from the sessions file; discovery capability
├── resources/icons/
│   ├── harness/<4 harnesses>-{dark,light}-{working,needs,finished,idle,new}.svg   T6  40 files regenerated (claude in D17 colours; dormant harnesses keep their tint); count unchanged
│   └── pitwall-activitybar.svg               T6  status-row mark, one colour, enlarged needs-you dot
├── scripts/
│   ├── generate-harness-icons.mjs            T6  new states + D17 hexes
│   ├── list-claude-repos.mjs                 T3  ground truth: repo roots with sessions in N days
│   ├── probe-claude-sessions.mjs             T2  ground truth: live sessionId/status/pid
│   └── check-icon-colours.mjs                T6  asserts SVG fills = D17 hexes
├── test/dry/core/                            storage, discovery, inbox-order, session-status, tree, menus, manifest, search, navigation
├── test/dry/harnesses/claude/                claude-sessions-file, claude-repo-discovery, claude (live states)
├── docs/
│   ├── adr/0018-live-status-from-sessions-file.md   T2  amends 0006
│   ├── adr/0019-repos-discovered-and-dismissed.md   T3
│   ├── privacy.md                            T2 T3  two new read-only sources
│   └── progress_reports/phase3-scorecard.md, phase3-handoff.md   T10
├── README.md, CHANGELOG.md                   T10  status + [0.4.0]
└── ROADMAP.md                                every merge flips its row; T10 closes Phase 3
```

## 2. Flowchart

```
 Activation ──> first render from stored repos/chats (≤ 1 s, nothing awaited below)
     |
     +--> RepoDiscoveryService.scan()  (after first render, then every 60 s and on window focus)
     |      ClaudeRepoDiscovery: ~/.claude/projects/*/*.jsonl mtime < 14 d --> {cwd, firstEntryAt, lastActivity}
     |      GitService.getMainRepoRoot(cwd) --> repo root | folder | skip (missing)
     |      dedupe (samePath) --> dismissed? (firstEntryAt > dismissedAt ? un-dismiss : skip)
     |      StorageService.addRepository(origin:'discovered') --(RecordOverlay)--> globalState
     |      SessionImportService (existing) --> chat rows for the repo's worktrees (14 d)
     |
     +--> SessionAttentionService.poll()  every 4 s
            poll set = open chats ∪ chats with a live sessions-file entry (others refreshed by the 60 s scan)
            ClaudeHarness.getLiveStates(ids)
               ClaudeSessionsFile.snapshot() --(missing dir)--> ClaudeAgentsService (fallback)
               readTurnState(tail) (cached by mtime)
            --> HarnessLiveState {turnState, turnEndedAt, liveStatus, waitingFor, writtenAt}
            sessionStatus(live, seenAt) --> needs | working | finished | idle
            status changed? --yes--> statusSince = now --> tree.refresh() --> inboxOrder re-sort
                           --no---> no re-sort (P6)
            needs-you toast rules R36–R45 (open chats only, P5)

 User ──> click / Enter / Ctrl+↓ on chat --> openChat (today's opener) --> seenAt = now --> finished → idle
      ──> repo "+" --> new Claude chat in repo root      ──> repo 🕘 --> history quick pick --> import + open
      ──> right-click "Dismiss from Pitwall" --> remove rows + dismissal record --> info message
      ──> Ctrl+Alt+1–9 --> reveal/select repo N (again: next chat)   Ctrl+Alt+0 --> longest wait
      ──> Ctrl+Alt+R --> quick pick REPOS | CHATS | INSIDE CHATS(later) | ✨ Find Session footer
      ──> Ctrl+Alt+F --> toggle FILES      Ctrl+Alt+Shift+N / Ctrl+Alt+O --> openFolder (new window)
```

## 3. UI wireframes

### 3a. Pitwall sidebar (the main list)

BEFORE (v0.3.0: repo → worktree → chat, creation order, no status on closed chats):
```
+--------------------------------------------------+
| PITWALL: WORKSPACES     [+repo][...]             |
+--------------------------------------------------+
| v [repo] job-market                              |
|   v [⎇] main   ● ↑1 ↓0  PR #12                   |  <- worktree level
|       [◐] One-off apply              2m          |  <- dot only if the chat is open
|       [○] LinkedIn job scroller      14m         |
|   > [⎇] feat/fiu-apply                           |
| v [repo] wynwood                                 |
| > CHANGES                                        |  <- Agntree Changes view
| > ALL FILES                                      |
+--------------------------------------------------+
```

AFTER (v0.4.0):
```
+--------------------------------------------------+
| PITWALL                                          |
| REPOS  sorted by who needs you   [🔍][📁+][...]  |  <- view desc; search + add repo; rest in overflow
+--------------------------------------------------+
| v job-market      1 need you · 2 open   [🕘][+]  |  <- 🕘 + "+" inline on hover (D28, D34)
|    ● One-off apply           ⎇ main  needs you · 2m   [🔔]  <- orange #f0883e, glow; bell action only when it needs you
|    ● Job market networking…  ⎇ main  working · now · open  [>_][⑂]  <- blue #4c9aff; hover: open in terminal, fork
|    ● LinkedIn job scroller   ⎇ feat/fiu-apply ⧉  finished · 14m   <- green; ⧉ = worktree
| v wynwood         2 sessions            [🕘][+]  |
|    ● Event landing page      ⎇ feat/rsvp-sticky ⧉  finished · 6m
|    ○ Ticket checkout bug     ⎇ main  idle · 1h              <- hollow gray ring
| > gatherly        1 needs you                    |  <- collapsed: summary stays visible (canvas: "1 needs you")
| > apparae         2 sessions                     |
+--------------------------------------------------+
| > FIND SESSION    (only when searches exist)     |
| > FILES  job-market ⎇ main  C:\code\job-market  |  <- renamed from "All Files"; collapsed; Ctrl+Alt+F; follows the clicked repo or the opened chat's worktree
+--------------------------------------------------+
  (CHANGES view gone; no worktree rows; no PR badges)
```
Repo description rule: `{k} needs you` (k = 1) / `{k} need you` (k > 1) and `{n} open` joined by ` · `, each left out when 0; both 0 → `{m} sessions` (`1 session` when m = 1). `open` = open as a tab in this window (other windows' tabs are Phase 4).
Activity-bar badge: the number of sessions that need you (canvas StatusRules "YOU GET": "+1 on the sidebar badge"), hidden at 0.
Session hover actions (canvas StatusRules item 5): bell (needs-you rows only; opens the chat), open in terminal, fork. Star, rename and close move to the right-click menu.
Session description: `⎇ {branch}[ ⧉]  {status} · {ago}[ · open]`. A plain-folder repo leaves out `⎇ {branch}`.

### 3b. Hover tooltips (verbatim)

```
Repo row:      job-market: Ctrl+Alt+1 jumps here, Ctrl+Alt+Shift+1 opens it in its own window. Right-click for more.
               (positions 10+ leave out the key clauses: "job-market: Right-click for more.")
Every session: {title} / {status} · {ago} / Folder: C:\code\job-market   (D14: hover shows the folder, main too)
⧉ session:     adds the canvas line: Worktree: a separate folder, so it runs in its own window (C:\code\job-market-wt\fiu)
Repo "+":      New Claude Code session in job-market
Repo 🕘:       Session history for job-market: every past chat in this repo
Header search: Search repos and chats (Ctrl+Alt+R)
Header folder: Add a repository
FILES:         Show or hide files (Ctrl+Alt+F)
```

### 3c. Right-click menus

BEFORE, repo row: Add Worktree · Checkout PR · Move Up · Move Down · Remove from Pitwall…
AFTER, repo row:
```
+------------------------------------------------+
| New Claude Code session                        |
| Session history…                               |
| Open its window              Ctrl+Alt+Shift+1  |  <- P12; label is fixed in Phase 3
|------------------------------------------------|
| Copy Path                                      |
| Reveal in File Explorer                        |
|------------------------------------------------|
| Dismiss from Pitwall                           |
+------------------------------------------------+
```
Session row (Agntree's set, kept, canvas Menus board): Open · Open in terminal · Rename… · Star · Fork (copy the conversation) · Copy resume command · Copy session ID · Close · Delete…  ("Fork with changes" is removed: it creates a worktree, D19.)

### 3d. Dismiss confirmation (info message, no modal)

```
Dismissed job-market from Pitwall. Nothing changed on disk: the repo, its files and its chats are untouched. It comes back if you add it with the folder icon, or when a new Claude Code session starts in it.
```

### 3e. Search (Ctrl+Alt+R), Cursor's quick-pick

```
+----------------------------------------------------------------------+
| Search repos, chats, and what was said in them  (Ctrl+Alt+R)         |
+----------------------------------------------------------------------+
| REPOS                                                                |
|   job-market                                   3 sessions            |
| CHATS                                   by name or branch            |
|   One-off apply                job-market · ⎇ main · needs you       |
| INSIDE CHATS              later: instant text search (roadmap)       |
| ──────────────────────────────────────────────────────────────────── |
|   ✨ Can't find it? Describe it and let an agent search your chats (Agntree's Find Session) |
+----------------------------------------------------------------------+
 Typing: no repo hit → "No repo matches." · no chat hit → "No chat name matches."
 Enter = first result · Esc closes · footer runs Find Session with the typed text
```

### 3f. Session history (🕘), Cursor's quick-pick

```
+----------------------------------------------------------------------+
| Filter job-market's session history                                  |
+----------------------------------------------------------------------+
| IN THE SIDEBAR (LAST 14 DAYS)                                        |
|   One-off apply                    ⎇ main · 2m                       |
| OLDER                   not in the sidebar; pick one to bring it back|
|   Resume parser spike              ⎇ feat/parse · 23d                |
+----------------------------------------------------------------------+
 Empty groups: "None." / "No older chats."  ·  picking OLDER → row returns as idle, chat opens
```

### 3g. Empty and first-run states

```
No repos and nothing discovered:          Discovery found repos (first run, P13):
+--------------------------------+        +--------------------------------+
| PITWALL                        |        | v job-market   ...             |
| No repositories yet.           |        | v wynwood      ...             |
| [Add repository]               |        |  (added automatically, no      |
+--------------------------------+        |   prompt)                      |
                                          +--------------------------------+
```

### 3h. Activity bar icon

BEFORE: chevron + pill mark (`#c5c5c5`).  AFTER: four dots in a row, one colour, the needs-you dot enlarged (`● ⬤ ● ○` at 24 px: working, needs you (enlarged), finished, idle, in D17's order), tooltip from Cursor (`Pitwall`).

### State summary

| UI piece | BEFORE | AFTER |
|---|---|---|
| Tree levels | repo → worktree → chat | repo → session |
| Which repos | added by hand | discovered (14 d) + added by hand − dismissed |
| Session dot | only open chats; working/done | every session; needs/working/finished/idle, D17 colours/shapes |
| Session text | age (★) | `⎇ branch[ ⧉]  status · ago[ · open]` |
| Order | creation order; manual repo order | inbox order; moves only on status change |
| Repo row | name + repo icon | name + summary + hover 🕘 / "+" |
| Repo menu | Add Worktree, Checkout PR, Move, Remove | New session, history, open window, copy path, reveal, Dismiss |
| Changes view, PR badges, worktree create/delete | shown | gone |
| FILES | "All Files", expanded | "Files", collapsed, Ctrl+Alt+F |
| Search | Find Session only (Ctrl+Alt+F) | Ctrl+Alt+R quick pick + Find Session footer |
| Hotkeys | Ctrl+Alt+N/S/A/Enter/F | + Ctrl+Alt+1–9, 0, R, O, Shift+1–9; F → FILES |
| Activity icon | chevron mark | status row, badge = needs-you count |
| Session hover icons | star, rename, terminal, close | bell (needs you), terminal, fork |
| FILES follows | worktree row selection | repo row click or opened chat's worktree; header shows repo, branch, path |

### 3i. Canvas coverage check (every sidebar element on the canvas → where it lands)

Checked 2026-11-17 against the canvas boards Navigation, SidebarOptions, StatusRules, Menus, Hotkeys, Decisions, Feasibility and Brand.

| Canvas element | Phase 3 | Where |
|---|---|---|
| Header `PITWALL` + `sorted by who needs you` | ✅ (one word native, P21) | T5 |
| Header search icon, `Search repos and chats (Ctrl+Alt+R)` | ✅ | T9 |
| Header folder icon, `Add a repository` | ✅ (exists) | T4 keeps it at navigation@1 |
| Header bell, `Sound alerts`, sound popover | → Phase 5 (5.3) | P14 |
| Repo row: chevron, name, `{n} open`, hover 🕘 and `+` | ✅ (hover text per P26) | T5, T7 |
| Repo row ` · {k} windows` suffix | → Phase 4 (needs the window registry) | 4.2 |
| Collapsed repo summary (`2 sessions`, `1 needs you`) | ✅ | T5 |
| Repo tooltip with Ctrl+Alt+{n} / Ctrl+Alt+Shift+{n} | ✅ | T5, T8 |
| Session row: dot, title, `⎇ branch`, `⧉`, `status · ago`, ` · open` | ✅ | T5 |
| Session tooltip: worktree folder (main too), ⧉ line | ✅ | T5 |
| Needs-you bell on the row | ✅ | T7 |
| Hover icons: open in terminal, fork | ✅ | T7 |
| 📡 Remote Control mark and menu item | → Phase 7 (7.3) | D38 |
| Status dots: 4 states, D17 hexes, glow / solid / ring shapes | ✅ | T6 |
| Status word in status colour; orange selected-row edge | ✗ native limit | P22 (v2 card panel, 7.2) |
| Finished → idle when the chat is opened | ✅ | T5 (P16) |
| Session order and repo inbox order; moves only on status change | ✅ | T5 (P6) |
| Activity-bar badge (+1 per needs-you session) | ✅ | T5 |
| Repos found automatically (14 days, panel + terminal sessions) | ✅ | T3 |
| First-run "Pitwall found 6 repos… [Show them all] [Choose repos…]" | ✗ dropped | P13 (log locks auto-add) |
| `No repositories yet.` + `[Add repository]` | ✅ (today's welcome text differs; replaced) | T5 |
| Dismiss from Pitwall + the dismissed message | ✅ | T3, T7 |
| Repo menu: New session, Session history…, Open its window, Copy Path, Reveal, Dismiss | ✅ | T7 |
| Repo menu: Show its open chats side by side; window label flip | → Phase 4 (4.3, 4.2) | |
| Session menu (Agntree set + Copy resume command) | ✅ (exists) | T4 removes Fork with changes |
| Session history quick pick (placeholder, 2 groups, notes, empties) | ✅ | T7 |
| Search quick pick (placeholder, REPOS / CHATS / INSIDE CHATS, metas, empties, ✨ footer) | ✅ (INSIDE CHATS = header + note only; 7.1) | T9 |
| Hotkeys Ctrl+Alt+1–9, again = next chat, 0, R, O, F, Shift+1–9 | ✅ | T8 |
| List keys ↓/↑, Ctrl+↓/↑, Enter | ✅ | T8 |
| FILES (header hover text per P26): collapsed, Ctrl+Alt+F, follows the clicked repo / opened chat, header with repo ⎇ branch + path | ✅ | T4 (collapsed), T5 (follow + header) |
| FILES clipboard line, Copy to another repo, drag onto a repo row | → Phase 4 (4.7) | |
| Hide Changes, worktree create/delete, PR badges; keep Find Session, Fork | ✅ | T4 |
| No sideways scroll, resizable edge, resizable line above FILES | ✅ (native) | E17 |
| Activity icon: status row, one colour, needs-you dot enlarged | ✅ | T6 |
| Bottom bar counts and the corner branch | → Phase 5 (5.4) / Phase 4 (4.5) | |
| Clicking a chat opens Claude's panel in its folder's window | → Phase 4 (4.1, 4.2) | Opener unchanged here |

## 4. Derisking (run in order; don't start N+1 until N passes)

| # | What it proves | Command | Expected | If it fails → |
|---|---|---|---|---|
| S1 | F3 exists on a non-PID key (live), so 3.0 fixes a real bug | Testing agent, own profile, two windows on `uj-lab-a`: 20 alternating star/rename actions across the windows, then a reload; protocol in Task 1 Step 1 | Log `captures/f3-repro-evidence/run.log` reports `lost=N reverted=M` (any N or M > 0 = reproduced) | 0/0 after 3 runs → ruling stands (overlay generalised anyway, R34 mechanism); record "not reproduced live" in the scorecard |
| S2 | The sessions file is a correct live-status source | `node scripts/probe-claude-sessions.mjs` while a lab session sits on a permission prompt, then `claude agents --json` | Same sessionId shows `waiting` in both; a dead-pid file is listed as `dropped (pid not alive)`; the log records `statusUpdatedAt` vs the tool-call write's transcript mtime on a real prompt (ordering evidence for P4) | Keep `claude agents` as primary (revert P4), file as secondary; tell Sharif |
| S3 | Discovery finds the right folders from real data | `node scripts/list-claude-repos.mjs --days 14` | Prints N repo roots; every one exists on disk; 0 duplicates under `samePath` | Fix cwd parse / root mapping before Task 3's service work |
| S4 | Each task's code is green on both OSes | `npm test` locally + `gh pr checks <N>` | 0 fail; skips ≤ 9 (`grep -cE "^ *﹣ "`), ubuntu + windows + privacy green | Fix in the task's PR; no merge |
| S5 | The new keys reach Pitwall in Cursor | Testing agent: test Cursor → "Developer: Toggle Keyboard Shortcuts Troubleshooting", press Ctrl+Alt+F, 1, 0, R, O, Shift+1; then Ctrl+Alt+Shift+1 with that repo's folder already open | Each logs a `pitwall.*` command as the match, not `list.find` or another command; window count unchanged after the last press (P12) | Pick the next free Ctrl+Alt key, record a ruling, update the canvas-copy tooltips |
| S6 | ↓/↑ don't open and Ctrl+↓/↑ move-and-open, in a real tree | Testing agent: focus the list, press ↓ ×3, then Ctrl+↓ | 0 new terminals / tabs after ↓; exactly 1 chat opened after Ctrl+↓ | If ↓ opens (`workbench.list.openMode`), set the items' command to open only on Enter/click and record a ruling |
| S7 | End to end in real Cursor (E15) | Testing agent walk W1–W10 (Task 10) on the merged sha | Every step PASS with evidence files | Route each FAIL to its task owner; re-walk |
| GT | System-says ≠ correct | After S7: compare the live tree with `list-claude-repos.mjs` and `probe-claude-sessions.mjs` output | Repo set equal; status of every live session equal | Open a finding; Phase 3 stays open |

## 5. Evaluation criteria (definition of done; graded by an independent evaluator sub-agent on a fresh clone)

| # | Criterion | Metric + threshold | How measured | Evidence |
|---|---|---|---|---|
| E1 | The full suite passes on both OSes | 0 fail on ubuntu + windows; skips ≤ 9, each with a reason; the dormant (excluded) test count is recorded and those tests still typecheck (QA C5) | `gh run view` of main CI at the release sha; spec-reporter `﹣` count | scorecard row + run id |
| E2 | Two windows never lose or revive each other's writes in any collection | Dry two-window stale-echo tests pass for repos, chats (incl. `seenAt`), stars, removed sessions, searches, dismissals: 6/6 | `npm test -- storage` names | test names in scorecard |
| E3 | Every repo with a session in the last 14 days is listed, and no older one | Fixture with sessions aged 1 d, 13 d, 15 d → exactly the 1 d and 13 d repos; live set = the evaluator's own set, derived from raw `*.jsonl` `cwd` (first entry with a cwd) + `git rev-parse --git-common-dir`, using no repo script (QA C1) | dry test + evaluator's independent derivation | test name; diff output (empty) |
| E4 | Dismiss hides a repo until it's re-added or a new session starts there | Dry: 3/3 cases (stays hidden after reload; back on new session; back on manual add). Live: same 3 on a lab repo | dry tests + testing walk W5 | test names; captures |
| E5 | Session rows carry branch and worktree mark correctly | Every git-repo row shows `⎇ <branch>`; `⧉` on 100 % of worktree rows and 0 % of main rows (lab fixture with 1 worktree) | dry tree test + walk W3 | test name; screenshot |
| E6 | Dots match the live truth | ≥ 9/9 observations (3 lab sessions × busy, waiting, idle) match `probe-claude-sessions.mjs` within 8 s; finished → idle within 8 s of opening the chat | walk W4 with probe log | `captures/w4-evidence/` |
| E7 | Inbox order holds and rows don't move without a status change | Dry: rank tables for repos + sessions pass. Live: a waiting session's repo is row 1 within 8 s; 60 s with a working session and no status change → 0 `[Pitwall] order` log lines (Task 5 logs `[Pitwall] order <repo ids>` on each re-sort, QA C2) | dry `inbox-order` tests + walk W6 exthost log | test names; log excerpt |
| E8 | Repo "+" and 🕘 work | "+" creates exactly 1 new chat in that repo; history count = transcripts whose cwd maps to that repo, counted independently by the evaluator (QA C1); picking an OLDER chat shows it in the sidebar as idle | walk W7 | captures |
| E9 | Agntree extras are hidden, keepers stay | `package.json` contributes contain 0 of: `pitwall.changesView`, `addWorktree`, `deleteWorktree`, `mergeWorktree`, `rebaseWorktree`, `checkoutPR`, `openPRInBrowser`, `forkChatWithChanges`; FILES view `visibility: collapsed`; `findSession` and `forkChat` present | `node scripts/check-contributes.mjs` (Task 4) | script output |
| E10 | Every hotkey in the canvas table is bound and wins in Cursor | 23/23 bindings present in `package.json` (Ctrl+Alt+1–9 = 9, Ctrl+Alt+Shift+1–9 = 9, Ctrl+Alt+0, R, O, F, N = 5); S5 shows `pitwall.*` for 6/6 sampled keys | manifest test + S5 log | test name; troubleshooting log |
| E11 | List keyboard per D37 | ↓ ×3 opens 0 chats; Ctrl+↓ opens 1; Enter opens 1 | walk W8 | captures |
| E12 | Search finds repos and chats and hands off to Find Session | Placeholder, group labels, empty texts and footer match §3e byte-for-byte; 5/5 chat names, picked by the evaluator from storage with a stated seed, found with the first result correct (QA C4); footer starts Find Session with the typed text | dry `search` tests + walk W9 | test names; captures |
| E13 | Brand colours and icons | `check-icon-colours.mjs` exit 0 (all fills = D17 hexes, idle is a ring with `fill="none"`); activity-bar SVG has 4 circles, one fill colour, the 2nd circle's r larger than the others | script | script output |
| E14 | The package ships only what it should | `npm run package` on windows CI; payload under `extension/` = 49 entries and the archive check reports 51 (49 + `[Content_Types].xml` + `extension.vsixmanifest`), names updated in Task 6; privacy job green | CI run | run id |
| E15 | End to end: the canvas sidebar flows work in real Cursor | Walk W1–W10 all PASS on the release sha, real `~/.claude` read-only (P15) + lab repos | testing agent walk | `captures/phase3-walk-evidence/` |
| E16 | Startup stays fast with real data | `[Pitwall] activate` → `[Pitwall] first render` ≤ 1 s, 5/5 starts, real `~/.claude` (Task 5 adds both log lines, QA C2) | exthost log (walk W1) | log excerpt |
| E17 | The sidebar never scrolls sideways and resizes like any panel (D33) | Yes/no: at 220 px no horizontal scrollbar and rows end in "…"; dragging the edge resizes (QA C3) | walk W10 | 2 screenshots |
| E19 | The sidebar matches the canvas wireframe | Every ✅ row of §3i present: yes on each, the screenshot marks each ✅ row present or absent; strings are compared byte-for-byte from `package.json` and the copy the dry tests assert, not from pixels (QA N2) | evaluator, walk W2/W3 screenshots | §3i table with a PASS column |
| E18 | The status tick stays cheap with many chats | Suite (deterministic): at 500 chats a tick stats only open chats and live sessions-file sessions, 0 others. Bench (outside the default suite): tick p95 ≤ 50 ms over 100 ticks (QA S5, R2) | `npm test -- attention` + `node --test test/bench/attention-bench.js` | test name + bench output |

## 6. Implementation tasks

Waves (parallel within a wave, one PR per task):
- **A:** T1, T2, T4, T6
- **B:** T3 (stacks on T1's dismissal API; merge after T4), T5 (consumes T1 + T2 + T6)
- **C:** T7, T8 (consume T5)
- **D:** T9 (consumes T8's `goToRepo`)
- **E:** T10

Rebase order where files overlap: T2 before T3 (`ClaudeHarness.ts`, `harness/types.ts`), T4 before T3 (`extension.ts`, manifest, `menus.test.ts`), T3 before T5 (`extension.ts`, manifest, `menus.test.ts`) (QA B4, B6, R3).

### Task 1: Every collection survives a stale storage echo (row 3.0, `phase3/task-1-storage-overlay`)

**Files:** Create `src/core/services/storageOverlay.ts`. Modify `src/core/services/StorageService.ts` (private `set` at L63, every collection read/write), `src/core/types.ts` (`ChatSession.seenAt?: number`, `Repository.origin?`, `STORAGE_KEYS.DISMISSED_REPOS`). Test `test/dry/core/storage.test.ts`.

**Interfaces:**
- Produces `class RecordOverlay<T> { note(id: string, value: T | null): void; merge(stored: Record<string, T>): Record<string, T>; settle(stored: Record<string, T>): void }`:
  - `null` = removed by this window.
  - `settle` drops entries the store has echoed back unchanged, so other windows' later writes win.
- Produces `StorageService`, unchanged public API. New: `STORAGE_KEYS.DISMISSED_REPOS = 'pitwall.dismissedRepos'` (Task 1 owns the key and API, QA B4), `getDismissedRepos(): Record<string, number>`, `setDismissed(rootPath: string, at: number | null): Promise<void>`, `markChatSeen(chatId: string, at: number): Promise<void>` (sets `ChatSession.seenAt`). `createChat` sets `seenAt` = now; records loaded without `seenAt` get it on first load (P16). `addRepository(name, rootPath, opts?: { origin?: 'manual' | 'discovered' })` checks with `samePath` and, for `discovered`, uses the P17 deterministic id; the repositories merge dedupes by `samePath`, oldest record kept.
- The PID overlay (R33a) is re-expressed on `RecordOverlay`; its two existing tests stay unchanged and green.

- [ ] **Step 1:** The testing agent runs live repro S1. Protocol:
  1. Open two windows on `uj-lab-a` with 3 chats each.
  2. In window A star chat 1, in B rename chat 2, in A unstar chat 3, in B star chat 1's neighbour. Repeat ×5 (20 actions).
  3. Reload both windows.
  4. Diff the visible stars and names against the action log.

  Result goes to `captures/f3-repro-evidence/run.log` as `lost=N reverted=M`.
- [ ] **Step 2:** Write failing tests, one per collection, each named `a stale storage echo cannot drop or revive this window's <collection> writes`, for `repositories`, `chats`, `starredChats`, `removedSessions`, `sessionSearches` and `dismissedRepos`. Use the stale-echo `memento` from the existing PID test (`storage.test.ts` "a stale storage echo cannot drop this window's PID records…"). Also add `two windows over one store keep each other's chat edits through a stale echo` (A stars, B renames the same chat, a stale echo lands, both edits survive); `two StorageService instances adding the same root through a stale echo keep one repository` (QA B3); `a chat created or loaded without seenAt gets a baseline` (P16).
- [ ] **Step 3:** Run `npm test -- storage`. Expected: the 9 new tests FAIL; the 2 PID tests pass.
- [ ] **Step 4:** Implement `RecordOverlay`, route every collection through it in `StorageService`, and re-express the PID overlay on it.
- [ ] **Step 5:** Run `npm test`. Expected: 0 fail, skips ≤ 9.
- [ ] **Step 6:** Commit, push, open the PR, and request QA.

### Task 2: Live status from `~/.claude/sessions` (row 3.3 source, `phase3/task-2-sessions-file`)

**Files:** Create `src/harnesses/claude/ClaudeSessionsFile.ts`, `scripts/probe-claude-sessions.mjs`, `docs/adr/0018-live-status-from-sessions-file.md`. Modify `src/harnesses/claude/ClaudeHarness.ts:140-208` (`getLiveStates`), `src/core/harness/types.ts` (`HarnessLiveState.liveStatus?: 'busy' | 'waiting' | 'idle'`), `docs/privacy.md`. Test `test/dry/harnesses/claude/claude-sessions-file.test.ts`, `claude.test.ts`.

**Interfaces:**
- Produces `class ClaudeSessionsFile { constructor(opts?: { dir?: () => string; isAlive?: (pid: number) => boolean }); snapshot(): Promise<{ available: boolean; observedAt: number; states: Map<string, { status: 'busy' | 'waiting' | 'idle'; waitingFor?: string; statusUpdatedAt: number; pid: number; cwd: string }> }> }`:
  - A file counts only when its `status` is `busy`, `waiting` or `idle` and its `pidDomain` equals this machine's; `available: false` when no file counts. A session whose file has an unknown status falls back to `claude agents` for that session (QA S2).
  - `isAlive` defaults to `process.kill(pid, 0)`: no throw or `EPERM` = alive, `ESRCH` = dead (QA S1). PID reuse is a known limit, recorded in ADR 0018.
  - Two files with the same `sessionId`: the newest `statusUpdatedAt` wins (QA S3).
- Produces `getLiveStates`, which returns `liveStatus` per session.
  - `waitingFor` comes from the file when it counts, else from `ClaudeAgentsService` (unchanged fallback).
  - `observedAt` = the snapshot's read time; the R40 stale-wait drop (floored ms, hotfix #24) applies only to fallback samples (P4).
  - `writtenAt := statusUpdatedAt` for a waiting session; `lastClearAt` (R45 floor, `SessionAttentionService.ts:395`) stays the fetch time.

- [ ] **Step 1:** Write the failing tests:
  - `reads status, waitingFor and pid from each .json and never opens .key files`: a fixture folder holds a `.key` file, and an `fs` spy asserts it is never opened.
  - `a file whose pid is not alive is dropped`.
  - `a missing or empty folder reports available: false`.
  - `a malformed file is skipped, the rest still read`.
  - `getLiveStates takes waitingFor from the sessions file and falls back to claude agents when it is unavailable`.
  - `a transcript write after statusUpdatedAt while the file still says waiting keeps the wait` (QA B1).
  - `fallback samples keep the R40 drop; same-ms counts as before`.
  - `a file from another pidDomain is ignored`; `EPERM from the pid check counts as alive`.
  - `an unknown status value falls back to claude agents for that session`.
  - `two files for one sessionId: the newest statusUpdatedAt wins`.
  - `writtenAt of a waiting session is its statusUpdatedAt`.
- [ ] **Step 2:** Run `npm test -- claude`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement `ClaudeSessionsFile` and the `getLiveStates` changes. Write `probe-claude-sessions.mjs`: it prints `sessionId status pid statusUpdatedAt` per live file and `dropped (pid not alive)` for dead ones, and never reads `.key`.
- [ ] **Step 4:** Write ADR 0018 (context: T1 and ADR 0006; decision: P4; consequences: fallback, privacy). Add the source to `docs/privacy.md`.
- [ ] **Step 5:** Run Smoke S2 on a lab session (the lead, or testing). Then run `npm test`: 0 fail, and the existing attention tests pass unchanged (R36–R45).
- [ ] **Step 6:** Commit, push, PR, QA.

### Task 3: Repos found from `~/.claude`, and dismissed by right-click (row 3.1, `phase3/task-3-discovery`; Wave B, branched from main after Task 1 merges)

**Files:**
- Create `src/harnesses/claude/ClaudeRepoDiscovery.ts`, `src/core/services/RepoDiscoveryService.ts`, `scripts/list-claude-repos.mjs`, `docs/adr/0019-repos-discovered-and-dismissed.md`.
- Modify `src/core/services/GitService.ts` (`getMainRepoRoot`), (the storage API comes from Task 1: `addRepository` origin + P17 id, `setDismissed`, `DISMISSED_REPOS`), `src/core/commands/repository.ts` (`pitwall.dismissRepository`), `src/extension.ts`, `manifest/core.contributes.json` (`pitwall.autoImport.retentionDays` default 14, `pitwall.discovery.enabled` default true, the dismiss command + its menu entry replacing "Remove from Pitwall…" on repo rows), `docs/privacy.md`.
- Test `test/dry/core/repo-discovery.test.ts`, `test/dry/harnesses/claude/claude-repo-discovery.test.ts`.

**Interfaces:**
- Produces `HarnessAdapter.discoverRecentFolders?(sinceMs: number): Promise<DiscoveredFolder[]>` with `DiscoveredFolder { cwd: string; firstEntryAt: number; lastActivity: number }`.
  - Claude reads each `*.jsonl` with `mtime ≥ sinceMs`, line by line, taking `cwd` from the first entry that has one (heads start with `queue-operation` entries without a cwd; an attachment line can exceed 64 KB) and the first entry's timestamp. It stops at a cwd or 1 MB and counts files skipped for having none (QA S7). Results are cached by path + mtime.
- Produces `GitService.getMainRepoRoot(cwd: string): Promise<string | null>`:
  - Uses `git rev-parse --path-format=absolute --git-common-dir`, and returns its parent when it ends in `.git`.
  - Returns `null` when not a git repo.
  - Gives the Phase 2 canonical native spelling.
- Produces `RepoDiscoveryService { scan(): Promise<{ added: string[]; skipped: number }> }`:
  - Runs after the first render, every 60 s and on window focus. Never awaited by activation.
  - Two concurrent scans or windows add a root once (dedupe on `samePath` against stored repos).
- Produces the `pitwall.dismissRepository` command:
  - Records `setDismissed(root, Date.now())`, removes the repo's rows and worktree records as `removeRepository` does, minus closing terminals, and deletes its chats with `rememberSession: false` so `REMOVED_SESSIONS` doesn't block re-import when the repo returns (QA S8).
  - Shows the §3d message.
  - `pitwall.addRepository` clears a dismissal.

- [ ] **Step 1:** Write the failing tests:
  - `lists folders whose transcripts changed in the window, with cwd and first entry time`.
  - `a transcript without cwd, unreadable or malformed is skipped`.
  - `a 15-day-old transcript is not listed`.
  - `a worktree cwd maps to its main repo root` (real temp git repo + `git worktree add`).
  - `a missing cwd is skipped`.
  - `a non-git cwd becomes a folder repository`.
  - `two concurrent scans store one repository per root, case-insensitive on Windows`.
  - `a dismissed repo stays hidden after reload`.
  - `a dismissed repo returns when a session starts in it after the dismissal`.
  - `an older session still active does not bring a dismissed repo back`.
  - `adding a dismissed repo by hand clears the dismissal`.
  - `a returned repo gets its chats back` (QA S8).
  - `the cwd comes from the first entry that has one, past a first line over 64 KB` (QA S7).
  - `discovery never runs before the first render and its failure is logged, not thrown`.
- [ ] **Step 2:** Run `npm test -- discovery`. Expected: FAIL.
- [ ] **Step 3:** Implement. Write `list-claude-repos.mjs [--days N] [--repo <root> --all]`, importing nothing from `src/` (a probe for S3, not the evaluator's ground truth, QA C1): it prints the canonical repo roots with sessions in N days, or, with `--repo`, every transcript belonging to that repo's worktrees. Run S3 against the real `~/.claude`.
- [ ] **Step 4:** Write ADR 0019 (P1, P2, P3, P13) and the privacy line.
- [ ] **Step 5:** Run `npm test`: 0 fail. Run `node scripts/build-manifest.mjs --check`.
- [ ] **Step 6:** Commit, push, PR, QA.

### Task 4: Hide Changes, worktree create/delete, PR badges; keep FILES, Find Session, Fork (row 3.6, `phase3/task-4-hide-extras`)

**Files:** Modify `manifest/core.contributes.json`, `src/extension.ts` (L123-170: Changes construction, PR timer; keep the `showWorktree` follow for FILES), `src/core/providers/WorkspacesTreeProvider.ts` (PR fetch/timer at L95, L331-358), dormant headers on `ChangesTreeProvider.ts`, `commands/changes.ts`, `GitHubService.ts`, `commands/worktree.ts`. Create `scripts/check-contributes.mjs`. Tests: `changes.test.ts`, `worktree-commands.test.ts`, `menus.test.ts`, `site.test.ts`, `files.test.ts`.

**Interfaces:**
- Produces no PR fetch, and no `gh` spawn from the tree.
- Produces FILES view: name `Files`, `"visibility": "collapsed"`.
- Produces `check-contributes.mjs`, which exits 1 if any E9 id is in `package.json`, if `findSession`/`forkChat` are missing, or if FILES isn't collapsed.

- [ ] **Step 1:** Write failing tests:
  - `the manifest contributes no Changes view, worktree create/delete/merge/rebase, PR or fork-with-changes entries`.
  - `the Files view is collapsed by default and Find Session and Fork are still contributed`.
  - `the tree never calls GitHubService`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Remove the contributions and wiring.
  - Tests that assert the removed behaviour move to `test/dry/core/dormant/` and are excluded from the run, with a README saying they return with the feature. Do not delete them.
  - Update the docs that `site.test.ts` checks.
- [ ] **Step 4:** Run `npm test`, `node scripts/check-contributes.mjs` (exit 0) and `build-manifest --check`.
- [ ] **Step 5:** Commit, push, PR, QA.

### Task 6: Brand icons: D17 status dots and the status-row activity icon (row 3.10, `phase3/task-6-brand-icons`)

**Files:** Modify `scripts/generate-harness-icons.mjs`, all 40 `resources/icons/harness/*.svg` (every harness regenerated with the renamed states; claude in D17 colours, dormant harnesses keep their tint; packaged count unchanged at 49), `resources/icons/pitwall-activitybar.svg`, `src/core/harness/types.ts` (`HarnessIconState = 'working' | 'needs' | 'finished' | 'idle' | 'new'`, replacing `done`/`closed`), `src/core/harness/treeIcons.ts:4` (`STATES`), `src/core/harness/sessionUtils.ts:153` (`selectHarnessIconState`, mapped as below), `src/core/providers/SessionSearchTreeProvider.ts:105` (`'closed'` literal) (QA B7), `resources/icons/harness/README.md`, the packaging archive check (new names, count stays 49). Create `scripts/check-icon-colours.mjs`. Test `test/dry/core/icons.test.ts`.

**Interfaces:**
- Produces files `resources/icons/harness/claude-{dark,light}-{working,needs,finished,idle,new}.svg`.
- Mapping until T5 lands: `done → finished`, `closed → idle`.

- [ ] **Step 1:** Write failing tests:
  - `every harness icon state has a dark and light SVG with the D17 fill`.
  - `idle is a hollow ring`.
  - `the activity-bar icon is four dots in one colour with the second dot largest`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Generate the icons:
  - Working and needs you get a glow ring at 22 % opacity of their colour.
  - Finished is solid.
  - Idle is a 1.5 px ring with `fill="none"`.
  - New: a dashed hollow ring in the idle grey (P24).
  - Draw the activity icon as 4 circles in a row in a single `currentColor`-style fill.
- [ ] **Step 4:** Run `node scripts/check-icon-colours.mjs` (exit 0), `npm test` and `npm run package` (archive check, count updated).
- [ ] **Step 5:** Commit, push, PR, QA.

### Task 5: Repo → session rows with branch, four statuses and inbox order (rows 3.2, 3.3, 3.4, `phase3/task-5-sidebar-rows`)

**Files:**
- Create `src/core/providers/sessionStatus.ts`, `src/core/providers/inboxOrder.ts`.
- Modify `src/core/providers/WorkspacesTreeProvider.ts` (`getChildren` L267, `worktreeRows` L323 removed from the view path, `chatRows` L384), `src/core/providers/chatTooltip.ts`, `src/core/services/SessionAttentionService.ts`, `manifest/core.contributes.json` (view name `Repos`). (`ChatSession.seenAt` is added by Task 1.)
- Tests `test/dry/core/session-status.test.ts`, `inbox-order.test.ts`, `tree.test.ts`, `attention.test.ts`.

**Interfaces:**
- Consumes `HarnessLiveState.liveStatus` (T2), `HarnessIconState` names (T6) and `StorageService.markChatSeen` (T1).
- Produces `type SessionStatus = 'needs' | 'working' | 'finished' | 'idle'` and `sessionStatus(input: { live?: HarnessLiveState; needsYou: boolean; seenAt?: number }): SessionStatus`:
  - needs: `needsYou` or `liveStatus === 'waiting'`.
  - working: `liveStatus === 'busy'` or `turnState === 'working'`.
  - finished: turn done and `turnEndedAt > seenAt` (`seenAt` always set, P16).
  - else idle.
- Produces `rankRepo(s)`: needs 0, finished 1, working 2, idle 3. `rankSession(s)`: needs 0, working 1, finished 2, idle 3. Also `orderRows<T extends { id: string; status: SessionStatus; statusSince: number; title: string }>(rows: T[], rank: (s: SessionStatus) => number): T[]`, sorted by rank, then `statusSince` desc, then title.
- Produces `SessionAttentionService`:
  - `statusOf(chatId): { status: SessionStatus; statusSince: number }`.
  - `onDidChangeStatus: Event<string[]>`, fired only for chats whose status changed.
  - The poll set is open chats ∪ live sessions-file sessions; other chats' turn state refreshes from the 60 s discovery/import scan (QA S5).
  - Toast state (`needsYouSince`, `waitingSince`, cleared for chats that aren't open at `SessionAttentionService.ts:236-263`) is split from row-status state, which is kept for every chat (QA S6).
  - A chat in front (`isChatVisible`) or opened via `pitwall.openChat` calls `markChatSeen(id, now)` only when `turnEndedAt > seenAt` (at most one write per finished turn, QA S4).
  - The tree re-reads storage and refreshes on `window.onDidChangeWindowState` (focused) and on each 60 s scan (P23).
  - Logs `[Pitwall] activate` and `[Pitwall] first render` once, and `[Pitwall] order <repo ids>` on each re-sort (QA C2).
- Produces the tree:
  - Repo children are sessions from all of the repo's worktrees.
  - Descriptions as in §3a, tooltips as in §3b (every session tooltip has its folder line, D14).
  - `moveRepositoryUp/Down` commands, menu entries and tests removed or parked dormant (P18).
  - `TreeView.badge` = number of needs-you sessions, `undefined` at 0.
  - `viewsWelcome` for the list becomes exactly `No repositories yet.` + `[Add repository](command:pitwall.addRepository)` (canvas §1f; Clone stays in the overflow menu); the FILES welcome becomes `Select a repo or session to browse its files.` (the worktree level is gone).
  - FILES follows a repo row click (its main worktree) and the opened chat's worktree; the worktree-row trigger in `extension.ts` (~L435-441, `getWorktreeForItem`) becomes repo/session rows. The FILES view description shows `{repo} ⎇ {branch}` and its tooltip the folder path.
  - The order is re-sorted only on `onDidChangeStatus` or row add/remove (P6); time labels refresh without re-sorting.
  - `TreeView.description = 'sorted by who needs you'`.

- [ ] **Step 1:** Write failing tests:
  - `sessionStatus covers the four statuses and the waiting/busy/turn combinations` (table test).
  - `finished turns idle once the chat is seen`.
  - `repos rank needs you, finished, working, idle; sessions rank needs you, working, finished, idle; newest statusSince first`.
  - `a tick with no status change does not reorder rows even when activity times change`.
  - `a repo shows every worktree's sessions with ⎇ branch, and ⧉ only on non-main worktrees`.
  - `a plain-folder repo's rows leave out the branch`.
  - `repo descriptions: "1 need you · 2 open", "2 sessions", "1 session"`.
  - `a closed session gets a status dot from the sessions file`.
  - `opening a finished chat marks it seen and it turns idle`.
  - `a session whose turn ended before it was first listed is idle` (QA B2).
  - `a chat kept in front writes seenAt at most once per finished turn` (QA S4).
  - `closing a chat keeps its row status, and reopening it doesn't toast a pre-existing wait` (QA S6, R45).
  - `every session tooltip shows its folder`.
  - `repo summary says "1 needs you" and "2 need you"`.
  - `the activity badge counts needs-you sessions and hides at 0`.
  - `clicking a repo row points FILES at its main worktree; opening a chat points it at the chat's worktree`.
  - `a window redraws stars, names and dismissals written by another window when it gains focus and on the 60 s scan` (P23; two StorageService instances over one memento).
  - `at 500 chats a tick stats only open and live sessions-file chats` (count assert, in the suite); the p95 timing lives in `test/bench/attention-bench.js`, outside the default run (E18).
  - `R36–R45 toasts still fire only for open chats`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement `sessionStatus` and `inboxOrder`, then the attention changes, then the tree changes.
- [ ] **Step 4:** Run `npm test` and `npm run test:e2e` (terminal restore must still pass).
- [ ] **Step 5:** Commit, push, PR, QA. The testing agent walks W2–W6 on the merge.

### Task 7: Repo row: "+", 🕘 session history, menu (row 3.5 + dismiss UI, `phase3/task-7-repo-row`)

**Files:** Modify `src/core/commands/repository.ts` (`pitwall.sessionHistory`, `pitwall.copyRepositoryPath`, `pitwall.revealRepository`, `pitwall.newSessionInRepository`), `src/core/providers/WorkspacesTreeProvider.ts`, `manifest/core.contributes.json`. Test `test/dry/core/session-history.test.ts`, `menus.test.ts`.

**Interfaces:**
- Consumes the T5 tree, the T3 dismiss command, and `list-claude-repos` logic via `HarnessAdapter.listSessionsForRepository` (existing).
- Produces:
  - Repo row inline "+" (`newSessionInRepository`: new Claude chat in the main worktree) and inline 🕘, both shown on hover.
  - The menu exactly as in §3c.
  - Session-row inline actions (canvas StatusRules item 5): `$(bell)` on needs-you rows (contextValue gains a `Needs` marker; runs `pitwall.openChat`), `openChatInTerminal`, `forkChat`. Star, rename and close leave the inline group (they stay in the right-click menu). `menus.test.ts:40` is rewritten to assert this set, not kept as is (QA N1).
  - The history quick pick as in §3f, newest first. Picking an OLDER chat imports it (existing `importSessions` path), then opens it.

- [ ] **Step 1:** Write failing tests:
  - `history lists sidebar chats then older chats, newest first, with the canvas labels`.
  - `picking an older chat imports it and it shows as idle`.
  - `the repo menu has exactly the §3c items in order`.
  - `"+" starts a Claude chat in the repo's main worktree`.
  - `session rows show bell (needs you only), terminal and fork inline; star, rename and close are in the right-click menu only`.
- [ ] **Step 2:** Run them (FAIL), implement, then run `npm test`.
- [ ] **Step 3:** Commit, push, PR, QA.

### Task 8: Hotkeys and list keyboard (rows 3.7, 3.8, `phase3/task-8-keys`)

**Files:** Create `src/core/commands/navigation.ts`. Modify `manifest/core.contributes.json` (keybindings), `src/extension.ts`. Test `test/dry/core/navigation.test.ts`, `menus.test.ts`.

**Interfaces:**
- Produces commands:
  - `pitwall.goToRepo1`…`9` (P11).
  - `pitwall.openRepoWindow1`…`9` and `pitwall.openCurrentRepoWindow` (P12).
  - `pitwall.openLongestWaiting` (Ctrl+Alt+0; Ctrl+Alt+N kept as an alias of the same behaviour, P10).
  - `pitwall.toggleFiles` (Ctrl+Alt+F).
  - `pitwall.list.moveDownAndOpen` / `moveUpAndOpen` (Ctrl+↓/↑, `when: focusedView == 'pitwall.workspacesView' && !inputFocus`).
- Global keys use `ctrl+alt` (mac `ctrl+cmd`). `menus.test.ts:139-140` only allows `^ctrl\+alt\+\w+$` / `^ctrl\+cmd\+\w+$`; Task 8 widens both to allow an optional `shift\+` and says so in its PR (QA B5). Ctrl+Alt+R is bound in Task 9.
- On a repo row, Ctrl+↓/↑ and Enter expand and select it (P20).

- [ ] **Step 1:** Write failing tests:
  - `Ctrl+Alt+1–9, 0, O, F and Ctrl+Alt+Shift+1–9 are bound to Pitwall commands`.
  - `goToRepo(n) reveals and selects the nth repo in inbox order; again opens its next chat`.
  - `openRepoWindow(n) opens the nth repo folder in a new window`.
  - `toggleFiles shows FILES when hidden and hides it when shown`.
  - `move-and-open moves focus one row and opens it; on a repo row it expands and selects` (P20).
  - `a repo tooltip names its keys only for positions 1–9`.
- [ ] **Step 2:** Run them (FAIL), implement, then run `npm test`.
- [ ] **Step 3:** The testing agent runs S5 and S6 on the PR build in its profile. Their results go in the PR before QA's verdict.
- [ ] **Step 4:** Commit, push, PR, QA.

### Task 9: Search box, Ctrl+Alt+R (row 3.9, `phase3/task-9-search`)

**Files:** Create `src/core/commands/search.ts`. Modify `manifest/core.contributes.json` (view/title navigation icon + keybinding), `src/extension.ts`. Test `test/dry/core/search.test.ts`.

**Interfaces:**
- Consumes the T5 order and statuses, T8's `goToRepo`, and `pitwall.findSession`. It takes no query today (`sessionSearch.ts:246`); register it to pass an optional query to the existing `find(query)`, as `askSessionSearchAgain` does at L247.
- `menus.test.ts:52` (only navigation title action is `addRepository`) is updated to `[search, addRepository]` in canvas order (QA N1).
- Produces `pitwall.search`. The quick pick uses `matchOnDescription`, groups as `QuickPickItemKind.Separator` items, and copy exactly as in §3e.
  - Repo pick → `goToRepo` behaviour.
  - Chat pick → `pitwall.openChat`.
  - Footer → `pitwall.findSession(query)`.

- [ ] **Step 1:** Write failing tests:
  - `the search box shows the canvas placeholder, groups and footer`.
  - `typing filters repos by name and chats by name or branch`.
  - `empty groups show "No repo matches." / "No chat name matches."`.
  - `picking a chat opens it; picking a repo reveals it`.
  - `the footer starts Find Session with the typed text`.
- [ ] **Step 2:** Run them (FAIL), implement, then run `npm test`.
- [ ] **Step 3:** Commit, push, PR, QA.

### Task 10: Close: walk, evaluator, v0.4.0 (`phase3/task-10-close`)

- [ ] **Step 1:** The testing agent walks W1–W10 on the latest main sha in its own profile. Evidence goes to `captures/phase3-walk-evidence/`.
  - **W1:** cold start with real `~/.claude` (read-only), 5 starts; activation → first render times (E16).
  - **W2:** the repo set equals `list-claude-repos.mjs --days 14` (E3, GT).
  - **W3:** branch and ⧉ on lab rows (E5).
  - **W4:** 3 lab sessions × busy/waiting/idle vs `probe-claude-sessions.mjs`; finished → idle on open (E6, GT).
  - **W5:** dismiss, reload, new session, manual add (E4).
  - **W6:** order: waiting repo goes to the top; a 60 s order log with no status change (E7).
  - **W7:** "+" and 🕘 (E8).
  - **W8:** ↓/Ctrl+↓/Enter (E11).
  - **W9:** search: 5 sampled names plus the footer (E12).
  - **W10:** FILES toggle plus the hotkeys sample (E10), and no sideways scroll at a 220 px sidebar plus an edge resize (E17, 2 screenshots).
- [ ] **Step 2:** Dispatch the independent evaluator on a fresh clone for E1–E19. The loop runs until every criterion passes (3 stalled rounds → Sharif). The scorecard goes to `docs/progress_reports/phase3-scorecard.md`.
- [ ] **Step 3:** Release:
  - README status and known issues; CHANGELOG `[0.4.0]`.
  - `npm version 0.4.0 --no-git-tag-version`; `build-manifest --check`.
  - Windows CI green. Annotated tag `v0.4.0`.
  - ROADMAP: rows 3.0–3.10 ✅ with SHAs, §0, §6, version bump.
  - `phase3-handoff.md`.
- [ ] **Step 4:** Hand marketing the 5-item handoff. Its draft goes to Sharif via Main, and it posts only after his approval.

## Out of scope (later phases)

- Chats opening in Claude's panel by default, focusing or opening the right window, "all its chats as tabs", the tab-to-chat match, and "Show its open chats side by side": Phase 4 (4.1–4.4).
- Pop-ups for every session, the sound switches and bell, bottom-bar counts, and the jump list: Phase 5. Ctrl+Alt+0 ships here using the existing needs-you list.
- FILES copy across repos, "Copy to another repo" and drag onto a repo row: Phase 4 row 4.7.
- Remote Control (📡, Ctrl+Alt+M): Phase 7 row 7.3.
- D14's bottom-bar corner showing the open chat's branch rides on row 4.5.
