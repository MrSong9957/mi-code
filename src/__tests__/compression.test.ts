// 上下文压缩测试
import { describe, it, expect } from 'vitest';
import {
  snipCompact,
  microCompact,
  compactHistory,
  compactHistoryWithLLM,
  runCompaction,
  estimateContextSize,
  needsCompaction,
  persistLargeOutput,
} from '../agent/compression.js';
import type { Message, ContentBlock, StreamingLLMClient, StreamEvent, AssistantMessage, ToolDefinition, StreamOptions } from '../agent/types.js';

function makeMsg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: text };
}

function makeToolResult(toolUseId: string, content: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content } as ContentBlock],
  };
}

function makeToolUse(id: string, name: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input: {} } as ContentBlock],
  };
}

describe('snipCompact', () => {
  it('should not modify messages below threshold', () => {
    const messages = [makeMsg('user', 'hello')];
    expect(snipCompact(messages)).toEqual(messages);
  });

  it('should snip old messages when count exceeds 50', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 60; i++) messages.push(makeMsg('user', `msg ${i}`));

    const result = snipCompact(messages);

    expect(result.length).toBe(51); // 前3 + snip标记 + 后47
    expect(result[3]).toEqual({ role: 'user', content: '[snipped 10 messages...]' });
  });

  it('should keep first 3 messages intact', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 60; i++) messages.push(makeMsg('user', `msg ${i}`));

    const result = snipCompact(messages);
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual(messages[1]);
    expect(result[2]).toEqual(messages[2]);
  });

  it('should not split tool_use/tool_result pairs', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 55; i++) messages.push(makeMsg('user', `msg ${i}`));
    messages[10] = makeToolUse('call_1', 'bash');
    messages[11] = makeToolResult('call_1', 'output');

    const result = snipCompact(messages);
    expect(result.length).toBeLessThan(60);
  });
});

describe('microCompact', () => {
  it('should not modify when tool results <= 3', () => {
    const messages = [
      makeToolResult('r1', 'short'),
      makeToolResult('r2', 'short'),
      makeToolResult('r3', 'short'),
    ];
    expect(microCompact(messages)).toEqual(messages);
  });

  it('should compact old tool results longer than 120 chars', () => {
    const longContent = 'x'.repeat(200);
    const messages = [
      makeToolResult('r1', longContent),
      makeToolResult('r2', longContent),
      makeToolResult('r3', longContent),
      makeToolResult('r4', 'keep'),
      makeToolResult('r5', 'keep'),
      makeToolResult('r6', 'keep'),
    ];

    const result = microCompact(messages);

    const content0 = (result[0]!.content as ContentBlock[])[0]!;
    expect(content0).toHaveProperty('text', '[Earlier tool result compacted. Re-run if needed.]');
    expect(result[3]).toEqual(messages[3]);
  });

  it('should not compact short old results', () => {
    const messages = [
      makeToolResult('r1', 'short'),
      makeToolResult('r2', 'short'),
      makeToolResult('r3', 'short'),
      makeToolResult('r4', 'keep'),
      makeToolResult('r5', 'keep'),
      makeToolResult('r6', 'keep'),
    ];
    expect(microCompact(messages)).toEqual(messages);
  });
});

describe('compactHistory', () => {
  it('should return single summary message', () => {
    const messages = [
      makeMsg('user', 'Build a CLI tool'),
      makeMsg('assistant', 'I will create the files.'),
    ];

    const result = compactHistory(messages);

    expect(result.length).toBe(1);
    expect(result[0]!.role).toBe('user');
    expect(result[0]!.content).toContain('compacted for continuity');
  });
});

describe('runCompaction', () => {
  it('should apply snip and micro compact', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 60; i++) messages.push(makeMsg('user', `msg ${i}`));

    const { messages: result, needsL4 } = runCompaction(messages);

    expect(result.length).toBeLessThan(60);
    expect(typeof needsL4).toBe('boolean');
  });

  it('should not modify small message sets', () => {
    const messages = [makeMsg('user', 'hello')];
    const { messages: result, needsL4 } = runCompaction(messages);

    expect(result).toEqual(messages);
    expect(needsL4).toBe(false);
  });
});

describe('estimateContextSize', () => {
  it('should estimate string content', () => {
    expect(estimateContextSize([makeMsg('user', 'hello')])).toBe(5);
  });

  it('should estimate block content', () => {
    expect(estimateContextSize([makeToolResult('r1', 'output text')])).toBe(11);
  });
});

describe('needsCompaction', () => {
  it('should return false for small context', () => {
    expect(needsCompaction([makeMsg('user', 'hello')])).toBe(false);
  });

  it('should return true for large context', () => {
    expect(needsCompaction([makeMsg('user', 'x'.repeat(200000))])).toBe(true);
  });
});

describe('persistLargeOutput', () => {
  it('should return output unchanged if below threshold', () => {
    expect(persistLargeOutput('test', 'short')).toBe('short');
  });
});

// ═══════════════════════════════════════════════════════════════
// compactHistoryWithLLM：用小模型生成真实摘要（带本地回退）
// ═══════════════════════════════════════════════════════════════

/**
 * 假的 StreamingLLMClient。
 * 物理本质：一个会"按剧本说话"的假翻译官——
 * 你提前把要说的话（摘要文本）写在剧本里，它就照着念出来。
 */
class FakeStreamClient implements StreamingLLMClient {
  constructor(
    /** 剧本：要念的摘要文本。设为 null 表示"念到一半出错"（抛异常）。 */
    private script: string | null,
  ) {}

  async *stream(
    _messages: Message[],
    _tools: ToolDefinition[],
    _options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    if (this.script === null) {
      throw new Error('simulated API failure');
    }
    // 模拟流式：message_start → content_block_start → delta(s) → stop → message_stop
    yield { type: 'message_start', messageId: 'msg_1', model: 'mimo-v2.5', inputTokens: 10 };
    yield { type: 'content_block_start', index: 0, blockType: 'text' };
    // 把摘要切成几段，模拟逐 token 流式
    const chunks = this.script.match(/.{1,8}/g) ?? [this.script];
    for (const chunk of chunks) {
      yield { type: 'content_block_delta', index: 0, deltaType: 'text', content: chunk };
    }
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', stopReason: 'end_turn', outputTokens: chunks.length };
    yield { type: 'message_stop' };
  }
}

describe('compactHistoryWithLLM', () => {
  it('应使用小模型返回的摘要文本', async () => {
    const messages = [
      makeMsg('user', '帮我建一个 CLI'),
      makeMsg('assistant', '好的，我来创建文件。'),
    ];
    const client = new FakeStreamClient('用户想建 CLI，助手开始创建文件。');

    const result = await compactHistoryWithLLM(messages, client);

    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
    // 摘要文本应在压缩后的消息里
    expect(typeof result[0]!.content === 'string').toBe(true);
    expect(result[0]!.content as string).toContain('用户想建 CLI');
  });

  it('client 抛错时应回退到本地启发式摘要，绝不崩溃', async () => {
    const messages = [
      makeMsg('user', '做任务 A'),
      makeMsg('assistant', '正在做 A'),
    ];
    const client = new FakeStreamClient(null); // 会抛错

    const result = await compactHistoryWithLLM(messages, client);

    // 回退路径：产出含"compacted for continuity"的本地摘要消息
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
    expect(result[0]!.content).toContain('compacted for continuity');
  });

  it('压缩消息应保持连续性前缀（让下一轮 AI 知道这是历史摘要）', async () => {
    const messages = [makeMsg('user', 'hello')];
    const client = new FakeStreamClient('打招呼的对话。');

    const result = await compactHistoryWithLLM(messages, client);

    expect(result[0]!.content).toContain('compacted for continuity');
  });
});
