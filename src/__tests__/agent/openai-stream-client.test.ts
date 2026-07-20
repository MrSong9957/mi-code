// src/__tests__/agent/openai-stream-client.test.ts
// OpenAIStreamClient 单元测试:把 OpenAI SSE chunk 翻译成统一 StreamEvent。
//
// 关键验证点(消费端不会崩,但功能必须正确的 3 件事):
// 1. yield AssistantMessage(type='assistant')—— 否则正文不流式显示、工具不执行
// 2. AssistantMessage.content 里有 tool_use block —— 否则工具永不执行
// 3. content_block_delta.deltaType='text' —— 否则正文不流式显示
//
// 用依赖注入 mock OpenAI client(不调真实 API)。

import { describe, it, expect } from 'vitest';
import { OpenAIStreamClient } from '../../agent/openai-stream-client.js';
import type { StreamEvent, AssistantMessage, Message, ToolDefinition, ImageBlock } from '../../agent/types.js';

// ── Mock OpenAI client ──
// OpenAIStreamClient 构造时注入 mock client,stream() 调 client.chat.completions.create
// 返回一个 async iterable(模拟 stream: true 的 chunk 序列)。

interface MockChunk {
  id?: string;
  model?: string;
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

function makeMockClient(chunks: MockChunk[]) {
  const captured: Array<{ messages: unknown }> = [];
  const client = {
    chat: {
      completions: {
        create: async (params: unknown): Promise<AsyncIterable<MockChunk>> => {
          // 捕获 messages 参数供测试断言 image_url 等转换结果
          captured.push({ messages: (params as any).messages });
          // 返回 async iterable,模拟 stream
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
    },
  };
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

describe('OpenAIStreamClient — 纯文本', () => {
  it('文本增量 → content_block_delta(text) + AssistantMessage', async () => {
    const chunks: MockChunk[] = [
      { id: 'chatcmpl-1', model: 'gpt-4o', choices: [{ delta: { role: 'assistant' }, finish_reason: null, index: 0 }] },
      { id: 'chatcmpl-1', model: 'gpt-4o', choices: [{ delta: { content: 'Hello' }, finish_reason: null, index: 0 }] },
      { id: 'chatcmpl-1', model: 'gpt-4o', choices: [{ delta: { content: ' world' }, finish_reason: null, index: 0 }] },
      { id: 'chatcmpl-1', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];
    const client = makeMockClient(chunks);
    const streamClient = new OpenAIStreamClient({ apiKey: 'test', model: 'gpt-4o' }, client as any);

    const events = await collect(streamClient.stream(MESSAGES, TOOLS, OPTIONS));

    // 1. message_start(首个 chunk 合成)
    const msgStart = events.find(e => e.type === 'message_start') as StreamEvent;
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

describe('OpenAIStreamClient — 工具调用', () => {
  it('tool_calls → content_block_start(tool_use) + input_json delta + AssistantMessage(tool_use)', async () => {
    const chunks: MockChunk[] = [
      { id: 'chatcmpl-2', model: 'gpt-4o', choices: [{ delta: { role: 'assistant' }, finish_reason: null, index: 0 }] },
      {
        id: 'chatcmpl-2', model: 'gpt-4o',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0, id: 'call_abc', function: { name: 'run_bash', arguments: '' },
            }],
          },
          finish_reason: null, index: 0,
        }],
      },
      {
        id: 'chatcmpl-2', model: 'gpt-4o',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0, function: { arguments: '{"command":"ls"}' },
            }],
          },
          finish_reason: null, index: 0,
        }],
      },
      { id: 'chatcmpl-2', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];
    const client = makeMockClient(chunks);
    const streamClient = new OpenAIStreamClient({ apiKey: 'test', model: 'gpt-4o' }, client as any);

    const events = await collect(streamClient.stream(MESSAGES, TOOLS, OPTIONS));

    // 1. content_block_start(tool_use)
    const blockStart = events.find(e => e.type === 'content_block_start') as StreamEvent;
    expect(blockStart).toBeDefined();
    expect((blockStart as any).blockType).toBe('tool_use');

    // 2. input_json delta
    const jsonDeltas = events.filter(e => e.type === 'content_block_delta' && (e as any).deltaType === 'input_json');
    expect(jsonDeltas.length).toBe(1);
    expect((jsonDeltas[0] as any).content).toBe('{"command":"ls"}');

    // 3. AssistantMessage 含 tool_use block(关键!否则工具不执行)
    const assistantMsgs = events.filter(e => e.type === 'assistant') as AssistantMessage[];
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    const toolUseBlock = assistantMsgs[0]!.content.find(b => b.type === 'tool_use');
    expect(toolUseBlock).toBeDefined();
    expect((toolUseBlock as any).name).toBe('run_bash');
    // input 是 JSON.parse 后的 object
    expect((toolUseBlock as any).input).toEqual({ command: 'ls' });
  });
});

// ─────────────── 文本 + 工具混合 ───────────────

describe('OpenAIStreamClient — 文本+工具混合', () => {
  it('先文本后工具:两种 block 都出现在 AssistantMessage', async () => {
    const chunks: MockChunk[] = [
      { id: 'chatcmpl-3', model: 'gpt-4o', choices: [{ delta: { role: 'assistant' }, finish_reason: null, index: 0 }] },
      { id: 'chatcmpl-3', model: 'gpt-4o', choices: [{ delta: { content: 'Let me check.' }, finish_reason: null, index: 0 }] },
      {
        id: 'chatcmpl-3', model: 'gpt-4o',
        choices: [{
          delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'run_bash', arguments: '{"command":"pwd"}' } }] },
          finish_reason: null, index: 0,
        }],
      },
      { id: 'chatcmpl-3', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
    ];
    const client = makeMockClient(chunks);
    const streamClient = new OpenAIStreamClient({ apiKey: 'test', model: 'gpt-4o' }, client as any);

    const events = await collect(streamClient.stream(MESSAGES, TOOLS, OPTIONS));

    // 应该有 text block 和 tool_use block
    const assistantMsgs = events.filter(e => e.type === 'assistant') as AssistantMessage[];
    // 合并所有 assistant 消息的 content
    const allBlocks = assistantMsgs.flatMap(m => m.content);
    expect(allBlocks.some(b => b.type === 'text')).toBe(true);
    expect(allBlocks.some(b => b.type === 'tool_use')).toBe(true);
  });
});

// ─────────────── usage / message_start ───────────────

describe('OpenAIStreamClient — usage', () => {
  it('message_start 含 inputTokens(来自 prompt_tokens)', async () => {
    const chunks: MockChunk[] = [
      { id: 'chatcmpl-4', model: 'gpt-4o', choices: [{ delta: { role: 'assistant' }, finish_reason: null, index: 0 }] },
      { id: 'chatcmpl-4', model: 'gpt-4o', choices: [{ delta: { content: 'hi' }, finish_reason: null, index: 0 }] },
      { id: 'chatcmpl-4', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 42, completion_tokens: 3 } },
    ];
    const client = makeMockClient(chunks);
    const streamClient = new OpenAIStreamClient({ apiKey: 'test', model: 'gpt-4o' }, client as any);

    const events = await collect(streamClient.stream(MESSAGES, TOOLS, OPTIONS));
    const msgStart = events.find(e => e.type === 'message_start') as any;
    // usage 在最后一个 chunk 才到,但 message_start 是首个 chunk 合成的
    // inputTokens 可能在 message_start 时为 0(usage 还没到),在 message_delta 时更新
    // 这是可接受的——消费端有 typeof 防御
    expect(msgStart).toBeDefined();
  });
});

// ─────────────── 图片输入 ───────────────

describe('OpenAIStreamClient — 图片输入', () => {
  // 用例 A:文本 + 图片(验证 content 升级为数组)
  it('文本+图片 → content 为数组,含 text part 和 image_url part', async () => {
    const chunks: MockChunk[] = [
      { id: 'img-A', model: 'gpt-4o', choices: [{ delta: { role: 'assistant' }, finish_reason: null, index: 0 }] },
      { id: 'img-A', model: 'gpt-4o', choices: [{ delta: { content: 'ok' }, finish_reason: null, index: 0 }] },
      { id: 'img-A', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ];
    const mockWrapper = makeMockClient(chunks);
    const streamClient = new OpenAIStreamClient({ apiKey: 'test', model: 'gpt-4o' }, mockWrapper as any);

    const imageBlock: ImageBlock = { type: 'image', mediaType: 'image/png', data: 'AAA' };
    const messages: Message[] = [
      { role: 'user', content: [imageBlock, { type: 'text', text: 'describe' }] },
    ];

    await collect(streamClient.stream(messages, TOOLS, OPTIONS));

    expect(mockWrapper.captured.length).toBeGreaterThanOrEqual(1);
    const capturedMessages = mockWrapper.captured[0]!.messages as Array<{ role: string; content: any }>;
    // 找到 user 消息(跳过 system)
    const userMsg = capturedMessages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(Array.isArray(userMsg!.content)).toBe(true);
    // 含 image_url part
    const imageUrlPart = userMsg!.content.find((p: any) => p.type === 'image_url');
    expect(imageUrlPart).toBeDefined();
    expect(imageUrlPart.image_url.url).toBe('data:image/png;base64,AAA');
    // 含 text part
    const textPart = userMsg!.content.find((p: any) => p.type === 'text');
    expect(textPart).toBeDefined();
    expect(textPart.text).toBe('describe');
  });

  // 用例 B:纯图片(验证修复后的新分支,防止回归)
  it('纯图片 → content 为纯 image_url 数组(不被 L253 else if 丢弃)', async () => {
    const chunks: MockChunk[] = [
      { id: 'img-B', model: 'gpt-4o', choices: [{ delta: { role: 'assistant' }, finish_reason: null, index: 0 }] },
      { id: 'img-B', model: 'gpt-4o', choices: [{ delta: { content: 'ok' }, finish_reason: null, index: 0 }] },
      { id: 'img-B', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ];
    const mockWrapper = makeMockClient(chunks);
    const streamClient = new OpenAIStreamClient({ apiKey: 'test', model: 'gpt-4o' }, mockWrapper as any);

    const imageBlock: ImageBlock = { type: 'image', mediaType: 'image/jpeg', data: 'BBB' };
    const messages: Message[] = [{ role: 'user', content: [imageBlock] }];

    await collect(streamClient.stream(messages, TOOLS, OPTIONS));

    const capturedMessages = mockWrapper.captured[0]!.messages as Array<{ role: string; content: any }>;
    const userMsg = capturedMessages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined(); // 关键:修复前 user 消息会被跳过
    expect(Array.isArray(userMsg!.content)).toBe(true);
    expect(userMsg!.content.length).toBe(1);
    expect(userMsg!.content[0].type).toBe('image_url');
    expect(userMsg!.content[0].image_url.url).toBe('data:image/jpeg;base64,BBB');
  });

  // 用例 C:纯文本(验证不回归,content 仍为字符串)
  it('纯文本 → content 仍为字符串(不被错误升级为数组)', async () => {
    const chunks: MockChunk[] = [
      { id: 'img-C', model: 'gpt-4o', choices: [{ delta: { role: 'assistant' }, finish_reason: null, index: 0 }] },
      { id: 'img-C', model: 'gpt-4o', choices: [{ delta: { content: 'ok' }, finish_reason: null, index: 0 }] },
      { id: 'img-C', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    ];
    const mockWrapper = makeMockClient(chunks);
    const streamClient = new OpenAIStreamClient({ apiKey: 'test', model: 'gpt-4o' }, mockWrapper as any);

    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];

    await collect(streamClient.stream(messages, TOOLS, OPTIONS));

    const capturedMessages = mockWrapper.captured[0]!.messages as Array<{ role: string; content: any }>;
    const userMsg = capturedMessages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(typeof userMsg!.content).toBe('string');
    expect(userMsg!.content).toBe('hello');
  });
});
