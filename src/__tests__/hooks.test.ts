// Hook 系统测试
import { describe, it, expect, vi } from 'vitest';
import { HookRunner } from '../hooks/runner.js';
import { preToolSafetyCheck } from '../hooks/builtins.js';
import type { HookEvent, HookHandler } from '../hooks/types.js';

describe('HookRunner', () => {
  it('should return exitCode 0 when no handlers registered', async () => {
    const runner = new HookRunner();
    const event: HookEvent = { name: 'PreToolUse', payload: { tool_name: 'test', input: {} } };

    const result = await runner.run(event);

    expect(result.exitCode).toBe(0);
    expect(result.message).toBe('');
  });

  it('should call single handler and return its result', async () => {
    const runner = new HookRunner();
    const handler: HookHandler = () => ({ exitCode: 0, message: 'ok' });
    runner.register('PreToolUse', handler);

    const event: HookEvent = { name: 'PreToolUse', payload: { tool_name: 'test', input: {} } };
    const result = await runner.run(event);

    expect(result.exitCode).toBe(0);
    expect(result.message).toBe('ok');
  });

  it('should stop and return when handler returns exitCode 1 (block)', async () => {
    const runner = new HookRunner();
    const handler1: HookHandler = () => ({ exitCode: 1, message: 'blocked' });
    const handler2: HookHandler = () => ({ exitCode: 0, message: 'should not reach' });
    runner.register('PreToolUse', handler1);
    runner.register('PreToolUse', handler2);

    const event: HookEvent = { name: 'PreToolUse', payload: { tool_name: 'test', input: {} } };
    const result = await runner.run(event);

    expect(result.exitCode).toBe(1);
    expect(result.message).toBe('blocked');
  });

  it('should stop and return when handler returns exitCode 2 (inject)', async () => {
    const runner = new HookRunner();
    const handler1: HookHandler = () => ({ exitCode: 2, message: 'injected context' });
    const handler2: HookHandler = () => ({ exitCode: 0, message: 'should not reach' });
    runner.register('PreToolUse', handler1);
    runner.register('PreToolUse', handler2);

    const event: HookEvent = { name: 'PreToolUse', payload: { tool_name: 'test', input: {} } };
    const result = await runner.run(event);

    expect(result.exitCode).toBe(2);
    expect(result.message).toBe('injected context');
  });

  it('should run handlers in registration order', async () => {
    const runner = new HookRunner();
    const order: number[] = [];
    const handler1: HookHandler = () => { order.push(1); return { exitCode: 0, message: '' }; };
    const handler2: HookHandler = () => { order.push(2); return { exitCode: 0, message: '' }; };
    runner.register('PreToolUse', handler1);
    runner.register('PreToolUse', handler2);

    await runner.run({ name: 'PreToolUse', payload: {} });

    expect(order).toEqual([1, 2]);
  });

  it('should skip handlers for different event names', async () => {
    const runner = new HookRunner();
    const handler = vi.fn<HookHandler>(() => ({ exitCode: 0, message: '' }));
    runner.register('PostToolUse', handler);

    await runner.run({ name: 'PreToolUse', payload: {} });

    expect(handler).not.toHaveBeenCalled();
  });

  it('should support async handlers', async () => {
    const runner = new HookRunner();
    const handler: HookHandler = async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return { exitCode: 0, message: 'async ok' };
    };
    runner.register('PreToolUse', handler);

    const result = await runner.run({ name: 'PreToolUse', payload: {} });

    expect(result.exitCode).toBe(0);
    expect(result.message).toBe('async ok');
  });

  it('should unregister handler', async () => {
    const runner = new HookRunner();
    const handler: HookHandler = () => ({ exitCode: 1, message: 'blocked' });
    runner.register('PreToolUse', handler);
    runner.unregister('PreToolUse', handler);

    const result = await runner.run({ name: 'PreToolUse', payload: {} });

    expect(result.exitCode).toBe(0);
  });
});

describe('preToolSafetyCheck', () => {
  it('should block dangerous bash commands', () => {
    const event: HookEvent = {
      name: 'PreToolUse',
      payload: { tool_name: 'run_bash', input: { command: 'sudo rm -rf /' } },
    };

    const result = preToolSafetyCheck(event);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('Dangerous command');
  });

  it('should allow safe bash commands', () => {
    const event: HookEvent = {
      name: 'PreToolUse',
      payload: { tool_name: 'run_bash', input: { command: 'npm test' } },
    };

    const result = preToolSafetyCheck(event);

    expect(result.exitCode).toBe(0);
  });

  it('should allow non-bash tools', () => {
    const event: HookEvent = {
      name: 'PreToolUse',
      payload: { tool_name: 'read_file', input: { path: '/tmp/test.txt' } },
    };

    const result = preToolSafetyCheck(event);

    expect(result.exitCode).toBe(0);
  });
});
