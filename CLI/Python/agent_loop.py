#!/usr/bin/env python3
"""
mi-code Agent Loop — AI 编程助手的核心循环

一个自包含的脚本，演示 Agent Loop 的核心机制：
1. 接收用户输入
2. 调用 AI 模型（带工具定义）
3. 如果模型请求工具 → 执行工具 → 将结果反馈给模型 → 重复
4. 如果模型认为完成 → 输出最终回答

API: Anthropic 兼容接口 (Zhipu AI GLM)
"""

import glob
import os
import subprocess
import sys
import json
import threading
from datetime import datetime
from pathlib import Path

import anthropic
from prompt_toolkit import prompt as pt_prompt

# ─── 配置 ───────────────────────────────────────────────────────────
MODEL = "glm-5.1"
MAX_TOKENS = 4096
BASE_URL = "https://open.bigmodel.cn/api/anthropic"

# 需要排除的目录名（虚拟环境、版本控制、缓存等）
EXCLUDE_DIRS = (".venv", "node_modules", "__pycache__", ".git")
MAX_FILE_READ = 10_000
MAX_TOOL_OUTPUT = 5_000
MAX_SEARCH_RESULTS = 50
MAX_TIMEOUT = 120  # 单次命令最大超时秒数
MAX_SUB_AGENT_ITERATIONS = 50  # 子代理最大循环次数
WORKDIR = Path.cwd()
SKILLS_DIR = WORKDIR / "skills"


def truncate(text: str, limit: int, label: str = "已截断") -> str:
    """截断超长文本，返回带标记的截断结果。"""
    if len(text) > limit:
        return text[:limit] + f"\n... ({label})"
    return text


def is_ignored(path: str) -> bool:
    """判断路径是否应被排除（匹配路径组件，非子字符串）。"""
    return any(d in Path(path).parts for d in EXCLUDE_DIRS)


def safe_path(path: str) -> Path:
    """解析并规范化文件路径，防止路径遍历攻击。

    - 相对路径基于 WORKDIR 解析为绝对路径
    - resolve() 消除 .. 和符号链接遍历
    - 越界检查：解析后路径必须在 WORKDIR 内
    """
    resolved = (WORKDIR / path).resolve()
    if not resolved.is_relative_to(WORKDIR):
        raise ValueError(f"路径越界: {path}")
    return resolved


_client = None  # 由 main() 设置，供 task 工具访问

SYSTEM_PROMPT = """你是一个终端里的 AI 编程助手。你可以读取文件、列出目录、搜索代码来帮助用户完成任务。
请用中文回答。在调用工具之前，先简要说明你打算做什么。

待办事项使用规则：
- 当任务预计需要 3 个以上步骤时，必须先调用 todo_create 规划所有步骤，再逐个执行
- 简单任务（1-2 步）不需要创建待办事项，直接执行即可
- 执行流程：todo_start(任务ID) → 执行实际工作 → todo_complete(任务ID) → todo_start(下一个)
- 同一时间只能有一个任务处于"正在进行"状态
- 如果执行中发现遗漏的步骤，用 todo_add 追加

技能系统：skills/ 目录中存放技能提示。使用流程：
1. 调用 list_skills() 查看可用技能列表
2. 根据任务需要，调用 load_skill(name="技能名") 加载技能全文，按其说明执行"""

SUB_AGENT_SYSTEM = "你是一个子智能体，负责完成父智能体分配的子任务。使用可用工具完成工作，完成后给出结果摘要。用中文回复。"


# ─── 工具注册表 ─────────────────────────────────────────────────────
# 声明即注册：@tool(schema) 同时注册 schema（给模型看）和 handler（给分发用）。
# 添加新工具只需在函数定义处加装饰器，一处修改即可。
_TOOL_SCHEMAS: list[dict] = []
_TOOL_HANDLERS: dict = {}


def tool(schema: dict):
    """装饰器：声明并注册一个工具。schema 遵循 Anthropic tool schema 格式。"""
    def decorator(func):
        name = schema["name"]
        _TOOL_SCHEMAS.append(schema)
        _TOOL_HANDLERS[name] = func
        return func
    return decorator



# ─── 工具执行器 ──────────────────────────────────────────────────────
def sanitize_text(text: str) -> str:
    """清除 surrogate 字符，确保字符串可被 UTF-8 / JSON 编码。

    Surrogate (U+D800–U+DFFF) 不是合法 Unicode scalar value，
    无法编码为 UTF-8。常见来源：终端字节级退格、surrogateescape IO。
    """
    try:
        text.encode("utf-8")
        return text  # 快速路径：无 surrogate，原样返回
    except UnicodeEncodeError:
        return text.encode("utf-8", errors="replace").decode("utf-8")


# ─── 技能管理器 ─────────────────────────────────────────────────────

class SkillManager:
    """技能管理器：扫描 skills/ 目录，解析 YAML frontmatter，提供注册表和加载功能。"""

    def __init__(self, skills_dir: Path):
        self._dir = skills_dir

    def _parse_skill_file(self, path: Path) -> dict | None:
        """解析单个技能文件，返回 {name, description, body}。解析失败返回 None。"""
        try:
            text = path.read_text(encoding="utf-8")
        except Exception:
            return None

        lines = text.split("\n")
        if not lines or lines[0].strip() != "---":
            return None

        frontmatter = {}
        end_idx = None
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                end_idx = i
                break
            line = lines[i].strip()
            if line.startswith("name:"):
                frontmatter["name"] = line[len("name:"):].strip()
            elif line.startswith("description:"):
                frontmatter["description"] = line[len("description:"):].strip()

        if end_idx is None or "name" not in frontmatter:
            return None

        body = "\n".join(lines[end_idx + 1:]).strip()
        return {
            "name": frontmatter["name"],
            "description": frontmatter.get("description", ""),
            "body": body,
        }

    def _scan_skills(self) -> list[dict]:
        """扫描目录，返回所有技能的 [{name, description}]。不含 body。"""
        if not self._dir.is_dir():
            return []
        results = []
        for f in sorted(self._dir.iterdir()):
            if not f.is_file():
                continue
            skill = self._parse_skill_file(f)
            if skill is not None:
                results.append({"name": skill["name"], "description": skill["description"]})
        return results

    def list_skills(self) -> str:
        """列出所有可用技能（name + description）。供模型浏览注册表。"""
        skills = self._scan_skills()
        if not skills:
            return "skills/ 目录为空或不存在"
        lines = ["可用技能："]
        for s in skills:
            lines.append(f"  - {s['name']}: {s['description']}")
        return "\n".join(lines)

    def load(self, name: str) -> str:
        """按 name 加载技能完整内容（name + description + body）。"""
        if not self._dir.is_dir():
            return "错误：skills/ 目录不存在"
        for f in sorted(self._dir.iterdir()):
            if not f.is_file():
                continue
            skill = self._parse_skill_file(f)
            if skill is not None and skill["name"] == name:
                parts = [f"技能：{skill['name']}", f"描述：{skill['description']}"]
                if skill["body"]:
                    parts.append(f"\n{skill['body']}")
                return "\n".join(parts)
        skills = self._scan_skills()
        if skills:
            available = ", ".join(s["name"] for s in skills)
            return f"错误：未找到技能 '{name}'。可用技能：{available}"
        return f"错误：未找到技能 '{name}'"



# ─── 待办事项管理器 ──────────────────────────────────────────────────

class TodoManager:
    """待办事项管理器：JSON 文件持久化，三种状态，严格串行执行。"""

    def __init__(self, path: Path):
        self._path = path

    def _load(self) -> dict:
        """从 JSON 文件加载。文件不存在则返回空结构。"""
        if not self._path.exists():
            return {"next_id": 1, "tasks": []}
        data = json.loads(self._path.read_text(encoding="utf-8"))
        # 防止 next_id 与已有任务 ID 重复
        if data["tasks"]:
            max_id = max(t["id"] for t in data["tasks"])
            data["next_id"] = max(data["next_id"], max_id + 1)
        return data

    def _save(self, data: dict) -> None:
        """将数据写回 JSON 文件。自动创建父目录。"""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _find_task(self, data: dict, task_id: int, expected_status: str | None = None) -> tuple:
        """查找任务并验证状态。返回 (task, error_msg)，成功时 error_msg 为 None。"""
        task = next((t for t in data["tasks"] if t["id"] == task_id), None)
        if task is None:
            return None, f"错误：任务 #{task_id} 不存在"
        if expected_status and task["status"] != expected_status:
            return None, f"错误：任务 #{task_id} 当前状态为 '{task['status']}'，无法执行此操作"
        return task, None

    def _new_task(self, data: dict, title: str, description: str) -> dict:
        """构造新任务字典并递增 next_id。"""
        task = {
            "id": data["next_id"],
            "title": title,
            "description": description,
            "status": "pending",
            "created_at": datetime.now().isoformat(timespec="seconds"),
        }
        data["next_id"] += 1
        return task

    def create(self, args: dict) -> str:
        """批量创建任务。模型规划阶段使用。"""
        data = self._load()
        created = []
        for t in args["tasks"]:
            task = self._new_task(data, t["title"], t["description"])
            data["tasks"].append(task)
            created.append(f"#{task['id']} {task['title']}")
        self._save(data)
        return f"已创建 {len(created)} 个任务: {', '.join(created)}"

    def start(self, args: dict) -> str:
        """开始执行任务。同一时间只能有一个 in_progress。"""
        data = self._load()
        task_id = args["task_id"]

        task, err = self._find_task(data, task_id, "pending")
        if err:
            return err

        in_progress = next((t for t in data["tasks"] if t["status"] == "in_progress"), None)
        if in_progress:
            return f"错误：任务 #{in_progress['id']}（{in_progress['title']}）正在执行中，请先完成它"

        task["status"] = "in_progress"
        self._save(data)
        return f"已开始任务 #{task_id}: {task['title']}\n\n" + self.list_tasks({}, data=data)

    def complete(self, args: dict) -> str:
        """完成任务。记录完成时间，显示剩余数量。"""
        data = self._load()
        task_id = args["task_id"]

        task, err = self._find_task(data, task_id, "in_progress")
        if err:
            return err

        task["status"] = "completed"
        task["completed_at"] = datetime.now().isoformat(timespec="seconds")
        self._save(data)

        pending = sum(1 for t in data["tasks"] if t["status"] == "pending")
        summary = f"已完成任务 #{task_id}，所有任务已完成" if pending == 0 else f"已完成任务 #{task_id}，剩余 {pending} 个未完成"
        return summary + "\n\n" + self.list_tasks({}, data=data)

    def add(self, args: dict) -> str:
        """追加单个任务到列表末尾。执行中发现遗漏时使用。"""
        data = self._load()
        task = self._new_task(data, args["title"], args["description"])
        data["tasks"].append(task)
        self._save(data)
        return f"已追加任务 #{task['id']}: {task['title']}"

    def list_tasks(self, args: dict, *, data: dict | None = None) -> str:
        """列出所有任务及状态统计。"""
        data = data or self._load()
        if not data["tasks"]:
            return "当前没有待办任务"

        status_icon = {"pending": " ", "in_progress": ">", "completed": "x"}
        total = len(data["tasks"])
        done = sum(1 for t in data["tasks"] if t["status"] == "completed")

        lines = [f"{done}/{total} 已完成", ""]
        for t in data["tasks"]:
            icon = status_icon.get(t["status"], " ")
            lines.append(f"[{icon}] #{t['id']} {t['title']} — {t['description']}")
        return "\n".join(lines)


# ─── 工具实现 ────────────────────────────────────────────────────────

@tool({
    "name": "read_file",
    "description": "读取指定路径文件的内容。返回文件的完整文本。",
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "要读取的文件路径（相对或绝对路径）",
            }
        },
        "required": ["path"],
    },
})
def read_file(args: dict) -> str:
    """读取文件内容。"""
    path = args["path"]
    try:
        target = safe_path(path)
        content = target.read_text(encoding="utf-8", errors="replace")
        return truncate(content, MAX_FILE_READ, "文件过长，已截断")
    except FileNotFoundError:
        return f"错误：文件不存在 '{path}'"
    except IsADirectoryError:
        return f"错误：'{path}' 是一个目录，不是文件"
    except Exception as e:
        return f"错误：读取文件失败 — {e}"


@tool({
    "name": "list_files",
    "description": "用 glob 模式列出目录中的文件。返回匹配的文件路径列表。",
    "input_schema": {
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "glob 模式，例如 '**/*.py' 或 'src/*.ts'",
            }
        },
        "required": ["pattern"],
    },
})
def list_files(args: dict) -> str:
    """用 glob 模式列出文件。"""
    pattern = args["pattern"]
    base = WORKDIR.resolve()
    matches = glob.glob(str(base / pattern), recursive=True)
    matches = [m for m in matches if not is_ignored(m)]
    # 只保留 WORKDIR 内的文件
    matches = [m for m in matches if Path(m).resolve().is_relative_to(base)]
    if not matches:
        return f"没有找到匹配 '{pattern}' 的文件"
    return truncate("\n".join(matches), MAX_TOOL_OUTPUT, "结果过长，已截断")


@tool({
    "name": "search_content",
    "description": "在文件中搜索文本内容（类似 grep）。返回匹配的文件路径和行内容。",
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "要搜索的文本",
            },
            "path": {
                "type": "string",
                "description": "搜索的目录路径，默认为当前目录",
            },
        },
        "required": ["query"],
    },
})
def search_content(args: dict) -> str:
    """在文件中搜索文本。"""
    query = args["query"]
    search_path = args.get("path", ".")
    try:
        results = []
        root = safe_path(search_path)

        for filepath in root.glob("**/*"):
            if is_ignored(str(filepath)):
                continue
            if not filepath.is_file():
                continue
            try:
                text = filepath.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue

            for i, line in enumerate(text.splitlines(), 1):
                if query in line:
                    results.append(f"{filepath}:{i}: {line.strip()}")

            if len(results) >= MAX_SEARCH_RESULTS:
                break

        if not results:
            return f"在 '{search_path}' 中未找到包含 '{query}' 的内容"
        return truncate("\n".join(results), MAX_TOOL_OUTPUT, "结果过长，已截断")
    except ValueError as e:
        return f"错误：{e}"
    except Exception as e:
        return f"错误：搜索失败 — {e}"


@tool({
    "name": "run_bash",
    "description": "执行 bash 命令并返回输出。支持管道和重定向。超时 30 秒自动终止。",
    "input_schema": {
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "要执行的 bash 命令",
            },
            "timeout": {
                "type": "integer",
                "description": "超时秒数，默认 30",
            },
        },
        "required": ["command"],
    },
})
def run_bash(args: dict) -> str:
    """执行 bash 命令，返回 stdout + stderr。"""
    command = args["command"]
    timeout = min(args.get("timeout", 30), MAX_TIMEOUT)
    try:
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True,
            timeout=timeout, encoding="utf-8", errors="replace"
        )
        output = ""
        if result.stdout:
            output += result.stdout
        if result.stderr:
            if output:
                output += "\n--- stderr ---\n"
            output += result.stderr
        if result.returncode != 0:
            output += f"\n[退出码: {result.returncode}]"

        output = truncate(output, MAX_TOOL_OUTPUT, "输出过长，已截断")
        return output or "(无输出)"
    except subprocess.TimeoutExpired:
        return f"错误：命令执行超时（{timeout}秒）"
    except Exception as e:
        return f"错误：命令执行失败 — {e}"


@tool({
    "name": "write_file",
    "description": "创建或完整覆写文件。需要提供文件全部内容。适用于创建新文件或完全重写。",
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "文件路径",
            },
            "content": {
                "type": "string",
                "description": "要写入的完整文件内容",
            },
        },
        "required": ["path", "content"],
    },
})
def write_file(args: dict) -> str:
    """创建或完整覆写文件。自动创建父目录。"""
    path = args["path"]
    content = args["content"]
    try:
        target = safe_path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        lines = content.count("\n") + (0 if content.endswith("\n") else 1)
        return f"已写入 {path}（{lines} 行，{len(content)} 字符）"
    except Exception as e:
        return f"错误：写入文件失败 — {e}"


@tool({
    "name": "edit_file",
    "description": (
        "精确替换文件中的局部内容。只替换第一次匹配。"
        "如果 old_text 在文件中找不到，会报错而非静默失败。"
        "适用于修改现有文件中的少量内容。"
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "文件路径",
            },
            "old_text": {
                "type": "string",
                "description": "要被替换的原文（必须与文件中的内容精确匹配）",
            },
            "new_text": {
                "type": "string",
                "description": "替换后的新内容",
            },
        },
        "required": ["path", "old_text", "new_text"],
    },
})
def edit_file(args: dict) -> str:
    """精确替换文件中首次匹配的文本。找不到 old_text 时报错。"""
    path = args["path"]
    old_text = args["old_text"]
    new_text = args["new_text"]
    try:
        target = safe_path(path)
        content = target.read_text(encoding="utf-8", errors="replace")

        if old_text not in content:
            return f"错误：在 '{path}' 中未找到要替换的文本。请确认 old_text 与文件内容精确匹配。"

        new_content = content.replace(old_text, new_text, 1)
        target.write_text(new_content, encoding="utf-8")

        # 返回变更摘要
        old_lines = old_text.count("\n") + 1
        new_lines = new_text.count("\n") + 1
        return f"已编辑 {path}（替换 {old_lines} 行 → {new_lines} 行）"
    except FileNotFoundError:
        return f"错误：文件不存在 '{path}'"
    except Exception as e:
        return f"错误：编辑文件失败 — {e}"


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
    if _todo_mgr is None:
        return "错误：待办事项系统未初始化"
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
    if _todo_mgr is None:
        return "错误：待办事项系统未初始化"
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
    if _todo_mgr is None:
        return "错误：待办事项系统未初始化"
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
    if _todo_mgr is None:
        return "错误：待办事项系统未初始化"
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
    if _todo_mgr is None:
        return "错误：待办事项系统未初始化"
    return _todo_mgr.list_tasks(args)


# ─── 技能工具 ──────────────────────────────────────────────────────

_skill_mgr: SkillManager | None = None


@tool({
    "name": "list_skills",
    "description": "列出所有可用技能的名称和描述。用于浏览技能注册表，选择合适的技能。",
    "input_schema": {
        "type": "object",
        "properties": {},
    },
})
def list_skills_tool(args: dict) -> str:
    """列出所有可用技能的名称和描述。"""
    if _skill_mgr is None:
        return "错误：技能系统未初始化"
    return _skill_mgr.list_skills()


@tool({
    "name": "load_skill",
    "description": "加载指定技能的完整内容（名称、描述、正文）。加载后按技能说明执行。",
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "要加载的技能名称",
            }
        },
        "required": ["name"],
    },
})
def load_skill(args: dict) -> str:
    """加载指定技能的完整内容。"""
    if _skill_mgr is None:
        return "错误：技能系统未初始化"
    return _skill_mgr.load(args["name"])


# 子代理工具集（此时 _TOOL_SCHEMAS 含基础工具 + 技能工具，无需过滤）
_SUB_TOOLS = list(_TOOL_SCHEMAS)
_SUB_HANDLERS = dict(_TOOL_HANDLERS)


# ─── 子智能体工具 ─────────────────────────────────────────────────────

@tool({
    "name": "task",
    "description": "创建子智能体执行子任务。子智能体拥有独立的上下文窗口，可以使用除 task 外的所有工具。适合将复杂任务拆分为可并行的子任务。",
    "input_schema": {
        "type": "object",
        "properties": {
            "description": {
                "type": "string",
                "description": "子任务描述：告诉子智能体要完成什么工作",
            }
        },
        "required": ["description"],
    },
})
def task_tool(args: dict) -> str:
    """创建子智能体，在线程中运行，返回最终结果。"""
    if _client is None:
        return "错误：系统未初始化"
    description = args["description"]

    result = {"output": None}

    def run():
        try:
            result["output"] = run_agent_loop(
                _client, description,
                tools=_SUB_TOOLS, tool_handlers=_SUB_HANDLERS,
                system=SUB_AGENT_SYSTEM, quiet=True,
                max_iterations=MAX_SUB_AGENT_ITERATIONS,
            )
        except Exception as e:
            result["output"] = f"子智能体错误：{e}"

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join()

    return result["output"] or "子智能体未返回结果"


# 主 agent 工具集 = 子代理工具集 + task
_MAIN_TOOLS = list(_TOOL_SCHEMAS)
_MAIN_HANDLERS = dict(_TOOL_HANDLERS)


# ─── Agent Loop ─────────────────────────────────────────────────────

def _agent_step(client, messages, tools, tool_handlers, system, quiet):
    """执行一次 agent 循环迭代。
    返回 str 表示最终结果（循环结束），返回 None 表示需要继续迭代。
    """
    response = client.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=system,
        tools=tools,
        messages=messages,
    )

    assistant_content = response.content
    messages.append({"role": "assistant", "content": assistant_content})

    # 单次遍历：收集文本 + 工具调用
    text_parts = []
    tool_blocks = []
    for block in assistant_content:
        if block.type == "text":
            text_parts.append(block.text)
            if not quiet:
                print(f"\n>> {block.text}")
        elif block.type == "tool_use":
            tool_blocks.append(block)

    if response.stop_reason == "end_turn":
        if not text_parts:
            return None  # API 返回空内容，继续迭代
        return "\n".join(text_parts)

    if response.stop_reason == "tool_use":
        tool_results = []
        for block in tool_blocks:
            if not quiet:
                print(f"\n  [tool] {block.name}({block.input})")

            handler = tool_handlers.get(block.name)
            if handler is None:
                result = f"错误：未知工具 '{block.name}'"
            else:
                result = sanitize_text(handler(block.input))

            result = truncate(result, MAX_TOOL_OUTPUT, "结果过长，已截断")

            if not quiet:
                print(f"   → {result[:200]}{'...' if len(result) > 200 else ''}")

            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": result,
            })

        messages.append({"role": "user", "content": tool_results})
        return None  # 继续迭代

    if not quiet:
        if response.stop_reason == "max_tokens":
            print("\n[warn] 模型输出被 max_tokens 截断，内容可能不完整")
        else:
            print(f"\n[warn] 循环结束，stop_reason: {response.stop_reason}")
    return "\n".join(text_parts)


def run_agent_loop(client, user_message, *, tools=None, tool_handlers=None, system=None, quiet=False, max_iterations=0):
    """智能体循环。返回最终文本输出。

    主 agent（max_iterations=0）：while 无限循环，支持长任务
    子代理（max_iterations>0）：for 循环，结构上保证不会无限循环
    """
    tools = tools or _MAIN_TOOLS
    tool_handlers = tool_handlers or _MAIN_HANDLERS
    system = system or SYSTEM_PROMPT

    messages = [{"role": "user", "content": user_message}]
    step = lambda: _agent_step(client, messages, tools, tool_handlers, system, quiet)

    if max_iterations:
        # 子代理：for 循环，硬性上限防卡死
        for _ in range(max_iterations):
            result = step()
            if result is not None:
                return result
        return "已达到最大迭代次数，任务可能未完成"
    else:
        # 主 agent：while 无限循环，无次数限制
        while True:
            result = step()
            if result is not None:
                return result


# ─── 主入口 ─────────────────────────────────────────────────────────
def main():
    # 从环境变量获取 API 配置
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        # 尝试从 docker/.env 读取
        env_path = Path(__file__).resolve().parent.parent.parent / "docker" / ".env"
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                line = line.strip()
                if line.startswith("ANTHROPIC_API_KEY="):
                    api_key = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break

    if not api_key:
        print("错误：未找到 ANTHROPIC_API_KEY 环境变量")
        print("请设置环境变量或在 docker/.env 中配置")
        sys.exit(1)

    # 创建客户端
    global _client
    _client = anthropic.Anthropic(api_key=api_key, base_url=BASE_URL)

    # 初始化待办事项管理器
    todo_path = Path(os.environ.get(
        "MI_CODE_TODO_PATH",
        str(WORKDIR / ".mi-code" / "todo.json"),
    ))
    global _todo_mgr
    _todo_mgr = TodoManager(todo_path)

    # 初始化技能管理器
    global _skill_mgr
    _skill_mgr = SkillManager(SKILLS_DIR)

    print("=" * 60)
    print("  mi-code Agent Loop")
    print(f"  模型: {MODEL}")
    print(f"  工具: {', '.join(_TOOL_HANDLERS.keys())}")
    print("  输入 'q' 或 'quit' 退出")
    print("=" * 60)

    # 外层交互循环
    while True:
        try:
            user_input = pt_prompt("\n你> ").strip()
            user_input = sanitize_text(user_input)
        except (EOFError, KeyboardInterrupt):
            print("\n再见！")
            break

        if not user_input:
            continue
        if user_input.lower() in ("q", "quit"):
            print("再见！")
            break

        try:
            run_agent_loop(_client, user_input)
        except anthropic.APIError as e:
            print(f"\n[error] API 错误: {e}")
        except Exception as e:
            print(f"\n[error] 错误: {e}")


if __name__ == "__main__":
    main()
