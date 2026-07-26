import { describe, expect, it } from 'vitest';
import {
  createMetaLifecycleRecord,
  decideMetaRetention,
  META_LIFECYCLE_PROTOCOL_VERSION,
  META_RETENTION_PROTOCOL_VERSION,
  type MetaLifecycleState,
  type MetaMessageLifecycleRecord,
  type MetaRetentionDecision,
  type MetaRetentionInput,
  type MetaRetentionPolicy,
} from '../../agent/context/retention.js';
import type { MetaContextActivation } from '../../agent/context/activation.js';

// ---------------------------------------------------------------------------
// ERC-1 / M-038 — Meta Retention Decision.
//
// `decideMetaRetention` is the only function that turns a DRC-2
// `MetaContextActivation` into a lifecycle action without rewriting its
// Authority or Trust. `createMetaLifecycleRecord` projects that decision into
// the initial meta lifecycle state, binding session/message/activation/
// retention identity for downstream serializer/compressor/M-049 consumers.
//
// Invariants exercised below (spec ERC-1 §7 / INV-E2 / INV-E3 / INV-E5):
//   - Retention action NEVER changes Authority/Trust (INV-E3).
//   - `reload_required` only registers a marker — it does NOT read source,
//     inject messages, or claim M-049 is done (INV-E5).
//   - Meta lifecycle is bound to session/message/activation/retention identity;
//     old records are immutable.
//   - Unknown freshness must NOT optimistically preserve; it must defer
//     (mark_reload_required) rather than assert staleness is fine.
//   - Content hash drift forces invalidate — the source the activation captured
//     is no longer the source on disk.
// ---------------------------------------------------------------------------

// A minimum-viable frozen MetaContextActivation stand-in. We do not call
// activateProjectInstruction here — retention must accept ANY structurally
// valid activation, and depending on the activator would couple two modules.
function frozenActivation(
  overrides: Partial<MetaContextActivation> = {},
): MetaContextActivation {
  return Object.freeze({
    activation_protocol_version: 'mi.activation/1',
    activation_id: 'activation-1',
    request_snapshot_id: 'snapshot-1',
    message_id: 'meta:abc123',
    semantic_role: 'user',
    placement: 'meta_context',
    is_meta: true,
    source_context_id: 'src-1',
    route_decision_id: 'route-1',
    content_ref: 'bounded-ref-1',
    content_hash: 'hash-captured',
    authority: 'user',
    trust: 'trusted',
    provenance_refs: ['user:input'],
    freshness_ref: 'fresh-1',
    overflow_metadata_ref: null,
    retention_state: 'unassigned',
    ordinal: 0,
    ...overrides,
  }) as MetaContextActivation;
}

const POLICY: MetaRetentionPolicy = {
  policy_id: 'pi-retention/1',
  policy_version: '1.0.0',
  fresh_threshold_ms: 60_000,
};

function inputFor(
  sourceState: MetaRetentionInput['source_freshness_state'],
  overrides: Partial<MetaRetentionInput> = {},
): MetaRetentionInput {
  return {
    retention_protocol_version: META_RETENTION_PROTOCOL_VERSION,
    meta_activation: frozenActivation(),
    session_snapshot_id: 'session-snap-1',
    source_freshness_state: sourceState,
    source_content_hash: 'hash-captured',
    activation_content_hash: 'hash-captured',
    current_time: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

describe('decideMetaRetention — source freshness mapping (spec ERC-1 §7.3 / §7.8)', () => {
  it.each([
    ['fresh', 'preserve'],
    ['stale_refreshable', 'mark_reload_required'],
    ['invalidated_source', 'invalidate'],
  ] as const)(
    'maps %s source state to %s without changing authority',
    (sourceState, action) => {
      const decision = decideMetaRetention(inputFor(sourceState), POLICY);
      expect(decision.action).toBe(action);
      // INV-E3: retention must not rewrite authority/trust.
      expect(decision.authority).toBe('user');
      expect(decision.trust).toBe('trusted');
    },
  );

  it('maps unknown freshness to mark_reload_required (not preserve)', () => {
    // Unknown must defer — it must NOT optimistically preserve stale content.
    const decision = decideMetaRetention(inputFor('unknown'), POLICY);
    expect(decision.action).toBe('mark_reload_required');
    expect(decision.reason_codes).toContain('retention.freshness_unknown');
  });

  it('invalidates on content hash mismatch (source drifted from activation)', () => {
    const decision = decideMetaRetention(
      inputFor('fresh', {
        source_content_hash: 'hash-on-disk-new',
        activation_content_hash: 'hash-captured',
      }),
      POLICY,
    );
    expect(decision.action).toBe('invalidate');
    expect(decision.reason_codes).toContain('retention.content_hash_mismatch');
  });

  it('content hash mismatch overrides a fresh source state', () => {
    // Even if freshness says 'fresh', hash drift wins (spec §7.8).
    const decision = decideMetaRetention(
      inputFor('fresh', {
        source_content_hash: 'different',
        activation_content_hash: 'hash-captured',
      }),
      POLICY,
    );
    expect(decision.action).toBe('invalidate');
  });
});

describe('decideMetaRetention — authority/trust verbatim (INV-E3)', () => {
  it('echoes authority/trust from the activation regardless of action', () => {
    const decision = decideMetaRetention(
      inputFor('invalidated_source', {
        meta_activation: frozenActivation({
          authority: 'system',
          trust: 'untrusted',
        }),
      }),
      POLICY,
    );
    expect(decision.authority).toBe('system');
    expect(decision.trust).toBe('untrusted');
    // invalidate does not promote trust back up.
    expect(decision.action).toBe('invalidate');
  });

  it('never mints authority/trust of its own', () => {
    const decision = decideMetaRetention(inputFor('fresh'), POLICY) as unknown as Record<
      string,
      unknown
    >;
    // Only authority/trust fields exist; no invented authority-like fields.
    expect(decision.authority).toBe('user');
    expect(decision.trust).toBe('trusted');
  });
});

describe('decideMetaRetention — identity gates (spec ERC-1 §7.7 / §7.8)', () => {
  it.each([
    ['retention_protocol_version', { retention_protocol_version: '' }],
    ['session_snapshot_id', { session_snapshot_id: '' }],
  ])(
    'rejects empty %s by throwing',
    (_field, override) => {
      expect(() => decideMetaRetention(inputFor('fresh', override), POLICY)).toThrowError(
        /retention\./,
      );
    },
  );

  it('rejects when meta_activation.activation_id is empty', () => {
    expect(() =>
      decideMetaRetention(
        inputFor('fresh', {
          meta_activation: frozenActivation({ activation_id: '' }),
        }),
        POLICY,
      ),
    ).toThrowError(/retention\./);
  });

  it.each([
    ['policy_id', { policy_id: '' }],
    ['policy_version', { policy_version: '' }],
  ])('rejects empty policy %s by throwing', (_field, override) => {
    const badPolicy = { ...POLICY, ...override };
    expect(() => decideMetaRetention(inputFor('fresh'), badPolicy)).toThrowError(
      /retention\.invalid_policy/,
    );
  });
});

describe('decideMetaRetention — output shape', () => {
  it('produces a retention_decision_id with the ret: prefix', () => {
    const decision = decideMetaRetention(inputFor('fresh'), POLICY);
    expect(decision.retention_decision_id).toMatch(/^ret:[0-9a-f]{16}$/);
  });

  it('produces a deterministic retention_decision_id for identical inputs', () => {
    const a = decideMetaRetention(inputFor('fresh'), POLICY);
    const b = decideMetaRetention(inputFor('fresh'), POLICY);
    expect(a.retention_decision_id).toBe(b.retention_decision_id);
  });

  it('changes retention_decision_id when source state changes', () => {
    const fresh = decideMetaRetention(inputFor('fresh'), POLICY);
    const stale = decideMetaRetention(inputFor('stale_refreshable'), POLICY);
    expect(fresh.retention_decision_id).not.toBe(stale.retention_decision_id);
  });

  it('carries activation_id and session_snapshot_id linkage verbatim', () => {
    const decision = decideMetaRetention(
      inputFor('fresh', { session_snapshot_id: 'session-snap-9' }),
      POLICY,
    );
    expect(decision.activation_id).toBe('activation-1');
    expect(decision.session_snapshot_id).toBe('session-snap-9');
    expect(decision.retention_protocol_version).toBe(META_RETENTION_PROTOCOL_VERSION);
  });

  it('returns a frozen object (downstream cannot mutate the decision)', () => {
    const decision = decideMetaRetention(inputFor('fresh'), POLICY);
    expect(Object.isFrozen(decision)).toBe(true);
  });
});

describe('createMetaLifecycleRecord — initial state mapping (spec ERC-1 §7.4)', () => {
  it.each([
    ['preserve', 'resident'],
    ['mark_reload_required', 'reload_required'],
    ['invalidate', 'invalidated'],
  ] as const)(
    'maps action %s to initial state %s',
    (action, state) => {
      const decision = decideMetaRetention(inputFor(freshnessForAction(action)), POLICY);
      const record = createMetaLifecycleRecord(decision, {
        transitioned_at: '2026-07-26T00:00:00.000Z',
      });
      expect(record.state).toBe(state as MetaLifecycleState);
    },
  );

  it('defaults previous_state to null on first transition', () => {
    const decision = decideMetaRetention(inputFor('fresh'), POLICY);
    const record = createMetaLifecycleRecord(decision, {
      transitioned_at: '2026-07-26T00:00:00.000Z',
    });
    expect(record.previous_state).toBeNull();
  });

  it('carries previous_state when supplied (state transitions are auditable)', () => {
    const decision = decideMetaRetention(inputFor('stale_refreshable'), POLICY);
    const record = createMetaLifecycleRecord(decision, {
      previous_state: 'resident',
      transitioned_at: '2026-07-26T00:00:01.000Z',
    });
    expect(record.previous_state).toBe('resident');
    expect(record.state).toBe('reload_required');
  });

  it('produces a lifecycle_record_id with the life: prefix', () => {
    const decision = decideMetaRetention(inputFor('fresh'), POLICY);
    const record = createMetaLifecycleRecord(decision, {
      transitioned_at: '2026-07-26T00:00:00.000Z',
    });
    expect(record.lifecycle_record_id).toMatch(/^life:[0-9a-f]{16}$/);
  });
});

describe('createMetaLifecycleRecord — identity binding (spec ERC-1 §7.4 / §7.5)', () => {
  it('binds session/message/activation/retention identity', () => {
    const decision = decideMetaRetention(
      inputFor('fresh', { session_snapshot_id: 'session-snap-7' }),
      POLICY,
    );
    const record = createMetaLifecycleRecord(decision, {
      transitioned_at: '2026-07-26T00:00:00.000Z',
    });
    expect(record.session_snapshot_id).toBe('session-snap-7');
    expect(record.message_id).toBe('meta:abc123');
    expect(record.activation_id).toBe('activation-1');
    expect(record.retention_decision_id).toBe(decision.retention_decision_id);
  });

  it('accepts serializer_identity_ref and compressor_identity_ref', () => {
    const decision = decideMetaRetention(inputFor('fresh'), POLICY);
    const record = createMetaLifecycleRecord(decision, {
      serializer_identity_ref: 'serializer-snap-1',
      compressor_identity_ref: 'compressor-snap-1',
      transitioned_at: '2026-07-26T00:00:00.000Z',
    });
    expect(record.serializer_identity_ref).toBe('serializer-snap-1');
    expect(record.compressor_identity_ref).toBe('compressor-snap-1');
  });

  it('defaults serializer/compressor identity refs to null when not supplied', () => {
    const decision = decideMetaRetention(inputFor('fresh'), POLICY);
    const record = createMetaLifecycleRecord(decision, {
      transitioned_at: '2026-07-26T00:00:00.000Z',
    });
    expect(record.serializer_identity_ref).toBeNull();
    expect(record.compressor_identity_ref).toBeNull();
  });

  it('stamps lifecycle_protocol_version on every record', () => {
    const decision = decideMetaRetention(inputFor('fresh'), POLICY);
    const record = createMetaLifecycleRecord(decision, {
      transitioned_at: '2026-07-26T00:00:00.000Z',
    });
    expect(record.lifecycle_protocol_version).toBe(META_LIFECYCLE_PROTOCOL_VERSION);
  });

  it('carries transitioned_at verbatim', () => {
    const decision = decideMetaRetention(inputFor('fresh'), POLICY);
    const ts = '2026-07-26T12:34:56.789Z';
    const record = createMetaLifecycleRecord(decision, { transitioned_at: ts });
    expect(record.transitioned_at).toBe(ts);
  });

  it('returns a frozen object (lifecycle records are immutable)', () => {
    const decision = decideMetaRetention(inputFor('fresh'), POLICY);
    const record = createMetaLifecycleRecord(decision, {
      transitioned_at: '2026-07-26T00:00:00.000Z',
    });
    expect(Object.isFrozen(record)).toBe(true);
  });
});

describe('createMetaLifecycleRecord — deterministic id', () => {
  it('produces the same lifecycle_record_id for identical inputs', () => {
    const decision = decideMetaRetention(inputFor('fresh'), POLICY);
    const a = createMetaLifecycleRecord(decision, {
      transitioned_at: '2026-07-26T00:00:00.000Z',
    });
    const b = createMetaLifecycleRecord(decision, {
      transitioned_at: '2026-07-26T00:00:00.000Z',
    });
    expect(a.lifecycle_record_id).toBe(b.lifecycle_record_id);
  });

  it('changes lifecycle_record_id when previous_state changes', () => {
    const decision = decideMetaRetention(inputFor('fresh'), POLICY);
    const first = createMetaLifecycleRecord(decision, {
      transitioned_at: '2026-07-26T00:00:00.000Z',
    });
    const second = createMetaLifecycleRecord(decision, {
      previous_state: 'resident',
      transitioned_at: '2026-07-26T00:00:00.000Z',
    });
    expect(first.lifecycle_record_id).not.toBe(second.lifecycle_record_id);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inverse of the action→state map: given a desired retention action, return
 * a source freshness state that will produce it (so lifecycle tests can stay
 * independent of the exact freshness inputs).
 */
function freshnessForAction(
  action: 'preserve' | 'mark_reload_required' | 'invalidate',
): MetaRetentionInput['source_freshness_state'] {
  switch (action) {
    case 'preserve':
      return 'fresh';
    case 'mark_reload_required':
      return 'stale_refreshable';
    case 'invalidate':
      return 'invalidated_source';
  }
}

// Type-level sanity: the exported interfaces are usable from outside.
// (If these compile, the public types are wired correctly.)
function _typeCheck(): void {
  const _d: MetaRetentionDecision = {} as unknown as MetaRetentionDecision;
  const _r: MetaMessageLifecycleRecord = {} as unknown as MetaMessageLifecycleRecord;
  void _d;
  void _r;
}
void _typeCheck;
