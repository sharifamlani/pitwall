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

Sessions open in a terminal or panel, and Claude Code sessions running anywhere on this machine, are checked every few seconds and on every change to the live-status folder; only the new end of each file is read. Every status change and notification is logged in the **Pitwall Operations** output (`[Pitwall] status <id8> …`, `[Pitwall] popup …`), with no chat titles.

opencode, Codex, and Pi do not expose a "waiting for permission" state, so "needs your input" is Claude Code only for now.

## Related

- [Sessions](sessions.md)
- [Troubleshooting: no notification](troubleshooting.md#i-get-no-notifications)
