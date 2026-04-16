"""子智能体（Sub-Agent）功能的单元测试。"""

import agent_loop
import pytest
from unittest.mock import MagicMock, patch


class TestToolRegistration:
    """task 工具的注册和工具过滤。"""

    def test_parent_has_task_tool(self):
        """父智能体工具列表包含 task。"""
        names = [t["name"] for t in agent_loop._MAIN_TOOLS]
        assert "task" in names

    def test_sub_agent_has_no_task_tool(self):
        """过滤后的子智能体工具列表不含 task。"""
        sub_tools = [t for t in agent_loop._TOOL_SCHEMAS if t["name"] != "task"]
        names = [t["name"] for t in sub_tools]
        assert "task" not in names

    def test_sub_agent_has_all_other_tools(self):
        """子智能体拥有除 task 外的全部工具。"""
        parent_names = {t["name"] for t in agent_loop._TOOL_SCHEMAS}
        sub_tools = [t for t in agent_loop._TOOL_SCHEMAS if t["name"] != "task"]
        sub_names = {t["name"] for t in sub_tools}
        assert sub_names == parent_names - {"task"}

    def test_task_schema_valid(self):
        """task 工具 schema 包含 name、description、input_schema。"""
        task_schema = next(t for t in agent_loop._TOOL_SCHEMAS if t["name"] == "task")
        assert "name" in task_schema
        assert "description" in task_schema
        assert "input_schema" in task_schema
        assert "description" in task_schema["input_schema"]["properties"]
        assert task_schema["input_schema"]["required"] == ["description"]


class TestTaskTool:
    """task 工具的执行逻辑（使用 mock client）。"""

    def _make_mock_client(self, text="子任务完成"):
        """创建 mock client，返回 end_turn + 文本。"""
        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = text

        response = MagicMock()
        response.content = [text_block]
        response.stop_reason = "end_turn"

        client = MagicMock()
        client.messages.create.return_value = response
        return client

    def test_task_returns_sub_agent_output(self):
        """task 工具返回子智能体的最终文本。"""
        client = self._make_mock_client("分析完成：共 3 个文件")
        agent_loop._client = client

        result = agent_loop.task_tool({"description": "列出所有 Python 文件"})
        assert "分析完成：共 3 个文件" in result

    def test_sub_agent_uses_filtered_tools(self):
        """子智能体 API 调用时 tools 参数不含 task。"""
        client = self._make_mock_client()
        agent_loop._client = client

        agent_loop.task_tool({"description": "读取 README.md"})

        call_kwargs = client.messages.create.call_args
        tools_passed = call_kwargs.kwargs.get("tools", call_kwargs[1].get("tools", []))
        tool_names = [t["name"] for t in tools_passed]
        assert "task" not in tool_names

    def test_sub_agent_has_own_messages(self):
        """子智能体的 messages 以 description 开始，独立于父智能体。"""
        client = self._make_mock_client()
        agent_loop._client = client

        agent_loop.task_tool({"description": "搜索 TODO 注释"})

        call_kwargs = client.messages.create.call_args
        messages = call_kwargs.kwargs.get("messages", call_kwargs[1].get("messages", []))
        # 第一条消息的 content 应该是子任务描述
        assert messages[0]["role"] == "user"
        assert messages[0]["content"] == "搜索 TODO 注释"

    def test_sub_agent_uses_sub_agent_system(self):
        """子智能体使用 SUB_AGENT_SYSTEM 而非 SYSTEM_PROMPT。"""
        client = self._make_mock_client()
        agent_loop._client = client

        agent_loop.task_tool({"description": "测试"})

        call_kwargs = client.messages.create.call_args
        system = call_kwargs.kwargs.get("system", call_kwargs[1].get("system"))
        assert system == agent_loop.SUB_AGENT_SYSTEM
