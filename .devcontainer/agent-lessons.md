# Agent lessons

The learning loop's memory (see `AGENT_ROLES.md`). Each role reads its list before every job.
The Auditor owns this file: it reads the agents' work and messages, adds the rule when something
went wrong, and adds a `Keep:` line when something went well. One line per lesson: the rule, then
the bug, PR or moment it came from. Remove a rule once a test or check enforces it.

## Build (Main and the builders read before building)

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
- Never install a build into the owner's own app while agent chats run in it, even at their request;
  installing restarted the extension host and cut off the QA, Tester and Marketing chats. Use a separate
  profile, or let the owner install at a quiet moment. (Pitwall 0.6.0 real-profile check.)
- Never substitute a stand-in reviewer for the QA agent. If QA is disconnected, wake it or ask the
  owner. (Pitwall 2026-11-19: #70–#72 went to stand-in reviewers; the owner then ruled QA reviews
  every PR, 1a28f36.)
- Keep: merge with `--match-head-commit <approved sha>`, so the merged commit is the one QA approved.
  (Pitwall #70–#72: approved and merged shas matched.)
- Keep: builders put their lesson line in the PR body under "Lesson:", not in this file. The
  Auditor adds it to main after the merge, so PRs don't conflict on this file. (Pitwall #73, #74,
  #75: three PRs each edited this file and conflicted; #73 sat about 20 minutes with no CI.)
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
- In a test, take a time boundary from the stamp the code under test recorded, never from a clock read
  made just before the call. Two `Date.now()` reads can fall in different milliseconds, and a `>=` at the
  boundary then flips. (Pitwall #77: tab-adoption.test.ts:313 failed on main CI.)
- Before cutting a latency, log or measure each stage between the trigger and the user seeing it,
  including process start-up. (Pitwall #78: the pop-up's 1 s was a fresh PowerShell per toast; the
  status path was already 0.2 s.)
- A job that fans out file reads (one per repo) must cap how many run at once. libuv has four file
  threads, and every small read queues behind them, the status poll's too. (Pitwall #78: discovery
  passes of 31–98 s were mostly waiting.)
- `npm run test:dry` deletes `test/dry/.build`. Never keep a backup or scratch file there across a
  test run. (Pitwall #78.)
- A byte pattern that stands in for a JSON key must include what only a key has, the closing quote and
  its colon (`"key":`), or a string value spelling the key matches too. And an equivalence fixture must
  carry every field real lines carry (here `entrypoint`), or the fast path it tests never runs.
  (Pitwall #78: QA on #78.)
- Never await a child process inside a status poll; serve its last answer (even stale) and refresh it in
  the background. With no answer at all, report "unknown", never "no change". Also test the moment when a
  starting process's record exists but its status isn't written yet. (Pitwall #79: `claude agents --json`
  held both windows' polls 2.7–5.3 s on every resume; treating "no answer" as "no wait" blanked waits.)
- A resume point is safe only if its check covers the bytes right before where it resumes. A check
  allowed to lag even one chunk leaves bytes no one verifies. Keep "check ends at offset" as the
  invariant, and drop the resume point when it doesn't hold. (Pitwall #81.)
- Before building a fix for "X waits behind Y", A/B the suspected mechanism at real scale. A poll-
  priority gate for file threads changed nothing (72–82 vs 67–80 ms), so the PR ships per-step timing
  instead. (Pitwall #81, round 1.)
- A test on mocked timers that also waits on real I/O must hold the mocked clock while that I/O is in
  flight; moving the clock at a fixed rate charges machine load to the code's timers. (Pitwall #83:
  first-scan tests went 1/30 → 30/30 under load.)
- Instrument before you attribute. A route line with no trigger source can't settle what caused an
  open; add the trigger to the log first, then name the cause. (Pitwall 2026-11-20: the 11-19 "spurious
  opens" were blamed on the owner's dictation without evidence.)
- Ask Sharif for post pre-approval when the RC walk starts, so the tag never waits on him. (Sharif,
  2026-11-20: the release tag is Marketing's automatic GO for pre-approved posts.)
- A walk brief uses every default the owner has. Never turn a feature off to make the walk easier;
  if one must be off, walk with it on as well. (Pitwall 0.6.0: the walk ran with discovery off and
  hid 5–8 s pop-up lag; with it on, lag was 6.5–8.4 s against a ~5 s bar.)

## Review (QA reads before reviewing)

- For any guard or branch the diff removes, write the counterexample to the author's "can only"
  claim, and block if one exists. (Pitwall #68 round 2 → fork in #71.)
- For startup or lifecycle changes, check the path where the UI never shows (hidden view, closed
  panel, background window). (Pitwall #70.)
- For anything that opens or starts a process, trace every caller and confirm none can start a
  second one for something already running. (Pitwall #71.)
- For any cache keyed by an OS id (pid, handle, port, window id), write what happens when the OS reuses that id for a different object; block if a stale entry can lead to opening or starting something. (Pitwall #72.)
- Cite the Review items you checked in every verdict, and read this list at the start of each review.
  (Pitwall 2026-11-19: earlier verdicts ran against the role prompt, not this list.)
- For a fast path that does part of an existing pass (e.g. one-session import vs full scan), list every
  step and callback the full pass runs and check each is either run or skipped on purpose with a test;
  any rule that compares candidates must see the same candidate list. (Pitwall #73.)
- For anything that can pop up, trace the front check for a surface not yet bound to its chat (a
  brand-new tab or terminal) while the user is looking at it. (Pitwall #73.)
- For any "treat X as in front / seen" heuristic, write the case where X belongs to a different chat,
  for both needs-input and finished pop-ups, and include a surface that never binds; block if an
  unrelated chat's pop-up can be silenced without a time limit. (Pitwall #73.)
- Keep: say APPROVE only with CI quoted at the exact sha, and say what you re-checked on a re-review.
  (Pitwall 2026-11-19: #70–#72 approvals quoted green CI at their shas.)

## Test (the Tester reads before walking)

- Walk on default settings. Changing a setting to get a pass is a FAIL, not a workaround.
  (Pitwall #70: `focusOnStartup` hid the bug.)
- Use renamed items and the owner's real kind of data, not fresh lab items with generated names.
  (Pitwall #71.)
- Upgrade from the previous version with windows already open; don't only install fresh.
  (Pitwall 0.6.0 real-profile check.)
- Try every way to open the same thing, on running and stopped items, and count processes before
  and after. (Pitwall #71.)
- Before every walk, stop your own stray cua-driver overlay processes and keep exactly one driver
  session. Six overlays were running when three chats opened that no deliberate action explains.
  (Pitwall 2026-11-20: the PR #79 gate's "unrequested opens".)
- Take a fresh screenshot right before every click, and never click from a frame more than a few
  seconds old; pixel clicks take the scale of the latest screenshot. (Pitwall 2026-11-20: text typed
  into a scratch editor; a click missed by scale.)
- Log each deliberate click's UTC wall-clock time in the walk notes (time, window, target), so every
  Pitwall route line can be matched to a deliberate action or flagged. (Pitwall 2026-11-20.)
- Include one real end-to-end action through the operating system (a real notification click),
  not only a simulated one. (Pitwall 0.6.0 real click.)

- Never exit, kill or restart the app by process name or globally; stop only the test profile's own
  instance, found by its `--user-data-dir`, and confirm it isn't the owner's. (Pitwall 0.6.0 walk:
  "Exit Cursor; relaunch" crashed Sharif's Cursor.)
- Write launch and stop scripts with the file tool, never a shell heredoc, and before launching
  assert the profile folder exists and no non-test app profile is running. (Pitwall 0.6.0 walk: a
  heredoc dropped a backslash and launched a stray profile.)
- Say "clean point" only once the walk is closed. (Pitwall 2026-11-19: the Tester offered a clean
  point while still walking.)
- Do every user action with computer use, on the real screen: row clicks, menus, tab switches,
  keyboard shortcuts and pop-up clicks. DevTools or Playwright is for reading logs, counts and dumps
  only. Don't read Pitwall's source to explain a FAIL; report steps, observations and evidence, and
  let a builder root-cause it. (Pitwall 0.6.0 walk: most actions went through DevTools, and the
  walk made about 130 log and file reads against about 90 UI steps.)
- Close the test windows' untitled scratch tabs before quitting, and don't leave a test window
  focused while others use the machine; dictation and clicks land in it. (Pitwall 0.6.0 walk: foreign
  dictated text in window a's untitled tab, likely the source of the "spurious opens" anomaly.)
- Count `claude` processes per second across a quit and relaunch: an outside chat can die at quit.
  (Pitwall 0.6.0 F5 FAIL C.)
- Keep: each FAIL goes to Main with exact repro steps and evidence paths, and no workaround is added
  to make it pass. (Pitwall 2026-11-19: F1–F6 reported this way.)

## Marketing (Marketing reads before drafting)

- Read this list before every draft, not only the memory notes. (Pitwall 2026-11-19: Marketing
  drafted from memory and read this list only after being asked.)
- Give the measured number with its condition; never stretch it (a handoff time measured only with
  the window already open).
- Gate a claim until the Tester's walk proves it; a screenshot doesn't prove it.
- Lead with a bold, clear promise; weak openers get rewritten.
- Always post with media; never offer a text-only fallback.
- Never use a raw whole-desktop recording; it shows the owner's other windows.
- Pad video to the platform's accepted ratio (a 3.08:1 clip was rejected).
- Make only the edits asked for ("change nothing else" means exactly that).
- Count X characters before sending (a draft ran to 306).
- Count LinkedIn words before sending, and flag a draft over the 120–160 target at once. (Pitwall
  2026-11-19: a 194-word draft was flagged only after it had been sent to Main.)
- Soften claims about platforms nobody tested (macOS).
- Flag drafts over the length target.
- Put the repo link in the first comment, never in the post.
- Lead each bullet with the job the product does for the reader ("it notifies you, so you don't have to
  wait"); a metric is optional support. In pre-approval packages, give every metric bullet a job-only
  fallback. At GO, drop any number that can't be filled cleanly (not measured, different conditions,
  n-of-n mismatch) instead of stalling the post. (Pitwall 2026-11-20: Sharif, approving v0.6.0: "You
  don't need to include the metrics. Just remember the jobs to be done.")
- A release post is pre-approved before the tag; the tag on origin is the GO. Post within the hour,
  with no second ask. Fill only the walk's measured numbers, and drop any line the walk didn't prove.
  Any other edit needs a fresh yes. (Sharif, 2026-11-20.)
- Keep: hold every post until Main sends GO, and state each open flag to Main in writing. (Pitwall
  2026-11-19: v0.6.0 posts held with both flags logged.)

## Audit (the Auditor reads before auditing)

- A "clean point" from a role is not enough. Before typing `/compact`, check the chat is idle: no
  Bash or Write running and the last result posted. (Pitwall 2026-11-19: QA said clean point, but
  its chat was running mutation probes when `/compact` was typed in.)
- In a chat's slash menu, the highlighted item can differ from the typed text. Never press Enter
  unless `/compact` itself is highlighted; if it isn't, click the `/compact` item directly. Arrow keys
  can wrap the highlight to the wrong end. (Pitwall 2026-11-20: `/milestone-compaction` was
  highlighted with `/compact` typed.)
- Before any push to main, run `gh run list --branch main --limit 3` and push only when no run is
  in progress; a new push cancels the running one. Doc-only pushes count too. (Pitwall 2026-11-20:
  the Auditor's docs push e8dd184 cancelled main CI on the #84 merge 80ceae7.)
- Check a claim against git before passing it on. (Pitwall 2026-11-19: "the warning text is new"
  was wrong; it already existed, and the Tester was briefed on the error.)
- Don't tell a peer a message was forwarded until the send returns success. (Pitwall 2026-11-19:
  a forward to `pitwall-be` failed and the sender was told it had gone through.)
- Re-list agents before naming a session as unreachable; refs change. (Pitwall 2026-11-19: the Main
  session changed from `pitwall-be` to `pitwall-28`.)
- Confirm the tab, the window title and an empty input before typing into a window; never type into
  a busy chat or someone's draft. (Pitwall 2026-11-19: a `/compact` path needed all three checks.)
- Keep: ask the role's owner about suspected drift before reporting it, and cite the rule it broke.
  (Pitwall 2026-11-19: Main's replies to the audit findings settled the questions with evidence.)
