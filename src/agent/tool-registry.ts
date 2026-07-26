// 工具注册表：注册、查找、执行工具
import { spawn } from 'child_process';
import { Encoder } from '../output/encoder.js';
import { killProcessTree } from './process-tree.js';
import type { ToolDefinition, ToolExecutor, RegisteredTool, ToolExecutionContext } from './types.js';
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
import {
  decideChildProcessEnvironment,
  getDefaultEnvironmentPolicy,
} from '../permission/child-environment.js';
import {
  buildToolDefinitionSnapshot,
  type ToolDefinitionSnapshot,
  type ToolDescriptor,
} from './tools/descriptor-snapshot.js';
import type { RequestToolViewSnapshot } from './tools/overlay.js';

export class ToolRegistry {
  private _tools = new Map<string, RegisteredTool>();

  /** 获取所有工具（供 Vercel AI SDK 使用） */
  get tools(): Map<string, RegisteredTool> {
    return this._tools;
  }

  /** 注册工具 */
  register(definition: ToolDefinition, executor: ToolExecutor): void {
    // RC-2:tool_id 是身份(不可重复)。重复注册直接抛错,不再静默覆盖。
    if (this._tools.has(definition.name)) {
      throw new Error(`Duplicate tool id: ${definition.name}`);
    }
    this._tools.set(definition.name, { definition, executor });
  }

  /** 获取工具定义列表（传给 LLM） */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this._tools.values()).map(t => t.definition);
  }

  /**
   * 构建一份不可变的工具定义快照(RC-2)。
   *
   * 物理本质:曝光底片。把当前注册表的所有工具定义 + 注册顺序深拷贝 +
   * 三层冻结,后续注册表增删或原始 definition 被 mutate 都不影响返回值。
   * 模型请求应从快照构建,避免一次 turn 内工具集漂移。
   *
   * 注意:Wave B(M-021/M-024)会让请求构建器改用此方法,getDefinitions()
   * 当前保留不动作为兼容路径。
   */
  getDefinitionSnapshot(registrySnapshotId: string): ToolDefinitionSnapshot {
    return buildToolDefinitionSnapshot(registrySnapshotId, this._tools);
  }

  /** 执行工具(透传 ctx 给 executor,旧 executor 忽略该可选参数) */
  async execute(
    name: string,
    input: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    const tool = this._tools.get(name);
    if (!tool) {
      return `Error: Unknown tool "${name}"`;
    }
    try {
      return await tool.executor(input, ctx);
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

// ─────────────────────────────────────────────────────────────────────────────
// Wave B Task 4 (M-021): materializeIncludedToolDefinitions
// ─────────────────────────────────────────────────────────────────────────────
//
// 物理本质:把"per-request 工具视图"(哪些工具 included/excluded)+ 一份 base
// 工具定义快照,显影成一份可发送给 provider 的 `ToolDefinition[]`。
//
// 这是 overlay/capability 层与 QueryEngine 之间的最后一段接驳:
//   - 上游 overlay 层(decision)决定"哪些工具可见"
//   - 本函数(execution 路径)负责"把可见工具的 schema 抠出来 deep-copy 后发出去"
//
// 关键不变量(BRC-2):
//   1. view 与 base 的身份必须一致(view.base_tool_snapshot_id === base.registry_snapshot_id)
//   2. 只输出 visibility === 'included' 的工具,excluded 工具不出现
//   3. included 工具必须在 base 中存在
//   4. canonical_order 不能漂移(view entry 与 base descriptor 必须一致)
//   5. included 工具的 description_asset_ref 状态由 overlay 决定 —— overlay 把
//      metadata 缺失的工具视为 approved-by-default,此时 entry 的 description_asset_ref
//      合法地为 null(常见于无显式 metadata 的内置工具)。本 materializer 不二次解释
//      overlay 的 approval 决策:view 说 included 即 included。
//   6. 输出是 NEW 数组 + 深拷贝,调用方 mutate 不影响 base / Registry
//   7. 输出按 canonical_order 升序(view.entries 已按此序,但显式排序保证稳健)
//   8. 不修改 Registry 或 base 快照
//
// 不感知 Provider / Capability / Permission:本函数只是"按视图剪一份 schema"。

/**
 * 把一份 RequestToolViewSnapshot + 对应的 base ToolDefinitionSnapshot,
 * 物化成发给 provider 的 `ToolDefinition[]`。
 *
 * @throws 当 view 与 base 的身份不一致时。
 * @throws 当某个 included tool_id 不在 base 中时。
 * @throws 当 canonical_order 在 view entry 与 base descriptor 之间漂移时。
 */
export function materializeIncludedToolDefinitions(
  view: RequestToolViewSnapshot,
  base: ToolDefinitionSnapshot,
): ToolDefinition[] {
  // 规则 1:身份一致性校验。view 必须引用同一份 base snapshot。
  if (view.base_tool_snapshot_id !== base.registry_snapshot_id) {
    throw new Error(
      `tool view base_tool_snapshot_id mismatch: ` +
        `view=${view.base_tool_snapshot_id} base=${base.registry_snapshot_id}`,
    );
  }

  // 规则 3 预备:base descriptor 按 tool_id 索引,便于 O(1) 查找。
  // 同时存原 descriptor 用于规则 4 的 canonical_order 一致性断言。
  const baseByToolId: Map<string, Readonly<ToolDescriptor>> = new Map();
  for (const d of base.descriptors) {
    baseByToolId.set(d.tool_id, d);
  }

  const out: ToolDefinition[] = [];

  // entries 已按 canonical_order 升序(overlay 保证);为稳健起见,这里仍然
  // 按 canonical_order 显式排序一次,避免上游某天顺序变化导致 Provider 收到乱序。
  const sortedEntries = [...view.entries].sort((a, b) => {
    if (a.canonical_order < b.canonical_order) return -1;
    if (a.canonical_order > b.canonical_order) return 1;
    return 0;
  });

  for (const entry of sortedEntries) {
    // 规则 2:只输出 included。
    if (entry.visibility !== 'included') continue;

    // 规则 3:included 工具必须在 base 中。
    const baseDescriptor = baseByToolId.get(entry.tool_id);
    if (!baseDescriptor) {
      throw new Error(
        `included tool "${entry.tool_id}" not found in base snapshot ` +
          `(base_tool_snapshot_id=${base.registry_snapshot_id})`,
      );
    }

    // 规则 4:canonical_order 不能漂移(view entry 与 base descriptor 必须一致)。
    if (entry.canonical_order !== baseDescriptor.canonical_order) {
      throw new Error(
        `canonical_order drift for "${entry.tool_id}": ` +
          `view=${entry.canonical_order} base=${baseDescriptor.canonical_order}`,
      );
    }

    // 规则 5:不在 materializer 层判断 description_asset_ref 是否为 null。
    // overlay 把 metadata 缺失的工具视为 approved-by-default,此时 entry 合法地
    // 带 null description_asset_ref(常见于无显式 metadata 的内置工具)。
    // view 说 included 即 included —— approval 的真值在 overlay 层,不在这里。

    // 规则 6:深拷贝一份 ToolDefinition(隔离调用方 mutate)。
    // base descriptor 的 definition 已经在 buildToolDefinitionSnapshot 里深拷贝过一次,
    // 这里再拷一次,确保返回数组与 base / Registry 完全无引用耦合。
    out.push(structuredClone(baseDescriptor.definition) as ToolDefinition);
  }

  // 规则 7:输出 NEW 数组(深拷贝完毕,顺序正确)。规则 8:无副作用。
  return out;
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

      // BRC-6 / M-063：子进程环境清洗。
      // 父进程 process.env 在此 ONCE 读取（sanctioned read point），交给
      // decideChildProcessEnvironment 构造 sanitized env。spawn 必须显式传 env，
      // 不得省略——省略等于隐式整包继承父环境（secret 会泄漏）。
      const envPolicy = getDefaultEnvironmentPolicy(process.platform);
      const envDecision = decideChildProcessEnvironment(
        {
          launch_snapshot_id: `bash:${command.slice(0, 32)}`,
          launcher_kind: 'shell_tool',
          executable_ref: command,
          parent_environment: process.env as Record<string, string>,
          required_variable_names: [],
          environment_policy_id: envPolicy.environment_policy_id,
          environment_policy_version: envPolicy.environment_policy_version,
        },
        envPolicy,
      );
      if (envDecision.sanitized_environment === null) {
        const reason = envDecision.missing_required_variable_names.length > 0
          ? `missing required: ${envDecision.missing_required_variable_names.join(', ')}`
          : `denied by policy ${envPolicy.environment_policy_id}@${envPolicy.environment_policy_version}`;
        return `Error: child environment denied: ${reason}`;
      }
      // 捕获到局部 const，避免 Promise closure 内的 narrowing 丢失（sanitized_environment
      // 在类型上仍是 Record | null，closure 看不到上面的 null 收窄）。
      const sanitizedEnv = envDecision.sanitized_environment;

      // 异步 spawn + 手动超时 + 进程树终止（替代 spawnSync 的孤儿进程泄漏）
      // 物理本质：spawnSync 超时只杀门面接待员（cmd.exe），孙进程（dev server）变孤儿。
      // 改用 spawn + killProcessTree 做"全楼清场"，超时后整棵进程树请走。
      return new Promise<string>((resolve) => {
        const child = spawn(command, {
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: sanitizedEnv,
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
