import { describe, expect, it } from 'vitest';
import {
  finalizeTurnForUser,
  commitFinalizedTurn,
  type TurnToolFact,
} from '../agent/turn-final-feedback.js';
import type { Message, ContentBlock } from '../agent/types.js';

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
    // 正常成功路径(模型已给出终端 assistant 文本)不追加状态块:
    // feedbackText 为空、messages 不变、requiresFeedback=false。
    // 只有异常兜底(部分完成/失败/无终端文本的成功)才生成状态块。
    if (result.requiresFeedback) {
      expect(result.feedbackText).toContain(`当前状态：${expected}`);
      expect(result.feedbackText).toContain('已获得结果：');
      expect(result.feedbackText).toContain('失败或受阻位置：');
      expect(result.feedbackText).toContain('下一步：');
    }
  });

  it('正常成功路径(有终端 assistant 文本)不追加状态块也不生成 feedbackText', () => {
    const result = finalizeTurnForUser({
      messages: [assistant('这是明确的总结回复')],
      turnStartIndex: 0,
      toolFacts: [],
      aborted: false,
    });
    expect(result.status).toBe('成功');
    expect(result.requiresFeedback).toBe(false);
    expect(result.feedbackText).toBe('');
    // messages 不变(未追加状态块)
    expect(result.messages).toEqual([assistant('这是明确的总结回复')]);
  });
});

it('appends one terminal status block to the last assistant message (需要反馈场景幂等)', () => {
  // 用"需要反馈"的场景(子代理完成但模型无 final 回复)验证幂等:
  // 重复 finalize 仍只追加一个状态块。
  const baseMessages: Message[] = [
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'task', input: {} },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '[Subagent status=completed]\ncompleted work' }] },
  ];
  const first = finalizeTurnForUser({
    messages: baseMessages,
    turnStartIndex: 1,
    toolFacts: [tool('task', '[Subagent status=completed]\ncompleted work', 'success')],
    aborted: false,
  });
  const second = finalizeTurnForUser({
    messages: first.messages,
    turnStartIndex: 1,
    toolFacts: [tool('task', '[Subagent status=completed]\ncompleted work', 'success')],
    aborted: false,
  });

  expect(second.messages).toEqual(first.messages);
  expect(countStatusBlocks(second.messages)).toBe(1);
});

// ★ uiOnly 标记:final-feedback 状态块必须独立 text block 且 uiOnly=true
describe('appendFeedback 状态块 uiOnly 标记', () => {
  // helper:构造一个"需要 feedback"的场景(tool-only assistant + completed subagent result)
  function needFeedbackMessages(): Message[] {
    return [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'task', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '[Subagent status=completed]\ncompleted work' }] },
    ];
  }
  const tf = [tool('task', '[Subagent status=completed]\ncompleted work', 'success')];

  it('array content → feedback block 为独立 text block 且 uiOnly=true', () => {
    const result = finalizeTurnForUser({
      messages: needFeedbackMessages(),
      turnStartIndex: 1,
      toolFacts: tf,
      aborted: false,
    });
    // finalized 后应有新 assistant message(终端无 assistant text → push 新 message)
    const last = result.messages.at(-1)!;
    expect(last.role).toBe('assistant');
    const blocks = last.content as ContentBlock[];
    // 状态块是独立 block,uiOnly=true
    const feedbackBlock = blocks.find(b => b.type === 'text' && (b as { uiOnly?: boolean }).uiOnly === true);
    expect(feedbackBlock).toBeDefined();
    expect(feedbackBlock!.type).toBe('text');
  });

  it('string content assistant → 规范化为两 block(原正文 + uiOnly feedback),不拼接', () => {
    // 构造:string content assistant 在 tool_result 之后
    const messages: Message[] = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: '正文回复' }, // string content,turnStartIndex=1
    ];
    // 用失败场景强制 feedback(error)
    const result = finalizeTurnForUser({
      messages,
      turnStartIndex: 1,
      toolFacts: [],
      error: 'something failed',
      aborted: false,
    });
    const last = result.messages.at(-1)!;
    expect(last.role).toBe('assistant');
    expect(Array.isArray(last.content)).toBe(true); // string 已规范化为 array
    const blocks = last.content as ContentBlock[];
    // 第一个 block 是原正文(无 uiOnly)
    expect(blocks[0]).toEqual({ type: 'text', text: '正文回复' });
    // 最后一个 block 是 feedback(uiOnly=true)
    const fb = blocks.at(-1)!;
    expect(fb.type).toBe('text');
    expect((fb as { uiOnly?: boolean }).uiOnly).toBe(true);
  });

  it('正常正文 text block 不被标记 uiOnly', () => {
    const messages: Message[] = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: [{ type: 'text', text: '正常正文' }] },
    ];
    const result = finalizeTurnForUser({
      messages,
      turnStartIndex: 1,
      toolFacts: [],
      error: 'fail',
      aborted: false,
    });
    const last = result.messages.at(-1)!;
    const blocks = last.content as ContentBlock[];
    const normalBlocks = blocks.filter(b => b.type === 'text' && (b as { uiOnly?: boolean }).uiOnly !== true);
    expect(normalBlocks.length).toBeGreaterThanOrEqual(1); // 原正文保留,未标记
    expect(normalBlocks.some(b => (b as { text: string }).text === '正常正文')).toBe(true);
  });
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

// ════════════════════════════════════════════════════════════════════
// commitFinalizedTurn:把 finalized 快照持久化并 emit 最终反馈。
//
// 物理本质:turn 结束前的"统一交班口"。finalized messages 里新增的部分要落盘,
// 然后才 emit 四字段状态块给用户看。落盘失败由调用方处理(视为失败回合)。
// ════════════════════════════════════════════════════════════════════
describe('commitFinalizedTurn', () => {
  it('persists and emits fallback text when the stream ended after a tool-only assistant', async () => {
    const appended: Message[] = [];
    const emitted: string[] = [];
    const result = finalizeTurnForUser({
      messages: [
        assistantToolUse('s1', 'task'),
        toolResult('s1', '[Subagent status=incomplete reason=error]\nrecovered work'),
      ],
      turnStartIndex: 0,
      toolFacts: [tool('task', '[Subagent status=incomplete reason=error]\nrecovered work', 'success')],
      aborted: false,
    });

    const count = await commitFinalizedTurn(
      result,
      0,
      async message => { appended.push(message); },
      text => { emitted.push(text); },
    );

    expect(count).toBe(result.messages.length);
    expect(appended.at(-1)?.role).toBe('assistant');
    expect(emitted).toEqual([result.feedbackText]);
    expect(emitted[0]).toContain('当前状态：部分完成');
  });

  it('awaits persistence of new messages in order and emits only after success', async () => {
    const order: string[] = [];
    // tool-only assistant + tool_result 场景:finalize 会新增一条 assistant 状态块消息
    const result = finalizeTurnForUser({
      messages: [
        assistantToolUse('s1', 'task'),
        toolResult('s1', '[Subagent status=incomplete reason=error]\nrecovered work'),
      ],
      turnStartIndex: 0,
      toolFacts: [tool('task', '[Subagent status=incomplete reason=error]\nrecovered work', 'success')],
      aborted: false,
    });
    // 已持久化 2 条(tool_use + tool_result),finalize 新增了 1 条 assistant 状态块
    const persistedBefore = 2;
    expect(result.messages.length).toBe(3);

    const count = await commitFinalizedTurn(
      result,
      persistedBefore,
      async message => { order.push(`append:${message.role}`); },
      text => { order.push(`emit:${text.slice(2, 4)}`); },
    );

    expect(count).toBe(3);
    // 持久化(append:assistant)先于 emit(emit:状态)
    expect(order[0]).toBe('append:assistant');
    expect(order.at(-1)).toMatch(/^emit/);
  });

  it('正常成功路径(requiresFeedback=false)持久化但不 emit 状态块', async () => {
    const appended: Message[] = [];
    const emitted: string[] = [];
    const result = finalizeTurnForUser({
      messages: [assistant('明确的正常回复')],
      turnStartIndex: 0,
      toolFacts: [],
      aborted: false,
    });
    expect(result.requiresFeedback).toBe(false);

    const count = await commitFinalizedTurn(
      result,
      0,
      async message => { appended.push(message); },
      text => { emitted.push(text); },
    );

    expect(count).toBe(result.messages.length);
    // 仍持久化正常回复(不因跳过反馈而丢消息)
    expect(appended).toHaveLength(1);
    expect(appended[0].role).toBe('assistant');
    // 关键:不 emit 任何状态块(用户不会看到四字段块)
    expect(emitted).toEqual([]);
  });
});
