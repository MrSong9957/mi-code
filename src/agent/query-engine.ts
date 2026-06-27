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

/** 规范化消息 */
export interface NormalizedMessage {
  type: 'assistant' | 'user' | 'system' | 'progress';
  content: ContentBlock[];
  usage?: Usage;
  stopReason?: string | null;
  uuid: string;
  timestamp: string;
}

/** 查询引擎选项 */
export interface QueryEngineOptions {
  systemPrompt: string;
  tools: ToolDefinition[];
  signal: AbortSignal;
  maxTokens?: number;
}

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
    const { systemPrompt, tools, signal, maxTokens = 8192 } = options;

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
