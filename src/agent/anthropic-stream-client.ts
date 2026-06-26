// Anthropic SDK 流式客户端：将 API 的 SSE 事件流转换为结构化的 StreamEvent
//
// 物理本质：水龙头 + 过滤器。
// Anthropic API 是水源，SSE 事件是水滴。
// 这个模块是过滤器，把杂乱的水滴（原始事件）过滤成干净的水（结构化 StreamEvent）。
// 水龙头 90 秒不出水 → 自动关闭（超时看门狗）。

import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import type {
  Message,
  ToolDefinition,
  StreamOptions,
  StreamEvent,
  AssistantMessage,
  ContentBlock,
  Usage,
  StreamingLLMClient,
} from './types.js';

/** 默认空闲超时（毫秒） */
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

/** 停滞检测阈值（毫秒） */
const STALL_THRESHOLD_MS = 30_000;

/**
 * AnthropicStreamClient
 *
 * 实现 StreamingLLMClient 接口，封装 Anthropic SDK 的流式 API。
 */
export class AnthropicStreamClient implements StreamingLLMClient {
  private client: Anthropic;
  private model: string;
  private idleTimeoutMs: number;

  constructor(options: {
    apiKey?: string;
    model?: string;
    idleTimeoutMs?: number;
  }) {
    this.client = new Anthropic({
      apiKey: options.apiKey || process.env.ANTHROPIC_API_KEY,
    });
    this.model = options.model || 'claude-sonnet-4-20250514';
    this.idleTimeoutMs = options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS;
  }

  /**
   * 流式调用 Anthropic API
   *
   * 返回 AsyncGenerator，逐个产出 StreamEvent 和 AssistantMessage。
   *
   * 核心算法：内容块累积
   *   contentBlocks[index] = { type, text/input/thinking }
   *   每收到 delta → 追加到对应字段
   *   收到 content_block_stop → 创建 AssistantMessage 并 yield
   */
  async *stream(
    messages: Message[],
    tools: ToolDefinition[],
    options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    const { systemPrompt, maxTokens, signal } = options;

    // 转换工具格式（Anthropic SDK 要求 input_schema.type 必须是 "object"）
    const anthropicTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object' as const,
        properties: t.parameters.properties ?? {},
        required: t.parameters.required ?? [],
      },
    }));

    // 创建流式请求
    const stream = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: this.convertMessages(messages),
        tools: anthropicTools,
        stream: true,
      },
      { signal },
    );

    // 状态：内容块累积
    const contentBlocks: Array<{
      type: string;
      id?: string;
      name?: string;
      text?: string;
      input?: string;
      thinking?: string;
    }> = [];

    let usage: Usage = { input_tokens: 0, output_tokens: 0 };
    let stopReason: string | null = null;
    let lastEventTime = Date.now();

    // 空闲超时看门狗
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        signal.dispatchEvent(new Event('abort'));
      }, this.idleTimeoutMs);
    };

    try {
      resetIdleTimer();

      for await (const event of stream) {
        resetIdleTimer();
        lastEventTime = Date.now();

        // 停滞检测
        const now = Date.now();
        if (now - lastEventTime > STALL_THRESHOLD_MS) {
          console.warn(`[Streaming] Stall detected: ${(now - lastEventTime) / 1000}s gap`);
        }

        switch (event.type) {
          case 'message_start': {
            usage = {
              input_tokens: event.message.usage?.input_tokens ?? 0,
              output_tokens: event.message.usage?.output_tokens ?? 0,
            };
            yield {
              type: 'message_start',
              messageId: event.message.id,
              model: event.message.model,
              inputTokens: usage.input_tokens,
            };
            break;
          }

          case 'content_block_start': {
            const blockType = event.content_block.type as 'text' | 'tool_use' | 'thinking';
            const toolUseBlock = event.content_block as any;
            contentBlocks[event.index] = {
              type: blockType,
              id: blockType === 'tool_use' ? toolUseBlock.id : undefined,
              name: blockType === 'tool_use' ? toolUseBlock.name : undefined,
              text: blockType === 'text' ? '' : undefined,
              input: blockType === 'tool_use' ? '' : undefined,
              thinking: blockType === 'thinking' ? '' : undefined,
            };
            yield {
              type: 'content_block_start',
              index: event.index,
              blockType,
              blockId: blockType === 'tool_use' ? toolUseBlock.id : undefined,
            };
            break;
          }

          case 'content_block_delta': {
            const block = contentBlocks[event.index];
            if (!block) break;

            const delta = event.delta as any;
            if (delta.type === 'text_delta') {
              block.text = (block.text ?? '') + delta.text;
              yield {
                type: 'content_block_delta',
                index: event.index,
                deltaType: 'text',
                content: delta.text,
              };
            } else if (delta.type === 'input_json_delta') {
              block.input = (block.input ?? '') + delta.partial_json;
              yield {
                type: 'content_block_delta',
                index: event.index,
                deltaType: 'input_json',
                content: delta.partial_json,
              };
            } else if (delta.type === 'thinking_delta') {
              block.thinking = (block.thinking ?? '') + delta.thinking;
              yield {
                type: 'content_block_delta',
                index: event.index,
                deltaType: 'thinking',
                content: delta.thinking,
              };
            }
            break;
          }

          case 'content_block_stop': {
            const block = contentBlocks[event.index];
            if (!block) break;

            // 将累积的块转换为 ContentBlock
            const contentBlock = this.createContentBlock(block, event.index);
            if (contentBlock) {
              const assistantMsg: AssistantMessage = {
                type: 'assistant',
                content: [contentBlock],
                usage: { ...usage },
                stopReason,
                uuid: randomUUID(),
                timestamp: new Date().toISOString(),
              };
              yield assistantMsg;
            }

            yield { type: 'content_block_stop', index: event.index };
            break;
          }

          case 'message_delta': {
            const delta = event.delta as any;
            stopReason = delta.stop_reason ?? null;
            usage = {
              ...usage,
              output_tokens: (event.usage as any)?.output_tokens ?? usage.output_tokens,
            };
            yield {
              type: 'message_delta',
              stopReason,
              outputTokens: usage.output_tokens,
            };
            break;
          }

          case 'message_stop': {
            yield { type: 'message_stop' };
            break;
          }
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  }

  /** 将内部消息格式转换为 Anthropic API 格式 */
  private convertMessages(messages: Message[]): Anthropic.MessageParam[] {
    return messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: typeof m.content === 'string'
        ? m.content
        : m.content.map(block => {
            if (block.type === 'text') return { type: 'text' as const, text: block.text };
            if (block.type === 'tool_use') return { type: 'tool_use' as const, id: block.id, name: block.name, input: block.input };
            if (block.type === 'tool_result') return { type: 'tool_result' as const, tool_use_id: block.tool_use_id, content: block.content };
            return block;
          }),
    }));
  }

  /** 将累积的块转换为 ContentBlock */
  private createContentBlock(
    block: { type: string; id?: string; name?: string; text?: string; input?: string; thinking?: string },
    _index: number,
  ): ContentBlock | null {
    if (block.type === 'text' && block.text !== undefined) {
      return { type: 'text', text: block.text };
    }
    if (block.type === 'tool_use' && block.input !== undefined) {
      try {
        const parsed = JSON.parse(block.input);
        return { type: 'tool_use', id: block.id || '', name: block.name || '', input: parsed };
      } catch {
        return null;
      }
    }
    // thinking 块不转为 ContentBlock（仅用于实时显示）
    return null;
  }
}
