// 团队协议测试
//
// 物理本质：测试"合同管理系统"能不能正确签合同、对上号、过期处理。
// 重点验证：持久化、类型安全校验、统一收件箱消费、idle loop。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { NegotiationManager } from '../agent/team/negotiation.js';
import { MessageBus } from '../agent/team/message-bus.js';
import { consumeLeadInbox } from '../agent/team/inbox-consumer.js';
import { runIdleLoop } from '../agent/team/idle-loop.js';

describe('NegotiationManager - 持久化', () => {
  let teamDir: string;
  let manager: NegotiationManager;

  beforeEach(() => {
    teamDir = join(tmpdir(), `neg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    manager = new NegotiationManager(teamDir);
  });

  afterEach(() => {
    rmSync(teamDir, { recursive: true, force: true });
  });

  it('createRequest: 写入磁盘文件', () => {
    const reqId = manager.createRequest('shutdown', 'lead', 'alice', 'Please shut down');

    const filePath = join(teamDir, 'requests', `${reqId}.json`);
    expect(existsSync(filePath)).toBe(true);

    const saved = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(saved.id).toBe(reqId);
    expect(saved.type).toBe('shutdown');
    expect(saved.status).toBe('pending');
  });

  it('respond: 更新磁盘文件', () => {
    const reqId = manager.createRequest('shutdown', 'lead', 'alice', 'Shutdown');
    manager.respond(reqId, true);

    const filePath = join(teamDir, 'requests', `${reqId}.json`);
    const saved = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(saved.status).toBe('approved');
  });

  it('recover: 从磁盘重建状态', () => {
    const reqId = manager.createRequest('shutdown', 'lead', 'alice', 'Shutdown');

    // 模拟进程重启
    const manager2 = new NegotiationManager(teamDir);
    const req = manager2.getRequest(reqId);
    expect(req).not.toBeNull();
    expect(req!.status).toBe('pending');
  });

  it('expire: 过期 pending 请求', () => {
    const reqId = manager.createRequest('shutdown', 'lead', 'alice', 'Shutdown');
    const ok = manager.expire(reqId);

    expect(ok).toBe(true);
    expect(manager.getStatus(reqId)).toBe('expired');
  });

  it('expire: 已解决的请求返回 false', () => {
    const reqId = manager.createRequest('shutdown', 'lead', 'alice', 'Shutdown');
    manager.respond(reqId, true);

    expect(manager.expire(reqId)).toBe(false);
  });
});

describe('NegotiationManager - 类型安全校验', () => {
  let teamDir: string;
  let manager: NegotiationManager;

  beforeEach(() => {
    teamDir = join(tmpdir(), `neg-type-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    manager = new NegotiationManager(teamDir);
  });

  afterEach(() => {
    rmSync(teamDir, { recursive: true, force: true });
  });

  it('matchResponse: 匹配正确的响应类型', () => {
    const reqId = manager.createRequest('shutdown', 'lead', 'alice', 'Shutdown');

    const ok = manager.matchResponse('shutdown_response', reqId, true);
    expect(ok).toBe(true);
    expect(manager.getStatus(reqId)).toBe('approved');
  });

  it('matchResponse: 拒绝不匹配的响应类型', () => {
    const reqId = manager.createRequest('shutdown', 'lead', 'alice', 'Shutdown');

    // plan_approval_response 不能 approve shutdown 请求
    const ok = manager.matchResponse('plan_approval_response', reqId, true);
    expect(ok).toBe(false);
    expect(manager.getStatus(reqId)).toBe('pending'); // 状态不变
  });

  it('matchResponse: plan_approval 类型匹配', () => {
    const reqId = manager.createRequest('plan_approval', 'lead', 'system', 'Refactor plan');

    const ok = manager.matchResponse('plan_approval_response', reqId, true);
    expect(ok).toBe(true);
    expect(manager.getStatus(reqId)).toBe('approved');
  });

  it('matchResponse: 已解决的请求返回 false', () => {
    const reqId = manager.createRequest('shutdown', 'lead', 'alice', 'Shutdown');
    manager.respond(reqId, true);

    const ok = manager.matchResponse('shutdown_response', reqId, false);
    expect(ok).toBe(false);
  });

  it('matchResponse: 不存在的请求返回 false', () => {
    expect(manager.matchResponse('shutdown_response', 'nonexistent', true)).toBe(false);
  });
});

describe('consumeLeadInbox', () => {
  let teamDir: string;
  let bus: MessageBus;
  let manager: NegotiationManager;

  beforeEach(() => {
    teamDir = join(tmpdir(), `inbox-consume-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    bus = new MessageBus(teamDir);
    manager = new NegotiationManager(teamDir);
  });

  afterEach(() => {
    rmSync(teamDir, { recursive: true, force: true });
  });

  it('普通消息直接返回', () => {
    bus.send('alice', 'lead', 'Task done', 'result');

    const messages = consumeLeadInbox(bus, manager);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Task done');
  });

  it('协议响应消息被拦截并更新状态', () => {
    const reqId = manager.createRequest('shutdown', 'lead', 'alice', 'Shutdown');

    // 模拟队友回复 shutdown_response
    bus.send('alice', 'lead', 'Shutting down', 'shutdown_response', reqId);

    const messages = consumeLeadInbox(bus, manager);

    // 消息仍然返回（供注入主循环）
    expect(messages).toHaveLength(1);

    // 但协议状态已更新
    expect(manager.getStatus(reqId)).toBe('approved');
  });

  it('无消息时返回空数组', () => {
    expect(consumeLeadInbox(bus, manager)).toEqual([]);
  });

  it('混合消息：协议 + 普通', () => {
    const reqId = manager.createRequest('plan_approval', 'lead', 'system', 'Plan A');

    bus.send('alice', 'lead', 'Plan approved', 'plan_approval_response', reqId);
    bus.send('bob', 'lead', 'My part is done', 'result');

    const messages = consumeLeadInbox(bus, manager);
    expect(messages).toHaveLength(2);
    expect(manager.getStatus(reqId)).toBe('approved');
  });
});

describe('runIdleLoop', () => {
  let teamDir: string;
  let bus: MessageBus;

  beforeEach(() => {
    teamDir = join(tmpdir(), `idle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    bus = new MessageBus(teamDir);
  });

  afterEach(() => {
    rmSync(teamDir, { recursive: true, force: true });
  });

  it('收到 shutdown_request 后退出', async () => {
    // 先发一条 shutdown 消息
    bus.send('lead', 'alice', 'Please shut down', 'shutdown_request', 'req-1');

    const result = await runIdleLoop('alice', bus, { pollIntervalMs: 50, maxWaitMs: 2000 });

    expect(result.exitReason).toBe('shutdown');
    expect(result.shutdownRequestId).toBe('req-1');

    // 队友应该回复了 shutdown_response
    const leadMessages = bus.readInbox('lead');
    expect(leadMessages.some(m => m.type === 'shutdown_response')).toBe(true);
  });

  it('收到新任务消息后返回任务', async () => {
    // 先发一条普通任务消息
    bus.send('lead', 'alice', 'New task: fix bug #42', 'message');

    const result = await runIdleLoop('alice', bus, { pollIntervalMs: 50, maxWaitMs: 2000 });

    expect(result.exitReason).toBe('new_task');
    expect(result.taskMessage).toContain('fix bug #42');
  });

  it('超时后退出', async () => {
    const result = await runIdleLoop('alice', bus, { pollIntervalMs: 50, maxWaitMs: 300 });

    expect(result.exitReason).toBe('timeout');
  });
});
