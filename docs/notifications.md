> Inherited from Agntree (MIT) at 47124cd; ids renamed to pitwall. <!-- credit-allow -->

# Notifications

Pitwall tells you when a coding agent finishes a turn and, for Claude Code, when it is waiting on a permission prompt or a question. With several agents running, you can stay in one session and let the others call you back.

There are three signals: the mark on each session row, a notification, and a shortcut that takes you to the agent that has waited longest.

## The mark on a session row

The agent's mark on each row is live:

| Mark | Meaning |
| --- | --- |
| The mark pulses | The agent is working |
| The mark with a green dot | The turn finished |
| A grey mark | The session is closed |
| The mark with a hollow ring | New, no prompt sent yet |

A glance at the tree shows which agents are busy and which are done. The pulse respects your system's reduced-motion setting.

## Notifications

When a session in the sidebar list needs attention, open or not, in this window or another, and you are not looking at it, VS Code shows a notification with an **Open** button that takes you to the session. **Open** lands in the session's own window: a chat of another folder opens in that folder's window, the same way a row click does.

| Notification | When | Agents |
| --- | --- | --- |
| `<session> finished` | The agent ended its turn | Claude Code, Codex, opencode, Pi |
| `<session> needs your input` | The agent is waiting on a permission prompt or a question | Claude Code |

The notification names the repository and worktree, so you know which agent is calling.

Notifications are deliberately quiet:

- With several windows open, exactly one of them shows each notification.
- You are never notified about a session you are looking at, in any window.
- A session that is waiting on you sends "needs your input", not a second "finished".
- A wait notifies once. A finished turn notifies once. The next prompt re-arms them.
- A session whose process exits mid-turn shows idle and sends nothing.
- After a window reload, sessions that were already waiting do not notify again.
- A notification held back by a setting is sent once you turn the setting on, while the session is still waiting or finished.

On macOS, Pitwall can also show a system banner while VS Code is in the background. The banner is not clickable; the notification inside VS Code has the **Open** button.

### Windows pop-ups

On Windows the notification is a Windows pop-up sent by **Pitwall**, so you see it while Cursor or VS Code is behind another app or minimised. It replaces the message inside the window:

| Pop-up | Title | Text | Small print |
| --- | --- | --- | --- |
| Needs you | `<repo> needs you` | `<chat>: Claude is waiting for you.` | The reason, for example `permission prompt` |
| Finished | `<repo>: finished` | `<chat>: Your turn.` | |

- **Open chat**, or a click on the pop-up, brings the chat's folder window forward (opening it if needed) with the chat's tab active, and marks the chat seen.
- **Dismiss** closes the pop-up. The row keeps its dot and its count.
- A newer pop-up for the same chat and kind replaces the older one. Action Center keeps pop-ups under "Pitwall" until you clear them.
- A chat running in a terminal Pitwall didn't open shows the usual warning ("That chat is already running in another terminal …") instead of opening a second copy; it is still marked seen.
- Pop-ups are silent by default. See [Sound](#sound).
- The first click may make Cursor ask "Allow 'Pitwall' to open this URI?". Allow it; **Do not ask me again** stops the question for good.
- If Windows can't show the pop-up (Pitwall's pop-ups are switched off in Windows, or the pop-up host fails), the message inside the window shows instead.

To show the name "Pitwall", Pitwall writes one per-user registry key, `HKCU\Software\Classes\AppUserModelId\sharifamlani.pitwall`, after the window starts. It needs no admin rights. **Pitwall: Remove Pop-up Registration** in the Command Palette deletes it, together with Windows' own entry for Pitwall under `HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\sharifamlani.pitwall` (so Pitwall leaves Settings → System → Notifications), and uninstalling Pitwall deletes both too. After a removal, every other running window notices the missing key on its next pop-up, shows the message inside the window instead, and logs `[Pitwall] toast failed unregistered`. See [Privacy](privacy.md#on-windows).

## Sound

Pop-ups are silent until you ask for sound. Two switches, both off by default:

| Setting | Plays a sound when |
| --- | --- |
| `pitwall.sound.needsYou` | A session needs you |
| `pitwall.sound.finished` | A session finishes its turn |

On Windows the pop-up plays the system notification sound (`Notification.Default`); on macOS the banner plays "Glass". Each kind follows its own switch.

The bell in the Repos header (a slashed bell when both are off, a plain bell when either is on) opens a checkbox list of the two switches. **Enter** applies the ticks. The **Test sound** button shows one pop-up, "Pitwall: test sound", with sound, whatever the switches say, and the menu stays open. The bell writes only `pitwall.sound.*`, only when you click, to your user settings. The same switches are under Settings → Pitwall → Sound.

## Go to the next session that needs you

Press `Ctrl+Alt+N` (`Ctrl+Cmd+N` on macOS), or choose **Go to Next Session That Needs You** in the Pitwall `…` menu.

Pitwall opens the session that has waited longest on you, open or not, in any repo. A session stays in the queue until you answer it, so a session waiting in front of you still counts. When nothing is waiting, it says so.

The shortcut works with notifications turned off, which makes it a good replacement if you find them distracting. One exception: Pitwall checks whether Claude Code is waiting on you only while `pitwall.notifications.onNeedsInput` is on.

## Turn notifications on or off

Open **Pitwall Settings…** from the Pitwall `…` menu. Under **Notifications**:

| Setting | Default | Controls |
| --- | --- | --- |
| [`pitwall.notifications.enabled`](reference/settings.md#notifications) | On | Every notification. Turn it off and the three below have no effect |
| `pitwall.notifications.onTurnEnd` | On | "Finished" notifications |
| `pitwall.notifications.onNeedsInput` | On | "Needs your input" notifications for Claude Code |
| `pitwall.notifications.nativeBanner` | On | The macOS system banner |

## How Pitwall knows

Pitwall installs no hooks and does not edit any agent's configuration.

- **Claude Code:** the session's live-status file in `~/.claude/sessions` reports whether it is busy, waiting on you or idle, and Pitwall watches that folder, so a change shows within a fraction of a second (`claude agents --json` when that file is missing; after a failed call Pitwall tries again a minute later). The end of the session transcript shows whether a turn is running. A background subagent that is still running keeps the session marked as working.
- **Codex:** the session's rollout file records when a task starts, completes, or is aborted.
- **opencode:** its API reports when a session last went idle.
- **Pi:** the last entry in the session record shows whether the agent is mid-turn.

Sessions open in a terminal or panel, and Claude Code sessions running anywhere on this machine, are checked every few seconds and on every change to the live-status folder; only the new end of each file is read. Every status change and notification is logged in the **Pitwall Operations** output (`[Pitwall] status <id8> …`, `[Pitwall] popup …`, and on Windows `[Pitwall] popup click <id8>` and `[Pitwall] toast failed <code>`), with no chat titles.

opencode, Codex, and Pi do not expose a "waiting for permission" state, so "needs your input" is Claude Code only for now.

## Related

- [Sessions](sessions.md)
- [Troubleshooting: no notification](troubleshooting.md#i-get-no-notifications)
