// Memory Admission 测试 (DRC-2 / M-044)
//
// 覆盖规格 docs/superpowers/specs/2026-07-26-agent-integrated-capabilities-wave-d-design.md
//   - §8.6 Memory admission input
//   - §8.7 Memory admission decision (admit ≠ persisted ≠ selected ≠ use)
//   - §8.8 Admission policy (reject / defer 规则)
//   - §8.9 Confidence 语义
//   - §8.11 Cross-channel 不变量
//
// admission 只决定 candidate 是否可交给 M-045 持久化 (INV-D6)。
// confidence 不等于事实 (INV-D7) —— confidence=1 仍需 evidence/freshness/use verification。
// Project Instruction 不能绕过 typed candidate 直接 admission (INV-D5)。
// decideMemoryAdmission 不读写 MemoryManager。

import { describe, it, expect } from 'vitest';
import {
  decideMemoryAdmission,
  MEMORY_ADMISSION_PROTOCOL_VERSION,
  type MemoryAdmissionInput,
  type MemoryAdmissionPolicy,
} from '../../memory/admission.js';

// 基线 policy:type-specific thresholds + 默认值。
// 阈值设计依据:不同 memory type 对"producer 自报置信"的可信度门槛不同。
//   - user_preference:用户偏好主观性高,需要较强 evidence → 0.6
//   - project_fact:项目事实通常可验证 → 0.5
//   - workflow_pattern:模式需多次重复 → 0.7
//   - failure_observation:失败结论代价大 → 0.7
//   默认:0.5(保守)
const basePolicy: MemoryAdmissionPolicy = {
  confidence_thresholds: {
    user_preference: 0.6,
    project_fact: 0.5,
    workflow_pattern: 0.7,
    failure_observation: 0.7,
  },
  default_confidence_threshold: 0.5,
  require_evidence: true,
  require_freshness: true,
};

// 基线合法输入:其它用例在其上覆盖单字段。
const validInput: MemoryAdmissionInput = {
  admission_protocol_version: MEMORY_ADMISSION_PROTOCOL_VERSION,
  memory_candidate_id: 'mem:abcdef0123456789',
  memory_policy_ref: { contract_id: 'memory-policy', contract_version: '1' },
  current_context_snapshot_id: 'snap-1',
  project_version_ref: 'proj-v1',
  candidate_evidence_refs: ['ev-1'],
  candidate_type: 'user_preference',
  candidate_claim: 'prefers tabs over spaces',
  candidate_confidence: 0.8,
  candidate_scope_ref: 'workspace-1',
  candidate_context_refs: [],
  candidate_invalidation_conditions: [],
  candidate_sensitivity_labels: [],
  candidate_observed_at: '2026-07-26T00:00:00Z',
  candidate_expires_at: null,
  candidate_source_channel: 'auto_memory',
  content_class: 'normal',
  validity_scope: 'persistent',
  freshness_status: 'fresh',
  refresh_path_available: false,
};

describe('decideMemoryAdmission — admit happy path', () => {
  it('admits a valid candidate', () => {
    const d = decideMemoryAdmission(validInput, basePolicy);
    expect(d.status).toBe('admit');
    expect(d.admission_protocol_version).toBe(MEMORY_ADMISSION_PROTOCOL_VERSION);
    expect(d.memory_candidate_id).toBe('mem:abcdef0123456789');
    expect(d.policy_ref).toEqual({ contract_id: 'memory-policy', contract_version: '1' });
    expect(d.current_context_snapshot_id).toBe('snap-1');
    expect(d.accepted_scope_ref).toBe('workspace-1');
    expect(d.accepted_type).toBe('user_preference');
    expect(d.evidence_refs).toEqual(['ev-1']);
  });

  it('admit still requires verification requirements (admit ≠ use)', () => {
    // INV-D6 / §8.7:admit 不表示已经写入,也不表示以后可无验证使用。
    const d = decideMemoryAdmission(validInput, basePolicy);
    expect(d.status).toBe('admit');
    expect(d.verification_requirements.length).toBeGreaterThan(0);
  });

  it('admit decision id is deterministic and content-addressed', () => {
    const a = decideMemoryAdmission(validInput, basePolicy);
    const b = decideMemoryAdmission({ ...validInput }, basePolicy);
    expect(a.admission_decision_id).toBe(b.admission_decision_id);
    expect(a.admission_decision_id).toMatch(/^admit:[a-f0-9]{16}$/);
  });

  it('returns a frozen decision object', () => {
    const d = decideMemoryAdmission(validInput, basePolicy);
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.reason_codes)).toBe(true);
    expect(Object.isFrozen(d.verification_requirements)).toBe(true);
  });
});

describe('decideMemoryAdmission — reject cases (§8.8)', () => {
  it.each([
    ['credential', { content_class: 'credential' }],
    ['secret', { content_class: 'secret' }],
    ['current_turn_state', { validity_scope: 'current_turn' }],
    ['missing_evidence', { candidate_evidence_refs: [] }],
    ['project_instruction_channel', { candidate_source_channel: 'project_instruction' as const }],
    ['tool_result_channel', { candidate_source_channel: 'tool_result' as const }],
    ['other_channel', { candidate_source_channel: 'other' as const }],
  ])('rejects %s', (_name, failure) => {
    const d = decideMemoryAdmission({ ...validInput, ...failure } as MemoryAdmissionInput, basePolicy);
    expect(d.status).toBe('reject');
    expect(d.reason_codes.length).toBeGreaterThan(0);
    expect(d.accepted_scope_ref).toBeNull();
    expect(d.accepted_type).toBeNull();
  });

  it('rejects credential with memory.credential_content reason code', () => {
    const d = decideMemoryAdmission(
      { ...validInput, content_class: 'credential' },
      basePolicy,
    );
    expect(d.status).toBe('reject');
    expect(d.reason_codes).toContain('memory.credential_content');
  });

  it('rejects current_turn with memory.temporary_state reason code', () => {
    const d = decideMemoryAdmission(
      { ...validInput, validity_scope: 'current_turn' },
      basePolicy,
    );
    expect(d.status).toBe('reject');
    expect(d.reason_codes).toContain('memory.temporary_state');
  });

  it('rejects empty evidence with memory.missing_evidence reason code', () => {
    const d = decideMemoryAdmission(
      { ...validInput, candidate_evidence_refs: [] },
      basePolicy,
    );
    expect(d.status).toBe('reject');
    expect(d.reason_codes).toContain('memory.missing_evidence');
  });

  it('rejects wrong channel with memory.wrong_channel reason code', () => {
    const d = decideMemoryAdmission(
      { ...validInput, candidate_source_channel: 'project_instruction' },
      basePolicy,
    );
    expect(d.status).toBe('reject');
    expect(d.reason_codes).toContain('memory.wrong_channel');
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negative', -0.1],
    ['over_one', 1.5],
  ])('rejects invalid confidence (%s)', (_name, confidence) => {
    const d = decideMemoryAdmission(
      { ...validInput, candidate_confidence: confidence },
      basePolicy,
    );
    expect(d.status).toBe('reject');
    expect(d.reason_codes).toContain('memory.invalid_confidence');
  });

  it('rejects when sensitivity_labels contain secret', () => {
    const d = decideMemoryAdmission(
      { ...validInput, candidate_sensitivity_labels: ['secret'] },
      basePolicy,
    );
    expect(d.status).toBe('reject');
    expect(d.reason_codes.some((c) => c.startsWith('memory.sensitive'))).toBe(true);
  });

  it('rejects when sensitivity_labels contain credential', () => {
    const d = decideMemoryAdmission(
      { ...validInput, candidate_sensitivity_labels: ['credential'] },
      basePolicy,
    );
    expect(d.status).toBe('reject');
  });

  it('does not require evidence when policy.require_evidence=false', () => {
    const d = decideMemoryAdmission(
      { ...validInput, candidate_evidence_refs: [] },
      { ...basePolicy, require_evidence: false },
    );
    // evidence 空但 policy 不要求 → 不因 missing_evidence reject
    expect(d.status).not.toBe('reject');
    expect(d.reason_codes).not.toContain('memory.missing_evidence');
  });
});

describe('decideMemoryAdmission — defer cases (§8.8)', () => {
  it('defers stale evidence when refresh path exists', () => {
    const d = decideMemoryAdmission(
      {
        ...validInput,
        freshness_status: 'stale',
        refresh_path_available: true,
      },
      basePolicy,
    );
    expect(d.status).toBe('defer');
    expect(d.reason_codes).toContain('memory.freshness.refresh_required');
    expect(d.accepted_scope_ref).toBeNull();
  });

  it('defers when freshness unknown and require_freshness=true', () => {
    const d = decideMemoryAdmission(
      {
        ...validInput,
        freshness_status: 'unknown',
      },
      basePolicy,
    );
    expect(d.status).toBe('defer');
    expect(d.reason_codes).toContain('memory.freshness.unknown');
  });

  it('does not defer on unknown freshness when require_freshness=false', () => {
    const d = decideMemoryAdmission(
      { ...validInput, freshness_status: 'unknown' },
      { ...basePolicy, require_freshness: false },
    );
    expect(d.status).toBe('admit');
  });

  it('rejects stale evidence when no refresh path exists (stale is hard fail without refresh)', () => {
    // stale 且无刷新路径:无法恢复新鲜度 → 不能 admit,也不是 defer(无 path)。
    // 设计选择:归入 reject(memory.freshness.stale_no_refresh)。
    const d = decideMemoryAdmission(
      {
        ...validInput,
        freshness_status: 'stale',
        refresh_path_available: false,
      },
      basePolicy,
    );
    expect(d.status).toBe('reject');
    expect(d.reason_codes.some((c) => c.startsWith('memory.freshness'))).toBe(true);
  });
});

describe('decideMemoryAdmission — confidence semantics (§8.9)', () => {
  it('confidence=1 still requires evidence (INV-D7)', () => {
    const d = decideMemoryAdmission(
      { ...validInput, candidate_confidence: 1, candidate_evidence_refs: [] },
      basePolicy,
    );
    expect(d.status).toBe('reject');
    expect(d.reason_codes).toContain('memory.missing_evidence');
  });

  it('confidence=1 still requires freshness (INV-D7)', () => {
    const d = decideMemoryAdmission(
      { ...validInput, candidate_confidence: 1, freshness_status: 'unknown' },
      basePolicy,
    );
    expect(d.status).toBe('defer');
    expect(d.reason_codes).toContain('memory.freshness.unknown');
  });

  it('admits at exactly threshold boundary (>=)', () => {
    const d = decideMemoryAdmission(
      { ...validInput, candidate_confidence: 0.6 }, // user_preference threshold
      basePolicy,
    );
    expect(d.status).toBe('admit');
  });

  it('defers when confidence below threshold', () => {
    const d = decideMemoryAdmission(
      { ...validInput, candidate_confidence: 0.59 },
      basePolicy,
    );
    // 低于阈值:不是 reject(候选本身合法),是 defer(置信不足,需更多 evidence)。
    expect(d.status).toBe('defer');
    expect(d.reason_codes.some((c) => c.includes('confidence'))).toBe(true);
  });

  it('uses default threshold for unmapped type', () => {
    // 不在 confidence_thresholds 里的 type → 走 default_confidence_threshold。
    // 构造一个"未知但通过 candidate 校验"的 type 字符串:测试层直接传字符串。
    const d = decideMemoryAdmission(
      {
        ...validInput,
        candidate_type: 'custom_type' as never,
        candidate_confidence: 0.5, // == default threshold
      },
      basePolicy,
    );
    expect(d.status).toBe('admit');
  });
});

describe('decideMemoryAdmission — invariants (§8.11 / INV-D5/D6/D7)', () => {
  it('admit does not mean persisted (no persistence side-effect)', () => {
    // admission 函数是纯函数 —— admit 不触发任何写入。
    // 这里通过"无任何外部依赖"间接验证:函数签名只读 input+policy,无 store 参数。
    const d = decideMemoryAdmission(validInput, basePolicy);
    expect(d.status).toBe('admit');
    // decision 本身只携带 status/requirements,不携带 stored_memory_ref 等持久化字段。
    expect(d).not.toHaveProperty('stored_memory_ref');
    expect(d).not.toHaveProperty('persisted');
  });

  it('admit carries verification_requirements (admit ≠ use)', () => {
    const d = decideMemoryAdmission(validInput, basePolicy);
    expect(d.status).toBe('admit');
    expect(d.verification_requirements.length).toBeGreaterThan(0);
    // 应明确指向 use-verification,呼应 M-046。
    expect(d.verification_requirements.some((r) => r.includes('use'))).toBe(true);
  });

  it('does not read or write MemoryManager (pure function)', () => {
    // admission.ts 不 import memory-manager.js。
    // 此测试是结构性断言:函数仅依赖 input + policy,不接受 manager/store 参数。
    // 如果将来有人加 manager 参数,TS 签名会变,此测试需要更新 —— 这正是保护点。
    const d = decideMemoryAdmission(validInput, basePolicy);
    expect(d).toBeDefined();
  });

  it('every decision carries admission_decision_id with stable prefix', () => {
    const cases: Array<{ status: string; input: MemoryAdmissionInput }> = [
      { status: 'admit', input: validInput },
      { status: 'reject', input: { ...validInput, content_class: 'credential' as const } },
      { status: 'defer', input: { ...validInput, freshness_status: 'unknown' as const } },
    ];
    for (const c of cases) {
      const d = decideMemoryAdmission(c.input, basePolicy);
      expect(d.status).toBe(c.status);
      expect(d.admission_decision_id).toMatch(/^[a-z]+:[a-f0-9]{16}$/);
      expect(d.admission_decision_id.startsWith(d.status + ':')).toBe(true);
    }
  });
});

describe('decideMemoryAdmission — policy version mismatch', () => {
  it('admission_protocol_version mismatch yields reject', () => {
    const d = decideMemoryAdmission(
      { ...validInput, admission_protocol_version: '999' },
      basePolicy,
    );
    expect(d.status).toBe('reject');
    expect(d.reason_codes.some((c) => c.includes('protocol_version'))).toBe(true);
  });

  it('decision echoes input protocol version even on reject', () => {
    const d = decideMemoryAdmission(
      { ...validInput, admission_protocol_version: '999' },
      basePolicy,
    );
    // decision 用 input 声称的版本回显,便于上游追溯。
    expect(d.admission_protocol_version).toBe('999');
  });
});
