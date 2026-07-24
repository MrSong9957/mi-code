// src/__tests__/agent/api-diff-structured-outcome.test.ts
// AUTO-0025 Phase B (Task 15):API diff 验证(硬约束)。
//
// 目标:证明 StructuredAskResult 不进入发给 Anthropic 的 API 请求。
// 方法:直接调用 AnthropicStreamClient.convertMessages(private,测试用 as any 访问),
// 构造含 ask_user_question tool_result 的 messages,断言转换后的 API payload:
// - tool_result.content 是纯字符串(serialize 产物)
// - 无 structuredOutcome 字段(它只存在于 UI 通道)
//
// 这是 meta 旁路的核心契约:UI/API 双通道隔离。
// API 通道(Message.content → ToolResultBlock → convertMessages → Anthropic)永远不携带结构化数据;
// 结构化数据走 UI 通道(ToolResultEvent.structuredOutcome → StreamMessage → Block → block-pipeline)。

import { describe, it, expect } from 'vitest';
import { AnthropicStreamClient } from '../../agent/anthropic-stream-client.js';
import { serializeAskQuestionOutcome } from '../../agent/ask-user-serialization.js';
import type { Message, ToolResultBlock } from '../../agent/types.js';
import type { StructuredAskResult } from '../../agent/ask-user-types.js';

/**
 * 构造一个"完整 PR2 链路"的消息:assistant 调用 ask_user_question + user 回写 tool_result。
 * tool_result.content 是 serializeAskQuestionOutcome 产出的字符串(与真实路径一致)。
 * StructuredAskResult 只存在于 UI 通道(此处故意不放进 Message,证明它本就不属于 API 数据源)。
 */
function makeApiMessages(): Message[] {
  const outcome = { kind: 'submitted' as const, answers: { 'Which auth?': 'OAuth' } };
  const toolResult: ToolResultBlock = {
    type: 'tool_result',
    tool_use_id: 'tuu-1',
    content: serializeAskQuestionOutcome(outcome),
  };
  return [
    {
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tuu-1', name: 'ask_user_question', input: { questions: [] } },
      ],
    },
    {
      role: 'user',
      content: [toolResult],
    },
  ];
}

describe('AUTO-0025 Phase B (Task 15):API diff — structuredOutcome 不污染 API 通道', () => {
  it('convertMessages:tool_result 的 content 是纯字符串', async () => {
    const client = new AnthropicStreamClient({ apiKey: 'test-key' });
    const apiMessages = (client as unknown as { convertMessages: (m: Message[]) => unknown[] })
      .convertMessages(makeApiMessages());

    // 找到 tool_result 块(在第 3 条 user 消息里)
    const userToolResultMsg = apiMessages[2] as { role: string; content: Array<{ type: string; content?: unknown }> };
    expect(userToolResultMsg.role).toBe('user');
    const toolResultBlock = userToolResultMsg.content.find(b => b.type === 'tool_result');
    expect(toolResultBlock).toBeDefined();

    // 核心断言 1:content 是 string 类型(非对象、非含 structuredOutcome 的结构)
    expect(typeof toolResultBlock!.content).toBe('string');
    // 核心断言 2:content 值是 serialize 产出的自然语言字符串
    expect(toolResultBlock!.content).toBe(
      serializeAskQuestionOutcome({ kind: 'submitted', answers: { 'Which auth?': 'OAuth' } }),
    );
  });

  it('convertMessages:tool_result 块无 structuredOutcome 字段', async () => {
    const client = new AnthropicStreamClient({ apiKey: 'test-key' });
    const apiMessages = (client as unknown as { convertMessages: (m: Message[]) => unknown[] })
      .convertMessages(makeApiMessages());

    const userToolResultMsg = apiMessages[2] as { role: string; content: Array<Record<string, unknown>> };
    const toolResultBlock = userToolResultMsg.content.find(b => b.type === 'tool_result')!;

    // 核心断言 3:API payload 的 tool_result 块只有 type/tool_use_id/content,无 structuredOutcome
    expect(Object.keys(toolResultBlock).sort()).toEqual(['content', 'tool_use_id', 'type']);
    expect(toolResultBlock).not.toHaveProperty('structuredOutcome');
    expect(toolResultBlock).not.toHaveProperty('request');
    expect(toolResultBlock).not.toHaveProperty('outcome');
  });

  it('ToolResultBlock 类型本身不含 structuredOutcome(类型层面证明)', () => {
    // 构造一个 ToolResultBlock:TypeScript 只允许 type/tool_use_id/content 三个字段。
    // StructuredAskResult 走 UI 通道(ToolResultEvent/StreamMessage/Block),与 ToolResultBlock 是不同类型。
    const block: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'x',
      content: 'y',
    };
    // 运行时再次确认:对象只有 3 个键
    expect(Object.keys(block).sort()).toEqual(['content', 'tool_use_id', 'type']);

    // StructuredAskResult 是独立的 UI 通道类型(此处仅证明它存在且与 ToolResultBlock 无字段交集)
    const uiChannel: StructuredAskResult = {
      version: 1,
      request: { questions: [] },
      outcome: { kind: 'cancelled' },
    };
    expect(uiChannel.version).toBe(1);
    // 两类型的字段集互斥:ToolResultBlock 无 version/request/outcome;StructuredAskResult 无 type/tool_use_id/content
    expect(block).not.toHaveProperty('version');
    expect(uiChannel).not.toHaveProperty('tool_use_id');
  });
});
