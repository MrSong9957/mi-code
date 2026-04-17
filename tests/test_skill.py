"""SkillManager 技能系统的单元测试。"""

import agent_loop
from pathlib import Path


# ─── 辅助 ──────────────────────────────────────────────────────────

SKILL_FILENAME = "SKILL.md"

def make_skill(skills_dir: Path, dirname: str, name: str, description: str = "", body: str = "") -> Path:
    """创建一个技能子目录，内含 SKILL.md。返回技能目录路径。"""
    skill_dir = skills_dir / dirname
    skill_dir.mkdir(parents=True, exist_ok=True)
    content = f"---\nname: {name}\ndescription: {description}\n---\n{body}"
    (skill_dir / SKILL_FILENAME).write_text(content, encoding="utf-8")
    return skill_dir

def make_aux_file(skill_dir: Path, filename: str, content: str) -> Path:
    """在技能目录下创建一个辅助文件。"""
    f = skill_dir / filename
    f.write_text(content, encoding="utf-8")
    return f


# ─── _parse_skill_file 解析测试 ─────────────────────────────────────

class TestParseSkillFile:
    """_parse_skill_file: YAML frontmatter 解析，正常/边界/异常"""

    def test_parse_valid_file(self, tmp_path):
        f = tmp_path / "SKILL.md"
        f.write_text("---\nname: my-skill\ndescription: 做某事\n---\n正文内容", encoding="utf-8")
        result = agent_loop.SkillManager(tmp_path)._parse_skill_file(f)
        assert result == {"name": "my-skill", "description": "做某事", "body": "正文内容"}

    def test_parse_without_description(self, tmp_path):
        f = tmp_path / "SKILL.md"
        f.write_text("---\nname: only-name\n---\n正文", encoding="utf-8")
        result = agent_loop.SkillManager(tmp_path)._parse_skill_file(f)
        assert result["name"] == "only-name"
        assert result["description"] == ""

    def test_parse_with_empty_body(self, tmp_path):
        f = tmp_path / "SKILL.md"
        f.write_text("---\nname: empty-body\ndescription: 无正文\n---\n", encoding="utf-8")
        result = agent_loop.SkillManager(tmp_path)._parse_skill_file(f)
        assert result["name"] == "empty-body"
        assert result["body"] == ""

    def test_parse_multiline_body(self, tmp_path):
        f = tmp_path / "SKILL.md"
        f.write_text("---\nname: multi\ndescription: 多行\n---\n第一行\n第二行\n第三行", encoding="utf-8")
        result = agent_loop.SkillManager(tmp_path)._parse_skill_file(f)
        assert result["body"] == "第一行\n第二行\n第三行"

    def test_reject_missing_frontmatter(self, tmp_path):
        f = tmp_path / "SKILL.md"
        f.write_text("name: no-frontmatter\ndescription: 没有分隔符", encoding="utf-8")
        assert agent_loop.SkillManager(tmp_path)._parse_skill_file(f) is None

    def test_reject_missing_name(self, tmp_path):
        f = tmp_path / "SKILL.md"
        f.write_text("---\ndescription: 只有描述\n---\n正文", encoding="utf-8")
        assert agent_loop.SkillManager(tmp_path)._parse_skill_file(f) is None

    def test_reject_missing_closing_delimiter(self, tmp_path):
        f = tmp_path / "SKILL.md"
        f.write_text("---\nname: no-end\ndescription: 没有关闭分隔符", encoding="utf-8")
        assert agent_loop.SkillManager(tmp_path)._parse_skill_file(f) is None

    def test_reject_empty_file(self, tmp_path):
        f = tmp_path / "SKILL.md"
        f.write_text("", encoding="utf-8")
        assert agent_loop.SkillManager(tmp_path)._parse_skill_file(f) is None

    def test_reject_nonexistent_file(self, tmp_path):
        assert agent_loop.SkillManager(tmp_path)._parse_skill_file(tmp_path / "nope.md") is None


# ─── _scan_skills 扫描测试 ─────────────────────────────────────────

class TestScanSkills:
    """_scan_skills: 遍历子目录，读 SKILL.md 元数据"""

    def test_scan_finds_skills(self, tmp_path):
        make_skill(tmp_path, "git-flow", "git-flow", "Git 工作流")
        make_skill(tmp_path, "code-review", "code-review", "代码审查")
        result = agent_loop.SkillManager(tmp_path)._scan_skills()
        assert len(result) == 2
        assert result[0]["name"] == "code-review"
        assert result[1]["name"] == "git-flow"

    def test_scan_returns_only_metadata(self, tmp_path):
        make_skill(tmp_path, "test", "test", "描述", "正文不应该出现")
        result = agent_loop.SkillManager(tmp_path)._scan_skills()
        assert "body" not in result[0]
        assert result[0] == {"name": "test", "description": "描述"}

    def test_scan_skips_dir_without_skill_md(self, tmp_path):
        make_skill(tmp_path, "valid", "good", "有效技能")
        (tmp_path / "empty-dir").mkdir()
        result = agent_loop.SkillManager(tmp_path)._scan_skills()
        assert len(result) == 1
        assert result[0]["name"] == "good"

    def test_scan_skips_files_at_root(self, tmp_path):
        """skills/ 根目录下的普通文件应被跳过。"""
        make_skill(tmp_path, "my-skill", "test", "测试")
        (tmp_path / "README.md").write_text("not a skill", encoding="utf-8")
        result = agent_loop.SkillManager(tmp_path)._scan_skills()
        assert len(result) == 1
        assert result[0]["name"] == "test"

    def test_scan_empty_directory(self, tmp_path):
        assert agent_loop.SkillManager(tmp_path)._scan_skills() == []

    def test_scan_nonexistent_directory(self, tmp_path):
        assert agent_loop.SkillManager(tmp_path / "nope")._scan_skills() == []

    def test_scan_sorted_by_dirname(self, tmp_path):
        make_skill(tmp_path, "c-dir", "z-skill", "最后")
        make_skill(tmp_path, "a-dir", "a-skill", "最前")
        make_skill(tmp_path, "b-dir", "m-skill", "中间")
        result = agent_loop.SkillManager(tmp_path)._scan_skills()
        assert result[0]["name"] == "a-skill"
        assert result[1]["name"] == "m-skill"
        assert result[2]["name"] == "z-skill"


# ─── _scan_aux_files 辅助文件测试 ──────────────────────────────────

class TestScanAuxFiles:
    """_scan_aux_files: 非递归扫描技能目录下的辅助文件"""

    def test_finds_aux_files(self, tmp_path):
        skill_dir = make_skill(tmp_path, "my-skill", "test", "测试")
        make_aux_file(skill_dir, "helper.sh", "#!/bin/bash\necho hello")
        result = agent_loop.SkillManager(tmp_path)._scan_aux_files(skill_dir)
        assert len(result) == 1
        assert result[0]["filename"] == "helper.sh"
        assert "#!/bin/bash" in result[0]["preview"]

    def test_skips_skill_md(self, tmp_path):
        skill_dir = make_skill(tmp_path, "my-skill", "test", "测试")
        make_aux_file(skill_dir, "helper.sh", "辅助")
        result = agent_loop.SkillManager(tmp_path)._scan_aux_files(skill_dir)
        filenames = [r["filename"] for r in result]
        assert "SKILL.md" not in filenames
        assert "helper.sh" in filenames

    def test_truncates_at_30_lines(self, tmp_path):
        skill_dir = make_skill(tmp_path, "my-skill", "test", "测试")
        lines = [f"line {i}" for i in range(50)]
        make_aux_file(skill_dir, "long.txt", "\n".join(lines))
        result = agent_loop.SkillManager(tmp_path)._scan_aux_files(skill_dir)
        preview_lines = result[0]["preview"].split("\n")
        assert len(preview_lines) == 30
        assert "line 0" in preview_lines[0]
        assert "line 29" in preview_lines[29]

    def test_no_aux_files(self, tmp_path):
        skill_dir = make_skill(tmp_path, "my-skill", "test", "测试")
        result = agent_loop.SkillManager(tmp_path)._scan_aux_files(skill_dir)
        assert result == []

    def test_skips_subdirectories(self, tmp_path):
        skill_dir = make_skill(tmp_path, "my-skill", "test", "测试")
        (skill_dir / "examples").mkdir()
        (skill_dir / "examples" / "demo.py").write_text("print('hi')", encoding="utf-8")
        result = agent_loop.SkillManager(tmp_path)._scan_aux_files(skill_dir)
        assert result == []


# ─── list_skills 注册表测试 ────────────────────────────────────────

class TestListSkills:
    """list_skills: 格式化输出技能注册表"""

    def test_list_with_skills(self, tmp_path):
        make_skill(tmp_path, "git-flow", "git-flow", "Git 工作流")
        make_skill(tmp_path, "code-review", "code-review", "代码审查")
        result = agent_loop.SkillManager(tmp_path).list_skills()
        assert "可用技能：" in result
        assert "git-flow: Git 工作流" in result
        assert "code-review: 代码审查" in result

    def test_list_empty_directory(self, tmp_path):
        result = agent_loop.SkillManager(tmp_path).list_skills()
        assert "skills/ 目录为空或不存在" in result

    def test_list_nonexistent_directory(self, tmp_path):
        result = agent_loop.SkillManager(tmp_path / "nope").list_skills()
        assert "skills/ 目录为空或不存在" in result


# ─── load 加载测试 ─────────────────────────────────────────────────

class TestLoadSkill:
    """load: 按名称加载技能 SKILL.md 全文 + 辅助文件预览"""

    def test_load_existing_skill(self, tmp_path):
        make_skill(tmp_path, "git-flow", "git-flow", "Git 工作流", "使用 squash merge")
        result = agent_loop.SkillManager(tmp_path).load("git-flow")
        assert "技能：git-flow" in result
        assert "描述：Git 工作流" in result
        assert "使用 squash merge" in result

    def test_load_with_aux_files(self, tmp_path):
        skill_dir = make_skill(tmp_path, "my-skill", "my-skill", "测试", "正文")
        make_aux_file(skill_dir, "helper.sh", "#!/bin/bash\necho hello")
        result = agent_loop.SkillManager(tmp_path).load("my-skill")
        assert "辅助文件：" in result
        assert "helper.sh" in result
        assert "#!/bin/bash" in result

    def test_load_without_aux_files(self, tmp_path):
        make_skill(tmp_path, "my-skill", "my-skill", "测试", "正文")
        result = agent_loop.SkillManager(tmp_path).load("my-skill")
        assert "辅助文件" not in result

    def test_load_skill_without_body(self, tmp_path):
        d = tmp_path / "s"
        d.mkdir()
        (d / "SKILL.md").write_text("---\nname: no-body\ndescription: 无正文\n---\n", encoding="utf-8")
        result = agent_loop.SkillManager(tmp_path).load("no-body")
        assert "技能：no-body" in result
        assert "描述：无正文" in result

    def test_load_nonexistent_skill_with_suggestions(self, tmp_path):
        make_skill(tmp_path, "git-flow", "git-flow", "Git 工作流")
        result = agent_loop.SkillManager(tmp_path).load("not-exist")
        assert "错误" in result
        assert "未找到技能 'not-exist'" in result
        assert "git-flow" in result

    def test_load_nonexistent_skill_empty_dir(self, tmp_path):
        result = agent_loop.SkillManager(tmp_path).load("anything")
        assert "错误" in result
        assert "未找到技能" in result

    def test_load_from_nonexistent_directory(self, tmp_path):
        result = agent_loop.SkillManager(tmp_path / "nope").load("anything")
        assert "错误" in result
        assert "skills/ 目录不存在" in result

    def test_load_among_multiple_skills(self, tmp_path):
        make_skill(tmp_path, "a", "skill-a", "描述A", "正文A")
        make_skill(tmp_path, "b", "skill-b", "描述B", "正文B")
        result = agent_loop.SkillManager(tmp_path).load("skill-b")
        assert "技能：skill-b" in result
        assert "正文B" in result
        assert "skill-a" not in result


# ─── 工具函数委托测试 ──────────────────────────────────────────────

class TestSkillTools:
    """list_skills_tool / load_skill: 工具函数委托到 SkillManager"""

    def test_list_skills_tool_returns_registry(self, tmp_path):
        make_skill(tmp_path, "s", "test-skill", "测试技能")
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
        make_skill(tmp_path, "s", "test-skill", "测试", "正文内容")
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


# ─── 集成测试：实际 skills/ 目录 ───────────────────────────────────

SKILLS_DIR = Path(__file__).parent.parent / "CLI" / "Python" / "skills"


class TestRealGitWorkflowSkill:
    """对实际 skills/git-workflow 技能的集成测试。"""

    @classmethod
    def setup_class(cls):
        cls.mgr = agent_loop.SkillManager(SKILLS_DIR)

    def test_skill_directory_exists(self):
        assert (SKILLS_DIR / "git-workflow").is_dir()
        assert (SKILLS_DIR / "git-workflow" / "SKILL.md").is_file()

    def test_list_skills_includes_git_workflow(self):
        result = self.mgr.list_skills()
        assert "git-workflow" in result
        assert "Git 分支管理和提交规范指导" in result

    def test_load_git_workflow_full_content(self):
        result = self.mgr.load("git-workflow")
        assert "技能：git-workflow" in result
        assert "描述：Git 分支管理和提交规范指导" in result
        assert "分支策略" in result
        assert "提交规范" in result
        assert "合并规则" in result

    def test_load_git_workflow_shows_aux_files(self):
        result = self.mgr.load("git-workflow")
        assert "辅助文件：" in result
        # 应包含辅助文件名
        assert "helper.sh" in result
        assert "commit-msg.txt" in result
        assert "empty-file.txt" in result
        assert "long-file.py" in result
        # 不应递归扫描子目录
        assert "demo.py" not in result

    def test_helper_sh_preview(self):
        """shell 脚本的前30行预览应包含 shebang 和注释。"""
        result = self.mgr.load("git-workflow")
        assert "#!/bin/bash" in result

    def test_commit_msg_preview(self):
        """有 yaml 元数据的辅助文件，前30行应包含其内容。"""
        result = self.mgr.load("git-workflow")
        assert "commit-message-template" in result

    def test_long_file_truncated(self):
        """超过30行的文件，不应包含第31行。"""
        result = self.mgr.load("git-workflow")
        assert "第31行 - 这行不应该出现在预览中" not in result
        assert "第30行" in result

    def test_empty_file_preview(self):
        """只有1行的文件，预览应正常。"""
        result = self.mgr.load("git-workflow")
        assert "这是一个空内容文件" in result

    def test_scan_skills_only_returns_metadata(self):
        """注册表只含 name + description，不含 body 和辅助文件。"""
        result = self.mgr._scan_skills()
        git_skill = next(s for s in result if s["name"] == "git-workflow")
        assert "body" not in git_skill
        assert git_skill["description"] == "Git 分支管理和提交规范指导"

    def test_aux_files_non_recursive(self):
        """辅助文件扫描不递归进入子目录。"""
        skill_dir = SKILLS_DIR / "git-workflow"
        aux = self.mgr._scan_aux_files(skill_dir)
        filenames = [a["filename"] for a in aux]
        assert "examples" not in filenames
        assert "demo.py" not in filenames
        # 只包含直接子文件
        assert sorted(filenames) == ["commit-msg.txt", "empty-file.txt", "helper.sh", "long-file.py"]

    def test_aux_files_skip_skill_md(self):
        """辅助文件列表不应包含 SKILL.md。"""
        skill_dir = SKILLS_DIR / "git-workflow"
        aux = self.mgr._scan_aux_files(skill_dir)
        filenames = [a["filename"] for a in aux]
        assert "SKILL.md" not in filenames
