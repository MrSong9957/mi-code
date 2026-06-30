// 工具注册表：注册、查找、执行工具
import { spawnSync } from 'child_process';
import { Encoder } from '../output/encoder.js';
import type { ToolDefinition, ToolExecutor, RegisteredTool } from './types.js';
import { createReadFileTool, createWriteFileTool, createEditFileTool } from './tools/index.js';
import { createTodoTool } from './tools/todo-tool.js';
import { createIdleTool } from './tools/idle-tool.js';
import { createClaimTaskTool } from './tools/claim-task-tool.js';
import { createScheduleTool, createScheduleListTool, createScheduleRemoveTool, createScheduleUpdateTool } from './tools/schedule-tool.js';
import { createBackgroundTool } from './tools/background-tool.js';
import type { TodoManager } from './todo.js';
import type { ScheduleManager } from './scheduler/schedule-manager.js';
import type { BackgroundManager } from '../background/background-manager.js';
import type { TaskBoard } from '../task-board/task-board.js';
import type { WorktreeManager } from '../worktree/worktree-manager.js';
import { createTaskMatrixTool, createMarkTaskDoneTool } from './tools/task-board-tool.js';
import { createWorktreeTool } from './tools/worktree-tool.js';

export class ToolRegistry {
  private _tools = new Map<string, RegisteredTool>();

  /** 获取所有工具（供 Vercel AI SDK 使用） */
  get tools(): Map<string, RegisteredTool> {
    return this._tools;
  }

  /** 注册工具 */
  register(definition: ToolDefinition, executor: ToolExecutor): void {
    this._tools.set(definition.name, { definition, executor });
  }

  /** 获取工具定义列表（传给 LLM） */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this._tools.values()).map(t => t.definition);
  }

  /** 执行工具 */
  async execute(name: string, input: Record<string, unknown>): Promise<string> {
    const tool = this._tools.get(name);
    if (!tool) {
      return `Error: Unknown tool "${name}"`;
    }
    try {
      return await tool.executor(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error executing tool "${name}": ${message}`;
    }
  }

  /** 已注册工具数量 */
  get size(): number {
    return this._tools.size;
  }
}

/** 只读工具列表（可并发安全执行） */
const READ_ONLY_TOOLS = new Set(['read_file', 'load_skill', 'todo_write', 'schedule_list', 'glob', 'ls']);

/** 判断工具是否只读 */
export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}

/**
 * 工具并发分区：把工具调用序列分成 batch
 *
 * 只读工具连续出现 → 合成一个 batch（并行）
 * 写工具 → 各自独立 batch（串行）
 *
 * 物理本质：快递分拣。
 * 小件（只读）可以同时扔上传送带，大件（写）要一个个搬。
 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ToolBatch = { calls: ToolCall[]; parallel: boolean };

export function partitionToolCalls(calls: ToolCall[]): ToolBatch[] {
  const batches: ToolBatch[] = [];
  let currentRead: ToolCall[] = [];

  for (const call of calls) {
    if (isReadOnlyTool(call.name)) {
      currentRead.push(call);
    } else {
      // 先把积攒的只读 batch 推出去
      if (currentRead.length > 0) {
        batches.push({ calls: currentRead, parallel: true });
        currentRead = [];
      }
      // 写工具独立 batch
      batches.push({ calls: [call], parallel: false });
    }
  }

  // 尾部只读 batch
  if (currentRead.length > 0) {
    batches.push({ calls: currentRead, parallel: true });
  }

  return batches;
}

/** 内置工具：执行 bash 命令 */
export function createBashTool(): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'run_bash',
      description: 'Execute a shell command and return its output',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute',
          },
        },
        required: ['command'],
      },
    },
    executor: async (input) => {
      const command = input.command as string;
      // 使用 spawnSync 替代 execSync，显式配置 stdio 为 'pipe' 以捕获 stderr
      // 而非让它直接输出到终端（导致乱码显示在 UI 上）
      const result = spawnSync(command, {
        shell: true,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        // 不指定 encoding，确保返回 Buffer 以便正确处理 GBK
        stdio: ['pipe', 'pipe', 'pipe'], // 显式捕获 stdin/stdout/stderr
        windowsHide: true, // 隐藏 Windows 上的 CMD 窗口
      });

      // 检查是否超时
      if (result.error) {
        const err = result.error as NodeJS.ErrnoException;
        if (err.code === 'ETIMEDOUT') {
          return 'Command timed out after 30 seconds';
        }
        return `Command failed: ${err.message}`;
      }

      // 有 stderr 输出（命令可能失败）
      if (result.stderr && result.stderr.length > 0) {
        const stderr = typeof result.stderr === 'string' ? result.stderr : Encoder.decodeBuffer(result.stderr);
        // 如果命令失败（非零退出码），返回 stderr
        if (result.status !== 0) {
          return stderr;
        }
        // 命令成功但有 stderr（警告），附加到 stdout
        const stdout = result.stdout ? (typeof result.stdout === 'string' ? result.stdout : Encoder.decodeBuffer(result.stdout)) : '';
        return stdout ? `${stdout}\n${stderr}` : stderr;
      }

      // 命令成功，返回 stdout
      if (result.stdout) {
        return typeof result.stdout === 'string' ? result.stdout : Encoder.decodeBuffer(result.stdout);
      }

      // 无输出
      return '';
    },
  };
}

/** 创建默认工具注册表 */
export function createDefaultRegistry(
  todoManager?: TodoManager,
  agentName?: string,
  scheduler?: ScheduleManager,
  backgroundManager?: BackgroundManager,
  taskBoard?: TaskBoard,
  worktreeManager?: WorktreeManager,
): ToolRegistry {
  const registry = new ToolRegistry();

  // 注册内置工具
  const bash = createBashTool();
  registry.register(bash.definition, bash.executor);

  const readFile = createReadFileTool();
  registry.register(readFile.definition, readFile.executor);

  const writeFile = createWriteFileTool();
  registry.register(writeFile.definition, writeFile.executor);

  const editFile = createEditFileTool();
  registry.register(editFile.definition, editFile.executor);

  // 注册 todo 工具（如果有 TodoManager）
  if (todoManager) {
    const todo = createTodoTool(todoManager);
    registry.register(todo.definition, todo.executor);

    // 注册 idle 工具
    const idle = createIdleTool();
    registry.register(idle.definition, idle.executor);

    // 注册 claim_task 工具（如果有 agentName）
    if (agentName) {
      const claimTask = createClaimTaskTool(todoManager, agentName);
      registry.register(claimTask.definition, claimTask.executor);
    }
  }

  // 注册调度工具（如果有 ScheduleManager）
  if (scheduler) {
    const scheduleCreate = createScheduleTool(scheduler);
    registry.register(scheduleCreate.definition, scheduleCreate.executor);

    const scheduleList = createScheduleListTool(scheduler);
    registry.register(scheduleList.definition, scheduleList.executor);

    const scheduleRemove = createScheduleRemoveTool(scheduler);
    registry.register(scheduleRemove.definition, scheduleRemove.executor);

    const scheduleUpdate = createScheduleUpdateTool(scheduler);
    registry.register(scheduleUpdate.definition, scheduleUpdate.executor);
  }

  // 注册后台任务工具（如果有 BackgroundManager）
  if (backgroundManager) {
    const bg = createBackgroundTool(backgroundManager);
    registry.register(bg.definition, bg.executor);
  }

  // 注册任务看板工具（如果有 TaskBoard）
  if (taskBoard) {
    const matrixTool = createTaskMatrixTool(taskBoard);
    registry.register(matrixTool.definition, matrixTool.executor);
    const doneTool = createMarkTaskDoneTool(taskBoard);
    registry.register(doneTool.definition, doneTool.executor);
  }

  // 注册 worktree 工具（如果有 WorktreeManager）
  if (worktreeManager) {
    const wt = createWorktreeTool(worktreeManager);
    registry.register(wt.definition, wt.executor);
  }

  return registry;
}
