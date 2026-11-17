"""Fail if the packaged .vsix would hold any path outside the allowlist.

    poetry run python -m tools.check_vsix [--from-file PATH]

Runs `npx -y @vscode/vsce@3.2.1 ls` (or reads the listing from PATH) and accepts
only the paths Pitwall ships.

Exit codes: 0 all allowlisted and every required path present, 1 stray paths (STRAY <path>)
or missing required paths (MISSING <path-or-pattern>), 2 vsce failed.
"""

import argparse
import re
import shutil
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path

_ALLOWED = re.compile(
    r"^(package\.json|README\.md|LICENSE|CHANGELOG\.md|THIRD_PARTY_NOTICES\.md"
    r"|out/extension\.js"
    r"|resources/icons/[^/]+\.(png|svg)"
    r"|resources/icons/harness/[^/]+\.svg)$"
)


_REQUIRED_FILES = (
    "package.json",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "THIRD_PARTY_NOTICES.md",
    "out/extension.js",
)
_REQUIRED_PATTERNS = (
    r"resources/icons/[^/]+\.(png|svg)",
    r"resources/icons/harness/[^/]+\.svg",
)


def missing_paths(paths: Iterable[str]) -> list[str]:
    present = set(paths)
    missing = [f for f in _REQUIRED_FILES if f not in present]
    missing += [pat for pat in _REQUIRED_PATTERNS if not any(re.fullmatch(pat, p) for p in present)]
    return missing


def stray_paths(paths: Iterable[str]) -> list[str]:
    return [p for p in paths if not _ALLOWED.match(p)]


def _listing(from_file: Path | None) -> list[str] | None:
    if from_file is not None:
        text = from_file.read_text(encoding="utf-8")
    else:
        npx = shutil.which("npx") or "npx"
        result = subprocess.run(
            [npx, "-y", "@vscode/vsce@3.2.1", "ls"], capture_output=True, text=True
        )
        if result.returncode != 0:
            print(f"vsce ls failed: {result.stderr.strip()}", file=sys.stderr)
            return None
        text = result.stdout
    return [line.strip() for line in text.splitlines() if line.strip()]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--from-file", type=Path, default=None)
    args = parser.parse_args(argv)

    paths = _listing(args.from_file)
    if paths is None:
        return 2
    stray = stray_paths(paths)
    missing = missing_paths(paths)
    for p in stray:
        print(f"STRAY {p}")
    for p in missing:
        print(f"MISSING {p}")
    if stray or missing:
        return 1
    print(f"OK: {len(paths)} packaged paths, all allowlisted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
