# 待办事项功能设计

## 背景

mi-code 是终端 AI 编程助手。当用户任务复杂（多步骤）时，模型容易在长链执行中迷失上下文、遗漏步骤或偏离目标。待办事项功能通过"先规划后执行"的模式，为模型提供明确的执行路线图。

## 核心需求

1. 三种状态：`pending`（未完成）、`in_progress`（正在进行）、`completed`（已完成）
2. `in_progress` 状态有且仅有一个——违反时拒绝操作
3. 先规划所有子任务，再逐个串行执行
4. 由模型根据任务复杂度自主决定是否启用
5. JSON 文件持久化，程序重启后数据保留

## 数据模型

存储文件：默认 `WORKDIR / ".mi-code" / "todo.json"`，可通过环境变量 `MI_CODE_TODO_PATH` 覆盖。

```json
{
  "tasks": [
    {
      "id": 1,
      "title": "创建数据库连接模块",
      "description": "使用 sqlite3 标准库，封装连接池和基本 CRUD 操作",
      "status": "pending",
      "created_at": "2026-04-13T14:30:00"
    },
    {
      "id": 2,
      "title": "实现用户认证接口",
      "description": "基于 JWT 的认证中间件",
      "status": "in_progress",
      "created_at": "2026-04-13T14:30:00"
    },
    {
      "id": 3,
      "title": "编写测试用例",
      "description": "覆盖认证接口的正常和异常路径",
      "status": "completed",
      "created_at": "2026-04-13T14:30:00",
      "completed_at": "2026-04-13T14:45:00"
    }
  ]
}
```

字段说明：
- `id`：自增整数，唯一标识，模型通过 id 引用任务
- `title`：简短标题
- `description`：具体内容描述
- `status`：`pending` | `in_progress` | `completed`
- `created_at`：ISO 格式创建时间
- `completed_at`：完成时间（仅 completed 状态有）

## 工具设计

### TodoManager 类

所有待办工具封装在 `TodoManager` 类中，内部管理 JSON 文件读写。

```python
class TodoManager:
    def __init__(self, path: Path): ...   # 指定 JSON 路径，不存在则创建空列表

    def _load(self) -> list[dict]: ...    # 从 JSON 加载任务列表
    def _save(self, tasks) -> None: ...   # 写回 JSON 文件

    def create(self, args: dict) -> str: ...   # 批量创建任务
    def start(self, args: dict) -> str: ...    # 开始执行任务
    def complete(self, args: dict) -> str: ... # 完成任务
    def add(self, args: dict) -> str: ...      # 追加单个任务
    def list_tasks(self, args: dict) -> str: ... # 列出所有任务
```

### 5 个工具 Schema

#### todo_create — 批量创建任务

规划阶段使用。模型一次性传入所有子任务，程序遍历后批量创建。

```json
{
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
            "title": { "type": "string", "description": "任务标题，简短概括" },
            "description": { "type": "string", "description": "任务具体内容，需要做什么" }
          },
          "required": ["title", "description"]
        }
      }
    },
    "required": ["tasks"]
  }
}
```

行为：
- 接收 `{"tasks": [{"title": "...", "description": "..."}]}`
- 遍历列表，为每个任务分配自增 id，设置 status 为 `pending`
- 写入 JSON 文件
- 返回确认消息，包含创建的任务数量和 ID 列表

#### todo_start — 开始执行任务

```json
{
  "name": "todo_start",
  "description": "将指定任务标记为正在执行。同一时间只能有一个正在执行的任务。",
  "input_schema": {
    "type": "object",
    "properties": {
      "task_id": { "type": "integer", "description": "要开始的任务 ID" }
    },
    "required": ["task_id"]
  }
}
```

行为：
- 校验 task_id 存在且当前为 `pending`，否则返回错误
- 检查是否已有 `in_progress` 状态的任务
- **如果有**：拒绝操作，返回错误消息（"任务 X 正在执行中，请先完成它"）
- **如果没有**：将指定任务标记为 `in_progress`
- 返回状态变更确认

约束：
- `in_progress` 有且仅有一个。违反时拒绝，不自动暂停
- 只能对 `pending` 状态的任务调用 start

#### todo_complete — 完成任务

```json
{
  "name": "todo_complete",
  "description": "将指定任务标记为已完成。记录完成时间。",
  "input_schema": {
    "type": "object",
    "properties": {
      "task_id": { "type": "integer", "description": "要完成的任务 ID" }
    },
    "required": ["task_id"]
  }
}
```

行为：
- 校验 task_id 存在且当前为 `in_progress`
- 将状态改为 `completed`，记录 `completed_at`
- 返回完成确认 + 剩余未完成任务数

#### todo_add — 追加单个任务

```json
{
  "name": "todo_add",
  "description": "追加一个新任务到待办列表。用于执行过程中发现遗漏的步骤。不影响正在执行的任务。",
  "input_schema": {
    "type": "object",
    "properties": {
      "title": { "type": "string", "description": "任务标题" },
      "description": { "type": "string", "description": "任务具体内容" }
    },
    "required": ["title", "description"]
  }
}
```

行为：
- 创建单个 pending 任务，追加到列表末尾
- 不影响当前 in_progress 任务
- 返回含新任务 ID 的确认消息

#### todo_list — 列出所有任务

```json
{
  "name": "todo_list",
  "description": "列出所有待办任务及其当前状态。用于查看进度或决定下一步操作。",
  "input_schema": {
    "type": "object",
    "properties": {}
  }
}
```

行为：
- 读取 JSON 文件，格式化输出所有任务
- 每行格式：`[状态] #ID 标题 — 描述`
- 底部显示统计：X 已完成 / Y 进行中 / Z 未完成

## System Prompt 增补

追加到现有 `SYSTEM_PROMPT` 末尾：

```
待办事项使用规则：
- 当任务预计需要 3 个以上步骤时，必须先调用 todo_create 规划所有步骤，再逐个执行
- 简单任务（1-2 步）不需要创建待办事项，直接执行即可
- 执行流程：todo_start(任务ID) → 执行实际工作 → todo_complete(任务ID) → todo_start(下一个)
- 同一时间只能有一个任务处于"正在进行"状态
- 如果执行中发现遗漏的步骤，用 todo_add 追加
```

## 执行流程示例

```
用户: "帮我重构 agent_loop.py 的工具注册部分"

模型判断: 步骤 > 3，需要待办事项

  → todo_create([
      {title: "提取工具注册装饰器", description: "将 @tool 装饰器改为基于类的注册"},
      {title: "重构 execute_tool", description: "改为 dict 查表分发"},
      {title: "测试所有工具调用", description: "验证 6 个工具都能正常工作"}
    ])
  ← "已创建 3 个任务: #1 提取工具注册装饰器, #2 重构 execute_tool, #3 测试所有工具调用"

  → todo_start(1)
  ← "已开始任务 #1: 提取工具注册装饰器"
  → ... 执行实际代码修改 ...
  → todo_complete(1)
  ← "已完成任务 #1，剩余 2 个未完成"

  → todo_start(2)
  ← "已开始任务 #2: 重构 execute_tool"
  → ... 执行实际代码修改 ...
  → todo_complete(2)
  ← "已完成任务 #2，剩余 1 个未完成"

  → todo_start(3)
  ← "已开始任务 #3: 测试所有工具调用"
  → ... 执行测试 ...
  → todo_complete(3)
  ← "已完成任务 #3，所有任务已完成"
```

## 集成方式

所有改动在 `agent_loop.py` 内完成，保持单文件原型：

1. 新增 `TodoManager` 类（`# --- 待办事项管理器 ---` 节）
2. 5 个 `@tool` 装饰器注册方法到现有注册表
3. `SYSTEM_PROMPT` 追加待办事项规则
4. `main()` 中实例化 `TodoManager`，传入路径
