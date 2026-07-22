// src/__tests__/tool-execution-context.test.ts
//
// AUTO-0025 Task 2 Step 1:验证 ToolExecutionContext 通过真实 streamingQuery 路径
// 透传到 executor,让工具能拿到自己的 toolUseId(用于子代理进度桥接)。
//
// 物理本质:工具执行时需要知道"我属于哪一次调用"(toolUseId),
// 才能把子代理的进度事件回传给正确的父 pending 消息。

import { describe, it, expect } from 'vitest';
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
import type { ToolExecutionContext } from '../agent/types.js';

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

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

describe('streamingQuery executor context (AUTO-0025 Task 2)', () => {
  it('executor 收到包含 toolUseId 的 context(流式执行路径)', async () => {
    const client = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'spawn-1', name: 'spawn_agent', input: { role: 'explore' } }],
      [{ type: 'text', text: 'done' }],
    ]);

    const received: ToolExecutionContext[] = [];
    const registry = new ToolRegistry();
    registry.register(
      { name: 'spawn_agent', description: 'd', parameters: { type: 'object' } },
      async (_input, context) => {
        if (context) received.push(context);
        return 'subagent result';
      },
    );

    const ac = new AbortController();
    await drain(streamingQuery(client, registry, 'use subagent', {
      systemPrompt: 'sys',
      tools: registry.getDefinitions(),
      signal: ac.signal,
      maxTurns: 3,
      enableStreamingExecution: true,
    }));

    expect(received).toEqual([{ toolUseId: 'spawn-1' }]);
  });

  it('executor 收到包含 toolUseId 的 context(传统串行路径)', async () => {
    const client = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'spawn-2', name: 'spawn_agent', input: { role: 'plan' } }],
      [{ type: 'text', text: 'done' }],
    ]);

    const received: ToolExecutionContext[] = [];
    const registry = new ToolRegistry();
    registry.register(
      { name: 'spawn_agent', description: 'd', parameters: { type: 'object' } },
      async (_input, context) => {
        if (context) received.push(context);
        return 'subagent result';
      },
    );

    const ac = new AbortController();
    await drain(streamingQuery(client, registry, 'use subagent', {
      systemPrompt: 'sys',
      tools: registry.getDefinitions(),
      signal: ac.signal,
      maxTurns: 3,
      enableStreamingExecution: false,
    }));

    expect(received).toEqual([{ toolUseId: 'spawn-2' }]);
  });

  it('不使用 context 的旧式 executor 仍能正常工作(向后兼容)', async () => {
    const client = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'bash-1', name: 'run_bash', input: { command: 'ls' } }],
      [{ type: 'text', text: 'done' }],
    ]);

    const registry = new ToolRegistry();
    registry.register(
      { name: 'run_bash', description: 'd', parameters: { type: 'object' } },
      async () => 'file1\nfile2',
    );

    const ac = new AbortController();
    const results = await drain(streamingQuery(client, registry, 'ls', {
      systemPrompt: 'sys',
      tools: registry.getDefinitions(),
      signal: ac.signal,
      maxTurns: 3,
      enableStreamingExecution: false,
    }));

    expect(results.length).toBeGreaterThan(0);
  });
});
