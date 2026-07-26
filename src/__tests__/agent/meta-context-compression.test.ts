/**
 * ERC-1 §7.6 / M-038 — Compressor enforcement.
 *
 * `applyMetaRetentionToCompression` is the single function that turns a frozen
 * `MetaMessageLifecycleRecord` into a closed `MetaCompressionDirective`. The
 * directive tells the compressor how to treat the meta message during history
 * eviction — never to read the source, never to change Authority, never to
 * touch tool pairing / current-user Pinned Working Set.
 *
 * Invariants exercised below (spec ERC-1 §7.6 / §7.8 / INV-E3 / INV-E5):
 *   - resident / serialized  → preserve_body (eviction must not drop the body)
 *   - reload_required        → emit_reload_marker (body MAY be omitted, but
 *                              marker/source/provenance/freshness/ordinal must
 *                              survive — deferred to M-049, not done here)
 *   - invalidated            → emit_invalidation_marker (keep reason, no silent
 *                              disappearance)
 *   - output is frozen and carries a deterministic result_id
 *   - NO Wave F edge: reload marker is a marker only, not FRC-1 import, not
 *     M-013 trigger, not "reconstruction complete".
 */
import { describe, expect, it } from 'vitest';
import {
  applyMetaRetentionToCompression,
  createMetaLifecycleRecord,
  decideMetaRetention,
  META_RETENTION_PROTOCOL_VERSION,
  type MetaLifecycleState,
  type MetaMessageLifecycleRecord,
  type MetaRetentionCompressionResult,
} from '../../agent/context/retention.js';
import type { MetaContextActivation } from '../../agent/context/activation.js';

// ---------------------------------------------------------------------------
// Stand-in activation. We do not call the activator here — compression must
// accept any structurally valid lifecycle record regardless of how it was
// produced.
// ---------------------------------------------------------------------------

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

/**
 * Build a real lifecycle record in the given state by routing through the
 * retention pipeline. This proves the compressor input is the same shape
 * downstream code will actually produce, not a hand-rolled stub.
 */
function recordIn(state: MetaLifecycleState): MetaMessageLifecycleRecord {
  // Map each lifecycle state back to a freshness input that produces it via
  // the retention pipeline, then transition to the requested state if needed.
  const freshnessForState: Record<
    MetaLifecycleState,
    'fresh' | 'stale_refreshable' | 'invalidated_source'
  > = {
    resident: 'fresh',
    reload_required: 'stale_refreshable',
    invalidated: 'invalidated_source',
    // serialized is not an initial state — reached by transitioning from
    // resident below.
    serialized: 'fresh',
  };

  const decision = decideMetaRetention(
    {
      retention_protocol_version: META_RETENTION_PROTOCOL_VERSION,
      meta_activation: frozenActivation(),
      session_snapshot_id: 'session-snap-1',
      source_freshness_state: freshnessForState[state],
      source_content_hash: 'hash-captured',
      activation_content_hash: 'hash-captured',
      current_time: '2026-07-26T00:00:00.000Z',
    },
    { policy_id: 'pi-retention/1', policy_version: '1.0.0', fresh_threshold_ms: 60_000 },
  );

  const initial = createMetaLifecycleRecord(decision, {
    transitioned_at: '2026-07-26T00:00:00.000Z',
  });

  if (state === 'serialized') {
    // Transition resident → serialized, the way a serializer would.
    return createMetaLifecycleRecord(decision, {
      previous_state: 'resident',
      serializer_identity_ref: 'serializer-snap-1',
      transitioned_at: '2026-07-26T00:00:01.000Z',
    }) as unknown as MetaMessageLifecycleRecord & { state: 'serialized' };
  }

  // Force the state field via a re-frozen copy. The retention pipeline
  // produces resident/reload_required/invalidated natively; only serialized
  // needs the transition above.
  return initial;
}

describe('applyMetaRetentionToCompression — state → directive mapping (spec ERC-1 §7.6)', () => {
  it.each([
    ['resident', 'preserve_body'],
    ['reload_required', 'emit_reload_marker'],
    ['invalidated', 'emit_invalidation_marker'],
    ['serialized', 'preserve_body'],
  ] as const)('handles %s as %s', (state, expected) => {
    const result = applyMetaRetentionToCompression({
      lifecycle_record: recordIn(state),
    });
    expect(result.meta_directive).toBe(expected);
  });
});

describe('applyMetaRetentionToCompression — output shape & identity', () => {
  it('stamps compression_protocol_version on every result', () => {
    const result = applyMetaRetentionToCompression({
      lifecycle_record: recordIn('resident'),
    });
    expect(result.compression_protocol_version).toMatch(/^mi\.meta\.compression\//);
  });

  it('produces a result_id with the mcomp: prefix', () => {
    const result = applyMetaRetentionToCompression({
      lifecycle_record: recordIn('resident'),
    });
    expect(result.result_id).toMatch(/^mcomp:[0-9a-f]{16}$/);
  });

  it('produces a deterministic result_id for identical inputs', () => {
    const record = recordIn('resident');
    const a = applyMetaRetentionToCompression({ lifecycle_record: record });
    const b = applyMetaRetentionToCompression({ lifecycle_record: record });
    expect(a.result_id).toBe(b.result_id);
  });

  it('returns a frozen object (directive is immutable)', () => {
    const result = applyMetaRetentionToCompression({
      lifecycle_record: recordIn('resident'),
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('carries non-empty reason_codes explaining the directive', () => {
    const result = applyMetaRetentionToCompression({
      lifecycle_record: recordIn('reload_required'),
    });
    expect(result.reason_codes.length).toBeGreaterThan(0);
    expect(result.reason_codes.every((c) => c.startsWith('compression.'))).toBe(true);
  });
});

describe('applyMetaRetentionToCompression — reason codes per directive', () => {
  it('resident yields a preserve reason', () => {
    const result = applyMetaRetentionToCompression({
      lifecycle_record: recordIn('resident'),
    });
    expect(result.reason_codes).toContain('compression.resident_preserve_body');
  });

  it('reload_required yields a reload-marker reason', () => {
    const result = applyMetaRetentionToCompression({
      lifecycle_record: recordIn('reload_required'),
    });
    expect(result.reason_codes).toContain('compression.reload_required_emit_marker');
  });

  it('invalidated yields an invalidation-marker reason', () => {
    const result = applyMetaRetentionToCompression({
      lifecycle_record: recordIn('invalidated'),
    });
    expect(result.reason_codes).toContain('compression.invalidated_emit_marker');
  });
});

describe('applyMetaRetentionToCompression — result_id divergence', () => {
  it('changes result_id when the lifecycle state differs', () => {
    const resident = applyMetaRetentionToCompression({
      lifecycle_record: recordIn('resident'),
    });
    const reload = applyMetaRetentionToCompression({
      lifecycle_record: recordIn('reload_required'),
    });
    expect(resident.result_id).not.toBe(reload.result_id);
  });

  it('changes result_id when the lifecycle_record_id differs', () => {
    // Two resident records minted from different sessions must diverge.
    const activationA = frozenActivation({ activation_id: 'activation-A' });
    const activationB = frozenActivation({ activation_id: 'activation-B' });

    const decisionA = decideMetaRetention(
      {
        retention_protocol_version: META_RETENTION_PROTOCOL_VERSION,
        meta_activation: activationA,
        session_snapshot_id: 'session-A',
        source_freshness_state: 'fresh',
        source_content_hash: 'hash',
        activation_content_hash: 'hash',
        current_time: '2026-07-26T00:00:00.000Z',
      },
      { policy_id: 'pi-retention/1', policy_version: '1.0.0', fresh_threshold_ms: 60_000 },
    );
    const decisionB = decideMetaRetention(
      {
        retention_protocol_version: META_RETENTION_PROTOCOL_VERSION,
        meta_activation: activationB,
        session_snapshot_id: 'session-B',
        source_freshness_state: 'fresh',
        source_content_hash: 'hash',
        activation_content_hash: 'hash',
        current_time: '2026-07-26T00:00:00.000Z',
      },
      { policy_id: 'pi-retention/1', policy_version: '1.0.0', fresh_threshold_ms: 60_000 },
    );

    const recordA = createMetaLifecycleRecord(decisionA, {
      transitioned_at: '2026-07-26T00:00:00.000Z',
    });
    const recordB = createMetaLifecycleRecord(decisionB, {
      transitioned_at: '2026-07-26T00:00:00.000Z',
    });

    const a = applyMetaRetentionToCompression({ lifecycle_record: recordA });
    const b = applyMetaRetentionToCompression({ lifecycle_record: recordB });
    expect(a.result_id).not.toBe(b.result_id);
  });
});

// ---------------------------------------------------------------------------
// NO Wave F edge (spec ERC-1 §7 / INV-E5).
//
// The reload marker output is a MARKER ONLY. It must not:
//   - import FRC-1 (Wave F is not a dependency of ERC-1)
//   - trigger M-013
//   - declare reconstruction complete
// We assert this structurally: the result never carries a "reconstruction"
// field, and the directive set is closed.
// ---------------------------------------------------------------------------

describe('applyMetaRetentionToCompression — no Wave F edge (INV-E5 / spec §7.8)', () => {
  it('never declares reconstruction complete (reload marker is marker-only)', () => {
    const result = applyMetaRetentionToCompression({
      lifecycle_record: recordIn('reload_required'),
    });
    // The result must not pretend M-049 reconstruction is done.
    expect(result).not.toHaveProperty('reconstruction_complete');
    expect(result).not.toHaveProperty('reconstruction_id');
    expect(result).not.toHaveProperty('m049_handoff');
  });

  it('directive set is closed: only the three documented directives', () => {
    const directives = new Set<MetaRetentionCompressionResult['meta_directive']>([
      'preserve_body',
      'emit_reload_marker',
      'emit_invalidation_marker',
    ]);
    for (const state of ['resident', 'reload_required', 'invalidated', 'serialized'] as const) {
      const result = applyMetaRetentionToCompression({
        lifecycle_record: recordIn(state),
      });
      expect(directives.has(result.meta_directive)).toBe(true);
    }
  });
});
