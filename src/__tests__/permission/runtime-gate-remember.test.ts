import { describe, it, expect } from 'vitest';
import { RuntimeSecurityGate } from '../../permission/runtime-gate.js';
import { createSecurityDecision, SECURITY_PROTOCOL_VERSION, type SecurityDecision, type UserDecision } from '../../permission/decisions.js';

class MemStore {
  public saved: any[] = [];
  async save(p: any) { this.saved.push({ ...p }); }
  async load() { return [...this.saved]; }
  async update() {}
}

class ControllableChannel {
  public requests: SecurityDecision[] = [];
  private resolver: ((u: UserDecision) => void) | null = null;
  async request(d: SecurityDecision) {
    this.requests.push(d);
    return new Promise<UserDecision>(resolve => { this.resolver = resolve; });
  }
  resolve(u: UserDecision) { const r = this.resolver!; this.resolver = null; r(u); }
}

function askDecision(id: string): SecurityDecision {
  return createSecurityDecision({
    protocol_version: SECURITY_PROTOCOL_VERSION,
    decision_id: id,
    action: { kind: 'tool_call', subject_id: 'write_file', snapshot_id: `snap-${id}` },
    behavior: 'ask',
    deciding_layer: 'permission',
    risk_kind: 'workspace_mutation',
    policy_id: 'test', policy_version: '1',
    reason_code: 'permission.user_confirmation_required',
    human_reason: 'test',
    provenance_refs: ['test'],
  });
}

describe('RuntimeSecurityGate remember 透传', () => {
  it('execute 的 onAuthorized 回调在 authorized 后、executor 前触发,携带 remember', async () => {
    const channel = new ControllableChannel();
    const gate = new RuntimeSecurityGate({ pendingStore: new MemStore() as any, channel: channel as any });
    const authorized: any[] = [];
    let executorCalled = false;

    const promise = gate.execute(
      askDecision('d1'),
      async () => { executorCalled = true; return 'done'; },
      { onAuthorized: (a) => { authorized.push(a); } },
    );

    // 等 channel 收到请求后,resolve approved_once + remember
    await new Promise(r => setTimeout(r, 20));
    expect(channel.requests).toHaveLength(1);
    expect(executorCalled).toBe(false); // 还未 authorized

    channel.resolve({
      protocol_version: SECURITY_PROTOCOL_VERSION,
      decision_id: 'd1',
      response: 'approved_once',
      decided_at: new Date().toISOString(),
      remember: true,
    });

    const result = await promise;
    expect(result).toBe('done');
    expect(executorCalled).toBe(true);
    expect(authorized).toHaveLength(1);
    expect(authorized[0].remember).toBe(true); // ★ 回调收到 remember 元数据
  });

  it('onAuthorized 在 denied 时不触发', async () => {
    const gate = new RuntimeSecurityGate({ pendingStore: new MemStore() as any, channel: null });
    const authorized: any[] = [];
    const result = await gate.execute(
      askDecision('d2'),
      async () => 'should-not-run',
      { onAuthorized: () => { authorized.push(true); } },
    );
    // channel=null → fail-closed denied
    expect((result as any).kind).toBe('denied');
    expect(authorized).toHaveLength(0);
  });

  it('无 onAuthorized 回调时行为不变(向后兼容)', async () => {
    const channel = new ControllableChannel();
    const gate = new RuntimeSecurityGate({ pendingStore: new MemStore() as any, channel: channel as any });
    const promise = gate.execute(askDecision('d3'), async () => 'done');
    await new Promise(r => setTimeout(r, 10));
    channel.resolve({
      protocol_version: SECURITY_PROTOCOL_VERSION,
      decision_id: 'd3',
      response: 'approved_once',
      decided_at: new Date().toISOString(),
    });
    expect(await promise).toBe('done');
  });

  // ★ 修订点 3:onAuthorized 是 non-interfering observer——throw 不阻止 executor
  it('onAuthorized throws → executor 仍恰好执行一次,返回 executor 结果', async () => {
    const channel = new ControllableChannel();
    const gate = new RuntimeSecurityGate({ pendingStore: new MemStore() as any, channel: channel as any });
    let executorCalls = 0;
    const promise = gate.execute(
      askDecision('d4'),
      async () => { executorCalls++; return 'done'; },
      { onAuthorized: () => { throw new Error('observer exploded'); } },
    );
    await new Promise(r => setTimeout(r, 10));
    channel.resolve({
      protocol_version: SECURITY_PROTOCOL_VERSION,
      decision_id: 'd4',
      response: 'approved_once',
      decided_at: new Date().toISOString(),
    });
    // ★ observer throw 不传播:execute 返回 executor 结果,不 reject
    const result = await promise;
    expect(result).toBe('done');
    expect(executorCalls).toBe(1); // ★ executor 恰好执行一次(未被 observer 阻止)
  });
});
