"""ContextManager 全面的边界测试。"""

import json
import os
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# 从 agent_loop 导入被测对象
from agent_loop import ContextManager, MAX_TOOL_OUTPUT


@pytest.fixture
def tmp_workdir(tmp_path):
    """提供一个临时工作目录。"""
    return tmp_path


@pytest.fixture
def ctx(tmp_workdir):
    """创建 ContextManager 实例。"""
    return ContextManager(tmp_workdir)


def make_tool_result(content, tool_use_id="id_1"):
    """构造一个 tool_result 消息片段。"""
    return {"type": "tool_result", "tool_use_id": tool_use_id, "content": content}


def make_messages_with_tool_results(contents):
    """构造包含多个 tool_result 轮次的 messages 列表。
    每个 content 变成一个 user 消息（含一个 tool_result），
    之间用 assistant 消息隔开。
    """
    messages = [{"role": "user", "content": "开始"}]
    for i, c in enumerate(contents):
        messages.append({"role": "assistant", "content": f"assistant_{i}"})
        messages.append({"role": "user", "content": [make_tool_result(c, f"id_{i}")]})
    return messages


# ─── truncate_and_save 测试 ───────────────────────────────────────


class TestTruncateAndSave:
    """Layer 0: 截断+落盘"""

    def test_within_limit_returned_as_is(self, ctx):
        """不超过 MAX_TOOL_OUTPUT 的内容原样返回。"""
        content = "a" * MAX_TOOL_OUTPUT
        result = ctx.truncate_and_save(content, "read_file")
        assert result == content

    def test_empty_content_returned(self, ctx):
        """空内容原样返回。"""
        result = ctx.truncate_and_save("", "read_file")
        assert result == ""

    def test_short_content_returned(self, ctx):
        """短内容原样返回。"""
        result = ctx.truncate_and_save("hello", "read_file")
        assert result == "hello"

    def test_over_limit_saves_to_disk(self, ctx):
        """超大内容写到磁盘文件。"""
        content = "a" * (MAX_TOOL_OUTPUT + 1)
        result = ctx.truncate_and_save(content, "read_file")
        # 返回值应包含预览和文件路径
        assert "... (完整结果已保存到" in result
        assert "read_file" in result
        # 磁盘文件存在且内容完整
        files = list(ctx.transcript_dir.glob("read_file_*.txt"))
        assert len(files) == 1
        assert files[0].read_text(encoding="utf-8") == content

    def test_over_limit_preview_has_20_lines(self, ctx):
        """超大内容的预览只保留前 20 行。"""
        lines = [f"第 {i} 行内容" for i in range(100)]
        content = "\n".join(lines)
        # 确保超过 MAX_TOOL_OUTPUT
        content += "\n" + "x" * MAX_TOOL_OUTPUT
        result = ctx.truncate_and_save(content, "read_file")
        preview_section = result.split("... (完整结果已保存到")[0]
        preview_lines = [l for l in preview_section.strip().splitlines() if l]
        assert len(preview_lines) == 20
        assert "第 0 行内容" in preview_lines[0]

    def test_over_limit_single_line(self, ctx):
        """超大但只有一行的内容，预览就是那一行。"""
        content = "a" * (MAX_TOOL_OUTPUT + 100)
        result = ctx.truncate_and_save(content, "bash")
        assert result.startswith("aaa")
        assert "... (完整结果已保存到" in result

    def test_unicode_content_saved_correctly(self, ctx):
        """Unicode 内容完整保存到磁盘。"""
        content = "中文内容测试" * 1000  # 确保 > MAX_TOOL_OUTPUT
        if len(content) <= MAX_TOOL_OUTPUT:
            content = "中文内容测试" * 5000
        result = ctx.truncate_and_save(content, "read_file")
        assert "... (完整结果已保存到" in result
        files = list(ctx.transcript_dir.glob("read_file_*.txt"))
        assert files[0].read_text(encoding="utf-8") == content

    def test_filename_contains_tool_name(self, ctx):
        """保存的文件名包含工具名。"""
        content = "a" * (MAX_TOOL_OUTPUT + 1)
        ctx.truncate_and_save(content, "grep")
        files = list(ctx.transcript_dir.glob("grep_*.txt"))
        assert len(files) == 1

    def test_exactly_at_limit_returned_as_is(self, ctx):
        """恰好等于 MAX_TOOL_OUTPUT 的内容原样返回。"""
        content = "a" * MAX_TOOL_OUTPUT
        result = ctx.truncate_and_save(content, "read_file")
        assert result == content
        # 不应创建文件
        assert list(ctx.transcript_dir.glob("*.txt")) == []


# ─── micro_compact 测试 ──────────────────────────────────────────


class TestMicroCompact:
    """Layer 1: 旧 tool_result 替换为占位符"""

    def test_no_tool_results_no_change(self, ctx):
        """没有 tool_result，不修改。"""
        messages = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ]
        original = json.dumps(messages)
        ctx.micro_compact(messages)
        assert json.dumps(messages) == original

    def test_fewer_than_keep_recent_no_change(self, ctx):
        """tool_result 数量 <= KEEP_RECENT，不修改。"""
        for n in range(0, ctx.KEEP_RECENT + 1):
            messages = make_messages_with_tool_results(
                ["a" * 200] * n
            )
            originals = [
                part["content"]
                for msg in messages
                if msg["role"] == "user" and isinstance(msg.get("content"), list)
                for part in msg["content"]
                if isinstance(part, dict) and part.get("type") == "tool_result"
            ]
            ctx.micro_compact(messages)
            after = [
                part["content"]
                for msg in messages
                if msg["role"] == "user" and isinstance(msg.get("content"), list)
                for part in msg["content"]
                if isinstance(part, dict) and part.get("type") == "tool_result"
            ]
            assert after == originals, f"n={n}: 不应修改但被修改了"

    def test_more_than_keep_recent_oldest_replaced(self, ctx):
        """超过 KEEP_RECENT 时，最旧的被替换。"""
        messages = make_messages_with_tool_results([
            "content_0_" + "a" * 200,
            "content_1_" + "b" * 200,
            "content_2_" + "c" * 200,
            "content_3_" + "d" * 200,
            "content_4_" + "e" * 200,
        ])
        ctx.micro_compact(messages)
        tool_results = [
            part
            for msg in messages
            if msg["role"] == "user" and isinstance(msg.get("content"), list)
            for part in msg["content"]
            if isinstance(part, dict) and part.get("type") == "tool_result"
        ]
        # 前 2 个（5-3=2）应被替换
        assert tool_results[0]["content"] == "[Previous tool result compacted]"
        assert tool_results[1]["content"] == "[Previous tool result compacted]"
        # 后 3 个保留
        assert "content_2" in tool_results[2]["content"]
        assert "content_3" in tool_results[3]["content"]
        assert "content_4" in tool_results[4]["content"]

    def test_short_content_not_replaced(self, ctx):
        """tool_result 内容 <= 100 字符时不替换。"""
        short = "x" * 100  # 恰好 100
        messages = make_messages_with_tool_results([
            short, short, short, short,
        ])
        ctx.micro_compact(messages)
        tool_results = [
            part
            for msg in messages
            if msg["role"] == "user" and isinstance(msg.get("content"), list)
            for part in msg["content"]
            if isinstance(part, dict) and part.get("type") == "tool_result"
        ]
        # 100 chars is not > 100, so should NOT be replaced
        assert tool_results[0]["content"] == short

    def test_101_chars_gets_replaced(self, ctx):
        """tool_result 内容恰好 101 字符时被替换。"""
        content_101 = "x" * 101
        messages = make_messages_with_tool_results([
            content_101, "y" * 200, "z" * 200, "w" * 200,
        ])
        ctx.micro_compact(messages)
        tool_results = [
            part
            for msg in messages
            if msg["role"] == "user" and isinstance(msg.get("content"), list)
            for part in msg["content"]
            if isinstance(part, dict) and part.get("type") == "tool_result"
        ]
        assert tool_results[0]["content"] == "[Previous tool result compacted]"

    def test_empty_tool_result_not_replaced(self, ctx):
        """空的 tool_result 不被替换（len <= 100）。"""
        messages = make_messages_with_tool_results([
            "", "y" * 200, "z" * 200, "w" * 200,
        ])
        ctx.micro_compact(messages)
        tool_results = [
            part
            for msg in messages
            if msg["role"] == "user" and isinstance(msg.get("content"), list)
            for part in msg["content"]
            if isinstance(part, dict) and part.get("type") == "tool_result"
        ]
        assert tool_results[0]["content"] == ""

    def test_empty_messages_list(self, ctx):
        """空 messages 列表不报错。"""
        messages = []
        ctx.micro_compact(messages)  # 应不报错

    def test_mixed_user_messages(self, ctx):
        """混合了 string 和 list content 的 user 消息。"""
        messages = [
            {"role": "user", "content": "初始问题"},
            {"role": "assistant", "content": "调用工具"},
            {"role": "user", "content": [make_tool_result("a" * 200, "id_0")]},
            {"role": "assistant", "content": "再调一次"},
            {"role": "user", "content": "普通文本消息"},  # string content，不是 list
            {"role": "assistant", "content": "调用工具2"},
            {"role": "user", "content": [make_tool_result("b" * 200, "id_1")]},
        ]
        ctx.micro_compact(messages)
        # 只有 2 个 tool_result，<= KEEP_RECENT，不应修改
        tr = [
            part for msg in messages
            if msg["role"] == "user" and isinstance(msg.get("content"), list)
            for part in msg["content"]
            if isinstance(part, dict) and part.get("type") == "tool_result"
        ]
        assert tr[0]["content"] == "a" * 200
        assert tr[1]["content"] == "b" * 200

    def test_multiple_tool_results_in_single_message(self, ctx):
        """一条 user 消息中包含多个 tool_result（一次多工具调用）。"""
        messages = [
            {"role": "user", "content": "go"},
            {"role": "assistant", "content": "multi"},
            {"role": "user", "content": [
                make_tool_result("a" * 200, "id_0"),
                make_tool_result("b" * 200, "id_1"),
            ]},
            {"role": "assistant", "content": "multi2"},
            {"role": "user", "content": [
                make_tool_result("c" * 200, "id_2"),
                make_tool_result("d" * 200, "id_3"),
            ]},
        ]
        # 4 个 tool_result，KEEP_RECENT=3，应替换 1 个
        ctx.micro_compact(messages)
        tr = [
            part for msg in messages
            if msg["role"] == "user" and isinstance(msg.get("content"), list)
            for part in msg["content"]
            if isinstance(part, dict) and part.get("type") == "tool_result"
        ]
        assert tr[0]["content"] == "[Previous tool result compacted]"
        assert tr[1]["content"] == "b" * 200  # > 100 但在保留范围内？不对，KEEP_RECENT=3
        # 4 个 tool_result，保留最近 3 个（索引 1,2,3），替换索引 0
        # 实际上 tool_results[:-3] 替换的是 [0]，保留 [1,2,3]
        assert tr[1]["content"] == "b" * 200
        assert tr[2]["content"] == "c" * 200
        assert tr[3]["content"] == "d" * 200

    def test_preserves_tool_use_id(self, ctx):
        """替换内容后 tool_use_id 不变。"""
        messages = make_messages_with_tool_results(["a" * 200] * 5)
        original_ids = [
            part["tool_use_id"]
            for msg in messages
            if msg["role"] == "user" and isinstance(msg.get("content"), list)
            for part in msg["content"]
            if isinstance(part, dict) and part.get("type") == "tool_result"
        ]
        ctx.micro_compact(messages)
        after_ids = [
            part["tool_use_id"]
            for msg in messages
            if msg["role"] == "user" and isinstance(msg.get("content"), list)
            for part in msg["content"]
            if isinstance(part, dict) and part.get("type") == "tool_result"
        ]
        assert original_ids == after_ids

    def test_idempotent(self, ctx):
        """重复调用 micro_compact 结果一致。"""
        messages = make_messages_with_tool_results(["a" * 200] * 5)
        ctx.micro_compact(messages)
        state_1 = json.dumps(messages)
        ctx.micro_compact(messages)
        state_2 = json.dumps(messages)
        assert state_1 == state_2


# ─── estimate_tokens / should_compact 测试 ──────────────────────


class TestEstimateTokens:
    """Token 估算与阈值判断"""

    def test_empty_messages_zero_tokens(self, ctx):
        assert ctx.estimate_tokens([]) == 0

    def test_string_content(self, ctx):
        messages = [{"role": "user", "content": "a" * 400}]
        # 400 chars / 4 = 100 tokens
        assert ctx.estimate_tokens(messages) == 100

    def test_list_content(self, ctx):
        messages = [{"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "id_1", "content": "b" * 400}
        ]}]
        assert ctx.estimate_tokens(messages) == 100

    def test_mixed_messages(self, ctx):
        messages = [
            {"role": "user", "content": "a" * 400},  # 100 tokens
            {"role": "assistant", "content": "b" * 400},  # 100 tokens
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "id_1", "content": "c" * 800}
            ]},  # 200 tokens
        ]
        assert ctx.estimate_tokens(messages) == 400

    def test_non_dict_parts_in_list_ignored(self, ctx):
        """list content 中的非 dict 部分不参与计算。"""
        messages = [{"role": "user", "content": [1, 2, 3]}]
        # 非字典元素被跳过
        assert ctx.estimate_tokens(messages) == 0

    def test_should_compact_below_threshold(self, ctx):
        messages = [{"role": "user", "content": "a" * (ctx.TOKEN_THRESHOLD * ctx.CHARS_PER_TOKEN)}]
        assert ctx.should_compact(messages) is False

    def test_should_compact_above_threshold(self, ctx):
        messages = [{"role": "user", "content": "a" * (ctx.TOKEN_THRESHOLD * ctx.CHARS_PER_TOKEN + 4)}]
        assert ctx.should_compact(messages) is True


# ─── auto_compact 测试 ──────────────────────────────────────────


class TestAutoCompact:
    """Layer 2: 自动压缩（保存 + 摘要 + 替换）"""

    def test_saves_transcript(self, ctx):
        """auto_compact 保存完整对话到磁盘。"""
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.content = [MagicMock(text="这是摘要")]
        mock_client.messages.create.return_value = mock_response

        messages = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "world"},
        ]
        ctx.auto_compact(messages, mock_client)

        files = list(ctx.transcript_dir.glob("transcript_*.jsonl"))
        assert len(files) == 1
        lines = files[0].read_text(encoding="utf-8").strip().splitlines()
        assert len(lines) == 2
        saved = [json.loads(l) for l in lines]
        assert saved[0]["content"] == "hello"
        assert saved[1]["content"] == "world"

    def test_replaces_messages_with_summary(self, ctx):
        """auto_compact 用摘要替换 messages。"""
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.content = [MagicMock(text="这是摘要内容")]
        mock_client.messages.create.return_value = mock_response

        messages = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "world"},
        ]
        # 验证原地修改
        original_id = id(messages)
        ctx.auto_compact(messages, mock_client)

        assert id(messages) == original_id  # 同一个 list 对象
        assert len(messages) == 2
        assert messages[0]["role"] == "user"
        assert "[会话摘要]" in messages[0]["content"]
        assert "这是摘要内容" in messages[0]["content"]
        assert messages[1]["role"] == "assistant"
        assert messages[1]["content"] == "了解，继续工作。"

    def test_calls_llm_with_correct_params(self, ctx):
        """auto_compact 以正确的参数调用 LLM。"""
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.content = [MagicMock(text="summary")]
        mock_client.messages.create.return_value = mock_response

        messages = [{"role": "user", "content": "test"}]
        ctx.auto_compact(messages, mock_client)

        mock_client.messages.create.assert_called_once()
        call_kwargs = mock_client.messages.create.call_args
        assert call_kwargs.kwargs.get("max_tokens") == 2000

    def test_empty_messages(self, ctx):
        """空 messages 列表不报错。"""
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.content = [MagicMock(text="空对话")]
        mock_client.messages.create.return_value = mock_response

        messages = []
        ctx.auto_compact(messages, mock_client)
        assert len(messages) == 2

    def test_large_conversation_truncated_for_summary(self, ctx):
        """超大对话在摘要时被截断到 80000 字符。"""
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.content = [MagicMock(text="摘要")]
        mock_client.messages.create.return_value = mock_response

        # 构造超大对话
        big_content = "x" * 100000
        messages = [{"role": "user", "content": big_content}]
        ctx.auto_compact(messages, mock_client)

        # 验证发送给 LLM 的内容被截断
        call_args = mock_client.messages.create.call_args
        sent_content = call_args.kwargs["messages"][0]["content"]
        assert "...(已截断)" in sent_content


# ─── _save_transcript 测试 ──────────────────────────────────────


class TestSaveTranscript:
    """Transcript 持久化"""

    def test_creates_jsonl_file(self, ctx):
        """保存为 JSONL 格式，每行一个 JSON 对象。"""
        messages = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": [{"type": "text", "text": "hi"}]},
        ]
        path = ctx._save_transcript(messages)
        assert path.exists()
        lines = path.read_text(encoding="utf-8").strip().splitlines()
        assert len(lines) == 2
        assert json.loads(lines[0])["content"] == "hello"

    def test_unicode_preserved(self, ctx):
        """Unicode 内容完整保存。"""
        messages = [{"role": "user", "content": "你好世界 🌍"}]
        path = ctx._save_transcript(messages)
        saved = json.loads(path.read_text(encoding="utf-8").strip())
        assert saved["content"] == "你好世界 🌍"

    def test_non_serializable_handled(self, ctx):
        """非序列化对象（如 Exception）通过 default=str 处理。"""
        messages = [{"role": "user", "content": ValueError("test error")}]
        path = ctx._save_transcript(messages)
        saved = json.loads(path.read_text(encoding="utf-8").strip())
        assert "test error" in saved["content"]

    def test_empty_messages_saves_empty_file(self, ctx):
        """空 messages 保存为空文件。"""
        path = ctx._save_transcript([])
        assert path.exists()
        assert path.read_text(encoding="utf-8").strip() == ""


# ─── 集成测试 ──────────────────────────────────────────────────


class TestIntegration:
    """端到端场景测试"""

    def test_full_compaction_pipeline(self, ctx):
        """完整压缩流程：先 micro_compact，再 auto_compact。"""
        # 构造 5 轮工具调用
        messages = make_messages_with_tool_results([
            "result_0_" + "a" * 300,
            "result_1_" + "b" * 300,
            "result_2_" + "c" * 300,
            "result_3_" + "d" * 300,
            "result_4_" + "e" * 300,
        ])

        # Layer 1: micro_compact
        ctx.micro_compact(messages)
        tr = [
            part for msg in messages
            if msg["role"] == "user" and isinstance(msg.get("content"), list)
            for part in msg["content"]
            if isinstance(part, dict) and part.get("type") == "tool_result"
        ]
        assert tr[0]["content"] == "[Previous tool result compacted]"
        assert tr[1]["content"] == "[Previous tool result compacted]"
        assert "result_2" in tr[2]["content"]

        # Layer 2: auto_compact
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.content = [MagicMock(text="摘要：读取了5个文件")]
        mock_client.messages.create.return_value = mock_response

        ctx.auto_compact(messages, mock_client)
        assert len(messages) == 2
        assert "摘要" in messages[0]["content"]

        # 验证 transcript 落盘
        transcripts = list(ctx.transcript_dir.glob("transcript_*.jsonl"))
        assert len(transcripts) == 1

    def test_micro_compact_then_truncate_and_save(self, ctx):
        """micro_compact 和 truncate_and_save 互不干扰。"""
        # 先 truncate_and_save 一个大结果
        big_content = "x" * (MAX_TOOL_OUTPUT + 1000)
        compacted = ctx.truncate_and_save(big_content, "read_file")

        # 这个被截断的结果进入 messages
        messages = [
            {"role": "user", "content": "go"},
            {"role": "assistant", "content": "调用"},
            {"role": "user", "content": [make_tool_result(compacted, "id_0")]},
            {"role": "assistant", "content": "调用2"},
            {"role": "user", "content": [make_tool_result("short", "id_1")]},
        ]
        # 只有 2 个 tool_result，不应被替换
        ctx.micro_compact(messages)
        tr = [
            part for msg in messages
            if msg["role"] == "user" and isinstance(msg.get("content"), list)
            for part in msg["content"]
            if isinstance(part, dict) and part.get("type") == "tool_result"
        ]
        assert "... (完整结果已保存到" in tr[0]["content"]
        assert tr[1]["content"] == "short"

    def test_transcript_dir_created_automatically(self, tmp_path):
        """ContextManager 自动创建 .transcripts 目录。"""
        workdir = tmp_path / "nested" / "new_dir"
        workdir.mkdir(parents=True)
        ctx = ContextManager(workdir)
        assert ctx.transcript_dir.exists()
        assert ctx.transcript_dir.name == ".transcripts"
