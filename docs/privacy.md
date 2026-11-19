> Inherited from Agntree (MIT) at 47124cd; ids renamed to pitwall. <!-- credit-allow -->

# Privacy

Pitwall is local-first. It collects no telemetry, needs no account, and keeps its own state inside VS Code on your machine. One feature, Find Session, sends session text to a model provider, and only when you ask it a question. This page says exactly what Pitwall reads, stores, and sends.

## What Pitwall never does

- **No telemetry.** Pitwall sends no usage data, crash reports, or analytics to its author or to any third party.
- **No account.** There is nothing to sign in to.
- **No servers.** Pitwall has no backend. It cannot see your code, your sessions, or which agents you use.
- **No changes to your agents.** Pitwall installs no hooks and edits no agent configuration files.
- **One registry key on Windows, nothing else in the system.** See [On Windows](#on-windows).

## What Pitwall reads

To list and watch sessions, Pitwall reads what each agent already keeps on your machine, through the interface that agent supports:

| Agent | What is read |
| --- | --- |
| Claude Code | Session transcripts under `~/.claude/projects/`, also to find the repos your sessions ran in (only the first lines of transcripts from the retention window, up to the folder they name; only counts are logged); the live-status files `~/.claude/sessions/*.json` (only those: the `.key` files in that folder are never opened, read or logged; Pitwall also watches the folder for changes, which reads nothing); and the output of `claude agents --json` when those files are missing. Pitwall writes nothing under `~/.claude` (a test spies on every file write to prove it) |
| Codex | Threads through a local `codex app-server`, and rollout files under `~/.codex/sessions/` |
| opencode | Sessions through the `opencode` CLI and API. Its database is never opened |
| Pi | Session records under `~/.pi/agent/sessions/` |

It also runs `git` in the folders you add, and `gh` for pull requests. All of this stays on your machine.

## What Pitwall stores

Pitwall keeps a small amount of state in VS Code's extension storage:

- the folders and repositories you added or it found from your sessions, and the ones you dismissed,
- the session list: for each row, its name, its agent, and the agent's session ID,
- your stars, and which sessions you removed,
- which worktrees came from a pull request,
- your last ten Find Session searches, with the agent's answers.

It does not copy conversations. A session's content stays in the agent's own storage, which is why removing a row never deletes a conversation and uninstalling Pitwall loses nothing.

### Files shared between windows

Each Cursor or VS Code window runs its own copy of Pitwall. So that one window can open a chat in another (one window per folder, [ADR 0020](adr/0020-window-per-folder-handoff.md)), the windows share a few small files in the extension's global storage folder (`globalStorageUri`) and nowhere else. They hold only session IDs, folder paths, process IDs and timestamps, never conversation text:

| File | Where | What it holds |
| --- | --- | --- |
| Window record | `pitwall-windows/<pid>.json` | `pid`, `folder`, `beatAt`, `openSessionIds`, `front`, `focused`: the window's folder, the chats it has open as tabs, the session in front, and whether the window has focus (so no other window pops up a chat you are looking at). Deleted when the window closes; ignored 45 s after its last update |
| Pop-up lock | `pitwall-popups/<sessionId>.<needs\|finished>.<stamp>.lock` | Nothing: an empty file whose name is a session ID, a kind and a timestamp. The first window to create it shows that one pop-up; the others don't. Swept after 10 minutes |
| Handoff request | `pitwall-handoff/<folder key>/<id>.json` (renamed `.claimed-<pid>` or `.expired`) | `v`, `kind`, `sessionIds`, `folder`, `at`, `nonce`: which chats to open in which folder. A `<id>.lock` file, always empty, exists only while a request is being claimed |
| Handoff outcome | `pitwall-handoff/<folder key>/<id>.done-<pid>` | `ok`, `error`, `at`: whether the other window opened the chats |
| Clipboard | `pitwall-clipboard.json` | `path`, `cut`, `at`: the one file path copied or cut in the FILES panel, shared by all windows |
| Next walk | `pitwall-jump.json` | `v`, `ids`, `last`, `at`: the session IDs of the chats that were waiting on you when you last jumped to one from the bottom bar or Ctrl+Alt+0, the one you went to, and when. It lets `Next ▸` continue in any window; it ends 10 minutes after the last jump or when nobody waits |
| Tab dump | `pitwall-dump/<pid>.json` | `version`, `pid`, `windowFolder`, `tabGroups` (tab labels, pinned and active flags, bound session IDs), `repos` (name, folder, sidebar chat IDs), `statuses` (each listed session's row status: needs, working, finished or idle), `counts` (how many need you, are working, finished). Written only when the hidden developer command `pitwall.dev.dumpState` is run, for `scripts/dump-tabs.mjs` and `scripts/compare-status.mjs` |

Unclaimed handoff requests are deleted after 2 minutes, and the other handoff files after 10. To see what is there, run `node scripts/dump-pitwall-windows.mjs`; `--check-privacy` fails if any file holds a key outside the lists above, or a lock file is not empty.

The **Pitwall Operations** output logs each status change and pop-up as `[Pitwall] status <id8> <from>→<to> lag=<ms>` and `[Pitwall] popup <needs|finished> <id8> shown|skipped <reason>`: the first 8 characters of a session ID, statuses and timings, never a chat title or a path. A pop-up click logs `[Pitwall] uri probe keys=<keys>` (the link's query keys, never their values), then `[Pitwall] popup click <id8>` or `[Pitwall] uri rejected <reason>`; a failed Windows pop-up logs `[Pitwall] toast failed <code>`, and a pop-up lock that can't be written `[Pitwall] popup lock failed <code>`. The in-window notification itself shows the chat's name, its repo and the waiting reason, inside VS Code only.

### On Windows

- **One registry key.** So that pop-ups are sent by "Pitwall", Pitwall writes `HKCU\Software\Classes\AppUserModelId\sharifamlani.pitwall` with two values, `DisplayName` (`Pitwall`) and `IconUri` (the path of Pitwall's icon inside the extension folder). It is per Windows user, needs no admin rights, and is written after each window starts (only when a value differs). **Pitwall: Remove Pop-up Registration** deletes it, and so does uninstalling Pitwall. The key is shared by every editor profile on your Windows account: another profile with Pitwall installed writes it again when it starts. Windows keeps its own per-app switch for Pitwall under Settings → System → Notifications; Pitwall reads it and never changes it.
- **Pop-up text goes to Windows.** A pop-up's title, text and small print (the repo name, the chat's name and the waiting reason) are handed to Windows Notifications, which keeps them in its Notification history (Action Center) until you clear them. The text never appears on a command line, where other processes could read it, and never becomes PowerShell code: Pitwall starts `powershell.exe -NoProfile -NonInteractive -Command -` and sends it a fixed script plus one base64-encoded data block.
- **The click link.** A pop-up's click target is `<cursor|vscode>://sharifamlani.pitwall/open?session=<session ID>`. Pitwall opens only a chat it already lists, and never starts a chat or sends a prompt from a link. The first time, Cursor may ask "Allow 'Pitwall' to open this URI?"; its **Do not ask me again** writes `extensions.confirmedUriHandlerExtensionIds` to your user settings, on your click. Pitwall itself writes no setting for this.

The hidden developer command `pitwall.dev.traceTabs` writes tab labels, input kinds (view types, never file paths) and bound session IDs to the **Pitwall Operations** output while it is on. It is off by default, writes no file of its own and changes no settings.

## When something leaves your machine

Pitwall itself makes no network requests. Network traffic comes only from tools you already use, when you ask for them:

| You do this | This tool talks to the network |
| --- | --- |
| Start or resume a session | The agent's CLI, to its model provider, as always |
| **Clone from GitHub…**, **Rebase onto Upstream…**, a worktree from `upstream` | `git`, to your remotes |
| **Check Out Pull Request…**, pull request numbers on branches | `gh`, to GitHub |
| **Find Session…** | The agent that runs the search, to its model provider |

## Find Session

Find Session is the one feature where your session content is sent somewhere because of Pitwall.

When you ask a question, the agent you chose (Claude Code, Codex, or Pi) reads your session records to find a match. That includes sessions from your other installed agents. Whatever it reads goes to that agent's model provider, on your account, under the same terms as any other session with that agent.

To keep a search from doing anything else:

- the agent gets read-only tools,
- MCP servers from your agent's configuration are turned off for the run,
- nothing is saved to your agent's profile, and the search's temporary folder is deleted afterwards.

Find Session never runs by itself. If you never use it, no session content is sent anywhere by Pitwall. See [Find Session](find-session.md).

## Destructive actions

Pitwall deletes very little, and says what it will delete before it does:

- Removing a session row or a repository from the sidebar deletes no files and no conversations.
- Deleting a file in the All Files panel, or discarding an untracked file, moves it to the Trash.
- Pasting a file, **Copy to another repo (Pitwall)**, or dropping a FILES row on a repo row writes a copy into that folder and never overwrites: a name clash is saved as `{name} copy`. A cut moves the file and then empties the clipboard.
- When a copied `.env` or `.env.*` file (not `.env.example`, `.env.sample` or `.env.template`) is not ignored by the repo it lands in, which Pitwall asks `git check-ignore`, Pitwall offers to add it to that repo's `.gitignore`. It changes `.gitignore`, appending one `/path` line, only when you click **Add to .gitignore**.
- Deleting a worktree removes its directory, after a confirmation that names what will be lost.
- These actions are logged in the **Pitwall Operations** output channel.

## Open source

Pitwall is MIT licensed, and everything on this page can be checked in the [source code](https://github.com/sharifamlani/pitwall). To report a security problem, see [SECURITY.md](../SECURITY.md).

## Related

- [FAQ](faq.md)
- [Find Session](find-session.md)
