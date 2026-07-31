/**
 * Wave C Task 9 (M-031): No-Tool Contract 与 streamingQuery 的集成测试.
 *
 * 验证四重 enforcement 在真实 streamingQuery 流程中生效:
 *   - provider gate: 发给 provider 的 tools 是 []
 *   - runtime gate: Provider 返回 tool call 时产生 protocol rejection, 不执行
 *   - executor 调用次数为 0
 *
 * 这是对 no-tool-contract.test.ts (单元) 的集成补充。
 */

import { describe, it, expect } from 'vitest';
import { streamingQuery } from '../../agent/streaming-query.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { createNoToolRequestContract } from '../../agent/tools/no-tool-contract.js';
import type {
  StreamingLLMClient,
  Message,
  ToolDefinition,
  StreamEvent,
  AssistantMessage,
  StreamOptions,
  ContentBlock,
} from '../../agent/types.js';
import { createToolExecutionRuntime } from '../helpers/tool-execution-runtime.js';

/**
 * 间谍式 client: 记录每次 stream 调用时传入的 tools 数组, 并按脚本返回内容。
 */
class ToolSpyStreamClient implements StreamingLLMClient {
  public calls: { tools: ToolDefinition[] }[] = [];
  constructor(private scripts: ContentBlock[][]) {}

  async *stream(
    _messages: Message[],
    tools: ToolDefinition[],
    _options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    const callIndex = this.calls.length;
    this.calls.push({ tools: [...tools] });
    const blocks = this.scripts[callIndex] ?? [];

    yield { type: 'message_start', messageId: `msg_${callIndex + 1}`, model: 'fake', inputTokens: 1 };
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
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
    const hasToolUse = blocks.some((b) => b.type === 'tool_use');
    yield {
      type: 'message_delta',
      stopReason: hasToolUse ? 'tool_use' : 'end_turn',
      outputTokens: blocks.length,
    };
    yield { type: 'message_stop' };
    yield {
      type: 'assistant',
      content: blocks,
      usage: { input_tokens: 1, output_tokens: blocks.length },
      stopReason: hasToolUse ? 'tool_use' : 'end_turn',
      uuid: `asst_${callIndex + 1}`,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * 可执行工具的假 registry: execute 被调用时计数 (用于验证 no-tool 模式下调用次数为 0)。
 */
function makeCountingRegistry(): { registry: ToolRegistry; executeCount: () => number } {
  let count = 0;
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'read_file',
      description: 'read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
    async () => {
      count++;
      return 'file content';
    },
  );
  return { registry, executeCount: () => count };
}

describe('No-Tool Contract streamingQuery integration', () => {
  it('provider gate: sends empty tools array when noToolContract is active', async () => {
    const client = new ToolSpyStreamClient([
      [{ type: 'text', text: 'summary without tools' }],
    ]);
    const { registry, executeCount } = makeCountingRegistry();
    const contract = createNoToolRequestContract({
      task_profile_snapshot_id: 'profile-1',
      tool_view_snapshot_id: 'tv-empty-1',
    });

    for await (const _msg of streamingQuery(client, registry, 'summarize this', {
      systemPrompt: 'you are a summarizer',
      tools: [
        {
          name: 'read_file',
          description: 'read',
          parameters: { type: 'object', properties: {} },
        },
      ],
      signal: new AbortController().signal,
      executionRuntime: createToolExecutionRuntime(),
      noToolContract: contract,
    })) {
      // drain
    }

    // provider gate: 每次 stream 调用 tools 必须是 []
    expect(client.calls.length).toBe(1);
    expect(client.calls[0].tools).toEqual([]);
    // executor 未被调用
    expect(executeCount()).toBe(0);
  });

  it('runtime gate: rejects tool call with protocol rejection, executor count stays 0', async () => {
    // 第一轮 provider 违规调用工具 → 应产生 rejection, 不执行
    // 第二轮 provider 看到 rejection 后改用文本
    const client = new ToolSpyStreamClient([
      [
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'read_file',
          input: { path: '/etc/passwd' },
        },
      ],
      [{ type: 'text', text: 'ok I will not use tools' }],
    ]);
    const { registry, executeCount } = makeCountingRegistry();
    const contract = createNoToolRequestContract({
      task_profile_snapshot_id: 'profile-1',
      tool_view_snapshot_id: 'tv-empty-1',
    });

    const outputs: string[] = [];
    for await (const msg of streamingQuery(client, registry, 'summarize', {
      systemPrompt: 'summarizer',
      tools: [
        {
          name: 'read_file',
          description: 'read',
          parameters: { type: 'object', properties: {} },
        },
      ],
      signal: new AbortController().signal,
      executionRuntime: createToolExecutionRuntime(),
      noToolContract: contract,
    })) {
      // StreamMessage union 里 tool_result 类型有 output 字段
      if (
        typeof msg === 'object' &&
        msg !== null &&
        'type' in msg &&
        msg.type === 'tool_result' &&
        'output' in msg
      ) {
        outputs.push(msg.output as string);
      }
    }

    // runtime gate: tool call 被拒绝, 产生 protocol rejection
    expect(outputs.some((o) => o.includes('Protocol Rejection'))).toBe(true);
    expect(outputs.some((o) => o.includes('No-Tool Contract'))).toBe(true);
    // executor 调用次数为 0 (关键 INV-C9)
    expect(executeCount()).toBe(0);
    // 两轮都收到 tools=[] (provider gate 在每轮都生效)
    expect(client.calls.length).toBe(2);
    expect(client.calls[0].tools).toEqual([]);
    expect(client.calls[1].tools).toEqual([]);
  });

  it('LEGACY: when noToolContract is absent, tools are passed through normally', async () => {
    const client = new ToolSpyStreamClient([
      [{ type: 'text', text: 'no contract, tools available' }],
    ]);
    const { registry } = makeCountingRegistry();

    for await (const _msg of streamingQuery(client, registry, 'hi', {
      systemPrompt: 'assistant',
      tools: [
        {
          name: 'read_file',
          description: 'read',
          parameters: { type: 'object', properties: {} },
        },
      ],
      signal: new AbortController().signal,
      executionRuntime: createToolExecutionRuntime(),
      // 不传 noToolContract → LEGACY 行为
    })) {
      // drain
    }

    // LEGACY: tools 原样传给 provider (不强制 [])
    expect(client.calls.length).toBe(1);
    expect(client.calls[0].tools.length).toBe(1);
    expect(client.calls[0].tools[0].name).toBe('read_file');
  });
});
