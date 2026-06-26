// StreamingToolExecutor：流式工具执行器
//
// 物理本质：快递到了就立刻拆，不用等整批到齐。
// LLM 流式输出时，只要检测到完整的 tool_use 块，立刻开始执行，
// 不等整条消息生成完毕，大幅降低用户体感延迟。

import type { ToolRegistry } from './tool-registry.js';

/** 流式工具调用块 */
export interface StreamingToolCall {
  id: string;
  name: string;
  inputJson: string;
  input: Record<string, unknown> | null;
}

/** 流式执行结果 */
export interface StreamingToolResult {
  toolUseId: string;
  name: string;
  output: string;
}

/** 流式解析状态 */
interface ParseState {
  current: StreamingToolCall | null;
  completed: StreamingToolCall[];
  executing: Map<string, Promise<StreamingToolResult>>;
  results: StreamingToolResult[];
}

/**
 * StreamingToolExecutor
 *
 * 从流式文本中检测 tool_use 块，一旦完整就立即开始执行。
 */
export class StreamingToolExecutor {
  private registry: ToolRegistry;
  private state: ParseState;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
    this.state = { current: null, completed: [], executing: new Map(), results: [] };
  }

  /** 处理一个文本 chunk */
  processChunk(chunk: string): void {
    // 检测 tool_use 块开始（支持 "tool_use" 标记或直接的 JSON 工具调用）
    if (!this.state.current) {
      const isToolCall = chunk.includes('"tool_use"') || (chunk.includes('"name"') && chunk.includes('"input"'));
      if (isToolCall) {
        this.state.current = {
          id: this.extractId(chunk),
          name: this.extractName(chunk),
          inputJson: chunk,
          input: null,
        };
        // 如果第一个 chunk 就是完整的 JSON，立即执行
        if (this.isJsonComplete(chunk)) {
          this.finalizeCurrentBlock();
        }
        return;
      }
    }

    // 累积内容到当前块
    if (this.state.current) {
      this.state.current.inputJson += chunk;

      // 检测块结束（JSON 完整）
      if (this.isJsonComplete(this.state.current.inputJson)) {
        this.finalizeCurrentBlock();
      }
    }
  }

  /** 完成当前工具块解析并开始执行 */
  private finalizeCurrentBlock(): void {
    const current = this.state.current;
    if (!current) return;

    try {
      const parsed = JSON.parse(current.inputJson);
      current.id = parsed.id || current.id;
      current.name = parsed.name || current.name;
      current.input = parsed.input || {};
    } catch {
      this.state.current = null;
      return;
    }

    this.state.completed.push(current);
    this.state.current = null;

    // 立即开始执行
    if (current.input) {
      const promise = this.executeTool(current);
      this.state.executing.set(current.id, promise);
    }
  }

  /** 执行单个工具 */
  private async executeTool(call: StreamingToolCall): Promise<StreamingToolResult> {
    const output = await this.registry.execute(call.name, call.input!);
    const result: StreamingToolResult = { toolUseId: call.id, name: call.name, output };
    this.state.results.push(result);
    this.state.executing.delete(call.id);
    return result;
  }

  /** 等待所有正在执行的工具完成 */
  async awaitAll(): Promise<StreamingToolResult[]> {
    await Promise.all(this.state.executing.values());
    return this.state.results;
  }

  /** 获取已完成的结果 */
  getResults(): StreamingToolResult[] { return this.state.results; }

  /** 是否有正在执行的工具 */
  hasExecuting(): boolean { return this.state.executing.size > 0; }

  /** 重置状态 */
  reset(): void {
    this.state = { current: null, completed: [], executing: new Map(), results: [] };
  }

  // 辅助方法
  private extractId(text: string): string {
    const match = text.match(/"id"\s*:\s*"([^"]+)"/);
    return match?.[1] || `call_${Date.now()}`;
  }

  private extractName(text: string): string {
    const match = text.match(/"name"\s*:\s*"([^"]+)"/);
    return match?.[1] || 'unknown';
  }

  private isJsonComplete(json: string): boolean {
    try { JSON.parse(json); return true; } catch { return false; }
  }
}
