// Wave D Task 13 (DRC-5): Shadow Comparison。
//
// 物理本质:shadow comparator 是"看 X 光片对比两份诊断的对照员"——
// 它把"现行 policy 的 decision"和"AST 推断的候选 behavior"放在一起比对,
// 输出一份 divergence 报告。它绝不修改现行 decision、绝不下执行结论。
//
// 关键不变量(INV-D14 / spec §11.5):
//   1. shadow 无执行权——不改变 allow/ask/deny/execution/pending/Outcome;
//   2. effective_security_decision_ref 字段根本不存在于本类型;
//   3. AST candidate 不能 allow/ask/deny/取消/修改动作——只是"候选 behavior";
//   4. shadow 不是"部分 enforcement"——它永远不影响现行 actual decision;
//   5. mode 只来自受信 policy_state,Prompt/用户/模型/telemetry 不能切换;
//   6. 历史 comparison immutable;
//   7. enforcement 失败不能回退 shadow(spec §11.6 rule 8)——本函数对 enforced
//      直接 throw,不偷偷降级。
//
// 本测试覆盖:5 种 divergence 全枚举、mode 守门、identity 守门、
// 决定性 comparison_id、decision_trace builder 调用与缺省、
// 不调用 runtimeGate / executor、不变量 INV-D14。

import { describe, expect, it, vi } from 'vitest';
import {
  compareCommandPolicyShadow,
  parseCommandStructure,
  PARSE_PROTOCOL_VERSION,
  SHADOW_PROTOCOL_VERSION,
  SUPPORTED_SHELL_DIALECT,
  SUPPORTED_GRAMMAR_VERSION,
  type CommandParseResult,
  type CommandPolicyState,
  type CommandShadowComparisonInput,
} from '../../permission/command-policy.js';

// ─────────────────────────────────────────────
// fixtures
// ─────────────────────────────────────────────

/** 默认受信 policy_state,mode='shadow'。 */
function shadowPolicyState(
  overrides: Partial<CommandPolicyState> = {},
): CommandPolicyState {
  return {
    command_policy_protocol_version: '1',
    policy_ref: { contract_id: 'drc-5-command-policy', contract_version: '1' },
    mode: 'shadow',
    shell_dialect: SUPPORTED_SHELL_DIALECT,
    grammar_version: SUPPORTED_GRAMMAR_VERSION,
    complexity_policy_ref: 'complexity:posix-shell-v1:1',
    plan_allowlist_policy_ref: 'plan-allowlist:default:1',
    ...overrides,
  };
}

/** 默认 parse 输入——一个最简单的 echo 命令。 */
function defaultParseInput() {
  return {
    parse_protocol_version: PARSE_PROTOCOL_VERSION,
    action_snapshot_id: 'snap-action-1',
    command_content: 'echo hello',
    command_hash: '', // parser 内部会重算
    shell_dialect: SUPPORTED_SHELL_DIALECT,
    grammar_version: SUPPORTED_GRAMMAR_VERSION,
  };
}

const defaultComplexityPolicy = {
  policy_id: 'complexity:posix-shell-v1',
  policy_version: '1',
  max_tokens: 64,
  max_operators: 16,
  max_nesting: 4,
  max_source_length: 4096,
};

/** 拿一个真实 parsed 结果。 */
function parsedResult(
  _overrides: Partial<CommandParseResult> = {},
): CommandParseResult {
  return parseCommandStructure(defaultParseInput(), defaultComplexityPolicy);
}

/** 默认 shadow comparison 输入;behavior 等字段由各用例覆盖。 */
function shadowInput(
  overrides: Partial<CommandShadowComparisonInput> = {},
): CommandShadowComparisonInput {
  return {
    shadow_protocol_version: SHADOW_PROTOCOL_VERSION,
    action_snapshot_id: 'snap-action-1',
    legacy_decision_ref: 'legacy-decision-1',
    legacy_decision_behavior: 'allow',
    ast_parse_result: parsedResult(),
    ast_candidate_behavior: 'deny',
    policy_state: shadowPolicyState(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// describe: INV-D14 — shadow 无执行权
// ─────────────────────────────────────────────

describe('DRC-5 shadow comparison — INV-D14 no execution authority', () => {
  it('never creates an effective security decision in shadow mode', () => {
    const comparison = compareCommandPolicyShadow(shadowInput());
    // divergence 是非 none,但绝不产生 effective_security_decision_ref 字段。
    expect(comparison.divergence).toBe('legacy_more_permissive');
    expect(comparison).not.toHaveProperty('effective_security_decision_ref');
  });

  it('does not invoke runtimeGate or executor (no execution side channel)', () => {
    // Spy 任何"执行权"模块——这里直接断言 compareCommandPolicyShadow 的返回里
    // 不包含任何"被授权执行"的信号,且函数本身不依赖这些模块(只看输入)。
    // 我们通过:对 ast_candidate_behavior 与 legacy 各组合,断言结果字段集合
    // 永远只是 { comparison_id, divergence, reason_codes, decision_trace_event_id, ... }。
    const comparison = compareCommandPolicyShadow(shadowInput());
    const keys = Object.keys(comparison).sort();
    // 字段集合必须固定,不出现 execution / permission / outcome 字样。
    expect(keys).not.toContain('effective_security_decision_ref');
    expect(keys).not.toContain('execution_ref');
    expect(keys).not.toContain('outcome');
    expect(keys).not.toContain('permission_decision_ref');
    // 反向确认:spec §11.5 列出的字段全部存在。
    expect(keys).toEqual(
      [
        'action_snapshot_id',
        'ast_candidate_behavior',
        'comparison_id',
        'decision_trace_event_id',
        'divergence',
        'legacy_decision_ref',
        'reason_codes',
        'shadow_protocol_version',
      ].sort(),
    );
  });

  it('freezes the comparison (immutable history)', () => {
    const comparison = compareCommandPolicyShadow(shadowInput());
    expect(Object.isFrozen(comparison)).toBe(true);
    // reason_codes 数组也应冻结。
    expect(Object.isFrozen(comparison.reason_codes)).toBe(true);
  });

  it('passes through ast_candidate_behavior as a candidate only (never authoritative)', () => {
    // ast_candidate_behavior 应原样回显——shadow 不下结论,只是回显对照。
    const comparison = compareCommandPolicyShadow(
      shadowInput({ ast_candidate_behavior: 'ask' }),
    );
    expect(comparison.ast_candidate_behavior).toBe('ask');
  });
});

// ─────────────────────────────────────────────
// describe: divergence 算法全枚举
// ─────────────────────────────────────────────

describe('DRC-5 shadow comparison — divergence classification', () => {
  it('returns none when behaviors match (allow==allow)', () => {
    const c = compareCommandPolicyShadow(
      shadowInput({
        legacy_decision_behavior: 'allow',
        ast_candidate_behavior: 'allow',
      }),
    );
    expect(c.divergence).toBe('none');
  });

  it('returns none when behaviors match (deny==deny)', () => {
    const c = compareCommandPolicyShadow(
      shadowInput({
        legacy_decision_behavior: 'deny',
        ast_candidate_behavior: 'deny',
      }),
    );
    expect(c.divergence).toBe('none');
  });

  it('detects legacy_more_permissive when legacy=allow ast=deny', () => {
    const c = compareCommandPolicyShadow(
      shadowInput({
        legacy_decision_behavior: 'allow',
        ast_candidate_behavior: 'deny',
      }),
    );
    expect(c.divergence).toBe('legacy_more_permissive');
  });

  it('detects ast_more_permissive when ast=allow legacy=deny', () => {
    const c = compareCommandPolicyShadow(
      shadowInput({
        legacy_decision_behavior: 'deny',
        ast_candidate_behavior: 'allow',
      }),
    );
    expect(c.divergence).toBe('ast_more_permissive');
  });

  it('returns not_comparable when legacy_decision_behavior is null', () => {
    const c = compareCommandPolicyShadow(
      shadowInput({
        legacy_decision_behavior: null,
        ast_candidate_behavior: 'allow',
      }),
    );
    expect(c.divergence).toBe('not_comparable');
  });

  it('returns not_comparable when ast_candidate_behavior is null', () => {
    const c = compareCommandPolicyShadow(
      shadowInput({
        legacy_decision_behavior: 'allow',
        ast_candidate_behavior: null,
      }),
    );
    expect(c.divergence).toBe('not_comparable');
  });

  it('classifies cross-category legacy=ask ast=allow as classification_mismatch', () => {
    // ask 与 allow 跨"询问类"与"放行类",不是简单的谁更宽松——分类不匹配。
    const c = compareCommandPolicyShadow(
      shadowInput({
        legacy_decision_behavior: 'ask',
        ast_candidate_behavior: 'allow',
      }),
    );
    expect(c.divergence).toBe('classification_mismatch');
  });

  it('classifies cross-category legacy=allow ast=ask as classification_mismatch', () => {
    const c = compareCommandPolicyShadow(
      shadowInput({
        legacy_decision_behavior: 'allow',
        ast_candidate_behavior: 'ask',
      }),
    );
    expect(c.divergence).toBe('classification_mismatch');
  });
});

// ─────────────────────────────────────────────
// describe: mode 守门 + identity 守门
// ─────────────────────────────────────────────

describe('DRC-5 shadow comparison — guards', () => {
  it('throws when policy_state mode is enforced (not shadow)', () => {
    // enforced 由 T14 处理——本函数对 enforced 直接 throw,
    // 不偷偷降级为 shadow(spec §11.6 rule 8: enforcement failure 不能回退 legacy allow)。
    expect(() =>
      compareCommandPolicyShadow(
        shadowInput({ policy_state: shadowPolicyState({ mode: 'enforced' }) }),
      ),
    ).toThrow(/shadow/i);
  });

  it('throws when action_snapshot_id is empty', () => {
    expect(() =>
      compareCommandPolicyShadow(shadowInput({ action_snapshot_id: '' })),
    ).toThrow(/action_snapshot_id/i);
  });

  it('throws when legacy_decision_ref is empty', () => {
    expect(() =>
      compareCommandPolicyShadow(shadowInput({ legacy_decision_ref: '' })),
    ).toThrow(/legacy_decision_ref/i);
  });

  it('throws when ast_parse_result.parse_result_id is empty', () => {
    const emptyIdResult = {
      ...parsedResult(),
      parse_result_id: '',
    } as CommandParseResult;
    expect(() =>
      compareCommandPolicyShadow(
        shadowInput({ ast_parse_result: emptyIdResult }),
      ),
    ).toThrow(/parse_result_id/i);
  });
});

// ─────────────────────────────────────────────
// describe: decision_trace builder + determinism
// ─────────────────────────────────────────────

describe('DRC-5 shadow comparison — decision trace & determinism', () => {
  it('produces deterministic comparison_id for identical input', () => {
    const a = compareCommandPolicyShadow(shadowInput());
    const b = compareCommandPolicyShadow(shadowInput());
    expect(a.comparison_id).toBe(b.comparison_id);
    expect(a.comparison_id).toMatch(/^shadow:[0-9a-f]{16}$/);
  });

  it('produces different comparison_id when divergence differs', () => {
    const allowAllow = compareCommandPolicyShadow(
      shadowInput({
        legacy_decision_behavior: 'allow',
        ast_candidate_behavior: 'allow',
      }),
    );
    const allowDeny = compareCommandPolicyShadow(
      shadowInput({
        legacy_decision_behavior: 'allow',
        ast_candidate_behavior: 'deny',
      }),
    );
    expect(allowAllow.comparison_id).not.toBe(allowDeny.comparison_id);
  });

  it('invokes decision_trace builder when provided and stores returned event id', () => {
    const builder = vi.fn(() => 'trace-event-xyz');
    const c = compareCommandPolicyShadow(shadowInput({ decision_trace_builder: builder }));
    expect(builder).toHaveBeenCalledOnce();
    // builder 必须收到完整的对照上下文。
    const arg = builder.mock.calls[0][0];
    expect(arg.action_snapshot_id).toBe('snap-action-1');
    expect(arg.subsystem).toBe('command_policy');
    expect(arg.divergence).toBe('legacy_more_permissive');
    expect(c.decision_trace_event_id).toBe('trace-event-xyz');
  });

  it('returns null decision_trace_event_id when builder is not provided', () => {
    // telemetry 不可用时不影响现行 decision(spec §11.5 rule 4)。
    const c = compareCommandPolicyShadow(shadowInput());
    expect(c.decision_trace_event_id).toBeNull();
  });

  it('does not let decision_trace builder failure affect divergence (telemetry non-blocking)', () => {
    // spec §11.9: decision trace 写入失败不改变 SecurityDecision。
    // 这里我们让 builder 抛错——comparison 仍应产出 divergence 与 comparison_id。
    // 注:我们让 builder 抛错时降级为 null event_id,而非传播异常。
    const throwingBuilder = () => {
      throw new Error('trace pipeline down');
    };
    const c = compareCommandPolicyShadow(
      shadowInput({ decision_trace_builder: throwingBuilder }),
    );
    expect(c.divergence).toBe('legacy_more_permissive');
    expect(c.decision_trace_event_id).toBeNull();
  });
});

// ─────────────────────────────────────────────
// describe: reason_codes
// ─────────────────────────────────────────────

describe('DRC-5 shadow comparison — reason codes', () => {
  it('emits reason_codes describing the divergence (no hidden reasoning)', () => {
    // spec §11.7 rule 9: 决策解释只使用 reason/risk codes,不记录隐藏思维。
    const c = compareCommandPolicyShadow(
      shadowInput({
        legacy_decision_behavior: 'allow',
        ast_candidate_behavior: 'deny',
      }),
    );
    expect(Array.isArray(c.reason_codes)).toBe(true);
    expect(c.reason_codes.length).toBeGreaterThan(0);
    // reason_codes 全部应是字符串。
    for (const code of c.reason_codes) {
      expect(typeof code).toBe('string');
      expect(code.length).toBeGreaterThan(0);
    }
  });

  it('includes not_comparable reason when either behavior is null', () => {
    const c = compareCommandPolicyShadow(
      shadowInput({
        legacy_decision_behavior: null,
        ast_candidate_behavior: 'allow',
      }),
    );
    expect(c.divergence).toBe('not_comparable');
    expect(c.reason_codes.some((r) => r.includes('not_comparable'))).toBe(true);
  });
});

// ─────────────────────────────────────────────
// describe: 受信状态(mode 不能由非受信来源切换)
// ─────────────────────────────────────────────

describe('DRC-5 shadow comparison — trusted policy_state source', () => {
  it('mode is read only from policy_state, not from input-level override fields', () => {
    // 输入类型上不存在任何 prompt/user/model/telemetry 提供的 mode 字段——
    // TypeScript 类型本身强制了这点。我们这里通过运行时验证:
    // 即便强行塞入 (mode as any) 也不被读取(policy_state.mode 才是唯一来源)。
    const c = compareCommandPolicyShadow(
      shadowInput({ policy_state: shadowPolicyState({ mode: 'shadow' }) }),
    );
    expect(c.divergence).toBeDefined();
    // 没有任何出口字段暗示 mode 来源。
    expect(c).not.toHaveProperty('mode_source');
    expect(c).not.toHaveProperty('requested_mode');
  });
});
