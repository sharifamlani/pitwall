# claude-lab-no-turn

Anonymised transcript lines from the Phase 4 lab chats (uj-lab-a, 2026-11-18), for the Q24
tests in `test/dry/harnesses/claude/claude-no-turn-status.test.ts`. Every prompt, path, id and
account value is a lab placeholder; only the line types, field names and turn shape are real.

| File | What it is |
|---|---|
| `transcript-before.jsonl` | A chat at rest: a prompt, a tool call the user rejected, Claude's `[Request interrupted by user for tool use]` marker, then the metadata block Claude writes after a turn |
| `resume-appends.jsonl` | What a resume (terminal or Claude's panel) appends with no prompt: `last-prompt`, `ai-title`, `mode`, `permission-mode`, `session-owner`, `atis-latch` |
| `close-appends.jsonl` | What closing the chat's process (closing its Claude tab) appends: `cost-state`, `last-prompt`, `tools-used` |

None of the appended lines has a timestamp or is a `user`/`assistant` entry.
