/**
 * ERC-1 §7.7 / M-038 — Activation gate for the full meta retention pipeline.
 *
 * `canActivateMetaRetention` is the closed-form six-gate predicate that must
 * pass before any meta retention directive is allowed to take effect on the
 * compressor / serializer path. If any single gate is false, activation is
 * refused and the missing gate names are returned for diagnostics.
 *
 * Non-negotiable (spec ERC-1 §7.7):
 *   - Gates cannot be replaced by a Prompt reminder.
 *   - Gates are independent: failing one must not silently flip another.
 *   - Output must list every failing gate, in stable order, by its canonical
 *     capability name.
 *
 * The six gates (spec Step 4):
 *   1. message_model_supports_is_meta
 *   2. serializer_round_trip_verified
 *   3. compressor_handles_all_three_actions
 *   4. resume_compaction_keeps_user_turn_count
 *   5. unknown_metadata_fails_closed
 *   6. message_source_identity_matches   (M-008 / M-038 identity match)
 */
import { describe, expect, it } from 'vitest';
import {
  canActivateMetaRetention,
  type MetaRetentionActivationInput,
  type MetaRetentionActivationResult,
} from '../../agent/context/retention.js';

/**
 * Convenience: all six gates green. Individual tests flip exactly one gate to
 * false to keep assertions tight and failure messages readable.
 */
function allGatesPass(
  overrides: Partial<MetaRetentionActivationInput> = {},
): MetaRetentionActivationInput {
  return {
    message_model_supports_is_meta: true,
    serializer_round_trip_verified: true,
    compressor_handles_all_three_actions: true,
    resume_compaction_keeps_user_turn_count: true,
    unknown_metadata_fails_closed: true,
    message_source_identity_matches: true,
    ...overrides,
  };
}

describe('canActivateMetaRetention — full activation (spec ERC-1 §7.7)', () => {
  it('activates when all six gates pass', () => {
    const result = canActivateMetaRetention(allGatesPass());
    expect(result.activated).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('returns a frozen result (gate decision is immutable)', () => {
    const result = canActivateMetaRetention(allGatesPass());
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe('canActivateMetaRetention — single-gate failures', () => {
  it.each([
    ['message_model_supports_is_meta'],
    ['serializer_round_trip_verified'],
    ['compressor_handles_all_three_actions'],
    ['resume_compaction_keeps_user_turn_count'],
    ['unknown_metadata_fails_closed'],
    ['message_source_identity_matches'],
  ] as const)('does not activate when %s is false', (gate) => {
    const result = canActivateMetaRetention(allGatesPass({ [gate]: false }));
    expect(result.activated).toBe(false);
    expect(result.missing).toContain(gate);
  });

  it('lists exactly the failing gate when only one is false', () => {
    const result = canActivateMetaRetention(
      allGatesPass({ serializer_round_trip_verified: false }),
    );
    expect(result.missing).toEqual(['serializer_round_trip_verified']);
  });
});

describe('canActivateMetaRetention — multi-gate failures', () => {
  it('lists every failing gate when several are false', () => {
    const result = canActivateMetaRetention(
      allGatesPass({
        compressor_handles_all_three_actions: false,
        unknown_metadata_fails_closed: false,
        message_source_identity_matches: false,
      }),
    );
    expect(result.activated).toBe(false);
    expect(result.missing).toEqual([
      'compressor_handles_all_three_actions',
      'unknown_metadata_fails_closed',
      'message_source_identity_matches',
    ]);
  });

  it('returns missing in the canonical gate order regardless of object key order', () => {
    // Object keys deliberately out of order — output must still be canonical.
    const result = canActivateMetaRetention({
      message_source_identity_matches: false,
      compressor_handles_all_three_actions: false,
      message_model_supports_is_meta: true,
      serializer_round_trip_verified: true,
      resume_compaction_keeps_user_turn_count: false,
      unknown_metadata_fails_closed: true,
    });
    expect(result.missing).toEqual([
      'compressor_handles_all_three_actions',
      'resume_compaction_keeps_user_turn_count',
      'message_source_identity_matches',
    ]);
  });

  it('does not activate when every gate is false', () => {
    const result = canActivateMetaRetention({
      message_model_supports_is_meta: false,
      serializer_round_trip_verified: false,
      compressor_handles_all_three_actions: false,
      resume_compaction_keeps_user_turn_count: false,
      unknown_metadata_fails_closed: false,
      message_source_identity_matches: false,
    });
    expect(result.activated).toBe(false);
    expect(result.missing).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Capability-edge assertions (spec ERC-1 §7.7 / INV-E5).
//
// The gate predicate is closed-form: it must NOT be replaceable by a Prompt
// reminder, must NOT touch Wave F, and must NOT implicitly trust any single
// gate. These tests pin those properties structurally.
// ---------------------------------------------------------------------------

describe('canActivateMetaRetention — capability edges', () => {
  it('result type is closed: only `activated` and `missing` fields', () => {
    const result = canActivateMetaRetention(allGatesPass()) as unknown as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['activated', 'missing']);
  });

  it('never returns a Prompt-reminder substitute (no `reminder` field)', () => {
    const result = canActivateMetaRetention(allGatesPass({ unknown_metadata_fails_closed: false }));
    expect(result).not.toHaveProperty('reminder');
    expect(result).not.toHaveProperty('prompt_reminder');
  });

  it('missing list contains only canonical gate names', () => {
    const canonical = new Set<keyof MetaRetentionActivationInput>([
      'message_model_supports_is_meta',
      'serializer_round_trip_verified',
      'compressor_handles_all_three_actions',
      'resume_compaction_keeps_user_turn_count',
      'unknown_metadata_fails_closed',
      'message_source_identity_matches',
    ]);
    const result = canActivateMetaRetention(
      allGatesPass({
        message_model_supports_is_meta: false,
        resume_compaction_keeps_user_turn_count: false,
      }),
    );
    for (const m of result.missing) {
      expect(canonical.has(m as keyof MetaRetentionActivationInput)).toBe(true);
    }
  });
});

// Type-level sanity: exported types are usable from outside the module.
function _typeCheck(): void {
  const _i: MetaRetentionActivationInput = {} as unknown as MetaRetentionActivationInput;
  const _r: MetaRetentionActivationResult = {} as unknown as MetaRetentionActivationResult;
  void _i;
  void _r;
}
void _typeCheck;
