# Pitwall — Step-by-Step Build Plan (LIVING)

> **Single source of truth. Update checkboxes as work lands. Status flips one cell.**
>
> This is CANON. All forward direction flows from here. Plan-creation order in [`docs/superpowers/plans/`](docs/superpowers/plans/) follows §3 Phase order. Before creating any new plan, verify the work has a Phase in §3. If it doesn't, propose a §3 edit first.

> v0.2 · 2026-11-16

---

## §0 You are here

- **Current phase:** Phase 1 — Import Agntree
- **Current step:** 1.1 — write the Phase 1 plan (merge Agntree with history via an `upstream` remote)
- **Last update:** 2026-11-16
- **Next action:** Sharif answers Decisions 2–10 on the spec canvas; then fold them into the Phase 1 plan and start the import.

Update §0 every working session. Any commit touching ROADMAP edits §0.

---

## §1 The North Star

**What Pitwall is.** A Cursor / VS Code extension that shows every Claude Code session across all your repos in one sidebar. Each session has a live status dot (working / needs you / finished / idle). Clicking a session opens it in the official Claude Code extension's chat panel, not a terminal. Source: `transcripts/inital_idea.md` (local).

**Who it serves.** A developer running Claude Code in several repos at once, across several Cursor windows, who loses minutes to an hour each time a session finishes or needs approval unnoticed. User zero is Sharif, on Windows.

**What v1 done delivers.** An installable `.vsix` (`v1.0.0`). Its sidebar lists repos and sessions with status dots. A click opens the chat panel directly, and Windows pop-ups fire on "finished" and "needs you". It is free, MIT, and works on native Windows.

**What later feels like.** You never hunt for windows. Ideally every repo's chat lives in one Cursor window (decided in Phase 2), and the session that has waited longest is one key away.

---

## §2 Locked architectural decisions

| # | Decision | Source |
|---|---|---|
| D1 | Runs inside Cursor as a second extension next to the official Claude Code extension; never copies, embeds or modifies it | `transcripts/inital_idea.md` (license: all rights reserved) |
| D2 | Fork Agntree (MIT), keeping its LICENSE line and a README credit; don't build from scratch | `transcripts/inital_idea.md` |
| D3 | Open sessions via `vscode://anthropic.claude-code/open?session=<id>` / `claude-vscode.editor.open` | `transcripts/inital_idea.md` |
| D4 | Status dot colors: blue = working, orange = needs you, green = finished, gray = idle | wireframe artifact `XhYy9L747DwQzBsQDpaFF2` |
| D5 | Name is Pitwall; no "Claude" in the name | `transcripts/inital_idea.md` |
| D6 | Extension = TypeScript/npm at the repo root; Python dev tooling = `tools/` via Poetry | [foundation plan](docs/superpowers/plans/2026-11-16-foundation.md) |
| D7 | Public repo; `.packages/`, `transcripts/`, `.claude/`, `.env` are never tracked | [foundation plan](docs/superpowers/plans/2026-11-16-foundation.md) |
| D8 | SemVer annotated tags on every version bump; Phase N closes as `v0.(N+1).0`, Phase 5 = `v1.0.0` | Sharif 2026-11-16, [CLAUDE.md](CLAUDE.md) |
| D9 | Claude Code only for v1; every agent lives in its own `src/harnesses/<id>/` folder, switched on by one `enabled.json` (Codex / opencode / Pi kept dormant) | Sharif 2026-11-16 |
| D10 | Sidebar = standard VS Code list (TreeView) for v1; the custom card panel is v2 | Sharif 2026-11-16, spec canvas Decision 1 |
| D11 | Two ways into a chat: click a repo → its open chats come up; click a session → its tab opens and the view switches to its repo | Sharif 2026-11-16, spec canvas "Two ways into a chat" |

---

## §3 The Checklist — every Phase from start to v1.0.0

### Phase 0 — Foundation
**Goal:** Clean, public repo with Poetry, `.env`, a dev container and a one-command verify script.
**Entry gate:** N/A.
**Exit gate:** Evaluator scorecard all PASS; tag `v0.1.0` pushed.
**Status:** ✅ done · tag `v0.1.0`.
**Plan:** [2026-11-16-foundation.md](docs/superpowers/plans/2026-11-16-foundation.md)

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 0.1 | Rewrite `.gitignore`, add `.gitattributes` + MIT `LICENSE` | ✅ | — | 2026-11-16 · `b78bf86` | plan Task 1 |
| 0.2 | Poetry project, `.env.example`, `tools/check_env.py` (6 tests) | ✅ | — | 2026-11-16 · `cca13ac` | plan Task 2 |
| 0.3 | Dev container (Python 3.13, Node 22, Poetry 2.3.4) | ✅ | — | 2026-11-16 · `4b0f06a` | plan Task 3 |
| 0.4 | `scripts/verify-foundation.sh` | ✅ | — | 2026-11-16 · `f27b8f8` | plan Task 4 |
| 0.5 | README, CLAUDE.md, this ROADMAP | ✅ | — | 2026-11-16 · `f27b8f8` | plan Task 4 |
| 0.6 | Secret scan of git history (gitleaks) | ✅ | — | 2026-11-16 · `f27b8f8` (no leaks, 9 commits) | plan Task 5 |
| 0.7 | Create public GitHub repo + push | ✅ | — | 2026-11-16 · `f27b8f8` · github.com/sharifamlani/pitwall | plan Task 5 |
| 0.8 | Fresh-clone end-to-end verify | ✅ | — | 2026-11-16 · `29a78a3` | plan Task 5 |
| 0.9 | Review fix pass: check_env missing template, privacy check any depth/casing, container isolation | ✅ | — | 2026-11-16 · `0c295ae` | whole-branch review |
| 0.10 | Independent evaluator scorecard (E1–E10) all PASS | ✅ | — | 2026-11-16 · E1–E8 @ `29a78a3`; E2/E3/E5/E7 + isolation re-graded @ `0c295ae`; E9–E10 @ `32214f9`. All 10 PASS | plan §4 |
| 0.11 | Tag `v0.1.0` | ✅ | — | 2026-11-16 · tag `v0.1.0` → `32214f9` | D8 |

### Phase 1 — Import Agntree
**Goal:** Agntree's code in this repo, with its history and MIT credit kept, building as Pitwall.
**Entry gate:** Phase 0 ✅ (`v0.1.0`).
**Exit gate:** `npm ci && npm run compile && npm test` green on host and in the container; tag `v0.2.0`.
**Status:** ⏸ planned.
**Plan:** ⏸ to write

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 1.1 | Add `upstream` remote → `subhashkhileri/agntree`; merge with `--allow-unrelated-histories` | ⏸ | ⏸ | — | D2 |
| 1.2 | Resolve root collisions (README, ROADMAP, `.gitignore`, LICENSE). Agntree tracks `.claude/`, which `check_private_paths` blocks: drop it or move it | ⏸ | ⏸ | — | D2, D7 |
| 1.3 | Rename to Pitwall in `package.json` (name, displayName, publisher); `version` → `0.2.0` | ⏸ | ⏸ | — | D5, D8 |
| 1.4 | `npm ci`, compile, dry tests green; add an npm step to `verify-foundation.sh` | ⏸ | ⏸ | — | D6 |

### Phase 2 — One-window test
**Goal:** Decide whether every repo's chat can live in one Cursor window, or a click must jump to that repo's window.
**Entry gate:** Phase 1 ✅.
**Exit gate:** Written verdict with evidence; tag `v0.3.0`.
**Status:** ⏸ planned.
**Plan:** ⏸ to write

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 2.1 | Multi-root workspace with 3 repos; open a session per repo via the link handler; record which folder each runs in | ⏸ | ⏸ | — | `transcripts/inital_idea.md` |
| 2.2 | Check the "already-open session opens a duplicate tab" bug | ⏸ | ⏸ | — | `transcripts/inital_idea.md` |
| 2.3 | Record the verdict: one-window vs jump-to-window | ⏸ | ⏸ | — | — |

### Phase 3 — Chat panel by default
**Goal:** Clicking a session opens the Claude Code chat panel directly, with no terminal step.
**Entry gate:** Phase 2 verdict.
**Exit gate:** Playwright/visual check: click → chat panel opens for the right session; tag `v0.4.0`.
**Status:** ⏸ planned.
**Plan:** ⏸ to write

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 3.1 | Find Agntree's "move to chat panel" code path; make it the default for Claude Code sessions | ⏸ | ⏸ | — | D3 |
| 3.2 | Handle the cross-window case per the Phase 2 verdict | ⏸ | ⏸ | — | Phase 2 |

### Phase 4 — Status dots + Windows pop-ups
**Goal:** Live working / needs-you / finished / idle dots, plus Windows notifications driven by Claude Code hooks.
**Entry gate:** Phase 3 ✅.
**Exit gate:** Status matches ground truth across 3 live sessions; pop-up fires on Stop and Notification; tag `v0.5.0`.
**Status:** ⏸ planned.
**Plan:** ⏸ to write

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 4.1 | Map Agntree's status labels to the D4 colors | ⏸ | ⏸ | — | D4 |
| 4.2 | Hook-driven "needs you" on native Windows | ⏸ | ⏸ | — | `transcripts/inital_idea.md` |
| 4.3 | Windows toast on finish / needs-you; clicking it focuses the session | ⏸ | ⏸ | — | `transcripts/inital_idea.md` |

### Phase 5 — Package + install
**Goal:** An installable `.vsix`, running in Sharif's daily Cursor.
**Entry gate:** Phase 4 ✅.
**Exit gate:** `.vsix` installed in Cursor and used across real repos for a day; GitHub release `v1.0.0` with the `.vsix` attached.
**Status:** ⏸ planned.
**Plan:** ⏸ to write

| # | Action | Status | Plan? | Date · Commit / Plan | Source |
|---|---|---|---|---|---|
| 5.1 | `vsce package` → `pitwall-1.0.0.vsix` | ⏸ | ⏸ | — | D8 |
| 5.2 | Install via *Extensions: Install from VSIX…* | ⏸ | ⏸ | — | `transcripts/inital_idea.md` |
| 5.3 | `gh release create v1.0.0` with the `.vsix` attached | ⏸ | ⏸ | — | D8 |
| 5.4 | (Optional) Publish to Open VSX with `OVSX_PAT` | ⏸ | ⏸ | — | `.env.example` |

---

## §4 Open decisions still to make

| # | Decision | Deadline / Trigger | Phase impact |
|---|---|---|---|
| Q1 | One-window vs jump-to-window | End of Phase 2 | Phase 3 design |
| Q2 | ~~Keep Agntree's other agents?~~ Resolved → D9 | — | — |
| Q4 | Spec canvas Decisions 2–10 (repo discovery, which sessions show, Finished→Idle, order, worktrees, extra panels, pop-ups, cross-window click, tabs vs side by side) | Before Phase 1 import | Phase 1 scope + later phases |
| Q3 | Publish to Open VSX / Marketplace, or `.vsix` only | Phase 5 | 5.4 |

---

## §5 Reference index

- [Foundation plan](docs/superpowers/plans/2026-11-16-foundation.md): Phase 0 tasks, smokes, evaluation criteria
- [CLAUDE.md](CLAUDE.md): project rules, never-track list, versioning and tags
- [Agntree](https://github.com/subhashkhileri/agntree): upstream (MIT)
- **Spec canvas** (wireframes, buildability, status rules, decisions): https://claude.ai/artifact/XhYy9L747DwQzBsQDpaFF2
- `transcripts/inital_idea.md`: origin conversation (local only, never committed)

---

## §6 Changelog

- **v0.1 · 2026-11-16.** Roadmap created. Phases 0–5 laid out from the origin conversation. Phase 0 rows 0.1–0.3 shipped. Versioning rule D8 locked (annotated tag on every bump).
- **v0.2 · 2026-11-16.** Phase 0 closed and tagged `v0.1.0`. Public repo at github.com/sharifamlani/pitwall. A whole-branch review found four Important issues, all fixed in `ab838e2`/`cdd42b3`/`0c295ae`: the env check passed with no template, the privacy check only caught top-level exact-case paths, the container's `node_modules` was root-owned, and the container could read the Claude login and `.packages/`. Phase 1 is unblocked. Machine note: Windows long paths are disabled (`LongPathsEnabled=0`), so enable them before Phase 1's npm install.
