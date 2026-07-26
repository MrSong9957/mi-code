// src/__tests__/agent/prompt-condition-scope.test.ts
// Wave C Task 1 — M-003/M-004 Condition DSL + Scope Classification.
//
// 物理本质:
//   - evaluatePromptCondition: 把封闭的 PromptCondition DSL 求值为三态
//     (true/false/unknown),不执行任意脚本/spec §7.5 rule 1。
//   - classifyPromptScope: 根据易变依赖判断 section 是 static / dynamic / unknown,
//     unknown 在 resolution 中按 dynamic 处理但保留原始 scope 字段(spec §7.6)。
//
// 这里只覆盖 evaluatePromptCondition 与 classifyPromptScope 两个纯函数。
// PromptResolutionPlan 的算法见 prompt-resolution.test.ts(Task 2)。

import { describe, expect, it } from 'vitest';

import {
  classifyPromptScope,
  evaluatePromptCondition,
  type ConditionEvaluationContext,
} from '../../agent/prompt/resolution.js';

// ---------------------------------------------------------------------------
// 测试用 context(局部 override 即可)
// ---------------------------------------------------------------------------

const baseContext: ConditionEvaluationContext = {
  control_mode: 'default',
  role_id: 'researcher',
  capabilities: { web_search: 'supported', file_write: 'unsupported' },
  trusted_flags: { experimental_feature: true, disabled_feature: false },
  present_source_classes: new Set(['memory', 'tool_result']),
  evidence_refs: ['snap:caps@1', 'snap:flags@1'],
};

// ---------------------------------------------------------------------------
// evaluatePromptCondition
// ---------------------------------------------------------------------------

describe('evaluatePromptCondition (M-004 Condition DSL)', () => {
  it('control_mode_is: 匹配返回 true,不匹配返回 false', () => {
    const yes = evaluatePromptCondition(
      { kind: 'control_mode_is', expected: 'default' },
      baseContext,
      'cond:cm-default',
    );
    expect(yes).toMatchObject({
      condition_ref: 'cond:cm-default',
      truth: 'true',
      reason_code: 'condition.control_mode_is.match',
    });
    expect(yes.evidence_refs).toEqual(baseContext.evidence_refs);

    const no = evaluatePromptCondition(
      { kind: 'control_mode_is', expected: 'plan' },
      baseContext,
      'cond:cm-plan',
    );
    expect(no.truth).toBe('false');
    expect(no.condition_ref).toBe('cond:cm-plan');
  });

  it('role_is: role_id 匹配返回 true,null role 时永远 false', () => {
    const yes = evaluatePromptCondition(
      { kind: 'role_is', expected: 'researcher' },
      baseContext,
      'cond:role',
    );
    expect(yes.truth).toBe('true');

    const nullCtx: ConditionEvaluationContext = {
      ...baseContext,
      role_id: null,
    };
    const no = evaluatePromptCondition(
      { kind: 'role_is', expected: 'researcher' },
      nullCtx,
      'cond:role-null',
    );
    expect(no.truth).toBe('false');
    expect(no.reason_code).toBe('condition.role_is.no_role');
  });

  it('capability_is: supported/unsupported 评估正确,缺失 capability 视为 unknown', () => {
    const sup = evaluatePromptCondition(
      { kind: 'capability_is', capability: 'web_search', expected: 'supported' },
      baseContext,
      'cond:cap-sup',
    );
    expect(sup.truth).toBe('true');

    const unsup = evaluatePromptCondition(
      { kind: 'capability_is', capability: 'file_write', expected: 'supported' },
      baseContext,
      'cond:cap-unsup',
    );
    expect(unsup.truth).toBe('false');

    // 缺失 capability → context 里没有该字段,无法判断 → unknown
    const missing = evaluatePromptCondition(
      { kind: 'capability_is', capability: 'unknown_tool', expected: 'supported' },
      baseContext,
      'cond:cap-missing',
    );
    expect(missing.truth).toBe('unknown');
    expect(missing.reason_code).toBe('condition.capability_is.absent');
  });

  it('capability_is: capability 在 context 里为 unknown 时也返回 unknown', () => {
    const ctx: ConditionEvaluationContext = {
      ...baseContext,
      capabilities: { flaky_tool: 'unknown' },
    };
    const r = evaluatePromptCondition(
      { kind: 'capability_is', capability: 'flaky_tool', expected: 'supported' },
      ctx,
      'cond:cap-ctx-unknown',
    );
    expect(r.truth).toBe('unknown');
  });

  it('trusted_config_flag_is: 匹配返回 true,缺失 flag 返回 unknown', () => {
    const yes = evaluatePromptCondition(
      {
        kind: 'trusted_config_flag_is',
        flag_id: 'experimental_feature',
        expected: true,
      },
      baseContext,
      'cond:flag-yes',
    );
    expect(yes.truth).toBe('true');

    const missing = evaluatePromptCondition(
      {
        kind: 'trusted_config_flag_is',
        flag_id: 'never_set',
        expected: true,
      },
      baseContext,
      'cond:flag-missing',
    );
    expect(missing.truth).toBe('unknown');
    expect(missing.reason_code).toBe('condition.trusted_config_flag_is.absent');
  });

  it('context_source_present: present_source_classes 包含目标返回 true', () => {
    const yes = evaluatePromptCondition(
      { kind: 'context_source_present', source_class: 'memory' },
      baseContext,
      'cond:src-mem',
    );
    expect(yes.truth).toBe('true');

    const no = evaluatePromptCondition(
      { kind: 'context_source_present', source_class: 'attachment' },
      baseContext,
      'cond:src-att',
    );
    expect(no.truth).toBe('false');
  });

  it('all: 全部 true 返回 true;含 unknown 且无 false 返回 unknown;含 false 返回 false', () => {
    const allTrue = evaluatePromptCondition(
      {
        kind: 'all',
        children: [
          { kind: 'control_mode_is', expected: 'default' },
          { kind: 'role_is', expected: 'researcher' },
        ],
      },
      baseContext,
      'cond:all-true',
    );
    expect(allTrue.truth).toBe('true');

    const withUnknown = evaluatePromptCondition(
      {
        kind: 'all',
        children: [
          { kind: 'control_mode_is', expected: 'default' },
          { kind: 'capability_is', capability: 'missing', expected: 'supported' },
        ],
      },
      baseContext,
      'cond:all-unknown',
    );
    expect(withUnknown.truth).toBe('unknown');

    const withFalse = evaluatePromptCondition(
      {
        kind: 'all',
        children: [
          { kind: 'control_mode_is', expected: 'default' },
          { kind: 'role_is', expected: 'other' },
        ],
      },
      baseContext,
      'cond:all-false',
    );
    expect(withFalse.truth).toBe('false');
  });

  it('any: 任一 true 返回 true;全 false 返回 false;无 true 且有 unknown 返回 unknown', () => {
    const anyTrue = evaluatePromptCondition(
      {
        kind: 'any',
        children: [
          { kind: 'role_is', expected: 'other' },
          { kind: 'control_mode_is', expected: 'default' },
        ],
      },
      baseContext,
      'cond:any-true',
    );
    expect(anyTrue.truth).toBe('true');

    const allFalse = evaluatePromptCondition(
      {
        kind: 'any',
        children: [
          { kind: 'role_is', expected: 'other' },
          { kind: 'control_mode_is', expected: 'plan' },
        ],
      },
      baseContext,
      'cond:any-false',
    );
    expect(allFalse.truth).toBe('false');

    const onlyUnknown = evaluatePromptCondition(
      {
        kind: 'any',
        children: [
          { kind: 'role_is', expected: 'other' },
          { kind: 'capability_is', capability: 'missing', expected: 'supported' },
        ],
      },
      baseContext,
      'cond:any-unknown',
    );
    expect(onlyUnknown.truth).toBe('unknown');
  });

  it('not: 反转 true/false;unknown 仍是 unknown', () => {
    const notTrue = evaluatePromptCondition(
      { kind: 'not', child: { kind: 'control_mode_is', expected: 'plan' } },
      baseContext,
      'cond:not-false',
    );
    expect(notTrue.truth).toBe('true');

    const notUnknown = evaluatePromptCondition(
      {
        kind: 'not',
        child: { kind: 'capability_is', capability: 'missing', expected: 'supported' },
      },
      baseContext,
      'cond:not-unknown',
    );
    expect(notUnknown.truth).toBe('unknown');
  });

  it('all/any/not 递归深度上限 16,超过返回 unknown + reason_code condition.depth_exceeded', () => {
    // 递归深度定义:每个 evalRecursive 调用计 1 层,叶子节点也算。
    // 嵌套 N 层 not + 1 个叶子 = N+1 层递归。
    // 上限 16:N+1 ≤ 16 合法,N+1 > 16 触发 depth_exceeded。

    // 17 层 not + 叶子 = 18 层 → 超限
    let cond: ReturnType<typeof deepNot> = { kind: 'control_mode_is', expected: 'default' };
    for (let i = 0; i < 17; i++) {
      cond = { kind: 'not', child: cond };
    }
    const r = evaluatePromptCondition(cond, baseContext, 'cond:deep');
    expect(r.truth).toBe('unknown');
    expect(r.reason_code).toBe('condition.depth_exceeded');

    // 15 层 not + 叶子 = 16 层 → 恰好上限内,正常求值
    let cond15: ReturnType<typeof deepNot> = { kind: 'control_mode_is', expected: 'default' };
    for (let i = 0; i < 15; i++) {
      cond15 = { kind: 'not', child: cond15 };
    }
    const r15 = evaluatePromptCondition(cond15, baseContext, 'cond:deep15');
    expect(r15.reason_code).not.toBe('condition.depth_exceeded');
  });

  it('未知 kind 抛错(封闭 DSL,不接受任意 condition)', () => {
    expect(() =>
      evaluatePromptCondition(
        { kind: 'arbitrary_callback' as never, x: 1 as never },
        baseContext,
        'cond:bad',
      ),
    ).toThrow(/unsupported condition kind/);
  });

  it('保留 evidence_refs 副本,调用方后续修改原数组不影响 evaluation', () => {
    const ctx: ConditionEvaluationContext = {
      ...baseContext,
      evidence_refs: ['snap:a@1', 'snap:b@1'],
    };
    const r = evaluatePromptCondition(
      { kind: 'control_mode_is', expected: 'default' },
      ctx,
      'cond:ev',
    );
    expect(r.evidence_refs).toEqual(['snap:a@1', 'snap:b@1']);
    // 不是同一引用(防止 freeze 后还被外部修改)
    expect(r.evidence_refs).not.toBe(ctx.evidence_refs);
  });
});

// helper:给 TS 一个递归类型别名,使 cond 变量类型可循环赋值
function deepNot(c: unknown): { kind: 'not'; child: unknown } {
  return { kind: 'not', child: c };
}

// ---------------------------------------------------------------------------
// classifyPromptScope
// ---------------------------------------------------------------------------

describe('classifyPromptScope (M-003 Static/Dynamic)', () => {
  it('immutable asset + 无易变依赖 + stable order → static', () => {
    const d = classifyPromptScope({
      section_id: 'base',
      immutable_asset: true,
      dependency_kinds: [],
      stable_order: true,
    });
    expect(d.scope).toBe('static');
    expect(d.section_id).toBe('base');
    expect(d.reason_code).toBe('scope.static');
    expect(d.dependency_kinds).toEqual([]);
  });

  it('包含 user/session/turn/time/cwd/memory/tool_result/attachment 任一依赖 → dynamic', () => {
    const dynKinds = [
      'user',
      'session',
      'turn',
      'time',
      'cwd',
      'environment',
      'memory',
      'tool_result',
      'attachment',
      'request_override',
      'mutable_config',
    ];
    for (const k of dynKinds) {
      const d = classifyPromptScope({
        section_id: 's',
        immutable_asset: true,
        dependency_kinds: [k],
        stable_order: true,
      });
      expect(d.scope).toBe('dynamic');
      expect(d.dependency_kinds).toEqual([k]);
    }
  });

  it('非 immutable asset → dynamic', () => {
    const d = classifyPromptScope({
      section_id: 's',
      immutable_asset: false,
      dependency_kinds: [],
      stable_order: true,
    });
    expect(d.scope).toBe('dynamic');
    expect(d.reason_code).toBe('scope.dynamic.mutable_asset');
  });

  it('stable_order=false → dynamic', () => {
    const d = classifyPromptScope({
      section_id: 's',
      immutable_asset: true,
      dependency_kinds: [],
      stable_order: false,
    });
    expect(d.scope).toBe('dynamic');
    expect(d.reason_code).toBe('scope.dynamic.unstable_order');
  });

  it('unknown 依赖(既非已知 dynamic kind,也无已知易变依赖)+ immutable + stable → unknown', () => {
    const d = classifyPromptScope({
      section_id: 's',
      immutable_asset: true,
      dependency_kinds: ['mystery_kind'],
      stable_order: true,
    });
    expect(d.scope).toBe('unknown');
    expect(d.reason_code).toBe('scope.unknown');
  });

  it('PromptScopeDecision 没有 cache_hit / saved_tokens / provider_cache_supported 字段 (INV-C4)', () => {
    const d = classifyPromptScope({
      section_id: 's',
      immutable_asset: true,
      dependency_kinds: [],
      stable_order: true,
    });
    expect(d).not.toHaveProperty('cache_hit');
    expect(d).not.toHaveProperty('saved_tokens');
    expect(d).not.toHaveProperty('provider_cache_supported');
  });
});
