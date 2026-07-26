import { describe, expect, it } from 'vitest';
import {
  activateProjectInstruction,
  ACTIVATION_PROTOCOL_VERSION,
  type ContextActivationIdentity,
  type ProjectInstructionActivationInput,
} from '../../agent/context/activation.js';

// ---------------------------------------------------------------------------
// DRC-2 §8 — Project Instruction Activation (M-008).
//
// `activateProjectInstruction` is the ONLY function that lifts a CRC-3-routed
// project_instruction_context candidate into a `MetaContextActivation` for the
// RC-2 `meta_context` plane. The four-gate trust AND is re-checked here because
// the channel boundary is load-bearing: route target, trust proof, sanitizer
// acceptance, and source budget must ALL be present and consistent before any
// meta message can be minted.
//
// Invariants exercised below (spec §8.5 / §8.12 / INV-D4 / INV-D5 / INV-D8):
//   - is_meta=true does NOT promote Authority/Trust/Retention.
//   - Project Instruction channel NEVER emits memory_candidate_id /
//     admission_decision_id (channel separation).
//   - meta context never lands in system_static/system_dynamic and never
//     replaces the current user turn.
//   - ordinal is received (caller guarantees uniqueness); this function does
//     not invent or guess order.
// ---------------------------------------------------------------------------

const BASE_IDENTITY: ContextActivationIdentity = {
  activation_protocol_version: ACTIVATION_PROTOCOL_VERSION,
  activation_id: 'activation-1',
  request_snapshot_id: 'snapshot-1',
  source_context_id: 'src-1',
  route_decision_id: 'route-1',
  channel: 'project_instruction',
};

function validInput(
  overrides: Partial<ProjectInstructionActivationInput> = {},
): ProjectInstructionActivationInput {
  return {
    activation_identity: BASE_IDENTITY,
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
    ...overrides,
  };
}

describe('activateProjectInstruction — four-gate trust AND (spec §8.3 / §8.12)', () => {
  it.each([
    ['wrong_route', { route_target: 'auto_memory_context' }, 'activation.wrong_route'],
    ['missing_trust', { trust_proof_ref: '' }, 'activation.missing_trust'],
    ['sanitizer_rejected', { sanitization_status: 'rejected' }, 'activation.sanitizer_rejected'],
    ['missing_budget', { source_budget_ref: '' }, 'activation.missing_budget'],
  ])(
    'rejects %s activation by throwing %s',
    (_name, failure, expectedMessage) => {
      expect(() => activateProjectInstruction(validInput(failure))).toThrowError(
        expectedMessage,
      );
    },
  );

  it('rejects when activation_identity channel is not project_instruction', () => {
    const input = validInput({
      activation_identity: { ...BASE_IDENTITY, channel: 'auto_memory' },
    });
    expect(() => activateProjectInstruction(input)).toThrowError(
      /channel/,
    );
  });

  it('rejects when identity source_context_id disagrees with context_source_id', () => {
    const input = validInput({
      context_source_id: 'src-2',
      activation_identity: { ...BASE_IDENTITY, source_context_id: 'src-1' },
    });
    expect(() => activateProjectInstruction(input)).toThrowError(/source_context_id/);
  });

  it('rejects when identity route_decision_id disagrees with route_decision_id', () => {
    const input = validInput({
      route_decision_id: 'route-2',
      activation_identity: { ...BASE_IDENTITY, route_decision_id: 'route-1' },
    });
    expect(() => activateProjectInstruction(input)).toThrowError(/route_decision_id/);
  });

  it('rejects when sanitization_status is transformed without being accepted', () => {
    // transformed is allowed by spec (accepted/transformed are the legal pass states).
    // This test confirms transformed PASSES (negative control).
    const result = activateProjectInstruction(
      validInput({ sanitization_status: 'transformed' }),
    );
    expect(result.is_meta).toBe(true);
  });

  it('rejects negative ordinal', () => {
    expect(() =>
      activateProjectInstruction(validInput({ ordinal: -1 })),
    ).toThrowError(/ordinal/);
  });

  it('rejects non-integer ordinal', () => {
    expect(() =>
      activateProjectInstruction(validInput({ ordinal: 1.5 })),
    ).toThrowError(/ordinal/);
  });
});

describe('activateProjectInstruction — meta context output (spec §8.4 / §8.5)', () => {
  it('produces MetaContextActivation with fixed placement and is_meta', () => {
    const result = activateProjectInstruction(validInput());
    expect(result.placement).toBe('meta_context');
    expect(result.is_meta).toBe(true);
    expect(result.semantic_role).toBe('user');
    expect(result.retention_state).toBe('unassigned');
  });

  it('echoes activation_protocol_version from identity', () => {
    const result = activateProjectInstruction(validInput());
    expect(result.activation_protocol_version).toBe(ACTIVATION_PROTOCOL_VERSION);
  });

  it('carries identity linkage (activation_id / request_snapshot_id / source_context_id / route_decision_id)', () => {
    const result = activateProjectInstruction(validInput());
    expect(result.activation_id).toBe('activation-1');
    expect(result.request_snapshot_id).toBe('snapshot-1');
    expect(result.source_context_id).toBe('src-1');
    expect(result.route_decision_id).toBe('route-1');
  });

  it('preserves authority/trust from input (no promotion)', () => {
    const result = activateProjectInstruction(
      validInput({ authority: 'user', trust: 'trusted' }),
    );
    expect(result.authority).toBe('user');
    expect(result.trust).toBe('trusted');
    // INV-D4: is_meta=true must not lift Authority/Trust to system.
    expect(result.authority).not.toBe('system');
  });

  it('preserves bounded content & overflow ref verbatim (no second silent truncation)', () => {
    const result = activateProjectInstruction(
      validInput({
        bounded_content_ref: 'bounded-xyz',
        overflow_metadata_ref: 'overflow-1',
      }),
    );
    expect(result.content_ref).toBe('bounded-xyz');
    expect(result.overflow_metadata_ref).toBe('overflow-1');
  });

  it('preserves null overflow_metadata_ref', () => {
    const result = activateProjectInstruction(
      validInput({ overflow_metadata_ref: null }),
    );
    expect(result.overflow_metadata_ref).toBeNull();
  });

  it('copies content_hash verbatim from input', () => {
    const result = activateProjectInstruction(
      validInput({ content_hash: 'deadbeef' }),
    );
    expect(result.content_hash).toBe('deadbeef');
  });

  it('copies provenance_refs and freshness_ref verbatim', () => {
    const result = activateProjectInstruction(
      validInput({
        provenance_refs: ['user:input', 'policy:pi'],
        freshness_ref: 'fresh-2',
      }),
    );
    expect(result.provenance_refs).toEqual(['user:input', 'policy:pi']);
    expect(result.freshness_ref).toBe('fresh-2');
  });

  it('echoes ordinal verbatim (caller owns uniqueness)', () => {
    const result = activateProjectInstruction(validInput({ ordinal: 7 }));
    expect(result.ordinal).toBe(7);
  });
});

describe('activateProjectInstruction — message_id (spec §8.4)', () => {
  it('produces a message_id with the meta: prefix', () => {
    const result = activateProjectInstruction(validInput());
    expect(result.message_id).toMatch(/^meta:[0-9a-f]{16}$/);
  });

  it('produces a deterministic message_id for identical inputs', () => {
    const a = activateProjectInstruction(validInput());
    const b = activateProjectInstruction(validInput());
    expect(a.message_id).toBe(b.message_id);
  });

  it('produces a different message_id when content_hash changes', () => {
    const a = activateProjectInstruction(validInput({ content_hash: 'h1' }));
    const b = activateProjectInstruction(validInput({ content_hash: 'h2' }));
    expect(a.message_id).not.toBe(b.message_id);
  });
});

describe('activateProjectInstruction — channel separation (INV-D5)', () => {
  it('does not output memory_candidate_id or admission_decision_id', () => {
    const result = activateProjectInstruction(
      validInput(),
    ) as unknown as Record<string, unknown>;
    expect(result).not.toHaveProperty('memory_candidate_id');
    expect(result).not.toHaveProperty('admission_decision_id');
    expect(result).not.toHaveProperty('memory_writer');
  });

  it('does not output system_static/system_dynamic placement fields', () => {
    const result = activateProjectInstruction(
      validInput(),
    ) as unknown as Record<string, unknown>;
    // The fixed placement is meta_context; no other placement field is minted.
    expect(result.placement).toBe('meta_context');
    expect(result).not.toHaveProperty('system_placement');
  });
});

describe('activateProjectInstruction — immutability', () => {
  it('returns a frozen object (snapshot cannot be mutated by downstream)', () => {
    const result = activateProjectInstruction(validInput());
    expect(Object.isFrozen(result)).toBe(true);
  });
});
