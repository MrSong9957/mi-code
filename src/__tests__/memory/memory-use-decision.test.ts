// Memory Use Decision 测试 (DRC-2 / M-044, T6)
//
// 覆盖规格 docs/superpowers/specs/2026-07-26-agent-integrated-capabilities-wave-d-design.md
//   - §8.10 Memory use decision (MemoryUseStatus / MemoryUseDecision)
//   - §8.11 Cross-channel 不变量 (admission / use 分离;INV-D6)
//   - §8.12 错误语义 (verifier unavailable / conflicting evidence / version mismatch)
//
// 不变量 INV-D6:
//   - admit 不自动产生 use;admission 与 use 是独立状态。
//   - use 必须绑定当前 context snapshot。
//   - needs_refresh 不能当低置信 use。
//   - use 不改变原 admission decision。

import { describe, it, expect } from 'vitest';
import {
  decideMemoryUse,
  decideMemoryAdmission,
  MEMORY_USE_PROTOCOL_VERSION,
  MEMORY_ADMISSION_PROTOCOL_VERSION,
  type MemoryUseInput,
  type MemoryAdmissionInput,
  type MemoryAdmissionPolicy,
} from '../../memory/admission.js';

// ─── baseline admission input / policy ────────────────────────────
// 用于构造一个真实的 admission decision,验证 use 不改变 admission (INV-D6)。
const basePolicy: MemoryAdmissionPolicy = {
  confidence_thresholds: { user_preference: 0.6 },
  default_confidence_threshold: 0.5,
  require_evidence: true,
  require_freshness: true,
};

const baseAdmissionInput: MemoryAdmissionInput = {
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

// ─── baseline use input ───────────────────────────────────────────
// baseline:两个 claim,全部 verifier 通过、零 stale、零冲突、verifier 可用。
// 这个 input 应当产 status='use'。
const baseUseInput: MemoryUseInput = {
  memory_use_protocol_version: MEMORY_USE_PROTOCOL_VERSION,
  stored_memory_ref: 'stored-mem-1',
  admission_decision_id: 'admit:abcd1234',
  current_context_snapshot_id: 'snap-1',
  project_version_ref: 'proj-v1',
  candidate_claims: [
    {
      claim_id: 'claim-1',
      claim_text: 'user prefers tabs',
      evidence_refs: ['ev-1'],
    },
    {
      claim_id: 'claim-2',
      claim_text: 'project uses TypeScript',
      evidence_refs: ['ev-2'],
    },
  ],
  verified_claim_refs: ['claim-1', 'claim-2'],
  stale_claim_refs: [],
  conflicting_evidence_refs: [],
  verifier_available: true,
  refresh_available: false,
};

describe('decideMemoryUse — use happy path', () => {
  it('returns use when all candidate claims are verified in current context', () => {
    const d = decideMemoryUse(baseUseInput);
    expect(d.status).toBe('use');
    expect(d.memory_use_protocol_version).toBe(MEMORY_USE_PROTOCOL_VERSION);
    expect(d.stored_memory_ref).toBe('stored-mem-1');
    expect(d.admission_decision_id).toBe('admit:abcd1234');
    expect(d.current_context_snapshot_id).toBe('snap-1');
    expect(d.project_version_ref).toBe('proj-v1');
    expect(d.verified_claim_refs).toEqual(['claim-1', 'claim-2']);
    expect(d.stale_claim_refs).toEqual([]);
    expect(d.conflicting_evidence_refs).toEqual([]);
    expect(d.reason_codes).toEqual([]);
  });

  it('produces a content-addressed, frozen decision id with status prefix', () => {
    const a = decideMemoryUse(baseUseInput);
    const b = decideMemoryUse({ ...baseUseInput });
    expect(a.memory_use_decision_id).toBe(b.memory_use_decision_id);
    expect(a.memory_use_decision_id).toMatch(/^use:use:[a-f0-9]{16}$/);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.reason_codes)).toBe(true);
    expect(Object.isFrozen(a.verified_claim_refs)).toBe(true);
  });
});

describe('decideMemoryUse — context snapshot binding (INV-D6)', () => {
  it('does not reuse a use decision from another context snapshot', () => {
    // prior decision bound to a different context snapshot → do_not_use
    const d = decideMemoryUse({
      ...baseUseInput,
      current_context_snapshot_id: 'snap-new',
      prior_decision: {
        memory_use_decision_id: 'use:use:cafebabe',
        current_context_snapshot_id: 'snap-old',
      },
    });
    expect(d.status).not.toBe('use');
    expect(d.status).toBe('do_not_use');
    expect(d.reason_codes).toContain('memory.context_snapshot_mismatch');
  });

  it('still allows use when prior decision bound to the same snapshot', () => {
    const d = decideMemoryUse({
      ...baseUseInput,
      current_context_snapshot_id: 'snap-shared',
      prior_decision: {
        memory_use_decision_id: 'use:use:deadbeef',
        current_context_snapshot_id: 'snap-shared',
      },
    });
    expect(d.status).toBe('use');
  });

  it('binds the decision id to the current context snapshot', () => {
    // 不同 snapshot 产生不同 decision id (即使其它字段相同)
    const a = decideMemoryUse({
      ...baseUseInput,
      current_context_snapshot_id: 'snap-A',
    });
    const b = decideMemoryUse({
      ...baseUseInput,
      current_context_snapshot_id: 'snap-B',
    });
    expect(a.memory_use_decision_id).not.toBe(b.memory_use_decision_id);
    expect(a.current_context_snapshot_id).toBe('snap-A');
    expect(b.current_context_snapshot_id).toBe('snap-B');
  });
});

describe('decideMemoryUse — verifier availability (§8.12)', () => {
  it('returns needs_refresh when verifier unavailable but refresh is available', () => {
    const d = decideMemoryUse({
      ...baseUseInput,
      verifier_available: false,
      refresh_available: true,
    });
    expect(d.status).toBe('needs_refresh');
    // 不乐观 use:needs_refresh 不带 reason_codes 中的 use 标记
    expect(d.reason_codes).not.toContain('memory.no_verified_claims');
  });

  it('returns do_not_use when verifier unavailable and no refresh path', () => {
    const d = decideMemoryUse({
      ...baseUseInput,
      verifier_available: false,
      refresh_available: false,
    });
    expect(d.status).toBe('do_not_use');
    expect(d.reason_codes).toContain('memory.verifier_unavailable');
  });
});

describe('decideMemoryUse — conflicting evidence & claims', () => {
  it('returns do_not_use on conflicting evidence in current context', () => {
    const d = decideMemoryUse({
      ...baseUseInput,
      conflicting_evidence_refs: ['ev-conflict-1'],
    });
    expect(d.status).toBe('do_not_use');
    expect(d.reason_codes).toContain('memory.conflicting_evidence');
    // 保留 evidence (§8.12):conflicting evidence 必须出现在 decision 中
    expect(d.conflicting_evidence_refs).toEqual(['ev-conflict-1']);
  });

  it('returns do_not_use when no claims were verified', () => {
    const d = decideMemoryUse({
      ...baseUseInput,
      verified_claim_refs: [],
    });
    expect(d.status).toBe('do_not_use');
    expect(d.reason_codes).toContain('memory.no_verified_claims');
  });

  it('preserves stale claim refs in the decision for traceability', () => {
    const d = decideMemoryUse({
      ...baseUseInput,
      verified_claim_refs: ['claim-1'],
      stale_claim_refs: ['claim-2'],
    });
    // 仍有 verified claim → use,但 stale claim 必须保留
    expect(d.status).toBe('use');
    expect(d.stale_claim_refs).toEqual(['claim-2']);
  });
});

describe('decideMemoryUse — identity guards', () => {
  it('throws on missing stored_memory_ref', () => {
    expect(() =>
      decideMemoryUse({
        ...baseUseInput,
        stored_memory_ref: '',
      }),
    ).toThrow(/stored_memory_ref/);
  });

  it('throws on missing admission_decision_id', () => {
    expect(() =>
      decideMemoryUse({
        ...baseUseInput,
        admission_decision_id: '   ',
      }),
    ).toThrow(/admission_decision_id/);
  });

  it('throws on missing current_context_snapshot_id', () => {
    expect(() =>
      decideMemoryUse({
        ...baseUseInput,
        current_context_snapshot_id: '',
      }),
    ).toThrow(/current_context_snapshot_id/);
  });
});

describe('decideMemoryUse — orthogonality with admission (INV-D6)', () => {
  it('admit does not automatically produce use (orthogonal)', () => {
    // 一个有效的 admission decision 本身不携带任何 use 信息。
    // decideMemoryAdmission 的输出与 decideMemoryUse 的输入是分离契约。
    const admission = decideMemoryAdmission(baseAdmissionInput, basePolicy);
    expect(admission.status).toBe('admit');
    // admission decision 没有 use 专属字段 —— use 必须独立调用 decideMemoryUse。
    expect(admission).not.toHaveProperty('verified_claim_refs');
    expect(admission).not.toHaveProperty('memory_use_decision_id');

    // 即便构造一个 use input 复用 admission_decision_id,use 仍独立判定:
    const useInput: MemoryUseInput = {
      memory_use_protocol_version: MEMORY_USE_PROTOCOL_VERSION,
      stored_memory_ref: 'stored-mem-1',
      admission_decision_id: admission.admission_decision_id,
      current_context_snapshot_id: admission.current_context_snapshot_id,
      project_version_ref: 'proj-v1',
      candidate_claims: [
        {
          claim_id: 'claim-1',
          claim_text: 'user prefers tabs',
          evidence_refs: ['ev-1'],
        },
      ],
      verified_claim_refs: [], // 没有 verified claim → do_not_use
      stale_claim_refs: [],
      conflicting_evidence_refs: [],
      verifier_available: true,
      refresh_available: false,
    };
    const use = decideMemoryUse(useInput);
    expect(use.status).toBe('do_not_use');
    expect(use.reason_codes).toContain('memory.no_verified_claims');
  });

  it('does not change the prior admission decision (use is read-only on admission)', () => {
    const admissionBefore = decideMemoryAdmission(baseAdmissionInput, basePolicy);
    const admissionIdBefore = admissionBefore.admission_decision_id;
    const admissionStatusBefore = admissionBefore.status;
    const admissionFrozenBefore = Object.isFrozen(admissionBefore);

    // 生成一个 use decision,引用该 admission id
    decideMemoryUse({
      ...baseUseInput,
      admission_decision_id: admissionBefore.admission_decision_id,
      current_context_snapshot_id: admissionBefore.current_context_snapshot_id,
    });

    // 再生成一次 admission(纯函数,应得到完全相同的 decision)
    const admissionAfter = decideMemoryAdmission(baseAdmissionInput, basePolicy);
    expect(admissionAfter.admission_decision_id).toBe(admissionIdBefore);
    expect(admissionAfter.status).toBe(admissionStatusBefore);
    expect(Object.isFrozen(admissionBefore)).toBe(admissionFrozenBefore);
    expect(Object.isFrozen(admissionAfter)).toBe(true);
  });

  it('needs_refresh is not a low-confidence use', () => {
    // 当 verifier 不可用但可刷新时,即使所有 claim "看起来" verified,
    // 也不能进入 use —— needs_refresh 是独立状态。
    const d = decideMemoryUse({
      ...baseUseInput,
      verifier_available: false,
      refresh_available: true,
    });
    expect(d.status).toBe('needs_refresh');
    expect(d.status).not.toBe('use');
    // needs_refresh 不应当被消费方当作 use
    expect(d.verified_claim_refs).toEqual(['claim-1', 'claim-2']); // 保留供刷新后参考
  });
});
