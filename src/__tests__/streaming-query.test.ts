// streamingQuery 的 L4 压缩接入测试
//
// 物理本质：验证"办公桌满了会自动请临时秘书(小模型)整理"。
// 主模型是日常办公的员工，小模型是被叫来帮忙整理桌子的秘书。
// 这个测试验证：桌子堆满(>100KB)时，秘书真的被叫来了，而不是只在墙上贴张告示。
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

/**
 * 录制式流式 fake client。
 * 物理本质：一个"按剧本念台词"的演员——你给它一沓台词卡(每张是一轮要念的内容)，
 * 它一张张念出来。念的台词会原样变成 AssistantMessage 事件。
 */
class ScriptedStreamClient implements StreamingLLMClient {
  private callCount = 0;
  constructor(private scripts: ContentBlock[][]) {}

  async *stream(
    _messages: Message[],
    _tools: ToolDefinition[],
    _options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    const blocks = this.scripts[this.callCount++] ?? [];
    yield { type: 'message_start', messageId: `msg_${this.callCount}`, model: 'fake', inputTokens: 1 };
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      if (block.type === 'text') {
        yield { type: 'content_block_start', index: i, blockType: 'text' };
        yield { type: 'content_block_delta', index: i, deltaType: 'text', content: block.text };
        yield { type: 'content_block_stop', index: i };
      } else if (block.type === 'tool_use') {
        yield { type: 'content_block_start', index: i, blockType: 'tool_use', blockId: block.id };
        // tool_use 的 input 以 JSON 流式发送
        const json = JSON.stringify(block.input);
        yield { type: 'content_block_delta', index: i, deltaType: 'input_json', content: json };
        yield { type: 'content_block_stop', index: i };
      }
    }
    yield { type: 'message_delta', stopReason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', outputTokens: blocks.length };
    yield { type: 'message_stop' };

    // 发出完整 AssistantMessage（QueryEngine 依赖它产出 NormalizedMessage）
    yield {
      type: 'assistant',
      content: blocks,
      usage: { input_tokens: 1, output_tokens: blocks.length },
      stopReason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      uuid: `asst_${this.callCount}`,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * 间谍式 client：记录是否被 stream 调用过。
 * 用来验证 compactClient（小模型）在 needsL4 时被触发。
 */
class SpyStreamClient implements StreamingLLMClient {
  streamCalled = false;
  async *stream(
    _messages: Message[],
    _tools: ToolDefinition[],
    _options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    this.streamCalled = true;
    yield { type: 'message_start', messageId: 'compact_1', model: 'small', inputTokens: 1 };
    yield { type: 'content_block_start', index: 0, blockType: 'text' };
    yield { type: 'content_block_delta', index: 0, deltaType: 'text', content: 'Compacted summary.' };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', stopReason: 'end_turn', outputTokens: 1 };
    yield { type: 'message_stop' };
    yield {
      type: 'assistant',
      content: [{ type: 'text', text: 'Compacted summary.' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stopReason: 'end_turn',
      uuid: 'compact_asst',
      timestamp: new Date().toISOString(),
    };
  }
}

/** 构造一个注册了"返回超大结果"工具的 registry，用来撑爆上下文触发 needsL4 */
function makeRegistryWithBigTool(): ToolRegistry {
  const registry = new ToolRegistry();
  const bigDef: ToolDefinition = {
    name: 'big_output',
    description: 'Returns a huge string to bloat context',
    parameters: { type: 'object', properties: {} },
  };
  // 200KB 的工具结果，足以让 estimateContextSize 超过 100000 阈值
  const bigExec = async () => 'x'.repeat(200_000);
  registry.register(bigDef, bigExec);
  return registry;
}

/** 收集 generator 的所有产出 */
async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

describe('streamingQuery L4 压缩接入', () => {
  it('提供 compactClient 时，上下文爆满应触发小模型压缩', async () => {
    // 主模型剧本：第一轮调用 big_output 工具，第二轮返回纯文本结束
    const mainClient = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'call_1', name: 'big_output', input: {} }],
      [{ type: 'text', text: 'Done.' }],
    ]);
    const compactClient = new SpyStreamClient();
    const registry = makeRegistryWithBigTool();

    const ac = new AbortController();
    await drain(streamingQuery(mainClient, registry, 'do big thing', {
      systemPrompt: 'sys',
      tools: registry.getDefinitions(),
      signal: ac.signal,
      maxTurns: 5,
      enableStreamingExecution: false, // 走串行执行路径，更可控
      compactClient,
    }));

    // 核心断言：小模型被叫来整理了
    expect(compactClient.streamCalled).toBe(true);
  });

  it('未提供 compactClient 时，上下文爆满不崩溃（保持旧行为：仅警告）', async () => {
    const mainClient = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'call_1', name: 'big_output', input: {} }],
      [{ type: 'text', text: 'Done.' }],
    ]);
    const registry = makeRegistryWithBigTool();
    const ac = new AbortController();

    // 不传 compactClient → 应优雅降级，不抛错
    const results = await drain(streamingQuery(mainClient, registry, 'do big thing', {
      systemPrompt: 'sys',
      tools: registry.getDefinitions(),
      signal: ac.signal,
      maxTurns: 5,
      enableStreamingExecution: false,
    }));

    // 能正常产出消息流，没崩
    expect(results.length).toBeGreaterThan(0);
  });
});
