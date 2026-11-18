# Pitwall

**Every Claude Code session across your repos, in one sidebar.**

You run Claude Code in several repos at once. Sessions finish, or stop and wait for your approval, inside Cursor windows you are not looking at, and nothing tells you. Pitwall puts every repo and its Claude Code sessions in one place.

On an F1 pit wall, the team watches every car at once and calls in whichever one needs attention. Pitwall is meant to do that for your agent sessions.

## Status

**v0.4.0 (Phase 3): Sidebar v1, repos and sessions.** What works today:

- Repos are found automatically from your Claude Code sessions (last 14 days). Dismiss or Remove from Pitwall takes one off the list.
- Each repo lists its chats, with chat rows in a git repo showing their branch and a mark on worktree chats.
- Four status dots: needs you, working, finished and idle. The repo that needs you is on top, and a badge counts the chats waiting.
- Hover a chat for the bell, open in terminal and fork. The repo row has "+", session history and a right-click menu.
- Hotkeys (Ctrl+Alt+1 to 9, 0, O, F, R) and list keys, plus a search box (Ctrl+Alt+R).
- The list draws within a second of starting.
- After you quit or reload Cursor, the chat you had open comes back resumed in its own tab. Windows works like Linux and macOS.

**Next, Phase 4, "Windows and tabs":** clicking a chat lands you in the right Cursor window with it open in Claude Code's own chat panel. Pop-ups for every session are Phase 5. The plan and its order are in [ROADMAP.md](ROADMAP.md).

### Known issues

- **The needs-you badge shows on Cursor's vertical activity bar**, not on its default horizontal sidebar icon row. See the [FAQ](docs/faq.md).
- **Chats open in a terminal tab until Phase 4**, when they move to Claude Code's chat panel.
- **Pop-ups are Phase 5.** Today only a chat you have open can pop up.
- **Claude Code pulls its terminal to the front.** About a second after a Claude turn starts in a terminal, the Claude Code extension's IDE integration brings that terminal forward and gives it keyboard focus. This happens with Pitwall disabled too; it isn't Pitwall.
- **Quitting with a file in front can drop terminal chats.** If a file (not a chat terminal) is in front when you quit, VS Code and Cursor may restart the chat terminals without their names, so Pitwall can't match them and they aren't resumed. It's an editor race, reproduced without Pitwall installed. Click the chat in Pitwall to resume it in a new tab. Terminal mode is being replaced by Claude's chat panel in Phase 4.
- **A terminal moved to the bottom panel always counts as "not looking"**, so you may get a "needs you" pop-up for a chat you are watching there.

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
npm run package -- --out dist/
```

Then in Cursor or VS Code: **Extensions: Install from VSIX...** and pick `dist/pitwall-0.2.0.vsix`.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and check [ROADMAP.md](ROADMAP.md) to see where a change fits.

## Credit

Forked from [Agntree](https://github.com/subhashkhileri/agntree) by Subhash Khileri (MIT), at 47124cd. <!-- credit-allow -->

Pitwall is independent and not affiliated with or endorsed by Anthropic. It drives the official Claude Code extension only through its public link handler and commands, and never copies or modifies it.

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

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
