# 0021 — Status and pop-ups for every listed session, one window speaks per transition

- **Status:** Proposed
- **Date:** 2026-11-19

## Context

Phase 5 (row 5.1) asks Pitwall to tell you the moment any Claude Code chat needs you or
finishes, in any repo and any window. Until v0.5.0 Pitwall polled `~/.claude/sessions` every
4 s ([ADR 0018](0018-live-status-from-sessions-file.md)), kept a status dot for every row,
and toasted only chats open in the current window (P5). A chat open nowhere, or open in
another window, never spoke.

Every Pitwall window runs its own copy of the extension and reads the same sessions file, so
every window sees every change. Without coordination, three open windows mean three
pop-ups for one wait. "Is the user looking at this chat?" was answered per window, so a
second window could interrupt someone typing in the first.

T1 (assumption tests) showed the sessions file alone carries needs-you (both reasons) and the
finished edge (busy → idle), for panel and CLI sessions. Sharif chose that file over Claude
Code hooks (Q45 = A): nothing is written under `~/.claude`.

## Decision

- **One source, watched.** `ClaudeSessionsFile.watch` re-polls 150 ms after the last `*.json`
  event in a burst (`HarnessAdapter.watchLive`); the 4 s tick stays as the backstop. A `.key`
  event is dropped from its name alone; nothing is opened to judge it. A complete read that
  lacks a session reports `running: false`, so a process that died mid-turn is idle, never
  working or finished.
- **Transitions.** `SessionAttentionService` turns each row-status change of a listed chat
  into a `StatusTransition {chatId, sessionId, from, to, at, observedAt, waitingFor?}` and
  logs `[Pitwall] status <id8> <from>→<to> lag=<ms>`. The first pass after activation and a
  row's first judgement are not transitions.
- **Needs you is the live wait (Q30).** A waiting chat is needs-you on its row, in
  `sessionsNeedingYou()` / `needsYouOrder()` (oldest wait first) and in `counts()`, whether
  or not it is in front. Only the pop-up looks at what is in front.
- **Pop-ups for every listed chat (Q31).** A wait that began after activation (R45), or a turn
  that finished after a working row, is judged in this order: the kind is enabled → the chat
  is listed → the transition has a stamp → it is not pre-existing → the chat is not in front of
  a focused window anywhere → this window wins the lock. A live session no listed chat holds
  asks discovery for one refresh, once per session per window.
- **Exactly one window speaks (Q32).** Each window tries to create
  `<globalStorage>/pitwall-popups/<sessionId>.<needs|finished>.<at>.lock` with `wx`. Only the
  creator shows the pop-up. `at` is `statusUpdatedAt` (else the transcript's last write) for a
  wait and the turn end for a finished turn, never 0 and never the observing window's clock:
  a transition with no stamp is skipped. `shown`, `locked`, `front` and `pre-existing` use up
  the wait, so a later restamp of the same wait can't pop in a window that lost the claim;
  `disabled` keeps it until the settings allow it. Locks are swept after 10 minutes.
- **In front anywhere (Q33).** Each window's registry record gains `front` (the session in
  front) and `focused`, both outside the change signature. `WindowRegistry.frontAnywhere` is
  synchronous over the snapshot the registry's existing refresh caches, ignoring stale records.
- **The in-window message's Open goes through `ChatRouter.route`** (Q35, D35), like every
  other open. It stays the delivery until the Windows pop-up lands (ADR 0022, Task 3).

## Alternatives

- **Claude Code hooks** (PermissionRequest, Notification, Stop): push latency under 100 ms and
  a true Stop vs interrupt, at the cost of writing `~/.claude/settings.json`. Deferred to an
  opt-in Phase 7 row (Q45).
- **A leader window** elected by heartbeat that alone shows pop-ups: one more protocol, a
  failover gap, and a new state file. A per-transition lock needs no election and loses at most
  one pop-up when its winner crashes.
- **Locks keyed by the observer's clock**: two windows see one change at different times and
  would make two keys. The harness's own stamp is the one value every window reads alike.

## Consequences

- Status reaches the rows within about 150 ms of a sessions-file write, not up to 4 s.
- A brand-new repo's first wait can be one discovery pass late (Q31).
- One stale registry record (up to 45 s) can hide a pop-up for a chat it claims is in front.
- A wait whose file has no stamp and whose transcript time is unknown never pops; it still
  shows on the row and in the list.
- Global storage gains `pitwall-popups/` (empty files) and two keys in each window record;
  `docs/privacy.md` lists them and `scripts/dump-pitwall-windows.mjs --check-privacy` enforces
  them. A runtime test spies on every fs write across activation and a poll: none lands under
  the Claude config dir.
- Ground truth: `scripts/watch-sessions.mjs` records the sessions file; `scripts/compare-status.mjs`
  diffs it against the status log lines and each window's state dump.
