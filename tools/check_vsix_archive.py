"""Fail if a built .vsix lacks a file the extension must ship.

    python -m tools.check_vsix_archive PATH.vsix

`npm run package` passes --allow-unused-files-pattern (vsce's unused-pattern check breaks on
Windows), so this check is what proves the must-ship files really are in the archive.

Exit codes: 0 all present (prints `vsix OK <n> entries`), 1 missing entries
(MISSING <entry>) or an unreadable archive.
"""

import argparse
import sys
import zipfile
from pathlib import Path

REQUIRED = (
    "extension/package.json",
    "extension/readme.md",
    "extension/changelog.md",
    "extension/LICENSE.txt",
    "extension/out/extension.js",
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("vsix", type=Path)
    args = parser.parse_args(argv)
    try:
        with zipfile.ZipFile(args.vsix) as z:
            names = set(z.namelist())
    except (OSError, zipfile.BadZipFile) as e:
        print(f"MISSING archive {args.vsix}: {e}")
        return 1
    missing = [r for r in REQUIRED if r not in names]
    for m in missing:
        print(f"MISSING {m}")
    if missing:
        return 1
    print(f"vsix OK {len(names)} entries")
    return 0


if __name__ == "__main__":
    sys.exit(main())
