# Pitwall — project rules

> **[ROADMAP.md](ROADMAP.md) is the canonical execution directive.** Before scoping new work, read ROADMAP §0 and the next Phase's entry gate in §3. Every new plan maps to a §3 Phase; if it doesn't, propose a §3 edit first. Flip status cells when the work merges, not later.

Pitwall is a Cursor / VS Code extension: one sidebar showing every Claude Code session across all repos, with status dots and Windows pop-ups. Clicking a session opens it in the **official Claude Code extension's chat panel**. Origin and decisions: `transcripts/inital_idea.md` (local only).

## Agent roles

The team's roles, prompts and learning loop are in [`.devcontainer/AGENT_ROLES.md`](.devcontainer/AGENT_ROLES.md); Pitwall's specifics are under "Agent roles" in [AGENTS.md](AGENTS.md). QA approval plus the Tester's user walk (in a real-use setup) ships a release; the Evaluator grades it after the tag, and its findings become patch releases.

**Build in public is part of the flywheel and runs on its own** (Sharif, 2026-11-20): build → QA → Tester walk → tag → Marketing posts on LinkedIn and X. Sharif pre-approves each release's posts near the end of the release (Main asks when the release-candidate walk starts). The pushed release tag is then the automatic GO: Marketing posts the pre-approved material right away, filling in only the walk's measured numbers and dropping unproven lines, with no further ask.

## Layout

- **Extension** = TypeScript, built with npm, at the repo root (`package.json`, `src/`, `test/`). Arrives in Phase 1 from Agntree.
- **Python dev tooling** = `tools/` only, managed by Poetry. Tests in `tools/tests/`. Run with `poetry run python -m tools.<name>`.
- **Scripts** = `scripts/`. Anything run more than once is a script there.
- **Plans** = `docs/superpowers/plans/`.

## Never track (this repo is PUBLIC)

| Path | Why |
|---|---|
| `.packages/` | Local connector scripts; may hold local credentials |
| `transcripts/` | Private planning conversations |
| `.claude/` (except `.claude/skills/pitwall-*/`, the extension's own skills) | Per-machine Claude Code settings, skills, locks |
| `.superpowers/` | Plan-execution scratch |
| `.env` | Local secrets. Only `.env.example` is tracked, with key names and empty values. |

Run `bash scripts/verify.sh` before every push; its `ignore` check fails if any of these is tracked.

## Versions and tags

- Releases use SemVer tags `vMAJOR.MINOR.PATCH`, as **annotated** git tags pushed to GitHub: `git tag -a vX.Y.Z -m "<one-line summary>" && git push origin vX.Y.Z`.
- **Every version bump gets a tag, in the same session it lands.** A version with no tag doesn't count as released.
- Each closed ROADMAP Phase is a minor release: Phase 0 → `v0.1.0`, Phase 1 → `v0.2.0`, … Phase 5 → `v0.6.0`. Phase 6, the first installable `.vsix`, is `v1.0.0` (numbering per ROADMAP v0.9). Fixes between phases bump the patch number.
- From Phase 1 onward, `package.json` `version` must equal the tag (reset Agntree's `4.0.0` on import). From Phase 6 onward, each tag also gets a GitHub release with the `.vsix` attached (`gh release create vX.Y.Z pitwall-X.Y.Z.vsix`).
- Record each tag in the ROADMAP Phase row and the §6 changelog.

## Naming and credit

- No "Claude" in the product name (Anthropic trademark). "for Claude Code" in descriptions is fine.
- Pitwall is forked from Agntree (MIT). Keep Agntree's copyright line in `LICENSE` and a "forked from Agntree" credit in the README.
- Never copy, embed or modify the Claude Code extension. It isn't open source. Drive it only through its public link handler and commands.

## Environment gotchas

- **This machine's shells can inherit `VIRTUAL_ENV` from another project.** Poetry will then install into that project's venv. Run `unset VIRTUAL_ENV` before any `poetry` command; `verify.sh` does this itself.
- In the container, Poetry's venv lives outside the workspace (`POETRY_VIRTUALENVS_IN_PROJECT=false`). `node_modules` is a per-checkout named volume that `postCreateCommand` hands to `vscode`. Together these mean the host's Windows environments are never overwritten.
- **The container sees no credentials.** Only `~/.claude/projects` is mounted (read-only), not `~/.claude`, which holds `.credentials.json`. `.packages/` is masked with an empty volume. npm install scripts run in there, so keep it that way. `verify.sh`'s `isolation` check enforces it.
- Tools must never call `load_dotenv(override=True)`: the host `.env` would override the container's `PITWALL_CLAUDE_HOME`.
- **Windows MAX_PATH (260 chars):** long paths were enabled on this machine on 2026-11-16 (`LongPathsEnabled=1`, `git core.longpaths=true`). If `WinError 206 … too long` comes back, check that registry value first. On other machines, README has the one-time admin fix.
- Write `.env` with the file tools, not `sed`/`awk`, which mangle Windows backslash paths.
