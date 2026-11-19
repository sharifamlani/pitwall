> Inherited from Agntree (MIT) at 47124cd; ids renamed to pitwall. <!-- credit-allow -->

# Commands and menus

Pitwall's commands are in three places: the Command Palette, the hover icons and right-click menu of each row, and the title bar and `…` menu of each view. This page lists all of them.

## Command Palette

Open the Command Palette (`Ctrl+Shift+P`, `Cmd+Shift+P` on macOS) and type **Pitwall**. The palette lists only the commands that work without a row under the cursor.

### Folders and repositories

| Command | What it does |
| --- | --- |
| **Pitwall: Search repos and chats** | Open the search box (`Ctrl+Alt+R`) |
| **Pitwall: Add a repository** | Add a folder or a git repository to the sidebar |
| **Pitwall: Clone from GitHub…** | Clone a repository and add it |
| **Pitwall: Remove from Pitwall…** | Remove a folder or repository from the sidebar. Files and conversations are kept. Like Dismiss, it stays off the list until a new session starts in it or you add it again |
| **Pitwall: Dismiss from Pitwall** | Hide a repository from the sidebar until a new Claude Code session starts in it, or you add it again. Nothing on disk changes |
| **Pitwall: Copy Path** | Copy a repository's folder path |
| **Pitwall: Reveal in File Explorer** | Show a repository's folder in your system file manager |
| **Pitwall: Open in This Window** | Switch this window's workspace folder to a repository's folder |
| **Pitwall: Open Terminal Here** | Open a plain terminal in a repository's folder |
| **Pitwall: Remove All Sessions from List…** | Take every session of a folder off the list. Conversations are kept |
| **Pitwall: Open its window** | Open a repository's main folder in its own window; an open window for it is focused instead |
| **Pitwall: Bring its window forward** | The same action, labelled this way on a repo whose window is already open |
| **Pitwall: Open in New Window** | Open a worktree's folder in a new window (no longer on the repo menu) |
| **Pitwall: Open its chats** | What a click or Enter on a repo row runs: opens the repo's main-folder chats as tabs in its window, the 8 most recent first and a pick for the rest. Worktree chats are not opened. A row action, not in the palette |
| **Pitwall: Show its open chats side by side** | Puts the repo's open chats in a pane each (up to 4) in its window. Shown on a repo with two or more of its chats open. A row action, not in the palette |
| **Pitwall: Dump tab state (developer)** | Writes this window's tab groups, bound sessions and each repo's sidebar chats to `pitwall-dump/<pid>.json` in global storage, for `scripts/dump-tabs.mjs`. Hidden from the palette |
| **Pitwall: Trace tab events (developer)** | Toggles a trace in the **Pitwall Operations** output: every raw tab and tab-group event (group, index, label, input kind, and whether a group event replaced the Tab objects) and each tab bind or release with its reason. Off by default and after a reload; changes no settings. Hidden from the palette |

### Sessions

| Command | What it does |
| --- | --- |
| **Pitwall: New Session** | Start a session with your default agent in the current worktree. Asks which agent when none is set |
| **Pitwall: New Claude Code session** | Start a Claude Code session in a repository's main worktree. The **+** on a repository row |
| **Pitwall: Session history…** | List a repository's chats: those in the sidebar, then older ones that are not. Picking an older one brings it back and opens it |
| **Pitwall: Open Session That Needs You** | The bell on a session row that needs you. Opens that session |
| **Pitwall: Set Default Agent…** | Choose the agent **New Session** starts, or go back to asking every time |
| **Pitwall: New Claude Code Session** | Start a Claude Code session where your settings say sessions open |
| **Pitwall: New Claude Code Session in Terminal** | Start a Claude Code session in a terminal |
| **Pitwall: New Claude Code Session in Claude Code UI** | Start a Claude Code session in the Claude Code extension's panel |
| **Pitwall: New Codex Session** | Start a Codex session where your settings say sessions open |
| **Pitwall: New Codex Session in Terminal** | Start a Codex session in a terminal |
| **Pitwall: New Codex Session in Codex UI** | Start a Codex session in the Codex extension's panel |
| **Pitwall: New opencode Session** | Start an opencode session |
| **Pitwall: New Pi Session** | Start a Pi session |
| **Pitwall: Open Session in Terminal** | Open or focus the selected session in its terminal |
| **Pitwall: Open in Claude Code UI** | Open the selected Claude Code session in the Claude Code panel |
| **Pitwall: Open in Codex UI** | Open the selected Codex session in the Codex panel |
| **Pitwall: Import Existing Sessions…** | Add sessions the agents already hold for a worktree |
| **Pitwall: Starred Sessions…** | Pick one of your starred sessions to open |
| **Pitwall: Go to Next Session That Needs You** | Open the session that has been waiting on you longest, leaving out the one in front of this window |
| **Pitwall: Go to the Session Waiting Longest** | The same, on `Ctrl+Alt+0` and `Ctrl+Alt+N` |
| **Pitwall: List the Sessions That Need You** | The jump list behind the bottom-bar `need you` count: pick one to go to it |
| **Pitwall: Continue to the Next Session That Needs You** | What `Next ▸` in the bottom bar runs: after a jump, the next waiting session in the list's order |
| **Pitwall: Go to Repo 1** | Reveal and select repo 1 in the list; again opens its next session (key only) |
| **Pitwall: Go to Repo 2** | Reveal and select repo 2 in the list; again opens its next session (key only) |
| **Pitwall: Go to Repo 3** | Reveal and select repo 3 in the list; again opens its next session (key only) |
| **Pitwall: Go to Repo 4** | Reveal and select repo 4 in the list; again opens its next session (key only) |
| **Pitwall: Go to Repo 5** | Reveal and select repo 5 in the list; again opens its next session (key only) |
| **Pitwall: Go to Repo 6** | Reveal and select repo 6 in the list; again opens its next session (key only) |
| **Pitwall: Go to Repo 7** | Reveal and select repo 7 in the list; again opens its next session (key only) |
| **Pitwall: Go to Repo 8** | Reveal and select repo 8 in the list; again opens its next session (key only) |
| **Pitwall: Go to Repo 9** | Reveal and select repo 9 in the list; again opens its next session (key only) |
| **Pitwall: Open Repo 1 in Its Window** | Open repo 1 in a window of its own (key only) |
| **Pitwall: Open Repo 2 in Its Window** | Open repo 2 in a window of its own (key only) |
| **Pitwall: Open Repo 3 in Its Window** | Open repo 3 in a window of its own (key only) |
| **Pitwall: Open Repo 4 in Its Window** | Open repo 4 in a window of its own (key only) |
| **Pitwall: Open Repo 5 in Its Window** | Open repo 5 in a window of its own (key only) |
| **Pitwall: Open Repo 6 in Its Window** | Open repo 6 in a window of its own (key only) |
| **Pitwall: Open Repo 7 in Its Window** | Open repo 7 in a window of its own (key only) |
| **Pitwall: Open Repo 8 in Its Window** | Open repo 8 in a window of its own (key only) |
| **Pitwall: Open Repo 9 in Its Window** | Open repo 9 in a window of its own (key only) |
| **Pitwall: Open Current Repo in Its Window** | Open the selected repo in a window of its own |
| **Pitwall: Show or hide files** | Show the FILES panel, or hide it when it is shown |
| **Pitwall: Move Down and Open** | Move one row down the list and open it (`Ctrl+Down`; key only) |
| **Pitwall: Move Up and Open** | Move one row up the list and open it (`Ctrl+Up`; key only) |

### Find Session

| Command | What it does |
| --- | --- |
| **Pitwall: Find Session…** | Describe a past session and have an agent find it in any folder |
| **Pitwall: Find Session Settings…** | Choose the agent, model, and effort for Find Session |
| **Pitwall: Clear Searches…** | Remove past searches from the Find Session view |

### Files

| Command | What it does |
| --- | --- |
| **Pitwall: Search in Files** | Search inside the current worktree |
| **Pitwall: New File...** | Create a file in the current worktree |
| **Pitwall: New Folder...** | Create a folder in the current worktree |
| **Pitwall: Paste** | Paste the copied or cut file |
| **Pitwall: Refresh** | Refresh the Workspaces or Files view |

### Settings

| Command | What it does |
| --- | --- |
| **Pitwall: Pitwall Settings…** | Open Pitwall's settings in the Settings editor |
| **Pitwall: Pitwall Keyboard Shortcuts…** | Open Pitwall's shortcuts in the Keyboard Shortcuts editor |
| **Pitwall: Turn On Auto-Switch Workspace Folder** / **Turn Off Auto-Switch Workspace Folder** | Make VS Code's open folder follow the worktree you select |
| **Pitwall: Turn On Focus on Startup** / **Turn Off Focus on Startup** | Open the Pitwall sidebar when VS Code starts |
| **Pitwall: Check Windows Notifications** | Windows only. Check whether Windows would hide Pitwall's pop-ups (notifications off, Pitwall's own switch off, or Focus assist on) and say so, with a button to the matching Windows settings page. Says "Windows pop-ups are on." when all is well. Pitwall also runs this once, the first time it starts. It reads these settings and never changes them. See [Troubleshooting](../troubleshooting.md) |
| **Pitwall: Sound alerts** (the bell in the Repos header) | Tick which pop-ups play a sound: when a session needs you, when it finishes. Both are off by default. Its **Test sound** button shows one pop-up with sound. See [Notifications](../notifications.md#sound) |
| **Pitwall: Test Sound** | Show one pop-up, "Pitwall: test sound", with sound, whatever the switches say |
| **Pitwall: Remove Pop-up Registration** | Windows only. Delete the per-user registry key that names "Pitwall" as the sender of its Windows pop-ups (`HKCU\Software\Classes\AppUserModelId\sharifamlani.pitwall`) and Windows' own entry for it under `Notifications\Settings`. Pop-ups show inside the window until Pitwall starts again; uninstalling Pitwall also deletes the key. See [Notifications](../notifications.md#windows-pop-ups) |

## Workspaces view

The view's title bar has **Add a repository**. Its `…` menu has:

- **Clone from GitHub…**, **Check Out Pull Request…**
- **Go to Next Session That Needs You**, **Find Session…**, **Starred Sessions…**
- **Set Default Agent…**, the two **Turn On** / **Turn Off** switches, **Pitwall Settings…**, **Pitwall Keyboard Shortcuts…**
- **Refresh**

## Repository and folder rows

| Action | Where | Notes |
| --- | --- | --- |
| **Session history…** | Right-click | Chats in the sidebar, then older ones that are not; picking an older one brings it back |
| **New Claude Code session** | Right-click | A Claude Code session in the repo's main worktree, in that repo's window |
| **New Claude Code session in this repo** | Hover **+** | The same action as the menu item; this is the hover text |
| **Session history for this repo: every past chat** | Hover clock icon | The same action as **Session history…**; this is the hover text |
| **Open its window** / **Bring its window forward** | Right-click | Opens the repo's main folder in its own window, or brings that window forward when it is open; the label says which |
| **Show its open chats side by side** | Right-click | Only on a repo with a window and two or more of its chats open there. Puts them in a pane each, up to 4; any more stay as tabs in the last pane. It is the only move Pitwall makes to a tab, and it never closes one |
| **Copy Path** | Right-click | |
| **Reveal in File Explorer** | Right-click | |
| **Dismiss from Pitwall** | Right-click | Hides the repo until a new session starts in it; nothing on disk changes |

## Session rows

| Action | Where | Notes |
| --- | --- | --- |
| **Open Session** | Click, right-click | Opens where your settings say, or focuses it where it is open |
| **Open Session That Needs You** | Hover bell | Only on a session that needs you |
| **Open Session in Terminal** | Hover icon, right-click | |
| **Open in Claude Code UI**, **Open in Codex UI** | Hover icon, right-click | Claude Code and Codex sessions |
| **Rename Session…** | Right-click, `F2` | |
| **Star Session**, **Unstar Session** | Right-click | Works on several selected rows |
| **Fork Session Here** | Hover icon, right-click | |
| **Copy Resume Command** | Right-click, `Ctrl+C` / `Cmd+C` | |
| **Copy Session ID** | Right-click | |
| **Close Session** | Right-click | Open sessions; works on several selected rows |
| **Remove Session from List…** | Right-click, `Delete` / `Cmd+Backspace` | Works on several selected rows; conversations are kept |

Select several sessions with `Shift` or `Ctrl`/`Cmd` click.

## Find Session view

| Action | Where |
| --- | --- |
| **Find Session…**, **Clear Searches…** | View title bar |
| **Find Session Settings…** | View `…` menu |
| **Stop Search** | Hover icon on a running search |
| **Ask Again…** | Hover icon or right-click on a finished search |
| **Remove Search** | Right-click on a finished search |
| **Resume**, **Show in Workspaces** | Hover icon or right-click on a found session |
| **Copy Resume Command** | Right-click on a found session |

## Files panel

| Action | Where |
| --- | --- |
| **Search in Files**, **New File...**, **New Folder...**, **Paste**, **Refresh** | View title bar |
| **Open to the Side** | Right-click a file |
| **Reveal in File Manager**, **Open in Integrated Terminal** | Right-click |
| **Copy Path**, **Copy Relative Path** | Right-click |
| **Copy**, **Cut**, **Paste** | Right-click, `Ctrl+C` / `Ctrl+X` / `Ctrl+V`. One clipboard for every Pitwall window; Paste lands in this window's folder |
| **Copy to another repo (Pitwall)** | Right-click a file. Pick a repo; the copy lands in its root. Dragging a file onto a repo row does the same |
| **New File...**, **New Folder...** | Right-click a folder |
| **Rename...** | Right-click, `F2` |
| **Delete** | Right-click, `Delete` / `Cmd+Backspace`. Moves to the Trash |

## Related

- [Keyboard shortcuts](keyboard-shortcuts.md)
- [Settings](settings.md)
