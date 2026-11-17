# Sharif action items

Things the autonomous build needs from Sharif. Each item: date, what, why it's blocked, how to reproduce or decide. Newest first. Empty means nothing is waiting on you.

## 2026-11-17 · Decide how "resumed within 15 s" is timed (Phase 2 criterion E9, Smoke 12 R1(b)), needed before the evaluator runs
The check: after quitting and relaunching Cursor, a chat that was open comes back resumed within 15 s.
- **(a) From relaunch (as written).** Cursor itself takes about 35 s before extensions start on this machine, so this would FAIL every time, on a delay Pitwall can't control.
- **(b) From Pitwall's start (`onStartupFinished`).** This measures only what Pitwall controls. Measured on the testing walk: 14.3 s and 8.5 s, so PASS, but thin. Task 6b is measuring where the time goes.
Lead and QA both lean towards (b). Reply "(a)" or "(b)", or give another bar. Until then, R1(b) is marked "pending Sharif" in the plan.

## 2026-11-16 · Update Cursor before December 14, 2026 (not urgent)
Cursor shows "This version of Cursor (3.14.27) stops working on December 14, 2026." That's your everyday Cursor. Update when convenient; the agents never press Update because the install is shared with your windows.

## ✅ 2026-11-16 · Sign in to the testing agent's Cursor copy: done by Sharif

## ✅ 2026-11-16 · Approve the kickoff post (LinkedIn + X): approved and posted
Draft text is in the lead's chat message. Reply "approved" or edits. The marketing agent also needs LinkedIn and X logged in in your Chrome to post live, and will confirm once with you that the lead's relayed approval is enough to publish.
