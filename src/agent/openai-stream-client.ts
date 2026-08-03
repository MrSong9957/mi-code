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
import { buildOpenAIImagePart, type OpenAIImagePart } from './image-utils.js';
import {
  createModelCapabilitySnapshot,
  type ModelCapabilitySnapshot,
} from './tools/capability-snapshot.js';
import type { MetaContextActivation } from './context/activation.js';

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

  /**
   * 返回本 adapter 的默认能力快照(M-058)。
   *
   * 关键不变量:
   *   - 能力值由本 adapter 的代码路径实际支持什么决定,**不**从 model 名字推断。
   *   - capability_snapshot_id 是确定性的 `cap:openai-compatible:<model>`,无随机 UUID。
   *   - 输出经 createModelCapabilitySnapshot 深拷贝 + 深冻结。
   *
   * 当前声明依据(stream 代码路径已实现):
   *   - native_tools: supported —— tools 参数转成 OpenAI function tools
   *   - tool_result_identity: supported —— convertMessages 用 tool_call_id 透传
   *   - system_instruction: supported —— systemPrompt 作为 system 消息插入
   *   - provider_annotations: unknown —— 当前代码路径不携带 provider 特有标注,
   *     显式标 unknown 而非 supported,避免乐观升级
   */
  getDefaultCapabilities(): ModelCapabilitySnapshot {
    return createModelCapabilitySnapshot({
      capability_protocol_version: '1',
      capability_snapshot_id: `cap:openai-compatible:${this.model}`,
      provider_id: 'openai-compatible',
      model_id: this.model,
      adapter_version: '1',
      capabilities: {
        native_tools: 'supported',
        tool_result_identity: 'supported',
        system_instruction: 'supported',
        provider_annotations: 'unknown',
      },
      diagnostics: [],
    });
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

    const usage: Usage = { input_tokens: 0, output_tokens: 0 };
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

  /**
   * Task 4 direct classifier RPC：一次非流式 chat.completions.create，返回 raw text。
   * 不经过 streamingQuery/Agent/tool registry；request 不含 tools；不 trim/不解析/不容错。
   */
  async completeText(request: {
    readonly model: { readonly providerId: string; readonly modelId: string };
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly signal: AbortSignal;
    readonly reasoning?: 'disabled' | 'enabled';
    readonly maxOutputTokens?: number;
    readonly temperature?: 0;
  }): Promise<string> {
    const response = await this.client.chat.completions.create(
      {
        model: request.model.modelId,
        messages: [
          { role: 'system' as const, content: request.systemPrompt },
          { role: 'user' as const, content: request.prompt },
        ],
        stream: false,
        ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      },
      { signal: request.signal },
    );
    const content = (response as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  }

  /** Task 4：adapter-owned 静态 classifier capability。 */
  classifierCapabilities(): import('../permission/classifier-provider.js').ClassifierProviderCapabilities {
    return {
      reasoningControl: false, // OpenAI chat completions 无显式 thinking 开关
      decodingControl: true,
      promptCache: false,
    };
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
      const imageParts: OpenAIImagePart[] = [];

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
        } else if (block.type === 'image') {
          imageParts.push(buildOpenAIImagePart(block));
        }
      }

      // 组装当前消息
      if (m.role === 'assistant') {
        const msg: Record<string, unknown> = { role: 'assistant' };
        if (textParts.length > 0) msg.content = textParts.join('');
        if (toolCalls.length > 0) msg.tool_calls = toolCalls;
        result.push(msg);
      } else if (textParts.length > 0 && imageParts.length > 0) {
        // 文本 + 图片:content 升级为数组
        result.push({
          role: m.role,
          content: [{ type: 'text', text: textParts.join('') }, ...imageParts],
        });
      } else if (imageParts.length > 0) {
        // 只有图片(无文本):必须新增此分支,否则纯图片消息会被跳过
        result.push({ role: m.role, content: imageParts });
      } else if (textParts.length > 0) {
        // 只有文本:保持原样(字符串 content)
        result.push({ role: m.role, content: textParts.join('') });
      }
      // textParts 与 imageParts 都为空:跳过(与现有行为一致)
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

// ===========================================================================
// DRC-2 Task 4 — Meta context adapter conformance (spec §8.5-6).
// ===========================================================================

/**
 * Project a batch of `MetaContextActivation`s into OpenAI-bound `Message[]`.
 *
 * The caller is expected to PREPEND the returned array to the conversation
 * `messages` before invoking `stream()` — the `stream()` signature itself is
 * unchanged (backward compatible). This helper only encodes the meta plane;
 * it does not call the SDK.
 *
 * Contract (spec §8.5-6):
 *   - Every output message has `role='user'` (mirrors
 *     `MetaContextActivation.semantic_role='user'`). Meta is NEVER rewritten
 *     to a system-role message — that would silently promote authority.
 *   - Output is ordered by `ordinal` ascending, so meta precedes conversation
 *     deterministically.
 *   - `content` carries the activation's bounded content ref verbatim, so the
 *     Provider-side request stays traceable to its activation. No second
 *     silent truncation (spec §8.5-8).
 *   - role / placement / authority / trust of the activation are not modified
 *     here; only the Provider message-plane encoding is produced.
 *
 * Note: OpenAI's chat completions API has no first-class "meta" envelope.
 * Encoding meta as early user-role messages is the Provider-neutral surface;
 * the semantic distinction (`is_meta`) lives on the RC-2 snapshot, not in the
 * wire request.
 */
export function encodeMetaContextAsMessages(
  activations: ReadonlyArray<MetaContextActivation>,
): Message[] {
  const ordered = [...activations].sort((a, b) => a.ordinal - b.ordinal);
  return ordered.map((a) => ({
    role: a.semantic_role,
    content: a.content_ref,
  }));
}
