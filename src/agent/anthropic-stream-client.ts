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
import { ensureImageData } from './image-utils.js';
import {
  createModelCapabilitySnapshot,
  type ModelCapabilitySnapshot,
} from './tools/capability-snapshot.js';
import type { MetaContextActivation } from './context/activation.js';

/** 默认空闲超时（毫秒） */
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

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
    baseUrl?: string;
  }) {
    this.client = new Anthropic({
      apiKey: options.apiKey || process.env.ANTHROPIC_API_KEY,
      baseURL: options.baseUrl,
    });
    this.model = options.model || 'claude-sonnet-4-20250514';
    this.idleTimeoutMs = options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS;
  }

  /**
   * 返回本 adapter 的默认能力快照(M-058)。
   *
   * 关键不变量:
   *   - 能力值由本 adapter 的代码路径实际支持什么决定,**不**从 model 名字推断。
   *   - capability_snapshot_id 是确定性的 `cap:anthropic:<model>`,无随机 UUID。
   *   - 输出经 createModelCapabilitySnapshot 深拷贝 + 深冻结。
   *
   * 当前声明依据(stream 代码路径已实现):
   *   - native_tools: supported —— tools 参数会转成 Anthropic tools schema
   *   - tool_result_identity: supported —— convertMessages 透传 tool_use_id 原值
   *   - system_instruction: supported —— systemPrompt 直接传给 system 字段
   *   - provider_annotations: supported —— message_start 暴露 messageId/model 等 provider 元信息
   */
  getDefaultCapabilities(): ModelCapabilitySnapshot {
    return createModelCapabilitySnapshot({
      capability_protocol_version: '1',
      capability_snapshot_id: `cap:anthropic:${this.model}`,
      provider_id: 'anthropic',
      model_id: this.model,
      adapter_version: '1',
      capabilities: {
        native_tools: 'supported',
        tool_result_identity: 'supported',
        system_instruction: 'supported',
        provider_annotations: 'supported',
      },
      diagnostics: [],
    });
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
    // 转换工具格式（Anthropic SDK 要求 input_schema.type 必须是 "object"）
    const anthropicTools = (tools ?? []).map(t => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object' as const,
        properties: t.parameters.properties ?? {},
        required: t.parameters.required ?? [],
      },
    }));

    // 创建流式请求
    let stream: AsyncIterable<any>;
    try {
      stream = await this.client.messages.create(
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
    } catch (err: any) {
      // API 错误(403/401/400 等):包装成清晰错误,不让 streamingQuery 的恢复逻辑吞掉
      const status = err?.status ?? '';
      const msg = err?.message ?? String(err);
      if (status === 403 || status === 401) {
        throw new Error(`API 认证失败(${status}):${msg.slice(0, 200)}。请检查 API Key 和模型权限。`);
      }
      if (status === 400) {
        throw new Error(`API 请求错误(400):${msg.slice(0, 200)}`);
      }
      throw new Error(`API 错误(${status || 'unknown'}):${msg.slice(0, 200)}`);
    }

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

  /**
   * Task 4 direct classifier RPC：一次非流式 messages.create，返回 raw text。
   *
   * 不经过 streamingQuery / Agent / tool registry / 正常 message 流；只发一次底层
   * provider 请求，拼回 text block 为完整字符串返回。不 trim、不解析 ALLOW/FLAG、不容错。
   * request 不含 tools（classifier 不用工具）。signal 贯穿底层请求。
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
    const response = await this.client.messages.create(
      {
        model: request.model.modelId,
        max_tokens: request.maxOutputTokens ?? 1024,
        system: request.systemPrompt,
        messages: [{ role: 'user' as const, content: request.prompt }],
        tools: undefined,
        stream: false,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      },
      { signal: request.signal },
    );
    // 拼回所有 text block（不 trim、不解析）
    const blocks = (response as { content?: Array<{ type: string; text?: string }> }).content ?? [];
    return blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  }

  /**
   * Task 4：adapter-owned 静态 classifier capability 声明。
   * Anthropic 支持 reasoning/thinking 控制、temperature、最小输出预算。
   */
  classifierCapabilities(): import('../permission/classifier-provider.js').ClassifierProviderCapabilities {
    return {
      reasoningControl: true,
      decodingControl: true,
      promptCache: true,
    };
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
            if (block.type === 'image') return {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: block.mediaType,
                data: ensureImageData(block),
              },
            };
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

// ===========================================================================
// DRC-2 Task 4 — Meta context adapter conformance (spec §8.5-6).
// ===========================================================================

/**
 * Project a batch of `MetaContextActivation`s into Anthropic-bound `Message[]`.
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
 * Note: Anthropic's SDK has no first-class "meta" envelope. Encoding meta as
 * early user-role messages is the Provider-neutral surface; the semantic
 * distinction (`is_meta`) lives on the RC-2 snapshot, not in the wire request.
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
