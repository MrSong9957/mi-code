// StreamingToolExecutor：流式工具执行器（v2：基于结构化事件）
//
// 物理本质：快递分拣中心。
// AI 输出的每个工具调用就是一个快递包裹。
// addTool → 包裹放到传送带
// processQueue → 分拣员根据包裹类型决定怎么处理
//   - 只读工具（读文件、搜索）→ 可以同时拆多个包裹（并发）
//   - 写入工具（写文件、执行命令）→ 必须一个一个拆（独占）
// getRemainingResults → 等所有包裹拆完，按顺序取结果

import type { ToolRegistry } from './tool-registry.js';
import type { ToolUseBlock, ContentBlock } from './types.js';
import type { PermissionChecker } from '../permission/checker.js';
import { READ_ONLY_TOOLS } from '../permission/types.js';
import type { RuntimeSecurityGate, DeniedAction } from '../permission/runtime-gate.js';
import { createHash } from 'node:crypto';

/** 工具执行状态 */
export type ToolStatus = 'queued' | 'executing' | 'completed' | 'yielded';

/** 跟踪中的工具调用 */
export interface TrackedTool {
  id: string;
  block: ToolUseBlock;
  status: ToolStatus;
  isConcurrencySafe: boolean;
  results?: ContentBlock[];
  error?: string;
}

/**
 * 并发安全的只读工具白名单
 *
 * 复用 permission/types.ts 的 READ_ONLY_TOOLS（唯一真相源），
 * 避免并发分区与权限判定使用不同标准导致漂移。
 */
const CONCURRENCY_SAFE_TOOLS = new Set(READ_ONLY_TOOLS);

/**
 * 判断工具是否可并发执行（只读工具可并发，写入工具必须独占）
 */
export function isConcurrencySafe(toolName: string, _input?: Record<string, unknown>): boolean {
  return CONCURRENCY_SAFE_TOOLS.has(toolName);
}

/**
 * StreamingToolExecutor v2
 *
 * 基于结构化事件的流式工具执行器。
 * 替代原来的文本解析方式，通过 addTool() 直接传入已解析的 ToolUseBlock。
 */
export class StreamingToolExecutor {
  private registry: ToolRegistry;
  private permissionChecker?: PermissionChecker;
  private runtimeGate?: RuntimeSecurityGate;
  private tools: TrackedTool[] = [];
  private discarded = false;
  private progressResolve?: () => void;

  /**
   * 构造执行器。
   *
   * - `permissionChecker`:可选,LEGACY 权限路径(无 runtimeGate 时启用,deny 拦截、ask 放行,向后兼容)。
   * - `runtimeGate`:可选,NEW 权限路径(Wave B Task 13 / M-066)。**生产路径必须传入**——
   *   接入后 ask 会真正阻塞(await 用户决策),不再静默放行。
   *   两者同时传入时,runtimeGate 优先(走 NEW 路径,checkDecision 由本类调用)。
   *
   * LEGACY 路径保留是为兼容既有调用方(未接入 gate 的测试 / 子代理路径),
   * 后续 Wave 计划把所有调用方迁移到 NEW 路径后,删除 LEGACY 分支。
   */
  constructor(registry: ToolRegistry, permissionChecker?: PermissionChecker, runtimeGate?: RuntimeSecurityGate) {
    this.registry = registry;
    this.permissionChecker = permissionChecker;
    this.runtimeGate = runtimeGate;
  }

  /**
   * 添加工具到执行队列
   *
   * 物理类比：包裹放到传送带上，立即尝试开始拆。
   */
  addTool(block: ToolUseBlock): void {
    if (this.discarded) return;

    const concurrencySafe = isConcurrencySafe(block.name, block.input);

    this.tools.push({
      id: block.id,
      block,
      status: 'queued',
      isConcurrencySafe: concurrencySafe,
    });

    // 立即尝试执行
    void this.processQueue();
  }

  /**
   * 处理执行队列
   *
   * 并发控制逻辑：
   * - 没有正在执行的工具 → 可以执行任何工具
   * - 有正在执行的只读工具 → 只能执行只读工具
   * - 有正在执行的写入工具 → 必须等待
   */
  private async processQueue(): Promise<void> {
    for (const tool of this.tools) {
      if (tool.status !== 'queued') continue;

      if (this.canExecuteTool(tool.isConcurrencySafe)) {
        await this.executeTool(tool);
      } else {
        // 不能执行：如果是非并发工具，必须等待前面的完成
        if (!tool.isConcurrencySafe) break;
      }
    }
  }

  /** 检查是否可以执行指定类型的工具 */
  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executing = this.tools.filter(t => t.status === 'executing');
    return (
      executing.length === 0 ||
      (isConcurrencySafe && executing.every(t => t.isConcurrencySafe))
    );
  }

  /** 执行单个工具 */
  private async executeTool(tool: TrackedTool): Promise<void> {
    tool.status = 'executing';

    try {
      // ═══════ Wave B Task 13 (M-066): RuntimeSecurityGate 接入 ═══════
      //
      // NEW 路径(runtimeGate 已传):用 checker.checkDecision 构造结构化 SecurityDecision,
      //   交给 gate.execute() 处理:
      //     - allow → 立即执行;
      //     - deny  → 写 [Blocked by permission] <human_reason>,不执行;
      //     - ask   → **阻塞** await channel.request(approved_once 到位前不执行 executor);
      //               channel=null → denied(ask.no_channel),绝不降级为 allow。
      //
      //   decision_id / action_snapshot_id 在本进程内确定性派生(per-tool-call),
      //   让 pending store / 用户决策单可追溯。
      //
      // LEGACY 路径(无 runtimeGate):保持旧行为——deny 拦截、ask 放行(向后兼容)。
      //   生产路径必须传 runtimeGate,LEGACY 仅留给未接入的测试 / 子代理路径。
      if (this.runtimeGate && this.permissionChecker) {
        const decisionId = `exec:${tool.block.id}`;
        // action_snapshot_id: 工具名 + 输入内容的确定性短哈希。
        // 输入内容变化 → snapshot 变化 → 旧 approved_once 失效(由 gate 保证,因为 decision_id 也变)。
        const snapshotInput = JSON.stringify({
          name: tool.block.name,
          input: tool.block.input,
        });
        const actionSnapshotId = `snap:${createHash('sha256').update(snapshotInput).digest('hex').slice(0, 16)}`;
        const decision = this.permissionChecker.checkDecision(tool.block.name, tool.block.input, {
          decision_id: decisionId,
          action_snapshot_id: actionSnapshotId,
          policy_id: 'permission-default',
          policy_version: '1',
        });

        const result = await this.runtimeGate.execute(decision, async () => {
          const output = await this.registry.execute(tool.block.name, tool.block.input, { toolUseId: tool.block.id });
          return output;
        });

        if (typeof result === 'string') {
          // authorized + 已执行
          tool.results = [{ type: 'text', text: result }];
          tool.status = 'completed';
        } else {
          // denied(包括 ask.no_channel / ask.user_rejected / ask.stale_decision_id / ask.channel_failed)
          const denied = result as DeniedAction;
          tool.results = [{ type: 'text', text: `[Blocked by permission] ${denied.human_reason}` }];
          tool.status = 'completed';
        }

        this.progressResolve?.();
        return;
      }

      // ─── LEGACY 路径 ───
      // 权限检查(仅在传入 checker 时启用)。
      // 无用户交互通道,**ask 决策保持旧行为(放行)**,仅 deny 真正拦截。
      // 向后兼容未接入 runtimeGate 的调用方;生产路径请改走 NEW 路径(传 runtimeGate)。
      if (this.permissionChecker) {
        const decision = this.permissionChecker.check(tool.block.name, tool.block.input);
        if (decision.behavior === 'deny') {
          tool.results = [{ type: 'text', text: `[Blocked by permission] ${decision.reason}` }];
          tool.status = 'completed';
          this.progressResolve?.();
          return;
        }
      }

      const output = await this.registry.execute(tool.block.name, tool.block.input, { toolUseId: tool.block.id });
      tool.results = [{ type: 'text', text: output }];
      tool.status = 'completed';
    } catch (error) {
      tool.error = String(error);
      tool.results = [{ type: 'text', text: `[Tool Error] ${String(error)}` }];
      tool.status = 'completed';
    }

    // 通知等待者
    this.progressResolve?.();
  }

  /**
   * 获取结果（按顺序，AsyncGenerator）
   *
   * 关键：即使 grep 先完成，也要等 read_file 输出后再输出 grep 的结果。
   * 保证顺序与 AI 输出工具调用的顺序一致。
   */
  async *getRemainingResults(): AsyncGenerator<TrackedTool[]> {
    for (const tool of this.tools) {
      // 等待工具完成
      while (tool.status !== 'completed' && tool.status !== 'yielded') {
        await new Promise<void>(resolve => {
          this.progressResolve = resolve;
        });
      }

      if (tool.status === 'completed') {
        tool.status = 'yielded';
        yield [tool];
      }
    }
  }

  /**
   * 丢弃所有待执行工具
   *
   * 物理类比：快递分拣中心关门了，还没拆的包裹全部丢弃。
   * 在流式降级（streaming fallback）时调用。
   */
  discard(): void {
    this.discarded = true;
    // 标记所有 queued 的工具为 completed（带错误）
    for (const tool of this.tools) {
      if (tool.status === 'queued') {
        tool.status = 'completed';
        tool.error = 'Discarded due to streaming fallback';
        tool.results = [{ type: 'text', text: '[Discarded] Streaming fallback' }];
      }
    }
    this.progressResolve?.();
  }

  /** 获取所有已完成的结果（兼容旧接口） */
  getResults(): TrackedTool[] {
    return this.tools.filter(t => t.status === 'completed' || t.status === 'yielded');
  }

  /** 是否有正在执行的工具 */
  hasExecuting(): boolean {
    return this.tools.some(t => t.status === 'executing');
  }

  /** 是否有排队中的工具 */
  hasQueued(): boolean {
    return this.tools.some(t => t.status === 'queued');
  }

  /** 重置状态 */
  reset(): void {
    this.tools = [];
    this.discarded = false;
    this.progressResolve = undefined;
  }
}
