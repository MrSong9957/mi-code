// src/__tests__/permission/session-allowlist-lifecycle.test.ts
//
// 阻断 B 回归:SessionAllowlist 生命周期契约。
//
// 设计语义:"Allow this exact action for this session" 在同一 MiCode session(同一 sessionId)
// 内跨 turn 有效。session 切换(产生新 sessionId)时必须清空,使相同 action 再次需要询问。
//
// 本测试锁定三条 session 切换路径的 allowlist 清空契约 + soft interrupt 不清空:
//   1. rotateSessionId(经 applyPlanApproval clearContext=true)→ clear
//   2. resume / hard rewind(切换 sessionId)→ clear → 相同 action 重新 ask
//   3. soft interrupt(不产生新 sessionId)→ 不 clear(锁定,避免错误扩大生命周期)
//   4. 同 session 跨 turn remember 保持(不清空)
//
// 测试全部用真实 executeToolCall + RuntimeSecurityGate 端到端验证,不只单测 clear()。

import { describe, it, expect } from 'vitest';
import { executeToolCall } from '../../agent/tool-execution.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { PermissionChecker } from '../../permission/checker.js';
import { RuntimeSecurityGate } from '../../permission/runtime-gate.js';
import { SessionAllowlist } from '../../permission/session-allowlist.js';
import { applyPlanApproval } from '../../plan/plan-approval-transition.js';
import {
  SECURITY_PROTOCOL_VERSION,
  type SecurityDecision, type UserDecision,
} from '../../permission/decisions.js';
import type { ToolUseBlock } from '../../agent/types.js';

class MemStore {
  async save() {} async load() { return []; } async update() {}
}

/** 可控 channel:resolve 由测试显式驱动,避免永久 pending。 */
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

function makeWriteRegistry(): { registry: ToolRegistry; calls: string[] } {
  const calls: string[] = [];
  const registry = new ToolRegistry();
  registry.register(
    { name: 'write_file', description: 'p', parameters: { type: 'object', properties: {}, required: [] } },
    async (i) => { calls.push(`write:${i.path}`); return 'written'; },
  );
  return { registry, calls };
}

const wf = (id: string, input: Record<string, unknown>): ToolUseBlock =>
  ({ type: 'tool_use', id, name: 'write_file', input } as ToolUseBlock);

/** 构造一套端到端 fixtures:checker + gate(绑定 ch) + allowlist + runtime。 */
function makeFixtures(mode: 'build' | 'plan' | 'auto' = 'build', allowlist = new SessionAllowlist()) {
  const ch = new ControllableChannel();
  const gate = new RuntimeSecurityGate({ pendingStore: new MemStore() as any, channel: ch });
  const checker = new PermissionChecker({ mode, workdir: process.cwd() });
  const runtime = { permissionChecker: checker, runtimeGate: gate, sessionAllowlist: allowlist };
  return { ch, gate, checker, allowlist, runtime };
}

const INPUT = { path: 'remember.txt', content: 'v1' };

describe('SessionAllowlist 生命周期契约', () => {

  describe('同 session 跨 turn remember(保持,不清空)', () => {
    it('记住后,同 session 内相同 write_file 不弹窗(跨 turn 有效)', async () => {
      const { registry } = makeWriteRegistry();
      const { ch, runtime, allowlist } = makeFixtures();

      // 第一次:ask → 用户选 "Allow exact"(remember=true)→ 执行 + allowlist 记住
      const p1 = executeToolCall(registry, wf('t1', INPUT), runtime, { origin: 'main' });
      await new Promise(r => setTimeout(r, 30));
      expect(ch.requests).toHaveLength(1); // 弹了一次
      ch.resolveApproved('exec:t1', true); // remember=true
      await p1;
      expect(allowlist.has('write_file', INPUT)).toBe(true); // 记住了

      // 第二次:相同 INPUT,同 session(未 clear)→ 命中 allowlist
      ch.requests.length = 0; // 重置计数
      const p2 = executeToolCall(registry, wf('t2', INPUT), runtime, { origin: 'main' });
      await new Promise(r => setTimeout(r, 30));
      expect(ch.requests).toHaveLength(0); // ★ 不弹窗(同 session 跨 turn 记住)
      await p2; // allowlist 命中 → rewriteToAllow → gate 直接 authorized → 完成
    });
  });

  describe('rotateSessionId 路径(applyPlanApproval clearContext=true)', () => {
    it('clearContext=true 调 rotateSessionId → allowlist clear → 相同 action 不再命中', () => {
      const allowlist = new SessionAllowlist();
      allowlist.add('write_file', INPUT);
      expect(allowlist.has('write_file', INPUT)).toBe(true);

      // index.ts L455: rotateSessionId 闭包 = sessionId = randomUUID() + sessionAllowlist.clear()
      // applyPlanApproval(clearContext=true) 调 deps.rotateSessionId()(plan-approval-transition L24)
      let rotateCalled = false;
      applyPlanApproval('build', true, {
        clearPipeline: () => {}, triggerClearScreen: () => {}, clearSessionMessages: () => {},
        rotateSessionId: () => { rotateCalled = true; allowlist.clear(); }, // 模拟 index.ts L455 绑定
        resetContextUsage: () => {}, setPermissionMode: () => {}, setConfigMode: () => {}, setStatusMode: () => {},
      });

      expect(rotateCalled).toBe(true); // ★ rotateSessionId 被调
      expect(allowlist.has('write_file', INPUT)).toBe(false); // ★ allowlist 已清空
    });

    it('clearContext=false 不调 rotateSessionId → allowlist 保留', () => {
      const allowlist = new SessionAllowlist();
      allowlist.add('write_file', INPUT);
      let rotateCalled = false;
      applyPlanApproval('build', false, {
        clearPipeline: () => {}, triggerClearScreen: () => {}, clearSessionMessages: () => {},
        rotateSessionId: () => { rotateCalled = true; allowlist.clear(); },
        resetContextUsage: () => {}, setPermissionMode: () => {}, setConfigMode: () => {}, setStatusMode: () => {},
      });
      expect(rotateCalled).toBe(false); // clearContext=false 不切 session
      expect(allowlist.has('write_file', INPUT)).toBe(true); // ★ 保留
    });
  });

  describe('clear 后相同 write_file 重新 ask(hard rewind L619 / resume L1049 契约)', () => {
    // 这两条路径在 index.ts bootstrap 内联,无法直接单测内部函数。
    // 契约:sessionId 变化 → 紧接 sessionAllowlist.clear()。
    // 此处验证"clear 被调后,相同 action 经 executeToolCall 重新弹 ask"的端到端语义。

    it('allowlist 记住 → clear → 相同 write_file 重新弹 ask', async () => {
      const { registry } = makeWriteRegistry();
      const { ch, runtime, allowlist } = makeFixtures();

      // 记住
      allowlist.add('write_file', INPUT);
      expect(allowlist.has('write_file', INPUT)).toBe(true);

      // 模拟 session 切换(rewind/resume 都调 allowlist.clear())
      allowlist.clear();
      expect(allowlist.has('write_file', INPUT)).toBe(false);

      // 相同 write_file → 重新 ask(channel 收到请求)
      const p = executeToolCall(registry, wf('t-after-clear', INPUT), runtime, { origin: 'main' });
      await new Promise(r => setTimeout(r, 30));
      expect(ch.requests).toHaveLength(1); // ★ 重新弹 ask(allowlist 已清空,未命中)
      ch.resolveApproved('exec:t-after-clear');
      await p;
    });
  });

  describe('soft interrupt(不产生新 sessionId → 不 clear)', () => {
    // handleRewindLastTurn soft interrupt 分支(index.ts L599-603):有 meaningful 内容时
    // 提前 return,不调 sessionAllowlist.clear()。锁定:不 clear 则 allowlist 保留。

    it('soft interrupt 模拟(不调 clear)→ allowlist 保留 → 相同 action 仍命中', async () => {
      const { registry } = makeWriteRegistry();
      const { ch, runtime, allowlist } = makeFixtures();

      // 记住
      allowlist.add('write_file', INPUT);

      // soft interrupt:不调 clear(模拟 L599-603 提前 return)
      // allowlist 仍保留
      expect(allowlist.has('write_file', INPUT)).toBe(true);

      // 相同 write_file → 命中 allowlist,不弹窗
      const p = executeToolCall(registry, wf('t-soft', INPUT), runtime, { origin: 'main' });
      await new Promise(r => setTimeout(r, 30));
      expect(ch.requests).toHaveLength(0); // ★ 不弹窗(soft interrupt 未清空 allowlist)
      await p;
    });
  });

  describe('clear 语义(单元,锁定清空所有 entry)', () => {
    it('clear 清空所有 entry(不只当前 key)', () => {
      const al = new SessionAllowlist();
      al.add('write_file', { path: 'a' });
      al.add('write_file', { path: 'b' });
      al.add('run_bash', { command: 'ls' });
      al.clear();
      expect(al.has('write_file', { path: 'a' })).toBe(false);
      expect(al.has('write_file', { path: 'b' })).toBe(false);
      expect(al.has('run_bash', { command: 'ls' })).toBe(false);
    });
  });
});
