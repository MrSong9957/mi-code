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
      maxTurns: 5,
      enableStreamingExecution: false, // 走串行路径，覆盖传统分支
    }));

    // 核心断言：LLM 只被调用 1 次（idle 后终止，不会进第 2 轮）
    expect(client.callCount, 'idle 后应立即终止，LLLM 只调 1 次').toBe(1);

    // idle 的 tool_result 应该被 emit（让 UI 显示 ⎿ 结果）
    const toolResults = events.filter(e => (e as { type?: string }).type === 'tool_result');
    expect(toolResults.length, 'idle 的 tool_result 应被 emit').toBeGreaterThanOrEqual(1);
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
      maxTurns: 5,
      enableStreamingExecution: true,
      eventBus,
    }));

    expect(loopEndReason, '应以 reason=idle 触发 loop_end').toBe('idle');
  });
});
