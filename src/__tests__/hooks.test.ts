// Hook 系统测试
import { describe, it, expect, vi } from 'vitest';
import { HookRunner } from '../hooks/runner.js';
import { preToolSafetyCheck, postToolLogger, sessionStartLogger } from '../hooks/builtins.js';
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

describe('postToolLogger', () => {
  it('返回 exitCode 0，message 含工具名但不重复输出内容（避免与 tool_result 块重复渲染）', () => {
    const event: HookEvent = {
      name: 'PostToolUse',
      payload: { tool_name: 'run_bash', output: 'hello world' },
    };
    const result = postToolLogger(event);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('[Hook]');
    expect(result.message).toContain('run_bash');
    // 关键：不再返回 output 预览——输出已由 pipeline 的 tool_result 块渲染，
    // hook 二次输出会导致同一内容被画两遍（症状 C 根因）。
    expect(result.message).not.toContain('hello world');
  });

  it('message 不含任何 output 内容（无论多长）', () => {
    const long = 'x'.repeat(250);
    const event: HookEvent = {
      name: 'PostToolUse',
      payload: { tool_name: 'read_file', output: long },
    };
    const result = postToolLogger(event);
    expect(result.message).not.toContain('x');
    expect(result.message).not.toContain('...');
  });

  it('不调用 console.log（不绕过渲染器）', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      postToolLogger({ name: 'PostToolUse', payload: { tool_name: 't', output: 'o' } });
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  // Hook 是诊断输出,不能替代最终 assistant 回复。
  // turn-final-feedback 的分类器从不把 [Hook] 文本当作终端 assistant 回复;
  // 这里锁定 Hook message 的形态,确保它携带的是 [Hook] 标记而非 当前状态: 状态块。
  it('Hook message 是 [Hook] 诊断输出,绝非终端状态块', () => {
    const hook = postToolLogger({
      name: 'PostToolUse',
      payload: { tool_name: 'task', output: 'work' },
    });
    expect(hook.message).toBe('[Hook] task done');
    // 关键不变量:Hook message 绝不包含最终状态块的标记
    expect(hook.message).not.toContain('当前状态：');
  });
});

describe('sessionStartLogger', () => {
  it('返回 exitCode 0，message 含 Session started', () => {
    const result = sessionStartLogger();
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('Session started');
  });

  it('不调用 console.log（不绕过渲染器）', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      sessionStartLogger();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});
