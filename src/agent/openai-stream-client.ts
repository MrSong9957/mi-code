// src/agent/openai-stream-client.ts
// OpenAI SDK 流式客户端:把 chat.completion.chunk SSE 翻译成统一 StreamEvent。
//
// 与 AnthropicStreamClient 完全对称的接口签名,实现 StreamingLLMClient。
// 核心差异:OpenAI 没有 content_block_start/delta/stop 的显式事件序列,
// adapter 内部跟踪 block 状态并合成这些事件。
//
// 映射规则:
//   首个 chunk(含 role)        → message_start(OpenAI 无此事件,合成)
//   delta.content               → content_block_delta(text)
//   delta.tool_calls[i] 首次    → content_block_start(tool_use)
//   delta.tool_calls[i].args    → content_block_delta(input_json)
//   finish_reason               → message_delta + 各 block 的 stop + AssistantMessage
//   最后                        → message_stop

import OpenAI from 'openai';
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

/** OpenAI ChatCompletionChunk 的最小子集(只用到的字段) */
interface OAIChunk {
  id: string;
  model: string;
  choices: Array<{
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
    index: number;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/** 内部 block 状态(跟踪累积) */
interface BlockState {
  type: 'text' | 'tool_use';
  text?: string;
  toolId?: string;
  toolName?: string;
  toolArgs?: string;
  started: boolean;
}

export class OpenAIStreamClient implements StreamingLLMClient {
  private client: OpenAI;
  private model: string;

  constructor(
    options: { apiKey?: string; model?: string; baseUrl?: string },
    /** 依赖注入:测试时传 mock client,生产路径留空走真实 OpenAI */
    clientOverride?: OpenAI,
  ) {
    this.client = clientOverride ?? new OpenAI({
      apiKey: options.apiKey || process.env.OPENAI_API_KEY,
      baseURL: options.baseUrl,
    });
    this.model = options.model || 'gpt-4o';
  }

  async *stream(
    messages: Message[],
    tools: ToolDefinition[],
    options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    const { systemPrompt, maxTokens, signal } = options;

    // 1. 转换工具格式:OpenAI { type:'function', function:{ name, description, parameters } }
    const openaiTools = tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    // 2. 调 OpenAI stream API
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          ...this.convertMessages(messages),
        ],
        tools: openaiTools,
        stream: true,
        stream_options: { include_usage: true },
      } as any,
      { signal },
    );

    // 3. 内部状态:block 累积
    // OpenAI 文本是隐式单 block(index 固定 0),工具调用按 tool_calls[i].index 分块。
    const blocks = new Map<number, BlockState>();
    let nextBlockIndex = 0;  // 统一 StreamEvent 用的 index
    let textUnifiedIndex = -1;  // 文本 block 的统一 index(首次文本时分配)

    let usage: Usage = { input_tokens: 0, output_tokens: 0 };
    let stopReason: string | null = null;
    let messageStartYielded = false;

    for await (const chunk of stream as unknown as AsyncIterable<OAIChunk>) {
      // 首个 chunk:合成 message_start(OpenAI 无此事件)
      if (!messageStartYielded) {
        messageStartYielded = true;
        if (chunk.usage?.prompt_tokens) {
          usage.input_tokens = chunk.usage.prompt_tokens;
        }
        yield {
          type: 'message_start',
          messageId: chunk.id,
          model: chunk.model,
          inputTokens: usage.input_tokens,
        };
      }

      // usage 可能在最后一个 chunk 才到
      if (chunk.usage) {
        usage.input_tokens = chunk.usage.prompt_tokens ?? usage.input_tokens;
        usage.output_tokens = chunk.usage.completion_tokens ?? usage.output_tokens;
      }

      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;

      // 文本增量
      if (delta.content) {
        if (textUnifiedIndex === -1) {
          textUnifiedIndex = nextBlockIndex++;
          blocks.set(textUnifiedIndex, { type: 'text', text: '', started: false });
        }
        const block = blocks.get(textUnifiedIndex)!;
        if (!block.started) {
          block.started = true;
          yield { type: 'content_block_start', index: textUnifiedIndex, blockType: 'text' };
        }
        block.text = (block.text ?? '') + delta.content;
        yield { type: 'content_block_delta', index: textUnifiedIndex, deltaType: 'text', content: delta.content };
      }

      // 工具调用增量
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          // 用 tc.index + 一个偏移作为统一 index(避免和文本 block 冲突)
          const unifiedIndex = tc.index + 100;  // 偏移 100 避免与 text(0) 冲突
          if (!blocks.has(unifiedIndex)) {
            blocks.set(unifiedIndex, {
              type: 'tool_use',
              toolId: tc.id || '',
              toolName: tc.function?.name || '',
              toolArgs: '',
              started: false,
            });
          }
          const block = blocks.get(unifiedIndex)!;
          if (!block.started) {
            block.started = true;
            yield { type: 'content_block_start', index: unifiedIndex, blockType: 'tool_use', blockId: block.toolId };
          }
          // arguments 增量
          if (tc.function?.arguments) {
            block.toolArgs = (block.toolArgs ?? '') + tc.function.arguments;
            yield { type: 'content_block_delta', index: unifiedIndex, deltaType: 'input_json', content: tc.function.arguments };
          }
        }
      }

      // finish_reason:收尾
      if (choice.finish_reason) {
        stopReason = choice.finish_reason;
      }
    }

    // 4. 收尾:yield 所有 block 的 stop + AssistantMessage
    for (const [index, block] of blocks) {
      const contentBlock = this.createContentBlock(block);
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
      yield { type: 'content_block_stop', index };
    }

    // message_delta(stopReason + outputTokens)
    yield { type: 'message_delta', stopReason, outputTokens: usage.output_tokens };

    // message_stop
    yield { type: 'message_stop' };
  }

  /** 内部消息 → OpenAI 消息格式 */
  private convertMessages(messages: Message[]): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];
    for (const m of messages) {
      if (typeof m.content === 'string') {
        result.push({ role: m.role, content: m.content });
        continue;
      }
      // 数组 content:需要按 OpenAI 格式拆分
      const textParts: string[] = [];
      const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];

      for (const block of m.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
        } else if (block.type === 'tool_result') {
          // tool_result 拆成独立 { role: 'tool' } 消息
          result.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: block.content,
          });
        }
        // image block:MVP 跳过
      }

      // 组装当前消息
      if (m.role === 'assistant') {
        const msg: Record<string, unknown> = { role: 'assistant' };
        if (textParts.length > 0) msg.content = textParts.join('');
        if (toolCalls.length > 0) msg.tool_calls = toolCalls;
        result.push(msg);
      } else if (textParts.length > 0) {
        // user 消息含 text(非 tool_result)
        result.push({ role: m.role, content: textParts.join('') });
      }
    }
    return result;
  }

  /** 内部 block 状态 → ContentBlock */
  private createContentBlock(block: BlockState): ContentBlock | null {
    if (block.type === 'text' && block.text !== undefined) {
      return { type: 'text', text: block.text };
    }
    if (block.type === 'tool_use') {
      try {
        const parsed = JSON.parse(block.toolArgs || '{}');
        return { type: 'tool_use', id: block.toolId || '', name: block.toolName || '', input: parsed };
      } catch {
        return { type: 'tool_use', id: block.toolId || '', name: block.toolName || '', input: {} };
      }
    }
    return null;
  }
}
