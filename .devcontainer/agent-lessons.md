# Agent lessons

The learning loop's memory (see `AGENT_ROLES.md`). Each role reads its list before every job.
The Auditor owns this file: it reads the agents' work and messages, adds the rule when something
went wrong, and adds a `Keep:` line when something went well. One line per lesson: the rule, then
the bug, PR or moment it came from. Remove a rule once a test or check enforces it.

## Main (Main reads before each brief, merge and handoff)

- Compare every limit, workaround and decision with the original design artifact. If it means the
  product won't do what that design promises, tell the owner at once in one plain sentence, before
  more work; never only a ROADMAP decision or a parked row. (Pitwall D35/D36, 11-16: the Claude Code
  panel runs only the open folder's sessions, so Sharif still has to switch windows to type. Row 7.4
  was parked and he found out on 11-20.)
- Send QA the sha and the Tester the build in the same minute; a serial QA-then-walk queue made each
  stage wait on the other. (Pitwall Phase 5: QA latency was the biggest wait, per Sharif 11-20.)
- Before a long walk, tell the owner the window and ask them to keep off the test machine's keyboard,
  or run it when they're away. (Pitwall RC2 walk, paused 00:34 UTC 11-21: the owner's keys landed in
  the test window's terminal.)
- Never brief a builder to run CPU-load tests while a walk is open; read the Tester's walk line
  first. (Pitwall #85: 16, then 64 busy-loop processes ran into the v0.6.0 RC walk, and its soak, CPU
  trace and speed trials were re-taken.)
- Never install a build into the owner's own app while agent chats run in it, even at their request;
  installing restarted the extension host and cut off the QA, Tester and Marketing chats. Use a
  separate profile, or let the owner install at a quiet moment. (Pitwall 0.6.0 real-profile check.)
- Never substitute a stand-in reviewer for the QA agent. If QA is disconnected, wake it or ask the
  owner. (Pitwall 2026-11-19: #70–#72 went to stand-in reviewers; the owner then ruled QA reviews
  every PR, 1a28f36.)
- A walk brief uses every default the owner has. Never turn a feature off to make the walk easier;
  if one must be off, walk with it on as well. (Pitwall 0.6.0: the walk ran with discovery off and
  hid 5–8 s pop-up lag; with it on, lag was 6.5–8.4 s against a ~5 s bar.)
- Instrument before you attribute. A route line with no trigger source can't settle what caused an
  open; add the trigger to the log first, then name the cause. (Pitwall 2026-11-20: the 11-19
  "spurious opens" were blamed on the owner's dictation without evidence.)
- Ask the owner for post pre-approval when the RC walk starts, so the tag never waits on them.
  (Sharif, 2026-11-20: the release tag is Marketing's automatic GO for pre-approved posts.)
- Write the merge-with-a-failed-gate decision down before it happens: a regression blocks the merge;
  a pre-existing failure needs main's matching run, an owner and a blocked tag. (Pitwall #78/#79
  merged with the gate at 5/6 before the rule existed; rule 453d30a.)
- Keep: merge with `--match-head-commit <approved sha>`, so the merged commit is the one QA approved.
  (Pitwall #70–#86: approved and merged shas matched.)
- Keep: a written list of tag conditions, checked one by one, held the v0.6.0 tag until each was
  met. (Pitwall 2026-11-20.)

## Build (builders read before building)

- If a limit or workaround means the product won't do what the original design promises, stop and
  tell Main in one plain sentence before building around it. (Pitwall D35/D36: the panel's
  one-folder limit was built around for four days without the owner being told.)
- Run the Review list on your own diff and break your own guards before opening the PR; each
  extra QA round costs a review and a re-walk. (Pitwall #73 took four rounds, #75 three.)
- When a CI assertion fails, find which line fails and what dropped the value before fixing. A
  plausible race that never failed is not the cause. (Pitwall #85: round 1 fixed a race QA showed
  wasn't the failure; the real cause was the transcript's file time running ahead of `Date.now()`
  on Windows.)
- A test that sleeps a fixed time for background work started by an event is a guess about machine
  speed. Wait on the observable result, bounded, with the elapsed time in the failure message.
  (Pitwall #84: the poll-stall test went 13/30 → 30/30 under load. Five flaky-test fixes in one
  release: #77, #83, #84, #85 and the #79 race.)
- In a test, take a time boundary from the stamp the code under test recorded, never from a clock
  read made just before the call. Two `Date.now()` reads can fall in different milliseconds, and a
  `>=` at the boundary then flips. (Pitwall #77: tab-adoption.test.ts:313 failed on main CI.)
- A test on mocked timers that also waits on real I/O must hold the mocked clock while that I/O is in
  flight; moving the clock at a fixed rate charges machine load to the code's timers. (Pitwall #83:
  first-scan tests went 1/30 → 30/30 under load.)
- Run load tests only when Main says no walk is open, and kill every process you start in a
  `finally`. (Pitwall #85: 64 busy-loop processes were orphaned during the RC walk.)
- Don't stack a PR on another. When a base is dropped, rebuild on main by re-homing each hook it
  borrowed, not by carrying the base along, then grep for the dropped PR's names. (Pitwall #82,
  rebuilt on main without #80.)
- Startup work that waits for a view or panel to appear also needs a timeout fallback for when it
  never appears. (Pitwall #70: no status or pop-ups while the sidebar stayed hidden.)
- Show and match names from the same source the user sees, such as the user's own rename before
  any generated title. (Pitwall #71: tab "Main" vs stored "Pitwall initial idea".)
- Never remove a safety guard because a case "can only happen when…"; keep it and test the
  counterexample. (Pitwall #71: #68 dropped the guard and a live chat was forked.)
- A guard on one entry point protects none of the others: put it in one shared function and call
  it from every command, menu item and fallback that can start a process, with a test for each.
  (Pitwall QA on #71: Open in Terminal / Open in Claude UI bypassed the router's guard and forked.)
- Remove each builder worktree as soon as its PR merges, and watch the package cache (`npm ci` in
  many worktrees grew npm's cache to ~16 GB and filled the disk mid-walk). (Pitwall 2026-11-19.)
- A tree row's click must not depend on a command with arguments (the editor caches them and drops
  them on every refresh), and a redraw fires only for rows whose text changed, never the whole tree
  on a timer. (Pitwall #74; 0.6.0 RC: "Actual command not found … pitwall.openChat /4105", dropped clicks.)
- Code that waits for the editor to ask for rows again must handle the rows it never asks for (a
  collapsed parent): clear the wait on the collapse event and cap it with a timeout. (Pitwall #74: a
  repo collapsed after expanding held every reveal until it was expanded again.)
- Never spend a one-shot trigger ("ask once", "scan once") before the data it looks for can exist:
  retry with backoff until it succeeds, bounded per cycle, and test the "too early" first try.
  (Pitwall #73: the one ask came before the transcript existed, so a hidden window never listed the chat.)
- A guess that "this unnamed surface is that chat" must pick exactly one chat: one that can be in that
  kind of surface (a terminal process is never in a panel tab; unknown counts as no), with no other
  surface, started after the surface appeared, the only one that fits, and only for a bounded time.
  Test it against a chat started outside the product. (Pitwall #73 rounds 2–3: an unbound tab silenced
  same-folder chats, then an outside-terminal `claude`.)
- A judgement that holds a pop-up back must leave the same trace for other windows as one that shows
  it: take the shared lock, and publish every "in front" the local check can see (here, a new chat's
  unbound tab), not only the bound ones. (Pitwall #86: RC2 walk item 1 FAIL.)
- Size a performance repro from the owner's real data, not test-sized fixtures, and never let a reader
  wait for an entry the writer may not write. (Pitwall #76: current Claude writes no `turn_duration`, so
  the tail reader read 1.7 GB of live transcripts whole; a 48 MB fixture showed 0.5 s, the owner's sizes
  showed 15–24 s.)
- "A tab exists" isn't "the process is alive": check the process itself (the harness's record or the
  terminal's own process tree) before treating a terminal as the running chat, and never stop a process
  through a terminal whose process already exited (its old pid may be someone else's). (Pitwall #75: a
  pop-up landed on a dead shell; quitting killed an outside chat on the same session.)
- A shell whose agent exited is the user's: forget it, never close it (they may run anything in it after
  /exit), and decide "exited" by the process, not the session id (/clear keeps the same pid under a new
  id). (Pitwall #75 QA: the release closed live shells and read /clear as exited.)
- Before cutting a latency, log or measure each stage between the trigger and the user seeing it,
  including process start-up. (Pitwall #78: the pop-up's 1 s was a fresh PowerShell per toast; the
  status path was already 0.2 s.)
- Before building a fix for "X waits behind Y", A/B the suspected mechanism at real scale. A poll-
  priority gate for file threads changed nothing (72–82 vs 67–80 ms), so the PR ships per-step timing
  instead. (Pitwall #81, round 1.)
- A job that fans out file reads (one per repo) must cap how many run at once. libuv has four file
  threads, and every small read queues behind them, the status poll's too. (Pitwall #78: discovery
  passes of 31–98 s were mostly waiting.)
- A host-lag clock must record how late each tick itself fired, not only how old the last tick is.
  A stall inside a timer callback makes the event loop fire the overdue tick before the queued
  input, so the tick reads 0 ms old at the moment that matters. (Pitwall #82: QA's host-lag blind
  spot.)
- Never await a child process inside a status poll; serve its last answer (even stale) and refresh it in
  the background. With no answer at all, report "unknown", never "no change". Also test the moment when a
  starting process's record exists but its status isn't written yet. (Pitwall #79: `claude agents --json`
  held both windows' polls 2.7–5.3 s on every resume; treating "no answer" as "no wait" blanked waits.)
- A resume point is safe only if its check covers the bytes right before where it resumes. A check
  allowed to lag even one chunk leaves bytes no one verifies. Keep "check ends at offset" as the
  invariant, and drop the resume point when it doesn't hold. (Pitwall #81.)
- A byte pattern that stands in for a JSON key must include what only a key has, the closing quote and
  its colon (`"key":`), or a string value spelling the key matches too. And an equivalence fixture must
  carry every field real lines carry (here `entrypoint`), or the fast path it tests never runs.
  (Pitwall #78: QA on #78.)
- `npm run test:dry` deletes `test/dry/.build`. Never keep a backup or scratch file there across a
  test run. (Pitwall #78.)
- Keep: builders put their lesson line in the PR body under "Lesson:", not in this file. The
  Auditor adds it to main after the merge, so PRs don't conflict on this file. (Pitwall #73, #74,
  #75: three PRs each edited this file and conflicted; #73 sat about 20 minutes with no CI.)

## Review (QA reads before reviewing)

- When a diff works around a limit, ask whether the product still does what the original design
  promises; if not, put the red flag in the verdict's first line. (Pitwall D35/D36.)
- Put every finding in one verdict; a finding held back for the next round costs a fix round and a
  re-walk. (Pitwall #73 took four rounds, #75 three.)
- Mark every claim the diff can't prove (timing, pop-ups, OS behavior, process counts) "for the
  Tester" in the verdict, so it is walked before the merge. (Pitwall Phase 5: about six bugs passed
  review and were found only in the running app.)
- For a fix, confirm that the failing line and the cause match the CI log or the repro; block a fix
  for a cause that never failed. (Pitwall #85 round 1.)
- For any guard or branch the diff removes, write the counterexample to the author's "can only"
  claim, and block if one exists. (Pitwall #68 round 2 → fork in #71.)
- For startup or lifecycle changes, check the path where the UI never shows (hidden view, closed
  panel, background window). (Pitwall #70.)
- For anything that opens or starts a process, trace every caller and confirm none can start a
  second one for something already running. (Pitwall #71.)
- For any cache keyed by an OS id (pid, handle, port, window id), write what happens when the OS
  reuses that id for a different object; block if a stale entry can lead to opening or starting
  something. (Pitwall #72.)
- For a fast path that does part of an existing pass (e.g. one-session import vs full scan), list every
  step and callback the full pass runs and check each is either run or skipped on purpose with a test;
  any rule that compares candidates must see the same candidate list. (Pitwall #73.)
- For anything that can pop up, trace the front check for a surface not yet bound to its chat (a
  brand-new tab or terminal) while the user is looking at it. (Pitwall #73.)
- For any "treat X as in front / seen" heuristic, write the case where X belongs to a different chat,
  for both needs-input and finished pop-ups, and include a surface that never binds; block if an
  unrelated chat's pop-up can be silenced without a time limit. (Pitwall #73.)
- Cite the Review items you checked in every verdict, and read this list at the start of each review.
  (Pitwall 2026-11-19: earlier verdicts ran against the role prompt, not this list.)
- Keep: say APPROVE only with CI quoted at the exact sha, and say what you re-checked on a re-review.
  (Pitwall 2026-11-19: #70–#72 approvals quoted green CI at their shas.)
- Keep: trace a flake to the line that failed before approving its fix. (Pitwall #85: QA found the
  file-clock skew the first fix missed.)

## Test (the Tester reads before walking)

- If the walk shows the product doing something other than the original design's core promise,
  report it as a red flag even when every item passes. (Pitwall D35/D36: typing into another
  window's chat still needs a window switch.)
- Write `WALK: OPEN <UTC>` / `WALK: CLOSED <UTC>` as the first line of your state file, so others
  can see a walk is running before starting heavy jobs. (Pitwall #85: a load test ran into the RC
  walk.)
- End each walk report with Proven claims (number and condition each) and save captures with a
  manifest line, so Marketing needs no follow-up questions. (Sharif, 2026-11-20: build in public
  must run fast.)
- Walk on default settings. Changing a setting to get a pass is a FAIL, not a workaround.
  (Pitwall #70: `focusOnStartup` hid the bug.)
- Use renamed items and the owner's real kind of data, not fresh lab items with generated names.
  (Pitwall #71.)
- Upgrade from the previous version with windows already open; don't only install fresh.
  (Pitwall 0.6.0 real-profile check.)
- Try every way to open the same thing, on running and stopped items, and count processes before
  and after. (Pitwall #71.)
- Count `claude` processes per second across a quit and relaunch: an outside chat can die at quit.
  (Pitwall 0.6.0 F5 FAIL C.)
- Include one real end-to-end action through the operating system (a real notification click),
  not only a simulated one. (Pitwall 0.6.0 real click.)
- Do every user action with computer use, on the real screen: row clicks, menus, tab switches,
  keyboard shortcuts and pop-up clicks. DevTools or Playwright is for reading logs, counts and dumps
  only. Don't read the product's source to explain a FAIL; report steps, observations and evidence,
  and let a builder root-cause it. (Pitwall 0.6.0 walk: most actions went through DevTools, and the
  walk made about 130 log and file reads against about 90 UI steps.)
- Before every walk, stop your own stray cua-driver overlay processes and keep exactly one driver
  session. Six overlays were running when three chats opened that no deliberate action explains.
  (Pitwall 2026-11-20: the PR #79 gate's "unrequested opens".)
- Take a fresh screenshot right before every click, and never click from a frame more than a few
  seconds old; pixel clicks take the scale of the latest screenshot. (Pitwall 2026-11-20: text typed
  into a scratch editor; a click missed by scale.)
- Log each deliberate click's UTC wall-clock time in the walk notes (time, window, target), so every
  route line can be matched to a deliberate action or flagged. (Pitwall 2026-11-20.)
- Never exit, kill or restart the app by process name or globally; stop only the test profile's own
  instance, found by its `--user-data-dir`, and confirm it isn't the owner's. (Pitwall 0.6.0 walk:
  "Exit Cursor; relaunch" crashed Sharif's Cursor.)
- Write launch and stop scripts with the file tool, never a shell heredoc, and before launching
  assert the profile folder exists and no non-test app profile is running. (Pitwall 0.6.0 walk: a
  heredoc dropped a backslash and launched a stray profile.)
- Close the test windows' untitled scratch tabs before quitting, and don't leave a test window
  focused while others use the machine; dictation and clicks land in it. (Pitwall 0.6.0 walk: foreign
  dictated text in window a's untitled tab.)
- Say "clean point" only once the walk is closed. (Pitwall 2026-11-19: the Tester offered a clean
  point while still walking.)
- Keep: each FAIL goes to Main with exact repro steps and evidence paths, and no workaround is added
  to make it pass. (Pitwall 2026-11-19: F1–F6 reported this way.)
- Keep: on foreign input, pause, log it as an anomaly and tell Main. (Pitwall RC2 walk, 00:34 UTC.)
- Keep: when the machine was loaded, mark those timings suspect and re-take them. (Pitwall RC2 walk:
  everything before 23:56:12Z re-taken after #85's load test.)

## Marketing (Marketing reads before drafting)

- Never claim the product does what the original design promises but the build doesn't do yet;
  check every claim against the walk's Proven claims. (Pitwall D35/D36: typing into every repo's
  sessions from one place isn't possible yet.)
- Draft the whole package when Main sends the scope, with slots and job-only fallbacks, so the tag
  posts within the hour. (Sharif, 2026-11-20: build in public runs itself.)
- Lead each bullet with the job the product does for the reader ("it notifies you, so you don't
  have to wait"); a metric is optional support. At GO, drop any number that can't be filled cleanly
  (not measured, different conditions, n-of-n mismatch) instead of stalling the post. (Sharif,
  approving v0.6.0, 2026-11-20: "You don't need to include the metrics. Just remember the jobs to be
  done.")
- A release post is pre-approved before the tag; the tag on origin is the GO. Post within the hour,
  with no second ask. Fill only the walk's measured numbers, and drop any line the walk didn't prove.
  Any other edit needs a fresh yes. (Sharif, 2026-11-20.)
- Give the measured number with its condition; never stretch it (a handoff time measured only with
  the window already open).
- Gate a claim until the Tester's walk proves it; a screenshot doesn't prove it.
- Soften claims about platforms nobody tested (macOS).
- Count LinkedIn words and X characters before sending, and flag a draft over target at once.
  (Pitwall 2026-11-19: a 194-word draft was flagged only after it reached Main; an X draft ran to
  306 characters.)
- Make only the edits asked for ("change nothing else" means exactly that).
- Never use a raw whole-desktop recording; it shows the owner's other windows.
- Pad video to the platform's accepted ratio (a 3.08:1 clip was rejected).
- Read this list before every draft, not only the memory notes. (Pitwall 2026-11-19: Marketing
  drafted from memory and read this list only after being asked.)
- Keep: hold every post until Main sends GO, and state each open flag to Main in writing. (Pitwall
  2026-11-19: v0.6.0 posts held with both flags logged.)

## Audit (the Auditor reads before auditing)

- On every new decision, ADR or parked row, ask "does this narrow the original design's promise?";
  if yes, check the owner was told in one plain sentence. (Pitwall D35/D36 went four days untold.)
- Measure the waits, not only the rules: rounds per PR, idle time between stages, walks re-run.
  The biggest cost this release was waiting, not rule-breaking. (Pitwall 11-20 flywheel audit.)
- Compact only when the walk line says CLOSED and the owner isn't typing; compaction takes the
  foreground for a moment. Skip a role that compacted since its last real work. (Pitwall 2026-11-20:
  QA's compaction held through the RC2 walk and its pause.)
- A "clean point" from a role is not enough. Before typing `/compact`, check the chat is idle: no
  tool running and the last result posted. (Pitwall 2026-11-19: QA said clean point, but its chat
  was running mutation probes when `/compact` was typed in.)
- In a chat's slash menu, the highlighted item can differ from the typed text. Never press Enter
  unless `/compact` itself is highlighted; if it isn't, click the `/compact` item directly. Arrow keys
  can wrap the highlight to the wrong end. (Pitwall 2026-11-20: `/milestone-compaction` was
  highlighted with `/compact` typed.)
- Before any push to main, check that no main CI run is in progress; a new push cancels the running
  one. Doc-only pushes count too. (Pitwall 2026-11-20: the Auditor's docs push e8dd184 cancelled main
  CI on the #84 merge 80ceae7.)
- While a walk runs, don't run `verify.sh` (it runs `npm ci` and a compile); doc pushes wait for the
  walk to end. Flag any process spike to Main at once, even before a walk starts. (Pitwall
  2026-11-20: the Auditor saw #85's 65 load-test processes 13 minutes before the RC walk began and
  didn't flag them; the load test then ran into the walk.)
- Never leave an unpushed commit on `main` in a checkout other agents share; hold it on a side
  branch and cherry-pick it onto `origin/main` when the push is allowed. (Pitwall 2026-11-20: the
  held lessons commit made Main's `git pull` create a merge in the shared checkout.)
- Run `gh` and `git push` with a timeout and `GCM_INTERACTIVE=never`. (Pitwall 2026-11-20: a push
  hung about 10 minutes until retried with prompts off.)
- Check a claim against git before passing it on. (Pitwall 2026-11-19: "the warning text is new"
  was wrong; it already existed, and the Tester was briefed on the error.)
- Don't tell a peer a message was forwarded until the send returns success. (Pitwall 2026-11-19:
  a forward to `pitwall-be` failed and the sender was told it had gone through.)
- Re-list agents before naming a session as unreachable; refs change. (Pitwall 2026-11-19: the Main
  session changed from `pitwall-be` to `pitwall-28`.)
- Keep: ask the role's owner about suspected drift before reporting it, and cite the rule it broke.
  (Pitwall 2026-11-19: Main's replies to the audit findings settled the questions with evidence.)
