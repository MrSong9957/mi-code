"""SkillManager 技能系统的单元测试。"""

import agent_loop
from pathlib import Path


# ─── 辅助 ──────────────────────────────────────────────────────────

def make_skill(path: Path, name: str, description: str = "", body: str = "") -> Path:
    """在指定路径创建一个技能文件。"""
    content = f"---\nname: {name}\ndescription: {description}\n---\n{body}"
    path.write_text(content, encoding="utf-8")
    return path


# ─── _parse_skill_file 解析测试 ─────────────────────────────────────

class TestParseSkillFile:
    """_parse_skill_file: YAML frontmatter 解析，正常/边界/异常"""

    def test_parse_valid_file(self, tmp_path):
        f = make_skill(tmp_path / "s.md", "my-skill", "做某事", "正文内容")
        result = agent_loop.SkillManager(tmp_path)._parse_skill_file(f)
        assert result == {"name": "my-skill", "description": "做某事", "body": "正文内容"}

    def test_parse_without_description(self, tmp_path):
        f = tmp_path / "s.md"
        f.write_text("---\nname: only-name\n---\n正文", encoding="utf-8")
        result = agent_loop.SkillManager(tmp_path)._parse_skill_file(f)
        assert result["name"] == "only-name"
        assert result["description"] == ""

    def test_parse_with_empty_body(self, tmp_path):
        f = tmp_path / "s.md"
        f.write_text("---\nname: empty-body\ndescription: 无正文\n---\n", encoding="utf-8")
        result = agent_loop.SkillManager(tmp_path)._parse_skill_file(f)
        assert result["name"] == "empty-body"
        assert result["body"] == ""

    def test_parse_multiline_body(self, tmp_path):
        body = "第一行\n第二行\n第三行"
        f = make_skill(tmp_path / "s.md", "multi", "多行", body)
        result = agent_loop.SkillManager(tmp_path)._parse_skill_file(f)
        assert result["body"] == "第一行\n第二行\n第三行"

    def test_reject_missing_frontmatter(self, tmp_path):
        f = tmp_path / "s.md"
        f.write_text("name: no-frontmatter\ndescription: 没有分隔符", encoding="utf-8")
        result = agent_loop.SkillManager(tmp_path)._parse_skill_file(f)
        assert result is None

    def test_reject_missing_name(self, tmp_path):
        f = tmp_path / "s.md"
        f.write_text("---\ndescription: 只有描述\n---\n正文", encoding="utf-8")
        result = agent_loop.SkillManager(tmp_path)._parse_skill_file(f)
        assert result is None

    def test_reject_missing_closing_delimiter(self, tmp_path):
        f = tmp_path / "s.md"
        f.write_text("---\nname: no-end\ndescription: 没有关闭分隔符", encoding="utf-8")
        result = agent_loop.SkillManager(tmp_path)._parse_skill_file(f)
        assert result is None

    def test_reject_empty_file(self, tmp_path):
        f = tmp_path / "s.md"
        f.write_text("", encoding="utf-8")
        result = agent_loop.SkillManager(tmp_path)._parse_skill_file(f)
        assert result is None

    def test_reject_nonexistent_file(self, tmp_path):
        result = agent_loop.SkillManager(tmp_path)._parse_skill_file(tmp_path / "nope.md")
        assert result is None


# ─── _scan_skills 扫描测试 ─────────────────────────────────────────

class TestScanSkills:
    """_scan_skills: 目录扫描，过滤，排序"""

    def test_scan_finds_skills(self, tmp_path):
        make_skill(tmp_path / "a.md", "skill-a", "技能A", "正文A")
        make_skill(tmp_path / "b.md", "skill-b", "技能B", "正文B")
        result = agent_loop.SkillManager(tmp_path)._scan_skills()
        assert len(result) == 2
        assert result[0]["name"] == "skill-a"
        assert result[1]["name"] == "skill-b"

    def test_scan_returns_only_metadata(self, tmp_path):
        make_skill(tmp_path / "s.md", "test", "描述", "不应该出现的正文")
        result = agent_loop.SkillManager(tmp_path)._scan_skills()
        assert "body" not in result[0]
        assert result[0] == {"name": "test", "description": "描述"}

    def test_scan_skips_invalid_files(self, tmp_path):
        make_skill(tmp_path / "valid.md", "good", "有效技能")
        (tmp_path / "invalid.md").write_text("这不是技能文件", encoding="utf-8")
        result = agent_loop.SkillManager(tmp_path)._scan_skills()
        assert len(result) == 1
        assert result[0]["name"] == "good"

    def test_scan_empty_directory(self, tmp_path):
        result = agent_loop.SkillManager(tmp_path)._scan_skills()
        assert result == []

    def test_scan_nonexistent_directory(self, tmp_path):
        result = agent_loop.SkillManager(tmp_path / "nope")._scan_skills()
        assert result == []

    def test_scan_ignores_subdirectories(self, tmp_path):
        make_skill(tmp_path / "s.md", "file-skill", "文件技能")
        (tmp_path / "subdir").mkdir()
        make_skill(tmp_path / "subdir" / "nested.md", "nested", "嵌套技能")
        result = agent_loop.SkillManager(tmp_path)._scan_skills()
        assert len(result) == 1
        assert result[0]["name"] == "file-skill"

    def test_scan_sorted_by_filename(self, tmp_path):
        make_skill(tmp_path / "c.md", "z-skill", "最后")
        make_skill(tmp_path / "a.md", "a-skill", "最前")
        make_skill(tmp_path / "b.md", "m-skill", "中间")
        result = agent_loop.SkillManager(tmp_path)._scan_skills()
        assert result[0]["name"] == "a-skill"
        assert result[1]["name"] == "m-skill"
        assert result[2]["name"] == "z-skill"


# ─── list_skills 注册表测试 ────────────────────────────────────────

class TestListSkills:
    """list_skills: 格式化输出技能注册表"""

    def test_list_with_skills(self, tmp_path):
        make_skill(tmp_path / "a.md", "git-flow", "Git 工作流")
        make_skill(tmp_path / "b.md", "code-review", "代码审查")
        mgr = agent_loop.SkillManager(tmp_path)
        result = mgr.list_skills()
        assert "可用技能：" in result
        assert "git-flow: Git 工作流" in result
        assert "code-review: 代码审查" in result

    def test_list_empty_directory(self, tmp_path):
        mgr = agent_loop.SkillManager(tmp_path)
        result = mgr.list_skills()
        assert "skills/ 目录为空或不存在" in result

    def test_list_nonexistent_directory(self, tmp_path):
        mgr = agent_loop.SkillManager(tmp_path / "nope")
        result = mgr.list_skills()
        assert "skills/ 目录为空或不存在" in result


# ─── load 加载测试 ─────────────────────────────────────────────────

class TestLoadSkill:
    """load: 按名称加载技能完整内容"""

    def test_load_existing_skill(self, tmp_path):
        make_skill(tmp_path / "s.md", "git-flow", "Git 工作流", "使用 squash merge")
        mgr = agent_loop.SkillManager(tmp_path)
        result = mgr.load("git-flow")
        assert "技能：git-flow" in result
        assert "描述：Git 工作流" in result
        assert "使用 squash merge" in result

    def test_load_skill_without_body(self, tmp_path):
        f = tmp_path / "s.md"
        f.write_text("---\nname: no-body\ndescription: 无正文\n---\n", encoding="utf-8")
        mgr = agent_loop.SkillManager(tmp_path)
        result = mgr.load("no-body")
        assert "技能：no-body" in result
        assert "描述：无正文" in result
        # body 为空时不应有额外的空行
        lines = result.split("\n")
        assert len([l for l in lines if l.strip()]) == 2  # 只有技能和描述两行

    def test_load_nonexistent_skill_with_suggestions(self, tmp_path):
        make_skill(tmp_path / "s.md", "git-flow", "Git 工作流")
        mgr = agent_loop.SkillManager(tmp_path)
        result = mgr.load("not-exist")
        assert "错误" in result
        assert "未找到技能 'not-exist'" in result
        assert "git-flow" in result

    def test_load_nonexistent_skill_empty_dir(self, tmp_path):
        mgr = agent_loop.SkillManager(tmp_path)
        result = mgr.load("anything")
        assert "错误" in result
        assert "未找到技能" in result
        assert "anything" in result

    def test_load_from_nonexistent_directory(self, tmp_path):
        mgr = agent_loop.SkillManager(tmp_path / "nope")
        result = mgr.load("anything")
        assert "错误" in result
        assert "skills/ 目录不存在" in result

    def test_load_among_multiple_skills(self, tmp_path):
        make_skill(tmp_path / "a.md", "skill-a", "描述A", "正文A")
        make_skill(tmp_path / "b.md", "skill-b", "描述B", "正文B")
        mgr = agent_loop.SkillManager(tmp_path)
        result = mgr.load("skill-b")
        assert "技能：skill-b" in result
        assert "正文B" in result
        assert "skill-a" not in result


# ─── 工具函数委托测试 ──────────────────────────────────────────────

class TestSkillTools:
    """list_skills_tool / load_skill: 工具函数委托到 SkillManager"""

    def test_list_skills_tool_returns_registry(self, tmp_path):
        make_skill(tmp_path / "s.md", "test-skill", "测试技能")
        mgr = agent_loop.SkillManager(tmp_path)
        agent_loop._skill_mgr = mgr
        try:
            result = agent_loop.list_skills_tool({})
            assert "test-skill" in result
        finally:
            agent_loop._skill_mgr = None

    def test_list_skills_tool_when_not_initialized(self):
        agent_loop._skill_mgr = None
        result = agent_loop.list_skills_tool({})
        assert "未初始化" in result

    def test_load_skill_tool_returns_full_content(self, tmp_path):
        make_skill(tmp_path / "s.md", "test-skill", "测试", "正文内容")
        mgr = agent_loop.SkillManager(tmp_path)
        agent_loop._skill_mgr = mgr
        try:
            result = agent_loop.load_skill({"name": "test-skill"})
            assert "技能：test-skill" in result
            assert "正文内容" in result
        finally:
            agent_loop._skill_mgr = None

    def test_load_skill_tool_when_not_initialized(self):
        agent_loop._skill_mgr = None
        result = agent_loop.load_skill({"name": "test"})
        assert "未初始化" in result
