// Wave D Task 14 (DRC-5): Activation Gate + cutover invariants。
//
// 物理本质:Activation Gate 是"上线前最后一道 checklist"——它确认目标 shell
// dialect 的 grammar 已冻结、benchmark corpus 已覆盖关键结构、divergence 已
// 分类、false allow/false deny 基线已记录、too_complex policy 已冻结、五重
// gate 组合已验证、ask 持久化已就绪、rollback 只动 policy state。
// 任一项缺失 → activated=false + missing 列表。
//
// 关键不变量:
//   - INV-D14: shadow 无执行权——shadow 不改变现行 allow/ask/deny;
//   - INV-D16: failures never upgrade state——enforced failure 不回退 shadow allow;
//   - spec §11.8: Activation 门是 9 项 evidence,不新增 M-055/M-065 为前置。

import { describe, expect, it } from 'vitest';
import {
  assertActivationGate,
  composeCommandStructuralDecision,
  parseCommandStructure,
  PARSE_PROTOCOL_VERSION,
  STRUCTURAL_DECISION_PROTOCOL_VERSION,
  SUPPORTED_GRAMMAR_VERSION,
  SUPPORTED_SHELL_DIALECT,
  type CommandStructuralDecisionInput,
} from '../../permission/command-policy.js';

// ─────────────────────────────────────────────
// fixtures
// ─────────────────────────────────────────────

const defaultComplexityPolicy = {
  policy_id: 'complexity:posix-shell-v1',
  policy_version: '1',
  max_tokens: 64,
  max_operators: 16,
  max_nesting: 4,
  max_source_length: 4096,
};

/** 9 项 evidence 全 true 的默认输入。 */
function allTrueInput() {
  return {
    grammar_version_frozen: true,
    corpus_covers_substitution_redirect_pipeline_control_flow_quoting: true,
    corpus_covers_environment_assignment_executable_candidate: true,
    divergence_baseline_recorded: true,
    false_allow_false_deny_baseline_recorded: true,
    too_complex_policy_frozen: true,
    plan_argument_path_rc5_composition_verified: true,
    pending_ask_persistence_verified: true,
    rollback_policy_state_only_verified: true,
  };
}

function parsedResult() {
  return parseCommandStructure(
    {
      parse_protocol_version: PARSE_PROTOCOL_VERSION,
      action_snapshot_id: 'snap-action-1',
      command_content: 'echo hello',
      command_hash: '',
      shell_dialect: SUPPORTED_SHELL_DIALECT,
      grammar_version: SUPPORTED_GRAMMAR_VERSION,
    },
    defaultComplexityPolicy,
  );
}

function enforcedInput(
  overrides: Partial<CommandStructuralDecisionInput> = {},
): CommandStructuralDecisionInput {
  const pr = parsedResult();
  return {
    structural_decision_protocol_version: STRUCTURAL_DECISION_PROTOCOL_VERSION,
    action_snapshot_id: 'snap-action-1',
    parse_result_id: pr.parse_result_id,
    parse_result: pr,
    policy_state_ref: 'policy-state:default:1',
    policy_state_mode: 'enforced',
    gates: {
      plan_allowlist: 'allow',
      argument_policy: 'allow',
      path_policy: 'allow',
      ast_structural: 'allow',
      rc5_permission: 'allow',
    },
    gate_decision_refs: ['gate:plan:1', 'gate:arg:1', 'gate:path:1', 'gate:ast:1', 'gate:rc5:1'],
    control_mode_snapshot_id: 'mode:build@1',
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// describe: Activation Gate 9 项 evidence
// ─────────────────────────────────────────────

describe('DRC-5 activation gate — 9 evidences', () => {
  it('accepts when all 9 evidences present', () => {
    const result = assertActivationGate(allTrueInput());
    expect(result.activated).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it.each([
    ['grammar_version_frozen', 'grammar_version_frozen'],
    ['corpus_substitution_redirect_pipeline_cf_quoting', 'corpus_covers_substitution_redirect_pipeline_control_flow_quoting'],
    ['corpus_env_assignment_executable', 'corpus_covers_environment_assignment_executable_candidate'],
    ['divergence_baseline_recorded', 'divergence_baseline_recorded'],
    ['false_allow_false_deny_baseline_recorded', 'false_allow_false_deny_baseline_recorded'],
    ['too_complex_policy_frozen', 'too_complex_policy_frozen'],
    ['plan_argument_path_rc5_composition_verified', 'plan_argument_path_rc5_composition_verified'],
    ['pending_ask_persistence_verified', 'pending_ask_persistence_verified'],
    ['rollback_policy_state_only_verified', 'rollback_policy_state_only_verified'],
  ] as const)('rejects when %s is false (lists it in missing)', (_label, key) => {
    const input = { ...allTrueInput(), [key]: false };
    const result = assertActivationGate(input);
    expect(result.activated).toBe(false);
    expect(result.missing).toContain(key);
  });

  it('lists every missing evidence when multiple are false', () => {
    const result = assertActivationGate({
      ...allTrueInput(),
      grammar_version_frozen: false,
      too_complex_policy_frozen: false,
      pending_ask_persistence_verified: false,
    });
    expect(result.activated).toBe(false);
    expect(result.missing).toHaveLength(3);
    expect(result.missing).toContain('grammar_version_frozen');
    expect(result.missing).toContain('too_complex_policy_frozen');
    expect(result.missing).toContain('pending_ask_persistence_verified');
  });

  it('rejects when all evidences are false', () => {
    const input = Object.fromEntries(
      Object.keys(allTrueInput()).map((k) => [k, false]),
    );
    const result = assertActivationGate(input);
    expect(result.activated).toBe(false);
    expect(result.missing).toHaveLength(9);
  });
});

// ─────────────────────────────────────────────
// describe: cutover invariants — shadow 不改变决策
// ─────────────────────────────────────────────

describe('DRC-5 cutover — shadow does not change allow/ask/deny (INV-D14)', () => {
  it('shadow with all-allow gates does NOT produce an effective decision', () => {
    // shadow 即便五重 gate 全 allow,也只是一个候选回声——绝不产生 SecurityDecision 引用。
    const result = composeCommandStructuralDecision(
      enforcedInput({ policy_state_mode: 'shadow' }),
    );
    expect(result.candidate_behavior).toBeNull();
    expect(result.effective_security_decision_ref).toBeNull();
  });

  it('shadow with all-deny gates still produces null candidate (no execution authority)', () => {
    // shadow 下 deny 也只是候选——不下有效结论。
    const result = composeCommandStructuralDecision(
      enforcedInput({
        policy_state_mode: 'shadow',
        gates: {
          plan_allowlist: 'deny',
          argument_policy: 'deny',
          path_policy: 'deny',
          ast_structural: 'deny',
          rc5_permission: 'deny',
        },
      }),
    );
    expect(result.candidate_behavior).toBeNull();
    expect(result.effective_security_decision_ref).toBeNull();
  });
});

// ─────────────────────────────────────────────
// describe: cutover invariants — enforced failure 不回退 shadow
// ─────────────────────────────────────────────

describe('DRC-5 cutover — enforced failure does not fallback to shadow (INV-D16)', () => {
  it('enforced parse failure yields deny, not silent allow', () => {
    // spec §11.6 rule 8 + §11.9: enforcement failure 不能回退 legacy/shadow allow。
    const failedParse = parseCommandStructure(
      {
        parse_protocol_version: PARSE_PROTOCOL_VERSION,
        action_snapshot_id: 'snap-action-1',
        command_content: 'echo hello',
        command_hash: '',
        shell_dialect: 'unsupported-csh',
        grammar_version: 'csh-v1',
      },
      defaultComplexityPolicy,
    );
    const result = composeCommandStructuralDecision(
      enforcedInput({
        parse_result: failedParse,
        control_mode_snapshot_id: 'mode:build@1',
      }),
    );
    expect(result.candidate_behavior).toBe('deny');
    // 关键:deny 不是 null,且 effective ref 指向 deny——没有"回退到 shadow 的 null"。
    expect(result.effective_security_decision_ref).not.toBeNull();
  });

  it('enforced missing gate yields deny, never silent allow', () => {
    const result = composeCommandStructuralDecision(
      enforcedInput({
        gates: {
          plan_allowlist: null, // 缺失
          argument_policy: 'allow',
          path_policy: 'allow',
          ast_structural: 'allow',
          rc5_permission: 'allow',
        },
      }),
    );
    expect(result.candidate_behavior).toBe('deny');
    expect(result.effective_security_decision_ref).toMatch(/:deny$/);
  });
});
