// src/agent/google-stream-client.ts
// Google(Gemini)SDK 流式客户端:把 Gemini SSE chunk 翻译成统一 StreamEvent。
//
// 与 OpenAIStreamClient 完全对称的接口签名,实现 StreamingLLMClient。
// 核心差异:Gemini 的 functionCall 返回完整 JSON(args 是 object,不是增量字符串)。
//
// 映射规则:
//   首个 chunk                 → message_start(Gemini 无此事件,合成)
//   parts[].text               → content_block_delta(text)
//   parts[].functionCall       → content_block_start(tool_use) + content_block_delta(input_json, 一次性完整 JSON)
//   finishReason               → message_delta + 各 block 的 stop + AssistantMessage
//   最后                       → message_stop

import { GoogleGenAI } from '@google/genai';
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
import { buildGeminiInlineData } from './image-utils.js';
import {
  createModelCapabilitySnapshot,
  type ModelCapabilitySnapshot,
} from './tools/capability-snapshot.js';
import type { MetaContextActivation } from './context/activation.js';

/** Gemini 流式 chunk 的最小子集(只用到的字段) */
interface GeminiChunk {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; functionCall?: { id?: string; name?: string; args?: Record<string, unknown> } }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
}

/** Gemini Content 格式 */
interface GeminiContent {
  role: string;
  parts: Array<Record<string, unknown>>;
}

/** 内部 block 状态(跟踪累积) */
interface BlockState {
  type: 'text' | 'tool_use';
  text?: string;
  toolId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  started: boolean;
}

export class GoogleStreamClient implements StreamingLLMClient {
  private client: GoogleGenAI;
  private model: string;

  constructor(
    options: { apiKey?: string; model?: string },
    /** 依赖注入:测试时传 mock client,生产路径留空走真实 GoogleGenAI */
    clientOverride?: GoogleGenAI,
  ) {
    this.client = clientOverride ?? new GoogleGenAI({
      apiKey: options.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY,
    });
    this.model = options.model || 'gemini-2.5-flash';
  }

  /**
   * 返回本 adapter 的默认能力快照(M-058)。
   *
   * 关键不变量:
   *   - 能力值由本 adapter 的代码路径实际支持什么决定,**不**从 model 名字推断。
   *   - capability_snapshot_id 是确定性的 `cap:google:<model>`,无随机 UUID。
   *   - 输出经 createModelCapabilitySnapshot 深拷贝 + 深冻结。
   *
   * 当前声明依据(stream 代码路径已实现):
   *   - native_tools: supported —— tools 参数转成 Gemini functionDeclarations
   *   - tool_result_identity: supported —— convertMessages 用 functionResponse.id 透传
   *   - system_instruction: supported —— systemPrompt 传给 config.systemInstruction
   *   - provider_annotations: unknown —— 当前代码路径不携带 provider 特有标注,
   *     显式标 unknown 而非 supported,避免乐观升级
   */
  getDefaultCapabilities(): ModelCapabilitySnapshot {
    return createModelCapabilitySnapshot({
      capability_protocol_version: '1',
      capability_snapshot_id: `cap:google:${this.model}`,
      provider_id: 'google',
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

    // 1. 转换工具格式:Gemini { functionDeclarations: [{ name, description, parametersJsonSchema }] }
    const geminiTools = tools.length > 0
      ? [{ functionDeclarations: tools.map(t => ({
          name: t.name,
          description: t.description,
          parametersJsonSchema: t.parameters,
        })) }]
      : undefined;

    // 2. 转换消息格式 + systemInstruction
    const contents = this.convertMessages(messages);

    // 3. 调 Gemini stream API
    const stream = await this.client.models.generateContentStream({
      model: this.model,
      contents: contents as any,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: maxTokens,
        tools: geminiTools as any,
        abortSignal: signal,
      } as any,
    } as any);

    // 4. 内部状态:block 累积
    const blocks = new Map<number, BlockState>();
    let nextBlockIndex = 0;
    let textUnifiedIndex = -1;

    let usage: Usage = { input_tokens: 0, output_tokens: 0 };
    let stopReason: string | null = null;
    let messageStartYielded = false;

    for await (const chunk of stream as AsyncIterable<GeminiChunk>) {
      // 首个 chunk:合成 message_start
      if (!messageStartYielded) {
        messageStartYielded = true;
        if (chunk.usageMetadata?.promptTokenCount) {
          usage.input_tokens = chunk.usageMetadata.promptTokenCount;
        }
        yield {
          type: 'message_start',
          messageId: randomUUID(),
          model: chunk.modelVersion || this.model,
          inputTokens: usage.input_tokens,
        };
      }

      // usage 可能在任意 chunk 更新
      if (chunk.usageMetadata) {
        usage.input_tokens = chunk.usageMetadata.promptTokenCount ?? usage.input_tokens;
        usage.output_tokens = chunk.usageMetadata.candidatesTokenCount ?? usage.output_tokens;
      }

      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;
      const parts = candidate.content?.parts ?? [];

      for (const part of parts) {
        // 文本增量
        if (part.text) {
          if (textUnifiedIndex === -1) {
            textUnifiedIndex = nextBlockIndex++;
            blocks.set(textUnifiedIndex, { type: 'text', text: '', started: false });
          }
          const block = blocks.get(textUnifiedIndex)!;
          if (!block.started) {
            block.started = true;
            yield { type: 'content_block_start', index: textUnifiedIndex, blockType: 'text' };
          }
          block.text = (block.text ?? '') + part.text;
          yield { type: 'content_block_delta', index: textUnifiedIndex, deltaType: 'text', content: part.text };
        }

        // 工具调用(Gemini 返回完整 JSON,不是增量)
        if (part.functionCall) {
          const fc = part.functionCall;
          // M-057: surface the provider tool-call identity verbatim. When Gemini
          // omits functionCall.id, do NOT synthesize a random fallback — surface
          // the missing identity as empty string consistently across both the
          // content_block_start.blockId and the final ToolUseBlock.id.
          const toolId = fc.id ?? '';
          const unifiedIndex = nextBlockIndex++;
          blocks.set(unifiedIndex, {
            type: 'tool_use',
            toolId,
            toolName: fc.name || '',
            toolArgs: fc.args ?? {},
            started: true,
          });
          // content_block_start + 一次性完整 JSON delta
          yield { type: 'content_block_start', index: unifiedIndex, blockType: 'tool_use', blockId: toolId };
          const jsonStr = JSON.stringify(fc.args ?? {});
          yield { type: 'content_block_delta', index: unifiedIndex, deltaType: 'input_json', content: jsonStr };
        }
      }

      if (candidate.finishReason) {
        stopReason = candidate.finishReason;
      }
    }

    // 5. 收尾:yield 所有 block 的 stop + AssistantMessage
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

    yield { type: 'message_delta', stopReason, outputTokens: usage.output_tokens };
    yield { type: 'message_stop' };
  }

  /** 内部消息 → Gemini contents 格式 */
  private convertMessages(messages: Message[]): GeminiContent[] {
    const result: GeminiContent[] = [];
    for (const m of messages) {
      // Gemini role: assistant → model
      const geminiRole = m.role === 'assistant' ? 'model' : 'user';

      if (typeof m.content === 'string') {
        result.push({ role: geminiRole, parts: [{ text: m.content }] });
        continue;
      }

      const parts: Array<Record<string, unknown>> = [];
      for (const block of m.content) {
        if (block.type === 'text') {
          parts.push({ text: block.text });
        } else if (block.type === 'tool_use') {
          parts.push({ functionCall: { id: block.id, name: block.name, args: block.input } });
        } else if (block.type === 'tool_result') {
          // Gemini functionResponse:{ name, response:{ output: <content> } }
          parts.push({
            functionResponse: {
              name: '',  // Gemini 要求但实际不校验名字匹配
              id: block.tool_use_id,
              response: { output: block.content },
            },
          });
        } else if (block.type === 'image') {
          parts.push(buildGeminiInlineData(block));
        }
      }
      if (parts.length > 0) {
        result.push({ role: geminiRole, parts });
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
      return { type: 'tool_use', id: block.toolId || '', name: block.toolName || '', input: block.toolArgs ?? {} };
    }
    return null;
  }
}

// ===========================================================================
// DRC-2 Task 4 — Meta context adapter conformance (spec §8.5-6).
// ===========================================================================

/**
 * Project a batch of `MetaContextActivation`s into Google(Gemini)-bound `Message[]`.
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
 *     (Gemini further maps `assistant`→`model` inside `convertMessages`, but
 *     `user` is preserved as-is.)
 *   - Output is ordered by `ordinal` ascending, so meta precedes conversation
 *     deterministically.
 *   - `content` carries the activation's bounded content ref verbatim, so the
 *     Provider-side request stays traceable to its activation. No second
 *     silent truncation (spec §8.5-8).
 *   - role / placement / authority / trust of the activation are not modified
 *     here; only the Provider message-plane encoding is produced.
 *
 * Note: Gemini's API has no first-class "meta" envelope. Encoding meta as
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
