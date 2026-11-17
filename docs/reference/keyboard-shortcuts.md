> Inherited from Agntree (MIT) at 47124cd; ids renamed to pitwall. <!-- credit-allow -->

# Keyboard shortcuts

Pitwall's default shortcuts use `Ctrl+Alt` on Windows and Linux and `Ctrl+Cmd` on macOS, so they stay clear of VS Code's own. Every one can be changed.

## Anywhere in VS Code

| Windows and Linux | macOS | Action |
| --- | --- | --- |
| `Ctrl+Alt+0` | `Ctrl+Cmd+0` | Go to the Session Waiting Longest |
| `Ctrl+Alt+N` | `Ctrl+Cmd+N` | Same as `Ctrl+Alt+0` |
| `Ctrl+Alt+1` | `Ctrl+Cmd+1` | Go to repo 1 in the list; press it again to open its next session |
| `Ctrl+Alt+2` | `Ctrl+Cmd+2` | Go to repo 2 in the list; press it again to open its next session |
| `Ctrl+Alt+3` | `Ctrl+Cmd+3` | Go to repo 3 in the list; press it again to open its next session |
| `Ctrl+Alt+4` | `Ctrl+Cmd+4` | Go to repo 4 in the list; press it again to open its next session |
| `Ctrl+Alt+5` | `Ctrl+Cmd+5` | Go to repo 5 in the list; press it again to open its next session |
| `Ctrl+Alt+6` | `Ctrl+Cmd+6` | Go to repo 6 in the list; press it again to open its next session |
| `Ctrl+Alt+7` | `Ctrl+Cmd+7` | Go to repo 7 in the list; press it again to open its next session |
| `Ctrl+Alt+8` | `Ctrl+Cmd+8` | Go to repo 8 in the list; press it again to open its next session |
| `Ctrl+Alt+9` | `Ctrl+Cmd+9` | Go to repo 9 in the list; press it again to open its next session |
| `Ctrl+Alt+Shift+1` | `Ctrl+Cmd+Shift+1` | Open repo 1 in a window of its own |
| `Ctrl+Alt+Shift+2` | `Ctrl+Cmd+Shift+2` | Open repo 2 in a window of its own |
| `Ctrl+Alt+Shift+3` | `Ctrl+Cmd+Shift+3` | Open repo 3 in a window of its own |
| `Ctrl+Alt+Shift+4` | `Ctrl+Cmd+Shift+4` | Open repo 4 in a window of its own |
| `Ctrl+Alt+Shift+5` | `Ctrl+Cmd+Shift+5` | Open repo 5 in a window of its own |
| `Ctrl+Alt+Shift+6` | `Ctrl+Cmd+Shift+6` | Open repo 6 in a window of its own |
| `Ctrl+Alt+Shift+7` | `Ctrl+Cmd+Shift+7` | Open repo 7 in a window of its own |
| `Ctrl+Alt+Shift+8` | `Ctrl+Cmd+Shift+8` | Open repo 8 in a window of its own |
| `Ctrl+Alt+Shift+9` | `Ctrl+Cmd+Shift+9` | Open repo 9 in a window of its own |
| `Ctrl+Alt+O` | `Ctrl+Cmd+O` | Open the selected repo in a window of its own |
| `Ctrl+Alt+Enter` | `Ctrl+Cmd+Enter` | New Session with your default agent, in the current worktree |
| `Ctrl+Alt+F` | `Ctrl+Cmd+F` | Show or hide FILES (Find Session… stays in the Command Palette) |
| `Ctrl+Alt+R` | `Ctrl+Cmd+R` | Search repos and chats; the last row hands your text to Find Session |
| `Ctrl+Alt+S` | `Ctrl+Cmd+S` | Starred Sessions… |
| `Ctrl+Alt+A` | `Ctrl+Cmd+A` | Show the Pitwall sidebar |

## In the Workspaces view

With a session selected:

| Windows and Linux | macOS | Action |
| --- | --- | --- |
| `F2` | `F2` | Rename Session… |
| `Delete` | `Cmd+Backspace` | Remove Session from List… (works on several selected sessions) |
| `Ctrl+C` | `Cmd+C` | Copy Resume Command |
| `Ctrl+Down` / `Ctrl+Up` | `Ctrl+Down` / `Ctrl+Up` | Move one row and open it (a repo row expands and is selected) |

## In the All Files panel

With a file or folder selected:

| Windows and Linux | macOS | Action |
| --- | --- | --- |
| `F2` | `F2` | Rename... |
| `Delete` | `Cmd+Backspace` | Delete (moves to the Trash) |
| `Ctrl+C` | `Cmd+C` | Copy |
| `Ctrl+X` | `Cmd+X` | Cut |
| `Ctrl+V` | `Cmd+V` | Paste |

## Change a shortcut

Choose **Pitwall Keyboard Shortcuts…** in the Pitwall `…` menu. VS Code's Keyboard Shortcuts editor opens with Pitwall's commands. There you can change or remove any shortcut, and give a key to any other Pitwall command, such as **Fork Session Here** or **Open Session in Terminal**. Session and file commands act on the selected row when run from a key.

## A keyboard-only loop

With a default agent set (**Set Default Agent…**), a whole working loop needs no mouse:

1. `Ctrl+Alt+Enter` starts an agent in the worktree you are in.
2. Give it a task, then start or switch to another.
3. `Ctrl+Alt+N` takes you to whichever agent finished or needs you first.
4. Run **Find Session…** from the Command Palette to find a session from last week by description.

## Related

- [Commands and menus](commands.md)
- [Settings](settings.md)
