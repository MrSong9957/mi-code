// DRC-2 Task 7 — Trusted Context Anchor (Core Orchestrator) tests.
//
// 覆盖规格 docs/superpowers/specs/2026-07-26-agent-integrated-capabilities-wave-d-design.md
//   - §8.1 目标 (Core Anchor 是确定性编排器,不是中央 Context Runtime)
//   - §8.2 Channel boundary (channel 由 CRC-3 决定,下游无权改写)
//   - §8.11 Cross-channel 不变量 (INV-D5 / INV-D16)
//   - §8.12 错误语义 (不注入、不 admission、不乐观 use、failure 不 fallback)
//
// `activateTrustedContext` 是 Core Anchor:它只做三件事 —— 按 channel 分发、
// 把结果封进对应的 discriminated union 变体、把异常转成结构化 failure。
// 它本身不创建新的 trust / Authority / Placement / Retention / persistence / selection。
//
// 不变量(INV-D5 / INV-D16):
//   - project_instruction 不能改写为 auto_memory;反之亦然。
//   - 失败不升级状态:一个 channel 的 failure 不会 fallback 到另一个 channel。
//   - Project instruction activation 不产生 Memory admission。
//   - Memory admission 不产生 Prompt placement。

import { describe, expect, it } from 'vitest';
import {
  activateProjectInstruction,
  ACTIVATION_PROTOCOL_VERSION,
  type ContextActivationIdentity,
  type ProjectInstructionActivationInput,
  type TrustedContextActivationInput,
  type TrustedContextActivationOutcome,
  activateTrustedContext,
} from '../../agent/context/activation.js';
import {
  MEMORY_ADMISSION_PROTOCOL_VERSION,
  MEMORY_USE_PROTOCOL_VERSION,
  type MemoryAdmissionInput,
  type MemoryAdmissionPolicy,
  type MemoryUseInput,
} from '../../memory/admission.js';

// ---------------------------------------------------------------------------
// Baseline inputs / dependencies.
// ---------------------------------------------------------------------------

const baseIdentity: ContextActivationIdentity = {
  activation_protocol_version: ACTIVATION_PROTOCOL_VERSION,
  activation_id: 'activation-1',
  request_snapshot_id: 'snapshot-1',
  source_context_id: 'src-1',
  route_decision_id: 'route-1',
  channel: 'project_instruction',
};

function validProjectInstructionInput(): ProjectInstructionActivationInput {
  return {
    activation_identity: baseIdentity,
    context_source_id: 'src-1',
    route_decision_id: 'route-1',
    route_target: 'project_instruction_context',
    bounded_content_ref: 'bounded-ref-1',
    content_hash: 'hash-1',
    trust_proof_ref: 'trust-proof-1',
    sanitization_status: 'accepted',
    source_budget_ref: 'budget-1',
    provenance_refs: ['user:input'],
    authority: 'user',
    trust: 'trusted',
    freshness_ref: 'fresh-1',
    overflow_metadata_ref: null,
    ordinal: 0,
  };
}

const basePolicy: MemoryAdmissionPolicy = {
  confidence_thresholds: { user_preference: 0.6 },
  default_confidence_threshold: 0.5,
  require_evidence: true,
  require_freshness: true,
};

function validMemoryAdmissionInput(): MemoryAdmissionInput {
  return {
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
}

function validMemoryUseInput(): MemoryUseInput {
  return {
    memory_use_protocol_version: MEMORY_USE_PROTOCOL_VERSION,
    stored_memory_ref: 'stored-mem-1',
    admission_decision_id: 'admit:abcd1234',
    current_context_snapshot_id: 'snap-1',
    project_version_ref: 'proj-v1',
    candidate_claims: [
      { claim_id: 'claim-1', claim_text: 'user prefers tabs', evidence_refs: ['ev-1'] },
    ],
    verified_claim_refs: ['claim-1'],
    stale_claim_refs: [],
    conflicting_evidence_refs: [],
    verifier_available: true,
    refresh_available: false,
  };
}

const dependencies = { memory_admission_policy: basePolicy };

// ---------------------------------------------------------------------------
// §8.2 / §8.1 — Channel dispatch (happy paths).
// ---------------------------------------------------------------------------

describe('activateTrustedContext — channel dispatch (§8.2)', () => {
  it("routes channel='project_instruction' to meta_context_activation", () => {
    const result = activateTrustedContext(
      {
        channel: 'project_instruction',
        project_instruction_input: validProjectInstructionInput(),
        memory_admission_input: null,
        memory_use_input: null,
      },
      dependencies,
    );
    expect(result.kind).toBe('meta_context_activation');
    if (result.kind !== 'meta_context_activation') return;
    expect(result.value.placement).toBe('meta_context');
    expect(result.value.is_meta).toBe(true);
  });

  it("routes channel='auto_memory_admission' to memory_admission_decision (admit)", () => {
    const result = activateTrustedContext(
      {
        channel: 'auto_memory_admission',
        project_instruction_input: null,
        memory_admission_input: validMemoryAdmissionInput(),
        memory_use_input: null,
      },
      dependencies,
    );
    expect(result.kind).toBe('memory_admission_decision');
    if (result.kind !== 'memory_admission_decision') return;
    expect(result.value.status).toBe('admit');
  });

  it("routes channel='auto_memory_admission' that rejects as memory_admission_decision (not failure)", () => {
    // reject/defer 是合法 decision,不是 failure —— 不能升级到 failure。
    const result = activateTrustedContext(
      {
        channel: 'auto_memory_admission',
        project_instruction_input: null,
        memory_admission_input: {
          ...validMemoryAdmissionInput(),
          content_class: 'credential',
        },
        memory_use_input: null,
      },
      dependencies,
    );
    expect(result.kind).toBe('memory_admission_decision');
    if (result.kind !== 'memory_admission_decision') return;
    expect(result.value.status).toBe('reject');
  });

  it("routes channel='auto_memory_use' to memory_use_decision", () => {
    const result = activateTrustedContext(
      {
        channel: 'auto_memory_use',
        project_instruction_input: null,
        memory_admission_input: null,
        memory_use_input: validMemoryUseInput(),
      },
      dependencies,
    );
    expect(result.kind).toBe('memory_use_decision');
    if (result.kind !== 'memory_use_decision') return;
    expect(result.value.status).toBe('use');
  });

  it('forwards the exact value produced by the underlying function (no rewriting)', () => {
    // Core Anchor 是编排器,不是 transformer —— 直接传 value。
    const expected = activateProjectInstruction(validProjectInstructionInput());
    const result = activateTrustedContext(
      {
        channel: 'project_instruction',
        project_instruction_input: validProjectInstructionInput(),
        memory_admission_input: null,
        memory_use_input: null,
      },
      dependencies,
    );
    if (result.kind !== 'meta_context_activation') throw new Error('expected meta_context_activation');
    expect(result.value).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// §8.11 — INV-D5 channel separation (no cross-channel elevation).
// ---------------------------------------------------------------------------

describe('activateTrustedContext — INV-D5 channel separation', () => {
  it('does not convert project instructions into auto memory', () => {
    const result = activateTrustedContext(
      {
        channel: 'project_instruction',
        project_instruction_input: validProjectInstructionInput(),
        memory_admission_input: null,
        memory_use_input: null,
      },
      dependencies,
    ) as unknown as Record<string, unknown>;
    // Output 变体只能是 meta_context_activation;不能升格为 memory_admission_decision。
    expect(result.kind).toBe('meta_context_activation');
    expect(result).not.toHaveProperty('memory_admission_decision');
    expect(result).not.toHaveProperty('memory_use_decision');
  });

  it('does not project admitted memory into prompt placement', () => {
    const result = activateTrustedContext(
      {
        channel: 'auto_memory_admission',
        project_instruction_input: null,
        memory_admission_input: validMemoryAdmissionInput(),
        memory_use_input: null,
      },
      dependencies,
    ) as unknown as Record<string, unknown>;
    expect(result.kind).toBe('memory_admission_decision');
    // admission decision 不带 placement —— INV-D5-5:Memory admission 不产生 Prompt placement。
    expect(result).not.toHaveProperty('placement');
    if (result.kind !== 'memory_admission_decision') return;
    const decision = (result as { value: Record<string, unknown> }).value;
    expect(decision).not.toHaveProperty('placement');
  });

  it('does not produce a meta_context_activation for a memory use channel', () => {
    const result = activateTrustedContext(
      {
        channel: 'auto_memory_use',
        project_instruction_input: null,
        memory_admission_input: null,
        memory_use_input: validMemoryUseInput(),
      },
      dependencies,
    ) as unknown as Record<string, unknown>;
    expect(result.kind).toBe('memory_use_decision');
    expect(result).not.toHaveProperty('meta_context_activation');
  });

  it('does not create new trust / authority / persistence / retention on the orchestrator output', () => {
    // Core Anchor 只编排,不铸造新的 trust/Authority/Placement/Retention/persistence/selection。
    // failure 变体尤其要检查 —— 不能因为异常就发明一个 trust/authority 来"补救"。
    const result = activateTrustedContext(
      {
        channel: 'project_instruction',
        project_instruction_input: {
          ...validProjectInstructionInput(),
          trust_proof_ref: '', // triggers failure inside activateProjectInstruction
        },
        memory_admission_input: null,
        memory_use_input: null,
      },
      dependencies,
    );
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.reason_codes).not.toContain('system');
    expect(result).not.toHaveProperty('authority');
    expect(result).not.toHaveProperty('trust');
    expect(result).not.toHaveProperty('placement');
    expect(result).not.toHaveProperty('retention_state');
    expect(result).not.toHaveProperty('writer');
  });
});

// ---------------------------------------------------------------------------
// §8.2 / §8.12 — Field consistency & unknown channel rejection.
// ---------------------------------------------------------------------------

describe('activateTrustedContext — field / channel validation (§8.12)', () => {
  it('rejects mixed channel fields (project_instruction channel with memory_admission_input)', () => {
    // Runtime 守门:即便 TS 在编译期不允许,也不能信任下游传入的形状。
    const mixed = {
      channel: 'project_instruction',
      project_instruction_input: validProjectInstructionInput(),
      memory_admission_input: validMemoryAdmissionInput(), // should be null
      memory_use_input: null,
    } as unknown as TrustedContextActivationInput;
    const result = activateTrustedContext(mixed, dependencies);
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.reason_codes).toContain('activation.channel_field_mismatch');
  });

  it('rejects mixed channel fields (auto_memory_admission channel with project_instruction_input)', () => {
    const mixed = {
      channel: 'auto_memory_admission',
      project_instruction_input: validProjectInstructionInput(), // should be null
      memory_admission_input: validMemoryAdmissionInput(),
      memory_use_input: null,
    } as unknown as TrustedContextActivationInput;
    const result = activateTrustedContext(mixed, dependencies);
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.reason_codes).toContain('activation.channel_field_mismatch');
  });

  it('rejects mixed channel fields (auto_memory_use channel with non-null memory_admission_input)', () => {
    const mixed = {
      channel: 'auto_memory_use',
      project_instruction_input: null,
      memory_admission_input: validMemoryAdmissionInput(), // should be null
      memory_use_input: validMemoryUseInput(),
    } as unknown as TrustedContextActivationInput;
    const result = activateTrustedContext(mixed, dependencies);
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.reason_codes).toContain('activation.channel_field_mismatch');
  });

  it('rejects an unknown channel string (exhaustive runtime guard)', () => {
    const unknown = {
      channel: 'system_rule', // not in the closed set
      project_instruction_input: null,
      memory_admission_input: null,
      memory_use_input: null,
    } as unknown as TrustedContextActivationInput;
    const result = activateTrustedContext(unknown, dependencies);
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.reason_codes).toContain('activation.unknown_channel');
  });
});

// ---------------------------------------------------------------------------
// §8.11-12 / INV-D16 — Failure does not escalate / fallback across channels.
// ---------------------------------------------------------------------------

describe('activateTrustedContext — failure does not fallback (INV-D16)', () => {
  it('project instruction activation failure does not fallback to a memory channel', () => {
    const result = activateTrustedContext(
      {
        channel: 'project_instruction',
        project_instruction_input: {
          ...validProjectInstructionInput(),
          trust_proof_ref: '', // four-gate fails inside activateProjectInstruction
        },
        memory_admission_input: null,
        memory_use_input: null,
      },
      dependencies,
    );
    expect(result.kind).toBe('failure');
    // 关键:不能"补救"成 memory_admission_decision 或 memory_use_decision。
    expect(result.kind).not.toBe('memory_admission_decision');
    expect(result.kind).not.toBe('memory_use_decision');
    expect(result.kind).not.toBe('meta_context_activation');
    if (result.kind !== 'failure') return;
    expect(result.reason_codes[0]).toBe('project_instruction.activation_failed');
    expect(result.reason_codes.length).toBeGreaterThan(1);
  });

  it('memory admission identity failure does not produce meta context', () => {
    // decideMemoryAdmission throws on empty memory_candidate_id (requireIdentity gate).
    const result = activateTrustedContext(
      {
        channel: 'auto_memory_admission',
        project_instruction_input: null,
        memory_admission_input: {
          ...validMemoryAdmissionInput(),
          memory_candidate_id: '',
        },
        memory_use_input: null,
      },
      dependencies,
    );
    expect(result.kind).toBe('failure');
    expect(result.kind).not.toBe('meta_context_activation');
    expect(result.kind).not.toBe('memory_use_decision');
    if (result.kind !== 'failure') return;
    expect(result.reason_codes[0]).toBe('memory_admission.activation_failed');
  });

  it('memory use identity failure does not produce meta context or admission', () => {
    // decideMemoryUse throws on empty stored_memory_ref (requireIdentity gate).
    const result = activateTrustedContext(
      {
        channel: 'auto_memory_use',
        project_instruction_input: null,
        memory_admission_input: null,
        memory_use_input: {
          ...validMemoryUseInput(),
          stored_memory_ref: '',
        },
      },
      dependencies,
    );
    expect(result.kind).toBe('failure');
    expect(result.kind).not.toBe('meta_context_activation');
    expect(result.kind).not.toBe('memory_admission_decision');
    if (result.kind !== 'failure') return;
    expect(result.reason_codes[0]).toBe('memory_use.activation_failed');
  });

  it('failure returns structured reason_codes (non-empty string array)', () => {
    const result = activateTrustedContext(
      {
        channel: 'project_instruction',
        project_instruction_input: {
          ...validProjectInstructionInput(),
          route_target: 'wrong_target', // triggers activation.wrong_route
        },
        memory_admission_input: null,
        memory_use_input: null,
      },
      dependencies,
    );
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(Array.isArray(result.reason_codes)).toBe(true);
    expect(result.reason_codes.length).toBeGreaterThan(0);
    for (const code of result.reason_codes) {
      expect(typeof code).toBe('string');
      expect(code.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// §8.1 — Deterministic orchestrator (Core Anchor is a pure dispatcher).
// ---------------------------------------------------------------------------

describe('activateTrustedContext — determinism & purity', () => {
  it('produces the same result kind and value for identical project_instruction inputs', () => {
    const input: TrustedContextActivationInput = {
      channel: 'project_instruction',
      project_instruction_input: validProjectInstructionInput(),
      memory_admission_input: null,
      memory_use_input: null,
    };
    const a = activateTrustedContext(input, dependencies);
    const b = activateTrustedContext(input, dependencies);
    expect(a.kind).toBe(b.kind);
    if (a.kind !== 'meta_context_activation' || b.kind !== 'meta_context_activation') return;
    expect(a.value).toEqual(b.value);
  });

  it('produces the same memory_admission_decision for identical inputs', () => {
    const input: TrustedContextActivationInput = {
      channel: 'auto_memory_admission',
      project_instruction_input: null,
      memory_admission_input: validMemoryAdmissionInput(),
      memory_use_input: null,
    };
    const a = activateTrustedContext(input, dependencies);
    const b = activateTrustedContext(input, dependencies);
    expect(a.kind).toBe('memory_admission_decision');
    if (a.kind !== 'memory_admission_decision' || b.kind !== 'memory_admission_decision') return;
    expect(a.value.admission_decision_id).toBe(b.value.admission_decision_id);
  });

  it('produces the same memory_use_decision for identical inputs', () => {
    const input: TrustedContextActivationInput = {
      channel: 'auto_memory_use',
      project_instruction_input: null,
      memory_admission_input: null,
      memory_use_input: validMemoryUseInput(),
    };
    const a = activateTrustedContext(input, dependencies);
    const b = activateTrustedContext(input, dependencies);
    expect(a.kind).toBe('memory_use_decision');
    if (a.kind !== 'memory_use_decision' || b.kind !== 'memory_use_decision') return;
    expect(a.value.memory_use_decision_id).toBe(b.value.memory_use_decision_id);
  });

  it('forwards frozen underlying values without re-wrapping', () => {
    // Core Anchor 不重新铸造 trust/identity —— value 直接来自底层纯函数,
    // 因此应保留 Object.isFrozen。
    const result = activateTrustedContext(
      {
        channel: 'project_instruction',
        project_instruction_input: validProjectInstructionInput(),
        memory_admission_input: null,
        memory_use_input: null,
      },
      dependencies,
    );
    if (result.kind !== 'meta_context_activation') throw new Error('expected meta_context_activation');
    expect(Object.isFrozen(result.value)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Type-level sanity: outcome covers every result variant + failure.
// ---------------------------------------------------------------------------

describe('activateTrustedContext — outcome type surface', () => {
  it('exposes all four outcome kinds via the type (compile-time guarantee)', () => {
    // This is a type-level assertion that runs at runtime as a no-op sanity check.
    // If the union narrows incorrectly, tsc will fail to compile this.
    const samples: Array<TrustedContextActivationOutcome['kind']> = [
      'meta_context_activation',
      'memory_admission_decision',
      'memory_use_decision',
      'failure',
    ];
    expect(new Set(samples)).toEqual(
      new Set([
        'meta_context_activation',
        'memory_admission_decision',
        'memory_use_decision',
        'failure',
      ]),
    );
  });
});
