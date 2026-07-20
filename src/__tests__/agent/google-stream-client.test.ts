// src/__tests__/agent/google-stream-client.test.ts
// GoogleStreamClient 单元测试:把 Gemini SSE chunk 翻译成统一 StreamEvent。
//
// 关键验证点(消费端不会崩,但功能必须正确的 3 件事):
// 1. yield AssistantMessage(type='assistant')—— 否则正文不流式显示、工具不执行
// 2. AssistantMessage.content 里有 tool_use block —— 否则工具永不执行
// 3. content_block_delta.deltaType='text' —— 否则正文不流式显示
//
// Gemini 关键特性:functionCall 返回完整 JSON(args 是 object,不是增量字符串)。
// 用依赖注入 mock GoogleGenAI(不调真实 API)。

import { describe, it, expect } from 'vitest';
import { GoogleStreamClient } from '../../agent/google-stream-client.js';
import type { StreamEvent, AssistantMessage, Message, ToolDefinition, ImageBlock } from '../../agent/types.js';

// ── Mock GoogleGenAI ──
// GoogleStreamClient 构造时注入 mock client,stream() 调 client.models.generateContentStream

interface MockChunk {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; functionCall?: { id?: string; name?: string; args?: Record<string, unknown> } }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
}

function makeMockClient(chunks: MockChunk[]) {
  // 捕获每次调用 generateContentStream 传入的 contents,供图片用例断言 inlineData part
  const captured: Array<{ contents: unknown }> = [];
  const client = {
    models: {
      generateContentStream: async (params: { contents?: unknown } | unknown): Promise<AsyncIterable<MockChunk>> => {
        captured.push({ contents: (params as { contents?: unknown }).contents });
        return {
          [Symbol.asyncIterator]() {
            let i = 0;
            return {
              next(): Promise<IteratorResult<MockChunk>> {
                if (i < chunks.length) return Promise.resolve({ value: chunks[i++]!, done: false });
                return Promise.resolve({ value: undefined, done: true });
              },
            };
          },
        };
      },
    },
  };
  // 把 captured 挂到返回值上,现有 `client as any` 注入不受影响
  return Object.assign(client, { captured });
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'run_bash',
    description: 'Run a bash command',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'command' } },
      required: ['command'],
    },
  },
];

const MESSAGES: Message[] = [{ role: 'user', content: 'hello' }];
const OPTIONS = { systemPrompt: 'You are helpful', maxTokens: 4096, signal: new AbortController().signal };

/** 收集 stream() 的所有输出 */
async function collect(gen: AsyncGenerator<StreamEvent | AssistantMessage>) {
  const events: Array<StreamEvent | AssistantMessage> = [];
  for await (const e of gen) events.push(e);
  return events;
}

// ─────────────── 纯文本响应 ───────────────

describe('GoogleStreamClient — 纯文本', () => {
  it('文本增量 → content_block_delta(text) + AssistantMessage', async () => {
    const chunks: MockChunk[] = [
      { candidates: [{ content: { parts: [{ text: 'Hello' }] }, finishReason: undefined }] },
      { candidates: [{ content: { parts: [{ text: ' world' }] }, finishReason: undefined }] },
      { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
    ];
    const client = makeMockClient(chunks);
    const streamClient = new GoogleStreamClient({ apiKey: 'test', model: 'gemini-2.5-flash' }, client as any);

    const events = await collect(streamClient.stream(MESSAGES, TOOLS, OPTIONS));

    // 1. message_start(首个 chunk 合成)
    const msgStart = events.find(e => e.type === 'message_start');
    expect(msgStart).toBeDefined();

    // 2. 文本 delta
    const textDeltas = events.filter(e => e.type === 'content_block_delta' && (e as any).deltaType === 'text');
    expect(textDeltas.length).toBe(2);
    expect((textDeltas[0] as any).content).toBe('Hello');
    expect((textDeltas[1] as any).content).toBe(' world');

    // 3. AssistantMessage(含 text block)
    const assistantMsgs = events.filter(e => e.type === 'assistant') as AssistantMessage[];
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    const textBlock = assistantMsgs[0]!.content.find(b => b.type === 'text');
    expect(textBlock).toBeDefined();
    expect((textBlock as any).text).toBe('Hello world');

    // 4. message_stop
    expect(events.some(e => e.type === 'message_stop')).toBe(true);
  });
});

// ─────────────── 工具调用响应 ───────────────

describe('GoogleStreamClient — 工具调用', () => {
  it('functionCall → content_block_start(tool_use) + input_json + AssistantMessage(tool_use)', async () => {
    const chunks: MockChunk[] = [
      {
        candidates: [{
          content: {
            parts: [{
              functionCall: { id: 'call_1', name: 'run_bash', args: { command: 'ls' } },
            }],
          },
          finishReason: undefined,
        }],
      },
      { candidates: [{ finishReason: 'STOP' }] },
    ];
    const client = makeMockClient(chunks);
    const streamClient = new GoogleStreamClient({ apiKey: 'test', model: 'gemini-2.5-flash' }, client as any);

    const events = await collect(streamClient.stream(MESSAGES, TOOLS, OPTIONS));

    // 1. content_block_start(tool_use)
    const blockStart = events.find(e => e.type === 'content_block_start');
    expect(blockStart).toBeDefined();
    expect((blockStart as any).blockType).toBe('tool_use');

    // 2. input_json delta(完整 JSON,不是增量)
    const jsonDeltas = events.filter(e => e.type === 'content_block_delta' && (e as any).deltaType === 'input_json');
    expect(jsonDeltas.length).toBe(1);
    // args 被 JSON.stringify
    const parsed = JSON.parse((jsonDeltas[0] as any).content);
    expect(parsed).toEqual({ command: 'ls' });

    // 3. AssistantMessage 含 tool_use block(关键!否则工具不执行)
    const assistantMsgs = events.filter(e => e.type === 'assistant') as AssistantMessage[];
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    const toolUseBlock = assistantMsgs[0]!.content.find(b => b.type === 'tool_use');
    expect(toolUseBlock).toBeDefined();
    expect((toolUseBlock as any).name).toBe('run_bash');
    // input 是 object
    expect((toolUseBlock as any).input).toEqual({ command: 'ls' });
  });
});

// ─────────────── 文本 + 工具混合 ───────────────

describe('GoogleStreamClient — 文本+工具混合', () => {
  it('先文本后工具:两种 block 都出现', async () => {
    const chunks: MockChunk[] = [
      { candidates: [{ content: { parts: [{ text: 'Let me check.' }] }, finishReason: undefined }] },
      {
        candidates: [{
          content: { parts: [{ functionCall: { id: 'c1', name: 'run_bash', args: { command: 'pwd' } } }] },
          finishReason: undefined,
        }],
      },
      { candidates: [{ finishReason: 'STOP' }] },
    ];
    const client = makeMockClient(chunks);
    const streamClient = new GoogleStreamClient({ apiKey: 'test', model: 'gemini-2.5-flash' }, client as any);

    const events = await collect(streamClient.stream(MESSAGES, TOOLS, OPTIONS));
    const assistantMsgs = events.filter(e => e.type === 'assistant') as AssistantMessage[];
    const allBlocks = assistantMsgs.flatMap(m => m.content);
    expect(allBlocks.some(b => b.type === 'text')).toBe(true);
    expect(allBlocks.some(b => b.type === 'tool_use')).toBe(true);
  });
});

// ─────────────── 图片输入 ───────────────

describe('GoogleStreamClient — 图片输入', () => {
  it('ImageBlock → inlineData part（纯 base64）', async () => {
    // 最小合法响应:3 chunk(role/content/finish)
    const chunks: MockChunk[] = [
      { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: undefined }] },
      { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
    ];
    const mockWrapper = makeMockClient(chunks);
    const streamClient = new GoogleStreamClient(
      { apiKey: 'test', model: 'gemini-2.5-flash' },
      mockWrapper as any,
    );

    const imageBlock: ImageBlock = { type: 'image', mediaType: 'image/png', data: 'AAA' };
    const messages: Message[] = [
      { role: 'user', content: [imageBlock, { type: 'text', text: 'describe' }] },
    ];

    await collect(streamClient.stream(messages, TOOLS, OPTIONS));

    // 断言传给 SDK 的 contents 里 user parts 含 inlineData
    expect(mockWrapper.captured.length).toBeGreaterThanOrEqual(1);
    const captured = mockWrapper.captured[0]!.contents as Array<{ role: string; parts: any[] }>;
    const userMsg = captured.find(c => c.role === 'user');
    expect(userMsg).toBeDefined();
    const inlineDataPart = userMsg!.parts.find((p: any) => p.inlineData);
    expect(inlineDataPart).toBeDefined();
    expect(inlineDataPart.inlineData.mimeType).toBe('image/png');
    expect(inlineDataPart.inlineData.data).toBe('AAA'); // 纯 base64,无 data URL 前缀
    // text part 也保留
    expect(userMsg!.parts.some((p: any) => p.text === 'describe')).toBe(true);
  });
});
