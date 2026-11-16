"""Check that every key documented in .env.example is present in .env.

Prints key names only — never values. Empty values count as present.

    poetry run python -m tools.check_env [--example PATH] [--env PATH]

Exit codes: 0 all keys present, 1 keys missing, 2 .env or .env.example not found.
"""

import argparse
import sys
from pathlib import Path

from dotenv import dotenv_values


def _keys(path: Path) -> list[str]:
    # utf-8-sig strips the BOM Windows Notepad writes, so the first key isn't misread.
    return list(dotenv_values(path, encoding="utf-8-sig").keys())


def missing_keys(example_path: Path, env_path: Path) -> list[str]:
    present = set(_keys(env_path))
    return [key for key in _keys(example_path) if key not in present]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--example", type=Path, default=Path(".env.example"))
    parser.add_argument("--env", type=Path, default=Path(".env"))
    args = parser.parse_args(argv)

    if not args.example.is_file():
        print(f"{args.example} not found. It is the tracked template; restore it from git.", file=sys.stderr)
        return 2

    if not args.env.is_file():
        print(f"{args.env} not found. Create it with: cp .env.example .env", file=sys.stderr)
        return 2

    missing = missing_keys(args.example, args.env)
    if missing:
        for key in missing:
            print(f"MISSING: {key}", file=sys.stderr)
        return 1

    print(f"OK: {len(_keys(args.example))} keys present")
    return 0


if __name__ == "__main__":
    sys.exit(main())
