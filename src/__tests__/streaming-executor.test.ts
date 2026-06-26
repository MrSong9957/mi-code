// StreamingToolExecutor 测试
import { describe, it, expect, beforeEach } from 'vitest';
import { StreamingToolExecutor } from '../agent/streaming-executor.js';
import { ToolRegistry } from '../agent/tool-registry.js';
import type { ToolDefinition, ToolExecutor } from '../agent/types.js';

function createTestRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const echoDef: ToolDefinition = {
    name: 'echo',
    description: 'Echo input',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
  };
  const echoExec: ToolExecutor = async (input) => `echo: ${input.text}`;
  registry.register(echoDef, echoExec);
  return registry;
}

describe('StreamingToolExecutor', () => {
  let executor: StreamingToolExecutor;

  beforeEach(() => {
    executor = new StreamingToolExecutor(createTestRegistry());
  });

  it('should initialize with empty state', () => {
    expect(executor.getResults()).toEqual([]);
    expect(executor.hasExecuting()).toBe(false);
  });

  it('should detect and execute tool_use block', async () => {
    const json = JSON.stringify({ id: 'call_1', name: 'echo', input: { text: 'hello' } });
    executor.processChunk(json);

    const results = await executor.awaitAll();
    expect(results.length).toBe(1);
    expect(results[0]!.output).toBe('echo: hello');
  });

  it('should handle multiple tool calls', async () => {
    const json1 = JSON.stringify({ id: 'call_1', name: 'echo', input: { text: 'a' } });
    const json2 = JSON.stringify({ id: 'call_2', name: 'echo', input: { text: 'b' } });

    executor.processChunk(json1);
    executor.processChunk(json2);

    const results = await executor.awaitAll();
    expect(results.length).toBe(2);
  });

  it('should reset state', () => {
    executor.processChunk(JSON.stringify({ id: 'call_1', name: 'echo', input: { text: 'x' } }));
    executor.reset();

    expect(executor.getResults()).toEqual([]);
    expect(executor.hasExecuting()).toBe(false);
  });

  it('should handle invalid JSON gracefully', () => {
    executor.processChunk('not json at all');
    expect(executor.getResults()).toEqual([]);
  });
});
