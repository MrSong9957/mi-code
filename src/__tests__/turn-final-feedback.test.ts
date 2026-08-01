import { describe, expect, it } from 'vitest';
import { finalizeTurnForUser, type TurnToolFact } from '../agent/turn-final-feedback.js';
import type { Message } from '../agent/types.js';

function assistant(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function assistantToolUse(id: string, name: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input: {} }],
  };
}

function toolResult(id: string, output: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: output }],
  };
}

function tool(
  name: string,
  output: string,
  status: 'success' | 'failure',
): TurnToolFact {
  return { name, output, executionStatus: status };
}

function countStatusBlocks(messages: readonly Message[]): number {
  return messages
    .flatMap(message => typeof message.content === 'string'
      ? [message.content]
      : message.content.filter(block => block.type === 'text').map(block => block.text))
    .reduce((count, text) => count + (text.match(/^当前状态：/gm)?.length ?? 0), 0);
}

describe('finalizeTurnForUser 分类', () => {
  it.each([
    {
      name: 'normal final text',
      messages: [assistant('answer')],
      toolFacts: [],
      error: undefined,
      expected: '成功',
    },
    {
      name: 'missing final text after recovered subagent work',
      messages: [],
      toolFacts: [tool('spawn_agent', '[Subagent status=incomplete reason=error]\nrecovered work', 'success')],
      error: undefined,
      expected: '部分完成',
    },
    {
      name: 'completed subagent result without a model-authored final message',
      messages: [],
      toolFacts: [tool('spawn_agent', '[Subagent status=completed]\ncompleted work', 'success')],
      error: undefined,
      expected: '成功',
    },
    {
      name: 'tool failure without result',
      messages: [],
      toolFacts: [tool('read_file', 'Error: denied', 'failure')],
      error: undefined,
      expected: '失败',
    },
    {
      name: 'provider error after useful output',
      messages: [assistant('partial answer')],
      toolFacts: [],
      error: 'provider disconnected',
      expected: '部分完成',
    },
  ])('$name => $expected', ({ messages, toolFacts, error, expected }) => {
    const result = finalizeTurnForUser({
      messages,
      turnStartIndex: 0,
      toolFacts,
      error,
      aborted: false,
    });
    expect(result.status).toBe(expected);
    expect(result.feedbackText).toContain(`当前状态：${expected}`);
    expect(result.feedbackText).toContain('已获得结果：');
    expect(result.feedbackText).toContain('失败或受阻位置：');
    expect(result.feedbackText).toContain('下一步：');
  });
});

it('appends one terminal status block to the last assistant message', () => {
  const first = finalizeTurnForUser({
    messages: [assistant('answer')],
    turnStartIndex: 0,
    toolFacts: [],
    aborted: false,
  });
  const second = finalizeTurnForUser({
    messages: first.messages,
    turnStartIndex: 0,
    toolFacts: [],
    aborted: false,
  });

  expect(second.messages).toEqual(first.messages);
  expect(countStatusBlocks(second.messages)).toBe(1);
});

it('does not count assistant prose before the last tool result as a terminal reply', () => {
  const result = finalizeTurnForUser({
    messages: [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect it.' },
          { type: 'tool_use', id: 't1', name: 'task', input: {} },
        ],
      },
      toolResult('t1', '[Subagent status=incomplete reason=error]\nrecovered work'),
    ],
    turnStartIndex: 1,
    toolFacts: [tool('task', '[Subagent status=incomplete reason=error]\nrecovered work', 'success')],
    aborted: false,
  });

  expect(result.status).toBe('部分完成');
  expect(result.messages.at(-1)?.role).toBe('assistant');
  expect(countStatusBlocks(result.messages)).toBe(1);
});
