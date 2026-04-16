"""TodoManager 待办事项管理器的单元测试。"""

import json

import agent_loop
import pytest
from pathlib import Path


class TestTodoManagerDataLayer:
    """_load / _save: JSON 文件读写和空文件初始化"""

    def test_creates_empty_json_on_first_load(self, tmp_path):
        mgr = agent_loop.TodoManager(tmp_path / "todo.json")
        data = mgr._load()
        assert data == {"next_id": 1, "tasks": []}

    def test_save_and_load_roundtrip(self, tmp_path):
        mgr = agent_loop.TodoManager(tmp_path / "todo.json")
        data = {"next_id": 3, "tasks": [
            {"id": 1, "title": "任务A", "description": "描述A", "status": "pending", "created_at": "2026-04-13T14:00:00"},
            {"id": 2, "title": "任务B", "description": "描述B", "status": "completed", "created_at": "2026-04-13T14:00:00", "completed_at": "2026-04-13T14:30:00"},
        ]}
        mgr._save(data)

        # 验证文件内容
        raw = json.loads((tmp_path / "todo.json").read_text(encoding="utf-8"))
        assert raw == data

        # 验证 reload 一致
        assert mgr._load() == data

    def test_save_creates_parent_dirs(self, tmp_path):
        mgr = agent_loop.TodoManager(tmp_path / "a" / "b" / "todo.json")
        mgr._save({"next_id": 1, "tasks": []})
        assert (tmp_path / "a" / "b" / "todo.json").exists()

    def test_load_existing_file(self, tmp_path):
        path = tmp_path / "todo.json"
        path.write_text(json.dumps({"next_id": 5, "tasks": [{"id": 1, "title": "已有", "description": "旧任务", "status": "completed", "created_at": "2026-01-01T00:00:00"}]}, ensure_ascii=False), encoding="utf-8")
        mgr = agent_loop.TodoManager(path)
        data = mgr._load()
        assert data["next_id"] == 5
        assert len(data["tasks"]) == 1

    def test_next_id_never_conflicts_with_existing(self, tmp_path):
        """即使 JSON 中 next_id 被手动改小，也不产生重复 ID。"""
        path = tmp_path / "todo.json"
        path.write_text(json.dumps({
            "next_id": 1,  # 人为改小
            "tasks": [
                {"id": 1, "title": "旧任务", "description": "已存在", "status": "pending", "created_at": "2026-01-01T00:00:00"},
                {"id": 3, "title": "另一旧任务", "description": "已存在", "status": "pending", "created_at": "2026-01-01T00:00:00"},
            ]
        }), encoding="utf-8")
        mgr = agent_loop.TodoManager(path)
        mgr.add({"title": "新任务", "description": "不应重复"})
        data = mgr._load()
        # 新任务 ID 应为 4（max_id=3 + 1），不是 1
        assert data["tasks"][-1]["id"] == 4
        assert len(set(t["id"] for t in data["tasks"])) == len(data["tasks"])


class TestTodoCreate:
    """create: 批量创建任务，分配自增 ID，设置 pending 状态"""

    def test_create_single_task(self, tmp_path):
        mgr = agent_loop.TodoManager(tmp_path / "todo.json")
        result = mgr.create({"tasks": [{"title": "任务1", "description": "描述1"}]})
        assert "已创建 1 个任务" in result
        assert "#1 任务1" in result

    def test_create_multiple_tasks(self, tmp_path):
        mgr = agent_loop.TodoManager(tmp_path / "todo.json")
        result = mgr.create({"tasks": [
            {"title": "步骤A", "description": "做A"},
            {"title": "步骤B", "description": "做B"},
            {"title": "步骤C", "description": "做C"},
        ]})
        assert "已创建 3 个任务" in result
        assert "#1" in result and "#2" in result and "#3" in result

    def test_assigns_incremental_ids(self, tmp_path):
        mgr = agent_loop.TodoManager(tmp_path / "todo.json")
        mgr.create({"tasks": [{"title": "T1", "description": "D1"}]})
        mgr.create({"tasks": [{"title": "T2", "description": "D2"}]})
        data = mgr._load()
        assert data["tasks"][0]["id"] == 1
        assert data["tasks"][1]["id"] == 2
        assert data["next_id"] == 3

    def test_all_tasks_are_pending(self, tmp_path):
        mgr = agent_loop.TodoManager(tmp_path / "todo.json")
        mgr.create({"tasks": [
            {"title": "A", "description": "a"},
            {"title": "B", "description": "b"},
        ]})
        data = mgr._load()
        assert all(t["status"] == "pending" for t in data["tasks"])

    def test_tasks_have_timestamps(self, tmp_path):
        mgr = agent_loop.TodoManager(tmp_path / "todo.json")
        mgr.create({"tasks": [{"title": "T", "description": "D"}]})
        data = mgr._load()
        assert "created_at" in data["tasks"][0]
        assert data["tasks"][0]["created_at"].startswith("2026")


class TestTodoStart:
    """start: 开始任务，严格串行约束，状态校验"""

    def _make_mgr_with_tasks(self, tmp_path, count=3):
        """辅助：创建 manager 并预填 count 个 pending 任务。"""
        mgr = agent_loop.TodoManager(tmp_path / "todo.json")
        mgr.create({"tasks": [
            {"title": f"任务{i}", "description": f"描述{i}"} for i in range(1, count + 1)
        ]})
        return mgr

    def test_start_pending_task(self, tmp_path):
        mgr = self._make_mgr_with_tasks(tmp_path)
        result = mgr.start({"task_id": 1})
        assert "已开始任务 #1" in result
        data = mgr._load()
        assert data["tasks"][0]["status"] == "in_progress"

    def test_reject_when_another_in_progress(self, tmp_path):
        mgr = self._make_mgr_with_tasks(tmp_path)
        mgr.start({"task_id": 1})
        result = mgr.start({"task_id": 2})
        assert "错误" in result
        assert "#1" in result
        assert "正在执行中" in result
        # 确认任务 2 没有变化
        data = mgr._load()
        assert data["tasks"][1]["status"] == "pending"

    def test_reject_nonexistent_task(self, tmp_path):
        mgr = self._make_mgr_with_tasks(tmp_path)
        result = mgr.start({"task_id": 99})
        assert "错误" in result
        assert "不存在" in result

    def test_reject_completed_task(self, tmp_path):
        mgr = self._make_mgr_with_tasks(tmp_path)
        mgr.start({"task_id": 1})
        mgr.complete({"task_id": 1})
        result = mgr.start({"task_id": 1})
        assert "错误" in result
        assert "只能对未完成任务" in result

    def test_start_after_complete_previous(self, tmp_path):
        """完成前一个后，可以开始下一个。"""
        mgr = self._make_mgr_with_tasks(tmp_path)
        mgr.start({"task_id": 1})
        mgr.complete({"task_id": 1})
        result = mgr.start({"task_id": 2})
        assert "已开始任务 #2" in result

    def test_start_shows_task_list(self, tmp_path):
        """start 返回值附带任务列表。"""
        mgr = self._make_mgr_with_tasks(tmp_path)
        result = mgr.start({"task_id": 1})
        assert "[>] #1 任务1" in result
        assert "[ ] #2 任务2" in result


class TestTodoComplete:
    """complete: 完成正在执行的任务，记录完成时间"""

    def _make_mgr_with_started(self, tmp_path):
        """辅助：创建 manager 并开始任务 1。"""
        mgr = agent_loop.TodoManager(tmp_path / "todo.json")
        mgr.create({"tasks": [
            {"title": "任务A", "description": "描述A"},
            {"title": "任务B", "description": "描述B"},
        ]})
        mgr.start({"task_id": 1})
        return mgr

    def test_complete_in_progress_task(self, tmp_path):
        mgr = self._make_mgr_with_started(tmp_path)
        result = mgr.complete({"task_id": 1})
        assert "已完成任务 #1" in result
        data = mgr._load()
        assert data["tasks"][0]["status"] == "completed"
        assert "completed_at" in data["tasks"][0]

    def test_shows_remaining_count(self, tmp_path):
        mgr = self._make_mgr_with_started(tmp_path)
        result = mgr.complete({"task_id": 1})
        assert "剩余 1 个未完成" in result

    def test_shows_all_done(self, tmp_path):
        mgr = self._make_mgr_with_started(tmp_path)
        mgr.complete({"task_id": 1})
        mgr.start({"task_id": 2})
        result = mgr.complete({"task_id": 2})
        assert "所有任务已完成" in result

    def test_reject_complete_pending_task(self, tmp_path):
        mgr = agent_loop.TodoManager(tmp_path / "todo.json")
        mgr.create({"tasks": [{"title": "T", "description": "D"}]})
        result = mgr.complete({"task_id": 1})
        assert "错误" in result
        assert "只能完成正在执行的任务" in result

    def test_reject_nonexistent_task(self, tmp_path):
        mgr = self._make_mgr_with_started(tmp_path)
        result = mgr.complete({"task_id": 99})
        assert "错误" in result
        assert "不存在" in result

    def test_complete_shows_task_list(self, tmp_path):
        """complete 返回值附带任务列表。"""
        mgr = self._make_mgr_with_started(tmp_path)
        result = mgr.complete({"task_id": 1})
        assert "[x] #1 任务A" in result
        assert "[ ] #2 任务B" in result

    def test_complete_shows_all_done_with_list(self, tmp_path):
        """全部完成时返回 '所有任务已完成' 且列表全部 [x]。"""
        mgr = self._make_mgr_with_started(tmp_path)
        mgr.complete({"task_id": 1})
        mgr.start({"task_id": 2})
        result = mgr.complete({"task_id": 2})
        assert "所有任务已完成" in result
        assert result.count("[x]") == 2


class TestTodoAdd:
    """add: 追加单个任务，不影响正在执行的任务"""

    def test_add_to_empty_list(self, tmp_path):
        mgr = agent_loop.TodoManager(tmp_path / "todo.json")
        result = mgr.add({"title": "新任务", "description": "新描述"})
        assert "已追加任务 #1" in result
        data = mgr._load()
        assert len(data["tasks"]) == 1
        assert data["tasks"][0]["status"] == "pending"

    def test_add_to_existing_list(self, tmp_path):
        mgr = agent_loop.TodoManager(tmp_path / "todo.json")
        mgr.create({"tasks": [{"title": "A", "description": "a"}]})
        result = mgr.add({"title": "B", "description": "b"})
        assert "已追加任务 #2" in result
        data = mgr._load()
        assert len(data["tasks"]) == 2

    def test_does_not_affect_in_progress(self, tmp_path):
        mgr = agent_loop.TodoManager(tmp_path / "todo.json")
        mgr.create({"tasks": [{"title": "A", "description": "a"}]})
        mgr.start({"task_id": 1})
        mgr.add({"title": "B", "description": "b"})
        data = mgr._load()
        assert data["tasks"][0]["status"] == "in_progress"
        assert data["tasks"][1]["status"] == "pending"

    def test_id_increments_from_existing(self, tmp_path):
        mgr = agent_loop.TodoManager(tmp_path / "todo.json")
        mgr.create({"tasks": [
            {"title": "A", "description": "a"},
            {"title": "B", "description": "b"},
        ]})
        result = mgr.add({"title": "C", "description": "c"})
        assert "#3" in result


class TestTodoList:
    """list_tasks: 格式化输出所有任务及统计"""

    def test_empty_list(self, tmp_path):
        mgr = agent_loop.TodoManager(tmp_path / "todo.json")
        result = mgr.list_tasks({})
        assert "当前没有待办任务" in result

    def test_format_with_mixed_statuses(self, tmp_path):
        mgr = agent_loop.TodoManager(tmp_path / "todo.json")
        mgr.create({"tasks": [
            {"title": "任务A", "description": "做A"},
            {"title": "任务B", "description": "做B"},
            {"title": "任务C", "description": "做C"},
        ]})
        mgr.start({"task_id": 1})
        mgr.complete({"task_id": 1})
        mgr.start({"task_id": 2})

        result = mgr.list_tasks({})
        assert "[x] #1 任务A — 做A" in result
        assert "[>] #2 任务B — 做B" in result
        assert "[ ] #3 任务C — 做C" in result

    def test_shows_statistics(self, tmp_path):
        mgr = agent_loop.TodoManager(tmp_path / "todo.json")
        mgr.create({"tasks": [
            {"title": "A", "description": "a"},
            {"title": "B", "description": "b"},
            {"title": "C", "description": "c"},
        ]})
        mgr.start({"task_id": 1})
        mgr.complete({"task_id": 1})

        result = mgr.list_tasks({})
        assert "1/3 已完成" in result

    def test_progress_all_done(self, tmp_path):
        """全部完成时显示 3/3。"""
        mgr = agent_loop.TodoManager(tmp_path / "todo.json")
        mgr.create({"tasks": [
            {"title": "A", "description": "a"},
            {"title": "B", "description": "b"},
            {"title": "C", "description": "c"},
        ]})
        mgr.start({"task_id": 1})
        mgr.complete({"task_id": 1})
        mgr.start({"task_id": 2})
        mgr.complete({"task_id": 2})
        mgr.start({"task_id": 3})
        mgr.complete({"task_id": 3})

        result = mgr.list_tasks({})
        assert "3/3 已完成" in result
