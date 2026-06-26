// 上下文压缩测试
import { describe, it, expect } from 'vitest';
import {
  snipCompact,
  microCompact,
  compactHistory,
  runCompaction,
  estimateContextSize,
  needsCompaction,
  persistLargeOutput,
} from '../agent/compression.js';
import type { Message, ContentBlock } from '../agent/types.js';

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
