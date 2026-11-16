from pathlib import Path

from tools.check_env import main, missing_keys


def _write(path: Path, text: str) -> Path:
    path.write_text(text, encoding="utf-8")
    return path


def test_all_keys_present_returns_empty(tmp_path):
    example = _write(tmp_path / ".env.example", "A=\nB=\n")
    env = _write(tmp_path / ".env", "A=1\nB=\n")
    assert missing_keys(example, env) == []


def test_missing_key_reported_by_name(tmp_path):
    example = _write(tmp_path / ".env.example", "A=\nB=\n")
    env = _write(tmp_path / ".env", "A=1\n")
    assert missing_keys(example, env) == ["B"]


def test_comments_blank_lines_and_export_prefix_ignored(tmp_path):
    example = _write(tmp_path / ".env.example", "# note\n\nexport A=\n")
    env = _write(tmp_path / ".env", "A=x\n")
    assert missing_keys(example, env) == []


def test_bom_and_crlf_env_file_parses(tmp_path):
    example = _write(tmp_path / ".env.example", "A=\nB=\n")
    env = tmp_path / ".env"
    env.write_bytes(b"\xef\xbb\xbfA=1\r\nB=2\r\n")
    assert missing_keys(example, env) == []


def test_main_never_prints_values(tmp_path, capsys):
    example = _write(tmp_path / ".env.example", "A=\nB=\n")
    env = _write(tmp_path / ".env", "A=sk-SECRET-123\n")
    code = main(["--example", str(example), "--env", str(env)])
    out, err = capsys.readouterr()
    assert code == 1
    assert "sk-SECRET-123" not in out + err
    assert "MISSING: B" in err


def test_main_missing_env_file_exits_2_with_hint(tmp_path, capsys):
    example = _write(tmp_path / ".env.example", "A=\n")
    code = main(["--example", str(example), "--env", str(tmp_path / "nope")])
    _, err = capsys.readouterr()
    assert code == 2
    assert "cp .env.example .env" in err
