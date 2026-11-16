# `tools/` — Python dev tooling

Python helpers for building and checking Pitwall: env checks, session-file probes, eval harnesses.
**This is not the extension.** The Cursor/VS Code extension is TypeScript at the repo root, built with npm.

Run any tool from the repo root with `poetry run python -m tools.<name>`. Tests live in `tools/tests/` (`poetry run pytest`).
