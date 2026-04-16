# 待办事项功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 mi-code 添加待办事项功能，帮助模型在复杂多步骤任务中保持执行路线图。

**Architecture:** `TodoManager` 类封装 JSON 文件读写和状态管理，5 个 `@tool` 包装函数委托到该类实例。严格串行约束在 `start` 方法内强制执行。

**Tech Stack:** Python 3.13 标准库（json, datetime, pathlib）, pytest

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `agent_loop.py` 新增 `import json` + `from datetime import datetime` | 依赖 |
| `agent_loop.py` 新增 `TodoManager` 类（第 99 行后插入） | 数据层 + 业务逻辑 |
| `agent_loop.py` 新增 5 个 `@tool` 包装函数 + `_todo_mgr` 变量（`edit_file` 之后） | 工具注册 |
| `agent_loop.py` 修改 `SYSTEM_PROMPT`（第 51 行） | 模型行为引导 |
| `agent_loop.py` 修改 `main()`（第 413 行） | 初始化 TodoManager |
| `tests/test_todo.py` 新建 | TodoManager 单元测试 |

---

### Task 1: TodoManager 数据层（_load / _save）

**Files:**
- Modify: `agent_loop.py`（第 14 行后加 import，第 99 行后插入类）
- Create: `tests/test_todo.py`

- [ ] **Step 1: 添加 import 语句**

在 `agent_loop.py` 第 14 行 `from pathlib import Path` 后追加：

```python
import json
from datetime import datetime
```

- [ ] **Step 2: 写 TodoManager 骨架 + _load/_save 的测试**

创建 `tests/test_todo.py`：

```python
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
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd /home/app/project && python -m pytest tests/test_todo.py::TestTodoManagerDataLayer -v`
Expected: FAIL（`TodoManager` 不存在）

- [ ] **Step 4: 实现 TodoManager 类（_load / _save）**

在 `agent_loop.py` 第 97 行（`execute_tool` 函数之后，`# ─── 工具实现 ───` 之前）插入：

```python

# ─── 待办事项管理器 ──────────────────────────────────────────────────

class TodoManager:
    """待办事项管理器：JSON 文件持久化，三种状态，严格串行执行。"""

    def __init__(self, path: Path):
        self._path = path

    def _load(self) -> dict:
        """从 JSON 文件加载。文件不存在则返回空结构。"""
        if not self._path.exists():
            return {"next_id": 1, "tasks": []}
        return json.loads(self._path.read_text(encoding="utf-8"))

    def _save(self, data: dict) -> None:
        """将数据写回 JSON 文件。自动创建父目录。"""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd /home/app/project && python -m pytest tests/test_todo.py::TestTodoManagerDataLayer -v`
Expected: 4 passed

- [ ] **Step 6: 提交**

```bash
cd /home/app/project
git add tests/test_todo.py cli/python/agent_loop.py
git commit -m "feat(todo): add TodoManager data layer with JSON persistence"
```

---

### Task 2: todo_create — 批量创建任务

**Files:**
- Modify: `agent_loop.py`（TodoManager 类内添加 `create` 方法）
- Modify: `tests/test_todo.py`（追加 TestTodoCreate 类）

- [ ] **Step 1: 写 todo_create 的测试**

在 `tests/test_todo.py` 末尾追加：

```python


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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/app/project && python -m pytest tests/test_todo.py::TestTodoCreate -v`
Expected: FAIL（`create` 方法不存在）

- [ ] **Step 3: 实现 create 方法**

在 `TodoManager` 类的 `_save` 方法后追加：

```python

    def create(self, args: dict) -> str:
        """批量创建任务。模型规划阶段使用。"""
        data = self._load()
        created = []
        for t in args["tasks"]:
            task = {
                "id": data["next_id"],
                "title": t["title"],
                "description": t["description"],
                "status": "pending",
                "created_at": datetime.now().isoformat(timespec="seconds"),
            }
            data["tasks"].append(task)
            created.append(f"#{task['id']} {task['title']}")
            data["next_id"] += 1
        self._save(data)
        return f"已创建 {len(created)} 个任务: {', '.join(created)}"
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /home/app/project && python -m pytest tests/test_todo.py::TestTodoCreate -v`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
cd /home/app/project
git add tests/test_todo.py cli/python/agent_loop.py
git commit -m "feat(todo): implement batch task creation"
```

---

### Task 3: todo_start — 开始执行任务（含约束）

**Files:**
- Modify: `agent_loop.py`（TodoManager 类内添加 `start` 方法）
- Modify: `tests/test_todo.py`（追加 TestTodoStart 类）

- [ ] **Step 1: 写 todo_start 的测试**

在 `tests/test_todo.py` 末尾追加：

```python


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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/app/project && python -m pytest tests/test_todo.py::TestTodoStart -v`
Expected: FAIL（`start` 方法不存在）

- [ ] **Step 3: 实现 start 方法**

在 `TodoManager` 类的 `create` 方法后追加：

```python

    def start(self, args: dict) -> str:
        """开始执行任务。同一时间只能有一个 in_progress。"""
        data = self._load()
        task_id = args["task_id"]

        # 查找任务
        task = next((t for t in data["tasks"] if t["id"] == task_id), None)
        if task is None:
            return f"错误：任务 #{task_id} 不存在"
        if task["status"] != "pending":
            return f"错误：任务 #{task_id} 当前状态为 '{task['status']}'，只能对未完成任务执行此操作"

        # 检查串行约束
        in_progress = next((t for t in data["tasks"] if t["status"] == "in_progress"), None)
        if in_progress:
            return f"错误：任务 #{in_progress['id']}（{in_progress['title']}）正在执行中，请先完成它"

        task["status"] = "in_progress"
        self._save(data)
        return f"已开始任务 #{task_id}: {task['title']}"
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /home/app/project && python -m pytest tests/test_todo.py::TestTodoStart -v`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
cd /home/app/project
git add tests/test_todo.py cli/python/agent_loop.py
git commit -m "feat(todo): implement todo_start with serial execution constraint"
```

---

### Task 4: todo_complete — 完成任务

**Files:**
- Modify: `agent_loop.py`（TodoManager 类内添加 `complete` 方法）
- Modify: `tests/test_todo.py`（追加 TestTodoComplete 类）

- [ ] **Step 1: 写 todo_complete 的测试**

在 `tests/test_todo.py` 末尾追加：

```python


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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/app/project && python -m pytest tests/test_todo.py::TestTodoComplete -v`
Expected: FAIL（`complete` 方法不存在）

- [ ] **Step 3: 实现 complete 方法**

在 `TodoManager` 类的 `start` 方法后追加：

```python

    def complete(self, args: dict) -> str:
        """完成任务。记录完成时间，显示剩余数量。"""
        data = self._load()
        task_id = args["task_id"]

        task = next((t for t in data["tasks"] if t["id"] == task_id), None)
        if task is None:
            return f"错误：任务 #{task_id} 不存在"
        if task["status"] != "in_progress":
            return f"错误：任务 #{task_id} 当前状态为 '{task['status']}'，只能完成正在执行的任务"

        task["status"] = "completed"
        task["completed_at"] = datetime.now().isoformat(timespec="seconds")
        self._save(data)

        pending = sum(1 for t in data["tasks"] if t["status"] == "pending")
        if pending > 0:
            return f"已完成任务 #{task_id}，剩余 {pending} 个未完成"
        return f"已完成任务 #{task_id}，所有任务已完成"
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /home/app/project && python -m pytest tests/test_todo.py::TestTodoComplete -v`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
cd /home/app/project
git add tests/test_todo.py cli/python/agent_loop.py
git commit -m "feat(todo): implement todo_complete with remaining count"
```

---

### Task 5: todo_add — 追加单个任务

**Files:**
- Modify: `agent_loop.py`（TodoManager 类内添加 `add` 方法）
- Modify: `tests/test_todo.py`（追加 TestTodoAdd 类）

- [ ] **Step 1: 写 todo_add 的测试**

在 `tests/test_todo.py` 末尾追加：

```python


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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/app/project && python -m pytest tests/test_todo.py::TestTodoAdd -v`
Expected: FAIL（`add` 方法不存在）

- [ ] **Step 3: 实现 add 方法**

在 `TodoManager` 类的 `complete` 方法后追加：

```python

    def add(self, args: dict) -> str:
        """追加单个任务到列表末尾。执行中发现遗漏时使用。"""
        data = self._load()
        task = {
            "id": data["next_id"],
            "title": args["title"],
            "description": args["description"],
            "status": "pending",
            "created_at": datetime.now().isoformat(timespec="seconds"),
        }
        data["tasks"].append(task)
        data["next_id"] += 1
        self._save(data)
        return f"已追加任务 #{task['id']}: {task['title']}"
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /home/app/project && python -m pytest tests/test_todo.py::TestTodoAdd -v`
Expected: 4 passed

- [ ] **Step 5: 提交**

```bash
cd /home/app/project
git add tests/test_todo.py cli/python/agent_loop.py
git commit -m "feat(todo): implement todo_add for appending tasks during execution"
```

---

### Task 6: todo_list — 列出所有任务

**Files:**
- Modify: `agent_loop.py`（TodoManager 类内添加 `list_tasks` 方法）
- Modify: `tests/test_todo.py`（追加 TestTodoList 类）

- [ ] **Step 1: 写 todo_list 的测试**

在 `tests/test_todo.py` 末尾追加：

```python


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
        assert "[已完成] #1 任务A — 做A" in result
        assert "[进行中] #2 任务B — 做B" in result
        assert "[未完成] #3 任务C — 做C" in result

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
        assert "1 已完成" in result
        assert "0 进行中" in result
        assert "2 未完成" in result
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/app/project && python -m pytest tests/test_todo.py::TestTodoList -v`
Expected: FAIL（`list_tasks` 方法不存在）

- [ ] **Step 3: 实现 list_tasks 方法**

在 `TodoManager` 类的 `add` 方法后追加：

```python

    def list_tasks(self, args: dict) -> str:
        """列出所有任务及状态统计。"""
        data = self._load()
        if not data["tasks"]:
            return "当前没有待办任务"

        status_label = {"pending": "未完成", "in_progress": "进行中", "completed": "已完成"}
        lines = []
        for t in data["tasks"]:
            label = status_label.get(t["status"], t["status"])
            lines.append(f"[{label}] #{t['id']} {t['title']} — {t['description']}")

        counts = {"pending": 0, "in_progress": 0, "completed": 0}
        for t in data["tasks"]:
            counts[t["status"]] = counts.get(t["status"], 0) + 1

        lines.append(
            f"\n{counts['completed']} 已完成 / {counts['in_progress']} 进行中 / {counts['pending']} 未完成"
        )
        return "\n".join(lines)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /home/app/project && python -m pytest tests/test_todo.py::TestTodoList -v`
Expected: 3 passed

- [ ] **Step 5: 运行全部 todo 测试**

Run: `cd /home/app/project && python -m pytest tests/test_todo.py -v`
Expected: 全部 22 个测试通过

- [ ] **Step 6: 提交**

```bash
cd /home/app/project
git add tests/test_todo.py cli/python/agent_loop.py
git commit -m "feat(todo): implement todo_list with formatted output and statistics"
```

---

### Task 7: @tool 注册 + SYSTEM_PROMPT + main() 集成

**Files:**
- Modify: `agent_loop.py`（5 个 @tool 包装函数 + SYSTEM_PROMPT + main()）

此 Task 没有 TDD——`@tool` 包装函数是纯委托（一行代码），已在 Task 2-6 中测试了全部业务逻辑。

- [ ] **Step 1: 添加模块级变量和 5 个 @tool 包装函数**

在 `agent_loop.py` 的 `edit_file` 函数之后、`# ─── Agent Loop ───` 之前插入：

```python

# ─── 待办事项工具（委托到 TodoManager） ─────────────────────────────────

_todo_mgr: TodoManager | None = None


@tool({
    "name": "todo_create",
    "description": "批量创建待办任务。当任务预计需要 3 个以上步骤时使用。传入所有步骤的标题和描述。",
    "input_schema": {
        "type": "object",
        "properties": {
            "tasks": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string", "description": "任务标题，简短概括"},
                        "description": {"type": "string", "description": "任务具体内容，需要做什么"},
                    },
                    "required": ["title", "description"],
                },
            }
        },
        "required": ["tasks"],
    },
})
def todo_create(args: dict) -> str:
    return _todo_mgr.create(args)


@tool({
    "name": "todo_start",
    "description": "将指定任务标记为正在执行。同一时间只能有一个正在执行的任务。必须先完成当前任务再开始新任务。",
    "input_schema": {
        "type": "object",
        "properties": {
            "task_id": {"type": "integer", "description": "要开始的任务 ID"}
        },
        "required": ["task_id"],
    },
})
def todo_start(args: dict) -> str:
    return _todo_mgr.start(args)


@tool({
    "name": "todo_complete",
    "description": "将指定任务标记为已完成。记录完成时间。只能完成正在执行的任务。",
    "input_schema": {
        "type": "object",
        "properties": {
            "task_id": {"type": "integer", "description": "要完成的任务 ID"}
        },
        "required": ["task_id"],
    },
})
def todo_complete(args: dict) -> str:
    return _todo_mgr.complete(args)


@tool({
    "name": "todo_add",
    "description": "追加一个新任务到待办列表。用于执行过程中发现遗漏的步骤。不影响正在执行的任务。",
    "input_schema": {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "任务标题"},
            "description": {"type": "string", "description": "任务具体内容"},
        },
        "required": ["title", "description"],
    },
})
def todo_add(args: dict) -> str:
    return _todo_mgr.add(args)


@tool({
    "name": "todo_list",
    "description": "列出所有待办任务及其当前状态。用于查看进度或决定下一步操作。",
    "input_schema": {
        "type": "object",
        "properties": {},
    },
})
def todo_list(args: dict) -> str:
    return _todo_mgr.list_tasks(args)
```

- [ ] **Step 2: 更新 SYSTEM_PROMPT**

将 `agent_loop.py` 中 `SYSTEM_PROMPT` 的值改为：

```python
SYSTEM_PROMPT = """你是一个终端里的 AI 编程助手。你可以读取文件、列出目录、搜索代码来帮助用户完成任务。
请用中文回答。在调用工具之前，先简要说明你打算做什么。

待办事项使用规则：
- 当任务预计需要 3 个以上步骤时，必须先调用 todo_create 规划所有步骤，再逐个执行
- 简单任务（1-2 步）不需要创建待办事项，直接执行即可
- 执行流程：todo_start(任务ID) → 执行实际工作 → todo_complete(任务ID) → todo_start(下一个)
- 同一时间只能有一个任务处于"正在进行"状态
- 如果执行中发现遗漏的步骤，用 todo_add 追加"""
```

- [ ] **Step 3: 在 main() 中初始化 TodoManager**

在 `agent_loop.py` 的 `main()` 函数中，`print("=" * 60)` 之前插入：

```python
    # 初始化待办事项管理器
    todo_path = Path(os.environ.get(
        "MI_CODE_TODO_PATH",
        str(WORKDIR / ".mi-code" / "todo.json"),
    ))
    global _todo_mgr
    _todo_mgr = TodoManager(todo_path)
```

- [ ] **Step 4: 运行全部测试确认无回归**

Run: `cd /home/app/project && python -m pytest tests/ -v`
Expected: 全部测试通过（包括原有的 test_write_edit.py）

- [ ] **Step 5: 运行程序验证启动**

Run: `cd /home/app/project/cli/python && echo 'q' | python agent_loop.py`
Expected: 启动信息中工具列表包含 `todo_create, todo_start, todo_complete, todo_add, todo_list`，程序正常退出

- [ ] **Step 6: 提交**

```bash
cd /home/app/project
git add cli/python/agent_loop.py
git commit -m "feat(todo): integrate todo tools with @tool registry and system prompt"
```
