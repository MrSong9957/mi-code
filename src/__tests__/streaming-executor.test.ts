// StreamingToolExecutor v2 测试（基于结构化事件）
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StreamingToolExecutor, isConcurrencySafe } from '../agent/streaming-executor.js';
import { ToolRegistry } from '../agent/tool-registry.js';
import type { ToolDefinition, ToolExecutor, ToolUseBlock } from '../agent/types.js';
import { createToolExecutionRuntime } from './helpers/tool-execution-runtime.js';

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
    executor = new StreamingToolExecutor(
      createTestRegistry(),
      createToolExecutionRuntime(),
      new AbortController().signal,
    );
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
    expect((results[0] as any).executionResult).toMatchObject({
      status: 'success',
      output: 'echo: hello',
    });
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

  it('serializes deferred ask_user_question calls and preserves result order', async () => {
    const registry = new ToolRegistry();
    let active = 0;
    let maxActive = 0;
    const releases = new Map<string, () => void>();
    registry.register({
      name: 'ask_user_question',
      description: 'Ask the user',
      parameters: { type: 'object', properties: { call: { type: 'string' } } },
    }, async (input) => {
      const call = input.call as string;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => { releases.set(call, resolve); });
      active -= 1;
      return call;
    });
    const serialExecutor = new StreamingToolExecutor(
      registry,
      createToolExecutionRuntime(),
      new AbortController().signal,
    );

    serialExecutor.addTool(createToolUseBlock('call-1', 'ask_user_question', { call: 'call-1' }));
    serialExecutor.addTool(createToolUseBlock('call-2', 'ask_user_question', { call: 'call-2' }));

    await vi.waitFor(() => expect(active).toBe(1));
    expect(releases.has('call-2')).toBe(false);
    releases.get('call-1')!();
    await vi.waitFor(() => expect(releases.has('call-2')).toBe(true));
    releases.get('call-2')!();

    const results = [];
    for await (const batch of serialExecutor.getRemainingResults()) results.push(...batch);
    expect(maxActive).toBe(1);
    expect(results.map((tool) => tool.id)).toEqual(['call-1', 'call-2']);
  });

  it('stores a structured permission failure and keeps string output', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'write_file',
      description: 'write',
      parameters: { type: 'object' },
    }, async () => 'should not run');
    const deniedExecutor = new StreamingToolExecutor(
      registry,
      createToolExecutionRuntime({ mode: 'build' }),
      new AbortController().signal,
    );

    deniedExecutor.addTool(createToolUseBlock(
      'call-denied',
      'write_file',
      { path: 'inside.txt' },
    ));
    const results = [];
    for await (const batch of deniedExecutor.getRemainingResults()) {
      results.push(...batch);
    }

    expect(results[0]?.executionResult).toMatchObject({
      status: 'failure',
      failure: { kind: 'permission_denied', stage: 'permission' },
    });
    expect(results[0]?.results?.[0]).toEqual({
      type: 'text',
      text: results[0]?.executionResult?.output,
    });
  });

  it('passes the configured signal into ToolExecutionContext', async () => {
    const registry = new ToolRegistry();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    registry.register({
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object' },
    }, async (_input, context) => {
      observedSignal = context?.signal;
      return 'ok';
    });
    const signalExecutor = new StreamingToolExecutor(
      registry,
      createToolExecutionRuntime(),
      controller.signal,
    );

    signalExecutor.addTool(createToolUseBlock('call-signal', 'echo', {}));
    for await (const _ of signalExecutor.getRemainingResults()) void _;

    expect(observedSignal).toBe(controller.signal);
  });

  it('bubbles an unclassified executor error through result consumption', async () => {
    const error = new TypeError('executor bug');
    const registry = new ToolRegistry();
    registry.register({
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object' },
    }, async () => {
      throw error;
    });
    const failingExecutor = new StreamingToolExecutor(
      registry,
      createToolExecutionRuntime(),
      new AbortController().signal,
    );
    failingExecutor.addTool(createToolUseBlock('call-error', 'echo', {}));

    const consume = async () => {
      for await (const _ of failingExecutor.getRemainingResults()) void _;
    };
    await expect(consume()).rejects.toBe(error);
  });
});
