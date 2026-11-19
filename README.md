# Pitwall

**Every Claude Code session across your repos, in one sidebar.**

You run Claude Code in several repos at once. Sessions finish, or stop and wait for your approval, inside Cursor windows you are not looking at, and nothing tells you. Pitwall puts every repo and its Claude Code sessions in one place.

On an F1 pit wall, the team watches every car at once and calls in whichever one needs attention. Pitwall is meant to do that for your agent sessions.

## Status

**v0.6.0 (Phase 5): status and pop-ups, on top of Windows and tabs.** What works today:

- Click any chat and it opens in the Cursor window for its folder (the window opens if needed), in Claude Code's own chat panel with its history.
- A repo click opens its 8 newest chats as tabs, side by side up to 4 panes, and never opens one twice.
- "+" on a repo starts the chat in that repo's window. The bottom bar shows `repo · branch` in every window, with a mark for worktrees.
- FILES follows the window's folder, with copy and paste between repos, "Copy to another repo" and an offer to add `.env` files to `.gitignore`.
- Repos are found automatically from your Claude Code sessions (last 14 days). Dismiss or Remove from Pitwall takes one off the list.
- Each repo lists its chats, with chat rows in a git repo showing their branch and a mark on worktree chats.
- Four status dots: needs you, working, finished and idle. The repo that needs you is on top, and a badge counts the chats waiting.
- Hover a chat for the bell, open in terminal and fork. The repo row has "+", session history and a right-click menu.
- Hotkeys (Ctrl+Alt+1 to 9, 0, O, F, R) and list keys, plus a search box (Ctrl+Alt+R).
- The list draws within a second of starting.
- After you quit or reload Cursor, the chat you had open comes back in its own tab (terminal chats are resumed by Pitwall; panel chats by Claude Code). This works on Windows.

**New in v0.6.0 (Phase 5):**

- Every listed session shows its status, read from Claude Code's sessions file.
- On Windows, a pop-up under Pitwall's own name for each chat that needs you or finishes, one per change however many windows are open. "Open chat" opens the chat in the window for its folder.
- Sound switches for "needs you" and "finished", off by default, with a bell in the Repos header and a Test sound button.
- The bottom bar counts chats that need you, are working or are finished. A click opens a jump list, `Next ▸` steps through the chats that need you, and Ctrl+Alt+0 opens the one that has waited longest.
- The first time Pitwall starts on Windows it checks that Windows will show its pop-ups, and offers the Settings page if not.

### Pop-ups on Windows

- The first time you click a Pitwall pop-up, Cursor asks "Allow 'Pitwall' extension to open this URI?". It asks on every click until you tick "Do not ask me again".
- Pitwall adds one per-user Windows entry so the pop-ups carry its name: HKCU `AppUserModelId\sharifamlani.pitwall`. It needs no admin rights. "Pitwall: Remove Pop-up Registration" removes it, and so does uninstalling Pitwall.
- Sounds are off by default. Turn them on from the bell in the Repos header or in Settings → Pitwall → Sound.
- More detail: [docs/notifications.md](docs/notifications.md) and [docs/privacy.md](docs/privacy.md).

**Next, Phase 6:** the first installable `.vsix`. The plan and its order are in [ROADMAP.md](ROADMAP.md).

### Known issues

- **The needs-you badge shows on Cursor's vertical activity bar**, not on its default horizontal sidebar icon row. See the [FAQ](docs/faq.md).
- **A chat that moved into a worktree keeps its row under the main repo**, though it opens in the worktree's window.
- **Windows with several folders open are not found** when Pitwall looks for the window to open a chat in; it opens the chat in the current window instead.
- **A new chat can take a second or two to get its name**, so text typed in that moment may land before the rename.
- **Dragging a file onto a repo row, and dragging tabs to reorder them, are checked by hand**, not by automated tests.
- **A click on a brand-new chat that belongs to another window's folder does nothing visible.** Pitwall won't start it in this window and doesn't yet say why; open that folder's window and click it there.
- **A restored tab titled "Claude Code", or with a title two chats share, isn't marked " · open".** Pitwall only links a tab it didn't open when its title names exactly one chat; clicking the row still shows the tab.
- **Claude Code pulls its terminal to the front.** About a second after a Claude turn starts in a terminal, the Claude Code extension's IDE integration brings that terminal forward and gives it keyboard focus. This happens with Pitwall disabled too; it isn't Pitwall.
- **Quitting with a file in front can drop terminal chats.** If a file (not a chat terminal) is in front when you quit, VS Code and Cursor may restart the chat terminals without their names, so Pitwall can't match them and they aren't resumed. It's an editor race, reproduced without Pitwall installed. Click the chat in Pitwall to resume it in a new tab. Since v0.5.0 chats open in Claude's chat panel by default; this affects terminal mode only.
- **A terminal moved to the bottom panel always counts as "not looking"**, so you may get a "needs you" pop-up for a chat you are watching there.
- **A click into a just-restored chat within about 0.8 s of the first Ctrl+↓ after launch is pulled back to the list once.** Click again.
- **Ctrl+Alt+0 and `Next ▸` can re-open the chat already in front** when it is a restored tab whose title other chats share.
- **Pop-up clicks open in Cursor's default profile**, and can take several seconds on a busy machine. A Cursor started with a separate `--user-data-dir` doesn't receive them.
- **A chat running a background agent shows "working"** until the agent's result is handled.
- **The pop-up registration is shared by all Cursor profiles** of the Windows user. Removing it in one profile turns pop-ups into in-window messages in the others until their next start.
- **Pop-ups appear about 1.5 to 3 s after the change.**
- **Downgrading shows merged duplicate chats again.** Nothing was deleted.
- **A pop-up click on a chat running in a window with several folders**, or in a Cursor window without Pitwall, shows "already running in another window" instead of bringing that window forward. Pitwall never opens a second copy.

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
