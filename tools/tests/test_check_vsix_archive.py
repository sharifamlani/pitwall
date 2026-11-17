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


FULL = [
    "extension.vsixmanifest",
    "[Content_Types].xml",
    *ENTRIES,
    "extension/THIRD_PARTY_NOTICES.md",
    "extension/resources/icons/pitwall.png",
    "extension/resources/icons/harness/claude.svg",
]


def test_full_archive_passes(tmp_path, capsys):
    assert main([str(_vsix(tmp_path, FULL))]) == 0
    assert capsys.readouterr().out.strip() == f"vsix OK {len(FULL)} entries"


def test_stray_entry_fails(tmp_path, capsys):
    assert main([str(_vsix(tmp_path, FULL + ["extension/.env"]))]) == 1
    assert "STRAY extension/.env" in capsys.readouterr().out


def test_missing_notice_fails(tmp_path, capsys):
    names = [e for e in FULL if e != "extension/THIRD_PARTY_NOTICES.md"]
    assert main([str(_vsix(tmp_path, names))]) == 1
    assert "MISSING extension/THIRD_PARTY_NOTICES.md" in capsys.readouterr().out


def test_missing_icons_fail_and_both_kinds_print(tmp_path, capsys):
    names = [e for e in FULL if "icons" not in e] + ["extension/.env"]
    assert main([str(_vsix(tmp_path, names))]) == 1
    out = capsys.readouterr().out
    assert "STRAY extension/.env" in out
    assert "MISSING extension/resources/icons/harness/" in out
