# Agent lessons

The learning loop's memory (see `AGENT_ROLES.md`). Each role reads its list before every job.
One line per lesson: the rule, then the bug or PR it came from. Remove a rule once a test or
check enforces it.

## Build (Main reads before building)

- Startup work that waits for a view or panel to appear also needs a timeout fallback for when it
  never appears. (Pitwall #70: no status or pop-ups while the sidebar stayed hidden.)
- Show and match names from the same source the user sees, such as the user's own rename before
  any generated title. (Pitwall #71: tab "Main" vs stored "Pitwall initial idea".)
- Never remove a safety guard because a case "can only happen when…"; keep it and test the
  counterexample. (Pitwall #71: #68 dropped the guard and a live chat was forked.)

## Review (QA reads before reviewing)

- For any guard or branch the diff removes, write the counterexample to the author's "can only"
  claim, and block if one exists. (Pitwall #68 round 2 → fork in #71.)
- For startup or lifecycle changes, check the path where the UI never shows (hidden view, closed
  panel, background window). (Pitwall #70.)
- For anything that opens or starts a process, trace every caller and confirm none can start a
  second one for something already running. (Pitwall #71.)

## Test (the Tester reads before walking)

- Walk on default settings. Changing a setting to get a pass is a FAIL, not a workaround.
  (Pitwall #70: `focusOnStartup` hid the bug.)
- Use renamed items and the owner's real kind of data, not fresh lab items with generated names.
  (Pitwall #71.)
- Upgrade from the previous version with windows already open; don't only install fresh.
  (Pitwall 0.6.0 real-profile check.)
- Try every way to open the same thing, on running and stopped items, and count processes before
  and after. (Pitwall #71.)
- Include one real end-to-end action through the operating system (a real notification click),
  not only a simulated one. (Pitwall 0.6.0 real click.)
