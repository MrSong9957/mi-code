// src/__tests__/streaming-query-structured-outcome.test.ts
// AUTO-0025 Phase B (Task 11):streaming-query 透传 structuredOutcome 集成测试。
//
// 物理本质:验证 meta 旁路的完整消费链路。
// executor 写 store(Task 9)→ streaming-query 阶段3 take(Task 11)→ 挂载到 tool_result 事件。
// 关键断言:tool_result 事件携带 structuredOutcome(走 UI 通道),
//          而 ToolResultBlock.content 仍是 serialize 字符串(API 通道不变)。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { streamingQuery } from '../agent/streaming-query.js';
import { ToolRegistry } from '../agent/tool-registry.js';
import { askOutcomeStore } from '../agent/ask-outcome-store.js';
import { createAskUserTool } from '../agent/tools/ask-user-tool.js';
import { StreamEventBus } from '../agent/stream-event-bus.js';
import { serializeAskQuestionOutcome } from '../agent/ask-user-serialization.js';
import type {
  StreamingLLMClient,
  Message,
  ToolDefinition,
  StreamEvent,
  AssistantMessage,
  StreamOptions,
  ContentBlock,
} from '../agent/types.js';
import type { AskUserManager } from '../agent/ask-user-manager.js';

// 录制式 fake client:按剧本念台词(同 streaming-query.test.ts 的 ScriptedStreamClient)
type ScriptBlock = ContentBlock;

class ScriptedStreamClient implements StreamingLLMClient {
  private callCount = 0;
  constructor(private scripts: ScriptBlock[][]) {}

  async *stream(
    _messages: Message[],
    _tools: ToolDefinition[],
    _options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    const blocks = this.scripts[this.callCount++] ?? [];
    yield { type: 'message_start', messageId: `msg_${this.callCount}`, model: 'fake', inputTokens: 1 };
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i] as ContentBlock;
      if (block.type === 'text') {
        yield { type: 'content_block_start', index: i, blockType: 'text' };
        yield { type: 'content_block_delta', index: i, deltaType: 'text', content: block.text };
        yield { type: 'content_block_stop', index: i };
      } else if (block.type === 'tool_use') {
        yield { type: 'content_block_start', index: i, blockType: 'tool_use', blockId: block.id };
        yield { type: 'content_block_delta', index: i, deltaType: 'input_json', content: JSON.stringify(block.input) };
        yield { type: 'content_block_stop', index: i };
      }
    }
    yield { type: 'message_delta', stopReason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', outputTokens: blocks.length };
    yield { type: 'message_stop' };
    const contentBlocks = blocks.filter((b): b is ContentBlock => b.type !== 'thinking');
    yield {
      type: 'assistant',
      content: contentBlocks,
      usage: { input_tokens: 1, output_tokens: blocks.length },
      stopReason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      uuid: `asst_${this.callCount}`,
      timestamp: new Date().toISOString(),
    };
  }
}

/** Mock AskUserManager:固定返回 submitted outcome。 */
function mockAskManager(): AskUserManager {
  return {
    ask: async () => ({ kind: 'submitted' as const, answers: { 'Which auth?': 'OAuth' } }),
  } as unknown as AskUserManager;
}

const ASK_INPUT = {
  questions: [{
    header: 'Auth',
    question: 'Which auth?',
    options: [
      { label: 'OAuth', description: 'd1' },
      { label: 'Key', description: 'd2' },
    ],
    multiSelect: false,
  }],
};

describe('streamingQuery structuredOutcome 透传', () => {
  beforeEach(() => askOutcomeStore.clear());

  it('ask_user_question 的 tool_result 携带 structuredOutcome(流式执行器路径)', async () => {
    const client = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'tuu-1', name: 'ask_user_question', input: ASK_INPUT }],
      [{ type: 'text', text: 'Got it.' }],
    ]);
    const registry = new ToolRegistry();
    const askTool = createAskUserTool(mockAskManager());
    registry.register(askTool.definition, askTool.executor);

    const eventBus = new StreamEventBus();
    const toolResults: { name: string; structuredOutcome?: unknown }[] = [];
    eventBus.onToolResult(d => toolResults.push({ name: d.name, structuredOutcome: d.structuredOutcome }));

    const messages: Message[] = [];
    const gen = streamingQuery(client, registry, 'hi', {
      systemPrompt: 'sys',
      tools: [askTool.definition],
      signal: new AbortController().signal,
      eventBus,
      onMessages: m => { messages.push(...m); },
    });

    // drain generator
    for await (const _ of gen) { void _; }

    // eventBus.onToolResult 收到的 data 携带 structuredOutcome
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.name).toBe('ask_user_question');
    const so = toolResults[0]?.structuredOutcome as { version: number; request: { questions: { header: string }[] }; outcome: { kind: string; answers: Record<string, string> } } | undefined;
    expect(so).toBeDefined();
    expect(so?.version).toBe(1);
    expect(so?.request.questions[0]?.header).toBe('Auth');
    expect(so?.outcome.kind).toBe('submitted');
    expect(so?.outcome.answers['Which auth?']).toBe('OAuth');

    // API 通道零污染:写回 messages 的 ToolResultBlock.content 是 serialize 字符串
    const toolResultBlocks = messages
      .flatMap(m => Array.isArray(m.content) ? m.content : [])
      .filter(b => b.type === 'tool_result');
    expect(toolResultBlocks).toHaveLength(1);
    const expectedApiContent = serializeAskQuestionOutcome({ kind: 'submitted', answers: { 'Which auth?': 'OAuth' } });
    expect((toolResultBlocks[0] as { content: string }).content).toBe(expectedApiContent);

    // turn 结束清理生效(finally clear):store 应空(正常路径下 take 已消费)
    expect(askOutcomeStore.size()).toBe(0);
  });

  it('普通工具的 tool_result 不携带 structuredOutcome(undefined)', async () => {
    const client = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'tuu-2', name: 'plain_tool', input: {} }],
      [{ type: 'text', text: 'Done.' }],
    ]);
    const registry = new ToolRegistry();
    registry.register(
      { name: 'plain_tool', description: 'p', parameters: { type: 'object', properties: {} } },
      async () => 'plain output',
    );

    const eventBus = new StreamEventBus();
    const toolResults: { structuredOutcome?: unknown }[] = [];
    eventBus.onToolResult(d => toolResults.push({ structuredOutcome: d.structuredOutcome }));

    const gen = streamingQuery(client, registry, 'hi', {
      systemPrompt: 'sys',
      tools: [{ name: 'plain_tool', description: 'p', parameters: { type: 'object', properties: {} } }],
      signal: new AbortController().signal,
      eventBus,
    });
    for await (const _ of gen) { void _; }

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.structuredOutcome).toBeUndefined();
  });
});

// ── streamingQuery finally 生命周期契约(锁住"finally 必须 clear")──
// code review 指出的验证缺口:store 层 clear/sweep 职责测试无法防止 finally 误调 sweep。
// 此测试直接验证调用关系:turn 结束时 finally 调 clear()(确定性清空),不调 sweep()(TTL 清理)。
// 若未来有人把 finally 改回 sweep,本测试失败 —— orphan 会回归(秒级 turn 内 sweep 是 no-op)。
describe('streamingQuery turn 结束生命周期契约', () => {
  beforeEach(() => askOutcomeStore.clear());

  it('finally 调 clear() 清空 store,不调 sweep()', async () => {
    const clearSpy = vi.spyOn(askOutcomeStore, 'clear');
    const sweepSpy = vi.spyOn(askOutcomeStore, 'sweep');

    const client = new ScriptedStreamClient([
      [{ type: 'text', text: 'done' }],  // 单轮纯文本,不触发工具,正常 end_turn 退出
    ]);
    const registry = new ToolRegistry();
    const gen = streamingQuery(client, registry, 'hi', {
      systemPrompt: 'sys',
      tools: [],
      signal: new AbortController().signal,
    });
    for await (const _ of gen) { void _; }

    // 核心契约:turn 结束(无论正常/异常)finally 必须调 clear(确定性清空 orphan)
    expect(clearSpy).toHaveBeenCalled();
    // 刻意约束:sweep 不该在 turn finally 调用。sweep 是 TTL 清理(只删超 5min 的 entry),
    // 对秒级 turn 内的 orphan 是 no-op —— 这正是原 bug 的根因(finally 误调 sweep 导致 orphan 残留)。
    // 若未来设计变化需要在 finally 同时调 clear+sweep,请先评估 orphan 清理是否仍确定,
    // 再更新此断言。勿直接删除此断言(会失去对 sweep 误用的回归保护)。
    expect(sweepSpy).not.toHaveBeenCalled();
  });
});
