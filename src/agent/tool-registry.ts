// 工具注册表：注册、查找、执行工具
import { spawn } from 'child_process';
import { Encoder } from '../output/encoder.js';
import { killProcessTree } from './process-tree.js';
import type { ToolDefinition, ToolExecutor, RegisteredTool } from './types.js';
import { createReadFileTool, createWriteFileTool, createEditFileTool } from './tools/index.js';
import { createGlobTool, createGrepTool } from './tools/search-tools.js';
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
import { READ_ONLY_TOOLS } from '../permission/types.js';

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

/**
 * 只读工具列表（可并发安全执行）
 *
 * 复用 permission/types.ts 的 READ_ONLY_TOOLS（唯一真相源），
 * 避免工具层与权限判定使用不同标准导致漂移。
 */
const READ_ONLY_SET = new Set(READ_ONLY_TOOLS);

/** 判断工具是否只读 */
export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_SET.has(name);
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

      // 异步 spawn + 手动超时 + 进程树终止（替代 spawnSync 的孤儿进程泄漏）
      // 物理本质：spawnSync 超时只杀门面接待员（cmd.exe），孙进程（dev server）变孤儿。
      // 改用 spawn + killProcessTree 做"全楼清场"，超时后整棵进程树请走。
      return new Promise<string>((resolve) => {
        const child = spawn(command, {
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });

        // 流式收集 stdout/stderr（Buffer[]，末尾 concat 后 decodeBuffer 保留 GBK 处理）
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        const MAX_OUTPUT = 1024 * 1024; // 1MB（对齐原 maxBuffer）
        let stdoutLen = 0;
        let stderrLen = 0;
        let stdoutCapped = false;
        let stderrCapped = false;
        let timedOut = false;

        // 流式截断：超 1MB 后停止 push（但不 pause/destroy 流，防 backpressure 挂死）
        if (child.stdout) {
          child.stdout.on('data', (chunk: Buffer) => {
            if (stdoutCapped) return;
            if (stdoutLen + chunk.length > MAX_OUTPUT) {
              stdoutChunks.push(chunk.subarray(0, MAX_OUTPUT - stdoutLen));
              stdoutChunks.push(Buffer.from('\n... (truncated)'));
              stdoutCapped = true;
            } else {
              stdoutChunks.push(chunk);
              stdoutLen += chunk.length;
            }
          });
        }
        if (child.stderr) {
          child.stderr.on('data', (chunk: Buffer) => {
            if (stderrCapped) return;
            if (stderrLen + chunk.length > MAX_OUTPUT) {
              stderrChunks.push(chunk.subarray(0, MAX_OUTPUT - stderrLen));
              stderrChunks.push(Buffer.from('\n... (truncated)'));
              stderrCapped = true;
            } else {
              stderrChunks.push(chunk);
              stderrLen += chunk.length;
            }
          });
        }

        // 超时定时器：30s 后杀整棵进程树
        const timer = setTimeout(() => {
          timedOut = true;
          if (child.pid) killProcessTree(child.pid);
        }, 30000);

        // 进程结束（stdio 流关闭后触发 close）
        child.on('close', (code) => {
          clearTimeout(timer);

          if (timedOut) {
            resolve('Command timed out after 30 seconds');
            return;
          }

          const stdout = stdoutChunks.length > 0 ? Encoder.decodeBuffer(Buffer.concat(stdoutChunks)) : '';
          const stderr = stderrChunks.length > 0 ? Encoder.decodeBuffer(Buffer.concat(stderrChunks)) : '';

          // 命令失败（非零退出码）：返回 stderr
          if (code !== 0) {
            resolve(stderr || stdout || `Command exited with code ${code}`);
            return;
          }

          // 命令成功：有 stderr（警告）则附加，否则纯 stdout
          if (stderr) {
            resolve(stdout ? `${stdout}\n${stderr}` : stderr);
            return;
          }
          resolve(stdout);
        });

        // spawn 失败（命令不存在等）
        child.on('error', (err) => {
          clearTimeout(timer);
          resolve(`Command failed: ${err.message}`);
        });
      });
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

  // 注册搜索工具（plan 模式探索主力，全程只读）
  const glob = createGlobTool();
  registry.register(glob.definition, glob.executor);
  const grep = createGrepTool();
  registry.register(grep.definition, grep.executor);

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
