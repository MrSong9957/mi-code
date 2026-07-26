import { describe, expect, it } from 'vitest';
import {
  buildEnvironmentContextBlock,
  type EnvironmentContextBlock,
} from '../../agent/context/routing.js';
import type { NormalizedEnvironmentSnapshot } from '../../agent/context/intake/environment.js';
import type { SourceBudgetPolicy } from '../../agent/context/intake/source-budget.js';

// ---------------------------------------------------------------------------
// M-009 EnvironmentContextBlock (CRC-3 §9.3).
//
// The block is the ONLY projection of normalized environment values into the
// dynamic system placement. It consumes ONLY `snapshot.allowed_fields` — never
// `process.env`, never the parent environment. Field order is deterministic
// (sorted by key). Budget overflow is recorded explicitly in
// `omitted_field_codes`; no infinite-budget fallback. `placement` is fixed to
// `system_dynamic` and the block carries NO `authority='system'` field —
// placement does not elevate Authority (INV-C6).
// ---------------------------------------------------------------------------

const REFERENCE_NOW = '2026-07-26T00:00:00.000Z';
const REFERENCE_EXPIRED = '2020-01-01T00:00:00.000Z';

/**
 * Build a minimal snapshot. allowed_fields is the surface the block reads;
 * everything else on NormalizedEnvironmentSnapshot is opaque identity to the
 * block builder.
 */
function makeSnapshot(
  overrides: Partial<Pick<NormalizedEnvironmentSnapshot, 'allowed_fields' | 'omitted_field_codes'>> & {
    environment_snapshot_id?: string;
    observed_at?: string;
  } = {},
): NormalizedEnvironmentSnapshot {
  return {
    environment_snapshot_id: overrides.environment_snapshot_id ?? 'env-snap-1',
    platform_family: 'windows',
    shell_family: null,
    workspace_root: 'D:\\repo',
    working_directory: 'D:\\repo\\src',
    repository_present: true,
    allowed_fields: overrides.allowed_fields ?? {},
    omitted_field_codes: overrides.omitted_field_codes ?? [],
    observed_at: overrides.observed_at ?? REFERENCE_NOW,
  };
}

function envBudgetPolicy(overrides: Partial<SourceBudgetPolicy> = {}): SourceBudgetPolicy {
  return {
    source_class: 'environment',
    max_bytes: 4096,
    max_lines: null,
    overflow_behavior: 'deterministic_truncate',
    policy_id: 'env-budget-1',
    policy_version: '1.0.0',
    ...overrides,
  };
}

describe('buildEnvironmentContextBlock — freshness & fields (CRC-3 §9.3)', () => {
  it('returns a block for a fresh snapshot; fields are sorted alphabetically by key', () => {
    const snapshot = makeSnapshot({
      allowed_fields: {
        terminal_columns: 120,
        // Insert deliberately out of order; output MUST be sorted.
        api_base_url: 'https://api.example.test',
        shell_integration_enabled: true,
      },
    });

    const result = buildEnvironmentContextBlock(snapshot, envBudgetPolicy(), {
      now: REFERENCE_NOW,
    });

    expect((result as { unavailable?: unknown }).unavailable).toBeUndefined();
    const block = result as EnvironmentContextBlock;

    const keys = Object.keys(block.fields);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual(['api_base_url', 'shell_integration_enabled', 'terminal_columns']);
    expect(block.fields.terminal_columns).toBe(120);
    expect(block.fields.api_base_url).toBe('https://api.example.test');
    expect(block.fields.shell_integration_enabled).toBe(true);
  });

  it('content_hash is 64 lowercase hex characters (sha256)', () => {
    const snapshot = makeSnapshot({
      allowed_fields: { terminal_columns: 120 },
    });

    const block = buildEnvironmentContextBlock(snapshot, envBudgetPolicy(), {
      now: REFERENCE_NOW,
    }) as EnvironmentContextBlock;

    expect(block.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic: same fields in different insertion order produce the same content_hash and block id', () => {
    const a = makeSnapshot({
      allowed_fields: { z: '1', a: '2' },
    });
    const b = makeSnapshot({
      allowed_fields: { a: '2', z: '1' },
    });

    const blockA = buildEnvironmentContextBlock(a, envBudgetPolicy(), {
      now: REFERENCE_NOW,
    }) as EnvironmentContextBlock;
    const blockB = buildEnvironmentContextBlock(b, envBudgetPolicy(), {
      now: REFERENCE_NOW,
    }) as EnvironmentContextBlock;

    expect(blockA.content_hash).toBe(blockB.content_hash);
    expect(blockA.environment_block_id).toBe(blockB.environment_block_id);
  });

  it('environment_block_id has the `env:` prefix and 16-char sha256 truncation', () => {
    const snapshot = makeSnapshot({ allowed_fields: { x: 1 } });
    const block = buildEnvironmentContextBlock(snapshot, envBudgetPolicy(), {
      now: REFERENCE_NOW,
    }) as EnvironmentContextBlock;

    expect(block.environment_block_id).toMatch(/^env:[0-9a-f]{16}$/);
  });

  it('environment_block_id changes when allowed_fields change', () => {
    const a = makeSnapshot({ allowed_fields: { x: 1 } });
    const b = makeSnapshot({ allowed_fields: { x: 2 } });
    const blockA = buildEnvironmentContextBlock(a, envBudgetPolicy(), {
      now: REFERENCE_NOW,
    }) as EnvironmentContextBlock;
    const blockB = buildEnvironmentContextBlock(b, envBudgetPolicy(), {
      now: REFERENCE_NOW,
    }) as EnvironmentContextBlock;

    expect(blockA.environment_block_id).not.toBe(blockB.environment_block_id);
  });

  it('propagates identity refs (snapshot id, budget policy ref) verbatim', () => {
    const snapshot = makeSnapshot({
      environment_snapshot_id: 'env-snap-42',
    });
    const policy = envBudgetPolicy({ policy_id: 'env-budget-9', policy_version: '2.3.0' });

    const block = buildEnvironmentContextBlock(snapshot, policy, {
      now: REFERENCE_NOW,
    }) as EnvironmentContextBlock;

    expect(block.source_environment_snapshot_id).toBe('env-snap-42');
    expect(block.source_budget_policy_ref).toBe('env-budget-9:2.3.0');
  });
});

describe('buildEnvironmentContextBlock — no process.env / no system authority (INV-C6)', () => {
  it('does NOT read process.env: uses snapshot.allowed_fields even when they disagree with the real env', () => {
    // Inject a value that does NOT exist in any real process.env. If the block
    // secretly read process.env, this field would be wrong or absent.
    const sentinel = 'ENVBLOCK_NO_PROCESS_ENV_SENTINEL_VALUE';
    const snapshot = makeSnapshot({
      allowed_fields: { ENVBLOCK_NO_PROCESS_ENV_SENTINEL: sentinel },
    });

    const block = buildEnvironmentContextBlock(snapshot, envBudgetPolicy(), {
      now: REFERENCE_NOW,
    }) as EnvironmentContextBlock;

    expect(block.fields.ENVBLOCK_NO_PROCESS_ENV_SENTINEL).toBe(sentinel);
    // process.env must NOT contain this sentinel at the time of the call —
    // proving the block did not pull from there.
    expect(process.env.ENVBLOCK_NO_PROCESS_ENV_SENTINEL).toBeUndefined();
  });

  it('placement is fixed to `system_dynamic` and the block carries no `authority` field at all', () => {
    const snapshot = makeSnapshot({ allowed_fields: { x: 1 } });
    const block = buildEnvironmentContextBlock(snapshot, envBudgetPolicy(), {
      now: REFERENCE_NOW,
    }) as EnvironmentContextBlock;

    expect(block.placement).toBe('system_dynamic');
    // No `authority` key, and certainly no `authority === 'system'`.
    expect((block as Record<string, unknown>).authority).toBeUndefined();
  });

  it('the protocol version field is present and non-empty', () => {
    const snapshot = makeSnapshot({ allowed_fields: { x: 1 } });
    const block = buildEnvironmentContextBlock(snapshot, envBudgetPolicy(), {
      now: REFERENCE_NOW,
    }) as EnvironmentContextBlock;

    expect(typeof block.environment_block_protocol_version).toBe('string');
    expect(block.environment_block_protocol_version.length).toBeGreaterThan(0);
  });

  it('block is frozen (immutable)', () => {
    const snapshot = makeSnapshot({ allowed_fields: { x: 1 } });
    const block = buildEnvironmentContextBlock(snapshot, envBudgetPolicy(), {
      now: REFERENCE_NOW,
    }) as EnvironmentContextBlock;

    expect(Object.isFrozen(block)).toBe(true);
    expect(Object.isFrozen(block.fields)).toBe(true);
    expect(Object.isFrozen(block.omitted_field_codes)).toBe(true);
  });
});

describe('buildEnvironmentContextBlock — freshness & budget overflow (CRC-3 §9.8)', () => {
  it('returns { unavailable, reason_code: environment.expired_no_refresh } when snapshot.expires_at is in the past', () => {
    const snapshot = makeSnapshot({ allowed_fields: { x: 1 } });
    // expires_at in the past + no refreshed snapshot id ⇒ unavailable.
    const result = buildEnvironmentContextBlock(snapshot, envBudgetPolicy(), {
      now: '2026-07-26T00:00:00.000Z',
      expires_at: REFERENCE_EXPIRED,
      refreshed_snapshot_id: null,
    });

    expect(result).toEqual({
      unavailable: true,
      reason_code: 'environment.expired_no_refresh',
    });
  });

  it('treats expires_at=null as never-expiring (builds the block; expires_at in block is null)', () => {
    const snapshot = makeSnapshot({ allowed_fields: { x: 1 } });
    const block = buildEnvironmentContextBlock(snapshot, envBudgetPolicy(), {
      now: REFERENCE_NOW,
      expires_at: null,
    }) as EnvironmentContextBlock;

    expect(block.expires_at).toBeNull();
  });

  it('records an explicit code in omitted_field_codes when a field exceeds the per-field budget', () => {
    const snapshot = makeSnapshot({
      allowed_fields: {
        // Small field kept.
        kept: 'a',
        // Enormous field that overflows the per-field byte cap.
        huge: 'X'.repeat(5000),
      },
    });
    // per_field_max_bytes caps any single field's serialized length.
    const policy = envBudgetPolicy();
    const block = buildEnvironmentContextBlock(snapshot, policy, {
      now: REFERENCE_NOW,
      per_field_max_bytes: 128,
    }) as EnvironmentContextBlock;

    expect(Object.keys(block.fields)).toEqual(['kept']);
    expect(block.omitted_field_codes).toContain('environment.field_over_budget.huge');
  });

  it('omitted_field_codes are sorted for determinism when multiple fields overflow', () => {
    const snapshot = makeSnapshot({
      allowed_fields: {
        zbig: 'Z'.repeat(5000),
        abig: 'A'.repeat(5000),
        kept: 'k',
      },
    });

    const block = buildEnvironmentContextBlock(snapshot, envBudgetPolicy(), {
      now: REFERENCE_NOW,
      per_field_max_bytes: 64,
    }) as EnvironmentContextBlock;

    expect(block.omitted_field_codes).toEqual([...block.omitted_field_codes].sort());
    expect(block.omitted_field_codes).toContain('environment.field_over_budget.abig');
    expect(block.omitted_field_codes).toContain('environment.field_over_budget.zbig');
  });

  it('content_hash is computed ONLY over the kept fields, so an omitted overflow field does not poison the hash', () => {
    const snapshotKeptOnly = makeSnapshot({ allowed_fields: { kept: 'k' } });
    const snapshotWithOverflow = makeSnapshot({
      allowed_fields: { kept: 'k', huge: 'X'.repeat(5000) },
    });

    const blockKeptOnly = buildEnvironmentContextBlock(snapshotKeptOnly, envBudgetPolicy(), {
      now: REFERENCE_NOW,
      per_field_max_bytes: 64,
    }) as EnvironmentContextBlock;
    const blockAfterOmit = buildEnvironmentContextBlock(snapshotWithOverflow, envBudgetPolicy(), {
      now: REFERENCE_NOW,
      per_field_max_bytes: 64,
    }) as EnvironmentContextBlock;

    expect(blockKeptOnly.content_hash).toBe(blockAfterOmit.content_hash);
    expect(blockAfterOmit.omitted_field_codes).toContain('environment.field_over_budget.huge');
  });
});
