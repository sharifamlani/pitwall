# Pitwall

**Every Claude Code session across your repos, in one sidebar.**

You run Claude Code in several repos at once. Sessions finish, or stop and wait for your approval, inside Cursor windows you are not looking at, and nothing tells you. Pitwall puts every repo and its Claude Code sessions in one place.

On an F1 pit wall, the team watches every car at once and calls in whichever one needs attention. Pitwall is meant to do that for your agent sessions.

## Status

**v0.2.0 (Phase 1): Agntree forked, renamed and made Claude-only.** What works today:

- A sidebar lists your repos and their Claude Code chats, imported automatically from your local Claude Code session files.
- Clicking a chat reopens it in a terminal.

**Planned, not built yet:** chats opening in Claude Code's own chat panel, live status dots (working, needs you, finished), Windows pop-ups when a session finishes or needs approval, and the redesigned sidebar. The plan and its order are in [ROADMAP.md](ROADMAP.md).

## Requirements

- Cursor or VS Code (1.93 or newer)
- The Claude Code extension and the `claude` CLI, signed in

## Install from source

There is no published release yet.

```bash
git clone https://github.com/sharifamlani/pitwall
cd pitwall
npm ci
npm run compile
mkdir -p dist
npx @vscode/vsce package --out dist/
```

Then in Cursor or VS Code: **Extensions: Install from VSIX...** and pick `dist/pitwall-0.2.0.vsix`.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and check [ROADMAP.md](ROADMAP.md) to see where a change fits.

## Credit

Forked from [Agntree](https://github.com/subhashkhileri/agntree) by Subhash Khileri (MIT), at 47124cd. <!-- credit-allow -->

Pitwall is independent and not affiliated with or endorsed by Anthropic. It drives the official Claude Code extension only through its public link handler and never copies or modifies it.

## Development

**Host (Windows, Git Bash)** requires Python 3.13, Poetry 2.x, Docker Desktop, and Node 22.

```bash
poetry install
cp .env.example .env        # then fill in values
bash scripts/verify.sh
```

On Dropbox, keep dependency folders from syncing: `powershell -ExecutionPolicy Bypass -File scripts\dropbox-ignore.ps1`.

**Windows path-length limit:** with long paths disabled (the Windows default), installs fail with `WinError 206 … filename or extension is too long` when the clone sits deep in the folder tree. Clone to a short path, or enable long paths once from an admin PowerShell:
`Set-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem -Name LongPathsEnabled -Value 1; git config --system core.longpaths true`

**Container:** in Cursor, run **Dev Containers: Reopen in Container**. It gives you Python 3.13, Node 22 and Poetry 2.3.4, with your `~/.claude/projects` session files mounted read-only. Your Claude login and `.packages/` are deliberately hidden from the container, so install scripts from npm dependencies can't read them.

The container is for building and testing. Pitwall itself runs in Cursor on Windows, because the Claude Code extension, its hooks, and Windows pop-ups all live on the host.

### Layout

| Path | What it is |
|---|---|
| `tools/` | Python dev tooling (Poetry): env checks, session-file probes. Not the extension. |
| `scripts/` | Repeatable commands: `verify.sh`, `run-linux-tests.sh`, `dropbox-ignore.ps1` |
| `.devcontainer/` | Dev container definition |
| `docs/` | Plans and design notes; `docs/adr/` holds upstream's decision records |
| `src/`, `test/`, `package.json` | The extension, imported from Agntree | <!-- credit-allow -->

