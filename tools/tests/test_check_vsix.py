from tools.check_vsix import main, stray_paths

GOOD = [
    "package.json",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "THIRD_PARTY_NOTICES.md",
    "out/extension.js",
    "out/uninstall.js",
    "resources/icons/pitwall.png",
    "resources/icons/pitwall.svg",
    "resources/icons/harness/claude.svg",
]


def test_allowlisted_listing_passes(tmp_path, capsys):
    listing = tmp_path / "ls.txt"
    listing.write_text("\n".join(GOOD) + "\n", encoding="utf-8")
    assert stray_paths(GOOD) == []
    assert main(["--from-file", str(listing)]) == 0
    assert capsys.readouterr().out.strip() == f"OK: {len(GOOD)} packaged paths, all allowlisted"


def test_source_map_is_stray():
    assert stray_paths(GOOD + ["out/extension.js.map"]) == ["out/extension.js.map"]


def test_env_local_is_stray():
    assert stray_paths(GOOD + [".env.local"]) == [".env.local"]


def test_transcripts_file_is_stray():
    assert stray_paths(GOOD + ["transcripts/a.md"]) == ["transcripts/a.md"]


def test_nested_resource_dir_is_stray(tmp_path, capsys):
    path = "resources/icons/harness/base/x.svg"
    assert stray_paths(GOOD + [path]) == [path]
    listing = tmp_path / "ls.txt"
    listing.write_text("\n".join(GOOD + [path]) + "\n", encoding="utf-8")
    assert main(["--from-file", str(listing)]) == 1
    assert f"STRAY {path}" in capsys.readouterr().out


def test_empty_listing_fails(tmp_path, capsys):
    listing = tmp_path / "ls.txt"
    listing.write_text("", encoding="utf-8")
    assert main(["--from-file", str(listing)]) == 1
    assert "MISSING out/extension.js" in capsys.readouterr().out


def test_missing_extension_js_fails(tmp_path, capsys):
    paths = [p for p in GOOD if p != "out/extension.js"]
    listing = tmp_path / "ls.txt"
    listing.write_text("\n".join(paths) + "\n", encoding="utf-8")
    assert main(["--from-file", str(listing)]) == 1
    out = capsys.readouterr().out
    assert "MISSING out/extension.js" in out
    assert "OK:" not in out


def test_missing_uninstall_js_fails(tmp_path, capsys):
    # The vscode:uninstall script removes the pop-up registration (Q46); it must ship.
    paths = [p for p in GOOD if p != "out/uninstall.js"]
    listing = tmp_path / "ls.txt"
    listing.write_text("\n".join(paths) + "\n", encoding="utf-8")
    assert main(["--from-file", str(listing)]) == 1
    assert "MISSING out/uninstall.js" in capsys.readouterr().out


def test_uninstall_source_map_is_stray():
    assert stray_paths(GOOD + ["out/uninstall.js.map"]) == ["out/uninstall.js.map"]
