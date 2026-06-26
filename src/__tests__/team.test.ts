// 团队系统测试
//
// 物理本质：测试"项目经理"能不能正确招人、发任务、收结果。
// 用 tmpdir 模拟团队目录，避免污染真实项目。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MessageBus } from '../agent/team/message-bus.js';
import { TeammateManager } from '../agent/team/teammate-manager.js';
import { PermissionBubble } from '../agent/team/permission-bubble.js';
import { createSpawnTeammateTool } from '../agent/team/tools.js';

describe('MessageBus', () => {
  let teamDir: string;
  let bus: MessageBus;

  beforeEach(() => {
    teamDir = join(tmpdir(), `team-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    bus = new MessageBus(teamDir);
  });

  afterEach(() => {
    rmSync(teamDir, { recursive: true, force: true });
  });

  it('send + readInbox: 基本收发', () => {
    bus.send('alice', 'bob', 'Hello Bob');

    const messages = bus.readInbox('bob');
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe('alice');
    expect(messages[0].content).toBe('Hello Bob');
    expect(messages[0].type).toBe('message');
  });

  it('readInbox: 读取后清空', () => {
    bus.send('alice', 'bob', 'msg1');
    bus.readInbox('bob');

    const second = bus.readInbox('bob');
    expect(second).toHaveLength(0);
  });

  it('readInbox: 空收件箱返回空数组', () => {
    expect(bus.readInbox('nobody')).toEqual([]);
  });

  it('broadcast: 广播给多人', () => {
    bus.broadcast('lead', ['alice', 'bob', 'charlie'], 'Team meeting');

    expect(bus.readInbox('alice')).toHaveLength(1);
    expect(bus.readInbox('bob')).toHaveLength(1);
    expect(bus.readInbox('charlie')).toHaveLength(1);
  });

  it('send: idle_notification 类型', () => {
    bus.send('alice', 'lead', 'idle', 'idle_notification');

    const messages = bus.readInbox('lead');
    expect(messages[0].type).toBe('idle_notification');
  });

  it('send: permission_request 带 requestId', () => {
    bus.send('alice', 'lead', 'Need approval for bash', 'permission_request', 'req-123');

    const messages = bus.readInbox('lead');
    expect(messages[0].type).toBe('permission_request');
    expect(messages[0].requestId).toBe('req-123');
  });
});

describe('TeammateManager', () => {
  let teamDir: string;
  let manager: TeammateManager;

  beforeEach(() => {
    teamDir = join(tmpdir(), `team-mgr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    manager = new TeammateManager(teamDir);
  });

  afterEach(() => {
    rmSync(teamDir, { recursive: true, force: true });
  });

  it('list: 初始为空', () => {
    expect(manager.list()).toEqual([]);
  });

  it('spawn: 注册队友到配置', () => {
    manager.spawn('alice', 'coder', 'Build the API');

    const members = manager.list();
    expect(members).toHaveLength(1);
    expect(members[0].name).toBe('alice');
    expect(members[0].role).toBe('coder');
    expect(members[0].status).toBe('working');
  });

  it('spawn: 配置持久化到磁盘', () => {
    manager.spawn('bob', 'tester', 'Write tests');

    const manager2 = new TeammateManager(teamDir);
    const members = manager2.list();
    expect(members).toHaveLength(1);
    expect(members[0].name).toBe('bob');
  });

  it('spawn: 重复名字抛错', () => {
    manager.spawn('alice', 'coder', 'Build API');
    expect(() => manager.spawn('alice', 'tester', 'Write tests')).toThrow('already exists');
  });

  it('getIdleMembers: 返回空闲队友', () => {
    manager.spawn('alice', 'coder', 'Build API');
    manager.setIdle('alice');

    const idle = manager.getIdleMembers();
    expect(idle).toHaveLength(1);
    expect(idle[0].name).toBe('alice');
  });

  it('describe: 输出团队状态', () => {
    manager.spawn('alice', 'coder', 'Build API');
    const desc = manager.describe();

    expect(desc).toContain('alice');
    expect(desc).toContain('coder');
    expect(desc).toContain('working');
  });

  it('getByName: 按名字查找队友', () => {
    manager.spawn('alice', 'coder', 'Build API');

    const alice = manager.getByName('alice');
    expect(alice).not.toBeNull();
    expect(alice!.role).toBe('coder');

    expect(manager.getByName('nobody')).toBeNull();
  });
});

describe('PermissionBubble', () => {
  let teamDir: string;
  let bus: MessageBus;
  let bubble: PermissionBubble;

  beforeEach(() => {
    teamDir = join(tmpdir(), `perm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    bus = new MessageBus(teamDir);
    bubble = new PermissionBubble(bus);
  });

  afterEach(() => {
    rmSync(teamDir, { recursive: true, force: true });
  });

  it('createRequest: 发起请求并写入 Lead 收件箱', () => {
    const reqId = bubble.createRequest('alice', 'run_bash', 'Need to run npm install');

    expect(reqId).toBeTruthy();
    expect(bubble.getStatus(reqId)).toBe('pending');

    // Lead 收件箱有 permission_request
    const messages = bus.readInbox('lead');
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('permission_request');
    expect(messages[0].requestId).toBe(reqId);
  });

  it('respond: 审批后写回队友收件箱', () => {
    const reqId = bubble.createRequest('alice', 'run_bash', 'npm install');
    const ok = bubble.respond(reqId, true);

    expect(ok).toBe(true);
    expect(bubble.getStatus(reqId)).toBe('approved');

    // 队友收件箱有 permission_response
    const messages = bus.readInbox('alice');
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('permission_response');
    expect(messages[0].content).toBe('approved');
  });

  it('respond: 驳回请求', () => {
    const reqId = bubble.createRequest('alice', 'run_bash', 'rm -rf /');
    bubble.respond(reqId, false);

    expect(bubble.getStatus(reqId)).toBe('rejected');
  });

  it('respond: 不存在的请求返回 false', () => {
    expect(bubble.respond('nonexistent', true)).toBe(false);
  });

  it('getPendingRequests: 返回待处理请求', () => {
    bubble.createRequest('alice', 'run_bash', 'task1');
    bubble.createRequest('bob', 'write_file', 'task2');

    const pending = bubble.getPendingRequests();
    expect(pending).toHaveLength(2);
  });

  it('getPendingRequests: 审批后不再返回', () => {
    const reqId = bubble.createRequest('alice', 'run_bash', 'task1');
    bubble.respond(reqId, true);

    expect(bubble.getPendingRequests()).toHaveLength(0);
  });
});

describe('spawn_teammate tool', () => {
  it('should register teammate in manager', async () => {
    const teamDir = join(tmpdir(), `spawn-tool-${Date.now()}`);
    const manager = new TeammateManager(teamDir);

    const { executor } = createSpawnTeammateTool(manager);
    const result = await executor({ name: 'alice', role: 'coder', prompt: 'Build API' });

    expect(result).toContain('alice');
    expect(result).toContain('coder');
    expect(manager.list()).toHaveLength(1);

    rmSync(teamDir, { recursive: true, force: true });
  });

  it('should return error for duplicate name', async () => {
    const teamDir = join(tmpdir(), `spawn-dup-${Date.now()}`);
    const manager = new TeammateManager(teamDir);
    manager.spawn('alice', 'coder', 'task1');

    const { executor } = createSpawnTeammateTool(manager);
    const result = await executor({ name: 'alice', role: 'tester', prompt: 'task2' });

    expect(result).toContain('Error');
    expect(result).toContain('already exists');

    rmSync(teamDir, { recursive: true, force: true });
  });
});
