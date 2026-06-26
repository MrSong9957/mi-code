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

/** 并发安全的只读工具白名单 */
const READ_ONLY_TOOLS = new Set([
  'read_file', 'glob', 'grep', 'web_fetch', 'web_search',
  'list_directory', 'get_file_info',
]);

/**
 * 判断工具是否可并发执行（只读工具可并发，写入工具必须独占）
 */
export function isConcurrencySafe(toolName: string, _input?: Record<string, unknown>): boolean {
  return READ_ONLY_TOOLS.has(toolName);
}

/**
 * StreamingToolExecutor v2
 *
 * 基于结构化事件的流式工具执行器。
 * 替代原来的文本解析方式，通过 addTool() 直接传入已解析的 ToolUseBlock。
 */
export class StreamingToolExecutor {
  private registry: ToolRegistry;
  private tools: TrackedTool[] = [];
  private discarded = false;
  private progressResolve?: () => void;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
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
      const output = await this.registry.execute(tool.block.name, tool.block.input);
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
