# Pitwall

**Every Claude Code session across your repos, in one sidebar.**

Pitwall is a Cursor / VS Code extension. A sidebar lists every repo and the Claude Code sessions in each one. Every session has a status dot: blue for working, orange for needs you, green for finished, gray for idle. Clicking a session opens it in the official Claude Code extension's chat panel, not a terminal. A Windows pop-up tells you when a session finishes or needs approval, so no session sits waiting while you're in another window.

On an F1 pit wall, the team watches every car at once and calls in whichever one needs attention. Pitwall does that for your agent sessions.

> **Status:** foundation only. The extension code arrives in Phase 1, forked from [Agntree](https://github.com/subhashkhileri/agntree) (MIT). See [ROADMAP.md](ROADMAP.md).

Pitwall is an independent project, not affiliated with or endorsed by Anthropic. It drives the official Claude Code extension through its public link handler (`vscode://anthropic.claude-code/open`) and never copies or modifies it.

## Setup

**Host (Windows, Git Bash)** requires Python 3.13, Poetry 2.x, Docker Desktop, and Node 22.

```bash
poetry install
cp .env.example .env        # then fill in values
bash scripts/verify-foundation.sh
```

On Dropbox, keep dependency folders from syncing: `powershell -ExecutionPolicy Bypass -File scripts\dropbox-ignore.ps1`.

**Container:** in Cursor, run **Dev Containers: Reopen in Container**. It gives you Python 3.13, Node 22 and Poetry 2.3.4, with your `~/.claude` mounted read-only.

The container is for building and testing. Pitwall itself runs in Cursor on Windows, because the Claude Code extension, its hooks, and Windows pop-ups all live on the host.

## Layout

| Path | What it is |
|---|---|
| `tools/` | Python dev tooling (Poetry): env checks, session-file probes. Not the extension. |
| `scripts/` | Repeatable commands: `verify-foundation.sh`, `dropbox-ignore.ps1` |
| `.devcontainer/` | Dev container definition |
| `docs/` | Plans and design notes |

## License

MIT. See [LICENSE](LICENSE).
