"""Fail if any private path is tracked by git. This repo is public.

Matches case-insensitively at any depth, so a force-add, a nested copy, or a
different casing from a case-sensitive clone is still caught.

    poetry run python -m tools.check_private_paths [--repo PATH]

Exit codes: 0 nothing private tracked, 1 private paths tracked, 2 git failed.
"""

import argparse
import re
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path

_PRIVATE = re.compile(
    r"""
    (^|/)(\.packages|transcripts|\.claude|\.superpowers)/      # private folders
    | (^|/)\.env(\.[^/]*)?$                                    # .env and .env.*
    | (^|/)\.?(token|credentials)\.json$                       # OAuth / login tokens
    | \.(pem|key)$                                             # private keys
    | (^|/)\.npmrc$                                            # npm auth tokens
    | (^|/)\.netrc$                                            # machine logins
    | (^|/)id_rsa[^/]*$                                        # SSH keys
    | (^|/)id_ed25519[^/]*$
    | \.p12$                                                   # certificate bundles
    | \.pfx$
    """,
    re.IGNORECASE | re.VERBOSE,
)
_TEMPLATE = re.compile(r"(^|/)\.env\.example$", re.IGNORECASE)
# The one tracked exception under .claude/: the extension's own skills, at the repo root only.
_ALLOWED = re.compile(r"^\.claude/skills/pitwall-[^/]+/", re.IGNORECASE)


def leaked_paths(paths: Iterable[str]) -> list[str]:
    leaked = []
    for p in paths:
        # Exempt only the allowed prefix; whatever sits beneath it is still checked.
        m = _ALLOWED.match(p)
        target = p[m.end() :] if m else p
        if _PRIVATE.search(target) and not _TEMPLATE.search(target):
            leaked.append(p)
    return leaked


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", type=Path, default=Path("."))
    args = parser.parse_args(argv)

    result = subprocess.run(
        ["git", "-C", str(args.repo), "ls-files", "-z"], capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"git ls-files failed: {result.stderr.strip()}", file=sys.stderr)
        return 2

    tracked = [p for p in result.stdout.split("\0") if p]
    leaked = leaked_paths(tracked)
    if leaked:
        for path in leaked:
            print(f"LEAKED: {path}", file=sys.stderr)
        return 1

    print(f"OK: no private paths tracked ({len(tracked)} files checked)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
