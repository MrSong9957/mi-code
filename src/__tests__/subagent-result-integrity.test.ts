// 子代理结果完整性测试
//
// 物理本质：验证"临时工交上来的报告是否真实"。
// 问题：临时工可能"没去现场看过就写报告"（explore 无工具证据却返回正文），
// 或者"干到一半被叫停"（max_turns 退出）却冒充完整结果。
// 这些测试锁定：未验证的正文被丢弃、中途退出被标记、交互工具被隔离。

import { describe, it, expect } from 'vitest';
import { runSubagent } from '../agent/subagent.js';
import { recoverSubagentWork, type SubagentJournal } from '../agent/subagent-journal.js';
import { streamingQuery } from '../agent/streaming-query.js';
import { ToolRegistry } from '../agent/tool-registry.js';
import type {
  StreamingLLMClient,
  Message,
  ToolDefinition,
  StreamEvent,
  AssistantMessage,
  StreamOptions,
  ContentBlock,
} from '../agent/types.js';
import { createToolExecutionRuntime } from './helpers/tool-execution-runtime.js';

// ════════════════════════════════════════════════════════════════════
// ScriptedStreamClient：按剧本执行的 fake LLM 客户端
// 复用 streaming-query.test.ts 的模式
// ════════════════════════════════════════════════════════════════════
type ScriptBlock = ContentBlock | { type: 'thinking'; thinking: string };

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
      const block = blocks[i] as ContentBlock | { type: 'thinking'; thinking: string };
      if (block.type === 'text') {
        yield { type: 'content_block_start', index: i, blockType: 'text' };
        yield { type: 'content_block_delta', index: i, deltaType: 'text', content: block.text };
        yield { type: 'content_block_stop', index: i };
      } else if (block.type === 'thinking') {
        yield { type: 'content_block_start', index: i, blockType: 'thinking' };
        yield { type: 'content_block_delta', index: i, deltaType: 'thinking', content: block.thinking };
        yield { type: 'content_block_stop', index: i };
      } else if (block.type === 'tool_use') {
        yield { type: 'content_block_start', index: i, blockType: 'tool_use', blockId: block.id };
        const json = JSON.stringify(block.input);
        yield { type: 'content_block_delta', index: i, deltaType: 'input_json', content: json };
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

// ════════════════════════════════════════════════════════════════════
// 测试辅助：真实注册 read_file executor 的 ToolRegistry
// ════════════════════════════════════════════════════════════════════
function makeReadRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const readDef: ToolDefinition = {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  };
  registry.register(readDef, async (input: Record<string, unknown>) => {
    const path = input.path as string;
    if (path === 'src') {
      return 'agent, tui, ui';
    }
    return `contents of ${path}`;
  });
  return registry;
}

// ════════════════════════════════════════════════════════════════════
// Task 1: explore 无工具证据时丢弃未经验证的正文
// ════════════════════════════════════════════════════════════════════
describe('subagent result integrity', () => {
  it('explore 未取得工具证据时丢弃未经验证的正文', async () => {
    const client = new ScriptedStreamClient([
      [{ type: 'text', text: 'src contains core, editor, components' }],
    ]);
    const result = await runSubagent('list real src modules', makeReadRegistry(), {
      role: 'explore',
      client,
      maxSteps: 5,
      executionRuntime: createToolExecutionRuntime(),
    });

    expect(result.status).toBe('unverified');
    expect(result.evidence).toEqual({ toolCallCount: 0, successfulToolResultCount: 0 });
    expect(result.text).toContain('no successful evidence tool result');
    expect(result.text).not.toContain('core, editor, components');
  });

  it('explore 有工具证据时返回 completed', async () => {
    const client = new ScriptedStreamClient([
      [
        { type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'src' } },
      ],
      [{ type: 'text', text: 'Verified modules: agent, tui, ui' }],
    ]);
    const result = await runSubagent('list real src modules', makeReadRegistry(), {
      role: 'explore',
      client,
      maxSteps: 5,
      executionRuntime: createToolExecutionRuntime(),
    });

    expect(result.status).toBe('completed');
    expect(result.evidence.successfulToolResultCount).toBe(1);
    expect(result.text).toBe('Verified modules: agent, tui, ui');
  });

  it('达到 maxTurns 时不把最后一句过程文本当成完整结果', async () => {
    const client = new ScriptedStreamClient([[
      { type: 'text', text: 'Now let me check the test files...' },
      { type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'src' } },
    ]]);
    const result = await runSubagent('inspect tests', makeReadRegistry(), {
      role: 'explore', client, maxSteps: 1,
      executionRuntime: createToolExecutionRuntime(),
    });

    expect(result.status).toBe('incomplete');
    expect(result.terminationReason).toBe('max_turns');
    expect(result.text).toContain('[Subagent incomplete: reached max turns');
    expect(result.text).toContain('Now let me check the test files...');
  });

  it('provider 抛普通对象时返回 incomplete/error 而不是 reject', async () => {
    const client: StreamingLLMClient = {
      // 模拟 provider 在产出任何流事件前就抛出普通对象异常。
      // eslint-disable-next-line require-yield
      async *stream() {
        throw {
          status: 503,
          code: 'upstream_unavailable',
          error: { message: 'provider temporarily unavailable' },
        };
      },
    };

    const result = await runSubagent('inspect files', makeReadRegistry(), {
      role: 'explore',
      client,
      maxSteps: 2,
      executionRuntime: createToolExecutionRuntime(),
    });

    expect(result.status).toBe('incomplete');
    expect(result.terminationReason).toBe('error');
    expect(result.isBackground).toBe(false);
    expect(result.text).toContain('"status":503');
    expect(result.text).toContain('provider temporarily unavailable');
    expect(result.text).not.toContain('[object Object]');
    expect(result.text).not.toContain('ERR_UNHANDLED_ERROR');
  });

  it('provider 在工具成功后失败时保留已积累的工具证据', async () => {
    const firstTurn = new ScriptedStreamClient([[
      { type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'src' } },
    ]]);
    let callCount = 0;
    const client: StreamingLLMClient = {
      async *stream(messages, tools, options) {
        callCount++;
        if (callCount === 2) {
          throw new Error('provider failed on second turn');
        }
        yield* firstTurn.stream(messages, tools, options);
      },
    };

    // 内存 journal:checkpoint 时克隆快照,load 时回放。
    // 用于验证 provider 失败后 runSubagent 能从 journal 恢复已完成的工作。
    let snapshot: Message[] = [];
    const journal: SubagentJournal = {
      executionId: 'child-provider-failure',
      reference: 'memory://child-provider-failure',
      checkpoint: async messages => { snapshot = structuredClone(messages) as Message[]; },
      load: async () => snapshot,
    };

    const result = await runSubagent('inspect files', makeReadRegistry(), {
      role: 'explore',
      client,
      maxSteps: 3,
      executionRuntime: createToolExecutionRuntime(),
      journal,
    });

    expect(result.status).toBe('incomplete');
    expect(result.terminationReason).toBe('error');
    expect(result.text).toContain('agent, tui, ui');
    expect(result.text).toContain('memory://child-provider-failure');
    expect(result.text).toContain('provider failed on second turn');
    expect(result.evidence.successfulToolResultCount).toBe(1);
  });

  it('final turn 未产出总结时,从 journal 恢复已完成的工作', async () => {
    // 工具成功 + 最终总结轮返回空内容 → journal 里有工具结果,但 finalTurnSynthesized=false
    const client = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'src' } }],
      // 第 2 轮(=maxSteps=2 的 final turn)返回空内容
      [],
    ]);
    let snapshot: Message[] = [];
    const journal: SubagentJournal = {
      executionId: 'child-empty-summary',
      reference: 'memory://child-empty-summary',
      checkpoint: async messages => { snapshot = structuredClone(messages) as Message[]; },
      load: async () => snapshot,
    };

    const result = await runSubagent('list skills', makeReadRegistry(), {
      role: 'explore',
      client,
      maxSteps: 2,
      executionRuntime: createToolExecutionRuntime(),
      journal,
    });

    expect(result.status).toBe('incomplete');
    expect(result.text).toContain('[Subagent incomplete: no final summary]');
    expect(result.text).toContain('agent, tui, ui');
    expect(result.text).toContain('memory://child-empty-summary');
    expect(result.text).not.toContain('(no final text)');
  });
});

// ════════════════════════════════════════════════════════════════════
// recoverSubagentWork:从结构化 child messages 确定式恢复已完成工作
//
// 物理本质:provider 崩溃后,从 journal 的 Message[] 里提取"真实发生过的工作":
// 配对的 tool_use→tool_result + assistant 分析文本,按 transcript 顺序拼接,
// 直到 12000 字符内联上限。journal 本身是无损源,内联只是给父代理看一个有界视图。
// ════════════════════════════════════════════════════════════════════
describe('recoverSubagentWork 确定式恢复', () => {
  it('按时间顺序保留所有 assistant 文本与成功的配对工具结果', () => {
    const recovered = recoverSubagentWork(
      [
        { role: 'assistant', content: [{ type: 'text', text: 'text A: inspect structure' }, { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'src/index.ts' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'file contents' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'text B: analyze TODOs' }, { type: 'tool_use', id: 'g1', name: 'run_bash', input: { command: 'grep TODO' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'g1', content: 'three TODOs' }] },
      ],
      'memory://chronological',
    );

    expect(recovered.successfulToolResults).toBe(2);
    expect(recovered.text.indexOf('text A')).toBeLessThan(recovered.text.indexOf('file contents'));
    expect(recovered.text.indexOf('file contents')).toBeLessThan(recovered.text.indexOf('text B'));
    expect(recovered.text.indexOf('text B')).toBeLessThan(recovered.text.indexOf('three TODOs'));
  });

  it('同一 assistant 消息内 tool_use 后的 text 块仍按消息顺序先于该 tool_result', () => {
    const mixed = recoverSubagentWork(
      [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'text A: preparing' },
            { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'src/index.ts' } },
            { type: 'text', text: 'text B: request prepared' },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'file contents' }] },
      ],
      'memory://mixed-blocks',
    );

    expect(mixed.successfulToolResults).toBe(1);
    expect(mixed.text.indexOf('text A')).toBeLessThan(mixed.text.indexOf('text B'));
    expect(mixed.text.indexOf('text B')).toBeLessThan(mixed.text.indexOf('file contents'));
  });

  it('没有任何成功的配对工具结果时返回空恢复', () => {
    const recovered = recoverSubagentWork(
      [
        { role: 'assistant', content: [{ type: 'text', text: 'just thinking, no tools' }] }],
      'memory://empty',
    );

    expect(recovered.successfulToolResults).toBe(0);
    expect(recovered.text).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════════
// AUTO-0025 Task 4:保留一个"无工具的最终总结轮"。
//
// 物理本质:子代理 maxTurns 耗尽前,最后一轮强制不暴露工具,让模型只能用已有
// 工具结果产出基于证据的总结,避免把"Now let me check..."这种过程句当成最终输出。
// 这一轮计入 maxTurns 边界,不通过无限增加轮次规避问题。
// ════════════════════════════════════════════════════════════════════

/** 捕获每轮传给模型的工具名列表(用于断言 final turn tools=[]) */
class ToolCapturingClient implements StreamingLLMClient {
  private callCount = 0;
  readonly toolsPerTurn: ToolDefinition[][] = [];
  constructor(private scripts: ScriptBlock[][]) {}

  async *stream(
    _messages: Message[],
    tools: ToolDefinition[],
    _options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    this.toolsPerTurn.push(tools);
    const blocks = this.scripts[this.callCount++] ?? [];
    yield { type: 'message_start', messageId: `msg_${this.callCount}`, model: 'fake', inputTokens: 1 };
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i] as ContentBlock | { type: 'thinking'; thinking: string };
      if (block.type === 'text') {
        yield { type: 'content_block_start', index: i, blockType: 'text' };
        yield { type: 'content_block_delta', index: i, deltaType: 'text', content: block.text };
        yield { type: 'content_block_stop', index: i };
      } else if (block.type === 'tool_use') {
        yield { type: 'content_block_start', index: i, blockType: 'tool_use', blockId: block.id };
        const json = JSON.stringify(block.input);
        yield { type: 'content_block_delta', index: i, deltaType: 'input_json', content: json };
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

describe('subagent final summary turn (AUTO-0025 Task 4)', () => {
  it('final turn 不暴露工具,模型产出基于证据的总结', async () => {
    // 两轮剧本:maxTurns=2 → 第 1 轮调 read_file,第 2 轮(=maxTurns)应是 final text turn
    const client = new ToolCapturingClient([
      [{ type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'src' } }],
      [{ type: 'text', text: 'Verified skills: code-review, git-workflow' }],
    ]);
    const result = await runSubagent('list skills', makeReadRegistry(), {
      role: 'explore', client, maxSteps: 2,
      executionRuntime: createToolExecutionRuntime(),
    });

    // 第 1 轮:工具列表含 read_file
    expect(client.toolsPerTurn[0]!.map(t => t.name)).toContain('read_file');
    // 第 2 轮(final):工具列表为空
    expect(client.toolsPerTurn[1]).toEqual([]);
    // 最终结果是模型第 2 轮的文本(基于工具证据)
    expect(result.text).toBe('Verified skills: code-review, git-workflow');
    expect(result.status).toBe('completed');
    expect(result.terminationReason).toBe('end_turn');
  });

  it('final turn 模型仍不输出文本时,incomplete 标记 (no final text)', async () => {
    // 第 2 轮(final)模型不产出任何文本 → 结果是 incomplete,无过程句泄漏
    const client = new ToolCapturingClient([
      [{ type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'src' } }],
      // 第 2 轮空内容(既无 text 也无 tool_use)
      [],
    ]);
    const result = await runSubagent('list skills', makeReadRegistry(), {
      role: 'explore', client, maxSteps: 2,
      executionRuntime: createToolExecutionRuntime(),
    });

    expect(result.status).toBe('incomplete');
    expect(result.terminationReason).toBe('max_turns');
    // 不含"Now let me check..."等过程句
    expect(result.text).not.toMatch(/let me check/i);
    expect(result.text).toContain('(no final text)');
  });

  it('主 agent 路径不受 reserveFinalTextTurn 影响(默认关闭)', async () => {
    // reserveFinalTextTurn 只在 runSubagentWithClient 启用,主 agent streamingQuery 不受影响。
    // 验证:不传 reserveFinalTextTurn 时,最后一轮仍暴露工具。
    const client = new ToolCapturingClient([
      [{ type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'src' } }],
      [{ type: 'text', text: 'done' }],
    ]);
    const ac = new AbortController();
    const registry = makeReadRegistry();
    // 直接调 streamingQuery,不传 reserveFinalTextTurn
    for await (const _ of streamingQuery(client, registry, 'do thing', {
      systemPrompt: 'sys', tools: registry.getDefinitions(), signal: ac.signal,
      executionRuntime: createToolExecutionRuntime(),
      maxTurns: 2, enableStreamingExecution: false,
    })) {
      void _;
    }
    // 第 2 轮工具列表仍含 read_file(主 agent 行为不变)
    expect(client.toolsPerTurn[1]!.map(t => t.name)).toContain('read_file');
  });
});

// ════════════════════════════════════════════════════════════════════
// AUTO-0025-stable Task 3:子代理内部工具活动对结果统计可见,但不进入主消息正文。
//
// 物理本质:子代理跑了 N 个工具(read_file/run_bash),这些活动保留在
// SubagentResult.evidence 里(让主 agent 知道子代理干了多少活),
// 但不再通过进度桥接写到父 pending 消息的 lines(那会导致活动区行数抖动、闪烁)。
// 父消息始终只有一行 ● spawn_agent(...),由稳定指示器渲染。
// ════════════════════════════════════════════════════════════════════

describe('subagent hidden child progress (AUTO-0025-stable Task 3)', () => {
  it('子代理跑 3 个工具,evidence 计数=3,但无 UI 进度回调泄露', async () => {
    // 3 轮工具 + 1 轮总结(maxSteps=4, final turn 是第 4 轮)
    const client = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'a' } }],
      [{ type: 'tool_use', id: 'read-2', name: 'read_file', input: { path: 'b' } }],
      [{ type: 'tool_use', id: 'read-3', name: 'read_file', input: { path: 'c' } }],
      [{ type: 'text', text: 'Verified 3 files' }],
    ]);

    const result = await runSubagent('inspect 3 files', makeReadRegistry(), {
      role: 'explore', client, maxSteps: 4,
      executionRuntime: createToolExecutionRuntime(),
    });

    // evidence 仍正确计数内部工具活动(3 个成功的 read_file)
    expect(result.evidence.toolCallCount).toBe(3);
    expect(result.evidence.successfulToolResultCount).toBe(3);
    // 最终总结基于工具结果
    expect(result.status).toBe('completed');
    expect(result.text).toBe('Verified 3 files');
  });
});
