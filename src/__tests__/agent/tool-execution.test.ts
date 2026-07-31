import { describe, expect, it } from 'vitest';
import { executeToolCall } from '../../agent/tool-execution.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import type {
  ToolDefinition,
  ToolExecutor,
  ToolUseBlock,
} from '../../agent/types.js';
import { createToolExecutionRuntime } from '../helpers/tool-execution-runtime.js';

function call(
  name: string,
  input: Record<string, unknown>,
): ToolUseBlock {
  return { type: 'tool_use', id: 'tool-use-1', name, input };
}

function register(
  definition: ToolDefinition,
  executor: ToolExecutor = async () => 'ok',
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(definition, executor);
  return registry;
}

describe('ToolRegistry.get', () => {
  it('returns the complete registered tool without replacing its executor', () => {
    const registry = new ToolRegistry();
    const definition: ToolDefinition = {
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object' },
    };
    const executor: ToolExecutor = async () => 'ok';

    registry.register(definition, executor);

    expect(registry.get('echo')).toEqual({ definition, executor });
    expect(registry.get('echo')?.executor).toBe(executor);
    expect(registry.get('missing')).toBeUndefined();
  });
});

describe('executeToolCall lookup, validation, and success', () => {
  it('returns an unknown_tool lookup failure', async () => {
    const result = await executeToolCall(
      new ToolRegistry(),
      call('missing', { value: 1 }),
      createToolExecutionRuntime(),
    );

    expect(result).toMatchObject({
      status: 'failure',
      toolUseId: 'tool-use-1',
      toolName: 'missing',
      inputUsed: { value: 1 },
      failure: {
        kind: 'unknown_tool',
        stage: 'lookup',
      },
    });
  });

  it('returns executor output for valid input', async () => {
    const registry = register(
      {
        name: 'echo',
        description: 'echo',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
      async (input) => `echo: ${input.text}`,
    );

    const result = await executeToolCall(
      registry,
      call('echo', { text: 'hello' }),
      createToolExecutionRuntime(),
    );

    expect(result).toMatchObject({
      status: 'success',
      output: 'echo: hello',
      inputUsed: { text: 'hello' },
      stageHits: {
        preExecute: false,
        postExecute: false,
        failure: false,
      },
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects a missing required property', async () => {
    const registry = register({
      name: 'echo',
      description: 'echo',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    });

    const result = await executeToolCall(
      registry,
      call('echo', {}),
      createToolExecutionRuntime(),
    );

    expect(result).toMatchObject({
      status: 'failure',
      failure: {
        kind: 'invalid_input',
        stage: 'validation',
        message: '$.text: required property missing',
      },
    });
  });

  it('reports a stable nested object path', async () => {
    const registry = register({
      name: 'profile',
      description: 'profile',
      parameters: {
        type: 'object',
        properties: {
          profile: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
        required: ['profile'],
      },
    });

    const result = await executeToolCall(
      registry,
      call('profile', { profile: { name: 42 } }),
      createToolExecutionRuntime(),
    );

    expect(result).toMatchObject({
      status: 'failure',
      failure: { message: '$.profile.name: expected string' },
    });
  });

  it('reports a stable nested array path', async () => {
    const registry = register({
      name: 'questions',
      description: 'questions',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: { header: { type: 'string' } },
              required: ['header'],
            },
          },
        },
      },
    });

    const result = await executeToolCall(
      registry,
      call('questions', { questions: [{ header: false }] }),
      createToolExecutionRuntime(),
    );

    expect(result).toMatchObject({
      status: 'failure',
      failure: { message: '$.questions[0].header: expected string' },
    });
  });

  it('does not coerce a string to a number', async () => {
    const registry = register({
      name: 'count',
      description: 'count',
      parameters: {
        type: 'object',
        properties: { count: { type: 'number' } },
      },
    });

    const result = await executeToolCall(
      registry,
      call('count', { count: '1' }),
      createToolExecutionRuntime(),
    );

    expect(result).toMatchObject({
      status: 'failure',
      failure: { message: '$.count: expected number' },
    });
  });

  it('allows extra object properties', async () => {
    const registry = register({
      name: 'echo',
      description: 'echo',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
      },
    });

    const result = await executeToolCall(
      registry,
      call('echo', { text: 'hello', extra: true }),
      createToolExecutionRuntime(),
    );

    expect(result.status).toBe('success');
  });

  it('returns a permission failure without calling the executor', async () => {
    let executorCalls = 0;
    const registry = register(
      {
        name: 'write_file',
        description: 'write',
        parameters: { type: 'object' },
      },
      async () => {
        executorCalls += 1;
        return 'written';
      },
    );

    const result = await executeToolCall(
      registry,
      call('write_file', {}),
      createToolExecutionRuntime({ mode: 'plan' }),
    );

    expect(result).toMatchObject({
      status: 'failure',
      failure: {
        kind: 'permission_denied',
        stage: 'permission',
      },
    });
    expect(executorCalls).toBe(0);
  });

  it('retains a deeply frozen snapshot of the input used', async () => {
    const input = { nested: { value: 'before' } };
    const registry = register({
      name: 'snapshot',
      description: 'snapshot',
      parameters: {
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            properties: { value: { type: 'string' } },
          },
        },
      },
    });

    const result = await executeToolCall(
      registry,
      call('snapshot', input),
      createToolExecutionRuntime(),
    );
    input.nested.value = 'after';

    expect(result.inputUsed).toEqual({ nested: { value: 'before' } });
    expect(Object.isFrozen(result.inputUsed)).toBe(true);
    expect(Object.isFrozen(result.inputUsed.nested)).toBe(true);
  });
});
