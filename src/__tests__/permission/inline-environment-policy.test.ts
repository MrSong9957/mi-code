// ERC-4 / M-065 Inline Environment Policy — 单元测试
//
// 物理本质:把 DRC-5 解析出的 inline VAR=value 语法事实,
// 按平台 policy 分类成 safe/controlled/path-resoloader/loader/unknown,
// 然后映射到 preserve/strip/ask/deny 结构化决策。
//
// 关键不变量(spec §10.4 + §10.9 + INV-E14/E17):
//   1. inherited 与 inline 是 AND — 本模块只处理 inline,不恢复 M-063 已剥离的;
//   2. 平台 policy 不混用(Windows/Linux/macOS 独立版本化);
//   3. decision 只保存 value_ref/hash/source range,不复制实际 value;
//   4. Plan Mode / ask-unavailable 下 loader injection 与 unknown → deny;
//   5. aggregated_action 是最严格(deny > ask > strip > preserve);
//   6. 不声称变量全集完整。

import { describe, expect, it } from 'vitest';
import {
  classifyInlineAssignments,
  decideInlineEnvironment,
  getDefaultPlatformEnvironmentPolicy,
  INLINE_ENVIRONMENT_PROTOCOL_VERSION,
  type InlineAssignmentFact,
  type InlineEnvironmentAction,
  type InlineAssignmentRisk,
  type PlatformEnvironmentPolicy,
  type PlatformFamily,
} from '../../permission/executable-environment.js';

// ─────────────────────────────────────────────
// 测试夹具
// ─────────────────────────────────────────────

const windowsPolicy = getDefaultPlatformEnvironmentPolicy('win32');
const linuxPolicy = getDefaultPlatformEnvironmentPolicy('linux');
const macosPolicy = getDefaultPlatformEnvironmentPolicy('darwin');

/**
 * 构造一个最小合法的 inline assignment fact。
 *
 * 注意:value_ref 是受控引用(不复制实际值),value_hash 是 sha256(value)。
 * 调用方覆盖 variable_name 即可触发不同 risk 分类。
 */
const fact = (
  overrides: Partial<InlineAssignmentFact> & { variable_name: string },
): InlineAssignmentFact => ({
  assignment_id: 'a-1',
  value_ref: 'ref:secret-store:a-1',
  value_hash: 'deadbeef'.repeat(8),
  source_range_ref: 'range:0:11',
  ...overrides,
});

/** 构造一个 build-mode、ask-available、windows 的 decideInlineEnvironment 输入。 */
const decideInput = (
  assignments: ReadonlyArray<InlineAssignmentFact>,
  overrides: {
    platform?: PlatformFamily;
    control_mode?: 'plan' | 'build' | 'auto';
    policy?: PlatformEnvironmentPolicy;
    ask_channel_available?: boolean;
  } = {},
) => ({
  decision_protocol_version: INLINE_ENVIRONMENT_PROTOCOL_VERSION,
  action_snapshot_id: 'snap-1',
  platform: (overrides.platform ?? 'win32') as PlatformFamily,
  control_mode: (overrides.control_mode ?? 'build') as 'plan' | 'build' | 'auto',
  assignments,
  policy:
    overrides.policy ??
    (overrides.platform === 'linux'
      ? linuxPolicy
      : overrides.platform === 'darwin'
        ? macosPolicy
        : windowsPolicy),
  ask_channel_available: overrides.ask_channel_available ?? true,
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 1: classifyInlineAssignments — 平台 denied 矩阵
// ═══════════════════════════════════════════════════════════════════════════

describe('classifyInlineAssignments — 平台 denied 矩阵 (INV-E17 平台 policy 不混用)', () => {
  it('windows: PATH / PATHEXT / COMSPEC → path_resolution_affecting (invariant uppercase)', () => {
    const classifications = classifyInlineAssignments(
      [
        fact({ assignment_id: 'a1', variable_name: 'PATH' }),
        fact({ assignment_id: 'a2', variable_name: 'path' }), // lowercase 仍命中
        fact({ assignment_id: 'a3', variable_name: 'Path' }),
        fact({ assignment_id: 'a4', variable_name: 'PATHEXT' }),
        fact({ assignment_id: 'a5', variable_name: 'pathext' }),
        fact({ assignment_id: 'a6', variable_name: 'COMSPEC' }),
        fact({ assignment_id: 'a7', variable_name: 'ComSpec' }),
      ],
      windowsPolicy,
    );
    const byId = new Map(classifications.map((c) => [c.assignment_id, c]));
    expect(byId.get('a1')?.risk).toBe('path_resolution_affecting');
    expect(byId.get('a2')?.risk).toBe('path_resolution_affecting');
    expect(byId.get('a3')?.risk).toBe('path_resolution_affecting');
    expect(byId.get('a4')?.risk).toBe('path_resolution_affecting');
    expect(byId.get('a5')?.risk).toBe('path_resolution_affecting');
    expect(byId.get('a6')?.risk).toBe('path_resolution_affecting');
    expect(byId.get('a7')?.risk).toBe('path_resolution_affecting');
  });

  it('linux: PATH / LD_PRELOAD / LD_LIBRARY_PATH — case-sensitive (lowercase NOT denied)', () => {
    const classifications = classifyInlineAssignments(
      [
        fact({ assignment_id: 'a1', variable_name: 'PATH' }),
        fact({ assignment_id: 'a2', variable_name: 'LD_PRELOAD' }),
        fact({ assignment_id: 'a3', variable_name: 'LD_LIBRARY_PATH' }),
        // case-sensitive — lowercase 不应命中 denied
        fact({ assignment_id: 'a4', variable_name: 'path' }),
        fact({ assignment_id: 'a5', variable_name: 'ld_preload' }),
      ],
      linuxPolicy,
    );
    const byId = new Map(classifications.map((c) => [c.assignment_id, c]));
    expect(byId.get('a1')?.risk).toBe('path_resolution_affecting');
    expect(byId.get('a2')?.risk).toBe('loader_injection');
    expect(byId.get('a3')?.risk).toBe('loader_injection');
    // case-sensitive — 小写不命中
    expect(byId.get('a4')?.risk).toBe('unknown');
    expect(byId.get('a5')?.risk).toBe('unknown');
  });

  it('macos: DYLD_INSERT_LIBRARIES / DYLD_LIBRARY_PATH → loader_injection; PATH → path_resolution_affecting', () => {
    const classifications = classifyInlineAssignments(
      [
        fact({ assignment_id: 'a1', variable_name: 'PATH' }),
        fact({ assignment_id: 'a2', variable_name: 'DYLD_INSERT_LIBRARIES' }),
        fact({ assignment_id: 'a3', variable_name: 'DYLD_LIBRARY_PATH' }),
      ],
      macosPolicy,
    );
    const byId = new Map(classifications.map((c) => [c.assignment_id, c]));
    expect(byId.get('a1')?.risk).toBe('path_resolution_affecting');
    expect(byId.get('a2')?.risk).toBe('loader_injection');
    expect(byId.get('a3')?.risk).toBe('loader_injection');
  });

  it('windows policy does NOT deny LD_PRELOAD (no cross-platform bleed)', () => {
    const classifications = classifyInlineAssignments(
      [fact({ variable_name: 'LD_PRELOAD' })],
      windowsPolicy,
    );
    expect(classifications[0].risk).toBe('unknown');
  });

  it('linux policy does NOT deny COMSPEC (no cross-platform bleed)', () => {
    const classifications = classifyInlineAssignments(
      [fact({ variable_name: 'COMSPEC' })],
      linuxPolicy,
    );
    expect(classifications[0].risk).toBe('unknown');
  });

  it('safe_passthrough / controlled_override / unknown 分类', () => {
    const policy: PlatformEnvironmentPolicy = {
      policy_id: 'test',
      policy_version: '1',
      platform: 'linux',
      denied_variables: new Set(['PATH']),
      safe_passthrough_variables: new Set(['MY_SAFE_VAR']),
      controlled_override_variables: new Set(['MY_CONTROLLED']),
      plan_mode_unknown_action: 'deny',
      ask_unavailable_action: 'deny',
    };
    const classifications = classifyInlineAssignments(
      [
        fact({ assignment_id: 's', variable_name: 'MY_SAFE_VAR' }),
        fact({ assignment_id: 'c', variable_name: 'MY_CONTROLLED' }),
        fact({ assignment_id: 'u', variable_name: 'WHATEVER' }),
        fact({ assignment_id: 'p', variable_name: 'PATH' }),
      ],
      policy,
    );
    const byId = new Map(classifications.map((c) => [c.assignment_id, c]));
    expect(byId.get('s')?.risk).toBe('safe_passthrough');
    expect(byId.get('c')?.risk).toBe('controlled_override');
    expect(byId.get('u')?.risk).toBe('unknown');
    expect(byId.get('p')?.risk).toBe('path_resolution_affecting');
  });

  it('每个 classification 携带 assignment_id / variable_name / risk / reason_code', () => {
    const classifications = classifyInlineAssignments(
      [fact({ assignment_id: 'a1', variable_name: 'PATH' })],
      windowsPolicy,
    );
    expect(classifications[0]).toEqual(
      expect.objectContaining({
        assignment_id: 'a1',
        variable_name: 'PATH',
        risk: 'path_resolution_affecting',
      }),
    );
    expect(typeof classifications[0].reason_code).toBe('string');
    expect(classifications[0].reason_code.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 2: decideInlineEnvironment — risk → action 映射
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 构造一个会让单个 assignment 落入指定 risk 的 policy。
 * controlled → 'ask', path/loader → 'deny', unknown → 'ask' (build+ask avail)。
 */
const policyFor = (risk: InlineAssignmentRisk): PlatformEnvironmentPolicy => {
  switch (risk) {
    case 'safe_passthrough':
      return {
        policy_id: 't-safe',
        policy_version: '1',
        platform: 'linux',
        denied_variables: new Set(),
        safe_passthrough_variables: new Set(['TARGET']),
        controlled_override_variables: new Set(),
        plan_mode_unknown_action: 'deny',
        ask_unavailable_action: 'deny',
      };
    case 'controlled_override':
      return {
        policy_id: 't-controlled',
        policy_version: '1',
        platform: 'linux',
        denied_variables: new Set(),
        safe_passthrough_variables: new Set(),
        controlled_override_variables: new Set(['TARGET']),
        plan_mode_unknown_action: 'deny',
        ask_unavailable_action: 'deny',
      };
    case 'path_resolution_affecting':
      return {
        policy_id: 't-path',
        policy_version: '1',
        platform: 'linux',
        denied_variables: new Set(['TARGET']),
        safe_passthrough_variables: new Set(),
        controlled_override_variables: new Set(),
        plan_mode_unknown_action: 'deny',
        ask_unavailable_action: 'deny',
      };
    case 'loader_injection':
      // LD_PRELOAD 在 linux 默认 policy 里就是 loader
      return {
        policy_id: 't-loader',
        policy_version: '1',
        platform: 'linux',
        denied_variables: new Set(['LD_PRELOAD']),
        safe_passthrough_variables: new Set(),
        controlled_override_variables: new Set(),
        plan_mode_unknown_action: 'deny',
        ask_unavailable_action: 'deny',
      };
    case 'unknown':
      return {
        policy_id: 't-unknown',
        policy_version: '1',
        platform: 'linux',
        denied_variables: new Set(),
        safe_passthrough_variables: new Set(),
        controlled_override_variables: new Set(),
        plan_mode_unknown_action: 'deny',
        ask_unavailable_action: 'deny',
      };
  }
};

const variableFor = (risk: InlineAssignmentRisk): string => {
  switch (risk) {
    case 'loader_injection':
      return 'LD_PRELOAD';
    default:
      return 'TARGET';
  }
};

describe('decideInlineEnvironment — risk → action 映射 (build mode + ask available)', () => {
  it.each([
    ['safe_passthrough', 'preserve'],
    ['controlled_override', 'ask'],
    ['path_resolution_affecting', 'deny'],
    ['loader_injection', 'deny'],
    ['unknown', 'ask'],
  ] as const)(
    'maps risk %s to action %s in build mode (ask available)',
    (risk: InlineAssignmentRisk, expected: InlineEnvironmentAction) => {
      const decision = decideInlineEnvironment(
        decideInput(
          [
            fact({
              assignment_id: 'a-1',
              variable_name: variableFor(risk),
            }),
          ],
          { platform: 'linux', policy: policyFor(risk) },
        ),
      );
      expect(decision.actions).toHaveLength(1);
      expect(decision.actions[0].action).toBe(expected);
      expect(decision.aggregated_action).toBe(expected);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 3: control_mode 与 ask_channel 影响 (Plan/ask-unavailable → deny)
// ═══════════════════════════════════════════════════════════════════════════

describe('decideInlineEnvironment — control_mode 与 ask_channel (spec §10.4 rule 4)', () => {
  it('denies unknown in plan mode (即使 ask channel available)', () => {
    const decision = decideInlineEnvironment(
      decideInput([fact({ variable_name: 'WHATEVER' })], {
        platform: 'linux',
        control_mode: 'plan',
        policy: linuxPolicy,
      }),
    );
    expect(decision.actions[0].action).toBe('deny');
    expect(decision.aggregated_action).toBe('deny');
    expect(decision.reason_codes).toContain('unknown_in_plan_mode');
  });

  it('denies unknown when ask channel unavailable (build mode)', () => {
    const decision = decideInlineEnvironment(
      decideInput([fact({ variable_name: 'WHATEVER' })], {
        platform: 'linux',
        control_mode: 'build',
        ask_channel_available: false,
        policy: linuxPolicy,
      }),
    );
    expect(decision.actions[0].action).toBe('deny');
    expect(decision.aggregated_action).toBe('deny');
    expect(decision.reason_codes).toContain('ask_unavailable');
  });

  it('denies loader_injection in plan mode even if ask available', () => {
    const decision = decideInlineEnvironment(
      decideInput([fact({ variable_name: 'LD_PRELOAD' })], {
        platform: 'linux',
        control_mode: 'plan',
        policy: linuxPolicy,
      }),
    );
    expect(decision.actions[0].action).toBe('deny');
    expect(decision.aggregated_action).toBe('deny');
  });

  it('denies loader_injection when ask unavailable', () => {
    const decision = decideInlineEnvironment(
      decideInput([fact({ variable_name: 'LD_PRELOAD' })], {
        platform: 'linux',
        control_mode: 'build',
        ask_channel_available: false,
        policy: linuxPolicy,
      }),
    );
    expect(decision.actions[0].action).toBe('deny');
  });

  it('denies path_resolution_affecting regardless of mode/ask (恒定 deny)', () => {
    const cases = [
      { control_mode: 'plan' as const, ask: true },
      { control_mode: 'build' as const, ask: false },
      { control_mode: 'auto' as const, ask: true },
    ];
    for (const c of cases) {
      const decision = decideInlineEnvironment(
        decideInput([fact({ variable_name: 'PATH' })], {
          platform: 'linux',
          control_mode: c.control_mode,
          ask_channel_available: c.ask,
          policy: linuxPolicy,
        }),
      );
      expect(decision.actions[0].action).toBe('deny');
      expect(decision.aggregated_action).toBe('deny');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 4: aggregated_action — 最严格
// ═══════════════════════════════════════════════════════════════════════════

describe('decideInlineEnvironment — aggregated_action 是最严格 (deny > ask > strip > preserve)', () => {
  it('aggregates to deny when any single assignment is deny (loader + safe mix)', () => {
    const decision = decideInlineEnvironment(
      decideInput(
        [
          fact({ assignment_id: 'safe', variable_name: 'MY_SAFE' }),
          fact({ assignment_id: 'loader', variable_name: 'LD_PRELOAD' }),
        ],
        {
          platform: 'linux',
          policy: {
            policy_id: 'mix',
            policy_version: '1',
            platform: 'linux',
            denied_variables: new Set(['LD_PRELOAD']),
            safe_passthrough_variables: new Set(['MY_SAFE']),
            controlled_override_variables: new Set(),
            plan_mode_unknown_action: 'deny',
            ask_unavailable_action: 'deny',
          },
        },
      ),
    );
    expect(decision.actions).toHaveLength(2);
    expect(decision.aggregated_action).toBe('deny');
  });

  it('aggregates to ask when one ask and one preserve (no deny)', () => {
    const decision = decideInlineEnvironment(
      decideInput(
        [
          fact({ assignment_id: 'safe', variable_name: 'MY_SAFE' }),
          fact({ assignment_id: 'ctl', variable_name: 'MY_CTL' }),
        ],
        {
          platform: 'linux',
          policy: {
            policy_id: 'mix2',
            policy_version: '1',
            platform: 'linux',
            denied_variables: new Set(),
            safe_passthrough_variables: new Set(['MY_SAFE']),
            controlled_override_variables: new Set(['MY_CTL']),
            plan_mode_unknown_action: 'deny',
            ask_unavailable_action: 'deny',
          },
        },
      ),
    );
    expect(decision.aggregated_action).toBe('ask');
  });

  it('aggregates to preserve only when all assignments preserve', () => {
    const decision = decideInlineEnvironment(
      decideInput(
        [
          fact({ assignment_id: 's1', variable_name: 'MY_SAFE' }),
          fact({ assignment_id: 's2', variable_name: 'MY_SAFE2' }),
        ],
        {
          platform: 'linux',
          policy: {
            policy_id: 'all-safe',
            policy_version: '1',
            platform: 'linux',
            denied_variables: new Set(),
            safe_passthrough_variables: new Set(['MY_SAFE', 'MY_SAFE2']),
            controlled_override_variables: new Set(),
            plan_mode_unknown_action: 'deny',
            ask_unavailable_action: 'deny',
          },
        },
      ),
    );
    expect(decision.aggregated_action).toBe('preserve');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 5: secret non-observability — decision 不复制实际 value
// ═══════════════════════════════════════════════════════════════════════════

describe('decideInlineEnvironment — secret non-observability (spec §10.3 + INV-E14)', () => {
  it('does not leak actual env value into decision (decision 不携带 value/ref)', () => {
    const decision = decideInlineEnvironment(
      decideInput(
        [
          fact({
            assignment_id: 'a-1',
            variable_name: 'PATH',
            value_ref: 'ref:store:a-1',
            value_hash: 'aaaa'.repeat(16),
            source_range_ref: 'range:0:9',
          }),
        ],
        { platform: 'linux', policy: linuxPolicy },
      ),
    );
    const json = JSON.stringify(decision);
    // decision 不应包含实际 secret value(结构上无法表达)
    expect(json).not.toMatch(/"value"\s*:/);
    expect(json).not.toMatch(/"raw_value"\s*:/);
    // decision 也不复制 value_ref / value_hash ——
    // 调用方需要时由 SanitizedExecutionPlan 单独引用 InlineAssignmentFact,
    // decision 本身只暴露 assignment_id / variable_name / risk / reason_code。
    expect(json).not.toContain('ref:store:a-1');
    // value_hash 也不应在 decision JSON 里出现
    expect(json).not.toContain('aaaa');
    // classifications 与 actions 项不应携带 value 字段
    expect(decision.classifications[0]).not.toHaveProperty('value');
    expect(decision.actions[0]).not.toHaveProperty('value');
  });

  it('classification 携带 assignment_id / variable_name / risk / reason_code,不含 value', () => {
    const decision = decideInlineEnvironment(
      decideInput([fact({ variable_name: 'PATH' })], {
        platform: 'linux',
        policy: linuxPolicy,
      }),
    );
    const c = decision.classifications[0];
    expect(c).toHaveProperty('assignment_id');
    expect(c).toHaveProperty('variable_name');
    expect(c).toHaveProperty('risk');
    expect(c).toHaveProperty('reason_code');
    expect(c).not.toHaveProperty('value');
    expect(c).not.toHaveProperty('value_ref');
    expect(c).not.toHaveProperty('value_hash');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 6: determinism + frozen + identity
// ═══════════════════════════════════════════════════════════════════════════

describe('decideInlineEnvironment — determinism / frozen / identity', () => {
  it('produces deterministic decision_id for same input', () => {
    const input = decideInput([fact({ variable_name: 'PATH' })], {
      platform: 'linux',
      policy: linuxPolicy,
    });
    const d1 = decideInlineEnvironment(input);
    const d2 = decideInlineEnvironment(input);
    expect(d1.decision_id).toBe(d2.decision_id);
    expect(d1.decision_id).toMatch(/^inline-env:[0-9a-f]{16}$/);
  });

  it('decision_id changes when assignment set changes', () => {
    const base = decideInput([fact({ variable_name: 'PATH' })], {
      platform: 'linux',
      policy: linuxPolicy,
    });
    const d1 = decideInlineEnvironment(base);
    const d2 = decideInlineEnvironment({
      ...base,
      assignments: [
        fact({ assignment_id: 'a-2', variable_name: 'PATH' }),
      ],
    });
    expect(d1.decision_id).not.toBe(d2.decision_id);
  });

  it('decision is frozen (Object.isFrozen)', () => {
    const decision = decideInlineEnvironment(
      decideInput([fact({ variable_name: 'PATH' })], {
        platform: 'linux',
        policy: linuxPolicy,
      }),
    );
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.classifications)).toBe(true);
    expect(Object.isFrozen(decision.actions)).toBe(true);
  });

  it('returns protocol_version / decision_id / action_snapshot_id / platform / control_mode', () => {
    const decision = decideInlineEnvironment(
      decideInput([fact({ variable_name: 'PATH' })], {
        platform: 'darwin',
        control_mode: 'auto',
        policy: macosPolicy,
      }),
    );
    expect(decision.inline_decision_protocol_version).toBe(
      INLINE_ENVIRONMENT_PROTOCOL_VERSION,
    );
    expect(decision.action_snapshot_id).toBe('snap-1');
    expect(decision.platform).toBe('darwin');
    expect(decision.control_mode).toBe('auto');
  });

  it('throws on missing action_snapshot_id identity', () => {
    expect(() =>
      decideInlineEnvironment({
        ...decideInput([fact({ variable_name: 'PATH' })], {
          platform: 'linux',
          policy: linuxPolicy,
        }),
        action_snapshot_id: '',
      }),
    ).toThrow(/action_snapshot_id/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 7: empty assignments + reason_codes
// ═══════════════════════════════════════════════════════════════════════════

describe('decideInlineEnvironment — 边界条件', () => {
  it('empty assignments → aggregated_action=preserve, no classifications', () => {
    const decision = decideInlineEnvironment(
      decideInput([], { platform: 'linux', policy: linuxPolicy }),
    );
    expect(decision.classifications).toEqual([]);
    expect(decision.actions).toEqual([]);
    expect(decision.aggregated_action).toBe('preserve');
  });

  it('each action carries assignment_id / action / reason_code', () => {
    const decision = decideInlineEnvironment(
      decideInput(
        [
          fact({ assignment_id: 'a1', variable_name: 'PATH' }),
          fact({ assignment_id: 'a2', variable_name: 'LD_PRELOAD' }),
        ],
        { platform: 'linux', policy: linuxPolicy },
      ),
    );
    for (const a of decision.actions) {
      expect(typeof a.assignment_id).toBe('string');
      expect(typeof a.action).toBe('string');
      expect(typeof a.reason_code).toBe('string');
    }
  });
});
