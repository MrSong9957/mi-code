// idle 工具调用后循环应立即终止（Bug 2 修复验证）
//
// 物理本质：员工举手说"我没事干了"（调 idle），主管应该让他下班（终止循环），
// 而不是把他刚才的工作总结（assistant 文本）又让他原样念一遍。
//
// 旧 bug：idle 只返回字面量 'IDLE_REQUESTED'，主循环不识别这个信号，
// 把它当普通 tool_result 写回 messages，下一轮 LLM 收到无意义反馈，
// 重新生成了一遍刚才的回复——表现为"一条消息回复了两次相同内容"。
//
// 修复：streamingQuery / agentLoop 在阶段 3 检测到 idle 工具调用后，
// 立即 emitLoopEnd({reason:'idle'}) 并 return，不进入阶段 4。
import { describe, it, expect } from 'vitest';
import { streamingQuery } from '../agent/streaming-query.js';
import { ToolRegistry } from '../agent/tool-registry.js';
import { createIdleTool } from '../agent/tools/idle-tool.js';
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
import { StreamEventBus } from '../agent/stream-event-bus.js';
import { finalizeTurnForUser } from '../agent/turn-final-feedback.js';
import { createTranslator } from '../locale/translator.js';
import { createLanguageStore } from '../locale/language-store.js';

type ScriptBlock = ContentBlock | { type: 'thinking'; thinking: string };

/** 按剧本念台词的 fake client，记录被调用次数 */
class ScriptedStreamClient implements StreamingLLMClient {
  callCount = 0;
  constructor(private scripts: ScriptBlock[][]) {}

  async *stream(
    _messages: Message[],
    _tools: ToolDefinition[],
    _options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    const callIdx = this.callCount++;
    const blocks = this.scripts[callIdx] ?? [];
    yield { type: 'message_start', messageId: `msg_${callIdx + 1}`, model: 'fake', inputTokens: 1 };
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
    yield {
      type: 'message_delta',
      stopReason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      outputTokens: blocks.length,
    };
    yield { type: 'message_stop' };

    const contentBlocks = blocks.filter((b): b is ContentBlock => b.type !== 'thinking');
    yield {
      type: 'assistant',
      content: contentBlocks,
      usage: { input_tokens: 1, output_tokens: blocks.length },
      stopReason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      uuid: `asst_${callIdx + 1}`,
      timestamp: new Date().toISOString(),
    };
  }
}

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

/** 构造含 idle 工具的 registry */
function makeRegistryWithIdle(): ToolRegistry {
  const registry = new ToolRegistry();
  const idle = createIdleTool();
  registry.register(idle.definition, idle.executor);
  return registry;
}

describe('streamingQuery idle 跳出（Bug 2）', () => {
  it('调 idle 后循环立即终止：LLM 只被调用 1 次（不会再次生成回复）', async () => {
    // 剧本：第 1 轮返回文本 + idle 工具调用
    // 如果 bug 没修，循环会把 IDLE_REQUESTED 写回 messages 触发第 2 轮 LLM 调用
    // 修复后：检测到 idle 立即 return，LLM 只被调 1 次
    const client = new ScriptedStreamClient([
      [
        { type: 'text', text: '分析完成，没有更多工作了。' },
        { type: 'tool_use', id: 'idle_call_1', name: 'idle', input: {} },
      ],
      // 这个第 2 轮剧本只在 bug 存在时才会被念到（重复回复）
      [{ type: 'text', text: '分析完成，没有更多工作了。' }],
    ]);
    const registry = makeRegistryWithIdle();
    const ac = new AbortController();

    const events = await drain(streamingQuery(client, registry, '探索项目', {
      systemPrompt: 'sys',
      tools: registry.getDefinitions(),
      signal: ac.signal,
      executionRuntime: createToolExecutionRuntime(),
      maxTurns: 5,
      enableStreamingExecution: false, // 走串行路径，覆盖传统分支
    }));

    // 核心断言：LLM 只被调用 1 次（idle 后终止，不会进第 2 轮）
    expect(client.callCount, 'idle 后应立即终止，LLLM 只调 1 次').toBe(1);

    // idle 是内部控制信号,不作为普通 tool_result yield(否则 UI 显示 ● Ran 1 operation / ⎿ IDLE_REQUESTED)
    const toolResults = events.filter(e => (e as { type?: string }).type === 'tool_result');
    expect(toolResults.length, 'idle 的 tool_result 不应被 yield').toBe(0);
  });

  it('idle 后 loop_end 事件以 reason=idle 触发', async () => {
    const client = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'idle_call_1', name: 'idle', input: {} }],
    ]);
    const registry = makeRegistryWithIdle();
    const ac = new AbortController();

    let loopEndReason: string | undefined;
    const { StreamEventBus } = await import('../agent/stream-event-bus.js');
    const eventBus = new StreamEventBus();
    eventBus.onLoopEnd(d => {
      loopEndReason = d.reason;
    });

    await drain(streamingQuery(client, registry, '探索项目', {
      systemPrompt: 'sys',
      tools: registry.getDefinitions(),
      signal: ac.signal,
      executionRuntime: createToolExecutionRuntime(),
      maxTurns: 5,
      enableStreamingExecution: true,
      eventBus,
    }));

    expect(loopEndReason, '应以 reason=idle 触发 loop_end').toBe('idle');
  });
});

describe('idle turn finalization 契约(idle 是控制信号,非普通 tool result)', () => {
  const zhT = createTranslator(createLanguageStore('zh-CN'));

  /** 跑一轮含 idle 的 turn,捕获 emit/yield/messages */
  async function runIdleTurn(opts: { streaming: boolean; blocks: ScriptBlock[] }) {
    const client = new ScriptedStreamClient([opts.blocks]);
    const registry = makeRegistryWithIdle();
    const eventBus = new StreamEventBus();
    const emitted: { name: string; output: string }[] = [];
    const emittedCalls: { name: string }[] = [];
    eventBus.onToolResult(d => emitted.push({ name: d.name, output: d.output }));
    eventBus.onToolCall(d => emittedCalls.push({ name: d.name }));
    let finalMessages: Message[] | undefined;
    const events = await drain(streamingQuery(client, registry, '探索', {
      systemPrompt: 'sys',
      tools: registry.getDefinitions(),
      signal: new AbortController().signal,
      executionRuntime: createToolExecutionRuntime(),
      maxTurns: 5,
      enableStreamingExecution: opts.streaming,
      eventBus,
      onMessages: m => { finalMessages = m; },
    }));
    return { events, emitted, emittedCalls, finalMessages };
  }

  it('serial 路径:idle 不 emitToolResult、不 yield tool_result', async () => {
    const { events, emitted } = await runIdleTurn({
      streaming: false,
      blocks: [
        { type: 'text', text: '项目全景已保存至记忆。' },
        { type: 'tool_use', id: 'idle_s', name: 'idle', input: {} },
      ],
    });
    // 不 emit 给 UI(否则渲染 ● Ran 1 operation / ⎿ IDLE_REQUESTED)
    expect(emitted.some(e => e.name === 'idle'), 'idle 不应 emitToolResult').toBe(false);
    expect(emitted.some(e => e.output === 'IDLE_REQUESTED'), 'IDLE_REQUESTED 不应 emit').toBe(false);
    // 不 yield 给 consumer(否则进 toolFacts)
    const yields = events.filter(e => (e as { type?: string }).type === 'tool_result');
    expect(yields, 'idle 的 tool_result 不应被 yield').toHaveLength(0);
  });

  it('streaming 路径:idle 不 emitToolResult、不 yield tool_result', async () => {
    const { events, emitted } = await runIdleTurn({
      streaming: true,
      blocks: [
        { type: 'text', text: 'done.' },
        { type: 'tool_use', id: 'idle_t', name: 'idle', input: {} },
      ],
    });
    expect(emitted.some(e => e.name === 'idle'), 'streaming 路径 idle 也不应 emit').toBe(false);
    const yields = events.filter(e => (e as { type?: string }).type === 'tool_result');
    expect(yields).toHaveLength(0);
  });

  it('streaming 路径:idle 不 emitToolCall(不创建 pending tool 生命周期 / 不泄漏 activeToolIds)', async () => {
    const { emittedCalls } = await runIdleTurn({
      streaming: true,
      blocks: [
        { type: 'text', text: '收尾。' },
        { type: 'tool_use', id: 'idle_call', name: 'idle', input: {} },
      ],
    });
    // idle 是控制信号:连 tool_call 都不应 emit,否则 block-pipeline 会创建
    // 永不 resolve 的 PendingTool,且 activeToolIds.add 后无对应 delete → 泄漏。
    expect(emittedCalls.some(c => c.name === 'idle'), 'idle 不应 emitToolCall').toBe(false);
  });

  it('idle 轮 assistant 正文保留进 messages,不留 IDLE_REQUESTED / idle tool_use', async () => {
    const { finalMessages } = await runIdleTurn({
      streaming: false,
      blocks: [
        { type: 'text', text: '项目全景已保存至记忆 project-overview。' },
        { type: 'tool_use', id: 'idle_m', name: 'idle', input: {} },
      ],
    });
    expect(finalMessages, 'onMessages 应被调用').toBeDefined();
    const dump = JSON.stringify(finalMessages);
    // assistant 正文保留(classifyTurn 需要看到 terminal text)
    expect(dump, 'idle 轮正文应保留进 messages').toContain('项目全景已保存至记忆 project-overview');
    // IDLE_REQUESTED 不残留(避免下一轮 LLM 收到无意义反馈循环)
    expect(dump, 'IDLE_REQUESTED 不应残留进 messages').not.toContain('IDLE_REQUESTED');
    // 不留 idle tool_use(避免未配对 tool_use 触发下一轮 API 错误)
    expect(dump, '不应残留未配对的 idle tool_use').not.toContain('"name":"idle"');
  });

  it('idle-only turn(有正文)最终分类 → 成功,candidate=null(不 Partial/Failed)', async () => {
    const { events, finalMessages } = await runIdleTurn({
      streaming: false,
      blocks: [
        { type: 'text', text: '项目全景已保存至记忆 project-overview。' },
        { type: 'tool_use', id: 'idle_c', name: 'idle', input: {} },
      ],
    });
    // 镜像 index.ts:从 yield 收集 toolFacts(idle 被抑制 → 不在 toolFacts)
    const toolFacts = events
      .filter(e => (e as { type?: string }).type === 'tool_result')
      .map(y => {
        const r = y as { name: string; output: string; executionResult?: { status?: string } };
        return { name: r.name, output: r.output, executionStatus: (r.executionResult?.status ?? 'success') as 'success' | 'failure' };
      });
    const result = finalizeTurnForUser({
      messages: finalMessages ?? [],
      turnStartIndex: 0,
      toolFacts,
      aborted: false,
    }, zhT);
    expect(result.status, 'idle-only 有正文 → 成功,不得 Partial/Failed').toBe('成功');
    expect(result.candidate, '成功路径无兜底行').toBeNull();
  });

  it('普通工具不受影响:仍 emit + yield + 进 messages', async () => {
    const client = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'echo1', name: 'echo', input: { text: 'hi' } }],
    ]);
    const registry = makeRegistryWithIdle();
    registry.register(
      { name: 'echo', description: 'test echo', parameters: { type: 'object', properties: {}, required: [] } },
      async (input) => String((input as { text?: string }).text ?? 'echoed'),
    );
    const eventBus = new StreamEventBus();
    const emitted: { name: string }[] = [];
    eventBus.onToolResult(d => emitted.push({ name: d.name }));
    let finalMessages: Message[] | undefined;
    const events = await drain(streamingQuery(client, registry, 'echo hi', {
      systemPrompt: 'sys',
      tools: registry.getDefinitions(),
      signal: new AbortController().signal,
      executionRuntime: createToolExecutionRuntime(),
      maxTurns: 5,
      enableStreamingExecution: false,
      eventBus,
      onMessages: m => { finalMessages = m; },
    }));
    // echo 正常 emit + yield(过滤 idle 不能误伤普通工具)
    expect(emitted.some(e => e.name === 'echo'), 'echo 应正常 emitToolResult').toBe(true);
    const yields = events.filter(e => (e as { type?: string }).type === 'tool_result');
    expect(yields.some(y => (y as { name?: string }).name === 'echo'), 'echo 应正常 yield').toBe(true);
    expect(JSON.stringify(finalMessages), 'echo result 应进 messages').toContain('hi');
  });
});
