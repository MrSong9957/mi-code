import { describe, it, expect } from 'vitest';
import { applySubagentSilentPolicy, rewriteToAllow } from '../../permission/subagent-silent-policy.js';
import { createSecurityDecision, SECURITY_PROTOCOL_VERSION } from '../../permission/decisions.js';
import type { SecurityDecision } from '../../permission/decisions.js';

function makeDecision(
  behavior: 'allow' | 'ask' | 'deny',
  reasonCode: string,
): SecurityDecision {
  return createSecurityDecision({
    protocol_version: SECURITY_PROTOCOL_VERSION,
    decision_id: 'test-1',
    action: { kind: 'tool_call', subject_id: 'write_file', snapshot_id: 'snap-1' },
    behavior,
    deciding_layer: 'permission',
    risk_kind: 'test',
    policy_id: 'test',
    policy_version: '1',
    reason_code: reasonCode,
    human_reason: 'test',
    provenance_refs: behavior === 'allow' ? ['test'] : [],
  });
}

describe('applySubagentSilentPolicy', () => {
  it('build_write_confirmation(user_confirmation_required)→ 静默 allow', () => {
    const out = applySubagentSilentPolicy(makeDecision('ask', 'permission.user_confirmation_required'));
    expect(out.behavior).toBe('allow');
  });

  it('command_unparseable → 静默 deny', () => {
    const out = applySubagentSilentPolicy(makeDecision('ask', 'permission.command_unparseable'));
    expect(out.behavior).toBe('deny');
  });

  it('command_unresolvable_var(新增)→ 静默 deny', () => {
    const out = applySubagentSilentPolicy(makeDecision('ask', 'permission.command_unresolvable_var'));
    expect(out.behavior).toBe('deny');
  });

  it('危险命令 deny → 透传(引用相等)', () => {
    const d = makeDecision('deny', 'permission.dangerous_command');
    expect(applySubagentSilentPolicy(d)).toBe(d);
  });

  it('allow → 透传(引用相等)', () => {
    const d = makeDecision('allow', 'permission.default');
    expect(applySubagentSilentPolicy(d)).toBe(d);
  });

  it('未知 ask → fail-closed deny', () => {
    const out = applySubagentSilentPolicy(makeDecision('ask', 'permission.future_unknown'));
    expect(out.behavior).toBe('deny');
  });
});

describe('rewriteToAllow', () => {
  it('把 ask 改成 allow 且 reason_code=session_allowlist_hit(保留 action/identity/provenance)', () => {
    // 用带非空 provenance 的 ask 作为 base,精确验证"保留 provenance"语义
    const base = createSecurityDecision({
      protocol_version: SECURITY_PROTOCOL_VERSION,
      decision_id: 'allowlist-base-1',
      action: { kind: 'tool_call', subject_id: 'write_file', snapshot_id: 'snap-1' },
      behavior: 'ask',
      deciding_layer: 'permission',
      risk_kind: 'test',
      policy_id: 'test',
      policy_version: '1',
      reason_code: 'permission.user_confirmation_required',
      human_reason: 'test',
      provenance_refs: ['checker:reasoning-1', 'context:subagent'],
    });
    const out = rewriteToAllow(base);
    expect(out.behavior).toBe('allow');
    expect(out.reason_code).toBe('permission.session_allowlist_hit');
    // 保留 action / identity / provenance
    expect(out.action).toEqual(base.action);
    expect(out.decision_id).toBe(base.decision_id);
    expect(out.deciding_layer).toBe(base.deciding_layer);
    expect(out.policy_id).toBe(base.policy_id);
    expect(out.policy_version).toBe(base.policy_version);
    expect(out.provenance_refs).toEqual(base.provenance_refs);
    // 不能原地改(frozen + 新对象)
    expect(base.behavior).toBe('ask');
    expect(out).not.toBe(base);
  });

  it('base 无 provenance 时注入 allowlist 来源标签(满足 allow 非空约束)', () => {
    const base = makeDecision('ask', 'permission.user_confirmation_required');
    const out = rewriteToAllow(base);
    expect(out.behavior).toBe('allow');
    expect(out.reason_code).toBe('permission.session_allowlist_hit');
    expect(out.provenance_refs).toEqual(['permission:session-allowlist']);
  });
});
