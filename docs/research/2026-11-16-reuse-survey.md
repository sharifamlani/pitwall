# Reuse survey: code we can lift (2026-11-16)

Sources: 8 repos shallow-cloned into `public/` (git-ignored) + a web search. Every item below was read, not just README-checked.
License rule: Pitwall is MIT, so we may copy MIT / Apache-2.0 / BSD / ISC code (keeping notices). AGPL, GPL and unlicensed code is **ideas only**.

## Licenses of the candidate repos

| Repo | License | Copy? |
|---|---|---|
| agntree (our base), claude-terminal, switchboard, ccmanager, vscode-cc-agent-manager | MIT | yes, keep notice |
| claude-code-manager (vishalguptax) | Apache-2.0 | yes, keep LICENSE + headers, mark changed files (no NOTICE file) |
| claudecodeui / CloudCLI | AGPL-3.0 | ideas only |
| sessiondeck | none (source-available) | ideas only |

## Facts found on this machine (they change the design)

- `~/.claude/sessions/<pid>.json` holds a live record for **every running session machine-wide**, including Cursor-panel ones (`entrypoint: "claude-vscode"`): `sessionId`, `cwd`, `status` (busy/idle seen), `statusUpdatedAt`, `name`. 21 files present. `claude agents --json` prints the same records but costs ~1.9 s per call. Reading the folder directly closes the "only this window" gap.
- `~/.claude/history.jsonl` has **no** Cursor-panel sessions (0 lines for pitwall). Repo discovery must scan `~/.claude/projects/`, not history.
- Project folder names are lossy (`Dropbox (Personal)` → `Dropbox--Personal-`; drive letter appears as `C--` and `c--`). Take the real path from the transcript's first `"cwd"`; compare case-insensitively.
- Transcripts (CLI 2.1.3xx) carry `ai-title`, `custom-title`, `last-prompt` records.
- Agntree bug: its chat-open fallback hardcodes `vscode://anthropic.claude-code/open`, which in Cursor launches VS Code. Use `vscode.env.uriScheme`.

## What to lift, by gap (ranked)

| # | Gap | Lift | License | Saves |
|---|---|---|---|---|
| 1 | Live status for every session, any window | claude-code-manager `src/features/sessions/liveSessions.ts` (`readSessionsDir`, `isPidAlive`, `detectPendingInteraction`, `refineStatus`), `procTime.ts` (Windows PID start time), `core/safeOpen.ts`, `core/lru.ts`; watcher pattern from `activeSessionWatcher.ts` | Apache-2.0 | ~2 days |
| 2 | Repo discovery + session titles | claude-code-manager `metaParser.ts` (`readSessionMeta`: 256 KB head / 64 KB tail, mtime cache) + `core/lineDecoder.ts`; switchboard `encode-project-path.js` (long-path hash); new walk over `~/.claude/projects` reading first `cwd` | Apache-2.0, MIT | ~1 day |
| 3 | Safe hook installer (extra status signal) | claude-code-manager `hookInstall.ts` + `core/atomicWrite.ts` + `core/nodePath.ts` (atomic global settings write, refuses on unparseable file, dedupes by script name, absolute node path); switchboard `classifyNotification` | Apache-2.0, MIT | ~1.5–2 days |
| 4 | Open the official chat correctly in Cursor | claude-code-manager `extension/claudeCodeExtension.ts` (`hostUriScheme`, `hasChatOpenCommand`) patched into Agntree `claudeUi.ts` | Apache-2.0 | ~0.5 day |
| 5 | Focus the right window / open repo in new window | claude-code-manager `commands.ts` `openProject` + cross-project `resumeSession` (openFolder, then URI); our own `cursor.cmd` fallback run via shell (spawn without shell fails on Windows, EINVAL / CVE-2024-27980) | Apache-2.0 | ~0.5 day |
| 6 | Windows pop-ups with click-to-open | **Nothing to lift; we write it.** ~60-line PowerShell WinRT toast, `activationType="protocol"`, `launch="cursor://…"`, Cursor's AppUserModelID (`Get-StartApps`). Patterns: powertoast (MIT), enescaakir/notify (MIT). Backup: node-notifier 12.1.0 (MIT, SnoreToast). | MIT patterns | budget 1–2 days |
| 7 | Transcript record types | `claude-code-types` 1.6.0 (dev dependency, types only) | MIT | ~1 h |
| 8 | v2 custom panel (later) | vscode-cc-agent-manager `media/main.js` + `style.css` (chips, status dots) | MIT | later |

Skipped: ccmanager / switchboard state detection (they read their own terminal's screen; can't see the chat panel), vscode-cc-agent-manager `deriveStatus` ("ends with ?" heuristic), claude-terminal hook installer (writes into every repo), ccusage (library export removed after v17; claude-code-manager's parser covers the need), Claude Agent SDK (commercial license; we copy only its title order: custom title → last prompt → summary → first prompt).

## Official hooks: what we can rely on

- Every hook payload: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name` ([docs](https://code.claude.com/docs/en/hooks)).
- **Stop fires in the extension's chat panel. Notification and PermissionRequest reportedly do not** ([#59718](https://github.com/anthropics/claude-code/issues/59718), dup of #55875). Treat as broken until tested.
- Fallbacks for "needs you": the sessions-folder status + claude-code-manager's unanswered `AskUserQuestion` / `ExitPlanMode` tail probe; enescaakir/notify's PreToolUse/PostToolUse marker (marker still present after ~3 s = permission prompt).

## Risks that need a Windows spike before building on them

1. Does a session waiting on **permission** show up in `~/.claude/sessions/<pid>.json` (as `waiting` / `waitingFor`), or only busy/idle? Run claude-code-manager's `scripts/observe-cli-statuses.mjs` while a prompt is pending.
2. Does clicking a protocol-activation toast bring the **right** Cursor window forward? Windows' focus-stealing rules can leave only a flashing taskbar button, and `cursor://` goes to the topmost window.
3. Does `workbench.action.toggleMaximizeEditorGroup` work in Cursor? A [forum report](https://forum.cursor.com/t/view-toggle-maximize-editor-group-command-not-working/154718) says no. The "click a repo → only its tabs" design (D11) depends on it; the fallback must not close running chats.
4. Hotkeys: Ctrl+Alt+digits are free in VS Code and Cursor defaults, but on non-US keyboard layouts Ctrl+Alt = AltGr and would swallow characters.

## License obligations when we copy

Add `THIRD_PARTY_NOTICES.md`: full Apache-2.0 text (© Vishal Gupta, claude-code-manager) and the MIT copyright lines of each MIT source used (Agntree © Subhash Khileri; switchboard © Doctly; and any others actually lifted). Mark every changed Apache file with a header line.
