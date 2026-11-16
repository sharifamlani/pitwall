# Pitwall Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay down Pitwall's repo foundation — clean `.gitignore`, Poetry, `.env`, a dev container, project docs, a one-command verify script — and publish it as a public GitHub repo, before any Agntree code is imported.

**Architecture:** Two toolchains side by side at the repo root. The VS Code/Cursor **extension** (imported from Agntree in Phase 1) is TypeScript built with npm, and owns the root `package.json`, `src/`, `test/`. **Python dev tooling** (session-file probes, verification scripts, eval harnesses) lives entirely under `tools/` and is managed by Poetry. Foundation files are placed so Agntree's tree merges in later without filename collisions (`tools/` not `scripts/` for Python, `tools/tests/` not `test/`).

**Tech Stack:** Python 3.13 + Poetry 2.3.4 + python-dotenv + pytest · Node 22 (for the extension, Phase 1) · Docker dev container (`python:3.13-bookworm` + Node 22) · GitHub via `gh`.

**Spec:** `transcripts/inital_idea.md` (stays local — `transcripts/` is intentionally git-ignored) + Sharif's request of 2026-11-16: *"Set up poetry and the .env file … the environmental file, the poetry, and the container … Send it to a GitHub remote. You can make it public. Clean up the git ignore as well."*

## Phase tracker

```
PITWALL — phase plan
─────────────────────────────────
Phase 0 : Foundation (this plan)            [....⏸...............] waiting on you (plan review)
Phase 1 : Import Agntree (MIT, history kept)
Phase 2 : One-window test (all repos, one Cursor window?)
Phase 3 : Chat panel by default (no terminal step)
Phase 4 : Status dots + Windows pop-ups (hooks)
Phase 5 : Package .vsix + install in Cursor
```

## Global Constraints

- Repo: `github.com/sharifamlani/pitwall`, **public**, default branch `main`.
- Description: `Pitwall: every Claude Code session across your repos, in one sidebar.`
- Never tracked, ever (public repo): `.packages/` (local connector scripts; may hold credentials), `transcripts/`, `.claude/`, `.env`.
- "Claude" must not appear in the product name (Anthropic trademark); "for Claude Code" in descriptions is fine.
- Python `requires-python = ">=3.13,<3.14"`; Poetry `package-mode = false`; venv in-project on the host (matches `audio-to-transcript`).
- Poetry pinned to `2.3.4` in the container (host already has 2.3.4). Node major `22` (host has v22.23.2).
- License: MIT, `Copyright (c) 2026 Sharif Amlani`. Phase 1 adds Agntree's `Copyright (c) Subhash Khileri` line; nothing is removed.
- The `.env` file is for **dev tooling only**. The extension itself reads VS Code settings, never `.env`.
- Tools never print `.env` values — key names only.

## Review Focus

1. **`.env` written by Windows Notepad** (UTF-8 BOM + CRLF) → the first key reads as `\ufeffKEY` and gets falsely reported missing. Expected: parses cleanly. → Task 2 test `test_bom_and_crlf_env_file_parses`.
2. **A secret value echoed to the terminal / a log** by the env check. Expected: only key names ever printed. → Task 2 test `test_main_never_prints_values`.
3. **Container clobbers the host's `.venv` / `node_modules`** (Linux binaries over Windows ones in the shared, bind-mounted folder). Expected: host env still works after a container run. → Task 3 sets `POETRY_VIRTUALENVS_IN_PROJECT=false` + a named volume on `node_modules`; Smoke 5 pins it.
4. **Case-sensitive ignore inside the Linux container**: today's rule `Transcripts/` does not match the real folder `transcripts/` on Linux, so a `git add .` inside the container would publish the transcript. Expected: ignored on both OSes. → Task 1 uses lowercase `/transcripts/`; Task 3 step checks `git check-ignore` *inside* the container.
5. **CRLF shell scripts in the container** (`/usr/bin/env: 'bash\r'`). Expected: `scripts/*.sh` runs in both places. → Task 1 `.gitattributes`; Task 4 runs the verify script inside the container.

---

## 1. Folder / file structure (only paths this plan touches)

```
pitwall/
├── .gitignore                       MODIFY  rewrite: secrets · Python · Node/extension · OS · private-local
├── .gitattributes                   CREATE  LF everywhere; CRLF only for *.ps1
├── LICENSE                          CREATE  MIT © 2026 Sharif Amlani
├── README.md                        CREATE  stub: what Pitwall is, setup (host + container); merged with Agntree's in Phase 1
├── CLAUDE.md                        CREATE  project rules: layout, never-track list, naming, credit
├── ROADMAP.md                       CREATE  phase table (Phases 0–5) + §0 banner + §6 changelog
├── .env.example                     CREATE  documented keys, empty values (tracked)
├── .env                             CREATE  local values (ignored — never committed)
├── pyproject.toml                   CREATE  Poetry project, py 3.13, python-dotenv, dev: pytest
├── poetry.toml                      CREATE  virtualenvs.in-project = true
├── poetry.lock                      CREATE  generated by `poetry lock`
├── .devcontainer/
│   ├── Dockerfile                   CREATE  python:3.13-bookworm + Node 22 + Poetry 2.3.4 + git, user `vscode`
│   └── devcontainer.json            CREATE  Cursor "Reopen in Container"; volumes + read-only ~/.claude mount
├── tools/
│   ├── __init__.py                  CREATE  makes `python -m tools.<x>` work
│   ├── _README.md                   CREATE  "Python dev tooling — not the extension"
│   ├── check_env.py                 CREATE  .env ↔ .env.example key-parity check (names only)
│   └── tests/
│       ├── __init__.py              CREATE
│       └── test_check_env.py        CREATE  6 tests incl. BOM/CRLF + never-print-values
├── scripts/
│   ├── verify-foundation.sh         CREATE  runs every foundation check; exit ≠ 0 on any failure
│   └── dropbox-ignore.ps1           CREATE  marks .venv/ and node_modules/ as Dropbox-ignored
└── docs/superpowers/plans/
    └── 2026-11-16-foundation.md     CREATE  this plan
```

## 2. Flowchart

```
                         +---------------------------+
                         |  Sharif / Claude session  |
                         +-------------+-------------+
                                       |
              +------------------------+-------------------------+
              | host (Windows, Git Bash)                         | container (Cursor "Reopen in Container")
              v                                                  v
   +----------------------+                       +------------------------------+
   | poetry install       |                       | docker build .devcontainer/  |
   |  -> .venv/ (Windows) |                       |  python 3.13 + node 22 +     |
   +----------+-----------+                       |  poetry 2.3.4                |
              |                                   +--------------+---------------+
              v                                                  |
   +----------------------+    reads    +--------------+         v
   | tools/check_env.py   |<------------| .env.example |   +-------------------------------+
   |  key names only      |<------------| .env (local) |   | poetry install -> ~/.cache venv|
   +----------+-----------+             +--------------+   | node_modules -> named volume   |
              |                                            | ~/.claude -> read-only mount   |
              v                                            +---------------+---------------+
   +----------------------------------------------------+                  |
   | scripts/verify-foundation.sh                        |<-----------------+
   |  ignore check -> eol check -> pytest -> check_env   |
   |  -> (host only) docker build + toolchain versions   |
   +-------------------------+--------------------------+
                             | all PASS
                             v
                 +-----------------------------+   leaks?  +--------------------+
                 | gitleaks scan (git history) |--- yes -->| STOP: purge, rescan |
                 +-------------+---------------+           +--------------------+
                               | "no leaks found"
                               v
                 +-----------------------------+
                 | gh repo create --public     |
                 |  --source . --push          |
                 +-------------+---------------+
                               v
                 +-----------------------------+
                 | fresh clone -> scratchpad   |
                 |  verify-foundation.sh = 0   |  <-- end-to-end proof
                 +-----------------------------+
```

## 3. Derisking

Smokes run in this order; do not start N+1's code until N passes.

**Smoke 1 — private folders stay out of git**
- What it proves: the rewritten `.gitignore` hides every never-track path on Windows.
- Command: `git add -A --dry-run | grep -cE '^add .(\.packages|transcripts|\.claude)/|^add .\.env.$'`
- Expected: `0`
- If it fails → fix the matching `.gitignore` line and re-run; nothing is committed until this is `0`.

**Smoke 2 — Poetry works on the host**
- What it proves: the Python toolchain installs and tests run.
- Command: `poetry install --no-interaction && poetry run pytest -q`
- Expected: last line `6 passed`
- If it fails → fix `pyproject.toml` / the failing test; check `poetry env info` points at `.\.venv`.

**Smoke 3 — the `.env` check catches a missing key**
- What it proves: `check_env` reads the real files and exits correctly.
- Command: `cp .env.example .env && poetry run python -m tools.check_env; echo "exit=$?"`
- Expected: `exit=0`; then delete one key from `.env`, re-run → `MISSING: <KEY>` and `exit=1`; restore it.
- If it fails → the parser or path defaults in `tools/check_env.py`.

**Smoke 4 — the container builds with the right toolchain**
- What it proves: the Dockerfile produces Node 22 + Python 3.13 + Poetry 2.3.4.
- Command: `docker build -t pitwall-dev -f .devcontainer/Dockerfile .devcontainer && docker run --rm pitwall-dev sh -c 'node -v; python --version; poetry --version'`
- Expected: `v22.` / `Python 3.13.` / `Poetry (version 2.3.4)`
- If it fails → check Docker Desktop is running (`docker info`); then the failing `RUN` line in the build log.

**Smoke 5 — the container does not clobber the host's venv**
- What it proves: Review Focus #3.
- Command: `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/workspace" -w /workspace -e POETRY_VIRTUALENVS_IN_PROJECT=false pitwall-dev sh -c 'git config --global --add safe.directory /workspace && poetry install -q && poetry run pytest -q && git check-ignore transcripts/inital_idea.md' && test -f .venv/Scripts/python.exe && poetry run pytest -q`
- Expected: `6 passed` (container), `transcripts/inital_idea.md` (ignored on Linux), then `6 passed` (host).
- If it fails → if `.venv/Scripts/python.exe` is gone, the env var override didn't apply: set it in the Dockerfile `ENV` too.

**Smoke 6 — `devcontainer.json` is valid and comes up**
- What it proves: the config Cursor will use (mounts, volumes, post-create) actually starts.
- Command: `npx -y @devcontainers/cli@0.72.0 up --workspace-folder . && npx -y @devcontainers/cli@0.72.0 exec --workspace-folder . bash scripts/verify-foundation.sh --skip-docker`
- Expected: `"outcome":"success"` then `FOUNDATION: ALL CHECKS PASSED`
- If it fails → read the `up` JSON error; the usual culprit is the `~/.claude` bind mount source path.

**Smoke 7 — no secrets in history before going public**
- What it proves: nothing private is in any commit.
- Command: `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo" zricethezav/gitleaks:v8.21.2 git /repo --no-banner`
- Expected: `no leaks found`
- If it fails → **STOP. Do not create the remote.** Identify the commit, rewrite history (`git filter-repo`), rescan.

**Smoke 8 — public repo exists and `main` is pushed**
- What it proves: GitHub remote + visibility.
- Command: `gh repo view sharifamlani/pitwall --json visibility,defaultBranchRef --jq '.visibility+" "+.defaultBranchRef.name' && git cherry -v @{upstream} | wc -l`
- Expected: `PUBLIC main` then `0`
- If it fails → `gh auth status`; re-run `git push -u origin main`.

**Smoke 9 — END-TO-END: fresh clone from GitHub works**
- What it proves: a stranger (or a fresh session) can clone and get a green foundation.
- Command: `cd "$SCRATCH" && gh repo clone sharifamlani/pitwall pitwall-e2e && cd pitwall-e2e && bash scripts/verify-foundation.sh`
- Expected: `FOUNDATION: ALL CHECKS PASSED`, exit 0
- If it fails → whatever check it names is relying on a local-only file; make the repo self-sufficient.

**Ground truth (after Smoke 9):** `gh api repos/sharifamlani/pitwall/git/trees/main?recursive=1 --jq '[.tree[].path | select(test("^(\\.packages|transcripts|\\.claude)/|^\\.env$"))] | length'` → `0`.

## 4. Evaluation criteria (definition of done)

Graded by an **independent evaluator sub-agent**, not the builder.

| # | Criterion | Metric + threshold | How measured | Evidence |
|---|---|---|---|---|
| E1 | Pitwall is a public GitHub repo with all work pushed | `PUBLIC main` and 0 unpushed commits | Smoke 8 command | command output in scorecard |
| E2 | Nothing private is on GitHub | gitleaks `no leaks found` on a fresh clone **and** 0 tracked paths under `.packages/`, `transcripts/`, `.claude/`, or `.env` | Smoke 7 against the fresh clone + ground-truth `gh api` query | both outputs |
| E3 | A fresh clone sets up on Windows with one command | `verify-foundation.sh` exit 0, prints `FOUNDATION: ALL CHECKS PASSED` | Smoke 9 | console tail |
| E4 | Container has the right toolchain | `v22.*`, `Python 3.13.*`, `Poetry (version 2.3.4)` | Smoke 4 | console output |
| E5 | Cursor's dev-container config comes up and passes inside | `"outcome":"success"` + verify script exit 0 inside | Smoke 6 | console output |
| E6 | Container use doesn't break the host | host `.venv/Scripts/python.exe` exists and host pytest `6 passed` after a container run | Smoke 5 | console output |
| E7 | Env check is safe and correct | 6/6 tests pass, incl. BOM/CRLF and never-print-values | `poetry run pytest tools/tests -v` | pytest output |
| E8 | Line endings won't break the container | 0 tracked text files stored with CRLF | `git ls-files --eol \| grep -c 'i/crlf'` → `0` | count |
| E9 | ROADMAP reflects reality | Phase 0 row `✅ <date> · <sha>`, §0 banner names Phase 1 as next, §6 has a 2026-11-16 entry, version stamp present | `grep` on `ROADMAP.md` | grep output |
| E10 | The release is tagged (added by Sharif 2026-11-16: "as we have new version releases … we're tagging those versions") | annotated tag `v0.1.0` exists on GitHub and points at the Phase 0 close commit | `git ls-remote --tags origin v0.1.0` + `git cat-file -t v0.1.0` → `tag` | command output |

## 5. Implementation tasks

### Task 1: Repo hygiene — `.gitignore`, `.gitattributes`, `LICENSE`

**Files:** Modify `.gitignore` · Create `.gitattributes`, `LICENSE`

- [ ] **Step 1:** Rewrite `.gitignore` with these sections, each with a one-line comment header. Drop every Job-Market-only entry (`Scripts/…`, LaTeX, Oracle HCM, `For-Girlfriend.zip`, `linkedin_probe.png`, `gcp_service-account-key.json`).
  - *Secrets:* `.env`, `.env.*`, `!.env.example`
  - *Python:* `__pycache__/`, `*.py[cod]`, `.venv/`, `.pytest_cache/`, `*.egg-info/`
  - *Node / extension (matches Agntree's ignores so Phase 1 merges cleanly):* `node_modules/`, `out/`, `dist/`, `*.vsix`, `.vscode-test/`, `test/dry/.build/`, `_site/`
  - *OS:* `.DS_Store`, `Thumbs.db`, `desktop.ini`
  - *Private, local-only — never public:* `/transcripts/`, `/Transcripts/`, `/.packages/` (comment: "may hold local credentials"), `/.claude/`, `.playwright-mcp/`
  - Do **not** ignore `.vscode/` (Agntree tracks its debug launch config).
- [ ] **Step 2:** Create `.gitattributes`: `* text=auto eol=lf`, `*.ps1 text eol=crlf`, `*.png binary`, `*.ico binary`.
- [ ] **Step 3:** Create `LICENSE` — standard MIT text, `Copyright (c) 2026 Sharif Amlani`.
- [ ] **Step 4:** Run Smoke 1. Expected `0`. Then `git add --renormalize . && git ls-files --eol | grep -c 'i/crlf'` → `0`.
- [ ] **Step 5:** Commit: `git add .gitignore .gitattributes LICENSE && git commit -m "repo: rewrite .gitignore for Pitwall, add .gitattributes + MIT license"`

### Task 2: Poetry + `.env` + `tools/check_env.py`

**Files:** Create `pyproject.toml`, `poetry.toml`, `poetry.lock`, `.env.example`, `.env` (ignored), `tools/__init__.py`, `tools/_README.md`, `tools/check_env.py`, `tools/tests/__init__.py`, `tools/tests/test_check_env.py`, `scripts/dropbox-ignore.ps1`

**Interfaces — Produces:**
- `tools.check_env.missing_keys(example_path: Path, env_path: Path) -> list[str]` — keys present in example but absent from env, in example-file order. Empty values count as present.
- `tools.check_env.main(argv: list[str] | None = None) -> int` — flags `--example` (default `.env.example`), `--env` (default `.env`). Exit `0` all present (prints `OK: <n> keys present`), `1` missing (prints one `MISSING: <KEY>` line per key to stderr), `2` env file not found (stderr includes `cp .env.example .env`).
- `python -m tools.check_env` calls `sys.exit(main())`.

- [ ] **Step 1:** Create `pyproject.toml` in the same shape as `audio-to-transcript/pyproject.toml`: `name = "pitwall-tools"`, `version = "0.1.0"`, `description = "Dev tooling for Pitwall"`, author Sharif Amlani / sharifocc@gmail.com, `requires-python = ">=3.13,<3.14"`, dependencies `python-dotenv (>=1.0.1)`; `[tool.poetry] package-mode = false`; `[tool.poetry.group.dev.dependencies] pytest = ">=8.3"`; `[tool.pytest.ini_options] testpaths = ["tools/tests"]`, `pythonpath = ["."]`. Create `poetry.toml` with `[virtualenvs] in-project = true`.
- [ ] **Step 2:** Run `poetry lock && poetry install --no-interaction`. Expected: `.venv/` created in the repo.
- [ ] **Step 3:** Create `scripts/dropbox-ignore.ps1` — takes `-Paths` (default `.venv`, `node_modules`), creates any missing folder, sets `Set-Content -Path <p> -Stream com.dropbox.ignored -Value 1`, prints one line per path, exits non-zero on failure. Run it. Verify: `Get-Content .venv -Stream com.dropbox.ignored` → `1`.
- [ ] **Step 4:** Create `.env.example` — every key with a comment line above, empty value:
  - `PITWALL_CLAUDE_HOME=` — "Where Claude Code stores session files. Windows: C:\Users\<you>\.claude. Container: /home/vscode/.claude-host"
  - `OVSX_PAT=` — "Open VSX token, for publishing where Cursor installs extensions from (Phase 5; leave empty until then)"
  - `VSCE_PAT=` — "VS Code Marketplace token (optional, Phase 5)"
  Copy to `.env` and fill `PITWALL_CLAUDE_HOME=C:\Users\Shari\.claude`.
- [ ] **Step 5: Write the failing tests** in `tools/tests/test_check_env.py` (use `tmp_path` fixtures to write files):
  - `test_all_keys_present_returns_empty` — example `A=\nB=\n`, env `A=1\nB=\n` → `missing_keys(...) == []`
  - `test_missing_key_reported_by_name` — env lacks `B` → `== ["B"]`
  - `test_comments_blank_lines_and_export_prefix_ignored` — example has `# note`, blank line, `export A=` → env `A=x` → `[]`
  - `test_bom_and_crlf_env_file_parses` — env bytes `b"\xef\xbb\xbfA=1\r\nB=2\r\n"` → `[]`
  - `test_main_never_prints_values` — env `A=sk-SECRET-123`, example `A=\nB=\n`; `main([...]) == 1`; `"sk-SECRET-123" not in out + err`; `"MISSING: B" in err`
  - `test_main_missing_env_file_exits_2_with_hint` — `main(["--env", str(tmp_path/"nope")]) == 2`; `"cp .env.example .env" in err`
- [ ] **Step 6:** `poetry run pytest -q` → FAIL (`ModuleNotFoundError: tools.check_env`).
- [ ] **Step 7:** Implement `tools/check_env.py` with the signatures above. Parse both files with `dotenv.dotenv_values(path, encoding="utf-8-sig")` (handles comments, quotes, `export`, CRLF; `utf-8-sig` strips the BOM). `argparse` for flags. Never print a value.
- [ ] **Step 8:** `poetry run pytest -q` → `6 passed`. Run Smoke 3.
- [ ] **Step 9:** Create `tools/_README.md` (3–5 lines: Python dev tooling for Pitwall; the extension is TypeScript at the repo root; run with `poetry run python -m tools.<name>`).
- [ ] **Step 10:** Commit: `git add pyproject.toml poetry.toml poetry.lock .env.example tools scripts/dropbox-ignore.ps1 && git commit -m "tooling: Poetry project, .env.example, env parity check"`

### Task 3: Dev container

**Files:** Create `.devcontainer/Dockerfile`, `.devcontainer/devcontainer.json`

- [ ] **Step 1:** `.devcontainer/Dockerfile`, decisions pinned:
  - Stage `FROM node:22-bookworm AS node`; final `FROM python:3.13-bookworm`.
  - `COPY --from=node` `/usr/local/bin/node` and `/usr/local/lib/node_modules`; symlink `npm` → `../lib/node_modules/npm/bin/npm-cli.js`, `npx` → `npx-cli.js` in `/usr/local/bin`.
  - `apt-get install -y --no-install-recommends git` then clean lists.
  - `pip install --no-cache-dir poetry==2.3.4`.
  - `ENV POETRY_VIRTUALENVS_IN_PROJECT=false` (keeps the Linux venv out of the shared folder — Review Focus #3).
  - `useradd -m -s /bin/bash vscode`, `USER vscode`.
- [ ] **Step 2:** Run Smoke 4.
- [ ] **Step 3:** `.devcontainer/devcontainer.json`:
  - `"name": "pitwall"`, `"build": {"dockerfile": "Dockerfile"}`, `"remoteUser": "vscode"`
  - `"mounts"`: `source=pitwall-node_modules,target=${containerWorkspaceFolder}/node_modules,type=volume` and `source=${localEnv:USERPROFILE}/.claude,target=/home/vscode/.claude-host,type=bind,readonly`
  - `"containerEnv": {"PITWALL_CLAUDE_HOME": "/home/vscode/.claude-host"}`
  - `"postCreateCommand": "git config --global --add safe.directory ${containerWorkspaceFolder} && poetry install --no-interaction"`
  - `"customizations.vscode.extensions": ["ms-python.python", "dbaeumer.vscode-eslint"]`
- [ ] **Step 4:** Run Smoke 5 (host venv survives; `transcripts/` ignored on Linux).
- [ ] **Step 5:** Commit: `git add .devcontainer && git commit -m "container: dev container with Python 3.13, Node 22, Poetry 2.3.4"`

### Task 4: Verify script + project docs

**Files:** Create `scripts/verify-foundation.sh`, `README.md`, `CLAUDE.md`, `ROADMAP.md`

- [ ] **Step 1:** `scripts/verify-foundation.sh` (`#!/usr/bin/env bash`, `set -euo pipefail`). Flag `--skip-docker`. Each check prints `PASS <name>` or `FAIL <name>: <why>` and the script exits 1 on the first FAIL:
  1. `ignore` — `git ls-files` has 0 paths under `.packages/`, `transcripts/`, `.claude/`, and no `.env`
  2. `eol` — `git ls-files --eol | grep -c 'i/crlf'` is 0
  3. `poetry` — `poetry install --no-interaction -q` then `poetry run pytest -q`
  4. `env` — if `.env` missing, `cp .env.example .env` (prints that it did); then `poetry run python -m tools.check_env`
  5. `docker` (skipped with `--skip-docker` or when `/.dockerenv` exists) — Smoke 4's build + version checks
  - Final line: `FOUNDATION: ALL CHECKS PASSED`
- [ ] **Step 2:** Run on host: `bash scripts/verify-foundation.sh` → final line as above, exit 0. Then run Smoke 6 (runs it inside the dev container too — Review Focus #5).
- [ ] **Step 3:** `README.md` — tagline, one paragraph on what Pitwall is, "forked from Agntree (coming in Phase 1)", Setup: host (`poetry install`, `cp .env.example .env`, `bash scripts/verify-foundation.sh`) and container (Cursor → *Dev Containers: Reopen in Container*). Note: the container is for building and testing; the extension itself runs in Windows Cursor, because the Claude Code extension, hooks, and pop-ups live on the host.
- [ ] **Step 4:** `CLAUDE.md` — layout (extension = TS/npm at root from Phase 1; Python = `tools/` only), the never-track list with the reason for each, naming rule (no "Claude" in the name), MIT credit rule for Agntree, "run `scripts/verify-foundation.sh` before every push".
- [ ] **Step 5:** `ROADMAP.md` — invoke the `writing-roadmaps` skill; flat phase table with the 6 phases from the tracker above, §0 "You are here" banner, §6 changelog, `v0.1` stamp.
- [ ] **Step 6:** Commit: `git add scripts/verify-foundation.sh README.md CLAUDE.md ROADMAP.md docs && git commit -m "docs: README, CLAUDE.md, ROADMAP, foundation verify script"`

### Task 5: Secret scan → publish → end-to-end

**Files:** Modify `ROADMAP.md`

- [ ] **Step 1:** Run Smoke 7. **If anything other than `no leaks found`, stop here.**
- [ ] **Step 2:** `gh repo create sharifamlani/pitwall --public --source . --remote origin --push --description "Pitwall: every Claude Code session across your repos, in one sidebar."` then `gh repo edit sharifamlani/pitwall --add-topic vscode-extension,cursor,claude-code,developer-tools`.
- [ ] **Step 3:** Run Smoke 8.
- [ ] **Step 4:** Run Smoke 9 in the scratchpad, then the ground-truth `gh api` query.
- [ ] **Step 5:** Flip ROADMAP Phase 0 to `✅ 2026-11-16 · <sha>`, refresh §0 (next: Phase 1 Import Agntree), add §6 entry, bump to `v0.2`. Commit `roadmap: Phase 0 foundation complete` and push.
- [ ] **Step 5b:** `git tag -a v0.1.0 -m "Phase 0: foundation" && git push origin v0.1.0` (Sharif 2026-11-16: every version bump gets a tag).
- [ ] **Step 6:** Dispatch an independent evaluator sub-agent with §4's table only; it grades E1–E9 and returns the scorecard. Fix any FAIL and re-grade until all PASS.

## 6. Scorecard (filled at close by the evaluator)

| Criterion | Threshold | Result | Evidence | PASS/FAIL |
|---|---|---|---|---|
| E1 … E10 | | | | |

## Out of scope (next plans)

- Importing Agntree's code (Phase 1) — merge with history via an `upstream` remote so later Agntree fixes can be pulled in.
- `npm` setup, extension build, `.vsix` packaging — they arrive with Agntree's `package.json` in Phase 1.
- CI (GitHub Actions) — once there is extension code to build.
