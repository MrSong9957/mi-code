"""write_file 和 edit_file 工具的单元测试。"""

import agent_loop


# --- 每个测试把 WORKDIR 指向独立临时目录，互不干扰 ---
import pytest

@pytest.fixture(autouse=True)
def use_tmp_workdir(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_loop, "WORKDIR", tmp_path)


# ─── write_file ─────────────────────────────────────────────────────

class TestWriteFile:
    """write_file: 创建新文件、覆写已有文件、自动建目录、路径安全"""

    def test_create_new_file(self, tmp_path):
        result = agent_loop.write_file("hello.py", "print('hello')")
        assert "已写入" in result
        assert (tmp_path / "hello.py").read_text() == "print('hello')"

    def test_overwrite_existing(self, tmp_path):
        (tmp_path / "cfg.txt").write_text("old", encoding="utf-8")
        result = agent_loop.write_file("cfg.txt", "new")
        assert "已写入" in result
        assert (tmp_path / "cfg.txt").read_text() == "new"

    def test_create_nested_dirs(self, tmp_path):
        result = agent_loop.write_file("a/b/c.py", "pass")
        assert "已写入" in result
        assert (tmp_path / "a/b/c.py").read_text() == "pass"

    def test_empty_content(self, tmp_path):
        result = agent_loop.write_file("empty.txt", "")
        assert "已写入" in result
        assert (tmp_path / "empty.txt").read_text() == ""

    def test_path_traversal_blocked(self):
        result = agent_loop.write_file("../../etc/evil.txt", "hacked")
        assert "错误" in result
        assert "路径越界" in result

    def test_returns_line_count(self, tmp_path):
        content = "line1\nline2\nline3\n"
        result = agent_loop.write_file("multi.txt", content)
        assert "3 行" in result
        assert f"{len(content)} 字符" in result


# ─── edit_file ──────────────────────────────────────────────────────

class TestEditFile:
    """edit_file: 精确替换、安全检查、只替换首次、错误处理"""

    def test_simple_replacement(self, tmp_path):
        (tmp_path / "code.py").write_text("x = 1\ny = 2\n", encoding="utf-8")
        result = agent_loop.edit_file("code.py", "x = 1", "x = 42")
        assert "已编辑" in result
        assert (tmp_path / "code.py").read_text() == "x = 42\ny = 2\n"

    def test_multiline_replacement(self, tmp_path):
        (tmp_path / "code.py").write_text("def foo():\n    return 1\n", encoding="utf-8")
        old = "def foo():\n    return 1"
        new = "def foo():\n    return 2"
        result = agent_loop.edit_file("code.py", old, new)
        assert "已编辑" in result
        assert "return 2" in (tmp_path / "code.py").read_text()

    def test_old_text_not_found(self, tmp_path):
        (tmp_path / "f.txt").write_text("hello", encoding="utf-8")
        result = agent_loop.edit_file("f.txt", "world", "new")
        assert "错误" in result
        assert "未找到" in result
        # 文件内容不变
        assert (tmp_path / "f.txt").read_text() == "hello"

    def test_replaces_only_first_match(self, tmp_path):
        (tmp_path / "f.txt").write_text("aaa\naaa\naaa\n", encoding="utf-8")
        result = agent_loop.edit_file("f.txt", "aaa", "bbb")
        assert "已编辑" in result
        assert (tmp_path / "f.txt").read_text() == "bbb\naaa\naaa\n"

    def test_file_not_found(self):
        result = agent_loop.edit_file("nope.txt", "old", "new")
        assert "错误" in result
        assert "不存在" in result

    def test_path_traversal_blocked(self):
        result = agent_loop.edit_file("../../etc/passwd", "old", "new")
        assert "错误" in result
        assert "路径越界" in result
