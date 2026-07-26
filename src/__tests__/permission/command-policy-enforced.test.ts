// Wave D Task 14 (DRC-5): Enforced AND Composition。
//
// 物理本质:enforced composer 是"五位安检员的合议庭书记员"——它把
// Plan allowlist、argument policy、path policy、AST structural、RC-5 permission
// 这五位安检员的判定用硬 AND 组合,产出唯一的有效 behavior,并绑出一份
// SecurityDecision 引用。任一位说 deny → 合议庭 deny;任一位说 ask → 合议庭 ask;
// 五位全 allow 才允许执行。
//
// 关键不变量:
//   - INV-D14: shadow 模式 effective_security_decision_ref=null,candidate=null;
//   - INV-D15: AST 与 Plan policy AND 组合,不互相覆盖;
//   - INV-D16: failures never upgrade state——parse failure / missing gate /
//     ask unavailable 均不能回退到 allow;
//   - spec §11.6 rule 1-8: 任一 deny / 至少一 ask / 全 allow / Plan Mode 未知 deny /
//     Normal Mode 不默认 allow / AST 输出 RC-5 SecurityDecision / enforcement
//     failure 不回退 shadow;
//   - spec §11.9: parser failure、snapshot 不匹配、缺失 decision 均 deny。
//
// 本测试覆盖:AND 组合全枚举、shadow 退化为候选、parse failure 双模式、
// identity mismatch、effective_security_decision_ref 语义、决定性 ID、frozen。

import { describe, expect, it } from 'vitest';
import {
  composeCommandStructuralDecision,
  parseCommandStructure,
  PARSE_PROTOCOL_VERSION,
  STRUCTURAL_DECISION_PROTOCOL_VERSION,
  SUPPORTED_GRAMMAR_VERSION,
  SUPPORTED_SHELL_DIALECT,
  type CommandParseResult,
  type CommandPolicyMode,
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

function defaultParseInput(overrides: { action_snapshot_id?: string } = {}) {
  return {
    parse_protocol_version: PARSE_PROTOCOL_VERSION,
    action_snapshot_id: overrides.action_snapshot_id ?? 'snap-action-1',
    command_content: 'echo hello',
    command_hash: '',
    shell_dialect: SUPPORTED_SHELL_DIALECT,
    grammar_version: SUPPORTED_GRAMMAR_VERSION,
  };
}

function parsedResult(
  _overrides: Partial<CommandParseResult> = {},
): CommandParseResult {
  return parseCommandStructure(defaultParseInput(), defaultComplexityPolicy);
}

/** 把 5 个 gate behavior 装成 enforced 输入。gate 顺序固定:plan/arg/path/ast/rc5。 */
function enforcedInput(
  gates: [
    CommandStructuralDecisionInput['gates']['plan_allowlist'],
    CommandStructuralDecisionInput['gates']['argument_policy'],
    CommandStructuralDecisionInput['gates']['path_policy'],
    CommandStructuralDecisionInput['gates']['ast_structural'],
    CommandStructuralDecisionInput['gates']['rc5_permission'],
  ],
  overrides: Partial<CommandStructuralDecisionInput> = {},
): CommandStructuralDecisionInput {
  return {
    structural_decision_protocol_version: STRUCTURAL_DECISION_PROTOCOL_VERSION,
    action_snapshot_id: 'snap-action-1',
    parse_result_id: parsedResult().parse_result_id,
    parse_result: parsedResult(),
    policy_state_ref: 'policy-state:default:1',
    policy_state_mode: 'enforced',
    gates: {
      plan_allowlist: gates[0],
      argument_policy: gates[1],
      path_policy: gates[2],
      ast_structural: gates[3],
      rc5_permission: gates[4],
    },
    gate_decision_refs: [
      'gate:plan:1',
      'gate:arg:1',
      'gate:path:1',
      'gate:ast:1',
      'gate:rc5:1',
    ],
    control_mode_snapshot_id: 'mode:build@1',
    ...overrides,
  };
}

function shadowInput(
  gates: [
    CommandStructuralDecisionInput['gates']['plan_allowlist'],
    CommandStructuralDecisionInput['gates']['argument_policy'],
    CommandStructuralDecisionInput['gates']['path_policy'],
    CommandStructuralDecisionInput['gates']['ast_structural'],
    CommandStructuralDecisionInput['gates']['rc5_permission'],
  ] = ['allow', 'allow', 'allow', 'allow', 'allow'],
  overrides: Partial<CommandStructuralDecisionInput> = {},
): CommandStructuralDecisionInput {
  return enforcedInput(gates, {
    policy_state_mode: 'shadow' as CommandPolicyMode,
    ...overrides,
  });
}

// ─────────────────────────────────────────────
// describe: AND composition 主算法
// ─────────────────────────────────────────────

describe('DRC-5 enforced composition — AND gate algorithm', () => {
  it.each([
    // [name, 5 gate behaviors, expected candidate_behavior]
    ['deny wins over all allow', ['allow', 'allow', 'deny', 'allow', 'allow'], 'deny'],
    ['deny wins over mixed ask', ['allow', 'ask', 'deny', 'allow', 'allow'], 'deny'],
    ['ask blocks when no deny', ['allow', 'ask', 'allow', 'allow', 'allow'], 'ask'],
    ['multiple ask still ask', ['ask', 'ask', 'allow', 'allow', 'allow'], 'ask'],
    ['all allow yields allow', ['allow', 'allow', 'allow', 'allow', 'allow'], 'allow'],
    ['deny in ast_structural wins (INV-D15)', ['allow', 'allow', 'allow', 'deny', 'allow'], 'deny'],
    ['deny in plan_allowlist wins', ['deny', 'allow', 'allow', 'allow', 'allow'], 'deny'],
    ['deny in rc5 wins', ['allow', 'allow', 'allow', 'allow', 'deny'], 'deny'],
  ] as const)('%s', (_name, gates, expected) => {
    const result = composeCommandStructuralDecision(enforcedInput(gates));
    expect(result.candidate_behavior).toBe(expected);
    expect(result.status).toBe('valid');
  });
});

// ─────────────────────────────────────────────
// describe: INV-D14 — shadow 退化为候选
// ─────────────────────────────────────────────

describe('DRC-5 enforced composition — shadow mode (INV-D14)', () => {
  it('shadow produces null candidate_behavior even when all gates allow', () => {
    // shadow 不产出有效 behavior,即便五重 gate 全 allow。
    const result = composeCommandStructuralDecision(
      shadowInput(['allow', 'allow', 'allow', 'allow', 'allow']),
    );
    expect(result.candidate_behavior).toBeNull();
  });

  it('shadow produces null effective_security_decision_ref', () => {
    // shadow 无执行权——绝不下 SecurityDecision 引用。
    const result = composeCommandStructuralDecision(shadowInput());
    expect(result.effective_security_decision_ref).toBeNull();
  });

  it('shadow mode field is echoed back as shadow', () => {
    const result = composeCommandStructuralDecision(shadowInput());
    expect(result.mode).toBe('shadow');
  });
});

// ─────────────────────────────────────────────
// describe: INV-D16 — failures never upgrade state
// ─────────────────────────────────────────────

describe('DRC-5 enforced composition — failures never upgrade (INV-D16)', () => {
  it('enforced missing gate → deny (no default allow)', () => {
    // 任一 gate 为 null(缺失)→ deny,绝不"乐观放行"。
    const result = composeCommandStructuralDecision(
      enforcedInput([null, 'allow', 'allow', 'allow', 'allow']),
    );
    expect(result.candidate_behavior).toBe('deny');
    expect(result.reason_codes).toContain('gate.missing');
  });

  it('enforced multiple missing gates → deny with gate.missing reason', () => {
    const result = composeCommandStructuralDecision(
      enforcedInput([null, null, 'allow', null, 'allow']),
    );
    expect(result.candidate_behavior).toBe('deny');
    expect(result.reason_codes).toContain('gate.missing');
  });
});

// ─────────────────────────────────────────────
// describe: parse failure 双模式(spec §11.9)
// ─────────────────────────────────────────────

/** 用 unsupported dialect 拿到 status !== 'parsed' 的 parse_result。 */
function failedParseResult(): CommandParseResult {
  return parseCommandStructure(
    {
      ...defaultParseInput(),
      shell_dialect: 'csh', // 不支持 → unsupported_syntax
      grammar_version: 'csh-v1',
    },
    defaultComplexityPolicy,
  );
}

describe('DRC-5 enforced composition — parse failure (spec §11.9)', () => {
  it('enforced parse failure in plan mode → deny (cannot approve unknown in Plan Mode)', () => {
    // spec §11.6 rule 4 + §11.9: Plan Mode 未知命令保持 deny,用户只能退出/切换模式。
    const result = composeCommandStructuralDecision(
      enforcedInput(['allow', 'allow', 'allow', 'allow', 'allow'], {
        parse_result: failedParseResult(),
        control_mode_snapshot_id: 'mode:plan@1',
      }),
    );
    expect(result.candidate_behavior).toBe('deny');
    expect(result.reason_codes).toContain('parse_failure:plan_mode_deny');
  });

  it('enforced parse failure in normal mode → deny (no default allow)', () => {
    // spec §11.6 rule 5 + §11.9: Normal Mode unsupported/too-complex 不默认 allow。
    // 默认 parse_failure_policy='normal_mode_ask_or_deny',本实现保守选 deny。
    const result = composeCommandStructuralDecision(
      enforcedInput(['allow', 'allow', 'allow', 'allow', 'allow'], {
        parse_result: failedParseResult(),
        control_mode_snapshot_id: 'mode:build@1',
      }),
    );
    expect(result.candidate_behavior).toBe('deny');
    expect(result.reason_codes.some((r) => r.startsWith('parse_failure:'))).toBe(true);
  });

  it('shadow mode suppresses parse failure behavior to null (no authority)', () => {
    // shadow 下即便 parse 失败,candidate 仍 null——它从不下结论。
    const result = composeCommandStructuralDecision(
      shadowInput(['allow', 'allow', 'allow', 'allow', 'allow'], {
        parse_result: failedParseResult(),
      }),
    );
    expect(result.candidate_behavior).toBeNull();
    expect(result.effective_security_decision_ref).toBeNull();
  });
});

// ─────────────────────────────────────────────
// describe: identity / hash mismatch
// ─────────────────────────────────────────────

describe('DRC-5 enforced composition — identity mismatch (spec §11.9)', () => {
  it('enforced action_snapshot_id mismatch with parse_result → deny', () => {
    // spec §11.9: action snapshot/hash 不匹配 → deny。
    const result = composeCommandStructuralDecision(
      enforcedInput(['allow', 'allow', 'allow', 'allow', 'allow'], {
        action_snapshot_id: 'snap-action-1',
        parse_result: parseCommandStructure(
          defaultParseInput({ action_snapshot_id: 'snap-DIFFERENT' }),
          defaultComplexityPolicy,
        ),
      }),
    );
    expect(result.candidate_behavior).toBe('deny');
    expect(result.reason_codes).toContain('identity.mismatch');
  });
});

// ─────────────────────────────────────────────
// describe: effective_security_decision_ref 语义
// ─────────────────────────────────────────────

describe('DRC-5 enforced composition — effective_security_decision_ref', () => {
  it('enforced allow yields non-null effective_security_decision_ref', () => {
    // spec §11.6 rule 7: enforced 有效结果必须引用绑定同一 action snapshot 的 SecurityDecision。
    const result = composeCommandStructuralDecision(
      enforcedInput(['allow', 'allow', 'allow', 'allow', 'allow']),
    );
    expect(result.candidate_behavior).toBe('allow');
    expect(result.effective_security_decision_ref).not.toBeNull();
    expect(result.effective_security_decision_ref).toMatch(/^cmd:snap-action-1:allow$/);
  });

  it('enforced deny yields non-null effective_security_decision_ref', () => {
    // deny 也是有效 SecurityDecision——只是行为是 deny。
    const result = composeCommandStructuralDecision(
      enforcedInput(['allow', 'allow', 'deny', 'allow', 'allow']),
    );
    expect(result.candidate_behavior).toBe('deny');
    expect(result.effective_security_decision_ref).toMatch(/^cmd:snap-action-1:deny$/);
  });

  it('enforced ask yields non-null effective_security_decision_ref', () => {
    const result = composeCommandStructuralDecision(
      enforcedInput(['allow', 'ask', 'allow', 'allow', 'allow']),
    );
    expect(result.candidate_behavior).toBe('ask');
    expect(result.effective_security_decision_ref).toMatch(/^cmd:snap-action-1:ask$/);
  });

  it('effective_security_decision_ref binds to same action_snapshot_id', () => {
    // spec §11.6 rule 7: 必须"绑定同一 action snapshot"——ref 字面量含 snapshot_id。
    const result = composeCommandStructuralDecision(
      enforcedInput(['allow', 'allow', 'allow', 'allow', 'allow'], {
        action_snapshot_id: 'snap-action-42',
      }),
    );
    expect(result.effective_security_decision_ref).toContain('snap-action-42');
  });
});

// ─────────────────────────────────────────────
// describe: determinism + frozen
// ─────────────────────────────────────────────

describe('DRC-5 enforced composition — determinism & frozen', () => {
  it('produces deterministic structural_decision_id for identical input', () => {
    const a = composeCommandStructuralDecision(enforcedInput(['allow', 'allow', 'allow', 'allow', 'allow']));
    const b = composeCommandStructuralDecision(enforcedInput(['allow', 'allow', 'allow', 'allow', 'allow']));
    expect(a.structural_decision_id).toBe(b.structural_decision_id);
    expect(a.structural_decision_id).toMatch(/^structural:[0-9a-f]{16}$/);
  });

  it('produces different structural_decision_id when candidate_behavior differs', () => {
    const allowCase = composeCommandStructuralDecision(enforcedInput(['allow', 'allow', 'allow', 'allow', 'allow']));
    const denyCase = composeCommandStructuralDecision(enforcedInput(['allow', 'allow', 'deny', 'allow', 'allow']));
    expect(allowCase.structural_decision_id).not.toBe(denyCase.structural_decision_id);
  });

  it('freezes the decision (immutable)', () => {
    const result = composeCommandStructuralDecision(
      enforcedInput(['allow', 'allow', 'allow', 'allow', 'allow']),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reason_codes)).toBe(true);
    expect(Object.isFrozen(result.gate_decision_refs)).toBe(true);
  });
});

// ─────────────────────────────────────────────
// describe: 字段集合(防 leakage)
// ─────────────────────────────────────────────

describe('DRC-5 enforced composition — field set', () => {
  it('exposes exactly the spec-defined field set', () => {
    const result = composeCommandStructuralDecision(
      enforcedInput(['allow', 'allow', 'allow', 'allow', 'allow']),
    );
    const keys = Object.keys(result).sort();
    expect(keys).toEqual(
      [
        'action_snapshot_id',
        'candidate_behavior',
        'effective_security_decision_ref',
        'gate_decision_refs',
        'mode',
        'parse_result_id',
        'policy_state_ref',
        'reason_codes',
        'status',
        'structural_decision_id',
        'structural_decision_protocol_version',
      ].sort(),
    );
  });
});
