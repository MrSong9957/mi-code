// src/__tests__/agent/prompt-resolution.test.ts
// Wave C Task 2 — M-002 PromptResolutionPlan.
//
// 物理本质:resolvePromptPolicy 把候选集合 + condition 上下文 + scope 输入
// 收敛成不可变 PromptResolutionPlan,作为 BRC-1 编译的上游政策证据。
//
// 这里覆盖 spec §7.3 (base precedence) / §7.4 (append) / §7.7 (输出形状) /
// §7.8 (错误语义) / §17.1 (CRC-1 验收) 的所有关键路径。
//
// 注意:resolvePromptPolicy 不调用 BRC-1 compiler;compiler 由 Task 3 adapter 单独桥接。

import { describe, expect, it } from 'vitest';

import {
  resolvePromptPolicy,
  type ConditionEvaluationContext,
  type PromptCondition,
  type PromptResolutionCandidate,
  type PromptResolutionInput,
} from '../../agent/prompt/resolution.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeCandidate(
  overrides: Partial<PromptResolutionCandidate> & { candidate_id: string },
): PromptResolutionCandidate {
  return {
    candidate_kind: 'default_base',
    operation: 'replace_base',
    criticality: 'mandatory',
    section_input_ref: overrides.candidate_id + ':section',
    asset_ref: { asset_id: 'asset', asset_version: '1' },
    authority: 'system',
    trust: 'trusted',
    stable_order: 100,
    condition_ref: null,
    dependency_snapshot_ids: [],
    ...overrides,
  };
}

const baseContext: ConditionEvaluationContext = {
  control_mode: 'default',
  role_id: 'researcher',
  capabilities: {},
  trusted_flags: {},
  present_source_classes: new Set(),
  evidence_refs: ['snap:ctx@1'],
};

const approveAll = (_ref: { asset_id: string; asset_version: string }): boolean => true;

const baseInput = {
  resolution_protocol_version: '1',
  policy_ref: { policy_id: 'pol', policy_version: '1' },
  input_snapshot_ids: ['snap:in@1'],
};

// ---------------------------------------------------------------------------
// 正向:base 选择
// ---------------------------------------------------------------------------

describe('resolvePromptPolicy — base precedence (spec §7.3)', () => {
  it('选 rank 更低的 base(default 与 role profile 都 approved + mandatory,选 role)', () => {
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({
        candidate_id: 'default',
        candidate_kind: 'default_base',
      }),
      makeCandidate({
        candidate_id: 'role',
        candidate_kind: 'agent_role_profile',
      }),
    ];
    const input: PromptResolutionInput = {
      ...baseInput,
      candidates,
      condition_context: baseContext,
      conditions: {},
      section_scope_inputs: {
        default: { section_input_ref: 'default:section', immutable_asset: true, dependency_kinds: [], stable_order: true },
        role: { section_input_ref: 'role:section', immutable_asset: true, dependency_kinds: [], stable_order: true },
      },
      approvedAsset: approveAll,
    };

    const plan = resolvePromptPolicy(input);
    expect(plan.selected_base_candidate_id).toBe('role');
    expect(plan.ordered_section_refs).toEqual(['role:section']);
    expect(plan.included_append_candidate_ids).toEqual([]);
    expect(plan.excluded_candidates.find((c) => c.candidate_id === 'default')?.reason_code)
      .toBe('candidate.superseded_by_lower_rank_base');
  });

  it('trusted_runtime_override 击败所有其它 base', () => {
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({ candidate_id: 'default', candidate_kind: 'default_base' }),
      makeCandidate({ candidate_id: 'role', candidate_kind: 'agent_role_profile' }),
      makeCandidate({ candidate_id: 'coord', candidate_kind: 'coordinator_profile' }),
      makeCandidate({ candidate_id: 'override', candidate_kind: 'trusted_runtime_override' }),
    ];
    const input: PromptResolutionInput = {
      ...baseInput,
      candidates,
      condition_context: baseContext,
      conditions: {},
      section_scope_inputs: {},
      approvedAsset: approveAll,
    };

    const plan = resolvePromptPolicy(input);
    expect(plan.selected_base_candidate_id).toBe('override');
  });

  it('没有 base candidate → rejected (base.none)', () => {
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({
        candidate_id: 'append1',
        operation: 'append',
        candidate_kind: 'approved_custom_profile',
      }),
    ];
    const input: PromptResolutionInput = {
      ...baseInput,
      candidates,
      condition_context: baseContext,
      conditions: {},
      section_scope_inputs: {},
      approvedAsset: approveAll,
    };
    expect(() => resolvePromptPolicy(input)).toThrow('base.none');
  });
});

// ---------------------------------------------------------------------------
// 错误语义:同层冲突 / asset 未批准
// ---------------------------------------------------------------------------

describe('resolvePromptPolicy — 错误语义 (spec §7.8)', () => {
  it('同层多个有效 base → rejected (base.conflict_at_rank)', () => {
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({ candidate_id: 'role1', candidate_kind: 'agent_role_profile' }),
      makeCandidate({ candidate_id: 'role2', candidate_kind: 'agent_role_profile' }),
    ];
    const input: PromptResolutionInput = {
      ...baseInput,
      candidates,
      condition_context: baseContext,
      conditions: {},
      section_scope_inputs: {},
      approvedAsset: approveAll,
    };
    expect(() => resolvePromptPolicy(input)).toThrow('base.conflict_at_rank');
  });

  it('非 approved asset 的 candidate → excluded (candidate.asset_not_approved)', () => {
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({ candidate_id: 'default', candidate_kind: 'default_base' }),
      makeCandidate({
        candidate_id: 'role',
        candidate_kind: 'agent_role_profile',
        asset_ref: { asset_id: 'unapproved', asset_version: '1' },
      }),
    ];
    const input: PromptResolutionInput = {
      ...baseInput,
      candidates,
      condition_context: baseContext,
      conditions: {},
      section_scope_inputs: {},
      approvedAsset: (ref) => ref.asset_id !== 'unapproved',
    };

    const plan = resolvePromptPolicy(input);
    expect(plan.selected_base_candidate_id).toBe('default');
    expect(plan.excluded_candidates.find((c) => c.candidate_id === 'role')?.reason_code)
      .toBe('candidate.asset_not_approved');
  });

  it('所有 base 都未 approved → rejected (base.none)', () => {
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({
        candidate_id: 'default',
        candidate_kind: 'default_base',
        asset_ref: { asset_id: 'unapproved', asset_version: '1' },
      }),
    ];
    const input: PromptResolutionInput = {
      ...baseInput,
      candidates,
      condition_context: baseContext,
      conditions: {},
      section_scope_inputs: {},
      approvedAsset: () => false,
    };
    expect(() => resolvePromptPolicy(input)).toThrow('base.none');
  });
});

// ---------------------------------------------------------------------------
// Condition 影响
// ---------------------------------------------------------------------------

describe('resolvePromptPolicy — condition 三态 (spec §7.5 / §7.8)', () => {
  it('base candidate condition=false → excluded,退回下一 rank', () => {
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({
        candidate_id: 'role',
        candidate_kind: 'agent_role_profile',
        condition_ref: 'cond:role-only',
      }),
      makeCandidate({ candidate_id: 'default', candidate_kind: 'default_base' }),
    ];
    const conditions: Record<string, PromptCondition> = {
      'cond:role-only': { kind: 'control_mode_is', expected: 'plan' },
    };
    const input: PromptResolutionInput = {
      ...baseInput,
      candidates,
      condition_context: baseContext,
      conditions,
      section_scope_inputs: {},
      approvedAsset: approveAll,
    };

    const plan = resolvePromptPolicy(input);
    expect(plan.selected_base_candidate_id).toBe('default');
    expect(plan.excluded_candidates.find((c) => c.candidate_id === 'role')?.reason_code)
      .toBe('candidate.condition_false');
  });

  it('mandatory base condition=unknown → rejected (base.condition_unknown)', () => {
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({
        candidate_id: 'role',
        candidate_kind: 'agent_role_profile',
        condition_ref: 'cond:flaky',
      }),
    ];
    const conditions: Record<string, PromptCondition> = {
      'cond:flaky': { kind: 'capability_is', capability: 'missing', expected: 'supported' },
    };
    const input: PromptResolutionInput = {
      ...baseInput,
      candidates,
      condition_context: baseContext,
      conditions,
      section_scope_inputs: {},
      approvedAsset: approveAll,
    };
    expect(() => resolvePromptPolicy(input)).toThrow('base.condition_unknown');
  });

  it('optional base condition=unknown → excluded,不 throw', () => {
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({
        candidate_id: 'role-opt',
        candidate_kind: 'agent_role_profile',
        criticality: 'optional',
        condition_ref: 'cond:flaky',
      }),
      makeCandidate({ candidate_id: 'default', candidate_kind: 'default_base' }),
    ];
    const conditions: Record<string, PromptCondition> = {
      'cond:flaky': { kind: 'capability_is', capability: 'missing', expected: 'supported' },
    };
    const input: PromptResolutionInput = {
      ...baseInput,
      candidates,
      condition_context: baseContext,
      conditions,
      section_scope_inputs: {},
      approvedAsset: approveAll,
    };

    const plan = resolvePromptPolicy(input);
    expect(plan.selected_base_candidate_id).toBe('default');
    expect(plan.excluded_candidates.find((c) => c.candidate_id === 'role-opt')?.reason_code)
      .toBe('candidate.condition_unknown_optional');
  });

  it('condition_evaluations 包含所有评估过的 condition(三态 + evidence)', () => {
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({
        candidate_id: 'role',
        candidate_kind: 'agent_role_profile',
        condition_ref: 'cond:role',
      }),
      makeCandidate({ candidate_id: 'default', candidate_kind: 'default_base' }),
    ];
    const conditions: Record<string, PromptCondition> = {
      'cond:role': { kind: 'role_is', expected: 'researcher' },
    };
    const input: PromptResolutionInput = {
      ...baseInput,
      candidates,
      condition_context: baseContext,
      conditions,
      section_scope_inputs: {},
      approvedAsset: approveAll,
    };

    const plan = resolvePromptPolicy(input);
    const roleEval = plan.condition_evaluations.find((e) => e.condition_ref === 'cond:role');
    expect(roleEval).toBeDefined();
    expect(roleEval?.truth).toBe('true');
    expect(roleEval?.evidence_refs).toEqual(['snap:ctx@1']);
  });
});

// ---------------------------------------------------------------------------
// Append 处理
// ---------------------------------------------------------------------------

describe('resolvePromptPolicy — append (spec §7.4)', () => {
  it('mandatory append 被包含,按 (stable_order ASC, candidate_id ASC) 排序', () => {
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({ candidate_id: 'default', candidate_kind: 'default_base' }),
      makeCandidate({
        candidate_id: 'b-append',
        operation: 'append',
        candidate_kind: 'append_section',
        stable_order: 20,
      }),
      makeCandidate({
        candidate_id: 'a-append',
        operation: 'append',
        candidate_kind: 'append_section',
        stable_order: 10,
      }),
    ];
    const input: PromptResolutionInput = {
      ...baseInput,
      candidates,
      condition_context: baseContext,
      conditions: {},
      section_scope_inputs: {},
      approvedAsset: approveAll,
    };

    const plan = resolvePromptPolicy(input);
    expect(plan.selected_base_candidate_id).toBe('default');
    expect(plan.included_append_candidate_ids).toEqual(['a-append', 'b-append']);
    expect(plan.ordered_section_refs).toEqual([
      'default:section',
      'a-append:section',
      'b-append:section',
    ]);
  });

  it('mandatory append condition=false 仍可省略(spec §7.4 rule 7:受信 condition=false 不适用)', () => {
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({ candidate_id: 'default', candidate_kind: 'default_base' }),
      makeCandidate({
        candidate_id: 'cond-append',
        operation: 'append',
        candidate_kind: 'append_section',
        condition_ref: 'cond:never',
      }),
    ];
    const conditions: Record<string, PromptCondition> = {
      'cond:never': { kind: 'control_mode_is', expected: 'never-matches' },
    };
    const input: PromptResolutionInput = {
      ...baseInput,
      candidates,
      condition_context: baseContext,
      conditions,
      section_scope_inputs: {},
      approvedAsset: approveAll,
    };

    const plan = resolvePromptPolicy(input);
    expect(plan.included_append_candidate_ids).toEqual([]);
    expect(plan.excluded_candidates.find((c) => c.candidate_id === 'cond-append')?.reason_code)
      .toBe('candidate.condition_false');
  });

  it('mandatory append condition=unknown → rejected (append.condition_unknown)', () => {
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({ candidate_id: 'default', candidate_kind: 'default_base' }),
      makeCandidate({
        candidate_id: 'flaky-append',
        operation: 'append',
        candidate_kind: 'append_section',
        condition_ref: 'cond:flaky',
      }),
    ];
    const conditions: Record<string, PromptCondition> = {
      'cond:flaky': { kind: 'capability_is', capability: 'missing', expected: 'supported' },
    };
    const input: PromptResolutionInput = {
      ...baseInput,
      candidates,
      condition_context: baseContext,
      conditions,
      section_scope_inputs: {},
      approvedAsset: approveAll,
    };
    expect(() => resolvePromptPolicy(input)).toThrow('append.condition_unknown');
  });

  it('optional append condition=unknown → excluded,不 throw', () => {
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({ candidate_id: 'default', candidate_kind: 'default_base' }),
      makeCandidate({
        candidate_id: 'flaky-opt-append',
        operation: 'append',
        candidate_kind: 'append_section',
        criticality: 'optional',
        condition_ref: 'cond:flaky',
      }),
    ];
    const conditions: Record<string, PromptCondition> = {
      'cond:flaky': { kind: 'capability_is', capability: 'missing', expected: 'supported' },
    };
    const input: PromptResolutionInput = {
      ...baseInput,
      candidates,
      condition_context: baseContext,
      conditions,
      section_scope_inputs: {},
      approvedAsset: approveAll,
    };

    const plan = resolvePromptPolicy(input);
    expect(plan.included_append_candidate_ids).toEqual([]);
    expect(plan.excluded_candidates.find((c) => c.candidate_id === 'flaky-opt-append')?.reason_code)
      .toBe('candidate.condition_unknown_optional');
  });

  it('append stable_order 重复 → rejected (append.duplicate_stable_order)', () => {
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({ candidate_id: 'default', candidate_kind: 'default_base' }),
      makeCandidate({
        candidate_id: 'a1',
        operation: 'append',
        candidate_kind: 'append_section',
        stable_order: 50,
      }),
      makeCandidate({
        candidate_id: 'a2',
        operation: 'append',
        candidate_kind: 'append_section',
        stable_order: 50,
      }),
    ];
    const input: PromptResolutionInput = {
      ...baseInput,
      candidates,
      condition_context: baseContext,
      conditions: {},
      section_scope_inputs: {},
      approvedAsset: approveAll,
    };
    expect(() => resolvePromptPolicy(input)).toThrow('append.duplicate_stable_order');
  });
});

// ---------------------------------------------------------------------------
// Scope decisions + 输出形状
// ---------------------------------------------------------------------------

describe('resolvePromptPolicy — scope decisions + 输出形状 (spec §7.6 / §7.7)', () => {
  it('为每个 included section 产出 scope_decision;static section 标 static', () => {
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({ candidate_id: 'default', candidate_kind: 'default_base' }),
      makeCandidate({
        candidate_id: 'dyn-append',
        operation: 'append',
        candidate_kind: 'append_section',
        section_input_ref: 'dyn-section',
      }),
    ];
    const input: PromptResolutionInput = {
      ...baseInput,
      candidates,
      condition_context: baseContext,
      conditions: {},
      section_scope_inputs: {
        default: {
          section_input_ref: 'default:section',
          immutable_asset: true,
          dependency_kinds: [],
          stable_order: true,
        },
        'dyn-append': {
          section_input_ref: 'dyn-section',
          immutable_asset: true,
          dependency_kinds: ['memory'],
          stable_order: true,
        },
      },
      approvedAsset: approveAll,
    };

    const plan = resolvePromptPolicy(input);
    const baseScope = plan.scope_decisions.find((d) => d.section_id === 'default');
    const dynScope = plan.scope_decisions.find((d) => d.section_id === 'dyn-append');
    expect(baseScope?.scope).toBe('static');
    expect(dynScope?.scope).toBe('dynamic');
  });

  it('scope_decision 缺失输入 → unknown(scope 决策不阻塞 resolution)', () => {
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({ candidate_id: 'default', candidate_kind: 'default_base' }),
    ];
    const input: PromptResolutionInput = {
      ...baseInput,
      candidates,
      condition_context: baseContext,
      conditions: {},
      section_scope_inputs: {},
      approvedAsset: approveAll,
    };

    const plan = resolvePromptPolicy(input);
    const scope = plan.scope_decisions.find((d) => d.section_id === 'default');
    expect(scope?.scope).toBe('unknown');
  });

  it('mandatory_candidate_ids 包含所有 mandatory 的 included(base + append)', () => {
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({ candidate_id: 'default', candidate_kind: 'default_base' }),
      makeCandidate({
        candidate_id: 'mand-append',
        operation: 'append',
        candidate_kind: 'append_section',
      }),
    ];
    const input: PromptResolutionInput = {
      ...baseInput,
      candidates,
      condition_context: baseContext,
      conditions: {},
      section_scope_inputs: {},
      approvedAsset: approveAll,
    };

    const plan = resolvePromptPolicy(input);
    expect(plan.mandatory_candidate_ids).toContain('default');
    expect(plan.mandatory_candidate_ids).toContain('mand-append');
  });
});

// ---------------------------------------------------------------------------
// 确定性:resolution_id 稳定 (INV-C1)
// ---------------------------------------------------------------------------

describe('resolvePromptPolicy — 确定性 (spec §6.4 INV-C1)', () => {
  it('同一 (policy + version + input snapshots + candidates + conditions) 产生相同 resolution_id', () => {
    const buildInput = (): PromptResolutionInput => ({
      ...baseInput,
      candidates: [
        makeCandidate({ candidate_id: 'default', candidate_kind: 'default_base' }),
        makeCandidate({
          candidate_id: 'append',
          operation: 'append',
          candidate_kind: 'append_section',
        }),
      ],
      condition_context: baseContext,
      conditions: {},
      section_scope_inputs: {},
      approvedAsset: approveAll,
    });

    const plan1 = resolvePromptPolicy(buildInput());
    const plan2 = resolvePromptPolicy(buildInput());
    expect(plan1.resolution_id).toBe(plan2.resolution_id);
    expect(plan1.resolution_id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('候选顺序不同(但内容相同)→ 相同 resolution_id', () => {
    const cands = [
      makeCandidate({ candidate_id: 'default', candidate_kind: 'default_base' }),
      makeCandidate({
        candidate_id: 'append',
        operation: 'append',
        candidate_kind: 'append_section',
      }),
    ];
    const inputA: PromptResolutionInput = {
      ...baseInput,
      candidates: [cands[0], cands[1]],
      condition_context: baseContext,
      conditions: {},
      section_scope_inputs: {},
      approvedAsset: approveAll,
    };
    const inputB: PromptResolutionInput = {
      ...baseInput,
      candidates: [cands[1], cands[0]],
      condition_context: baseContext,
      conditions: {},
      section_scope_inputs: {},
      approvedAsset: approveAll,
    };
    expect(resolvePromptPolicy(inputA).resolution_id)
      .toBe(resolvePromptPolicy(inputB).resolution_id);
  });

  it('policy_version 变化 → resolution_id 变化', () => {
    const buildInput = (version: string): PromptResolutionInput => ({
      ...baseInput,
      policy_ref: { policy_id: 'pol', policy_version: version },
      candidates: [makeCandidate({ candidate_id: 'default', candidate_kind: 'default_base' })],
      condition_context: baseContext,
      conditions: {},
      section_scope_inputs: {},
      approvedAsset: approveAll,
    });
    expect(resolvePromptPolicy(buildInput('1')).resolution_id)
      .not.toBe(resolvePromptPolicy(buildInput('2')).resolution_id);
  });
});

// ---------------------------------------------------------------------------
// 不可变性
// ---------------------------------------------------------------------------

describe('resolvePromptPolicy — 不可变性', () => {
  it('返回的 plan 是深冻结的', () => {
    const input: PromptResolutionInput = {
      ...baseInput,
      candidates: [makeCandidate({ candidate_id: 'default', candidate_kind: 'default_base' })],
      condition_context: baseContext,
      conditions: {},
      section_scope_inputs: {},
      approvedAsset: approveAll,
    };
    const plan = resolvePromptPolicy(input);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.excluded_candidates)).toBe(true);
    expect(Object.isFrozen(plan.condition_evaluations)).toBe(true);
    expect(Object.isFrozen(plan.scope_decisions)).toBe(true);
    expect(Object.isFrozen(plan.ordered_section_refs)).toBe(true);
  });
});
