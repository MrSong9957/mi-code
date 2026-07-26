// ERC-4 / M-065 Sanitized Execution Plan — 单元测试
//
// 物理本质:把五门 gate(inherited env、structural policy、inline environment、
// executable resolution、RC-5 permission)与 parse result(复杂 shell structure
// 探测)用硬 AND 组合,产出一份"已净化的执行计划"——它只声明 plan/spawn
// 之前的安全准备状态,绝不授予 spawn 权限、绝不恢复 stripped env、绝不让
// resolved 等同于 allowed。
//
// 关键不变量(spec §10.9 + ERC-4 + 计划 Task 13 Global Constraints):
//   1. plan 没有 spawn 方法——它只承载身份绑定与状态,无执行能力;
//   2. 没有恢复 stripped env——stripped_assignment_ids 是结构化 diff,不复活;
//   3. resolved 不等于 allowed——ready_for_permission 仍需 RC-5 显式 allow;
//   4. ready_for_permission 不等于 permission allow——只是"可以走 permission gate";
//   5. 复杂 shell structure(pipeline / redirect / substitution / control_flow)
//      → invalid,绝不回退 shell:true;
//   6. plan 是 frozen 的、plan_id 由 canonical 字段确定性派生。

import { describe, expect, it } from 'vitest';
import {
  buildSanitizedExecutionPlan,
  SANITIZED_PLAN_PROTOCOL_VERSION,
  type SanitizedExecutionPlanInput,
  type SanitizedExecutionPlan,
  type SanitizedExecutionPlanStatus,
  type InlineEnvironmentDecision,
  type ExecutableResolutionResult,
  type PlatformFamily,
} from '../../permission/executable-environment.js';
import type { CommandStructuralDecision } from '../../permission/command-policy.js';

// ─────────────────────────────────────────────
// 测试夹具
// ─────────────────────────────────────────────

const PLATFORM: PlatformFamily = 'linux';

/** 构造一个"全绿"baseline inline decision(preserve,无 deny/ask)。 */
function greenInlineDecision(): InlineEnvironmentDecision {
  return {
    inline_decision_protocol_version: '1',
    decision_id: 'inline-env:green',
    action_snapshot_id: 'snap-1',
    platform: PLATFORM,
    control_mode: 'build',
    classifications: [],
    actions: [],
    aggregated_action: 'preserve',
    reason_codes: [],
  };
}

/** 构造一个"全绿"baseline executable resolution(resolved,单一 executable)。 */
function greenResolutionResult(): ExecutableResolutionResult {
  return {
    resolution_protocol_version: 'erc-4-exec-res-v1',
    resolution_id: 'exec-res:green',
    action_snapshot_id: 'snap-1',
    status: 'resolved',
    resolved_canonical_path: '/usr/bin/node',
    file_identity_ref: 'exec-identity:abcd',
    content_or_metadata_hash: 'abcd'.repeat(16),
    candidate_provenance: {
      raw_name: 'node',
      resolution_method: 'path_search',
    },
    reason_codes: ['executable.resolved'],
  };
}

/** 构造一个"全绿"baseline CommandStructuralDecision(enforced, allow)。 */
function greenStructuralDecision(): CommandStructuralDecision {
  return {
    structural_decision_protocol_version: '1',
    structural_decision_id: 'structural:green',
    action_snapshot_id: 'snap-1',
    parse_result_id: 'parse:green',
    policy_state_ref: 'policy-state:1',
    mode: 'enforced',
    candidate_behavior: 'allow',
    effective_security_decision_ref: 'cmd:snap-1:allow',
    gate_decision_refs: [],
    reason_codes: ['gate.all_allow'],
    status: 'valid',
  };
}

/**
 * 构造一个全绿 baseline SanitizedExecutionPlanInput。
 *
 * 任何 gate 的"任一非默认值"通过 overrides 覆盖;inputWithInvalidGate()
 * 用它把对应 gate 标记为 invalid。
 */
function greenInput(
  overrides: Partial<SanitizedExecutionPlanInput> = {},
): SanitizedExecutionPlanInput {
  return {
    plan_protocol_version: SANITIZED_PLAN_PROTOCOL_VERSION,
    action_snapshot_id: 'snap-1',
    inherited_environment_ref: 'inherited-env:scrubbed-1',
    inherited_environment_valid: true,
    structural_decision: greenStructuralDecision(),
    structural_decision_valid: true,
    inline_decision: greenInlineDecision(),
    inline_decision_valid: true,
    executable_resolution: greenResolutionResult(),
    executable_resolution_valid: true,
    required_security_decision_ref: 'rc5:snap-1:allow',
    permission_valid: true,
    parse_result_status: 'parsed',
    parse_result_risk_facts_kinds: ['command', 'executable_candidate'],
    literal_argv_after_name: ['-v'],
    ...overrides,
  };
}

/** 把指定 gate 标记为 invalid(保留其它全绿)。 */
function inputWithInvalidGate(
  gate: 'inherited_environment' | 'structural_policy' | 'inline_environment' | 'executable_resolution' | 'permission',
): SanitizedExecutionPlanInput {
  const input = greenInput();
  switch (gate) {
    case 'inherited_environment':
      return { ...input, inherited_environment_valid: false };
    case 'structural_policy':
      return { ...input, structural_decision_valid: false };
    case 'inline_environment':
      return { ...input, inline_decision_valid: false };
    case 'executable_resolution':
      return { ...input, executable_resolution_valid: false };
    case 'permission':
      return { ...input, permission_valid: false };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 1: 六门 AND — 任一 gate invalid 不进入 ready
// ═══════════════════════════════════════════════════════════════════════════

describe('buildSanitizedExecutionPlan — 六门 AND (spec ERC-4 Step 1)', () => {
  it.each([
    'inherited_environment',
    'structural_policy',
    'inline_environment',
    'executable_resolution',
    'permission',
  ] as const)(
    'does not become ready when $gate gate is invalid',
    (gate) => {
      const plan = buildSanitizedExecutionPlan(inputWithInvalidGate(gate));
      expect(plan.status).not.toBe('ready_for_permission');
    },
  );

  it('becomes ready when all gates pass', () => {
    const plan = buildSanitizedExecutionPlan(greenInput());
    expect(plan.status).toBe('ready_for_permission');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 2: status 决定矩阵 — ask / deny / invalid
// ═══════════════════════════════════════════════════════════════════════════

describe('buildSanitizedExecutionPlan — status 决定矩阵 (Step 4)', () => {
  it('ask_required when inline_decision.aggregated_action is ask', () => {
    const plan = buildSanitizedExecutionPlan(
      greenInput({
        inline_decision: {
          ...greenInlineDecision(),
          aggregated_action: 'ask',
        },
      }),
    );
    expect(plan.status).toBe('ask_required');
  });

  it('ask_required when permission gate references an ask decision', () => {
    // 把 required ref 命名为 ask 即可触发 permission ask 短路
    const plan = buildSanitizedExecutionPlan(
      greenInput({
        required_security_decision_ref: 'rc5:snap-1:ask',
      }),
    );
    expect(plan.status).toBe('ask_required');
  });

  it('denied when structural decision candidate_behavior is deny', () => {
    const plan = buildSanitizedExecutionPlan(
      greenInput({
        structural_decision: {
          ...greenStructuralDecision(),
          candidate_behavior: 'deny',
        },
      }),
    );
    expect(plan.status).toBe('denied');
  });

  it('denied when inline_decision.aggregated_action is deny', () => {
    const plan = buildSanitizedExecutionPlan(
      greenInput({
        inline_decision: {
          ...greenInlineDecision(),
          aggregated_action: 'deny',
        },
      }),
    );
    expect(plan.status).toBe('denied');
  });

  it('denied when executable_resolution.status is denied', () => {
    const plan = buildSanitizedExecutionPlan(
      greenInput({
        executable_resolution: {
          ...greenResolutionResult(),
          status: 'denied',
          resolved_canonical_path: null,
        },
      }),
    );
    expect(plan.status).toBe('denied');
  });

  it('invalid when any gate is invalid (takes precedence over deny)', () => {
    const plan = buildSanitizedExecutionPlan(
      greenInput({
        structural_decision_valid: false,
        structural_decision: {
          ...greenStructuralDecision(),
          candidate_behavior: 'deny',
        },
      }),
    );
    expect(plan.status).toBe('invalid');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 3: 复杂 shell structure → invalid,不回退 shell:true
// ═══════════════════════════════════════════════════════════════════════════

describe('buildSanitizedExecutionPlan — 复杂 shell structure → invalid (Step 5)', () => {
  it('invalid when parse_result_status is not parsed', () => {
    const plan = buildSanitizedExecutionPlan(
      greenInput({ parse_result_status: 'too_complex' }),
    );
    expect(plan.status).toBe('invalid');
  });

  it('invalid when parse has pipeline', () => {
    const plan = buildSanitizedExecutionPlan(
      greenInput({
        parse_result_risk_facts_kinds: ['command', 'pipeline'],
      }),
    );
    expect(plan.status).toBe('invalid');
  });

  it('invalid when parse has redirect', () => {
    const plan = buildSanitizedExecutionPlan(
      greenInput({
        parse_result_risk_facts_kinds: ['redirect'],
      }),
    );
    expect(plan.status).toBe('invalid');
  });

  it('invalid when parse has substitution', () => {
    const plan = buildSanitizedExecutionPlan(
      greenInput({
        parse_result_risk_facts_kinds: ['substitution'],
      }),
    );
    expect(plan.status).toBe('invalid');
  });

  it('invalid when parse has control_flow', () => {
    const plan = buildSanitizedExecutionPlan(
      greenInput({
        parse_result_risk_facts_kinds: ['control_flow'],
      }),
    );
    expect(plan.status).toBe('invalid');
  });

  it('literal_argv only populated when single executable + parsed + no complex fact kinds', () => {
    const plan = buildSanitizedExecutionPlan(
      greenInput({ literal_argv_after_name: ['-v', '--help'] }),
    );
    expect(plan.status).toBe('ready_for_permission');
    expect(plan.literal_argv).toEqual(['-v', '--help']);
  });

  it('literal_argv is null when parse has pipeline (invalid plan)', () => {
    const plan = buildSanitizedExecutionPlan(
      greenInput({
        parse_result_risk_facts_kinds: ['pipeline'],
        literal_argv_after_name: ['-v'],
      }),
    );
    expect(plan.literal_argv).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 4: 关键不变量 — no spawn / no stripped-env revive / resolved ≠ allowed
// ═══════════════════════════════════════════════════════════════════════════

describe('buildSanitizedExecutionPlan — 不变量 (Global Constraints)', () => {
  it('plan has no spawn method', () => {
    const plan = buildSanitizedExecutionPlan(greenInput());
    expect((plan as unknown as Record<string, unknown>).spawn).toBeUndefined();
    expect(typeof (plan as unknown as Record<string, unknown>).spawn).not.toBe('function');
  });

  it('plan does not carry stripped env values back — stripped_assignment_ids only', () => {
    const plan = buildSanitizedExecutionPlan(
      greenInput({
        inline_decision: {
          ...greenInlineDecision(),
          classifications: [
            {
              assignment_id: 'a-1',
              variable_name: 'DEBUG',
              risk: 'safe_passthrough',
              reason_code: 'policy:safe_passthrough',
            },
            {
              assignment_id: 'a-2',
              variable_name: 'OLDPWD',
              risk: 'unknown',
              reason_code: 'policy:no_match',
            },
          ],
          actions: [
            {
              assignment_id: 'a-1',
              action: 'preserve',
              reason_code: 'action:preserve_safe',
            },
            {
              assignment_id: 'a-2',
              action: 'strip',
              reason_code: 'action:strip_unknown',
            },
          ],
          aggregated_action: 'strip',
        },
      }),
    );
    // diff 结构化呈现
    expect(plan.preserved_assignment_ids).toEqual(['a-1']);
    expect(plan.stripped_assignment_ids).toEqual(['a-2']);
    // plan 字段集里没有任何携带 env value 的字段(只有 *_ref 字符串引用)
    const keys = Object.keys(plan);
    const forbiddenValueKeys = keys.filter((k) =>
      /stripped.*value|preserved.*value|env_value/i.test(k),
    );
    expect(forbiddenValueKeys).toEqual([]);
  });

  it('ready_for_permission does not imply permission allow (status name != allow)', () => {
    const plan = buildSanitizedExecutionPlan(greenInput());
    expect(plan.status).toBe('ready_for_permission');
    // 不存在 "allow" / "approved" 之类的字段
    const allowLike = (Object.keys(plan) as (keyof SanitizedExecutionPlan)[]).filter(
      (k) => /allow|approv|spawn/i.test(k),
    );
    expect(allowLike).toEqual([]);
  });

  it('resolved_canonical_path is bound but does not grant allow', () => {
    const plan = buildSanitizedExecutionPlan(greenInput());
    // 已绑定 resolved path
    expect(plan.resolved_canonical_path).toBe('/usr/bin/node');
    // status 仍只是 ready_for_permission,不是 allow
    expect(plan.status).toBe('ready_for_permission');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 5: identity 绑定 — diff 与 *_id 字段绑定
// ═══════════════════════════════════════════════════════════════════════════

describe('buildSanitizedExecutionPlan — identity 绑定 (Step 3)', () => {
  it('binds all upstream identities into the plan', () => {
    const plan = buildSanitizedExecutionPlan(greenInput());
    expect(plan.inherited_environment_ref).toBe('inherited-env:scrubbed-1');
    expect(plan.structural_decision_id).toBe('structural:green');
    expect(plan.inline_decision_id).toBe('inline-env:green');
    expect(plan.executable_resolution_id).toBe('exec-res:green');
    expect(plan.required_security_decision_ref).toBe('rc5:snap-1:allow');
    expect(plan.action_snapshot_id).toBe('snap-1');
  });

  it('effective_environment_ref mirrors inherited_environment_ref (no scrub revive)', () => {
    const plan = buildSanitizedExecutionPlan(greenInput());
    // effective_environment_ref 是 inherited scrubbed snapshot 的引用——不复活
    // stripped env,而是把 inline decision 应用于 scrubbed inherited snapshot 的结果引用。
    expect(plan.effective_environment_ref).toBe(plan.inherited_environment_ref);
  });

  it('throws when action_snapshot_id is empty', () => {
    expect(() =>
      buildSanitizedExecutionPlan(greenInput({ action_snapshot_id: '' })),
    ).toThrow(/action_snapshot_id/);
  });

  it('throws when plan_protocol_version is empty', () => {
    expect(() =>
      buildSanitizedExecutionPlan(greenInput({ plan_protocol_version: '' })),
    ).toThrow(/plan_protocol_version/);
  });

  it('throws when inherited_environment_ref is empty', () => {
    expect(() =>
      buildSanitizedExecutionPlan(
        greenInput({ inherited_environment_ref: '' }),
      ),
    ).toThrow(/inherited_environment_ref/);
  });

  it('throws when required_security_decision_ref is empty', () => {
    expect(() =>
      buildSanitizedExecutionPlan(
        greenInput({ required_security_decision_ref: '' }),
      ),
    ).toThrow(/required_security_decision_ref/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 6: 确定性与冻结
// ═══════════════════════════════════════════════════════════════════════════

describe('buildSanitizedExecutionPlan — 确定性与冻结', () => {
  it('produces deterministic plan_id for identical inputs', () => {
    const a = buildSanitizedExecutionPlan(greenInput());
    const b = buildSanitizedExecutionPlan(greenInput());
    expect(a.plan_id).toBe(b.plan_id);
    expect(a.plan_id).toMatch(/^plan:[0-9a-f]+$/);
  });

  it('plan_id changes when status changes (canonical includes status)', () => {
    const ready = buildSanitizedExecutionPlan(greenInput());
    const ask = buildSanitizedExecutionPlan(
      greenInput({
        inline_decision: {
          ...greenInlineDecision(),
          aggregated_action: 'ask',
        },
      }),
    );
    expect(ready.plan_id).not.toBe(ask.plan_id);
  });

  it('is frozen (Object.isFrozen)', () => {
    const plan = buildSanitizedExecutionPlan(greenInput());
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.literal_argv ?? [])).toBe(true);
    expect(Object.isFrozen(plan.preserved_assignment_ids)).toBe(true);
    expect(Object.isFrozen(plan.stripped_assignment_ids)).toBe(true);
    expect(Object.isFrozen(plan.reason_codes)).toBe(true);
  });

  it('preserved/stripped lists default to empty when inline_decision has no actions', () => {
    const plan = buildSanitizedExecutionPlan(greenInput());
    expect(plan.preserved_assignment_ids).toEqual([]);
    expect(plan.stripped_assignment_ids).toEqual([]);
  });
});
