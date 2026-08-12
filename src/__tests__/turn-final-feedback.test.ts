import { describe, expect, it } from 'vitest';
import {
  finalizeTurnForUser as finalizeTurnForUserWithTranslator,
  commitFinalizedTurn,
  buildTurnStatusCandidate,
  type TurnToolFact,
  type TurnFinalizationInput,
} from '../agent/turn-final-feedback.js';
import type { Message } from '../agent/types.js';
import { createLanguageStore, createTranslator, type Translator } from '../locale/index.js';
import { shouldEmitTurnStatus } from '../tui/state/transcript-reducer.js';
import type { AgentBlock } from '../tui/transcript-types.js';

const zhTranslator = createTranslator(createLanguageStore('zh-CN'));

function finalizeTurnForUser(input: Parameters<typeof finalizeTurnForUserWithTranslator>[0], translator: Translator = zhTranslator) {
  return finalizeTurnForUserWithTranslator(input, translator);
}

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
  // 行为变更(v1):finalizeTurnForUser 不再产出四字段 feedbackText / requiresFeedback,
  // 改为返回简洁的 candidate(partial/failed/cancelled)或 null。
  // cancelled 只来自 aborted(无视 classified);成功→null。
  it('用户中止且没有 useful output 时归为部分完成；candidate 为 cancelled', () => {
    const result = finalizeTurnForUser({
      messages: [],
      turnStartIndex: 0,
      toolFacts: [],
      aborted: true,
    });

    expect(result.status).toBe('部分完成');
    // aborted → candidate.status === 'cancelled'(cancelled 只来自 aborted)
    expect(result.candidate?.status).toBe('cancelled');
  });

  it('普通 provider error 且没有 useful output 时仍归为失败；candidate 为 failed', () => {
    const result = finalizeTurnForUser({
      messages: [],
      turnStartIndex: 0,
      toolFacts: [],
      error: 'provider disconnected',
      aborted: false,
    });

    expect(result.status).toBe('失败');
    expect(result.candidate?.status).toBe('failed');
  });

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
  ])('$name => status $expected', ({ messages, toolFacts, error, expected }) => {
    const result = finalizeTurnForUser({
      messages,
      turnStartIndex: 0,
      toolFacts,
      error,
      aborted: false,
    });
    expect(result.status).toBe(expected);
    // candidate 由 buildTurnStatusCandidate(aborted=false) 从 classified 映射:
    // 成功→null,部分完成→partial,失败→failed。不再有四字段 feedbackText。
    if (expected === '成功') {
      expect(result.candidate).toBeNull();
    } else if (expected === '部分完成') {
      expect(result.candidate?.status).toBe('partial');
    } else {
      expect(result.candidate?.status).toBe('failed');
    }
  });

  it('正常成功路径(有终端 assistant 文本)candidate 为 null 且 messages 不变', () => {
    const result = finalizeTurnForUser({
      messages: [assistant('这是明确的总结回复')],
      turnStartIndex: 0,
      toolFacts: [],
      aborted: false,
    });
    expect(result.status).toBe('成功');
    expect(result.candidate).toBeNull();
    // messages 不变(不再追加四字段状态块)
    expect(result.messages).toEqual([assistant('这是明确的总结回复')]);
  });
});

describe('finalizeTurnForUser 本地化', () => {
  // 行为变更(v1):不再产出四字段本地化块;candidate.line 是单行本地化文本。
  it.each([
    ['zh-CN' as const, '✖ 失败'],
    ['en-US' as const, '✖ Failed'],
  ])('localizes candidate line for failed status in %s', (language, expectedLine) => {
    const result = finalizeTurnForUser({
      messages: [],
      turnStartIndex: 0,
      toolFacts: [tool('run_bash', 'The user rejected this action.', 'failure')],
      aborted: false,
    }, createTranslator(createLanguageStore(language)));

    expect(result.candidate?.status).toBe('failed');
    expect(result.candidate?.line).toBe(expectedLine);
  });

  it('does not append any status block to messages (no uiOnly append)', () => {
    // 即使输入里已有一条"当前状态"文本,v1 也不再追加第二条(不再有 appendFeedback)。
    const messages = [assistant('当前状态：失败')];
    const result = finalizeTurnForUser({
      messages,
      turnStartIndex: 0,
      toolFacts: [tool('run_bash', 'The user rejected this action.', 'failure')],
      aborted: false,
    }, zhTranslator);

    expect(result.messages).toEqual(messages);
    expect(countStatusBlocks(result.messages)).toBe(1); // 只有输入里原有的那一条
  });
});

it('finalize is idempotent: messages unchanged, no status block appended', () => {
  // 行为变更(v1):finalize 不再向 messages 追加四字段状态块。
  // 重复 finalize 仍幂等(messages 不变,无状态块)。
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
  // 新行为:不向 messages 追加任何状态块
  expect(countStatusBlocks(second.messages)).toBe(0);
});

// 行为变更(v1):移除 appendFeedback / uiOnly 状态块整套逻辑。
// 旧 describe('appendFeedback 状态块 uiOnly 标记') 已删除 —— 不再有 uiOnly 追加。

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
  expect(result.candidate?.status).toBe('partial');
  // 新行为:不向 messages 追加状态块
  expect(countStatusBlocks(result.messages)).toBe(0);
});

// ════════════════════════════════════════════════════════════════════
// commitFinalizedTurn:v1 persist-only。
//
// 行为变更:不再接收 emit 参数、不再读 requiresFeedback/feedbackText。
// 只把 finalized messages 里新增的部分 awaited 落盘,返回新计数。
// turn-status 兜底行的 emit 决策移到 index.ts(调用 shouldEmitTurnStatus)。
// ════════════════════════════════════════════════════════════════════
describe('commitFinalizedTurn', () => {
  it('persists new messages and returns count (persist-only, no emit param)', async () => {
    const appended: Message[] = [];
    const result = finalizeTurnForUser({
      messages: [
        assistantToolUse('s1', 'task'),
        toolResult('s1', '[Subagent status=incomplete reason=error]\nrecovered work'),
      ],
      turnStartIndex: 0,
      toolFacts: [tool('task', '[Subagent status=incomplete reason=error]\nrecovered work', 'success')],
      aborted: false,
    });
    // v1: messages 不变(不再追加四字段状态块消息)
    expect(result.messages.length).toBe(2);

    const count = await commitFinalizedTurn(
      result,
      0,
      async message => { appended.push(message); },
    );

    expect(count).toBe(2);
    expect(appended).toHaveLength(2);
  });

  it('awaits persistence of only the new messages (slice persistedMessageCount)', async () => {
    const appended: Message[] = [];
    const result = finalizeTurnForUser({
      messages: [assistant('正常回复')],
      turnStartIndex: 0,
      toolFacts: [],
      aborted: false,
    });
    // 已持久化 1 条 → 不再重复 append
    const count = await commitFinalizedTurn(
      result,
      1,
      async message => { appended.push(message); },
    );
    expect(count).toBe(1);
    expect(appended).toHaveLength(0);
  });

  it('正常成功路径也持久化全部消息(persist-only,无 emit 决策)', async () => {
    const appended: Message[] = [];
    const result = finalizeTurnForUser({
      messages: [assistant('明确的正常回复')],
      turnStartIndex: 0,
      toolFacts: [],
      aborted: false,
    });
    expect(result.candidate).toBeNull();

    const count = await commitFinalizedTurn(
      result,
      0,
      async message => { appended.push(message); },
    );

    expect(count).toBe(1);
    expect(appended).toHaveLength(1);
    expect(appended[0].role).toBe('assistant');
  });
});

// ════════════════════════════════════════════════════════════════════
// buildTurnStatusCandidate / shouldEmitTurnStatus
//
// cancelled 映射的硬规则:cancelled 只来自 input.aborted,绝不从 UserTurnStatus
// 推导(classifyTurn 的 '部分完成' 在 aborted 时仍映射到 cancelled,不是 partial)。
// shouldEmitTurnStatus 是唯一的生产决策缝:candidate !== null 且无可见异常活动。
// ════════════════════════════════════════════════════════════════════
function makeInput(overrides: Partial<TurnFinalizationInput>): TurnFinalizationInput {
  return {
    messages: [],
    turnStartIndex: 0,
    toolFacts: [],
    aborted: false,
    ...overrides,
  };
}

describe('buildTurnStatusCandidate', () => {
  it('aborted: true -> cancelled (无论 classified 是什么)', () => {
    // aborted 时 classifyTurn 会返回 '部分完成',但 candidate 必须是 cancelled
    const candidate = buildTurnStatusCandidate(
      makeInput({ aborted: true }),
      '部分完成',
      zhTranslator,
    );
    expect(candidate?.status).toBe('cancelled');
  });

  it('aborted: true 即使 classified=失败 也映射 cancelled', () => {
    const candidate = buildTurnStatusCandidate(
      makeInput({ aborted: true }),
      '失败',
      zhTranslator,
    );
    expect(candidate?.status).toBe('cancelled');
  });

  it('aborted: false, classified: 成功 -> null', () => {
    const candidate = buildTurnStatusCandidate(
      makeInput({ aborted: false }),
      '成功',
      zhTranslator,
    );
    expect(candidate).toBeNull();
  });

  it('aborted: false, classified: 部分完成 -> { status: partial }', () => {
    const candidate = buildTurnStatusCandidate(
      makeInput({ aborted: false }),
      '部分完成',
      zhTranslator,
    );
    expect(candidate?.status).toBe('partial');
  });

  it('aborted: false, classified: 失败 -> { status: failed }', () => {
    const candidate = buildTurnStatusCandidate(
      makeInput({ aborted: false }),
      '失败',
      zhTranslator,
    );
    expect(candidate?.status).toBe('failed');
  });

  it('candidate.line 来自 translator.t(status.turnFinal.*Line)', () => {
    const partial = buildTurnStatusCandidate(
      makeInput({ aborted: false }),
      '部分完成',
      createTranslator(createLanguageStore('en-US')),
    );
    expect(partial?.line).toBe('⚠ Partial');

    const failed = buildTurnStatusCandidate(
      makeInput({ aborted: false }),
      '失败',
      createTranslator(createLanguageStore('en-US')),
    );
    expect(failed?.line).toBe('✖ Failed');

    const cancelled = buildTurnStatusCandidate(
      makeInput({ aborted: true }),
      '部分完成',
      createTranslator(createLanguageStore('en-US')),
    );
    expect(cancelled?.line).toBe('○ Cancelled');
  });
});

// ════════════════════════════════════════════════════════════════════
// Task 7 — 生产决策缝验收(production TurnStatus seam)
//
// 驱动真实的 finalizeTurnForUser(classifyTurn + buildTurnStatusCandidate)+ 真实的
// shouldEmitTurnStatus(transcript-reducer 的唯一决策缝)。这是能在生产 bug 上真正
// 变红的测试:既验证 outcome 终态分类(aborted→cancelled / rule-7 部分完成),也验证
// emit 决策(可见异常活动抑制兜底行 / 无可见异常时真正 emit)。
//
// 关键:不在此处复制任何决策逻辑。candidate 来自真实 finalizer,items 直接喂给真实
// shouldEmitTurnStatus。每个用例都带「right-reason guard」证明决策在做真正的判别
// (而非恒 true / 恒 false 的假阳性)。
// ════════════════════════════════════════════════════════════════════
describe('production TurnStatus seam — spawn_agent cancelled case', () => {
  it('aborted turn with an Agent cancelled already visible -> no duplicate TurnStatus', () => {
    // 真实生产 finalizer 处理一个 aborted fixture。
    // abortedMessages 刻画「用户要求 spawn_agent,assistant 已发出 call,回合被中止」:
    // toolFacts 为空(spawn_agent 未返回 result 事实),aborted=true。
    const abortedMessages: Message[] = [
      { role: 'user', content: '启动子代理调查项目' },
      assistantToolUse('a1', 'spawn_agent'),
    ];
    const finalized = finalizeTurnForUser(
      {
        messages: abortedMessages,
        turnStartIndex: 0,
        toolFacts: [],
        error: undefined,
        aborted: true,
      },
      zhTranslator,
    );
    // candidate 来自 aborted 硬规则:cancelled 只从 input.aborted 来(无视 classified)。
    // classifyTurn 在 aborted 时返回 '部分完成',但 candidate 必须是 cancelled。
    expect(finalized.candidate?.status).toBe('cancelled');

    // items 反映用户已看到的内容:一个已由 Task 4 固化的 AgentBlock(cancelled)。
    const itemsWithCancelledAgent: AgentBlock[] = [
      { id: 'a1', kind: 'agent', label: '调查项目', status: 'cancelled' },
    ];
    // 可见的 cancelled AgentBlock 解释了本回合结局 -> 不再补冗余 TurnStatus。
    expect(shouldEmitTurnStatus(finalized.candidate, itemsWithCancelledAgent)).toBe(false);

    // right-reason guard:同一个 cancelled candidate,若无可见异常活动,
    // 则「会」emit。证明抑制来自 agent 块的可见性,而非恒 false 的假阳性。
    expect(shouldEmitTurnStatus(finalized.candidate, [])).toBe(true);
  });

  it('partial turn with NO visible abnormal activity -> emits TurnStatus', () => {
    // 构造一个真实分类为「部分完成」的 fixture(rule 7:最后 tool_result 之后无终端
    // assistant 文本 + 存在成功工具事实),且不含任何会在时间线上解释结局的异常活动。
    // assistantToolUse 仅含 tool_use 块无文本 -> getTerminalAssistantText 返回 ''；
    // toolFacts 的 memory_list 成功 -> rule 7 走 hasSuccessfulTool 分支返回「部分完成」。
    const partialNoAbnormalMessages: Message[] = [
      assistantToolUse('t1', 'memory_list'),
      toolResult('t1', 'No memories'),
    ];
    const finalized = finalizeTurnForUser(
      {
        messages: partialNoAbnormalMessages,
        turnStartIndex: 0,
        toolFacts: [tool('memory_list', 'No memories', 'success')],
        error: undefined,
        aborted: false,
      },
      zhTranslator,
    );
    // 真实 rule-7 分类(非 aborted / 非 error / 无失败事实 / 无终端文本 + 成功工具)。
    expect(finalized.status).toBe('部分完成');
    expect(finalized.candidate?.status).toBe('partial');
    // 时间线无可见项 -> 无异常活动 -> 真正的兜底 emit。
    expect(shouldEmitTurnStatus(finalized.candidate, [])).toBe(true);

    // right-reason guard:若时间线里出现可见异常活动(如一个失败工具),
    // 则「不会」emit。证明 emit 决策在做真正的判别,而非恒 true 的假阳性。
    const itemsWithAbnormal: AgentBlock[] = [
      { id: 'x1', kind: 'agent', label: '子任务', status: 'partial' },
    ];
    expect(shouldEmitTurnStatus(finalized.candidate, itemsWithAbnormal)).toBe(false);
  });
});
