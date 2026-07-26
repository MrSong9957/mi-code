// RC-5 SecurityDecision 单元测试
//
// 物理本质：安检员的工作守则——
//   - 必须有合法身份（requireIdentity）才能开决策单；
//   - 决策单一旦开出就 immutable（frozen）；
//   - 决策单绝不携带 approved 字段（Wave A 不实现 ask 通道）；
//   - 多张决策单合并时取最严格（deny > ask > allow），并保留全部 provenance。
//
// 重点：human_reason 只是人类可读解释，绝不能参与任何机器分支判断。
import { describe, expect, it } from 'vitest';
import {
  createSecurityDecision,
  mergeSecurityDecisions,
  type CreateSecurityDecisionInput,
} from '../../permission/decisions.js';

const baseInput = (overrides: Partial<CreateSecurityDecisionInput> = {}): CreateSecurityDecisionInput => ({
  protocol_version: '1',
  decision_id: 'decision-1',
  action: { kind: 'tool_call', subject_id: 'run_bash', snapshot_id: 'action-1' },
  behavior: 'deny',
  deciding_layer: 'permission',
  risk_kind: 'workspace_mutation',
  policy_id: 'permission-default',
  policy_version: '1',
  reason_code: 'permission.deny',
  human_reason: 'some human explanation',
  provenance_refs: ['rule:default'],
  ...overrides,
});

const decision = (behavior: 'allow' | 'ask' | 'deny') =>
  createSecurityDecision(baseInput({
    decision_id: `decision-${behavior}`,
    behavior,
    reason_code: `permission.${behavior}`,
    human_reason: behavior,
    provenance_refs: ['rule:default'],
  }));

// ─────────────────────────────────────────────
// createSecurityDecision
// ─────────────────────────────────────────────

describe('createSecurityDecision - identity validation', () => {
  it('rejects empty decision_id', () => {
    expect(() => createSecurityDecision(baseInput({ decision_id: '' }))).toThrow();
  });
  it('rejects empty policy_id', () => {
    expect(() => createSecurityDecision(baseInput({ policy_id: '' }))).toThrow();
  });
  it('rejects empty policy_version', () => {
    expect(() => createSecurityDecision(baseInput({ policy_version: '' }))).toThrow();
  });
  it('rejects empty reason_code', () => {
    expect(() => createSecurityDecision(baseInput({ reason_code: '' }))).toThrow();
  });
  it('rejects empty protocol_version', () => {
    expect(() => createSecurityDecision(baseInput({ protocol_version: '' }))).toThrow();
  });
  it('rejects empty action.subject_id', () => {
    expect(() =>
      createSecurityDecision(
        baseInput({ action: { kind: 'tool_call', subject_id: '', snapshot_id: 's1' } }),
      ),
    ).toThrow();
  });
  it('rejects empty action.snapshot_id', () => {
    expect(() =>
      createSecurityDecision(
        baseInput({ action: { kind: 'tool_call', subject_id: 'run_bash', snapshot_id: '' } }),
      ),
    ).toThrow();
  });
  it('rejects whitespace-only identity fields', () => {
    expect(() => createSecurityDecision(baseInput({ decision_id: '   ' }))).toThrow();
  });
  it('rejects empty deciding_layer', () => {
    expect(() => createSecurityDecision(baseInput({ deciding_layer: '' }))).toThrow();
  });
});

describe('createSecurityDecision - behavior validation', () => {
  it('rejects unknown behavior', () => {
    // 未知 behavior 必须 throw —— fail closed at creator boundary
    expect(() =>
      createSecurityDecision(baseInput({ behavior: 'maybe' as 'allow' })),
    ).toThrow();
  });
  it('accepts allow with non-empty provenance', () => {
    expect(() =>
      createSecurityDecision(baseInput({ behavior: 'allow', provenance_refs: ['rule:x'] })),
    ).not.toThrow();
  });
  it('rejects allow with empty provenance_refs', () => {
    // 跨边界 action 无 provenance 不能 allow（spec §11.6.5）
    expect(() =>
      createSecurityDecision(baseInput({ behavior: 'allow', provenance_refs: [] })),
    ).toThrow();
  });
  it('accepts ask with empty provenance_refs', () => {
    expect(() =>
      createSecurityDecision(baseInput({ behavior: 'ask', provenance_refs: [] })),
    ).not.toThrow();
  });
  it('accepts deny with empty provenance_refs', () => {
    expect(() =>
      createSecurityDecision(baseInput({ behavior: 'deny', provenance_refs: [] })),
    ).not.toThrow();
  });
});

describe('createSecurityDecision - immutability & shape', () => {
  it('output is frozen', () => {
    const d = createSecurityDecision(baseInput());
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.action)).toBe(true);
    expect(Object.isFrozen(d.provenance_refs)).toBe(true);
  });

  it('output has NO approved property (Wave A)', () => {
    const d = createSecurityDecision(baseInput());
    expect((d as unknown as { approved?: unknown }).approved).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(d, 'approved')).toBe(false);
  });

  it('provenance_refs is a copy (mutating input array post-creation does not change output)', () => {
    const refs = ['rule:default'];
    const input = baseInput({ provenance_refs: refs });
    const d = createSecurityDecision(input);
    refs.push('rule:late-added');
    expect([...d.provenance_refs]).toEqual(['rule:default']);
  });

  it('action is a deep copy (mutating input action does not change output)', () => {
    const action = { kind: 'tool_call', subject_id: 'run_bash', snapshot_id: 'snap-1' };
    const d = createSecurityDecision(baseInput({ action }));
    action.snapshot_id = 'tampered';
    expect(d.action.snapshot_id).toBe('snap-1');
  });

  it('stores human_reason but never branches on it', () => {
    // 两个 decision 行为不同，但 human_reason 相同 ——
    // 输出的 behavior 应严格来自 input.behavior，不来自 human_reason。
    const a = createSecurityDecision(baseInput({ behavior: 'allow', human_reason: 'SAME', provenance_refs: ['r'] }));
    const b = createSecurityDecision(baseInput({ behavior: 'deny', human_reason: 'SAME' }));
    expect(a.behavior).toBe('allow');
    expect(b.behavior).toBe('deny');
    expect(a.human_reason).toBe('SAME');
    expect(b.human_reason).toBe('SAME');
  });
});

// ─────────────────────────────────────────────
// mergeSecurityDecisions
// ─────────────────────────────────────────────

describe('mergeSecurityDecisions - ranking', () => {
  it('merges deny over ask over allow', () => {
    expect(mergeSecurityDecisions([decision('allow'), decision('ask')]).behavior).toBe('ask');
    expect(mergeSecurityDecisions([decision('allow'), decision('deny')]).behavior).toBe('deny');
    expect(mergeSecurityDecisions([decision('ask'), decision('deny')]).behavior).toBe('deny');
  });

  it('ranking is by explicit rank map, not string compare', () => {
    // 'allow' < 'ask' < 'deny' in string order, but we explicitly map;
    // 这条用例至少证明结果是 deny（最严格）而非任何字符串巧合。
    const merged = mergeSecurityDecisions([decision('allow'), decision('ask'), decision('deny')]);
    expect(merged.behavior).toBe('deny');
  });
});

describe('mergeSecurityDecisions - fail closed', () => {
  it('fails closed when policy evaluation fails (empty input → deny)', () => {
    const merged = mergeSecurityDecisions([]);
    expect(merged.behavior).toBe('deny');
    expect(merged.reason_code).toBe('policy.missing');
    expect(merged.risk_kind).toBe('policy_failure');
    expect(merged.provenance_refs).toEqual(['policy:missing']);
  });

  it('empty-input result is frozen', () => {
    const merged = mergeSecurityDecisions([]);
    expect(Object.isFrozen(merged)).toBe(true);
  });
});

describe('mergeSecurityDecisions - provenance union', () => {
  it('union of provenance: inputs with [a] and [b] → merged has both sorted+deduped', () => {
    const a = createSecurityDecision(
      baseInput({ decision_id: 'd-a', behavior: 'deny', provenance_refs: ['b'] }),
    );
    const b = createSecurityDecision(
      baseInput({ decision_id: 'd-b', behavior: 'deny', provenance_refs: ['a'] }),
    );
    const merged = mergeSecurityDecisions([a, b]);
    expect([...merged.provenance_refs]).toEqual(['a', 'b']);
  });

  it('dedupes identical provenance refs', () => {
    const a = createSecurityDecision(
      baseInput({ decision_id: 'd-a', behavior: 'deny', provenance_refs: ['a', 'b'] }),
    );
    const b = createSecurityDecision(
      baseInput({ decision_id: 'd-b', behavior: 'deny', provenance_refs: ['b', 'c'] }),
    );
    const merged = mergeSecurityDecisions([a, b]);
    expect([...merged.provenance_refs]).toEqual(['a', 'b', 'c']);
  });
});

describe('mergeSecurityDecisions - identity & determinism', () => {
  it('returns a NEW object (not a reference to any input)', () => {
    const a = decision('allow');
    const b = decision('deny');
    const merged = mergeSecurityDecisions([a, b]);
    expect(merged).not.toBe(b);
    expect(merged).not.toBe(a);
    // 修改输入不能改变 merged（已经是新对象 + frozen）
    expect(Object.isFrozen(merged)).toBe(true);
  });

  it('deterministic for same inputs in different orders', () => {
    const a = createSecurityDecision(
      baseInput({ decision_id: 'd-a', behavior: 'deny', deciding_layer: 'permission', provenance_refs: ['x'] }),
    );
    const b = createSecurityDecision(
      baseInput({ decision_id: 'd-b', behavior: 'deny', deciding_layer: 'permission', provenance_refs: ['y'] }),
    );
    const m1 = mergeSecurityDecisions([a, b]);
    const m2 = mergeSecurityDecisions([b, a]);
    // winning decision should be the same (tiebreak deterministic)
    expect(m1.decision_id).toBe(m2.decision_id);
    expect([...m1.provenance_refs]).toEqual([...m2.provenance_refs]);
  });

  it('tiebreak: two decisions same behavior → winner is deciding_layer ASC then decision_id ASC', () => {
    const z = createSecurityDecision(
      baseInput({
        decision_id: 'z-decision',
        behavior: 'deny',
        deciding_layer: 'zeta',
        reason_code: 'permission.z',
        provenance_refs: ['z'],
      }),
    );
    const a = createSecurityDecision(
      baseInput({
        decision_id: 'a-decision',
        behavior: 'deny',
        deciding_layer: 'alpha',
        reason_code: 'permission.a',
        provenance_refs: ['a'],
      }),
    );
    const merged = mergeSecurityDecisions([z, a]);
    // alpha < zeta, so winner's reason_code is permission.a
    expect(merged.reason_code).toBe('permission.a');
    expect(merged.deciding_layer).toBe('alpha');
  });

  it('merged decision_id is derived from winning decision (deterministic prefix)', () => {
    const a = createSecurityDecision(
      baseInput({ decision_id: 'origin-id', behavior: 'deny', provenance_refs: ['p'] }),
    );
    const merged = mergeSecurityDecisions([a]);
    expect(merged.decision_id).toBe('merge:origin-id');
  });

  it('merged result has NO approved property', () => {
    const merged = mergeSecurityDecisions([decision('allow'), decision('deny')]);
    expect((merged as unknown as { approved?: unknown }).approved).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(merged, 'approved')).toBe(false);
  });

  it('merged result has NO approved property even on empty input', () => {
    const merged = mergeSecurityDecisions([]);
    expect((merged as unknown as { approved?: unknown }).approved).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(merged, 'approved')).toBe(false);
  });
});
