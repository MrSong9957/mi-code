// src/__tests__/agent/streaming-query-uionly-boundary.test.ts
//
// 阻断 A 集成边界:streamingQuery 把 initialMessages 喂模型前必须剔除 uiOnly block。
// 捕获 client.stream() 收到的 messages,验证 uiOnly block 不存在,但正常历史保留。

import { describe, it, expect } from 'vitest';
import { streamingQuery } from '../../agent/streaming-query.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import type { StreamingLLMClient, Message } from '../../agent/types.js';
import type { StreamEvent, AssistantMessage } from '../../agent/types.js';
import { createToolExecutionRuntime } from '../helpers/tool-execution-runtime.js';

const emptyRegistry = new ToolRegistry();

/**
 * CapturingClient:捕获 stream() 收到的 messages,返回最小 end_turn 响应。
 */
class CapturingClient implements StreamingLLMClient {
  public capturedMessages: Message[] | null = null;
  async *stream(
    messages: Message[],
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    this.capturedMessages = JSON.parse(JSON.stringify(messages)); // 深拷贝捕获
    yield { type: 'message_start', messageId: 'm1', model: 'test', inputTokens: 1 };
    yield { type: 'content_block_start', index: 0, blockType: 'text' };
    yield { type: 'content_block_delta', index: 0, deltaType: 'text', content: 'done' };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', stopReason: 'end_turn', outputTokens: 1 };
    yield { type: 'message_stop' };
    yield {
      type: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stopReason: 'end_turn',
      uuid: 'a1',
      timestamp: new Date().toISOString(),
    };
  }
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) { void _; }
}

describe('streamingQuery uiOnly 边界过滤', () => {
  it('initialMessages 含 uiOnly block → client.stream 收到的 messages 不含 uiOnly', async () => {
    const client = new CapturingClient();
    // 模拟上一 turn 落盘的 sessionMessages:含 uiOnly 状态块
    const initialMessages: Message[] = [
      { role: 'user', content: 'do task' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '正常回复正文' },
          { type: 'text', text: '当前状态：部分完成\n失败或受阻位置：The user rejected this action.', uiOnly: true },
        ],
      },
    ];

    await drain(streamingQuery(client, emptyRegistry, 'next turn', {
      systemPrompt: 'test',
      tools: [],
      signal: new AbortController().signal,
      executionRuntime: createToolExecutionRuntime(),
      initialMessages,
    }));

    expect(client.capturedMessages).not.toBeNull();
    const json = JSON.stringify(client.capturedMessages);
    // ★ 模型输入不含 uiOnly 字段
    expect(json).not.toContain('uiOnly');
    // ★ 模型输入不含状态块文本
    expect(json).not.toContain('当前状态');
    expect(json).not.toContain('The user rejected');
    // ★ 正常历史保留
    expect(json).toContain('正常回复正文');
    expect(json).toContain('do task');
    expect(json).toContain('next turn');
  });

  it('initialMessages 原对象仍含 uiOnly(sanitizer 不 mutation 输入)', async () => {
    const client = new CapturingClient();
    const initialMessages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '正文' },
          { type: 'text', text: '状态块', uiOnly: true },
        ],
      },
    ];
    const snapshot = JSON.parse(JSON.stringify(initialMessages));

    await drain(streamingQuery(client, emptyRegistry, 'turn', {
      systemPrompt: 'test',
      tools: [],
      signal: new AbortController().signal,
      executionRuntime: createToolExecutionRuntime(),
      initialMessages,
    }));

    // 输入原对象未被修改(仍含 uiOnly)
    expect(initialMessages).toEqual(snapshot);
    expect(JSON.stringify(initialMessages)).toContain('uiOnly');
  });

  it('无 uiOnly 的 initialMessages 正常通过', async () => {
    const client = new CapturingClient();
    const initialMessages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ];

    await drain(streamingQuery(client, emptyRegistry, 'turn', {
      systemPrompt: 'test',
      tools: [],
      signal: new AbortController().signal,
      executionRuntime: createToolExecutionRuntime(),
      initialMessages,
    }));

    expect(client.capturedMessages).not.toBeNull();
    const json = JSON.stringify(client.capturedMessages);
    expect(json).toContain('hi');
    expect(json).toContain('hello');
    expect(json).not.toContain('uiOnly');
  });
});
