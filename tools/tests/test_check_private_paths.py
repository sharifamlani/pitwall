import subprocess

import pytest

from tools.check_private_paths import leaked_paths, main

LEAKED = [
    ".env",
    ".ENV",
    ".env.local",
    "tools/.env",
    ".packages/Gmail/token.json",
    ".Packages/x",
    "transcripts/inital_idea.md",
    "Transcripts/a.md",
    ".claude/settings.local.json",
    "sub/.claude/settings.json",
    ".superpowers/sdd/progress.md",
    "token.json",
    "a/credentials.json",
    ".credentials.json",
    "certs/server.pem",
    "id.key",
]

CLEAN = [
    ".env.example",
    "tools/.env.example",
    "README.md",
    "tools/check_env.py",
    "docs/env-notes.md",
    "src/environment.ts",
    "src/key.ts",
    "tokens/README.md",
]


@pytest.mark.parametrize("path", LEAKED)
def test_private_path_is_flagged(path):
    assert leaked_paths([path]) == [path]


@pytest.mark.parametrize("path", CLEAN)
def test_ordinary_path_is_not_flagged(path):
    assert leaked_paths([path]) == []


def _git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def test_main_flags_force_added_file_in_real_repo(tmp_path, capsys):
    _git(tmp_path, "init", "-q")
    (tmp_path / "README.md").write_text("x\n")
    (tmp_path / ".env.local").write_text("SECRET=sk-SECRET-123\n")
    _git(tmp_path, "add", "-f", "README.md", ".env.local")
    code = main(["--repo", str(tmp_path)])
    out, err = capsys.readouterr()
    assert code == 1
    assert "LEAKED: .env.local" in err
    assert "sk-SECRET-123" not in out + err


def test_main_clean_repo_exits_0(tmp_path, capsys):
    _git(tmp_path, "init", "-q")
    (tmp_path / ".env.example").write_text("A=\n")
    _git(tmp_path, "add", ".env.example")
    assert main(["--repo", str(tmp_path)]) == 0
    assert "OK" in capsys.readouterr().out


def test_pitwall_skill_folder_allowed():
    assert leaked_paths([".claude/skills/pitwall-add-feature/SKILL.md"]) == []


def test_other_claude_skill_still_flagged():
    path = ".claude/skills/account-recovery/SKILL.md"
    assert leaked_paths([path]) == [path]
