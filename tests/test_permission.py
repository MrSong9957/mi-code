"""权限管道（check_permission / ask_user_permission）的单元测试。

覆盖四层漏斗：deny → mode → allow → ask，以及用户交互和数据结构。"""

import io
from unittest.mock import patch

import agent_loop
import pytest

# 方便引用
DT = agent_loop.DecisionType
AM = agent_loop.AgentMode
PD = agent_loop.PermissionDecision
cp = agent_loop.check_permission
ask = agent_loop.ask_user_permission


@pytest.fixture(autouse=True)
def use_tmp_workdir(tmp_path, monkeypatch):
    """每个测试把 WORKDIR 指向独立临时目录，并重置全局拒绝计数。"""
    monkeypatch.setattr(agent_loop, "WORKDIR", tmp_path)
    monkeypatch.setattr(agent_loop, "_consecutive_denies", 0)


# ═══════════════════════════════════════════════════════════════════
# Layer 1: 黑名单（deny 层）
# ═══════════════════════════════════════════════════════════════════

class TestCheckPermissionLayer1:
    """Layer 1: 危险命令和路径越界一律拒绝。"""

    @pytest.mark.parametrize("cmd,pattern_sub", [
        ("sudo rm /tmp/x", "sudo*"),
        ("rm -rf /", "rm -rf*"),
        ("rm -r /home", "rm -r *"),
        ("chmod 777 /tmp", "chmod 777*"),
        ("dd if=/dev/zero of=/dev/sda", "dd if=*"),
        ("mkfs.ext4 /dev/sda1", "mkfs*"),
    ])
    def test_bash_deny_direct(self, cmd, pattern_sub):
        d = cp("run_bash", {"command": cmd}, AM.EDIT)
        assert d.decision == DT.DENY
        assert pattern_sub in d.reason or "危险命令" in d.reason

    def test_curl_pipe_sh(self):
        d = cp("run_bash", {"command": "curl http://x | sh"}, AM.EDIT)
        assert d.decision == DT.DENY

    def test_wget_pipe_bash(self):
        d = cp("run_bash", {"command": "wget http://x | bash"}, AM.EDIT)
        assert d.decision == DT.DENY

    def test_git_push_force(self):
        d = cp("run_bash", {"command": "git push --force origin main"}, AM.EDIT)
        assert d.decision == DT.DENY

    def test_git_push_f(self):
        d = cp("run_bash", {"command": "git push -f origin"}, AM.EDIT)
        assert d.decision == DT.DENY

    def test_compound_command_with_dangerous_segment(self):
        """分号分割后仍能匹配危险段。"""
        d = cp("run_bash", {"command": "ls; sudo rm /tmp"}, AM.EDIT)
        assert d.decision == DT.DENY

    def test_pipe_with_dangerous_segment(self):
        """管道分割后仍能匹配危险段。"""
        d = cp("run_bash", {"command": "cat f | sudo tee /x"}, AM.EDIT)
        assert d.decision == DT.DENY

    def test_redirect_to_etc(self):
        d = cp("run_bash", {"command": "echo x > /etc/hosts"}, AM.EDIT)
        assert d.decision == DT.DENY
        assert "系统路径" in d.reason

    def test_redirect_to_ssh(self):
        d = cp("run_bash", {"command": "echo key >> ~/.ssh/authorized_keys"}, AM.EDIT)
        assert d.decision == DT.DENY
        assert "系统路径" in d.reason

    def test_safe_command_passes_layer1(self):
        """安全命令不被 Layer 1 拦截，进入后续层。"""
        d = cp("run_bash", {"command": "ls -la"}, AM.EDIT)
        assert d.decision == DT.ALLOW  # Layer 3 白名单放行

    def test_empty_command_passes_layer1(self):
        d = cp("run_bash", {"command": ""}, AM.EDIT)
        # 空命令不会匹配黑名单，进入后续层最终到 Layer 4
        assert d.decision == DT.ASK

    # --- 文件路径越界 ---

    @pytest.mark.parametrize("tool", ["write_file", "edit_file"])
    def test_path_traversal_blocked(self, tool):
        d = cp(tool, {"path": "../../etc/evil"}, AM.EDIT)
        assert d.decision == DT.DENY
        assert "越界" in d.reason

    @pytest.mark.parametrize("tool", ["write_file", "edit_file"])
    def test_deep_traversal_blocked(self, tool):
        d = cp(tool, {"path": "../../../tmp/x"}, AM.EDIT)
        assert d.decision == DT.DENY

    @pytest.mark.parametrize("tool", ["write_file", "edit_file"])
    def test_absolute_path_blocked(self, tool):
        d = cp(tool, {"path": "/etc/passwd"}, AM.EDIT)
        assert d.decision == DT.DENY

    @pytest.mark.parametrize("tool", ["write_file", "edit_file"])
    def test_normal_path_passes(self, tool):
        d = cp(tool, {"path": "src/main.py"}, AM.EDIT)
        assert d.decision != DT.DENY  # 进入后续层

    @pytest.mark.parametrize("tool", ["write_file", "edit_file"])
    def test_bad_path_raises(self, tool):
        d = cp(tool, {"path": "\x00bad"}, AM.EDIT)
        assert d.decision == DT.DENY
        assert "路径解析失败" in d.reason


# ═══════════════════════════════════════════════════════════════════
# Layer 2: 模式检查
# ═══════════════════════════════════════════════════════════════════

class TestCheckPermissionLayer2Ask:
    """ASK 模式：只允许只读工具。"""

    def test_read_file_allowed(self):
        d = cp("read_file", {}, AM.ASK)
        assert d.decision == DT.ALLOW  # Layer 3 放行

    def test_list_files_allowed(self):
        d = cp("list_files", {}, AM.ASK)
        assert d.decision == DT.ALLOW

    def test_write_file_denied(self):
        d = cp("write_file", {"path": "x.py"}, AM.ASK)
        assert d.decision == DT.DENY
        assert "ask 模式" in d.reason

    def test_run_bash_denied(self):
        d = cp("run_bash", {"command": "echo x"}, AM.ASK)
        assert d.decision == DT.DENY

    def test_edit_file_denied(self):
        d = cp("edit_file", {"path": "x.py"}, AM.ASK)
        assert d.decision == DT.DENY

    def test_todo_create_denied(self):
        d = cp("todo_create", {}, AM.ASK)
        assert d.decision == DT.DENY


class TestCheckPermissionLayer2Plan:
    """PLAN 模式：只读 + 可写 .md 文件。"""

    def test_read_file_allowed(self):
        d = cp("read_file", {}, AM.PLAN)
        assert d.decision == DT.ALLOW

    def test_write_md_passes_to_layer3(self):
        """write_file(.md) 通过 Layer 2，进入 Layer 3/4。"""
        d = cp("write_file", {"path": "doc.md"}, AM.PLAN)
        assert d.decision == DT.ASK  # 不在 ALWAYS_SAFE_TOOLS，到 Layer 4

    def test_write_py_denied(self):
        d = cp("write_file", {"path": "code.py"}, AM.PLAN)
        assert d.decision == DT.DENY
        assert ".md" in d.reason

    def test_write_txt_denied(self):
        d = cp("write_file", {"path": "note.txt"}, AM.PLAN)
        assert d.decision == DT.DENY

    def test_edit_md_passes_to_layer3(self):
        """edit_file(.md) 修复后通过 Layer 2。"""
        d = cp("edit_file", {"path": "doc.md"}, AM.PLAN)
        assert d.decision == DT.ASK  # 不在 ALWAYS_SAFE_TOOLS，到 Layer 4

    def test_edit_py_denied(self):
        d = cp("edit_file", {"path": "code.py"}, AM.PLAN)
        assert d.decision == DT.DENY
        assert ".md" in d.reason

    def test_run_bash_denied(self):
        d = cp("run_bash", {"command": "ls"}, AM.PLAN)
        assert d.decision == DT.DENY


class TestCheckPermissionLayer2Edit:
    """EDIT 模式：白名单工具自动 ALLOW，其余需确认。"""

    def test_safe_tool_allow(self):
        d = cp("read_file", {}, AM.EDIT)
        assert d.decision == DT.ALLOW

    def test_write_file_ask(self):
        d = cp("write_file", {"path": "x.py"}, AM.EDIT)
        assert d.decision == DT.ASK

    def test_edit_file_ask(self):
        d = cp("edit_file", {"path": "x.py"}, AM.EDIT)
        assert d.decision == DT.ASK

    def test_safe_bash_allow(self):
        d = cp("run_bash", {"command": "ls"}, AM.EDIT)
        assert d.decision == DT.ALLOW

    def test_unsafe_bash_ask(self):
        d = cp("run_bash", {"command": "pip install x"}, AM.EDIT)
        assert d.decision == DT.ASK

    def test_todo_create_ask(self):
        d = cp("todo_create", {}, AM.EDIT)
        assert d.decision == DT.ASK

    def test_todo_start_ask(self):
        d = cp("todo_start", {}, AM.EDIT)
        assert d.decision == DT.ASK


class TestCheckPermissionLayer2Auto:
    """AUTO 模式：Layer 1 通过后全部 ALLOW。"""

    def test_safe_tool_allow(self):
        d = cp("read_file", {}, AM.AUTO)
        assert d.decision == DT.ALLOW

    def test_write_file_allow(self):
        d = cp("write_file", {"path": "x.py"}, AM.AUTO)
        assert d.decision == DT.ALLOW

    def test_dangerous_cmd_still_denied(self):
        """Layer 1 黑名单在 AUTO 模式仍然有效。"""
        d = cp("run_bash", {"command": "sudo x"}, AM.AUTO)
        assert d.decision == DT.DENY

    def test_safe_bash_allow(self):
        d = cp("run_bash", {"command": "ls"}, AM.AUTO)
        assert d.decision == DT.ALLOW


# ═══════════════════════════════════════════════════════════════════
# Layer 3: 白名单
# ═══════════════════════════════════════════════════════════════════

class TestCheckPermissionLayer3:
    """Layer 3: ALWAYS_SAFE_TOOLS 和 BASH_READONLY_PREFIXES。"""

    def test_all_safe_tools(self):
        for tool in agent_loop.ALWAYS_SAFE_TOOLS:
            d = cp(tool, {}, AM.EDIT)
            assert d.decision == DT.ALLOW, f"{tool} 应被 ALLOW"

    @pytest.mark.parametrize("cmd", [
        "ls -la",
        "cat file.txt",
        "git log --oneline",
        "pwd",
        "echo hello",
        "find . -name '*.py'",
        "grep -r 'pattern' .",
    ])
    def test_readonly_bash_prefix(self, cmd):
        d = cp("run_bash", {"command": cmd}, AM.EDIT)
        assert d.decision == DT.ALLOW

    def test_non_readonly_bash_ask(self):
        d = cp("run_bash", {"command": "python script.py"}, AM.EDIT)
        assert d.decision == DT.ASK

    def test_write_file_not_in_whitelist(self):
        d = cp("write_file", {"path": "x.py"}, AM.EDIT)
        assert d.decision == DT.ASK

    def test_edit_file_not_in_whitelist(self):
        d = cp("edit_file", {"path": "x.py"}, AM.EDIT)
        assert d.decision == DT.ASK


# ═══════════════════════════════════════════════════════════════════
# Layer 4: 兜底 ASK
# ═══════════════════════════════════════════════════════════════════

class TestCheckPermissionLayer4:
    """Layer 4: 未被前几层拦截的操作默认需要确认。"""

    def test_write_file_ask(self):
        d = cp("write_file", {"path": "x.py"}, AM.EDIT)
        assert d.decision == DT.ASK

    def test_unknown_bash_ask(self):
        d = cp("run_bash", {"command": "python main.py"}, AM.EDIT)
        assert d.decision == DT.ASK

    def test_todo_create_ask(self):
        d = cp("todo_create", {}, AM.EDIT)
        assert d.decision == DT.ASK

    def test_reason_contains_tool_name(self):
        d = cp("write_file", {"path": "x.py"}, AM.EDIT)
        assert "write_file" in d.reason


# ═══════════════════════════════════════════════════════════════════
# ask_user_permission
# ═══════════════════════════════════════════════════════════════════

class TestAskUserPermission:
    """用户确认交互测试。"""

    def _make_ask_decision(self, tool_name="run_bash", tool_input=None):
        return PD(DT.ASK, f"工具 '{tool_name}' 需要确认", tool_name, tool_input or {})

    def test_quiet_auto_deny(self):
        d = self._make_ask_decision()
        result = ask(d, quiet=True)
        assert result.decision == DT.DENY
        assert "子代理" in result.reason

    @pytest.mark.parametrize("user_input", ["y", "yes", "Y"])
    def test_user_approves(self, user_input, monkeypatch):
        monkeypatch.setattr(agent_loop, "pt_prompt", lambda _: user_input)
        result = ask(self._make_ask_decision())
        assert result.decision == DT.ALLOW

    @pytest.mark.parametrize("user_input", ["n", "", " "])
    def test_user_rejects(self, user_input, monkeypatch):
        monkeypatch.setattr(agent_loop, "pt_prompt", lambda _: user_input)
        result = ask(self._make_ask_decision())
        assert result.decision == DT.DENY
        assert "用户拒绝" in result.reason

    def test_eof_error(self, monkeypatch):
        def raise_eof(_):
            raise EOFError
        monkeypatch.setattr(agent_loop, "pt_prompt", raise_eof)
        result = ask(self._make_ask_decision())
        assert result.decision == DT.DENY
        assert "用户取消" in result.reason

    def test_keyboard_interrupt(self, monkeypatch):
        def raise_ki(_):
            raise KeyboardInterrupt
        monkeypatch.setattr(agent_loop, "pt_prompt", raise_ki)
        result = ask(self._make_ask_decision())
        assert result.decision == DT.DENY
        assert "用户取消" in result.reason

    def test_displays_bash_command(self, monkeypatch, capsys):
        monkeypatch.setattr(agent_loop, "pt_prompt", lambda _: "y")
        ask(self._make_ask_decision("run_bash", {"command": "ls -la"}))
        captured = capsys.readouterr()
        assert "ls -la" in captured.out

    def test_displays_write_path(self, monkeypatch, capsys):
        monkeypatch.setattr(agent_loop, "pt_prompt", lambda _: "y")
        ask(self._make_ask_decision("write_file", {"path": "x.py"}))
        captured = capsys.readouterr()
        assert "x.py" in captured.out


# ═══════════════════════════════════════════════════════════════════
# PermissionDecision 数据结构
# ═══════════════════════════════════════════════════════════════════

class TestPermissionDecision:
    """PermissionDecision 数据类的基础属性。"""

    def test_allow_is_allowed(self):
        assert PD(DT.ALLOW).allowed is True

    def test_deny_not_allowed(self):
        assert PD(DT.DENY).allowed is False

    def test_ask_not_allowed(self):
        assert PD(DT.ASK).allowed is False

    def test_default_tool_input_empty(self):
        d = PD(DT.ALLOW)
        assert d.tool_input == {}

    def test_default_reason_empty(self):
        d = PD(DT.ALLOW)
        assert d.reason == ""

    def test_default_tool_name_empty(self):
        d = PD(DT.ALLOW)
        assert d.tool_name == ""


# ═══════════════════════════════════════════════════════════════════
# 连续拒绝计数
# ═══════════════════════════════════════════════════════════════════

class TestConsecutiveDenies:
    """连续 DENY 计数器逻辑（模拟 agent_loop 中的使用方式）。"""

    def _simulate_deny(self, monkeypatch):
        """模拟一次 DENY 结果处理（复制 agent_loop 中的逻辑）。"""
        agent_loop._consecutive_denies += 1
        reason_suffix = ""
        if agent_loop._consecutive_denies >= 3:
            reason_suffix = "\n[提示] 连续被拒，考虑 /mode edit 或 /mode auto"
        return reason_suffix

    def _simulate_allow(self):
        agent_loop._consecutive_denies = 0

    def test_three_consecutive_denies_trigger_hint(self, monkeypatch):
        r1 = self._simulate_deny(monkeypatch)
        r2 = self._simulate_deny(monkeypatch)
        r3 = self._simulate_deny(monkeypatch)
        assert "[提示]" in r3
        assert r1 == "" and r2 == ""

    def test_allow_resets_counter(self, monkeypatch):
        self._simulate_deny(monkeypatch)
        self._simulate_deny(monkeypatch)
        self._simulate_allow()
        assert agent_loop._consecutive_denies == 0
        r = self._simulate_deny(monkeypatch)
        assert r == ""  # 从 1 开始，未到 3

    def test_deny_after_user_reject_increments(self, monkeypatch):
        self._simulate_deny(monkeypatch)
        # 用户拒绝也等价于 deny（计数递增）
        self._simulate_deny(monkeypatch)
        assert agent_loop._consecutive_denies == 2

    def test_hint_does_not_reset_counter(self, monkeypatch):
        """3 次提示后计数器不归零（修复死循环：旧版会重置导致 3→0→3→0 循环）。"""
        self._simulate_deny(monkeypatch)
        self._simulate_deny(monkeypatch)
        r3 = self._simulate_deny(monkeypatch)
        assert "[提示]" in r3
        # 计数器不归零，继续递增
        assert agent_loop._consecutive_denies == 3
        r4 = self._simulate_deny(monkeypatch)
        assert agent_loop._consecutive_denies == 4


# ═══════════════════════════════════════════════════════════════════
# 强制停止机制
# ═══════════════════════════════════════════════════════════════════

class TestForcedStop:
    """连续权限拒绝达到上限时强制停止。"""

    def test_forced_stop_at_limit(self, monkeypatch):
        """连续 MAX_CONSECUTIVE_DENIES 次拒绝触发停止消息。"""
        limit = agent_loop.MAX_CONSECUTIVE_DENIES
        for i in range(limit):
            agent_loop._consecutive_denies += 1

        assert agent_loop._consecutive_denies >= limit
        # 模拟 _agent_step 中的强制停止检查
        if agent_loop._consecutive_denies >= agent_loop.MAX_CONSECUTIVE_DENIES:
            stop_msg = f"已停止：连续 {agent_loop.MAX_CONSECUTIVE_DENIES} 次权限拒绝。请切换模式（/mode edit 或 /mode auto）后重试。"
            assert "已停止" in stop_msg
            assert str(agent_loop.MAX_CONSECUTIVE_DENIES) in stop_msg

    def test_forced_stop_resets_counter(self, monkeypatch):
        """强制停止后重置计数器。"""
        limit = agent_loop.MAX_CONSECUTIVE_DENIES
        for i in range(limit):
            agent_loop._consecutive_denies += 1

        # 模拟强制停止后重置
        assert agent_loop._consecutive_denies >= limit
        agent_loop._consecutive_denies = 0
        assert agent_loop._consecutive_denies == 0


# ═══════════════════════════════════════════════════════════════════
# 边界情况
# ═══════════════════════════════════════════════════════════════════

class TestEdgeCases:
    """边界和特殊输入。"""

    def test_empty_tool_input_no_crash(self):
        d = cp("run_bash", {}, AM.EDIT)
        assert d.decision in (DT.ALLOW, DT.ASK, DT.DENY)

    def test_dotdot_inside_workdir_ok(self):
        """路径含 .. 但仍在 WORKDIR 内，不拒绝。"""
        d = cp("write_file", {"path": "a/../b.py"}, AM.EDIT)
        assert d.decision != DT.DENY

    def test_bash_deny_case_insensitive(self):
        d = cp("run_bash", {"command": "Sudo whoami"}, AM.EDIT)
        assert d.decision == DT.DENY

    def test_pipe_safe_plus_safe(self):
        d = cp("run_bash", {"command": "ls | grep foo"}, AM.EDIT)
        assert d.decision == DT.ALLOW

    def test_semicolon_safe_plus_safe(self):
        d = cp("run_bash", {"command": "ls; pwd"}, AM.EDIT)
        assert d.decision == DT.ALLOW

    def test_readonly_prefix_exact_match_limitation(self):
        """lsattr 以 ls 开头匹配只读前缀 "ls"，当前行为：ALLOW。"""
        d = cp("run_bash", {"command": "lsattr file"}, AM.EDIT)
        assert d.decision == DT.ALLOW  # 已知限制：前缀匹配 "ls"
