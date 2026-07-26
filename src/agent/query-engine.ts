// 查询引擎：封装流式 API 调用 + 消息规范化 + usage 追踪
//
// 物理本质：翻译官。
// API 返回的是"原始方言"（SSE 事件），查询引擎翻译成"普通话"（NormalizedMessage）。
// 同时还兼任"记账员"，追踪每轮对话用了多少 token。

import { randomUUID } from 'crypto';
import type {
  Message,
  ToolDefinition,
  StreamEvent,
  AssistantMessage,
  StreamingLLMClient,
  ContentBlock,
  Usage,
} from './types.js';
import { isStreamEvent } from './types.js';
import type { ToolDefinitionSnapshot } from './tools/descriptor-snapshot.js';
import type { RequestToolViewSnapshot } from './tools/overlay.js';
import { materializeIncludedToolDefinitions } from './tool-registry.js';

/** 规范化消息 */
export interface NormalizedMessage {
  type: 'assistant' | 'user' | 'system' | 'progress';
  content: ContentBlock[];
  usage?: Usage;
  stopReason?: string | null;
  uuid: string;
  timestamp: string;
}

/**
 * 查询引擎选项 —— discriminated union(Wave B Task 4 / M-021)。
 *
 * 两条互斥路径:
 *   1. NEW variant (`toolView` + `baseToolSnapshot`):走 overlay 派生的工具视图,
 *      submit() 内部调用 materializeIncludedToolDefinitions() 把视图物化成
 *      `ToolDefinition[]`,再转发给 provider。这是 Wave B 之后的推荐路径。
 *   2. LEGACY variant (`tools` + `legacyToolInput: true`):老调用方直接传一个
 *      `ToolDefinition[]` 数组,submit() 原样转发。`legacyToolInput: true` 是
 *      discriminant,保持旧测试与旧调用点零改动。
 *
 * 由于是 discriminated union,结构上禁止同时提供 `tools` 与 `toolView` ——
 * TypeScript 编译期会拒绝这种对象字面量(编译时即报错)。
 */
export type QueryEngineOptions =
  | {
      systemPrompt: string;
      toolView: RequestToolViewSnapshot;
      baseToolSnapshot: ToolDefinitionSnapshot;
      signal: AbortSignal;
      maxTokens?: number;
    }
  | {
      systemPrompt: string;
      tools: ToolDefinition[];
      signal: AbortSignal;
      maxTokens?: number;
      /** discriminant:必须为 true 才走老路径 */
      legacyToolInput: true;
    };

/**
 * QueryEngine
 *
 * 封装流式 API 调用，将 StreamEvent 转换为 NormalizedMessage。
 * 追踪 token 使用量（input/output/cache）。
 */
export class QueryEngine {
  private client: StreamingLLMClient;
  private totalUsage: Usage = { input_tokens: 0, output_tokens: 0 };

  constructor(client: StreamingLLMClient) {
    this.client = client;
  }

  /**
   * 提交用户消息，返回流式结果
   *
   * 物理类比：翻译官听到一句外语 → 立刻翻译成普通话 → 说出来。
   */
  async *submit(
    messages: Message[],
    options: QueryEngineOptions,
  ): AsyncGenerator<NormalizedMessage | StreamEvent> {
    const { systemPrompt, signal, maxTokens = 8192 } = options;

    // Branch on variant (M-021):
    //   - NEW variant (`toolView` 存在): 物化工具视图,得到 included 工具的
    //     ToolDefinition[] 数组,转发给 provider。
    //   - LEGACY variant (`legacyToolInput: true`): 直接透传 options.tools。
    // 由于是 discriminated union,这里的类型 narrowing 让 TS 知道
    // `options.toolView` 存在分支里 `options.tools` 不可访问,反之亦然。
    const tools: ToolDefinition[] = (() => {
      if ('toolView' in options) {
        return materializeIncludedToolDefinitions(
          options.toolView,
          options.baseToolSnapshot,
        );
      }
      return options.tools;
    })();

    // 调用流式 API
    const stream = this.client.stream(messages, tools, {
      systemPrompt,
      maxTokens,
      signal,
    });

    // 当前消息的 usage
    let currentUsage: Usage = { input_tokens: 0, output_tokens: 0 };
    let stopReason: string | null = null;

    for await (const event of stream) {
      if (isStreamEvent(event)) {
        // 流式事件：透传给 UI + 更新 usage
        yield event;

        // 更新 usage 计数器
        if (event.type === 'message_start') {
          currentUsage = { input_tokens: event.inputTokens, output_tokens: 0 };
        } else if (event.type === 'message_delta') {
          currentUsage.output_tokens = event.outputTokens;
          stopReason = event.stopReason;
        } else if (event.type === 'message_stop') {
          // 累积到总 usage
          this.totalUsage.input_tokens += currentUsage.input_tokens;
          this.totalUsage.output_tokens += currentUsage.output_tokens;
        }
      } else if (this.isAssistantMessage(event)) {
        // 助手消息：规范化后输出
        const normalized: NormalizedMessage = {
          type: 'assistant',
          content: event.content,
          usage: { ...currentUsage },
          stopReason: stopReason ?? event.stopReason,
          uuid: event.uuid || randomUUID(),
          timestamp: event.timestamp || new Date().toISOString(),
        };
        yield normalized;
      }
    }
  }

  /** 获取总 usage */
  getTotalUsage(): Usage {
    return { ...this.totalUsage };
  }

  /** 重置总 usage */
  resetUsage(): void {
    this.totalUsage = { input_tokens: 0, output_tokens: 0 };
  }

  private isAssistantMessage(event: StreamEvent | AssistantMessage): event is AssistantMessage {
    return 'type' in event && event.type === 'assistant';
  }
}
