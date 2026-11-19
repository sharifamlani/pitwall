# Phase 5 — Status and Pop-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** You find out the moment any Claude Code chat needs you or finishes, in any repo and any window, without looking. A Windows pop-up under Pitwall's own name says which chat, and "Open chat" lands you in that chat's window with the chat open. Sound is off until you switch it on. The bottom bar counts what needs you and walks you through it. Ships with the v0.5.0 known issue fixed (first Ctrl+↓ onto a restored panel tab). Tag `v0.6.0`.

**Architecture:**
- **One status source for every session.** Claude Code writes `~/.claude/sessions/<pid>.json` for every running session on the machine, panel or CLI, with `status` busy / waiting / idle, `waitingFor` and `statusUpdatedAt` (T1, ADR 0018). Today Pitwall polls it every 4 s and toasts only chats open in this window (P5). Phase 5:
  1. watches the folder (`fs.watch`, `*.json` only) and re-polls within 150 ms of a change; the 4 s tick stays as the backstop;
  2. turns each row-status change into a `StatusTransition` with its lag from `statusUpdatedAt`;
  3. judges pop-ups for **every chat in the sidebar list**, not only open ones.
- **Exactly one window speaks.** Every Pitwall window sees the same transition. Each tries to create one lock file per transition (`wx`, exclusive) in the shared `globalStorageUri`; only the winner shows the pop-up. "In front" comes from the window registry: each record gains `front` (the session in front) and `focused`.
- **Windows pop-up.** A short PowerShell WinRT toast, script and payload on stdin, under Pitwall's AppUserModelID (Q46). "Open chat" is a protocol action on Pitwall's own URI (`<uriScheme>://sharifamlani.pitwall/open?session=<uuid>`). Pitwall's `UriHandler` validates it and calls Phase 4's `ChatRouter.route()`. No new open path (D35).
- **Bottom bar and jump list.** Three count buttons (`{n} need you`, `{n} working`, `{n} finished`) open a quick pick of those chats, longest wait first. `Next ▸` walks the rest. Ctrl+Alt+0 = the longest needs-you wait.

**Tech Stack:** TypeScript 5, esbuild, `node --test` dry tests with the `vscode` stub (`test/dry/run.js`), `@vscode/test-electron`, GitHub Actions (`ubuntu-latest`, `windows-latest`, privacy job). Windows PowerShell 5.1 (inbox) for the toast; no new runtime dependency, no bundled binary.

**Spec:**
- [ROADMAP](../../../ROADMAP.md) v0.64 §3, Phase 5, rows 5.1–5.5. §2 decisions:
  - Status and pop-ups: D3, D4, D9, D17, D18, D20, D21, D25, D27, D35, D36, D39.
- Spec canvas https://claude.ai/artifact/XhYy9L747DwQzBsQDpaFF2, boards StatusRules, Navigation (toast, bell, bottom bar, triage picker) and Decisions 8, 16, 18. UI strings below are copied verbatim from it unless marked *(new copy)*.
- [Assumption tests](../../research/2026-11-16-assumption-tests.md):
  - T1 PASS: `"status":"waiting"` with `waitingFor` "permission prompt" and "input needed"; transitions idle → busy → waiting → busy → idle, CLI and panel.
  - T11 PASS: PermissionRequest, Notification (`permission_prompt`) and Stop fire from the panel.
  - T2 and T12 BLOCKED (notifications were off). They are re-run as smokes S3–S5 now that notifications are on (ROADMAP v0.9).
  - Side note: `entrypoint` is unreliable for panel vs terminal.
- [Reuse survey](../../research/2026-11-16-reuse-survey.md) gap 6 (toasts: write our own; powertoast, notify patterns, MIT) and gap 3 (hook installer, deferred by Q45).
- [Phase 4 handoff](../../progress_reports/phase4-handoff.md): known issues and follow-ups, placed in §8.

## Phase tracker

```
PITWALL PHASE 5 — phase plan
─────────────────────────────────────────────
Plan : Plan, QA review, Sharif's go      [████████████████⏸...] waiting on you
T1   : Ctrl+↓ onto a restored tab
T2   : Status for every session
T3   : Windows pop-up + click → router
T4   : Sound switches + bell
T5   : Bottom-bar counts + jump list
T6   : First-run notifications check
T7   : Close: walk, evaluator, v0.6.0
```

## Rulings made while planning (planner; spec silent or ambiguous)

| # | Ruling | Why | Cost if wrong |
|---|---|---|---|
| Q29 | Status source = the sessions file, plus the transcript tail for chats with no running process (today's rule). No hooks in v0.6.0 unless Sharif picks otherwise (Q45) | T1 measured needs-you (both reasons) and the finished edge (busy → idle) from the file alone, in the panel and the CLI. Hooks would mean writing into `~/.claude/settings.json` | A status the file doesn't show (S2 checks background agents and Esc) |
| Q30 | **Needs you** = live `waiting`. **Finished** = live busy → idle, or a transcript turn end for an open chat with no live record. A process that exits mid-turn is idle, never finished. An Esc interrupt is finished only if the chat is not in front (and it is in front when you press Esc) | StatusRules board; D18 | A false "finished" pop-up after an interrupt from another window |
| Q31 | Pop-ups and the needs-you list cover **every chat in the sidebar list** (lifts P5). A live session in a folder Pitwall doesn't list triggers one discovery refresh and pops once it is listed | Phase 5 goal; handoff known issue "Pop-ups still only cover chats you have open" | A brand-new repo's first wait is late by one discovery pass |
| Q32 | Exactly one window shows each pop-up: the first to create `<globalStorage>/pitwall-popups/<sessionId>.<kind>.<at>.lock` with `wx`. `at` = `statusUpdatedAt` (needs) or the turn end (finished). Swept after 10 min | Every window reads the same file; a heartbeat-based leader would add an election and a failover | None; a crashed winner loses one pop-up |
| Q33 | "In front" means in front in **any** window. Registry records gain `front?: string` (the session ID in front) and `focused: boolean`, written on change. A pop-up is skipped when any non-stale window reports that session in front and focused | The existing rule ("never interrupt someone typing in this session") was per window | One stale record (≤ 45 s) can hide a pop-up |
| Q34 | R45 holds: a wait already there at activation or reload is marked and listed, never popped. With the lock, a reload within 10 min can't re-pop a transition either | Phase 2 rule | None |
| Q35 | On Windows the OS pop-up **replaces** the in-window message. The in-window message (today's `showInformationMessage` with "Open") is the fallback when the toast host fails or Windows pop-ups are off. It sits behind the same lock: one per transition. macOS and Linux keep today's behaviour | Two alerts per event is noise | Users who liked the in-window message lose it on Windows |
| Q36 | Pop-up copy (canvas): title `{repo} needs you` / `{repo}: finished`; body `{chat}: Claude is waiting for you.` / `{chat}: Your turn.`; attribution line `{waitingFor}` for needs-you *(new copy, the raw reason)*; buttons `Open chat`, `Dismiss`. A toast body click = Open chat | Canvas toast; the ask text needs a transcript read, so the raw reason stands in | Less detail than the canvas's question text |
| Q37 | Click → `<uriScheme>://sharifamlani.pitwall/open?session=<uuid>` → `PopupUriHandler` → `ChatRouter.route({kind:'open'})`. The handler accepts only path `/open`, one UUID that Pitwall lists, and no other parameters. It never starts a chat and never passes a `prompt` | D35, Phase 4 router; any local app or web page can fire this URI | A chat Pitwall doesn't list can't open from a stale pop-up |
| Q38 | Counts are three left status bar items after `repo · ⎇ branch`: `{n} need you` · `{n} working` · `{n} finished`. Each is hidden at 0. Scope = the sidebar list (14 days). Every window shows the same numbers | D25, canvas bottom bar; Cursor's bar is crowded | A user wants a visible "0 need you" |
| Q39 | Ctrl+Alt+0 and Ctrl+Alt+N = the **needs-you** chat that has waited longest, across all sessions. Finished is excluded (canvas `longestWait`). With none: `Nobody is waiting on you right now.` | Decision 16, canvas | Phase 3 users who used it to walk finished chats |
| Q40 | `Next ▸` *(new copy)*: after a jump from the list or Ctrl+Alt+0, while ≥ 1 other session needs you, every window's bar shows `Next ▸`. It opens the next session in the list's order after the last one jumped to, through the router. The walk state is `<globalStorage>/pitwall-jump.json` (`v, ids, last, at`). It ends after 10 min or when the list empties | D25 "jumps you to each in turn (Next ▸)"; the jump changes windows, so the state is shared | A one-file state that can lag a list change by one tick |
| Q41 | Sound: off → `<audio silent="true"/>`; on → `<audio src="ms-winsoundevent:Notification.Default"/>`. Settings `pitwall.sound.needsYou` and `pitwall.sound.finished`, default `false`, under Settings → Pitwall → **Sound**. The bell is in the Repos header: `$(bell-slash)` when both are off, `$(bell)` when either is on. It opens a checkbox quick pick with a `▶ Test sound` button. How the bell stores a flip is Q47 | D27, canvas bell popover | None |
| Q42 | First-run check: Windows only, once per profile (globalState flag plus a `wx` lock so two starting windows don't both ask), after first render. It reads `ToastNotifier.Setting` for Pitwall's AUMID, `PushNotifications\ToastEnabled` and Focus assist (S6). It offers `ms-settings:notifications` or `ms-settings:quiethours` and never changes Windows settings. "Pitwall: Check Windows Notifications" re-runs it | Row 5.5; T2 found every toast off on this machine | Focus assist may read as `unknown` (S6 fallback) |
| Q43 | Task 1 (restored tab): on the **first visit since launch** of a panel tab that was present at activation, the retry waits for the webview-load signal S1 names (expected: a second tab change on that tab), not the fixed 250 ms. The deadline is 1500 ms from the press. Still at most one retry after the immediate refocus, never a loop. Any editor, terminal, window-blur or other Pitwall open lets go | Sharif 2026-11-19; handoff follow-up "wait for the webview to finish loading" | A webview slower than 1.5 s still takes focus |
| Q44 | `ClaudeAgentsService` (the fallback for live sessions of unknown status) retries 60 s after a failure instead of staying off until restart, and re-reads its settings on change | Handoff known issue "turns off after a single 5-second timeout"; follow-up "pick up changes without a restart" | One failing `claude agents` call per minute while broken |

## Global Constraints

- **Privacy:**
  - `~/.claude` stays read-only, and Pitwall never opens `~/.claude/sessions/*.key` (only `*.json`; a planted `.key` fixture proves it).
  - Pitwall writes nothing under the Claude config dir (Q45 = A). A dry architecture test fails on any write call whose path resolves under `claudeConfigDir()`.
  - New local files hold only session IDs, kinds, timestamps and booleans: pop-up locks (empty files), `pitwall-jump.json`, and registry records with `front` and `focused`. `docs/privacy.md` lists them.
  - Pop-up text (repo name, chat title, wait reason) goes to Windows Notifications. It travels on the PowerShell process's **stdin**, never in argv (argv is visible to every process), and `docs/privacy.md` says Windows keeps it in Notification history.
- **Never track** `.packages/`, `transcripts/`, `.claude/` (except `.claude/skills/pitwall-*`), `.superpowers/` or `.env`. Run `bash scripts/verify.sh` before every push.
- **Claude Code** is driven only through `claude-vscode.editor.open` and its `/open` link, via Phase 4's router. It is never copied, embedded or modified. No "Claude" in the product name. The Claude icon is a circle only: no Claude mark, no #D97757.
- **User files and settings:** Pitwall writes no VS Code user or workspace settings, except where Q47's answer allows it, and it writes nothing into user repos in this phase. Any Windows registration (Q46) is per-user (HKCU), needs no admin, is undone by one command and on uninstall, and is documented.
- **Exact values:**
  - Sessions folder: `fs.watch` events re-poll after a 150 ms debounce. The tick stays 4 s. A missing folder is re-watched on the next tick.
  - Pop-up lock dir: `<globalStorage>/pitwall-popups/`. Locks are swept after 10 min, by every window on activation and every 5 min.
  - Toast host: `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command -`, `windowsHide: true`, killed after 10 s, at most 1 in flight per window (queued).
  - AUMID `sharifamlani.pitwall`; DisplayName `Pitwall`; icon `resources/icons/pitwall.png` (already packaged; Q46).
  - URI: `<vscode.env.uriScheme>://sharifamlani.pitwall/open?session=<uuid>`; manifest `activationEvents` gains `onUri`.
  - Jump walk expires after 10 min. First-run lock: `<globalStorage>/pitwall-notify-check.lock`.
- **Log lines** (Pitwall Operations channel; the evaluator greps them; they never carry titles or paths):
  - `[Pitwall] status <id8> <from>→<to> lag=<ms>` (lag = detection time − `statusUpdatedAt`, or − turn end)
  - `[Pitwall] popup <needs|finished> <id8> shown lag=<ms> sound=<on|off> via=<toast|in-window>`
  - `[Pitwall] popup <needs|finished> <id8> skipped <front|locked|pre-existing|disabled|unlisted>`
  - `[Pitwall] popup click <id8>` and `[Pitwall] uri rejected <reason>`
  - `[Pitwall] toast failed <code>`
  - `[Pitwall] notify-check toasts=<on|off|unknown> app=<on|off|unknown> focus=<off|priority|alarms|unknown>`
  - `[Pitwall] jump <id8> <i>/<n>`
  - Phase 4's `[Pitwall] route …` and `handoff …` lines are reused as they are.
- **Activation:** the watcher, the lock sweep, the toast host and the first-run check start after `[Pitwall] first render`. Nothing on the activation path awaits them. E16 (≤ 1 s, as amended) holds.
- **Copy:** sentence case, no exclamation marks; canvas strings verbatim or marked *(new copy)*.
- **Windows parity:** every new test passes on the windows CI job; skips ≤ 9. Tests that spawn PowerShell inject the spawner; one real-PowerShell test runs on windows CI only, skipped elsewhere with a reason.
- **Timing asserts** use `assertNoLongBlock(fn, maxMs, { runs: 3 })`.
- **Flywheel:**
  - one PR per task on `phase5/task-N-<slug>`;
  - QA approves an exact sha; the lead merges only with `gh pr checks` green at that sha (`--match-head-commit`), then confirms main CI;
  - the testing agent walks each merge in `%LOCALAPPDATA%\pitwall-uj` with lab repos `uj-lab-*`, never in Sharif's windows; evidence shows lab repos only;
  - `package.json` is generated: on a conflict take main's copy, rerun `node scripts/build-manifest.mjs`, then `--check`.

## Review Focus

1. **Exactly once.** Three windows, one transition: one `popup … shown` in total. A reload, a pre-existing wait, the chat in front in another window, or a re-poll of the same `statusUpdatedAt` → `skipped`. Tests in T2 and T3, including a 2-process lock race on windows CI.
2. **The URI is an open door.** Any page or app can fire `cursor://sharifamlani.pitwall/…`. Only `/open` with one listed UUID routes; anything else logs `uri rejected` and does nothing. There is no `prompt` and no new chat. Test in T3.
3. **Toast injection.** Chat titles are user text: they are XML-escaped and sent as JSON on stdin; argv holds no title or path; the script is a constant. Test in T3.
4. **False status.** Esc interrupt, process exit mid-turn, torn `.json` reads, a reused pid, a closed tab, Pitwall's own opens (Phase 4 Q24): none may show working, finished or a pop-up that didn't happen. Tests in T2.
5. **Cost.** No orphan `powershell.exe` after 10 pop-ups (count = 0 after 15 s). `fs.watch` storms are debounced. Startup E16 held. Test in T3; live in E13.

---

## 1. Folder / file structure (paths this plan touches)

```
pitwall/
├── src/
│   ├── core/notify/                          NEW folder: pop-ups, sound, first-run check
│   │   ├── PopupLedger.ts                    T2 claim(key) via wx lock file; sweep()
│   │   ├── toastXml.ts                       T3 toastXml(payload): escaped XML, actions, audio
│   │   ├── WindowsToast.ts                   T3 show() via PowerShell stdin; registerAumid(); notifierSetting()
│   │   ├── PopupUriHandler.ts                T3 parseOpenUri(); handleUri → ChatRouter.route
│   │   ├── SoundSwitches.ts                  T4 get/set per kind, context key pitwall.soundOn, Test sound
│   │   ├── notificationState.ts              T6 toasts / app / Focus assist reader (read-only)
│   │   └── FirstRunCheck.ts                  T6 once per profile; ms-settings offers
│   ├── core/services/SessionAttentionService.ts   T2 transitions, every listed chat, lag log, counts(), needsYouOrder()
│   ├── core/services/NotificationService.ts       T2 lock + front-anywhere; T3 Windows toast path, in-window fallback; T4 sound
│   ├── core/services/chatVisibility.ts            T2 frontSessionId() for the registry record
│   ├── core/harness/types.ts                      T2 optional watchLive(onChange): Disposable
│   ├── core/harness/kit/NativeUiTabSurfaceService.ts   T1 isFirstVisitSinceLaunch(tab); T1 quieter traceTabs
│   ├── core/windows/WindowRegistry.ts             T2 record front + focused; frontAnywhere(); dispose early entry on failed start
│   ├── core/windows/AttentionStatusBar.ts         T5 NEW three count items + Next ▸
│   ├── core/windows/JumpWalk.ts                   T5 NEW shared walk state (pitwall-jump.json)
│   ├── core/windows/dumpState.ts                  T2 adds statuses + counts per window (GT)
│   ├── core/commands/chat.ts                      T1 holdListForPanel first-visit path; T5 list + jump commands
│   ├── core/commands/navigation.ts                T5 openLongestWaiting = needs-only, all sessions
│   ├── harnesses/claude/ClaudeSessionsFile.ts     T2 watch(onChange) on *.json events only
│   ├── harnesses/claude/ClaudeHarness.ts          T2 watchLive
│   ├── harnesses/claude/ClaudeAgentsService.ts    T2 retry after 60 s; settings re-read (Q44)
│   ├── uninstall.ts                               T3 NEW (only if Q46 = A): removes the HKCU AUMID key
│   └── extension.ts                               T2–T6 wiring after first render; registerUriHandler
├── manifest/core.contributes.json            T3 onUri, vscode:uninstall; T4 Sound settings, bell; T5 list commands; T6 check command
├── package.json                              generated; files allowlist + out/uninstall.js (Q46 = A)
├── test/dry/core/notify/                     NEW popup-ledger, toast-xml, windows-toast, popup-uri, sound, notification-state, first-run
├── test/dry/core/windows/{attention-status-bar,jump-walk}.test.ts   T5 NEW
├── test/dry/core/{attention,chat-commands,navigation,manifest,menus,architecture}.test.ts   updated per task
├── test/dry/core/windows/window-registry.test.ts           T2 front/focused
├── test/dry/harnesses/claude/{claude-sessions-file,claude-agents,claude-repo-discovery}.test.ts   T2
├── scripts/watch-sessions.mjs                T2 NEW GT recorder: *.json in ~/.claude/sessions every 100 ms → JSONL
├── scripts/compare-status.mjs                T2 NEW GT diff: recorder JSONL vs dumpState statuses and log lines
├── scripts/toast-probe.ps1                   T3 NEW smoke S3/S4/S5 probe (sender, click, sound)
├── scripts/dump-pitwall-windows.mjs          T2/T5 --check-privacy allow-list: front, focused, popup locks, jump file, dump
├── docs/adr/0021-status-and-popups-for-every-session.md   T2 NEW
├── docs/adr/0022-windows-popup-sender.md                  T3 NEW
├── docs/notifications.md, docs/privacy.md, docs/troubleshooting.md   T2–T6
├── docs/progress_reports/phase5-scorecard.md, phase5-handoff.md     T7 NEW
├── CHANGELOG.md, README.md                   T7 [0.6.0] (notes v0.5.0 known issue fixed)
└── ROADMAP.md                                every merge: row flip, §0, §6, version
```

## 2. Flowchart

```
 Claude session (panel or CLI, any repo)
   writes ~/.claude/sessions/<pid>.json  {status, waitingFor, statusUpdatedAt}
            |
            v  (every Pitwall window, independently)
 +-------------------------------+   fs.watch *.json --150 ms--> poll()
 | ClaudeSessionsFile.watch      |   4 s tick backstop ---------> poll()
 +-------------------------------+   (*.key never opened)
            |
            v
 +-------------------------------+   rowState per chat (live record, or transcript tail
 | SessionAttentionService       |   for chats with no process); every listed chat (Q31)
 |  recomputeStatuses()          |
 +-------------------------------+
     | onDidChangeStatus            | onDidTransition {from,to,at,lag}
     v                              v
 sidebar dots + order (D21)    "[Pitwall] status <id8> a→b lag=" 
 badge + bottom-bar counts     +-----------------------------------+
 (AttentionStatusBar, T5)      | pop-up judge (T2)                 |
                               |  to=needs|finished? pre-existing? |--skip--> log "skipped <reason>"
                               |  front+focused in ANY window?     |   (registry front/focused, Q33)
                               |  settings off?                    |
                               +-----------------------------------+
                                            | eligible
                                            v
                               PopupLedger.claim(<sid>.<kind>.<at>.lock, wx)
                                  | lost (another window won) -> "skipped locked"
                                  | won
                                  v
                    win32 + toasts on?  --no-->  in-window message (fallback, Q35)
                                  | yes
                                  v
                    WindowsToast.show: powershell stdin {xml, aumid}  (sound per T4 switches)
                                  |
                                  v
                    Windows pop-up "Pitwall"  [Open chat] [Dismiss]
                                  | click (protocol)
                                  v
                    <uriScheme>://sharifamlani.pitwall/open?session=<uuid>
                    -> Cursor delivers it to a window -> PopupUriHandler (validate, Q37)
                                  |
                                  v
                    Phase 4 ChatRouter.route({kind:'open'})
                      same folder -> open here | other folder -> handoff inbox + openFolder
                                  |
                                  v
                    chat's folder window in front, chat tab active; markSeen -> idle (D18)

 bottom bar "{n} need you" -> quick pick (longest wait first) -> route -> JumpWalk.last
 Next ▸ / Ctrl+Alt+0 -> JumpWalk.next() / longest wait -> route
 first render -> FirstRunCheck (once per profile, wx lock) -> notificationState() -> offer ms-settings
```

## 3. UI wireframes

### 3a. Windows pop-up (rows 5.2, 5.3)

```
BEFORE (v0.5.0): no OS pop-up on Windows. Only for chats open in THIS window, an in-window message:
+--------------------------------------------------------------+
| (i) One-off apply needs your input (uj-lab-b · main) —       |
|     permission prompt                               [Open]   |   <- inside Cursor, bottom right
+--------------------------------------------------------------+

AFTER: needs you, sound off (default)          AFTER: needs you, sound on
+-------------------------------------------+  +-------------------------------------------+
| [◉] Pitwall                         now  x|  | [◉] Pitwall                         now  x|  <- sender = Pitwall (Q46)
| uj-lab-b needs you                        |  | uj-lab-b needs you                        |
| Fix map: Claude is waiting for you.       |  | Fix map: Claude is waiting for you.       |
| permission prompt                         |  | permission prompt                         |  <- attribution (new copy)
| [   Open chat   ]  [   Dismiss   ]       |  | [   Open chat   ]  [   Dismiss   ]       |
+-------------------------------------------+  +-------------------------------------------+
  silent (<audio silent="true"/>)                 plays Windows "Notification.Default"

AFTER: finished (sound per its own switch)     Click "Open chat" (or the body)
+-------------------------------------------+   -> uj-lab-b's window comes forward (opened if needed)
| [◉] Pitwall                         now  x|   -> the chat's Claude tab is active, history shown
| uj-lab-c: finished                        |   -> row turns idle (D18); counts drop by 1
| Notes sync: Your turn.                    |  "Dismiss": closes; the row keeps its dot and count
| [   Open chat   ]  [   Dismiss   ]       |
+-------------------------------------------+
Action Center keeps the pop-up under "Pitwall". [◉] = the Pitwall status-row logo (D17), never a Claude mark.
Not shown: the chat is in front of a focused window (any window); a wait already there at startup.
```

### 3b. Bottom bar (row 5.4)

```
BEFORE (v0.5.0):  [$(repo) uj-lab-a · ⎇ main] [⎇ main ⟳] [⊗ 0 ⚠ 0]
AFTER, quiet:     [$(repo) uj-lab-a · ⎇ main] [⎇ main ⟳] ...           <- all counts 0: hidden (Q38)
AFTER, busy:      [$(repo) uj-lab-a · ⎇ main] [● 2 need you] [● 1 working] [● 3 finished] ...
                                               orange ($(bell))  blue           green
AFTER, walking:   [$(repo) uj-lab-a · ⎇ main] [● 2 need you] [Next ▸] ...   <- after a jump, while another waits (Q40)
tooltips: "2 sessions need you. Click to list them." *(new copy)* · "Go to the next session that needs you" *(new copy)*
every window shows the same numbers
```

### 3c. Jump list (click a count, row 5.4)

```
AFTER (click "2 need you")
+--------------------------------------------------------------------------+
| 2 need you: pick one to go to it (Enter = top)                           |  <- placeholder (canvas)
|--------------------------------------------------------------------------|
| WAITING ON YOU, LONGEST FIRST                                            |  <- separator (canvas)
| ● Fix map           uj-lab-b · ⎇ main · its own window · permission prompt |  <- highlighted (Enter)
| ● One-off apply     uj-lab-a · ⎇ main · this window · input needed        |
+--------------------------------------------------------------------------+
"1 working" / "3 finished" open the same box with group WORKING / FINISHED.
Empty after a change: "Nothing left in this list." (canvas). Ctrl+Alt+0 with none: "Nobody is waiting on you right now." (canvas)
Pick -> router -> that window; Next ▸ then visits "One-off apply".
```

### 3d. Repos header bell and sound (row 5.3)

```
BEFORE                                     AFTER, both off            AFTER, one on
+--------------------------------------+   +-------------------------+  +-------------------------+
| REPOS          [🔍] [📁] [...]        |   | REPOS  [🔍] [📁] [🔕] [...]|  | REPOS  [🔍] [📁] [🔔] [...]|
+--------------------------------------+   +-------------------------+  +-------------------------+
                                             $(bell-slash)                $(bell)

Click the bell:
+----------------------------------------------------------------------+
| Sound alerts                                              [▶ Test sound] |  <- title (canvas "SOUND ALERTS"), button
| Off by default. When on, the Windows pop-up plays the system         |
| notification sound. Also in Settings → Pitwall → Sound.              |  <- placeholder (canvas)
| [ ] When a session needs you                                         |
| [ ] When a session finishes                                          |
+----------------------------------------------------------------------+
Enter = keep the ticks. Test sound = one toast "Pitwall: test sound" *(new copy)* with sound.
Settings → Pitwall → Sound: "pitwall.sound.needsYou", "pitwall.sound.finished" (both false).
```

### 3e. First-run notifications check (row 5.5)

```
BEFORE: nothing; pop-ups silently never show.
AFTER (Windows only, once per profile, after first render; a warning message, no modal):
 toasts off   ⚠ Windows notifications are off, so Pitwall's pop-ups can't show.     [Open notification settings] [Not now]
 app off      ⚠ Pitwall's pop-ups are turned off in Windows settings.               [Open notification settings] [Not now]
 Focus assist ⚠ Focus assist is on, so Windows hides Pitwall's pop-ups.             [Open Focus assist settings] [Not now]
 all on       (nothing shown; log line only)
 all *(new copy)*. Buttons open ms-settings:notifications / ms-settings:quiethours. Re-run: "Pitwall: Check Windows Notifications",
 which also says "Windows pop-ups are on." *(new copy)* when all is well.
```

### State summary

| UI piece | BEFORE (v0.5.0) | AFTER (v0.6.0) |
|---|---|---|
| Pop-up on Windows | none; in-window message for open chats only | Windows pop-up under Pitwall for every listed chat; in-window only as fallback |
| Who pops | every window with the chat open | exactly one window per transition |
| Pop-up click | — | Open chat → Phase 4 router → its window and chat |
| Status latency | up to ~4 s tick (+ cache) | ≤ 2 s (watcher) |
| Sound | macOS banner "Glass" only | two switches, off by default; Windows system sound when on |
| Repos header | search, add folder | + bell (`bell-slash` / `bell`) |
| Bottom bar | repo · branch | + `{n} need you` / `working` / `finished` (hidden at 0) + `Next ▸` |
| Count click | — | quick pick, longest wait first, Enter = top |
| Ctrl+Alt+0 / N | longest of open chats' needs + finished | longest needs-you wait, all sessions |
| First run | nothing | one warning if Windows would hide pop-ups |
| First Ctrl+↓ onto restored tab | list loses focus (v0.5.0 known issue) | list keeps focus |

## 4. Derisking (run in order; don't start N+1 until N passes)

S1–S6 need no product code (S3–S5 use `scripts/toast-probe.ps1`, S2 uses `scripts/watch-sessions.mjs`, both landed first in their task's PR as a script-only commit). S3–S5 wait on Sharif's Q46 answer.

| # | What it proves | Command | Expected | If it fails → |
|---|---|---|---|---|
| S1 | The signal that a restored panel tab's webview finished loading is observable (input to Q43) | Testing agent, test profile with 3 restored panel tabs: `Pitwall: Dev Trace Tabs` on, fresh launch, Ctrl+↓ onto each restored tab once; focus owner logged every 50 ms for 2 s; 3 launches | `captures/phase5-s1/` names, per press, the event (kind + ms after press) at the focus steal, the same in ≥ 3/3 launches | No event: T1 uses the 1500 ms deadline refocus only (Q43 fallback), ruling recorded |
| S2 | The sessions file alone shows every status Phase 5 needs, quickly | `node scripts/watch-sessions.mjs --out captures/phase5-s2/truth.jsonl` while the tester drives a uj-lab-a panel chat and a uj-lab-c CLI chat through: prompt, Write permission prompt, approve, question card, answer, end, Esc mid-turn, background agent, `/exit` | Each step shows its status (`busy`, `waiting` + `permission prompt`, `waiting` + `input needed`, `idle`), and `statusUpdatedAt` is ≤ 500 ms after the UI event (CUA timestamps), 2/2 chats; background-agent and Esc rows recorded as found | Gap found → that status uses the transcript tail (today's code) and Q45 option B is re-proposed to Sharif with the evidence |
| S3 | A toast shows under Pitwall's sender (D20) | `powershell -File scripts/toast-probe.ps1 -Register -Title "uj-lab-a needs you"` | Screenshot shows sender "Pitwall" with its icon; `ToastNotifier.Setting` prints `Enabled`; Action Center entry under "Pitwall" | Q46 fallback B (Start-menu shortcut), then C (Cursor's AUMID, sender "Cursor"); ruling recorded |
| S4 | A protocol click reaches Pitwall's URI handler in a running window and that window comes forward | Probe toast with launch `cursor://sharifamlani.pitwall/open?probe=1` (a T3 script-only build logs `[Pitwall] uri probe`); click it with Cursor behind another app, 3 trials + 1 with Cursor minimised | 4/4: log line present, a Cursor window is in the foreground (CUA). Record any Cursor "open this URI?" confirm; it may show once, never per click | Foreground fails: the handler calls Phase 4 `raiseWindow` on the routed window. Confirm per click: ruling to Sharif before T3 merges |
| S5 | `audio` controls sound, both ways | `toast-probe.ps1 -Sound on` then `-Sound off` | XML echo shows `ms-winsoundevent:Notification.Default` vs `silent="true"`; the tester's audio capture has 1 chime for on and 0 for off | Use `ms-winsoundevent:Notification.IM`; re-run |
| S6 | Pitwall can read the three settings that hide pop-ups, read-only | `powershell -File scripts/toast-probe.ps1 -State` (prints toasts / app / focus) with Focus assist toggled off → priority → off by the tester | `toasts=on app=on focus=off`, then `focus=priority`, then `focus=off` | Focus assist reads `unknown`: the check drops the Focus assist prompt and keeps the other two (Q42) |
| S7 | T2's transitions match the recorder, with low lag | T2 build + `watch-sessions.mjs` + `compare-status.mjs --log <Operations log>` over 12 transitions (3 sessions × 4) | Every recorder transition has one `status` line, same from/to; `lag` ≤ 2000 ms 12/12; 0 extra lines | Fix in T2; no T3 merge |
| S8 | One pop-up per transition across 3 windows, and the toast spawn is fast | T2+T3 build, windows on uj-lab-a, uj-lab-b, uj-lab-d; 6 transitions | 6 `shown` lines in total (grep across 3 logs), 12 `skipped locked`; `lag` ≤ 3000 ms; `powershell.exe` children 0 after 15 s | Spawn p95 > 1.5 s: one long-lived host per window (stdin JSON lines); lock bug: fix in T2 |
| S9 | Each task is green on both OSes | `npm test` + `gh pr checks <N>` | 0 fail; skips ≤ 9; ubuntu + windows + privacy green | Fix in the task's PR; no merge |
| S10 | End to end in real Cursor (exit gate, E18) | Testing agent walk W1–W10 (T7) on the release sha in `%LOCALAPPDATA%\pitwall-uj` | Every W step PASS with evidence | Route each FAIL to its task owner; re-walk |
| GT | System-says ≠ correct | After S10: `compare-status.mjs` (recorder vs every window's `dumpState` vs log) + CUA screenshots of dots and bar in each window + Action Center count | Statuses equal across recorder, 3 windows and screenshots; pop-ups in Action Center = `shown` lines | Open a finding; Phase 5 stays open |

## 5. Evaluation criteria (definition of done; graded by an independent evaluator sub-agent on a fresh clone)

Lab set for the live criteria: windows on `uj-lab-a`, `uj-lab-b`, `uj-lab-d` (no chats), plus `uj-lab-a-wt`; sessions A = uj-lab-a panel chat, B = uj-lab-b panel chat, C = uj-lab-c CLI chat in Windows Terminal (no Cursor window for uj-lab-c).

| # | Criterion | Metric + threshold | How measured | Evidence |
|---|---|---|---|---|
| E1 | The full suite passes on both OSes | 0 fail on ubuntu + windows; skips ≤ 9, each with a reason | `gh run view` of main CI at the release sha | run id |
| E2 | **Exit gate:** status matches ground truth across 3 live sessions | A, B and C each driven idle → working → needs you → working → finished → (opened) idle, twice: 30 checkpoints. At each one, the dot in all 3 windows = the recorder's status, 30/30 per window; `compare-status.mjs` exit 0 | walk W2: `watch-sessions.mjs`, `compare-status.mjs`, per-window `dumpState`, CUA screenshots | JSONL + diff output + screenshots |
| E3 | Status and pop-ups are quick | `status` line `lag` ≤ 2000 ms for 24/24 transitions; `popup … shown` `lag` ≤ 3000 ms for 12/12 pop-ups | Operations log lines from W2/W3 | log excerpt |
| E4 | **Exit gate:** a pop-up fires exactly once per needs-you and per finished transition, and never when it shouldn't | 3 windows open. 12 eligible transitions (6 needs, 6 finished): exactly 12 `shown` across all logs and 12 toasts in Action Center. 0 `shown` for 3 transitions with the chat in front of a focused window (another window, twice), 2 waits present at a reload, and 2 re-polls. Dry: `two processes claiming one transition: exactly one wins` | walk W3 + `npm run test:dry -- popup-ledger attention` | log grep counts; Action Center screenshot; test names |
| E5 | The pop-up says what the canvas says, under Pitwall | Needs you and finished each: sender = "Pitwall" (or per the Q46 answer), title/body/attribution/buttons equal §3a, 2/2 screenshots; the dry test `toastXml escapes <, &, " and ' in titles` passes | walk W3 screenshots + `npm run test:dry -- toast-xml` | screenshots; test name |
| E6 | **Exit gate:** a pop-up click lands on the right chat | Open chat on pop-ups for: (a) a chat of the window in front, (b) a chat of another open window, (c) C's folder with no window, (d) a uj-lab-a-wt chat: 4/4 the chat's folder window in the foreground (CUA) with that chat's tab active showing its last message; 1 `route` line each; existing window `handoff opened` ≤ 3 s; cold, Pitwall's part (activate → opened) ≤ 5 s. A forged URI (non-UUID, unknown UUID, extra `prompt`) → `uri rejected`, 0 opens, 3/3 | walk W4 + `npm run test:dry -- popup-uri` | captures; log lines; test names |
| E7 | Sound is off by default and each switch works | Fresh profile: both settings `false`, bell = `bell-slash`, pop-ups log `sound=off`. Then 4 combos (off/off, on/off, off/on, on/on): each pop-up's `sound=` matches its kind's switch, 8/8; the bell icon flips; Test sound logs one `shown … sound=on`. Audible check is a human gate, not a criterion | walk W5 + `npm run test:dry -- sound` | log lines; screenshots |
| E8 | Bottom-bar counts are right and are buttons | At 6 checkpoints the three counts in each of 3 windows = the recorder's needs/working/finished counts over the sidebar list, within 5 s, 18/18; an item is hidden at 0; clicking `{n} need you` lists exactly those n, ordered by wait start ascending | walk W6 + `dumpState` counts + `npm run test:dry -- attention-status-bar` | screenshots; dumps; test names |
| E9 | The jump list and Ctrl+Alt+0 take you to the longest wait, then the rest | With A, B and C waiting (known start order): Ctrl+Alt+0 from each of 3 windows → the oldest wait, 3/3; `Next ▸` then visits the other two in order, each in its own window, 2/2; with 0 waiting, Ctrl+Alt+0 shows `Nobody is waiting on you right now.` | walk W6 + `npm run test:dry -- jump-walk navigation` | `jump` log lines; captures |
| E10 | The first-run check catches hidden pop-ups and is quiet otherwise | Dry: 4 states (all on, toasts off, app off, Focus assist on) → none / the matching §3e text, 4/4; two windows starting together → 1 prompt. Live: fresh profile with all on → 0 prompts; Pitwall's own Windows toggle off (tester, then restored) → the app-off prompt, and its button opens Settings (CUA window list) | `npm run test:dry -- first-run notification-state` + walk W7 | test names; screenshot |
| E11 | Task 1: the first Ctrl+↓ after launch onto a restored panel tab keeps list focus | 3 fresh launches, each with ≥ 3 restored panel tabs: the first Ctrl+↓ onto a restored tab keeps focus in the list (focus owner = list 1 s later, then the next ↓ moves the highlight), 3/3; the press scored by session ID and route line, not title | walk W8 | captures; route lines |
| E12 | Phase 4 doesn't regress where Phase 5 touches it | Phase 4 E3 (4 windows from 1), E4 (no duplicates), E6 (handoff timing), E8 (now **without** the amendment: 3/3 `ui` + 3/3 `terminal`, restored tabs included) and E14 (menu flip, ` · {k} windows`) each PASS on the release sha | walk W9 with Phase 4's measures | per-criterion evidence |
| E13 | Startup stays fast | `[Pitwall] activate` → `[Pitwall] first render` ≤ 1 s, 5/5 starts with real `~/.claude`, ≥ 3 other Pitwall windows open, load gate as amended in Phase 4 E16; 1 of the 5 is the first start after install | exthost log + gate table | log excerpt |
| E14 | Privacy holds | Dry: a planted `x.key` in the sessions fixture is never opened (fs spy, 0 opens); toast argv contains no title or path (payload on stdin); every new log format matches the allow-list regex (no path, no title). `node scripts/dump-pitwall-windows.mjs --check-privacy` exit 0 with the new keys (`front`, `focused`, lock names, jump file `v, ids, last, at`); privacy CI job green | `npm run test:dry -- claude-sessions-file windows-toast architecture` + script | test names; output; run id |
| E15 | Pitwall writes nothing under the Claude config dir | sha256 of `~/.claude/settings.json` and the file list of `~/.claude/sessions` (names only) unchanged by Pitwall across walk W1–W9 (only Claude's own pid files come and go); dry architecture test `no write call targets claudeConfigDir` passes | evaluator's own hash before/after + test | hashes; test name |
| E16 | Any Windows registration is reversible | If Q46 = A: `reg query HKCU\Software\Classes\AppUserModelId\sharifamlani.pitwall` shows `DisplayName Pitwall` after the first pop-up; after "Pitwall: Remove Pop-up Registration" *(new copy)*, the query exits 1; the `vscode:uninstall` script does the same in a dry test. If Q46 = C: N/A by ruling | walk W10 + `npm run test:dry -- windows-toast` | reg output; test name |
| E17 | The package ships only what it should | Windows CI archive check: 51 entries, or 52 with `out/uninstall.js` (Q46 = A), or the PR states why; privacy job green | CI run | run id |
| E18 | End to end: the Phase 5 flows work in real Cursor | Walk W1–W10 all PASS on the release sha (lab repos; real `~/.claude` read-only for W1 timing only) | testing agent walk | `captures/phase5-walk-evidence/` |

## 6. Implementation tasks

Waves (parallel within a wave, one PR per task):
- **A:** T1, T2
- **B:** T3 (consumes T2's ledger and transitions), T5 (consumes T2's `counts()` and `needsYouOrder()`)
- **C:** T4 (consumes T3's toast payload), T6 (consumes T3's `notifierSetting()` and AUMID)
- **D:** T7

Rebase order where files overlap:
- T1 before T5 (`chat.ts`).
- T2 before T3 (`NotificationService.ts`, `extension.ts`).
- T3 before T4 and T6 (`WindowsToast.ts`, manifest).
- T5 before T4 (manifest view/title and `extension.ts`).

`package.json` conflicts follow the Flywheel rule.

### Task 1: First Ctrl+↓ onto a restored panel tab keeps list focus (v0.5.0 known issue, `phase5/task-1-restored-ctrl-down`)

**Files:** Modify `src/core/commands/chat.ts` (`holdListForPanel`, `PANEL_SETTLE_MS` and a new `RESTORED_SETTLE_MAX_MS = 1500`) and `src/core/harness/kit/NativeUiTabSurfaceService.ts` (first-visit tracking, quieter trace). Tests: `test/dry/core/chat-commands.test.ts`, `test/dry/shared/native-ui-surface.test.ts`.

**Interfaces:**
- Consumes: S1 evidence (the load event's kind and timing).
- Produces:
  - `NativeUiTabSurfaceService.isFirstVisitSinceLaunch(sessionId: string): boolean`: true for a tab present at activation that has not been active since.
  - `holdListForPanel(opts?: { firstVisit: boolean }): void`. With `firstVisit`, the first tab change (the reveal) and the S1 load event both count as expected, and one refocus follows the load event after 250 ms, or the 1500 ms deadline if no event comes. Without it, behaviour is unchanged.

- [ ] **Step 1: Failing tests** in `chat-commands.test.ts`:
  - `first Ctrl+Down onto a restored, unvisited panel tab refocuses once after its webview load event`;
  - `with no load event, the first visit refocuses once at the 1500 ms deadline if nothing moved`;
  - `a restored tab already visited keeps the 250 ms single retry`;
  - extend `Ctrl+Down onto an open panel tab refocuses the list once more after the webview activates (E8)`: `one retry, never a loop` asserted for the first-visit path too (exactly 2 `focus list` events over 3 s);
  - `an editor click, a terminal, a window blur or another Pitwall open during the first-visit wait lets go`;
  - `a mouse open of a restored panel chat arms no retry`.

  In `native-ui-surface.test.ts`:
  - `a tab seeded at activation is a first visit until it is active once`;
  - `a tab Pitwall opened is never a first visit`;
  - `traceTabs logs a re-sent identical tab model once` (follow-up).
- [ ] **Step 2:** `npm run test:dry -- chat-commands native-ui-surface` → FAIL.
- [ ] **Step 3:** Implement. Keyboard path only (the one-shot `keepListFocus` marker). No timer loop: one `setTimeout` per press, cleared on let-go.
- [ ] **Step 4:** PASS, then `npm test`. Commit, push, PR. CHANGELOG `[Unreleased]`: "Fixed: the first Ctrl+↓ after launch onto a restored panel tab keeps the list focused (v0.5.0 known issue)."

**Live check (tester):** E11 (3 fresh launches) plus Phase 4 W6 for E8 on both surfaces.

### Task 2: Status for every session, transitions, one pop-up per transition (row 5.1, `phase5/task-2-status-everywhere`)

**Files:** Create `src/core/notify/PopupLedger.ts`, `scripts/watch-sessions.mjs`, `scripts/compare-status.mjs`, `docs/adr/0021-status-and-popups-for-every-session.md` and `test/dry/core/notify/popup-ledger.test.ts`. Modify:
- `src/harnesses/claude/ClaudeSessionsFile.ts`, `ClaudeHarness.ts`, `ClaudeAgentsService.ts`;
- `src/core/harness/types.ts`;
- `src/core/services/SessionAttentionService.ts`, `NotificationService.ts`, `chatVisibility.ts`;
- `src/core/windows/WindowRegistry.ts`, `dumpState.ts`;
- `src/extension.ts`, `scripts/dump-pitwall-windows.mjs`, `docs/privacy.md`, `docs/notifications.md`.

Tests: `attention.test.ts`, `window-registry.test.ts`, `claude-sessions-file.test.ts`, `claude-agents.test.ts`, `claude-repo-discovery.test.ts` (follow-up: `assertNoLongBlock`), `architecture.test.ts`.

**Interfaces:**
- Produces:
  - `ClaudeSessionsFile.watch(onChange: () => void): vscode.Disposable` (`*.json` events only, 150 ms debounce, re-watch when the folder appears).
  - `HarnessAdapter.watchLive?(onChange: () => void): vscode.Disposable`.
  - `StatusTransition = { chatId: string; sessionId: string; from: SessionStatus; to: SessionStatus; at: number; observedAt: number; waitingFor?: string }`.
  - `SessionAttentionService`:
    - `onDidTransition: Event<StatusTransition>`;
    - `counts(): { needs: number; working: number; finished: number }` over the sidebar list;
    - `needsYouOrder(): Array<{ chatId: string; since: number }>` (all listed chats, oldest wait first);
    - `sessionsNeedingYou()` keeps its signature, now backed by `needsYouOrder()`.
  - `WindowRecord` gains `front?: string; focused: boolean`. `beat(state: { openSessionIds: string[]; front?: string; focused: boolean }): Promise<void>`. `frontAnywhere(sessionId: string): boolean` (non-stale records only).
  - `class PopupLedger { constructor(dir: string, clock?: () => number); claim(key: { sessionId: string; kind: 'needs' | 'finished'; at: number }): Promise<boolean>; sweep(): Promise<void> }`.
  - `NotificationService.notify(kind, target & { at: number; sessionId: string }): Promise<'shown' | 'skipped'>`: judges, then claims, then delivers (in-window until T3).
  - `dumpState` adds `statuses: Record<sessionId, SessionStatus>` and `counts`.

- [ ] **Step 0 (S2):** land `scripts/watch-sessions.mjs` (reads only `*.json`, writes JSONL `{t, sid8, status, waitingFor, statusUpdatedAt}`) as its own commit; the tester runs S2 and the PR body records the results.
- [ ] **Step 1: Failing tests.**

  `claude-sessions-file.test.ts`:
  - `watch fires once per burst of .json writes within 150 ms`;
  - `a .key file event never fires and a .key file is never opened` (fs spy);
  - `watch survives the folder being created after start`.

  `attention.test.ts`:
  - `a closed chat whose live record turns waiting while you look elsewhere pops once` (inverts `R36–R45 toasts still fire only for open chats`, renamed `R36–R45 toasts fire for every listed chat`);
  - `busy → idle on a live record is finished; a pid that disappears mid-turn is idle with no pop-up`;
  - `a chat in front of a focused window in another window does not pop` (registry `frontAnywhere`);
  - `every transition logs status <id8> from→to lag=`;
  - `a re-poll with the same statusUpdatedAt makes no second transition`;
  - `counts() matches the sidebar list's needs, working and finished rows`;
  - `needsYouOrder() is oldest wait first across open and closed chats`;
  - `a live session in an unlisted folder asks discovery to refresh once` (Q31);
  - `Pitwall's own open or close of a chat makes no transition` (Phase 4 Q24 kept).

  `popup-ledger.test.ts`:
  - `the first claim of a key wins and the second loses`;
  - `two processes claiming one transition: exactly one wins` (child processes; both CI jobs);
  - `locks older than 10 min are swept`;
  - `a reload in the same window can't re-claim a transition`.

  `window-registry.test.ts`:
  - `front and focused round-trip and change fires onDidChange`;
  - `a stale record's front is ignored`;
  - `the early registry entry is disposed when window services fail to start` (follow-up).

  `claude-agents.test.ts`:
  - `after a failed call, the next call retries after 60 s, not never` (Q44);
  - `a settings change takes effect without a restart`.

  `architecture.test.ts`:
  - `no write call targets claudeConfigDir`;
  - `sessions folder reads filter on .json before open`.
- [ ] **Step 2:** `npm run test:dry -- attention popup-ledger window-registry claude-sessions-file claude-agents architecture` → FAIL.
- [ ] **Step 3:** Implement. The watcher is wired after first render. The judgement order is: kind enabled → pre-existing (R45) → front anywhere → `ledger.claim`. Then write `scripts/compare-status.mjs --truth <jsonl> --log <ops.log> [--dump <dir>]` (exit 1 on a missing, extra or mismatched transition), ADR 0021, and the privacy allow-list update.
- [ ] **Step 4:** PASS, then `npm test`. Commit, push, PR.

**Live check (tester):** S7, then E2 and E3 on the dots (pop-ups are still in-window until T3).

### Task 3: Windows pop-up under Pitwall; click → router (row 5.2, `phase5/task-3-windows-popup`)

**Files:** Create `src/core/notify/toastXml.ts`, `WindowsToast.ts`, `PopupUriHandler.ts`, `scripts/toast-probe.ps1`, `docs/adr/0022-windows-popup-sender.md`, and tests `test/dry/core/notify/{toast-xml,windows-toast,popup-uri}.test.ts`. If Q46 = A, also `src/uninstall.ts`. Modify `src/core/services/NotificationService.ts`, `src/extension.ts` (`registerUriHandler`), the manifest (`onUri`; `vscode:uninstall` if A; command `pitwall.removePopupRegistration` if A), `docs/notifications.md`, `docs/privacy.md`, `docs/troubleshooting.md`. Follow-up: `test/dry/core/windows/handoff-claim-processes.test.ts` sorts claims by send order.

**Interfaces:**
- Consumes: T2 `NotificationService.notify`, `PopupLedger`; Phase 4 `ChatRouter.route({ kind: 'open', chats: [chat] })`; `raiseWindow` (S4 fallback).
- Produces:
  - `ToastPayload = { aumid: string; title: string; body: string; attribution?: string; sound: boolean; openUri: string; tag: string }`.
  - `toastXml(p: ToastPayload): string` (every text node escaped; `launch` and the Open chat action = `openUri`, `activationType="protocol"`; Dismiss = `activationType="system"` `arguments="dismiss"`; `<audio>` per `sound`).
  - `class WindowsToast`:
    - `constructor(spawn?: SpawnFn, platform?: NodeJS.Platform)`;
    - `show(p: ToastPayload): Promise<'shown' | 'failed'>`;
    - `registerAumid(iconPath: string): Promise<'ok' | 'failed'>` and `unregisterAumid(): Promise<void>` (Q46 = A only; idempotent; IconUri refreshed when the extension path changes);
    - `notifierSetting(): Promise<'enabled' | 'disabledForUser' | 'disabledForApplication' | 'disabledByGroupPolicy' | 'unknown'>`.
  - `openUri(sessionId: string): string` and `parseOpenUri(uri: vscode.Uri): { sessionId: string } | { error: string }`.
  - `class PopupUriHandler implements vscode.UriHandler { handleUri(uri: vscode.Uri): Promise<void> }`.

- [ ] **Step 0 (S3–S5):** land `scripts/toast-probe.ps1` (`-Register`, `-Sound on|off`, `-State`, `-Launch <uri>`) as its own commit. The tester runs S3, S4 and S5; ADR 0022 records the sender route chosen.
- [ ] **Step 1: Failing tests.**

  `toast-xml.test.ts`:
  - `toastXml escapes <, &, " and ' in titles`;
  - `copy matches §3a for needs and finished`;
  - `sound off writes audio silent, sound on writes Notification.Default`;
  - `Open chat and the body launch the open URI; Dismiss is a system action`.

  `windows-toast.test.ts`:
  - `show spawns powershell with a constant script and the payload on stdin only` (argv has no title or path);
  - `a host that runs past 10 s is killed and reports failed`;
  - `at most one host in flight; a second show queues`;
  - `failed falls back to the in-window message once` (Q35);
  - `register writes DisplayName Pitwall under HKCU and unregister removes it` (spawn spy; Q46 = A);
  - `the uninstall script removes the key` (Q46 = A);
  - `non-win32 never spawns`;
  - `real PowerShell renders the XML without error` (windows CI only).

  `popup-uri.test.ts`:
  - `a listed session's open URI routes through ChatRouter once and logs popup click`;
  - `a non-UUID, an unknown UUID, another path or an extra prompt parameter is rejected and opens nothing`;
  - `the URI uses vscode.env.uriScheme`;
  - `a click marks the chat seen after the route lands` (D18).
- [ ] **Step 2:** `npm run test:dry -- toast-xml windows-toast popup-uri` → FAIL.
- [ ] **Step 3:** Implement. The toast tag is `<id8>-<kind>`, so a newer pop-up for the same chat replaces the older one. Registration runs once per activation after first render, never on the activation path.
- [ ] **Step 4:** PASS, then `npm test`. Commit, push, PR.

**Live check (tester):** S8, then E4, E5 and E6 (4 click cases plus forged URIs), and the 45 s re-raise follow-up on case (c).

### Task 4: Sound switches and the bell (row 5.3, `phase5/task-4-sound`)

**Files:** Create `src/core/notify/SoundSwitches.ts` and `test/dry/core/notify/sound.test.ts`. Modify the manifest (config section `pitwall.sound` titled "Sound" with two booleans; commands `pitwall.soundMenu` ×2 icons with `when` on `pitwall.soundOn`; `pitwall.testSound`; view/title `navigation@2`), `NotificationService.ts`, `src/extension.ts`, `docs/notifications.md`. Tests also in `manifest.test.ts` and `menus.test.ts`.

**Interfaces:**
- Consumes: T3 `ToastPayload.sound`, `WindowsToast.show`.
- Produces: `class SoundSwitches { get(kind: 'needs' | 'finished'): boolean; set(kind, on: boolean): Promise<void>; onDidChange: Event<void> }`, plus the context key `pitwall.soundOn`. How `set` stores the value follows Q47 (A: `config.update('sound.<kind>', on, Global)` on the user's click; B: it opens Settings filtered to `pitwall.sound`).

- [ ] **Step 1: Failing tests:**
  - `both sound settings default to false`;
  - `a needs pop-up carries sound only when sound.needsYou is on; finished follows its own switch`;
  - `the bell shows bell-slash with both off and bell with either on`;
  - `the bell quick pick ticks match the settings and Enter applies only changed ones`;
  - `Test sound shows one toast with sound on, whatever the switches`;
  - `set touches no key outside pitwall.sound` (Q47);
  - `the Settings page groups the two keys under Sound`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; regenerate `package.json`, run `--check`. **Step 4:** PASS, then `npm test`. Commit, push, PR.

**Live check (tester):** E7 (4 combos, bell flip, Test sound) plus one audible confirmation (human gate, logged, not graded).

### Task 5: Bottom-bar counts, jump list, Next ▸, Ctrl+Alt+0 (row 5.4, `phase5/task-5-counts-jump`)

**Files:** Create `src/core/windows/AttentionStatusBar.ts`, `src/core/windows/JumpWalk.ts`, and tests `test/dry/core/windows/{attention-status-bar,jump-walk}.test.ts`. Modify `src/core/commands/chat.ts` (`pitwall.showStatusList` with arg `needs|working|finished`, `pitwall.jumpNext`), `src/core/commands/navigation.ts` (`openLongestWaiting` per Q39), the manifest, `src/extension.ts`, `scripts/dump-pitwall-windows.mjs` (jump file keys), `docs/privacy.md`. Tests also in `navigation.test.ts`, `chat-commands.test.ts`.

**Interfaces:**
- Consumes: T2 `counts()`, `needsYouOrder()`, `onDidChangeStatus`; Phase 4 `ChatRouter.route`, `launchFolder` (for the meta "this window" / "its own window"); `RepoStatusBar` (priority: placed right after it).
- Produces:
  - `class AttentionStatusBar implements vscode.Disposable { constructor(source: { counts(): Counts; onDidChange: Event<void> }, walk: JumpWalk); refresh(): void }`.
  - `class JumpWalk { constructor(dir: string, clock?); start(order: string[], current: string): Promise<void>; next(order: string[]): Promise<string | undefined>; active(): Promise<boolean>; end(): Promise<void>; onDidChange: Event<void> }`.

- [ ] **Step 1: Failing tests:**
  - `three items show "{n} need you", "{n} working", "{n} finished" and hide at 0`;
  - `counts redraw within one status change`;
  - `clicking need you lists exactly those chats, oldest wait first, with meta "{repo} · ⎇ {branch} · this window|its own window · {waitingFor}"`;
  - `Enter opens the top item through the router`;
  - `an emptied list shows "Nothing left in this list."`;
  - `Ctrl+Alt+0 opens the longest needs-you wait across all sessions and skips finished`;
  - `Ctrl+Alt+0 with none says "Nobody is waiting on you right now."`;
  - `Next ▸ shows after a jump while another session waits, and opens the next one in order`;
  - `two JumpWalk instances on one dir agree on next`;
  - `the walk ends after 10 min or when the list empties`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, then `npm test`. Commit, push, PR.

**Live check (tester):** E8 and E9 across 3 windows.

### Task 6: First-run Windows notifications check (row 5.5, `phase5/task-6-notify-check`)

**Files:** Create `src/core/notify/notificationState.ts`, `src/core/notify/FirstRunCheck.ts`, and tests `test/dry/core/notify/{notification-state,first-run}.test.ts`. Modify the manifest (`pitwall.checkWindowsNotifications`), `src/extension.ts`, `docs/troubleshooting.md`.

**Interfaces:**
- Consumes: T3 `WindowsToast.notifierSetting()` and the AUMID; S6 result (Focus assist read route).
- Produces:
  - `notificationState(read?: Readers): Promise<{ toasts: 'on' | 'off' | 'unknown'; app: 'on' | 'off' | 'unknown'; focus: 'off' | 'priority' | 'alarms' | 'unknown' }>` (read-only: `HKCU\…\PushNotifications\ToastEnabled`, `notifierSetting()`, and the Focus assist route from S6).
  - `class FirstRunCheck { constructor(state: Memento, lockDir: string, read: typeof notificationState); run(opts?: { force: boolean }): Promise<'shown' | 'quiet' | 'skipped'> }`.

- [ ] **Step 1: Failing tests:**
  - `all on shows nothing and logs notify-check`;
  - `toasts off, app off and Focus assist on each show their §3e text and button`;
  - `the button opens ms-settings:notifications or ms-settings:quiethours via openExternal`;
  - `it runs once per profile; two windows starting together show one prompt`;
  - `force re-runs and says "Windows pop-ups are on." when all is on`;
  - `unknown Focus assist never prompts`;
  - `non-win32 never runs`;
  - `nothing writes to the registry` (spawn spy: only `reg query` / read calls).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, then `npm test`. Commit, push, PR.

**Live check (tester):** E10. The tester turns off **only Pitwall's own** toggle in Windows Settings, checks, then turns it back on (screenshot of both).

### Task 7: Close: walk, evaluator, v0.6.0 (`phase5/task-7-close`)

**Files:** `docs/progress_reports/phase5-scorecard.md`, `docs/progress_reports/phase5-handoff.md`, `CHANGELOG.md` [0.6.0], `README.md`, `package.json` version `0.6.0`, ROADMAP; one-line fix to the Phase 4 plan's FILES drag mime (`application/vnd.pitwall.files`).

- [ ] **Step 1:** Testing agent walk on the merged sha in `%LOCALAPPDATA%\pitwall-uj`. Lab: `uj-lab-a`, `uj-lab-b`, `uj-lab-c` (CLI only), `uj-lab-d`, `uj-lab-a-wt`.
  - **W1** — Fresh profile: sound defaults, bell icon, first start after install, 5 starts (E7 part, E13).
  - **W2** — Status ground truth, 3 sessions × 2 rounds, recorder on (E2, E3).
  - **W3** — Pop-ups across 3 windows, plus negatives: in front in another window, reload with a pending wait, re-poll (E4, E5).
  - **W4** — Click cases (a)–(d), forged URIs, the 45 s re-raise on a cold click (E6).
  - **W5** — Sound combos, bell, Test sound, Settings → Pitwall → Sound (E7).
  - **W6** — Counts, jump list, Next ▸, Ctrl+Alt+0 from each window (E8, E9).
  - **W7** — First-run check (E10).
  - **W8** — Restored-tab Ctrl+↓, 3 fresh launches (E11).
  - **W9** — Phase 4 E3, E4, E6 (existing-window handoffs on release code), E8 (unamended), E14 (E12).
  - **W10** — `~/.claude` hashes; registration present, then removed (E15, E16).
- [ ] **Step 2:** Run the GT row of §4.
- [ ] **Step 3:** The independent evaluator grades E1–E18 on a fresh clone and writes `phase5-scorecard.md`. The loop repeats until 18/18 PASS; after 3 rounds stuck on one criterion, escalate to Sharif.
- [ ] **Step 4:** Release PR (CHANGELOG [0.6.0] including "Fixed: v0.5.0 known issue, first Ctrl+↓ onto a restored panel tab", README, version 0.6.0). After the merge: annotated tag `v0.6.0`, pushed; ROADMAP flips; marketing handoff (§10).

## 7. Out of scope (later phases)

- Claude Code hooks, unless Sharif picks Q45 B (then a new row in Phase 7 or a Phase 5 amendment).
- macOS and Linux OS pop-ups beyond today's behaviour.
- Pop-ups for Codex, opencode and Pi (D9: dormant).
- Packaging and release on GitHub (Phase 6).

## 8. Phase 4 follow-ups and known issues

| Item (phase4-handoff.md) | Phase 5 | Why |
|---|---|---|
| v0.5.1: keep list focus on the first visit to a restored panel tab | **T1** | Sharif 2026-11-19 |
| Make the agents service pick up changes without a restart | **T2** (Q44) | Same file as status |
| Known issue: needs-you check turns off after one 5 s timeout | **T2** (Q44) | Same |
| Known issue: pop-ups only cover open chats | **T2** (Q31) | Phase 5 goal |
| Dispose the early registry entry if window services fail | **T2** | T2 changes `WindowRegistry` |
| Raw event-loop assert in `claude-repo-discovery.test.ts` → `assertNoLongBlock` | **T2** | T2 edits Claude harness tests |
| `dump-tabs.mjs`: add the dev tab dump to the privacy check | **T2** | T2 extends `dumpState` and the allow-list |
| Sort handoff claims by send order (race test flake) | **T3** | Pop-up clicks lean on handoffs |
| Quiet repeated re-sent model lines in `traceTabs` | **T1** | T1's S1 evidence uses the trace |
| Score W6 by session ID or route line, not row title | **T1 live check, T7** (E11) | Shared titles gave false FAILs |
| Walk the 45 s re-raise and "Open its window" toast live | **T7** W4 | Cold pop-up click exercises it |
| Re-run E6 existing-window handoffs on release code | **T7** W9 (E12) | Regression criterion |
| Sample the first start after install on a cold machine | **T7** W1 (E13) | Startup criterion |
| Re-measure startup under recorded load | **T7** W1 (E13) | Same |
| Update the Phase 4 plan's FILES drag mime | **T7** | One-line doc fix |
| QA probes for same-title tabs by place, re-send then copy | Deferred | Tab binding is untouched in Phase 5 |
| "Open the other N chats" pick: keyboard focus on a cold click | Deferred | Repo-click flow, not status |
| Screenshot of the outside-terminal warning + process count | Deferred | Evidence for a Phase 4 guard Phase 5 doesn't touch |
| `dump-tabs.mjs`: skip reused-pid dumps; show terminal chats | Deferred | Dev tooling only |
| Re-home a moved chat's row under its worktree | Deferred | Row placement, not status; counts don't depend on it |
| Other Phase 4 known issues (multi-root, type-ahead, flicker, slow parent lookup, binds within 2 s or 30 s, "+" row marker, side-by-side wait, startup in a handoff window) | Deferred | No Phase 5 code path; they stay in the v0.6.0 handoff |

## 9. Open questions for Sharif (recommendation first)

| # | Question | Recommended | Options and trade-offs | Changes |
|---|---|---|---|---|
| Q45 | **Hooks.** Row 5.1 names hooks (PermissionRequest, Notification, Stop). Installing them means writing into your Claude Code settings (`~/.claude/settings.json`), outside Pitwall. T1 measured that the sessions file alone shows needs-you (permission prompt and question card) and the finished edge, in the panel and the CLI. | **A. Sessions file only** for v0.6.0; amend row 5.1 to "from the sessions file (hooks deferred)" and add a Phase 7 row for opt-in hooks | **A** Sessions file only: zero writes to `~/.claude`; T1 covers both statuses; ≤ 2 s with the watcher. Risk: a status the file doesn't show (S2 checks background agents and Esc). **B** Opt-in hook install: a consent dialog, an atomic write to `~/.claude/settings.json` with a backup, dedupe, and "Remove Pitwall hooks" plus the uninstall script. Gains push latency (< 100 ms) and Stop vs interrupt; costs about 2 days, Apache-2.0 notices (claude-code-manager's installer), node-path issues on Windows, and a write to your settings. **C** Project-level hooks in each repo's `.claude/settings.local.json`: writes into your repos; not recommended. **D** Read hooks you install yourself: no setup, but undiscoverable | Q29; row 5.1 text; T2 scope; E15 |
| Q46 | **Pop-up sender.** Windows shows a toast under an app's ID (AUMID). For "Pitwall" to appear (D20), Windows must know that name. | **A. Per-user registry entry** `HKCU\Software\Classes\AppUserModelId\sharifamlani.pitwall` (DisplayName Pitwall, icon), written on first pop-up, no admin, removed by "Pitwall: Remove Pop-up Registration" and on uninstall. Fallback C if S3 shows A doesn't take | **A** HKCU key: one registry key, invisible in Start; our own code (MIT patterns from powertoast and notify); it touches your Windows user profile (system change, needs your OK); the test profile shares it. **B** Start-menu shortcut `Pitwall.lnk` carrying the AUMID: the classic route, but it adds a visible Start entry. **C** Cursor's AUMID: no install, but the sender reads "Cursor" and the per-app toggle is Cursor's. **D** node-notifier + SnoreToast (MIT wrapper, LGPL-3.0 exe): a bundled binary, antivirus flags, makes its own shortcut; not recommended. **E** PowerShell's ID: sender "Windows PowerShell"; not recommended | Q-route in T3; E5, E16, E17; ADR 0022 |
| Q47 | **Bell writes.** Flipping a sound switch from the bell stores `pitwall.sound.*` in your VS Code user settings. That conflicts with "Pitwall writes no user settings" unless Pitwall's own keys are allowed. | **A. Allow it for `pitwall.sound.*` only, on your click** (the same way the existing "Disable auto switch" header items already write `pitwall.*`) | **A** The bell flips in place; one source of truth with Settings → Pitwall → Sound. **B** The bell opens Settings filtered to `pitwall.sound` and you flip it there: zero writes by Pitwall, one extra click. **C** Store the switches in Pitwall's own state, not Settings: drops D27's "and in Settings" | T4 `SoundSwitches.set`; Global Constraints wording |

## 10. Close-out

**Scorecard template** (`docs/progress_reports/phase5-scorecard.md`, written by the evaluator):

| Criterion | Threshold | Result | Evidence | PASS/FAIL |
|---|---|---|---|---|
| E1 … E18 | as §5 | | | |

**Release:**
- annotated tag `v0.6.0` on the release merge commit: `git tag -a v0.6.0 -m "Phase 5: status and pop-ups" && git push origin v0.6.0`;
- `package.json` version `0.6.0`.

**ROADMAP:**
- rows 5.1–5.5 ✅ with PR and sha;
- the Phase 5 status line with the tag and the scorecard;
- the row 5.1 text per Q45;
- §0 → Phase 6;
- a §6 entry, and a version bump.

**Marketing handoff (D39):**
- tag + sha + the evaluator scorecard (PASS features only);
- bullets: "a chat in any repo that needs you shows a Windows pop-up; Open chat takes you there", "bottom-bar counts and Ctrl+Alt+0 walk you through what's waiting", plus what still doesn't work (from the handoff);
- media from the testing agent, lab repos only: a 10 s clip of a pop-up arriving and Open chat landing in another window, and a screenshot of the counts + jump list;
- one honest number: the p95 detection lag from E3;
- don't mention hooks unless Q45 = B ships.
