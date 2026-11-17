import zipfile
from pathlib import Path

from tools.check_vsix_archive import main

ENTRIES = [
    "extension/package.json",
    "extension/readme.md",
    "extension/changelog.md",
    "extension/LICENSE.txt",
    "extension/out/extension.js",
]


def _vsix(tmp_path: Path, names: list[str]) -> Path:
    path = tmp_path / "x.vsix"
    with zipfile.ZipFile(path, "w") as z:
        for n in names:
            z.writestr(n, "x")
    return path


def test_complete_archive_passes(tmp_path, capsys):
    assert main([str(_vsix(tmp_path, ENTRIES))]) == 0
    assert capsys.readouterr().out.strip() == "vsix OK 5 entries"


def test_missing_changelog_fails(tmp_path, capsys):
    names = [e for e in ENTRIES if e != "extension/changelog.md"]
    assert main([str(_vsix(tmp_path, names))]) == 1
    assert "MISSING extension/changelog.md" in capsys.readouterr().out


def test_unreadable_archive_fails(tmp_path, capsys):
    assert main([str(tmp_path / "nope.vsix")]) == 1
