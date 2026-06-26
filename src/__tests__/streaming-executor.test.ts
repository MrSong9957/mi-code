// StreamingToolExecutor v2 测试（基于结构化事件）
import { describe, it, expect, beforeEach } from 'vitest';
import { StreamingToolExecutor, isConcurrencySafe } from '../agent/streaming-executor.js';
import { ToolRegistry } from '../agent/tool-registry.js';
import type { ToolDefinition, ToolExecutor, ToolUseBlock } from '../agent/types.js';

function createTestRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const echoDef: ToolDefinition = {
    name: 'echo',
    description: 'Echo input',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
  };
  const echoExec: ToolExecutor = async (input) => `echo: ${input.text}`;
  registry.register(echoDef, echoExec);

  const readFileDef: ToolDefinition = {
    name: 'read_file',
    description: 'Read file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  };
  const readFileExec: ToolExecutor = async (input) => `file content: ${input.path}`;
  registry.register(readFileDef, readFileExec);

  return registry;
}

function createToolUseBlock(id: string, name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

describe('StreamingToolExecutor v2', () => {
  let executor: StreamingToolExecutor;

  beforeEach(() => {
    executor = new StreamingToolExecutor(createTestRegistry());
  });

  it('should initialize with empty state', () => {
    expect(executor.getResults()).toEqual([]);
    expect(executor.hasExecuting()).toBe(false);
    expect(executor.hasQueued()).toBe(false);
  });

  it('should execute a single tool via addTool', async () => {
    const block = createToolUseBlock('call_1', 'echo', { text: 'hello' });
    executor.addTool(block);

    const results: unknown[] = [];
    for await (const batch of executor.getRemainingResults()) {
      results.push(...batch);
    }

    expect(results.length).toBe(1);
    expect((results[0] as any).results[0].text).toBe('echo: hello');
  });

  it('should execute multiple tools in order', async () => {
    const block1 = createToolUseBlock('call_1', 'echo', { text: 'a' });
    const block2 = createToolUseBlock('call_2', 'echo', { text: 'b' });
    executor.addTool(block1);
    executor.addTool(block2);

    const results: unknown[] = [];
    for await (const batch of executor.getRemainingResults()) {
      results.push(...batch);
    }

    expect(results.length).toBe(2);
    // 顺序与添加顺序一致
    expect((results[0] as any).id).toBe('call_1');
    expect((results[1] as any).id).toBe('call_2');
  });

  it('should reset state', () => {
    executor.addTool(createToolUseBlock('call_1', 'echo', { text: 'x' }));
    executor.reset();

    expect(executor.getResults()).toEqual([]);
    expect(executor.hasExecuting()).toBe(false);
    expect(executor.hasQueued()).toBe(false);
  });

  it('should discard queued tools', () => {
    // addTool 会立即执行（因为没有并发冲突），所以 discard 后结果为空
    // 但如果先 discard，后续 addTool 应被忽略
    executor.discard();
    executor.addTool(createToolUseBlock('call_1', 'echo', { text: 'a' }));

    // discard 后 addTool 被忽略
    expect(executor.getResults()).toEqual([]);
    expect(executor.hasQueued()).toBe(false);
  });

  it('should identify concurrency-safe tools', () => {
    expect(isConcurrencySafe('read_file')).toBe(true);
    expect(isConcurrencySafe('glob')).toBe(true);
    expect(isConcurrencySafe('grep')).toBe(true);
    expect(isConcurrencySafe('echo')).toBe(false);
    expect(isConcurrencySafe('write_file')).toBe(false);
  });
});
