# 0018 — Live status comes from `~/.claude/sessions`, with `claude agents` as the fallback

- **Status:** Proposed
- **Date:** 2026-11-17
- **Amends:** [0006](0006-needs-you-from-agents-json.md)

## Context

[0006](0006-needs-you-from-agents-json.md) reads needs-you from `claude agents --json`. That
call spawns the CLI (0.56–0.82 s measured on 2026-11-17), so its answer is cached for 10 s,
and a cached "waiting" row can be older than the prompt's answer. Phase 2 had to work around
that age: R40 drops a wait when the transcript was written after the call started (hotfix #24
compares at whole milliseconds), and R41 approximates when the wait began from the
transcript's mtime.

Phase 3 shows a status dot on every row, not only open chats, and covers sessions running in
Claude's own panel (T1). Polling the CLI for that every tick is the cost 0006 tried to keep
small.

Claude Code keeps one file per running session in `<configDir>/sessions/<pid>.json`. Each
holds, among other keys, `pid`, `sessionId`, `cwd`, `status` (`busy`, `waiting` or `idle`),
`waitingFor`, `statusUpdatedAt` and `pidDomain`. The CLI's own `agents` command parses the
same records, so the files are never behind it. The folder also holds `<pid>.<hex>.key`
files, which are not Pitwall's to read.

## Decision

- Read live status from `<configDir>/sessions/*.json` on every attention tick (rule P4).
  Only `*.json` names are opened; `.key` files are never opened, read or stat-ed, and
  nothing from a file is logged.
- A file counts only when its `status` is `busy`, `waiting` or `idle`, its `pidDomain`
  equals this machine's, and its pid is alive. The pid check is `process.kill(pid, 0)`:
  no error or `EPERM` means alive, `ESRCH` means gone. Two files for one session: the
  newest `statusUpdatedAt` wins.
- The file is read fresh, so its status is current truth. `observedAt` is the read time,
  and there is no stale-wait drop for file samples. `statusUpdatedAt` is the wait's start
  (`writtenAt`), never a reason to drop it: it does not move during a wait, so a drop keyed
  on it would hide a real wait for as long as it lasts. The R45 floor (`lastClearAt`) stays
  the sample time.
- `claude agents --json` stays as the fallback, per session, with 0006's rules and the R40
  drop unchanged:
  - for every session when no file counts (no folder, an empty one, or an older CLI);
  - for a session whose file has a status Pitwall does not know;
  - for a session missing from the folder while another `.json` there could not be parsed
    (for example, caught mid-write), so a torn file never clears a wait by itself.
- A session absent from an available, fully readable folder is not running. It costs no
  CLI call.
- `HarnessLiveState.liveStatus` carries the status (`busy`, `waiting`, `idle`) for the row
  dots.
- The listing is read synchronously; the `.json` reads are asynchronous. A missing folder
  therefore adds no I/O round trip before the fallback.

## Alternatives

- **Keep polling `claude agents --json`.** Spawns the CLI every 10 s for every window, and
  keeps the cache-age workarounds.
- **Keep the R40 drop for file samples, keyed on `statusUpdatedAt`.** Hides a real wait
  whenever the transcript is written during it.
- **Read the `.key` files or the messaging socket.** Not needed for status, and not
  Pitwall's data.
- **Watch the folder with `fs.watch`.** Faster, but adds a watcher lifecycle per window; the
  tick already bounds latency.

## Consequences

- No CLI spawn while the folder answers. Needs-you latency is the tick interval, not the
  10 s cache.
- Older CLIs without the folder, and containers where it is not mounted, behave as before.
- Needs-you marks no longer depend on `pitwall.notifications.onNeedsInput`. The setting
  still gates the toast, and the fallback call is still skipped when it is off. With the
  setting off and the sessions folder unavailable, the `claude agents` fallback stays
  disabled, so no needs-you mark shows: the mark then depends on which source answered.
- A torn read (a file caught mid-write) that hides a session waiting on the previous tick
  keeps that session's previous file state for one tick, so the wait neither ends nor
  restarts (an R45 residual). A second torn read in a row falls back as above.
- `pidDomain` mirrors Claude Code 2.1.326: `win32:<lower-case hostname>` on Windows,
  `linux:<machine-id>:<pid namespace>` on Linux, the platform name elsewhere. If a future CLI
  changes it, every file is ignored and the fallback takes over: a cost, never a wrong
  status.
- **PID reuse is a known limit.** A crashed session whose pid the OS has given to another
  process still reads as alive until Claude removes or rewrites the file. `procStart` could
  close this, but its format is undocumented and platform-specific, so it is not read yet.
- The record format is undocumented. Unknown keys are ignored, and an unknown `status`
  falls back per session.
- Privacy: [privacy.md](../privacy.md) lists the folder. Only `sessionId`, `pid`, `status` and
  `statusUpdatedAt` are ever printed, and only by `scripts/probe-claude-sessions.mjs`.

## Evidence

Smoke S2, 2026-11-17, this machine's real folder (read-only), Claude Code 2.1.326:

- `node scripts/probe-claude-sessions.mjs`: 10 live files (5 idle, 4 busy, 1 waiting), 0
  dropped, 0 unknown status, 0 other pidDomain, 0 unreadable.
- Five paired samples, folder read then `claude agents --json`: status agreed 10/10 each
  time, `waitingFor` agreed 1/1. Folder read 2–3 ms; CLI call 562–822 ms.
