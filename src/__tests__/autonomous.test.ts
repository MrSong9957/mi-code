// 自主代理测试
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TodoManager } from '../agent/todo.js';
import { MessageBus } from '../agent/team/message-bus.js';
import { runIdleLoop } from '../agent/team/idle-loop.js';

describe('TodoManager - 自主扩展', () => {
  let todo: TodoManager;

  beforeEach(() => {
    todo = new TodoManager(1);
    todo.update([
      { id: '1', content: 'Setup DB', status: 'pending' },
      { id: '2', content: 'Build API', status: 'pending', blockedBy: ['1'] },
      { id: '3', content: 'Write tests', status: 'pending', blockedBy: ['2'] },
    ]);
  });

  it('canStart: 无依赖的任务可以开始', () => {
    expect(todo.canStart('1')).toBe(true);
  });

  it('canStart: 有未完成依赖的任务不能开始', () => {
    expect(todo.canStart('2')).toBe(false);
  });

  it('canStart: 依赖完成后可以开始', () => {
    todo.update([
      { id: '1', content: 'Setup DB', status: 'completed' },
      { id: '2', content: 'Build API', status: 'pending', blockedBy: ['1'] },
      { id: '3', content: 'Write tests', status: 'pending', blockedBy: ['2'] },
    ]);
    expect(todo.canStart('2')).toBe(true);
    expect(todo.canStart('3')).toBe(false);
  });

  it('scanClaimable: 只返回可认领的任务', () => {
    const claimable = todo.scanClaimable();
    expect(claimable).toHaveLength(1);
    expect(claimable[0].id).toBe('1');
  });

  it('scanClaimable: 依赖完成后返回更多任务', () => {
    todo.update([
      { id: '1', content: 'Setup DB', status: 'completed' },
      { id: '2', content: 'Build API', status: 'pending', blockedBy: ['1'] },
      { id: '3', content: 'Write tests', status: 'pending', blockedBy: ['2'] },
    ]);
    const claimable = todo.scanClaimable();
    expect(claimable).toHaveLength(1);
    expect(claimable[0].id).toBe('2');
  });

  it('claim: 原子性检查 - 已被认领的任务不能重复认领', () => {
    todo.claim('1', 'alice');
    const result = todo.claim('1', 'bob');
    expect(result).toContain('Error');
    expect(result).toContain('alice');
  });

  it('claim: 被阻塞的任务不能认领', () => {
    const result = todo.claim('2', 'alice');
    expect(result).toContain('Error');
    expect(result).toContain('blocked');
  });

  it('claim: 自动认领 source=auto', () => {
    const result = todo.claim('1', 'alice', 'auto');
    expect(result).toContain('Claimed');
    const items = todo.getItems();
    expect(items[0].claimSource).toBe('auto');
  });
});

describe('runIdleLoop - 双源轮询', () => {
  let teamDir: string;
  let bus: MessageBus;

  beforeEach(() => {
    teamDir = join(tmpdir(), `idle-dual-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    bus = new MessageBus(teamDir);
  });

  afterEach(() => {
    rmSync(teamDir, { recursive: true, force: true });
  });

  it('inbox 优先于任务板', async () => {
    const todo = new TodoManager(1);
    todo.update([{ id: '1', content: 'Task', status: 'pending' }]);
    bus.send('lead', 'alice', 'Do this instead', 'message');

    const result = await runIdleLoop('alice', bus, {
      pollIntervalMs: 50,
      maxWaitMs: 2000,
      todoManager: todo,
    });

    expect(result.exitReason).toBe('new_task');
    expect(result.taskMessage).toContain('Do this instead');
    expect(result.claimedTaskId).toBeUndefined();
  });

  it('无 inbox 时自动认领任务', async () => {
    const todo = new TodoManager(1);
    todo.update([{ id: '1', content: 'Auto task', status: 'pending' }]);

    const result = await runIdleLoop('alice', bus, {
      pollIntervalMs: 50,
      maxWaitMs: 2000,
      todoManager: todo,
    });

    expect(result.exitReason).toBe('new_task');
    expect(result.claimedTaskId).toBe('1');
    expect(result.taskMessage).toContain('Auto task');
    expect(todo.getItems()[0].owner).toBe('alice');
  });

  it('shutdown 优先于任务认领', async () => {
    const todo = new TodoManager(1);
    todo.update([{ id: '1', content: 'Task', status: 'pending' }]);
    bus.send('lead', 'alice', 'Shutdown', 'shutdown_request', 'req-1');

    const result = await runIdleLoop('alice', bus, {
      pollIntervalMs: 50,
      maxWaitMs: 2000,
      todoManager: todo,
    });

    expect(result.exitReason).toBe('shutdown');
    expect(result.claimedTaskId).toBeUndefined();
  });

  it('无任务无消息时超时', async () => {
    const result = await runIdleLoop('alice', bus, {
      pollIntervalMs: 50,
      maxWaitMs: 300,
    });

    expect(result.exitReason).toBe('timeout');
  });
});
