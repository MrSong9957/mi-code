import { describe, it, expect, vi } from 'vitest';
import { executeToolCall } from '../../agent/tool-execution.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { PermissionChecker } from '../../permission/checker.js';
import { RuntimeSecurityGate } from '../../permission/runtime-gate.js';
import { SessionAllowlist } from '../../permission/session-allowlist.js';
import {
  SECURITY_PROTOCOL_VERSION,
  type SecurityDecision, type UserDecision,
} from '../../permission/decisions.js';
import type { ToolUseBlock } from '../../agent/types.js';

class MemStore {
  async save() {} async load() { return []; } async update() {}
}

/** 可控 channel:resolve 不自动,测试显式驱动,避免永久 pending。 */
class ControllableChannel {
  public requests: SecurityDecision[] = [];
  private resolver: ((u: UserDecision) => void) | null = null;
  async request(d: SecurityDecision) {
    this.requests.push(d);
    return new Promise<UserDecision>(resolve => { this.resolver = resolve; });
  }
  resolveApproved(id: string, remember = false) {
    const r = this.resolver!; this.resolver = null;
    r({ protocol_version: SECURITY_PROTOCOL_VERSION, decision_id: id, response: 'approved_once', decided_at: new Date().toISOString(), remember });
  }
}

function makeRegistry(): { registry: ToolRegistry; calls: string[] } {
  const calls: string[] = [];
  const registry = new ToolRegistry();
  registry.register(
    { name: 'write_file', description: 'p', parameters: { type: 'object', properties: {}, required: [] } },
    async (i) => { calls.push(`write:${i.path}`); return 'written'; },
  );
  registry.register(
    { name: 'run_bash', description: 'p', parameters: { type: 'object', properties: {}, required: [] } },
    async (i) => { calls.push(`bash:${i.command}`); return 'done'; },
  );
  return { registry, calls };
}

function makeRuntime(mode: 'build' | 'auto', channel: any, allowlist?: SessionAllowlist) {
  const checker = new PermissionChecker({ mode, workdir: process.cwd() });
  const gate = new RuntimeSecurityGate({ pendingStore: new MemStore() as any, channel });
  // spy gate.execute:锁定"所有执行路径统一经 gate"(修订点 1)
  const executeSpy = vi.spyOn(gate, 'execute');
  return { permissionChecker: checker, runtimeGate: gate, sessionAllowlist: allowlist, executeSpy };
}

const wf = (id: string, input: Record<string, unknown>): ToolUseBlock =>
  ({ type: 'tool_use', id, name: 'write_file', input } as ToolUseBlock);
const rb = (id: string, cmd: string): ToolUseBlock =>
  ({ type: 'tool_use', id, name: 'run_bash', input: { command: cmd } } as ToolUseBlock);

describe('executeToolCall origin 路由(端到端)', () => {
  it('子代理普通 write → 静默 allow,不弹 channel,执行了', async () => {
    const { registry, calls } = makeRegistry();
    const ch = new ControllableChannel();
    const rt = makeRuntime('build', ch);
    const r = await executeToolCall(registry, wf('t1', { path: 'a.txt', content: 'x' }), rt, { origin: 'subagent' });
    expect(r.status).toBe('success');
    expect(ch.requests).toHaveLength(0); // ★ 不弹 UI
    expect(calls).toEqual(['write:a.txt']); // ★ 执行了
  });

  it('子代理危险命令 → deny,不执行不弹 channel', async () => {
    const { registry, calls } = makeRegistry();
    const ch = new ControllableChannel();
    const rt = makeRuntime('build', ch);
    const r = await executeToolCall(registry, rb('t2', 'rm -rf /home'), rt, { origin: 'subagent' });
    expect(r.status).toBe('failure');
    expect(ch.requests).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('子代理变量未知 bash → 静默 deny,不弹 channel', async () => {
    const { registry, calls } = makeRegistry();
    const ch = new ControllableChannel();
    const rt = makeRuntime('build', ch);
    const r = await executeToolCall(registry, rb('t3', 'echo $UNDEFINED_X'), rt, { origin: 'subagent' });
    expect(r.status).toBe('failure');
    expect(ch.requests).toHaveLength(0); // ★ safety_uncertain 静默 deny
    expect(calls).toHaveLength(0);
  });

  it('主 Agent 变量未知 bash → 仍询问(channel 收到请求)', async () => {
    const { registry } = makeRegistry();
    const ch = new ControllableChannel();
    const rt = makeRuntime('build', ch);
    const p = executeToolCall(registry, rb('t4', 'echo $UNDEFINED_X'), rt, { origin: 'main' });
    await new Promise(r => setTimeout(r, 30));
    expect(ch.requests).toHaveLength(1); // ★ 主 Agent 仍询问
    // 测试驱动:resolve 让 promise 完成,避免悬挂
    ch.resolveApproved('exec:t4');
    await p;
  });

  it('主 Agent remembered 命令 → 不询问,且仍经 gate.execute(不绕过)', async () => {
    const { registry, calls } = makeRegistry();
    const ch = new ControllableChannel();
    const al = new SessionAllowlist();
    al.add('write_file', { path: 'a.txt', content: 'x' });
    const rt = makeRuntime('build', ch, al);
    const r = await executeToolCall(registry, wf('t5', { path: 'a.txt', content: 'x' }), rt, { origin: 'main' });
    expect(r.status).toBe('success');
    expect(ch.requests).toHaveLength(0); // ★ allowlist 命中 → decision 改写为 allow → gate 不弹 channel
    expect(calls).toEqual(['write:a.txt']);
    // ★★★ 锁定:allowlist hit 仍统一经 gate.execute(修订点 1:不绕过 gate)
    expect(rt.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('主 Agent 不同命令 → 仍询问', async () => {
    const { registry } = makeRegistry();
    const ch = new ControllableChannel();
    const al = new SessionAllowlist();
    al.add('write_file', { path: 'a.txt', content: 'x' });
    const rt = makeRuntime('build', ch, al);
    const p = executeToolCall(registry, wf('t6', { path: 'b.txt', content: 'x' }), rt, { origin: 'main' });
    await new Promise(r => setTimeout(r, 30));
    expect(ch.requests).toHaveLength(1); // ★ 不命中,仍询问
    ch.resolveApproved('exec:t6');
    await p;
  });

  it('remembered 即使命中危险规则也 deny(allowlist 不覆盖 deny)', async () => {
    const { registry, calls } = makeRegistry();
    const ch = new ControllableChannel();
    const al = new SessionAllowlist();
    al.add('run_bash', { command: 'rm -rf /home' }); // 假装记过
    const rt = makeRuntime('build', ch, al);
    const r = await executeToolCall(registry, rb('t7', 'rm -rf /home'), rt, { origin: 'main' });
    expect(r.status).toBe('failure'); // ★ deny 优先
    expect(ch.requests).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('主 Agent 选 remember → gate onAuthorized 写入 allowlist', async () => {
    const { registry } = makeRegistry();
    const ch = new ControllableChannel();
    const al = new SessionAllowlist();
    const rt = makeRuntime('build', ch, al);
    const input = { path: 'c.txt', content: 'y' };
    const p = executeToolCall(registry, wf('t8', input), rt, { origin: 'main' });
    await new Promise(r => setTimeout(r, 30));
    expect(ch.requests).toHaveLength(1);
    // 用户选 "Allow this exact action for this session" → remember=true
    ch.resolveApproved('exec:t8', true);
    await p;
    // ★ allowlist 现在记住此 action
    expect(al.has('write_file', input)).toBe(true);
  });
});
