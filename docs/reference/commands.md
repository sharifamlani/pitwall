> Inherited from Agntree (MIT) at 47124cd; ids renamed to pitwall. <!-- credit-allow -->

# Commands and menus

Pitwall's commands are in three places: the Command Palette, the hover icons and right-click menu of each row, and the title bar and `…` menu of each view. This page lists all of them.

## Command Palette

Open the Command Palette (`Ctrl+Shift+P`, `Cmd+Shift+P` on macOS) and type **Pitwall**. The palette lists only the commands that work without a row under the cursor.

### Folders and repositories

| Command | What it does |
| --- | --- |
| **Pitwall: Add Local Folder or Repository…** | Add a folder or a git repository to the sidebar |
| **Pitwall: Clone from GitHub…** | Clone a repository and add it |
| **Pitwall: Remove from Pitwall…** | Remove a folder or repository from the sidebar. Files and conversations are kept. Like Dismiss, it stays off the list until a new session starts in it or you add it again |
| **Pitwall: Dismiss from Pitwall** | Hide a repository from the sidebar until a new Claude Code session starts in it, or you add it again. Nothing on disk changes |

### Sessions

| Command | What it does |
| --- | --- |
| **Pitwall: New Session** | Start a session with your default agent in the current worktree. Asks which agent when none is set |
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
| **Pitwall: Go to Next Session That Needs You** | Open the session that has waited longest since it finished or asked you something |

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

## Workspaces view

The view's title bar has **Add Local Folder or Repository…**. Its `…` menu has:

- **Clone from GitHub…**, **Check Out Pull Request…**
- **Go to Next Session That Needs You**, **Find Session…**, **Starred Sessions…**
- **Set Default Agent…**, the two **Turn On** / **Turn Off** switches, **Pitwall Settings…**, **Pitwall Keyboard Shortcuts…**
- **Refresh**

## Repository and folder rows

| Action | Where | Notes |
| --- | --- | --- |
| **Move Up**, **Move Down** | Right-click | Reorder the list |
| **Dismiss from Pitwall** | Right-click | Hides the repo until a new session starts in it; nothing on disk changes |

A plain folder row also has every action of a worktree row except the git ones, because sessions run directly in it.

## Worktree rows

| Action | Where | Notes |
| --- | --- | --- |
| **New Session** | Hover icon, right-click | A menu of installed agents, or your default agent in one click |
| **Import Existing Sessions…** | Right-click | |
| **Open in This Window** | Right-click | Shown when Auto-Switch Workspace Folder is off |
| **Open in New Window** | Right-click | |
| **Open Terminal Here** | Hover icon, right-click | A plain terminal |
| **Copy Path** | Right-click | |
| **Remove All Sessions from List…** | Right-click | Conversations are kept |

## Session rows

| Action | Where | Notes |
| --- | --- | --- |
| **Open Session** | Click, right-click | Opens where your settings say, or focuses it where it is open |
| **Open Session in Terminal** | Hover icon, right-click | |
| **Open in Claude Code UI**, **Open in Codex UI** | Hover icon, right-click | Claude Code and Codex sessions |
| **Rename Session…** | Hover icon, right-click, `F2` | |
| **Star Session**, **Unstar Session** | Hover icon, right-click | Works on several selected rows |
| **Fork Session Here** | Right-click | |
| **Copy Resume Command** | Right-click, `Ctrl+C` / `Cmd+C` | |
| **Copy Session ID** | Right-click | |
| **Close Session** | Hover icon, right-click | Open sessions; works on several selected rows |
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
| **Copy**, **Cut**, **Paste** | Right-click, `Ctrl+C` / `Ctrl+X` / `Ctrl+V` |
| **New File...**, **New Folder...** | Right-click a folder |
| **Rename...** | Right-click, `F2` |
| **Delete** | Right-click, `Delete` / `Cmd+Backspace`. Moves to the Trash |

## Related

- [Keyboard shortcuts](keyboard-shortcuts.md)
- [Settings](settings.md)
