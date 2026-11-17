# Assumption tests, round 1 (2026-11-16)

Live tests of the design assumptions T1–T16, run on Sharif's Windows machine with two throwaway lab repos
(`pitwall-lab-a`, `pitwall-lab-b`, in the session scratchpad, never committed).

Setup:
- Cursor 3.14.27, the Claude Code extension 2.1.296, and the CLI 2.1.325.
- Both lab repos had project hooks that log every hook event to a file.
- claude-code-manager's `scripts/observe-cli-statuses.mjs` watched `~/.claude/sessions/` every 250 ms.
- Windows were driven with CUA: Windows Terminal for the CLI, a separate Cursor window for the panel.

## Scorecard

| # | Assumption | Result | Evidence |
|---|---|---|---|
| T1 | The status file shows when a session waits for you | **PASS** (CLI and Cursor panel) | `"status":"waiting"` + `"waitingFor":"permission prompt"` on a Write prompt; `"waitingFor":"input needed"` on a question card. Transitions seen: idle → busy → waiting → busy → idle |
| T2 | A pop-up click brings the right window forward | **BLOCKED** | Windows notifications are off on this machine: `PushNotifications\ToastEnabled=0`, `Anysphere.Cursor` notifications disabled, Focus assist = Alarms only. The test toast never showed |
| T3 | "Toggle Maximize Editor Group" works in Cursor | **PASS** | Three groups → one fills the editor area; toggling back restores all three with their tabs (Ctrl+M Ctrl+M) |
| T4 | Ctrl+Alt hotkeys aren't eaten by AltGr | **PASS for this machine** | Keyboard layout en-US (0409), which has no AltGr. Still a risk for European layouts |
| T5 | One window can hold chats from several repos | **FAIL** | A session from lab-b, opened by link in the lab-a window, came up as a **new empty chat in lab-a** (Claude: "I haven't replied to anything earlier… working directory …\pitwall-lab-a"). The same happened in a two-folder workspace, and again with lab-b picked as the active repo. Control: a lab-a session in the same window loaded with its history |
| T6 | Opening an open chat doesn't duplicate it | **PASS** | Re-sending the link focused the existing tab (6 tabs before and after). A link for a chat open in another window brought **that** window to the front |
| T7 | Two chats side by side | **PASS within one repo** | Standard split. Across repos it's blocked by T5 |
| T8 | Show one repo's tabs, then all again, without closing | **Mechanism PASS** (via T3) | Maximize/restore keeps every tab. But a window can only hold one repo's chats (T5) |
| T9 | Repo label under Claude's chat tabs | **Not possible** | The tab label is the chat title, cut to about 24 characters ("Control session from lab…"). New chats are just "Claude Code" until named. The repo isn't shown, and other extensions can't add it |
| T10 | Pitwall can tell which chat a tab shows | **RISK CONFIRMED** | Tabs carry only the (truncated) title, and two tabs were both "Claude Code". Agntree matches by title (`NativeUiTabSurfaceService`). The session ID exists only inside the webview URL, which the extension API doesn't expose |
| T11 | Hooks fire inside the Cursor panel | **PASS** | From the panel: SessionStart, UserPromptSubmit, PermissionRequest (tool Write), Notification (`permission_prompt`, "Claude needs your permission to use Write"), Stop. Issue #59718 didn't reproduce on 2.1.296 |
| T12 | The pop-up can play a sound | **BLOCKED** | Same cause as T2 |
| T13 | Pitwall's Ctrl+Alt+F beats Cursor's | **Clash confirmed** | Cursor binds `list.find` to keycode 2596 = Ctrl+Alt+F. Extension keybindings normally win over built-ins; verify in Phase 1 |
| T14 | Drag a file onto a repo row | Not tested | Needs Pitwall code (Phase 1) |
| T15 | "+" starts a chat in another repo | Expected FAIL in a shared window | Same lookup as T5: a chat starts in the window's own folder |
| T16 | Agntree's 12 Windows test failures are environment quirks | Not tested | Phase 1 Windows triage |

## What it means for the design

1. **The one-window hub doesn't work with Claude's panel (T5).** The chat panel only resumes chats that belong to the window's folder. So decisions D25 (cross-repo side by side), D31 (tabs from several repos in one window) and D15's hub assume something Cursor won't do. The canvas "Fallback" board becomes the main design: each repo keeps its own Cursor window, Pitwall's sidebar shows everything in every window, and clicking a chat from another repo brings that repo's window forward with the chat open. Needs Sharif's call.
2. **The fallback has a working route.** A link goes to the focused window, or to the window already showing that chat (T6). Pitwall can focus the repo's window, then open the chat there.
3. **Status detection is solid (T1 + T11).** The status files and hooks both report "needs you" from the panel, including question cards. Phase 4's hardest open question is answered.
4. **Pop-ups need a first-run check (T2).** On this machine every Windows notification is off. Pitwall should detect `ToastEnabled=0`, Focus assist, and the app's own toggle, and offer `ms-settings:notifications`.
5. **Tab matching needs care (T10).** Use title + recent-open expectations (Agntree's approach) and treat unmatched tabs as unknown. Never guess from a duplicate "Claude Code" label.

## Why T5 fails: code recon (read-only, Claude Code extension 2.1.296)

Read for interoperability only, in the installed `extension.js`. Nothing was copied into Pitwall. Findings in our own words:

1. **Each window has one Claude folder.** The extension's session scope is the window's *first* workspace folder (the user's home folder if none is open). Every chat panel in that window uses that folder to list chats, look one up, and run Claude.
2. **The link carries no folder.** `/open` reads only `session` and `prompt`, then opens a panel in the window's folder. There's no setting for the folder either (checked all 23 `claudeCode.*` settings).
3. **The lookup could find any chat; the panel narrows it.** The "find transcript by ID" routine scans *every* project folder when given no folder. The panel always gives it the window's folder, so another repo's chat isn't found and the panel starts a new one.
4. **Worktrees are included in the lookup.** Given a folder, the lookup also searches that repo's git worktrees, so a worktree chat should open in its main repo's window (T17, still to confirm live). Claude's own history list sets `includeWorktrees: false`, so worktree chats don't appear there. Pitwall's list would show them.
5. **A process wrapper exists** (`claudeCode.claudeProcessWrapper`). It could start the Claude process in a different folder, but the panel's own history loading and file anchoring still use the window folder. Partial and fragile.

Ways around it, assessed:

| Idea | Verdict |
|---|---|
| Reorder workspace folders so the target repo is first before opening | ✗ Changing the first folder restarts every extension in the window and would stop running chats |
| Process wrapper that switches folders on `--resume` | ✗ Fragile: history pane and diffs still anchored to the window folder; bends Claude Code's behaviour |
| Window with no folder | ✗ Scope becomes the home folder, not "all repos" |
| Claude Code in terminal mode (`claudeCode.useTerminal`) | ◐ Terminals can run any repo's chat in one window, but you lose the chat panel UI. Possible v2 option |
| Feature request to Anthropic: per-session folder / multi-root support | ✓ The lookup already handles "any folder", so it's a small change on their side. File it with this evidence |
| **One window per repo (chosen for v1)** | ✓ Works today; T6 shows the link focuses the window already holding a chat |

## Side notes

- `entrypoint` in the sessions file said `claude-vscode` even for the terminal session, because it inherits the environment. Don't use it to tell panel from terminal.
- Shells started from Cursor's extension host inherit `ELECTRON_RUN_AS_NODE=1`, which makes `cursor`/`Cursor.exe` start with no window. Clear it before launching Cursor from a script.
- Side effects of the test:
  - 9 lab sessions under `~/.claude/projects/*pitwall-lab-*`.
  - One blank "Claude Code" tab left in Sharif's Job Market window (the first link test, before the focus rule was understood).
  - Two of Sharif's windows were minimized during the notification-center attempt; they have been restored.
