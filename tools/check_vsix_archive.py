"""Fail if a built .vsix holds a stray entry or lacks a file the extension must ship.

    python -m tools.check_vsix_archive PATH.vsix

`npm run package` passes --allow-unused-files-pattern (vsce's unused-pattern check breaks on
Windows), so this check is what proves the must-ship files really are in the archive.

Exit codes: 0 all present (prints `vsix OK <n> entries`), 1 missing entries
(MISSING <entry-or-pattern>), stray entries (STRAY <entry>), or an unreadable archive.
Same allowlist shape as tools.check_vsix, mapped to archive names.
"""

import argparse
import re
import sys
import zipfile
from pathlib import Path

_ALLOWED = re.compile(
    r"^(extension\.vsixmanifest|\[Content_Types\]\.xml"
    r"|extension/(package\.json|readme\.md|changelog\.md|LICENSE\.txt|THIRD_PARTY_NOTICES\.md|out/(extension|uninstall)\.js)"
    r"|extension/resources/icons/[^/]+\.(png|svg)"
    r"|extension/resources/icons/harness/[^/]+\.svg)$"
)

REQUIRED_FILES = (
    "extension/package.json",
    "extension/readme.md",
    "extension/changelog.md",
    "extension/LICENSE.txt",
    "extension/THIRD_PARTY_NOTICES.md",
    "extension/out/extension.js",
    "extension/out/uninstall.js",
)
REQUIRED_PATTERNS = (
    r"extension/resources/icons/[^/]+\.(png|svg)",
    r"extension/resources/icons/harness/[^/]+\.svg",
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
    stray = sorted(n for n in names if not _ALLOWED.match(n))
    missing = [f for f in REQUIRED_FILES if f not in names]
    missing += [p for p in REQUIRED_PATTERNS if not any(re.fullmatch(p, n) for n in names)]
    for n in stray:
        print(f"STRAY {n}")
    for m in missing:
        print(f"MISSING {m}")
    if stray or missing:
        return 1
    print(f"vsix OK {len(names)} entries")
    return 0


if __name__ == "__main__":
    sys.exit(main())
