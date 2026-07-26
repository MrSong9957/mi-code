// Wave B Task 13 (M-066): RuntimeSecurityGate 单元测试
//
// 物理本质:银行柜台的"双重确认窗口"。
//   - allow / deny: 自动出闸(无人值守)。
//   - ask: 必须按下"叫号器",等用户(经理)走到窗口签字(approved_once)才能放行;
//          没人值守(channel=null)→ 直接关门(no_channel,绝不偷偷开侧门放行)。
//
// 九大不变量(对应 self-review checkpoint):
//   1. ask 在 approved_once 到位前,executor 调用次数必须为 0;
//   2. channel=null 时 ask 绝不降级为 allow(只 deny);
//   3. approved_once 一次即消费,不可对同一 decision 重放;
//   4. action snapshot 改变→旧 approved_once 失效;
//   5. ask 不产出 tool result 占位(由调用方负责);
//   6. 不写永久 allow 规则;
//   7. channel 失败 / 拒绝→ 不继续执行;
//   8. 不实现 delegation handoff classifier(M-067, Wave C);
//   9. 只动允许的文件集合。
//
// 测试不接真实 UI / 文件系统,用 InMemoryPendingDecisionStore + DeferredUserDecisionChannel。

import { describe, expect, it, vi } from 'vitest';
import {
  RuntimeSecurityGate,
  type PendingSecurityDecision,
  type PendingDecisionStore,
  type UserDecisionChannel,
} from '../../permission/runtime-gate.js';
import {
  createSecurityDecision,
  SECURITY_PROTOCOL_VERSION,
  type SecurityDecision,
  type UserDecision,
} from '../../permission/decisions.js';

// ─────────────────────────────────────────────
// 测试替身
// ─────────────────────────────────────────────

/** 内存版 PendingDecisionStore:记录所有 save / update 调用,供断言。 */
class InMemoryPendingDecisionStore implements PendingDecisionStore {
  public readonly saved: PendingSecurityDecision[] = [];
  public readonly updates: { decisionId: string; update: Partial<PendingSecurityDecision> }[] = [];

  async save(pending: PendingSecurityDecision): Promise<void> {
    this.saved.push({ ...pending });
  }
  async load(_sessionId: string): Promise<readonly PendingSecurityDecision[]> {
    return [...this.saved];
  }
  async update(decisionId: string, update: Partial<PendingSecurityDecision>): Promise<void> {
    this.updates.push({ decisionId, update: { ...update } });
  }
}

/**
 * 延迟版 UserDecisionChannel:request() 返回一个未决 Promise,
 * 测试通过 resolve()/reject() 控制何时 / 用什么 UserDecision 完成它。
 */
class DeferredUserDecisionChannel implements UserDecisionChannel {
  public requestCalls: SecurityDecision[] = [];
  private deferred: {
    resolve: (d: UserDecision) => void;
    reject: (e: unknown) => void;
  } | null = null;

  async request(decision: SecurityDecision): Promise<UserDecision> {
    this.requestCalls.push(decision);
    return new Promise<UserDecision>((resolve, reject) => {
      this.deferred = { resolve, reject };
    });
  }

  /** 完成 Promise:提交一个 UserDecision(approved_once / rejected)。 */
  resolve(userDecision: UserDecision): void {
    if (!this.deferred) throw new Error('no pending request to resolve');
    const d = this.deferred;
    this.deferred = null;
    d.resolve(userDecision);
  }

  /** 让 channel.request() 抛错(模拟通道故障)。 */
  rejectChannel(error: unknown): void {
    if (!this.deferred) throw new Error('no pending request to reject');
    const d = this.deferred;
    this.deferred = null;
    d.reject(error);
  }

  get hasPending(): boolean {
    return this.deferred !== null;
  }
}

// ─────────────────────────────────────────────
// 构造助手
// ─────────────────────────────────────────────

let counter = 0;
function uniqueId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function makeDecision(
  overrides: Partial<{
    decision_id: string;
    action_snapshot_id: string;
    behavior: 'allow' | 'ask' | 'deny';
    reason_code: string;
    human_reason: string;
    session_id: string;
  }> = {},
): { decision: SecurityDecision; session_id: string } {
  const session_id = overrides.session_id ?? uniqueId('sess');
  const decision = createSecurityDecision({
    protocol_version: SECURITY_PROTOCOL_VERSION,
    decision_id: overrides.decision_id ?? uniqueId('decision'),
    action: {
      kind: 'tool_call',
      subject_id: 'write_file',
      snapshot_id: overrides.action_snapshot_id ?? uniqueId('snapshot'),
    },
    behavior: overrides.behavior ?? 'ask',
    deciding_layer: 'permission',
    risk_kind: 'workspace_mutation',
    policy_id: 'permission-default',
    policy_version: '1',
    reason_code: overrides.reason_code ?? 'permission.user_confirmation_required',
    human_reason: overrides.human_reason ?? 'Write operation needs user confirmation',
    provenance_refs: ['rule:default'],
  });
  return { decision, session_id };
}

function userApprove(decision: SecurityDecision, decidedAt = '2026-07-26T00:00:00Z'): UserDecision {
  return {
    protocol_version: SECURITY_PROTOCOL_VERSION,
    decision_id: decision.decision_id,
    response: 'approved_once',
    decided_at: decidedAt,
  };
}

function userReject(decision: SecurityDecision, decidedAt = '2026-07-26T00:00:00Z'): UserDecision {
  return {
    protocol_version: SECURITY_PROTOCOL_VERSION,
    decision_id: decision.decision_id,
    response: 'rejected',
    decided_at: decidedAt,
  };
}

// ─────────────────────────────────────────────
// 测试
// ─────────────────────────────────────────────

describe('RuntimeSecurityGate', () => {
  // ─── allow ───

  it('allow → 立即 AuthorizedAction,不调用 channel,executor 被调用一次', async () => {
    const executor = vi.fn(async () => 'done');
    const pendingStore = new InMemoryPendingDecisionStore();
    const channel = new DeferredUserDecisionChannel();
    const gate = new RuntimeSecurityGate({ pendingStore, channel });

    const { decision } = makeDecision({ behavior: 'allow' });

    const result = await gate.execute(decision, executor);

    expect(result).toBe('done');
    expect(executor).toHaveBeenCalledTimes(1);
    expect(channel.requestCalls).toHaveLength(0);
    expect(pendingStore.saved).toHaveLength(0); // allow 不写 pending
  });

  it('allow (AuthorizedAction 形态) decision_id / action_snapshot_id 正确透传', async () => {
    const pendingStore = new InMemoryPendingDecisionStore();
    const channel = new DeferredUserDecisionChannel();
    const gate = new RuntimeSecurityGate({ pendingStore, channel });

    const { decision } = makeDecision({
      behavior: 'allow',
      decision_id: 'd-allow',
      action_snapshot_id: 'snap-1',
    });

    const auth = await gate.authorize(decision);

    expect(auth.kind).toBe('authorized');
    if (auth.kind === 'authorized') {
      expect(auth.decision_id).toBe('d-allow');
      expect(auth.action_snapshot_id).toBe('snap-1');
    }
  });

  // ─── deny ───

  it('deny → DeniedAction,executor 不被调用', async () => {
    const executor = vi.fn(async () => 'done');
    const pendingStore = new InMemoryPendingDecisionStore();
    const channel = new DeferredUserDecisionChannel();
    const gate = new RuntimeSecurityGate({ pendingStore, channel });

    const { decision } = makeDecision({
      behavior: 'deny',
      reason_code: 'permission.plan_write_blocked',
      human_reason: 'Plan mode blocks write operations',
    });

    const result = await gate.execute(decision, executor);

    expect(result).toMatchObject({
      kind: 'denied',
      decision_id: decision.decision_id,
      reason_code: 'permission.plan_write_blocked',
      human_reason: 'Plan mode blocks write operations',
    });
    expect(executor).not.toHaveBeenCalled();
    expect(channel.requestCalls).toHaveLength(0);
    expect(pendingStore.saved).toHaveLength(0); // deny 不写 pending
  });

  // ─── ask + 无通道(关键不变量:绝不降级为 allow) ───

  it('ask + channel=null → DeniedAction (reason_code=ask.no_channel),executor 不被调用', async () => {
    const executor = vi.fn(async () => 'done');
    const pendingStore = new InMemoryPendingDecisionStore();
    // 故意不传 channel
    const gate = new RuntimeSecurityGate({ pendingStore, channel: null });

    const { decision } = makeDecision({ behavior: 'ask' });

    const result = await gate.execute(decision, executor);

    expect(result).toMatchObject({
      kind: 'denied',
      decision_id: decision.decision_id,
      reason_code: 'ask.no_channel',
    });
    expect(executor).not.toHaveBeenCalled();
    // 即使无通道,也要把 pending 写盘(状态 expired / rejected),方便 resume 审计
    expect(pendingStore.saved).toHaveLength(1);
    expect(pendingStore.saved[0]!.status).toBe('awaiting_user');
    // 至少有一次 update 把 pending 标记为 expired/rejected
    expect(pendingStore.updates.length).toBeGreaterThanOrEqual(1);
  });

  // ─── ask + 通道(关键不变量:executor 在 approved_once 前不被调用) ───

  it('ask + channel:在 approved_once 到位前,executor 必须未被调用(零调用证据)', async () => {
    const executor = vi.fn(async () => 'done');
    const pendingStore = new InMemoryPendingDecisionStore();
    const channel = new DeferredUserDecisionChannel();
    const gate = new RuntimeSecurityGate({ pendingStore, channel });

    const { decision } = makeDecision({ behavior: 'ask' });

    const promise = gate.execute(decision, executor);

    // 让微任务队列跑一轮(channel.request 已被调用,promise 仍未决)
    await Promise.resolve();
    await Promise.resolve();

    // 关键断言:approved_once 到位前 executor 调用次数 = 0
    expect(executor).not.toHaveBeenCalled();
    expect(channel.requestCalls).toHaveLength(1);
    expect(channel.requestCalls[0]).toBe(decision);

    // 用户签字 → approved_once
    channel.resolve(userApprove(decision));

    await expect(promise).resolves.toBe('done');
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('ask + channel resolved approved_once (matching decision_id) → AuthorizedAction', async () => {
    const pendingStore = new InMemoryPendingDecisionStore();
    const channel = new DeferredUserDecisionChannel();
    const gate = new RuntimeSecurityGate({ pendingStore, channel });

    const { decision } = makeDecision({
      behavior: 'ask',
      decision_id: 'd-ask-1',
      action_snapshot_id: 'snap-1',
    });

    const promise = gate.authorize(decision);
    await Promise.resolve();
    channel.resolve(userApprove(decision));

    const auth = await promise;
    expect(auth).toMatchObject({
      kind: 'authorized',
      decision_id: 'd-ask-1',
      action_snapshot_id: 'snap-1',
    });
  });

  it('ask + channel resolved approved_once with WRONG decision_id → DeniedAction (ask.stale_decision_id),executor 不被调用', async () => {
    const executor = vi.fn(async () => 'done');
    const pendingStore = new InMemoryPendingDecisionStore();
    const channel = new DeferredUserDecisionChannel();
    const gate = new RuntimeSecurityGate({ pendingStore, channel });

    const { decision } = makeDecision({ behavior: 'ask', decision_id: 'd-real' });

    const promise = gate.execute(decision, executor);
    await Promise.resolve();

    // 通道回了一个不匹配的 decision_id(陈旧 / 错位的 user decision)
    channel.resolve({
      protocol_version: SECURITY_PROTOCOL_VERSION,
      decision_id: 'd-other',
      response: 'approved_once',
      decided_at: '2026-07-26T00:00:00Z',
    });

    const result = await promise;
    expect(result).toMatchObject({
      kind: 'denied',
      decision_id: 'd-real',
      reason_code: 'ask.stale_decision_id',
    });
    expect(executor).not.toHaveBeenCalled();
  });

  it('ask + channel resolved rejected → DeniedAction (ask.user_rejected),executor 不被调用', async () => {
    const executor = vi.fn(async () => 'done');
    const pendingStore = new InMemoryPendingDecisionStore();
    const channel = new DeferredUserDecisionChannel();
    const gate = new RuntimeSecurityGate({ pendingStore, channel });

    const { decision } = makeDecision({ behavior: 'ask' });

    const promise = gate.execute(decision, executor);
    await Promise.resolve();
    channel.resolve(userReject(decision));

    const result = await promise;
    expect(result).toMatchObject({
      kind: 'denied',
      decision_id: decision.decision_id,
      reason_code: 'ask.user_rejected',
    });
    expect(executor).not.toHaveBeenCalled();
  });

  it('ask + channel rejects (通道故障) → DeniedAction,executor 不被调用', async () => {
    const executor = vi.fn(async () => 'done');
    const pendingStore = new InMemoryPendingDecisionStore();
    const channel = new DeferredUserDecisionChannel();
    const gate = new RuntimeSecurityGate({ pendingStore, channel });

    const { decision } = makeDecision({ behavior: 'ask' });

    const promise = gate.execute(decision, executor);
    await Promise.resolve();
    channel.rejectChannel(new Error('UI transport crashed'));

    const result = await promise;
    expect(result.kind).toBe('denied');
    if (result.kind === 'denied') {
      expect(result.decision_id).toBe(decision.decision_id);
      // 通道故障的具体 reason_code 由实现决定,但必须是 denied(绝不放行)
    }
    expect(executor).not.toHaveBeenCalled();
  });

  // ─── approved_once 一次即消费(无 memoize) ───

  it('approved_once 不可重放:两次独立 ask decision 各自走一次 channel(无跨 decision 缓存)', async () => {
    const executor = vi.fn(async (i: number) => `done-${i}`);
    const pendingStore = new InMemoryPendingDecisionStore();
    const channel = new DeferredUserDecisionChannel();
    const gate = new RuntimeSecurityGate({ pendingStore, channel });

    const { decision: d1 } = makeDecision({ behavior: 'ask', decision_id: 'd-1' });
    const { decision: d2 } = makeDecision({ behavior: 'ask', decision_id: 'd-2' });

    const p1 = gate.execute(d1, () => executor(1));
    await Promise.resolve();
    channel.resolve(userApprove(d1));
    await expect(p1).resolves.toBe('done-1');

    // 第二个 ask decision:必须重新走 channel(没有"上次签过字"的缓存)
    const p2 = gate.execute(d2, () => executor(2));
    await Promise.resolve();
    expect(channel.requestCalls).toHaveLength(2); // 第二次 ask 也调了 channel.request
    channel.resolve(userApprove(d2));
    await expect(p2).resolves.toBe('done-2');

    expect(executor).toHaveBeenCalledTimes(2);
  });

  // ─── action snapshot 变更 → 旧 approved_once 失效 ───

  it('action snapshot 改变 → 旧 decision_id 不再有效(新 snapshot 是独立 ask)', async () => {
    const executor = vi.fn(async () => 'done');
    const pendingStore = new InMemoryPendingDecisionStore();
    const channel = new DeferredUserDecisionChannel();
    const gate = new RuntimeSecurityGate({ pendingStore, channel });

    // 同一 decision_id,但 action snapshot 变了(模拟 content/target/params/provenance 变化)
    const { decision: d1 } = makeDecision({
      behavior: 'ask',
      decision_id: 'd-same',
      action_snapshot_id: 'snap-old',
    });
    const { decision: d2 } = makeDecision({
      behavior: 'ask',
      decision_id: 'd-same',
      action_snapshot_id: 'snap-new',
    });

    const p1 = gate.execute(d1, executor);
    await Promise.resolve();
    channel.resolve(userApprove(d1));
    await expect(p1).resolves.toBe('done');
    expect(executor).toHaveBeenCalledTimes(1);

    // 第二次:同 decision_id,但 snapshot 不同 → 必须重新 ask(snap-new 不复用 snap-old 的批准)
    const p2 = gate.execute(d2, executor);
    await Promise.resolve();
    expect(channel.requestCalls).toHaveLength(2);
    channel.resolve(userApprove(d2));
    await expect(p2).resolves.toBe('done');
    expect(executor).toHaveBeenCalledTimes(2);
  });

  // ─── pending 持久化 ───

  it('ask 时把 PendingSecurityDecision 写入 store(awaiting_user 状态)', async () => {
    const pendingStore = new InMemoryPendingDecisionStore();
    const channel = new DeferredUserDecisionChannel();
    // gate 的 sessionId 通过 options 传入(security decision 本身不带 session_id)
    const gate = new RuntimeSecurityGate({ pendingStore, channel, sessionId: 'sess-test' });

    const { decision } = makeDecision({ behavior: 'ask', decision_id: 'd-pending' });

    const promise = gate.authorize(decision);
    await Promise.resolve();

    expect(pendingStore.saved).toHaveLength(1);
    const pending = pendingStore.saved[0]!;
    expect(pending.decision_id).toBe('d-pending');
    expect(pending.action_snapshot_id).toBe(decision.action.snapshot_id);
    expect(pending.session_id).toBe('sess-test');
    expect(pending.status).toBe('awaiting_user');
    expect(pending.resolved_at).toBeNull();
    expect(pending.user_decision_ref).toBeNull();
    expect(typeof pending.created_at).toBe('string');
    expect(typeof pending.decision_id).toBe('string');

    channel.resolve(userApprove(decision));
    await promise;
  });

  it('approved_once 后 pending 被 update 为 approved_once 状态(resolved_at + user_decision_ref)', async () => {
    const pendingStore = new InMemoryPendingDecisionStore();
    const channel = new DeferredUserDecisionChannel();
    const gate = new RuntimeSecurityGate({ pendingStore, channel });

    const { decision } = makeDecision({ behavior: 'ask', decision_id: 'd-resolve' });

    const promise = gate.authorize(decision);
    await Promise.resolve();
    channel.resolve(userApprove(decision));
    await promise;

    const approvalUpdate = pendingStore.updates.find(
      u => u.decisionId === 'd-resolve' && u.update.status === 'approved_once',
    );
    expect(approvalUpdate, 'expected pending to be updated to approved_once').toBeDefined();
    expect(approvalUpdate!.update.resolved_at).toBeTruthy();
    expect(approvalUpdate!.update.user_decision_ref).toBeTruthy();
  });

  it('rejected 后 pending 被 update 为 rejected 状态', async () => {
    const pendingStore = new InMemoryPendingDecisionStore();
    const channel = new DeferredUserDecisionChannel();
    const gate = new RuntimeSecurityGate({ pendingStore, channel });

    const { decision } = makeDecision({ behavior: 'ask', decision_id: 'd-rej' });

    const promise = gate.authorize(decision);
    await Promise.resolve();
    channel.resolve(userReject(decision));
    await promise;

    const rejectionUpdate = pendingStore.updates.find(
      u => u.decisionId === 'd-rej' && u.update.status === 'rejected',
    );
    expect(rejectionUpdate, 'expected pending to be updated to rejected').toBeDefined();
  });

  it('channel=null 时 pending 被 update 为 expired', async () => {
    const pendingStore = new InMemoryPendingDecisionStore();
    const gate = new RuntimeSecurityGate({ pendingStore, channel: null });

    const { decision } = makeDecision({ behavior: 'ask', decision_id: 'd-expired' });

    await gate.authorize(decision);

    const expiredUpdate = pendingStore.updates.find(
      u => u.decisionId === 'd-expired' && u.update.status === 'expired',
    );
    expect(expiredUpdate, 'expected pending to be updated to expired when channel is null').toBeDefined();
  });

  // ─── 不写永久 allow 规则 / 不产 tool result 占位 ───
  // (这两个不变量在单元层通过 "PendingDecisionStore 上没有 allow rule 写入" 与
  //  "RuntimeSecurityGate 没有任何 tool-result 输出字段" 来间接验证。
  //  由于 PendingDecisionStore 接口本身只暴露 save/load/update,
  //  这里通过断言 store.updates 里只有 status 变更、没有"创建 allow rule"来保证。)

  it('approve 后 store 上只有 status/resolved_at/user_decision_ref 的 update,没有写入永久 allow 规则', async () => {
    const pendingStore = new InMemoryPendingDecisionStore();
    const channel = new DeferredUserDecisionChannel();
    const gate = new RuntimeSecurityGate({ pendingStore, channel });

    const { decision } = makeDecision({ behavior: 'ask' });

    const promise = gate.authorize(decision);
    await Promise.resolve();
    channel.resolve(userApprove(decision));
    await promise;

    // 所有 update 只触及允许的字段,没有出现 "rule"/"allow_rule" 之类的字段
    for (const u of pendingStore.updates) {
      const keys = Object.keys(u.update).sort();
      // 合法键集合:{ resolved_at, status, user_decision_ref } 的子集
      for (const k of keys) {
        expect(['status', 'resolved_at', 'user_decision_ref']).toContain(k);
      }
    }
  });
});
