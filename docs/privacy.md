> Inherited from Agntree (MIT) at 47124cd; ids renamed to pitwall. <!-- credit-allow -->

# Privacy

Pitwall is local-first. It collects no telemetry, needs no account, and keeps its own state inside VS Code on your machine. One feature, Find Session, sends session text to a model provider, and only when you ask it a question. This page says exactly what Pitwall reads, stores, and sends.

## What Pitwall never does

- **No telemetry.** Pitwall sends no usage data, crash reports, or analytics to its author or to any third party.
- **No account.** There is nothing to sign in to.
- **No servers.** Pitwall has no backend. It cannot see your code, your sessions, or which agents you use.
- **No changes to your agents.** Pitwall installs no hooks and edits no agent configuration files.

## What Pitwall reads

To list and watch sessions, Pitwall reads what each agent already keeps on your machine, through the interface that agent supports:

| Agent | What is read |
| --- | --- |
| Claude Code | Session transcripts under `~/.claude/projects/`, and the output of `claude agents --json` |
| Codex | Threads through a local `codex app-server`, and rollout files under `~/.codex/sessions/` |
| opencode | Sessions through the `opencode` CLI and API. Its database is never opened |
| Pi | Session records under `~/.pi/agent/sessions/` |

It also runs `git` in the folders you add, and `gh` for pull requests. All of this stays on your machine.

## What Pitwall stores

Pitwall keeps a small amount of state in VS Code's extension storage:

- the folders and repositories you added,
- the session list: for each row, its name, its agent, and the agent's session ID,
- your stars, and which sessions you removed,
- which worktrees came from a pull request,
- your last ten Find Session searches, with the agent's answers.

It does not copy conversations. A session's content stays in the agent's own storage, which is why removing a row never deletes a conversation and uninstalling Pitwall loses nothing.

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
- Deleting a worktree removes its directory, after a confirmation that names what will be lost.
- These actions are logged in the **Pitwall Operations** output channel.

## Open source

Pitwall is MIT licensed, and everything on this page can be checked in the [source code](https://github.com/sharifamlani/pitwall). To report a security problem, see [SECURITY.md](../SECURITY.md).

## Related

- [FAQ](faq.md)
- [Find Session](find-session.md)
