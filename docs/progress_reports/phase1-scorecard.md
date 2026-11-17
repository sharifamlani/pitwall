# Phase 1 scorecard (independent evaluator, fresh clone @ d5b54ba)

| Criterion | Threshold | Result | Evidence | PASS/FAIL |
|---|---|---|---|---|
| E1 history + credit | 47124cd ancestor of main; LICENSE both lines; README credit+link | Ancestor yes; LICENSE lines 3 (2025 Subhash Khileri) and 4 (2026 Sharif Amlani); README line 44 "Forked from [Agntree](https://github.com/subhashkhileri/agntree) by Subhash Khileri (MIT), at 47124cd" | `git merge-base --is-ancestor 47124cd HEAD` -> ANCESTOR_OK; `grep -i copyright LICENSE` | PASS |
| E2 Linux suite | all pass except allowed flaky | 192 tests, 192 pass, 0 fail, 0 skipped | `bash scripts/run-linux-tests.sh` -> `ℹ tests 192 / ℹ pass 192 / ℹ fail 0` | PASS |
| E3 core agent-agnostic | architecture tests pass | Both pass (Windows and Linux runs) | `✔ core never imports from a harness folder`; `✔ extension.ts reaches harnesses only through harnesses/index` | PASS |
| E4 one switch | claude,codex yields Codex commands+settings; ["claude"] none; dormant tests run+pass | `--enabled claude,codex`: 4 codex commands, 1 codex setting (36 codex mentions); `claude`: 0. `--check` exit 0. Dormant codex/opencode/pi tests run and pass in the 192/192 Linux run; `✔ enabling Codex is one switch` | `node scripts/build-manifest.mjs --enabled claude,codex --out $TEMP/pk2.json` then count | PASS |
| E5 Claude-only ship | 0 codex/opencode/pi in contributes | codex 0, opencode 0, pi 0 (version 0.2.0) | `node -e` scan of `JSON.stringify(package.json.contributes)` -> `codex 0 opencode 0 pi 0` | PASS |
| E6 renamed | 0 agntree hits in src test manifest package.json | 0 | `git grep -ni agntree -- src test manifest package.json \| wc -l` -> 0 | PASS |
| E7 registry safety | registry-safety test passes | Linux suite 192/192 green (includes registry-safety); Windows run: no registry-safety failure among the 12 failures | `bash scripts/run-linux-tests.sh` | PASS |
| E8 real editor | part 1: integration exit 0 on Windows host; part 2: Cursor exthost evidence | Part 1: exit 0, 0 FAIL lines, "ALL ACTIVATION CHECKS PASSED", "disabled harnesses (opencode, codex, pi) contribute no command or setting". Part 2: pending: testing agent's final walk on d5b54ba | `env -u ELECTRON_RUN_AS_NODE -u VSCODE_ESM_ENTRYPOINT -u VSCODE_CRASH_REPORTER_PROCESS_TYPE npm run test:integration` -> `Exit code: 0` | PASS (part 1); part 2 pending |
| E9 Windows triage | triage rows = Windows fail + skipped | Windows run: 192 tests, 163 pass, 12 fail, 17 skipped = 29. docs/windows-test-triage.md has 29 numbered rows, every failing/skipped test name found in it, each classed env-limit / POSIX-assumption / real-bug | `npm test` -> `ℹ fail 12 / ℹ skipped 17`; name-by-name grep against the file: 0 missing | PASS |
| E10 verify + CI | verify.sh exit 0 on host; ci.yml green both jobs on closing commit | verify.sh: first run failed once on allowed-flaky "the opencode snapshot stops at its byte budget and says so" (linux-tests step); immediate rerun exit 0, all 8 checks PASS (eol poetry ignore env docker npm vsix linux-tests). CI push run 44015475360 on head d5b54ba: windows success, ubuntu success | `bash scripts/verify.sh` (rerun) exit 0; `gh run view 44015475360 --json headSha,jobs` -> d5b54ba..., windows success, ubuntu success | PASS |
| E11 privacy | check_private_paths OK; gitleaks clean; only .claude/skills/pitwall-*/ tracked | check_private_paths "OK: no private paths tracked (275 files checked)"; gitleaks 169 commits "no leaks found"; `git ls-files .claude` = 4 files, all under skills/pitwall-*; non-matching = 0. R17: .gitleaksignore has exactly 1 fingerprint (`69b7265...:site/pages.mjs:generic-api-key:34`); `git show 69b7265:site/pages.mjs` line 34 is `indexNowKey: '8958e9546b0eaa97b52be21feae12273'`, the upstream IndexNow key, public by design | gitleaks v8.21.2 docker command; `poetry run python -m tools.check_private_paths` | PASS |
| E12 ROADMAP + tag | - | N/A - post-scorecard | - | N/A |

## FAILs
None.

## Notes
- Allowed-flaky test hit once in verify.sh's Linux step; it passed on the immediate rerun (rule satisfied).
- E8 part 2 (Cursor exthost activation of `sharifamlani.pitwall`, 0 errors) is not measured here per R4; the controller must add it before E8 is fully closed.
- Windows: 12 failures are triaged and deferred to Phase 2 (not a Phase 1 criterion).


## E8 part 2 (added by the controller from the testing agent's final walk, UJ run 6 on d5b54ba)
Test Cursor (separate profile), fresh storage: exthost "Extension activated success: sharifamlani.pitwall — 238ms", 0 [error] lines at install/activation, 0 pitwall error/fail lines. Smoke 7 ground truth (R11): auto path 1 row at t+42 s; manual path 0 rows for ~160 s, then import → exactly 1 row "Lab ready". Claude-only menus/palette/settings confirmed; honest README on the details page. Sharif's Cursor: sharifamlani.pitwall@0.2.0 installed, not reloaded (R4). **E8: PASS.**
