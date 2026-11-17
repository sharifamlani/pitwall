# Autonomous build handoff (started 2026-11-16)

Sharif said go on 2026-11-16: build ROADMAP Phases 1→6 autonomously with the team flow in D39. The build agents open PRs; QA (pitwall-cd) approves an exact commit; the lead merges it; testing (pitwall-62) walks the real extension; marketing (pitwall-e8) drafts a LinkedIn + X post per phase, which goes live after Sharif approves via the lead.

## Phase tracker
```
PITWALL — phase plan
─────────────────────────────────
Phase 1 : Import Agntree            [████████████████████] ✅ v0.2.0
Phase 2 : Windows parity            [⏳..................] in progress
Phase 3 : Sidebar v1
Phase 4 : Windows and tabs
Phase 5 : Status + pop-ups
Phase 6 : Package + launch (v1.0.0)
```

## Results per phase
### Phase 1 — closed 2026-11-16, tag `v0.2.0`
- 6 PRs (#1–#6), each QA-approved at an exact commit, ≤1 fix round each. Merges: ea78755, efa93e6, f94f66f, 85d14d7, 5caa2cb, d5b54ba; close commit 54e4b4a.
- Independent evaluator: E1–E11 PASS on a fresh clone (`phase1-scorecard.md`); E8 part 2 from the testing agent's walk.
- Testing agent: 6 live walks in a separate Cursor profile; final walk PASS 14/14; Sharif's Cursor never reloaded.
- Final whole-branch review (most capable model): 0 Critical / 4 Important / 9 Minor (`phase1-final-review.md`); I1 fixed (local upstream tags removed), I2–I4 → Phase 2.
- Posts live: kickoff, Phase 1, repo link (LinkedIn + X).

## Bugs found and fixed / open
Fixed in Phase 1 (caught by QA): privacy allowlist exempted whole skill folders; verify.sh cp1252 bytes; dead homepage link; packaging could ship transcripts/.packages/public from the real checkout.
Open → Phase 2: likely Windows worktree-path bug (triage rows 9–12); restored-terminal orphan after restart (2.6); quit/restore with a live chat (2.11); 3 flaky timing tests (2.7); manifest duplicate-id checks (2.8); package.json files allowlist (2.9); CI privacy gate (2.10).

## Decisions made autonomously (Phase 1 rulings, each with its cost if wrong)
- Ruling R1: T1 adds a `credit-allow` marker (HTML comment in README/CHANGELOG, trailing comment-free form in LICENSE handled by skip-list) to every credit line — T3's script depends on it — cost if wrong: a credit line gets renamed, caught by E1/E6.
- Ruling R2: triage doc paths are "as of upstream 47124cd" (stated in its header); Phase 2 maps them — cost: none.
- Ruling R3: T1 deletes site/ and media/ only if no test/code references them (grep first); otherwise keep — cost: a few extra files.
- Ruling R4: Smoke 7 in Sharif's Cursor = install + `cursor --list-extensions --show-versions` only, no reload. Activation/exthost log/screenshot/ground-truth (0 rows, then 1 imported row) are done by the testing agent (pitwall-62) in its separate Cursor profile; E8 evidence comes from there — cost: none (same checks, isolated profile).
- Ruling R5: the external QA agent pitwall-cd IS the per-task reviewer (spec + quality; it re-runs smokes on the PR head merged with main) — replaces the in-session task-reviewer seat to avoid paying twice; the whole-branch final review (most capable model) still runs at Phase 1 close — cost if wrong: a style issue QA doesn't weigh; final review is the net.
- Ruling R6: build worktree at C:\Users\Shari\pitwall-build (outside Dropbox: node_modules + Dropbox sync conflicts); one branch per task phase1/task-N-<slug> off origin/main; one PR per task; I merge the QA-approved sha with `gh pr merge --merge --match-head-commit <sha>` — cost: none.
- Task 1: Ruling R7: accept deleting site/, media/ and the 2 site-only tests (upstream marketing site; its build test breaks on any Pitwall doc) — new suite baseline = 182 tests; Smokes 3/4 compare against the Task-1 count, the only allowed failure stays the named opencode test — cost if wrong: 2 tests of a site we never ship.
- Task 1: Ruling R8: upstream docs stay in place (docs/reference etc.), no move to docs/upstream/ — moving needs test path edits for zero user value; Task 3 marks them "inherited from Agntree" — cost: tree diagram slightly off.
- Task 3: Ruling R9: pre-existing Linux flake "the opencode snapshot stops at its byte budget and says so" (fails 7/60 on main ad417a2) is graded by the existing rerun rule (rerun once; a repeat failure = FAIL); added to Phase 2 scope (de-flake opencode snapshot timing tests) — cost if wrong: an evaluator run needs one rerun.
- Task 3: Ruling R10: package.json `author` stays upstream's for Phase 1 (credit, lift-and-shift); Phase 6 packaging sets author/contributors properly — cost: metadata only.
- Ruling R11: Smoke 7 ground truth = auto path (1 row within ~2 min with defaults) + manual path (autoImport=false: 0 rows 150 s, then import → 1 row) — upstream auto-import defaults on — cost: none.
- Task 4: Ruling R12: enabled.json/ALL_HARNESSES order = upstream (claude, opencode, codex, pi), not the plan's listed order — Task 4 is behaviour-identical — cost: none. Pre-review fix sent to implementer.
- Task 4: Ruling R13: JS fixtures stay in test/dry/fixtures (run.js bundles to .build; paths still resolve) — cost: tree diagram slightly off.
- Task 5: Ruling R14: newChat alias uses the registry's first adapter instead of enabledHarnesses()[0] — core may not import harnesses (E3) and the registry is built in enabled.json order, so same result — cost: none.
- Task 5: Ruling R15: HarnessId stays a plain string (branding breaks Record<HarnessId,…> test maps) — validity enforced by registry membership — cost: weaker compile-time check.
- Task 5: Ruling R16: accept merge-rule extensions (settings sections merge by title; harness fragments supply enum labels) and the reworded welcome/3 setting descriptions (wireframe AFTER + E5 "names none") — cost: none.
- Task 6: Ruling R17: gitleaks finding = upstream indexNowKey in deleted site/pages.mjs (history, 69b7265), public by design → documented .gitleaksignore exception with comment, excluded from .vsix; E11 then measured on a fresh clone with the ignore file — cost if wrong: one public-by-design key allow-listed.
- Final: Ruling R18: I2 (build-manifest has no duplicate-id checks), I3 (package.json `files` allowlist so a bare vsce package can't ship .env*/keys; must land before first public .vsix), I4 (CI runs privacy gate + gitleaks + vsix allowlist) → new ROADMAP Phase 2 rows 2.8–2.10; nothing downstream in Phase 1 builds on them — cost if wrong: Phase 2 picks them up.
- Final: Ruling R19: ROADMAP 2.5 (Find Session off-enum) appears already fixed in code per reviewer → Phase 2 turns it into a regression test and closes it — cost: none.

## Risks and recommendations
_(filled in)_

## RESUME HERE (lead session state, updated at each phase close)
- Phase 1 closed: tag `v0.2.0` (54e4b4a). All 12 criteria PASS (independent evaluator). Phase 2 = Windows parity, ROADMAP rows 2.1–2.12.
- Team (ROADMAP D39): QA = pitwall-cd (APPROVE <sha> / CHANGES; one PR per task; branch phaseN/task-M-<slug>; lead merges only the approved sha against the graded main, with `gh pr merge N -R sharifamlani/pitwall --merge --match-head-commit <sha>`). Testing = pitwall-62 (separate Cursor profile; message it each merged commit with entry point, scenarios, not-done list). Marketing = pitwall-e8 (drafts → lead → Sharif's approval → posts live on LinkedIn + X; phase-close handoff = tag + scorecard).
- Build worktree: C:\Users\Shari\pitwall-build (outside Dropbox). Never reload Sharif's Cursor windows (Pitwall 0.2.0 is installed there, not reloaded).
- Next: write the Phase 2 plan (docs/superpowers/plans/), with tree, flowchart, derisking and criteria; QA pre-flight; then build task by task.
