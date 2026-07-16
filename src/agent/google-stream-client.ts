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
          const unifiedIndex = nextBlockIndex++;
          blocks.set(unifiedIndex, {
            type: 'tool_use',
            toolId: fc.id || randomUUID(),
            toolName: fc.name || '',
            toolArgs: fc.args ?? {},
            started: true,
          });
          // content_block_start + 一次性完整 JSON delta
          yield { type: 'content_block_start', index: unifiedIndex, blockType: 'tool_use', blockId: fc.id };
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
        }
        // image block:MVP 跳过
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
