import { describe, expect, it, vi } from 'vitest';
import {
  executeToolCall,
  PreCallbackInputViolation,
  ToolOperationalError,
  type ToolExecutionCallbacks,
  type ToolExecutionResult,
  type ToolPreExecuteResult,
} from '../../agent/tool-execution.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import type {
  ToolDefinition,
  ToolExecutor,
  ToolUseBlock,
} from '../../agent/types.js';
import { createToolExecutionRuntime } from '../helpers/tool-execution-runtime.js';
import type { PermissionRule } from '../../permission/types.js';

/**
 * 本文件所有 stub 工具的 allow 规则。
 * 这些测试验证的是 executeToolCall 管线（校验/错误分类/回调），不是权限行为；
 * A15 后 auto 模式对未决工具返回 ask 会阻塞执行，故显式 allow 这些 stub 工具，
 * 把权限隔离为被控依赖。只 allow 本文件实际用到的工具，不扩大范围。
 */
const STUB_ALLOW_RULES: PermissionRule[] = [
  'echo',
  'profile',
  'questions',
  'count',
  'bounded-number',
  'snapshot',
  'write_file',
  'Error',
  'NonErrorThrown',
].map((tool) => ({ tool, behavior: 'allow' as const }));

/**
 * 本文件专用 runtime 工厂：默认带入 STUB_ALLOW_RULES，允许透传 mode/callbacks。
 * 保持与 createToolExecutionRuntime 相同的 options 形状，只是预填 rules。
 */
function stubRuntime(
  options: Omit<Parameters<typeof createToolExecutionRuntime>[0], 'rules'> = {},
) {
  return createToolExecutionRuntime({ rules: STUB_ALLOW_RULES, ...options });
}

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

const echoDefinition: ToolDefinition = {
  name: 'echo',
  description: 'echo',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      nested: {
        type: 'object',
        properties: { value: { type: 'string' } },
      },
    },
    required: ['text'],
  },
};

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
      stubRuntime(),
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
      stubRuntime(),
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
      stubRuntime(),
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
      stubRuntime(),
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
      stubRuntime(),
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
      stubRuntime(),
    );

    expect(result).toMatchObject({
      status: 'failure',
      failure: { message: '$.count: expected number' },
    });
  });

  it.each([
    { value: 0, message: '$.timeout_ms: expected number >= 1' },
    { value: 600_001, message: '$.timeout_ms: expected number <= 600000' },
  ])('rejects $value outside inclusive number bounds', async ({ value, message }) => {
    const registry = register({
      name: 'bounded-number',
      description: 'bounded number',
      parameters: {
        type: 'object',
        properties: {
          timeout_ms: {
            type: 'number',
            minimum: 1,
            maximum: 600_000,
          },
        },
        required: ['timeout_ms'],
      },
    });

    const result = await executeToolCall(
      registry,
      call('bounded-number', { timeout_ms: value }),
      stubRuntime(),
    );

    expect(result).toMatchObject({
      status: 'failure',
      failure: {
        kind: 'invalid_input',
        stage: 'validation',
        message,
      },
    });
  });

  it.each([1, 1.5, 600_000])(
    'accepts %s inside inclusive number bounds',
    async (value) => {
      const registry = register({
        name: 'bounded-number',
        description: 'bounded number',
        parameters: {
          type: 'object',
          properties: {
            timeout_ms: {
              type: 'number',
              minimum: 1,
              maximum: 600_000,
            },
          },
          required: ['timeout_ms'],
        },
      });

      const result = await executeToolCall(
        registry,
        call('bounded-number', { timeout_ms: value }),
        stubRuntime(),
      );

      expect(result.status).toBe('success');
    },
  );

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
      stubRuntime(),
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
      stubRuntime({ mode: 'plan' }),
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
      stubRuntime(),
    );
    input.nested.value = 'after';

    expect(result.inputUsed).toEqual({ nested: { value: 'before' } });
    expect(Object.isFrozen(result.inputUsed)).toBe(true);
    expect(Object.isFrozen(result.inputUsed.nested)).toBe(true);
  });
});

describe('executeToolCall pre-execution input identity', () => {
  it('executes a complete replacement input and authorizes the same values', async () => {
    let executorInput: Record<string, unknown> | undefined;
    const registry = register(echoDefinition, async (input) => {
      executorInput = structuredClone(input);
      return `echo: ${input.text}`;
    });
    const runtime = stubRuntime({
      callbacks: {
        onPreExecute: () => ({
          updatedInput: { text: 'replacement', nested: { value: 'final' } },
        }),
      },
    });
    const decisionSpy = vi.spyOn(
      runtime.permissionChecker,
      'checkDecision',
    );

    const result = await executeToolCall(
      registry,
      call('echo', { text: 'original' }),
      runtime,
    );

    const finalInput = {
      text: 'replacement',
      nested: { value: 'final' },
    };
    expect(decisionSpy).toHaveBeenCalledWith(
      'echo',
      finalInput,
      expect.anything(),
    );
    expect(executorInput).toEqual(finalInput);
    expect(result).toMatchObject({
      status: 'success',
      output: 'echo: replacement',
      inputUsed: finalInput,
      stageHits: { preExecute: true },
    });
  });

  it('passes Pre an immutable snapshot and ignores in-place mutation attempts', async () => {
    let preInputWasFrozen = false;
    const registry = register(
      echoDefinition,
      async (input) => `echo: ${input.text}`,
    );
    const runtime = stubRuntime({
      callbacks: {
        onPreExecute: (context) => {
          preInputWasFrozen = Object.isFrozen(context.input)
            && Object.isFrozen(context.input.nested);
          expect(Reflect.set(context.input, 'text', 'mutated')).toBe(false);
        },
      },
    });

    const result = await executeToolCall(
      registry,
      call('echo', { text: 'original', nested: { value: 'stable' } }),
      runtime,
    );

    expect(preInputWasFrozen).toBe(true);
    expect(result).toMatchObject({
      status: 'success',
      output: 'echo: original',
      inputUsed: { text: 'original', nested: { value: 'stable' } },
    });
  });

  it('treats updatedInput as a replacement rather than a patch', async () => {
    const registry = register(echoDefinition);
    const runtime = stubRuntime({
      callbacks: {
        onPreExecute: () => ({ updatedInput: { nested: { value: 'only' } } }),
      },
    });

    await expect(executeToolCall(
      registry,
      call('echo', { text: 'original' }),
      runtime,
    )).rejects.toBeInstanceOf(PreCallbackInputViolation);
  });

  it.each([
    null,
    [],
    { unexpected: true },
    { updatedInput: [] },
  ])('rejects an invalid Pre result shape: %j', async (invalidResult) => {
    const onPreExecute = (() => invalidResult) as unknown as NonNullable<
      ToolExecutionCallbacks['onPreExecute']
    >;
    const registry = register(echoDefinition);

    await expect(executeToolCall(
      registry,
      call('echo', { text: 'original' }),
      stubRuntime({ callbacks: { onPreExecute } }),
    )).rejects.toThrow('onPreExecute returned an invalid result');
  });

  it('does not call Pre when original input is invalid', async () => {
    const onPreExecute = vi.fn<
      NonNullable<ToolExecutionCallbacks['onPreExecute']>
    >((): ToolPreExecuteResult => ({ updatedInput: { text: 'fixed' } }));

    const result = await executeToolCall(
      register(echoDefinition),
      call('echo', {}),
      stubRuntime({ callbacks: { onPreExecute } }),
    );

    expect(result).toMatchObject({
      status: 'failure',
      failure: { kind: 'invalid_input' },
    });
    expect(onPreExecute).not.toHaveBeenCalled();
  });

  it('keeps inputUsed stable when the executor mutates its input', async () => {
    const registry = register(echoDefinition, async (input) => {
      input.text = 'mutated-by-executor';
      const nested = input.nested as Record<string, unknown>;
      nested.value = 'mutated-by-executor';
      return 'done';
    });

    const result = await executeToolCall(
      registry,
      call('echo', { text: 'original' }),
      stubRuntime({
        callbacks: {
          onPreExecute: () => ({
            updatedInput: { text: 'final', nested: { value: 'snapshot' } },
          }),
        },
      }),
    );

    expect(result.inputUsed).toEqual({
      text: 'final',
      nested: { value: 'snapshot' },
    });
  });
});

describe('executeToolCall executor error classification', () => {
  async function executeThrowing(error: unknown) {
    const registry = register(echoDefinition, async () => {
      throw error;
    });
    return executeToolCall(
      registry,
      call('echo', { text: 'hello' }),
      stubRuntime(),
    );
  }

  it('converts ToolOperationalError to operational_error', async () => {
    const result = await executeThrowing(
      new ToolOperationalError('service unavailable', 'SERVICE_DOWN'),
    );

    expect(result).toMatchObject({
      status: 'failure',
      failure: {
        kind: 'operational_error',
        stage: 'execution',
        message: 'service unavailable',
        code: 'SERVICE_DOWN',
      },
    });
  });

  it('accepts any string-valued errno code as operational', async () => {
    const error = Object.assign(new Error('environment failed'), {
      code: 'EUNLISTED_TEST_CODE',
    });

    const result = await executeThrowing(error);

    expect(result).toMatchObject({
      status: 'failure',
      failure: {
        kind: 'operational_error',
        code: 'EUNLISTED_TEST_CODE',
      },
    });
  });

  it('converts AbortError to cancelled', async () => {
    const error = new Error('cancelled');
    error.name = 'AbortError';

    const result = await executeThrowing(error);

    expect(result).toMatchObject({
      status: 'failure',
      failure: { kind: 'cancelled', stage: 'execution' },
    });
  });

  it('converts TimeoutError to timeout', async () => {
    const error = new Error('deadline exceeded');
    error.name = 'TimeoutError';

    const result = await executeThrowing(error);

    expect(result).toMatchObject({
      status: 'failure',
      failure: { kind: 'timeout', stage: 'execution' },
    });
  });

  it('bubbles TypeError by identity', async () => {
    const error = new TypeError('programmer bug');
    await expect(executeThrowing(error)).rejects.toBe(error);
  });

  it('bubbles an unmarked Error by identity', async () => {
    const error = new Error('unclassified');
    await expect(executeThrowing(error)).rejects.toBe(error);
  });

  it('bubbles a non-Error thrown value unchanged', async () => {
    const thrown = { reason: 'not-an-error' };
    await expect(executeThrowing(thrown)).rejects.toBe(thrown);
  });

  it('does not classify errors from timeout-like message text', async () => {
    const error = new Error('request timeout after 30 seconds');
    await expect(executeThrowing(error)).rejects.toBe(error);
  });
});

describe('executeToolCall callback exception post-processing', () => {
  it('bubbles a Pre Error and does not authorize or execute', async () => {
    const preError = new Error('pre failed');
    const executor = vi.fn(async () => 'unreachable');
    const runtime = stubRuntime({
      callbacks: {
        onPreExecute: () => {
          throw preError;
        },
      },
    });
    const decisionSpy = vi.spyOn(runtime.permissionChecker, 'checkDecision');

    await expect(executeToolCall(
      register(echoDefinition, executor),
      call('echo', { text: 'hello' }),
      runtime,
    )).rejects.toBe(preError);
    expect(decisionSpy).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });

  it('bubbles a non-Error thrown by Pre unchanged', async () => {
    const thrown = { stage: 'pre', reason: 'contract failed' };
    const runtime = stubRuntime({
      callbacks: {
        onPreExecute: () => {
          throw thrown;
        },
      },
    });

    await expect(executeToolCall(
      register(echoDefinition),
      call('echo', { text: 'hello' }),
      runtime,
    )).rejects.toBe(thrown);
  });

  it('preserves success and attaches an Error thrown by Post', async () => {
    let callbackResult: ToolExecutionResult | undefined;
    const postError = Object.assign(new Error('post failed'), {
      code: 'POST_FAILED',
    });
    const runtime = stubRuntime({
      callbacks: {
        onPostExecute: (result) => {
          callbackResult = result;
          throw postError;
        },
      },
    });

    const result = await executeToolCall(
      register(echoDefinition, async () => 'success output'),
      call('echo', { text: 'hello' }),
      runtime,
    );

    expect(callbackResult).toMatchObject({
      status: 'success',
      output: 'success output',
      stageHits: { postExecute: true },
    });
    expect(result).toMatchObject({
      status: 'success',
      output: 'success output',
      postExecuteError: {
        name: 'Error',
        message: 'post failed',
        code: 'POST_FAILED',
      },
    });
  });

  it('safely serializes a non-Error thrown by Post', async () => {
    const circular: Record<string, unknown> = { reason: 'post failed' };
    circular.self = circular;
    const runtime = stubRuntime({
      callbacks: {
        onPostExecute: () => {
          throw circular;
        },
      },
    });

    const result = await executeToolCall(
      register(echoDefinition),
      call('echo', { text: 'hello' }),
      runtime,
    );

    expect(result).toMatchObject({
      status: 'success',
      postExecuteError: {
        name: 'NonErrorThrown',
        message: '[unserializable thrown value]',
      },
    });
  });

  it('notifies Failure for every structured failure stage', async () => {
    const observed: Array<{ kind: string; stage: string; stageHit: boolean }> = [];
    const callbacks: ToolExecutionCallbacks = {
      onFailure: (result) => {
        observed.push({
          kind: result.failure.kind,
          stage: result.failure.stage,
          stageHit: result.stageHits.failure,
        });
      },
    };
    const runtime = () => stubRuntime({ callbacks });

    await executeToolCall(
      new ToolRegistry(),
      call('missing', {}),
      runtime(),
    );
    await executeToolCall(
      register(echoDefinition),
      call('echo', {}),
      runtime(),
    );
    await executeToolCall(
      register({
        name: 'write_file',
        description: 'write',
        parameters: { type: 'object' },
      }),
      call('write_file', {}),
      stubRuntime({ mode: 'plan', callbacks }),
    );
    await executeToolCall(
      register(echoDefinition, async () => {
        throw new ToolOperationalError('offline');
      }),
      call('echo', { text: 'hello' }),
      runtime(),
    );

    expect(observed).toEqual([
      { kind: 'unknown_tool', stage: 'lookup', stageHit: true },
      { kind: 'invalid_input', stage: 'validation', stageHit: true },
      { kind: 'permission_denied', stage: 'permission', stageHit: true },
      { kind: 'operational_error', stage: 'execution', stageHit: true },
    ]);
  });

  it('preserves failure and attaches an Error thrown by Failure notification', async () => {
    const runtime = stubRuntime({
      callbacks: {
        onFailure: () => {
          throw new Error('failure notification failed');
        },
      },
    });

    const result = await executeToolCall(
      register(echoDefinition),
      call('echo', {}),
      runtime,
    );

    expect(result).toMatchObject({
      status: 'failure',
      failure: { kind: 'invalid_input', stage: 'validation' },
      stageHits: { failure: true },
      failureCallbackError: {
        name: 'Error',
        message: 'failure notification failed',
      },
    });
  });

  it('preserves failure when Failure notification throws a non-Error', async () => {
    const thrown = { reason: 'notification transport failed' };
    const result = await executeToolCall(
      new ToolRegistry(),
      call('missing', {}),
      stubRuntime({
        callbacks: {
          onFailure: () => {
            throw thrown;
          },
        },
      }),
    );

    expect(result).toMatchObject({
      status: 'failure',
      failure: { kind: 'unknown_tool', stage: 'lookup' },
      failureCallbackError: {
        name: 'NonErrorThrown',
        message: '{"reason":"notification transport failed"}',
      },
    });
  });

  it('excludes blocked Post time from durationMs', async () => {
    const postEntered = deferred();
    const releasePost = deferred();
    // Task 13 在 runtime-gate.authorize 入口新增 performance.now 计时（startTime，审计用），
    // 与 executeToolCall 的 startedAt/durationMs 交错。本测试未提供 auditSink，故 gate 只调 1 次：
    //   call1=startedAt(tool,100) → call2=gate.startTime(100,不影响) → call3=durationMs(tool,125)
    const nowSpy = vi.spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(125);
    let releaseIfBlocked = false;

    try {
      const execution = executeToolCall(
        register(echoDefinition),
        call('echo', { text: 'hello' }),
        stubRuntime({
          callbacks: {
            onPostExecute: async () => {
              releaseIfBlocked = true;
              postEntered.resolve();
              await releasePost.promise;
            },
          },
        }),
      );
      const first = await Promise.race([
        postEntered.promise.then(() => 'post-entered' as const),
        execution.then(() => 'execution-returned' as const),
      ]);

      expect(first).toBe('post-entered');
      releasePost.resolve();
      const result = await execution;
      expect(result.durationMs).toBe(25);
    } finally {
      if (releaseIfBlocked) releasePost.resolve();
      nowSpy.mockRestore();
    }
  });

  it('excludes blocked Failure notification time from durationMs', async () => {
    const failureEntered = deferred();
    const releaseFailure = deferred();
    // 此测试走校验失败路径（空 input），durationMs 在 gate.execute 之前计算，不经过 gate 计时：
    //   call1=startedAt(tool,200) → call2=durationMs(tool,240)
    const nowSpy = vi.spyOn(performance, 'now')
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(240);
    let releaseIfBlocked = false;

    try {
      const execution = executeToolCall(
        register(echoDefinition),
        call('echo', {}),
        stubRuntime({
          callbacks: {
            onFailure: async () => {
              releaseIfBlocked = true;
              failureEntered.resolve();
              await releaseFailure.promise;
            },
          },
        }),
      );
      const first = await Promise.race([
        failureEntered.promise.then(() => 'failure-entered' as const),
        execution.then(() => 'execution-returned' as const),
      ]);

      expect(first).toBe('failure-entered');
      releaseFailure.resolve();
      const result = await execution;
      expect(result.durationMs).toBe(40);
    } finally {
      if (releaseIfBlocked) releaseFailure.resolve();
      nowSpy.mockRestore();
    }
  });
});
