/**
 * GRC-1 §6 / §7.2 / §7.3 / §7.24 — Post-Compact Reconstruction capture.
 *
 * Wave G Task 1 covers only the immutable-capture surface:
 *   - createReconstructionPolicy       (closed value domain, spec §7.2)
 *   - capturePreCompactSnapshot        (one-shot capture, spec §7.3)
 *   - createReconstructionTransactionRequest (state='requested', spec §6.2)
 *   - computeReconstructionIdempotencyKey  (deterministic, spec §7.24)
 *
 * Non-negotiable invariants under test:
 *   - Policy enforces a closed value domain; any out-of-domain field throws.
 *   - Captured snapshots are deep-frozen; identical inputs yield identical ids.
 *   - Idempotency keys bind to every identity-bearing input field, and changing
 *     any one of them produces a different key.
 *   - Reconstruction protocol version is orthogonal to precompact protocol
 *     version — bumping one never rewrites the other's fields.
 */
import { describe, expect, it } from 'vitest';
import {
  capturePreCompactSnapshot,
  computeReconstructionIdempotencyKey,
  createReconstructionPolicy,
  createReconstructionTransactionRequest,
  PRECOMPACT_PROTOCOL_VERSION,
  RECONSTRUCTION_POLICY_PROTOCOL_VERSION,
  RECONSTRUCTION_PROTOCOL_VERSION,
  RECONSTRUCTION_TRANSACTION_PROTOCOL_VERSION,
  type CapturePreCompactInput,
  type CreateTransactionRequestInput,
} from '../../agent/context/reconstruction.js';
import type { ToolTranscriptValidation } from '../../agent/tools/transcript-validator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal valid policy identity the factory requires. */
function policyIdentity() {
  return {
    policy_id: 'mi.reconstruction.policy:default',
    policy_version: '1.0.0',
    request_budget_policy_ref: 'mi.budget/1:default',
  };
}

/** A capture input with every identity-bearing field populated. */
function captureInput(overrides: Partial<CapturePreCompactInput> = {}): CapturePreCompactInput {
  return {
    session_id: 'sess:abc',
    turn_id: 'turn:1',
    task_snapshot_id: 'task:snap-1',
    current_context_snapshot_id: 'ctx:before-compact',
    project_version_ref: 'proj:sha-1',
    transcript_snapshot_id: 'tx:snap-1',
    current_user_message_ref: 'msg:user-1',
    current_user_message_hash: '0'.repeat(64),
    active_project_activation_refs: ['act:proj-a', 'act:proj-b'],
    active_meta_lifecycle_refs: ['life:meta-a'],
    memory_entrypoint_snapshot_ref: 'entry:mem-1',
    execution_state_refs: ['exec:state-1'],
    request_budget_snapshot_id: 'budget:snap-1',
    captured_at: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

/** A minimal preflight validation identity the transaction request consumes. */
function preflightValidation(
  overrides: Partial<ToolTranscriptValidation> = {},
): ToolTranscriptValidation {
  return {
    validation_protocol_version: '1',
    validation_id: 'tv:preflight-1',
    transcript_snapshot_id: 'tx:snap-1',
    checkpoint: 'before_compaction',
    status: 'accepted',
    validator_policy_id: 'mi.transcript.policy:default',
    validator_policy_version: '1.0.0',
    pair_records: [],
    reason_codes: [],
    ...overrides,
  };
}

/** The full input to createReconstructionTransactionRequest. */
function transactionInput(
  overrides: Partial<CreateTransactionRequestInput> = {},
): CreateTransactionRequestInput {
  const precompact = capturePreCompactSnapshot(captureInput());
  return {
    precompact,
    preflight_validation: preflightValidation(),
    policy: createReconstructionPolicy(policyIdentity()),
    target_context_snapshot_id: 'ctx:after-compact-target',
    compaction_method: 'deterministic_local',
    compaction_method_version: 'local/1',
    memory_rebuild_identity: {
      old_entrypoint_snapshot_id: 'entry:mem-1',
      policy_ref: { contract_id: 'mi.entrypoint/1', protocol_version: '1' },
      render_profile_ref: 'render:profile-1',
    },
    postflight_validator_policy: {
      validator_policy_id: 'mi.postflight.policy:default',
      validator_policy_version: '1.0.0',
    },
    ...overrides,
  };
}

/**
 * Recursively checks that every object/array in `value` is frozen.
 * `freezeSnapshot` deep-freezes in place, so every nested layer must report frozen.
 */
function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  if (Array.isArray(value)) {
    for (const item of value) assertDeepFrozen(item);
  } else {
    for (const v of Object.values(value as Record<string, unknown>)) {
      assertDeepFrozen(v);
    }
  }
}

// ===========================================================================
// createReconstructionPolicy — closed value domain (spec §7.2)
// ===========================================================================

describe('createReconstructionPolicy — closed value domain (spec §7.2)', () => {
  it('accepts a valid default policy and stamps the protocol version', () => {
    const policy = createReconstructionPolicy(policyIdentity());
    expect(policy.reconstruction_policy_protocol_version).toBe(
      RECONSTRUCTION_POLICY_PROTOCOL_VERSION,
    );
    expect(policy.policy_id).toBe('mi.reconstruction.policy:default');
    expect(policy.current_user_requirement).toBe('required_exact');
    expect(policy.publish_mode).toBe('atomic');
  });

  it('rejects an out-of-domain current_user_requirement', () => {
    expect(() =>
      createReconstructionPolicy({
        ...policyIdentity(),
        current_user_requirement: 'optional_current' as never,
      }),
    ).toThrow('current_user_requirement');
  });

  it('rejects an out-of-domain publish_mode', () => {
    expect(() =>
      createReconstructionPolicy({
        ...policyIdentity(),
        publish_mode: 'incremental' as never,
      }),
    ).toThrow('publish_mode');
  });

  it('rejects an out-of-domain source_failure_behavior', () => {
    expect(() =>
      createReconstructionPolicy({
        ...policyIdentity(),
        source_failure_behavior: 'silent_skip' as never,
      }),
    ).toThrow('source_failure_behavior');
  });

  it('rejects an out-of-domain duplicate_behavior', () => {
    expect(() =>
      createReconstructionPolicy({
        ...policyIdentity(),
        duplicate_behavior: 'merge' as never,
      }),
    ).toThrow('duplicate_behavior');
  });

  it('rejects an out-of-domain unknown_item_behavior', () => {
    expect(() =>
      createReconstructionPolicy({
        ...policyIdentity(),
        unknown_item_behavior: 'preserve' as never,
      }),
    ).toThrow('unknown_item_behavior');
  });

  it('rejects a missing policy_id', () => {
    expect(() =>
      createReconstructionPolicy({
        ...policyIdentity(),
        policy_id: '',
      }),
    ).toThrow('policy_id');
  });

  it('rejects a missing policy_version', () => {
    expect(() =>
      createReconstructionPolicy({
        ...policyIdentity(),
        policy_version: '   ',
      }),
    ).toThrow('policy_version');
  });

  it('rejects a missing request_budget_policy_ref', () => {
    expect(() =>
      createReconstructionPolicy({
        ...policyIdentity(),
        request_budget_policy_ref: '',
      }),
    ).toThrow('request_budget_policy_ref');
  });

  it('also enforces the remaining closed fields (compact/project/memory/execution)', () => {
    // Each of these should reject any non-canonical value.
    expect(() =>
      createReconstructionPolicy({
        ...policyIdentity(),
        compact_summary_requirement: 'optional_current' as never,
      }),
    ).toThrow('compact_summary_requirement');
    expect(() =>
      createReconstructionPolicy({
        ...policyIdentity(),
        project_instruction_requirement: 'optional_current' as never,
      }),
    ).toThrow('project_instruction_requirement');
    expect(() =>
      createReconstructionPolicy({
        ...policyIdentity(),
        memory_entrypoint_requirement: 'required_exact' as never,
      }),
    ).toThrow('memory_entrypoint_requirement');
    expect(() =>
      createReconstructionPolicy({
        ...policyIdentity(),
        execution_state_requirement: 'required_current' as never,
      }),
    ).toThrow('execution_state_requirement');
  });
});

// ===========================================================================
// capturePreCompactSnapshot — one-shot capture (spec §7.3)
// ===========================================================================

describe('capturePreCompactSnapshot — one-shot capture (spec §7.3)', () => {
  it('captures every input field and stamps the protocol version', () => {
    const snap = capturePreCompactSnapshot(captureInput());
    expect(snap.precompact_protocol_version).toBe(PRECOMPACT_PROTOCOL_VERSION);
    expect(snap.session_id).toBe('sess:abc');
    expect(snap.turn_id).toBe('turn:1');
    expect(snap.current_user_message_hash).toBe('0'.repeat(64));
    expect(snap.memory_entrypoint_snapshot_ref).toBe('entry:mem-1');
    expect(snap.active_project_activation_refs).toEqual(['act:proj-a', 'act:proj-b']);
  });

  it('deep-freezes the snapshot (every nested layer immutable)', () => {
    const snap = capturePreCompactSnapshot(captureInput());
    assertDeepFrozen(snap);
  });

  it('computes a deterministic precompact_snapshot_id for identical input', () => {
    const a = capturePreCompactSnapshot(captureInput());
    const b = capturePreCompactSnapshot(captureInput());
    expect(a.precompact_snapshot_id).toBe(b.precompact_snapshot_id);
    expect(a.precompact_snapshot_id).toMatch(/^precompact:[0-9a-f]{16}$/);
  });

  it('diverges precompact_snapshot_id when any input field changes', () => {
    const base = capturePreCompactSnapshot(captureInput());
    const other = capturePreCompactSnapshot(
      captureInput({ project_version_ref: 'proj:sha-2' }),
    );
    expect(other.precompact_snapshot_id).not.toBe(base.precompact_snapshot_id);
  });

  it('excludes precompact_snapshot_id itself from the hash input', () => {
    // The id cannot depend on itself (would be a fixed-point / circular).
    // Verifying stability across two captures is sufficient: if the id were
    // part of its own hash input, the second call could not match the first.
    const a = capturePreCompactSnapshot(captureInput());
    const b = capturePreCompactSnapshot(captureInput());
    expect(a.precompact_snapshot_id).toBe(b.precompact_snapshot_id);
  });

  it('defaults captured_at to an ISO timestamp when omitted', () => {
    const snap = capturePreCompactSnapshot(captureInput({ captured_at: undefined }));
    expect(snap.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Valid ISO parse
    expect(() => new Date(snap.captured_at).toISOString()).not.toThrow();
  });

  it('honors a caller-provided captured_at for test determinism', () => {
    const snap = capturePreCompactSnapshot(
      captureInput({ captured_at: '2026-01-01T00:00:00.000Z' }),
    );
    expect(snap.captured_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('preserves empty arrays as [] rather than coercing to null', () => {
    const snap = capturePreCompactSnapshot(
      captureInput({
        active_project_activation_refs: [],
        active_meta_lifecycle_refs: [],
        execution_state_refs: [],
      }),
    );
    expect(snap.active_project_activation_refs).toEqual([]);
    expect(snap.active_meta_lifecycle_refs).toEqual([]);
    expect(snap.execution_state_refs).toEqual([]);
  });

  it('throws on a missing identity field (requireIdentity)', () => {
    expect(() =>
      capturePreCompactSnapshot(captureInput({ session_id: '' })),
    ).toThrow('session_id');
    expect(() =>
      capturePreCompactSnapshot(captureInput({ current_user_message_hash: '' })),
    ).toThrow('current_user_message_hash');
  });
});

// ===========================================================================
// createReconstructionTransactionRequest — state='requested' (spec §6.2)
// ===========================================================================

describe('createReconstructionTransactionRequest — requested state (spec §6.2)', () => {
  it('initializes state to "requested"', () => {
    const tx = createReconstructionTransactionRequest(transactionInput());
    expect(tx.state).toBe('requested');
  });

  it('stamps the reconstruction protocol version', () => {
    const tx = createReconstructionTransactionRequest(transactionInput());
    expect(tx.reconstruction_protocol_version).toBe(
      RECONSTRUCTION_TRANSACTION_PROTOCOL_VERSION,
    );
  });

  it('computes a deterministic transaction id bound to idempotency + precompact', () => {
    const a = createReconstructionTransactionRequest(transactionInput());
    const b = createReconstructionTransactionRequest(transactionInput());
    expect(a.reconstruction_transaction_id).toBe(b.reconstruction_transaction_id);
    expect(a.reconstruction_transaction_id).toMatch(/^recon-tx:[0-9a-f]{16}$/);
  });

  it('leaves compaction_result_id null on creation', () => {
    const tx = createReconstructionTransactionRequest(transactionInput());
    expect(tx.compaction_result_id).toBeNull();
  });

  it('leaves working_set_plan_id null on creation', () => {
    const tx = createReconstructionTransactionRequest(transactionInput());
    expect(tx.working_set_plan_id).toBeNull();
  });

  it('forwards preflight_validation_id from the input validation', () => {
    const tx = createReconstructionTransactionRequest(
      transactionInput({
        preflight_validation: preflightValidation({ validation_id: 'tv:different' }),
      }),
    );
    expect(tx.preflight_validation_id).toBe('tv:different');
  });

  it('forwards target_context_snapshot_id from the input', () => {
    const tx = createReconstructionTransactionRequest(
      transactionInput({ target_context_snapshot_id: 'ctx:special-target' }),
    );
    expect(tx.target_context_snapshot_id).toBe('ctx:special-target');
  });

  it('forwards session_id / turn_id / precompact_snapshot_id from the precompact', () => {
    const tx = createReconstructionTransactionRequest(transactionInput());
    expect(tx.session_id).toBe('sess:abc');
    expect(tx.turn_id).toBe('turn:1');
    expect(tx.precompact_snapshot_id).toMatch(/^precompact:/);
  });

  it('initializes the unresolved refs/candidate/publish/recovery fields as null/empty', () => {
    const tx = createReconstructionTransactionRequest(transactionInput());
    expect(tx.source_resolution_refs).toEqual([]);
    expect(tx.candidate_snapshot_ref).toBeNull();
    expect(tx.postflight_validation_ref).toBeNull();
    expect(tx.publish_ack_ref).toBeNull();
    expect(tx.recovery_ref).toBeNull();
    expect(tx.reason_codes).toEqual(['reconstruction.requested']);
  });

  it('carries the idempotency_key computed by computeReconstructionIdempotencyKey', () => {
    const input = transactionInput();
    const tx = createReconstructionTransactionRequest(input);
    expect(tx.idempotency_key).toBe(computeReconstructionIdempotencyKey(input));
    expect(tx.idempotency_key).toMatch(/^recon-idem:[0-9a-f]{32}$/);
  });

  it('deep-freezes the transaction record', () => {
    const tx = createReconstructionTransactionRequest(transactionInput());
    assertDeepFrozen(tx);
  });
});

// ===========================================================================
// computeReconstructionIdempotencyKey — binding matrix (spec §7.24)
// ===========================================================================

describe('computeReconstructionIdempotencyKey — binding matrix (spec §7.24)', () => {
  it('is deterministic for identical inputs', () => {
    const a = computeReconstructionIdempotencyKey(transactionInput());
    const b = computeReconstructionIdempotencyKey(transactionInput());
    expect(a).toBe(b);
  });

  it('binds to session_id', () => {
    const base = transactionInput();
    const other = transactionInput({
      precompact: capturePreCompactSnapshot(captureInput({ session_id: 'sess:other' })),
    });
    expect(computeReconstructionIdempotencyKey(other)).not.toBe(
      computeReconstructionIdempotencyKey(base),
    );
  });

  it('binds to turn_id', () => {
    const base = transactionInput();
    const other = transactionInput({
      precompact: capturePreCompactSnapshot(captureInput({ turn_id: 'turn:2' })),
    });
    expect(computeReconstructionIdempotencyKey(other)).not.toBe(
      computeReconstructionIdempotencyKey(base),
    );
  });

  it('binds to precompact_snapshot_id (whole-capture change)', () => {
    const base = transactionInput();
    const other = transactionInput({
      precompact: capturePreCompactSnapshot(
        captureInput({ task_snapshot_id: 'task:snap-2' }),
      ),
    });
    expect(computeReconstructionIdempotencyKey(other)).not.toBe(
      computeReconstructionIdempotencyKey(base),
    );
  });

  it('binds to preflight_validation_id', () => {
    const base = transactionInput();
    const other = transactionInput({
      preflight_validation: preflightValidation({ validation_id: 'tv:other' }),
    });
    expect(computeReconstructionIdempotencyKey(other)).not.toBe(
      computeReconstructionIdempotencyKey(base),
    );
  });

  it('binds to compaction_method', () => {
    const base = transactionInput();
    const other = transactionInput({ compaction_method: 'model_summary' });
    expect(computeReconstructionIdempotencyKey(other)).not.toBe(
      computeReconstructionIdempotencyKey(base),
    );
  });

  it('binds to compaction_method_version', () => {
    const base = transactionInput();
    const other = transactionInput({ compaction_method_version: 'local/2' });
    expect(computeReconstructionIdempotencyKey(other)).not.toBe(
      computeReconstructionIdempotencyKey(base),
    );
  });

  it('binds to policy_id', () => {
    const base = transactionInput();
    const other = transactionInput({
      policy: createReconstructionPolicy({ ...policyIdentity(), policy_id: 'other' }),
    });
    expect(computeReconstructionIdempotencyKey(other)).not.toBe(
      computeReconstructionIdempotencyKey(base),
    );
  });

  it('binds to policy_version', () => {
    const base = transactionInput();
    const other = transactionInput({
      policy: createReconstructionPolicy({ ...policyIdentity(), policy_version: '2.0.0' }),
    });
    expect(computeReconstructionIdempotencyKey(other)).not.toBe(
      computeReconstructionIdempotencyKey(base),
    );
  });

  it('binds to target_context_snapshot_id', () => {
    const base = transactionInput();
    const other = transactionInput({ target_context_snapshot_id: 'ctx:other-target' });
    expect(computeReconstructionIdempotencyKey(other)).not.toBe(
      computeReconstructionIdempotencyKey(base),
    );
  });

  it('binds to project_version_ref (via precompact)', () => {
    const base = transactionInput();
    const other = transactionInput({
      precompact: capturePreCompactSnapshot(
        captureInput({ project_version_ref: 'proj:sha-other' }),
      ),
    });
    expect(computeReconstructionIdempotencyKey(other)).not.toBe(
      computeReconstructionIdempotencyKey(base),
    );
  });

  it('binds to request_budget_snapshot_id (via precompact)', () => {
    const base = transactionInput();
    const other = transactionInput({
      precompact: capturePreCompactSnapshot(
        captureInput({ request_budget_snapshot_id: 'budget:snap-other' }),
      ),
    });
    expect(computeReconstructionIdempotencyKey(other)).not.toBe(
      computeReconstructionIdempotencyKey(base),
    );
  });

  it('is order-insensitive over active_project_activation_refs', () => {
    const base = transactionInput({
      precompact: capturePreCompactSnapshot(
        captureInput({ active_project_activation_refs: ['act:a', 'act:b', 'act:c'] }),
      ),
    });
    const reordered = transactionInput({
      precompact: capturePreCompactSnapshot(
        captureInput({ active_project_activation_refs: ['act:c', 'act:a', 'act:b'] }),
      ),
    });
    // Sorted canonicalization → same key despite different physical order.
    expect(computeReconstructionIdempotencyKey(reordered)).toBe(
      computeReconstructionIdempotencyKey(base),
    );
  });

  it('is order-insensitive over active_meta_lifecycle_refs', () => {
    const base = transactionInput({
      precompact: capturePreCompactSnapshot(
        captureInput({ active_meta_lifecycle_refs: ['life:1', 'life:2'] }),
      ),
    });
    const reordered = transactionInput({
      precompact: capturePreCompactSnapshot(
        captureInput({ active_meta_lifecycle_refs: ['life:2', 'life:1'] }),
      ),
    });
    expect(computeReconstructionIdempotencyKey(reordered)).toBe(
      computeReconstructionIdempotencyKey(base),
    );
  });

  it('binds to memory_rebuild_identity.old_entrypoint_snapshot_id', () => {
    const base = transactionInput();
    const other = transactionInput({
      memory_rebuild_identity: {
        old_entrypoint_snapshot_id: 'entry:mem-other',
        policy_ref: { contract_id: 'mi.entrypoint/1', protocol_version: '1' },
        render_profile_ref: 'render:profile-1',
      },
    });
    expect(computeReconstructionIdempotencyKey(other)).not.toBe(
      computeReconstructionIdempotencyKey(base),
    );
  });

  it('binds to memory_rebuild_identity.policy_ref', () => {
    const base = transactionInput();
    const other = transactionInput({
      memory_rebuild_identity: {
        old_entrypoint_snapshot_id: 'entry:mem-1',
        policy_ref: { contract_id: 'mi.entrypoint/2', protocol_version: '1' },
        render_profile_ref: 'render:profile-1',
      },
    });
    expect(computeReconstructionIdempotencyKey(other)).not.toBe(
      computeReconstructionIdempotencyKey(base),
    );
  });

  it('binds to memory_rebuild_identity.render_profile_ref', () => {
    const base = transactionInput();
    const other = transactionInput({
      memory_rebuild_identity: {
        old_entrypoint_snapshot_id: 'entry:mem-1',
        policy_ref: { contract_id: 'mi.entrypoint/1', protocol_version: '1' },
        render_profile_ref: 'render:profile-other',
      },
    });
    expect(computeReconstructionIdempotencyKey(other)).not.toBe(
      computeReconstructionIdempotencyKey(base),
    );
  });

  it('binds to postflight_validator_policy (id and version)', () => {
    const base = transactionInput();
    const otherId = transactionInput({
      postflight_validator_policy: {
        validator_policy_id: 'mi.postflight.policy:other',
        validator_policy_version: '1.0.0',
      },
    });
    const otherVersion = transactionInput({
      postflight_validator_policy: {
        validator_policy_id: 'mi.postflight.policy:default',
        validator_policy_version: '2.0.0',
      },
    });
    expect(computeReconstructionIdempotencyKey(otherId)).not.toBe(
      computeReconstructionIdempotencyKey(base),
    );
    expect(computeReconstructionIdempotencyKey(otherVersion)).not.toBe(
      computeReconstructionIdempotencyKey(base),
    );
  });
});

// ===========================================================================
// Protocol version orthogonality
// ===========================================================================

describe('protocol version orthogonality', () => {
  it('stamps independent protocol versions on each record type', () => {
    const snap = capturePreCompactSnapshot(captureInput());
    const tx = createReconstructionTransactionRequest(transactionInput());
    expect(snap.precompact_protocol_version).toBe(PRECOMPACT_PROTOCOL_VERSION);
    expect(tx.reconstruction_protocol_version).toBe(
      RECONSTRUCTION_TRANSACTION_PROTOCOL_VERSION,
    );
    // The two are distinct protocol namespaces — never aliased.
    expect(PRECOMPACT_PROTOCOL_VERSION).not.toBe(
      RECONSTRUCTION_TRANSACTION_PROTOCOL_VERSION,
    );
    expect(RECONSTRUCTION_PROTOCOL_VERSION).not.toBe(
      RECONSTRUCTION_TRANSACTION_PROTOCOL_VERSION,
    );
  });

  it('bumping policy_version produces a new transaction identity without rewriting precompact fields', () => {
    // Capture once; the same frozen precompact feeds both transactions.
    const precompact = capturePreCompactSnapshot(captureInput());

    const txA = createReconstructionTransactionRequest({
      ...transactionInput(),
      precompact,
      policy: createReconstructionPolicy({ ...policyIdentity(), policy_version: '1.0.0' }),
    });
    const txB = createReconstructionTransactionRequest({
      ...transactionInput(),
      precompact,
      policy: createReconstructionPolicy({ ...policyIdentity(), policy_version: '2.0.0' }),
    });

    // Precompact fields are bit-for-bit identical (we passed the same snapshot).
    expect(txB.precompact_snapshot_id).toBe(txA.precompact_snapshot_id);
    expect(txB.session_id).toBe(txA.session_id);
    expect(txB.turn_id).toBe(txA.turn_id);

    // But the transaction identity and idempotency diverge on policy_version.
    expect(txB.reconstruction_transaction_id).not.toBe(txA.reconstruction_transaction_id);
    expect(txB.idempotency_key).not.toBe(txA.idempotency_key);
  });
});
