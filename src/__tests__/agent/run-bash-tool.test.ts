import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  killProcessTree: vi.fn(),
}));

vi.mock('child_process', async () => ({
  ...(await vi.importActual<typeof import('child_process')>('child_process')),
  spawn: mocks.spawn,
}));

vi.mock('../../agent/process-tree.js', () => ({
  killProcessTree: mocks.killProcessTree,
}));

import { executeToolCall } from '../../agent/tool-execution.js';
import { createBashTool, ToolRegistry } from '../../agent/tool-registry.js';
import type { ToolExecutionContext, ToolUseBlock } from '../../agent/types.js';
import { createToolExecutionRuntime } from '../helpers/tool-execution-runtime.js';

function makeChild(pid = 4_242): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  return child;
}

function executeBash(
  input: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const registry = new ToolRegistry();
  const bash = createBashTool();
  registry.register(bash.definition, bash.executor);
  const call: ToolUseBlock = {
    type: 'tool_use',
    id: 'run-bash-test',
    name: 'run_bash',
    input,
  };
  const context: Omit<ToolExecutionContext, 'toolUseId'> = signal
    ? { signal }
    : {};
  return executeToolCall(
    registry,
    call,
    // A15 后 auto 模式 run_bash 返回 ask；本组测试验证 timeout 契约而非权限行为，
    // 显式 allow run_bash 以隔离权限依赖。
    createToolExecutionRuntime({ rules: [{ tool: 'run_bash', behavior: 'allow' }] }),
    context,
  );
}

beforeEach(() => {
  mocks.spawn.mockReset();
  mocks.spawn.mockImplementation(() => {
    const child = makeChild();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  });
  mocks.killProcessTree.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('run_bash timeout contract', () => {
  it('declares optional timeout_ms with inclusive bounds', () => {
    const bash = createBashTool();
    expect(bash.definition.parameters.properties?.timeout_ms).toMatchObject({
      type: 'number',
      minimum: 1,
      maximum: 600_000,
    });
    expect(bash.definition.parameters.required).toEqual(['command']);
  });

  it.each([
    { timeout_ms: 0, message: '$.timeout_ms: expected number >= 1' },
    { timeout_ms: 600_001, message: '$.timeout_ms: expected number <= 600000' },
  ])(
    'rejects run_bash timeout_ms $timeout_ms before spawn',
    async ({ timeout_ms, message }) => {
      await expect(executeBash({ command: 'echo blocked', timeout_ms }))
        .resolves.toMatchObject({
          status: 'failure',
          failure: {
            kind: 'invalid_input',
            stage: 'validation',
            message,
          },
        });
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it.each([
    { input: { command: 'echo ok' }, delay: 30_000 },
    { input: { command: 'echo ok', timeout_ms: 1_234 }, delay: 1_234 },
  ])('schedules the configured timeout $delay', async ({ input, delay }) => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const bash = createBashTool();

    const resultPromise = bash.executor(input);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), delay);
    child.stdout?.emit('data', Buffer.from('ok'));
    child.emit('close', 0);
    await expect(resultPromise).resolves.toBe('ok');
  });

  it('immediately returns failure(timeout) without a child close/error event', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const settled = vi.fn();

    const execution = executeBash({ command: 'echo waiting', timeout_ms: 1_234 });
    void execution.then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_234);
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failure',
      failure: expect.objectContaining({
        kind: 'timeout',
        stage: 'execution',
      }),
    }));
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(mocks.killProcessTree).toHaveBeenCalledWith(4_242);
    expect(clearTimeoutSpy.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.killProcessTree.mock.invocationCallOrder[0]);
    expect(mocks.killProcessTree.mock.invocationCallOrder[0])
      .toBeLessThan(settled.mock.invocationCallOrder[0]);

    child.emit('close', 0);
    child.emit('error', new Error('late child error'));
    await Promise.resolve();
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('keeps a non-zero exit code as success with stderr output', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);

    const execution = executeBash({ command: 'echo failing', timeout_ms: 600_000 });
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    child.stderr?.emit('data', Buffer.from('command failed'));
    child.emit('close', 7);

    await expect(execution).resolves.toMatchObject({
      status: 'success',
      output: 'command failed',
    });
  });

  it('kills the process tree and returns failure(cancelled) on Abort', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const controller = new AbortController();
    const removeListenerSpy = vi.spyOn(
      controller.signal,
      'removeEventListener',
    );
    const settled = vi.fn();

    const execution = executeBash(
      { command: 'echo waiting', timeout_ms: 600_000 },
      controller.signal,
    );
    void execution.then(settled);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    controller.abort();

    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failure',
      failure: expect.objectContaining({
        kind: 'cancelled',
        stage: 'execution',
      }),
    }));
    expect(removeListenerSpy).toHaveBeenCalledWith(
      'abort',
      expect.any(Function),
    );
    expect(mocks.killProcessTree).toHaveBeenCalledWith(4_242);
    expect(removeListenerSpy.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.killProcessTree.mock.invocationCallOrder[0]);
    expect(mocks.killProcessTree.mock.invocationCallOrder[0])
      .toBeLessThan(settled.mock.invocationCallOrder[0]);

    child.emit('close', 0);
    child.emit('error', new Error('late child error'));
    await Promise.resolve();
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('returns cancelled before spawn for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(executeBash(
      { command: 'echo never-started', timeout_ms: 600_000 },
      controller.signal,
    )).resolves.toMatchObject({
      status: 'failure',
      failure: { kind: 'cancelled', stage: 'execution' },
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.killProcessTree).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'without code',
      error: new Error('plain spawn failure'),
      expectedCode: undefined,
    },
    {
      label: 'with string code',
      error: Object.assign(new Error('coded spawn failure'), { code: 'ENOENT' }),
      expectedCode: 'ENOENT',
    },
  ])(
    'returns failure(operational_error) for child error $label',
    async ({ error, expectedCode }) => {
      const child = makeChild();
      mocks.spawn.mockReturnValue(child);

      const execution = executeBash({ command: 'echo unavailable' });
      await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
      child.emit('error', error);

      await expect(execution).resolves.toMatchObject({
        status: 'failure',
        failure: {
          kind: 'operational_error',
          stage: 'execution',
          message: error.message,
          code: expectedCode,
        },
      });
    },
  );
});
