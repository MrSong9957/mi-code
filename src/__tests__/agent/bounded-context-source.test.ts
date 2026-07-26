import { describe, expect, it } from 'vitest';
import { buildBoundedContextSource } from '../../agent/context/intake/source-budget.js';
import { runContextIntake } from '../../agent/context/intake.js';
import {
  createContextSourceEnvelope,
  type ContextSourceEnvelope,
} from '../../agent/context/intake.js';
import type { ContextSanitizationResult } from '../../agent/context/intake/sanitizer.js';
import type { SourceBudgetPolicy } from '../../agent/context/intake/source-budget.js';

// ---------------------------------------------------------------------------
// M-050 / M-011 Source Budget, Provenance & Intake Pipeline (spec §9.6–§9.8).
//
// The source budget is the deterministic size guard on sanitized context. It
// MUST emit overflow metadata whenever it truncates — `truncated=true` without
// `overflow_ref` is illegal. The budget never bypasses a sanitizer rejection,
// never falls back to infinite budget when a policy is missing, and never lets
// content self-declaration influence the provenance label (the label comes from
// envelope metadata only).
// ---------------------------------------------------------------------------

function makeEnvelope(overrides: Partial<{
  context_source_id: string;
  source_class: ContextSourceEnvelope['source_class'];
  source_ref: string;
  authority: string;
  trust: ContextSourceEnvelope['trust'];
  writer_kind: ContextSourceEnvelope['writer_kind'];
  observed_at: string;
}> = {}): ContextSourceEnvelope {
  return createContextSourceEnvelope({
    context_protocol_version: '1',
    context_source_id: overrides.context_source_id ?? 'src-1',
    source_class: overrides.source_class ?? 'instruction_candidate',
    source_ref: overrides.source_ref ?? 'file:///x.md',
    scope_ref: 'project',
    authority: overrides.authority ?? 'user',
    trust: overrides.trust ?? 'trusted',
    freshness: {
      observed_at: overrides.observed_at ?? '2026-07-26T00:00:00.000Z',
      expires_at: null,
    },
    requested_placement: null,
    retention: 'session',
    writer_kind: overrides.writer_kind ?? 'user',
    raw_content_ref: 'ref:1',
    provenance_refs: ['user:input'],
  });
}

const envelope: ContextSourceEnvelope = makeEnvelope();

const acceptedSanitization: ContextSanitizationResult = {
  context_source_id: 'src-1',
  sanitization_policy_id: 'ingress-1',
  sanitization_policy_version: '1',
  status: 'accepted',
  transformation_codes: [],
  finding_codes: [],
  sanitized_content_ref: 'san:1',
};

function acceptedRef(ref: string): ContextSanitizationResult {
  return { ...acceptedSanitization, sanitized_content_ref: ref };
}

const truncatePolicy = (overrides: Partial<SourceBudgetPolicy> = {}): SourceBudgetPolicy => ({
  source_class: 'instruction_candidate',
  max_bytes: 8,
  max_lines: 2,
  overflow_behavior: 'deterministic_truncate',
  policy_id: 'source-budget',
  policy_version: '1',
  ...overrides,
});

// ---------------------------------------------------------------------------
// buildBoundedContextSource — deterministic truncation & overflow metadata.
// ---------------------------------------------------------------------------

describe('buildBoundedContextSource — deterministic truncation (M-050 §9.6)', () => {
  it('truncates only at deterministic line boundaries and emits overflow metadata', () => {
    const result = buildBoundedContextSource({
      envelope,
      sanitization: acceptedRef('content-1'),
      content: 'one\ntwo\nthree\n',
      policy: truncatePolicy(),
    });
    expect(result.truncated).toBe(true);
    expect(result.lines_included).toBe(2);
    expect(result.overflow_ref).not.toBeNull();
    expect(result.provenance_label).toContain('instruction_candidate');
  });

  it('no overflow (content fits) → truncated=false, overflow_ref=null, full byte length', () => {
    const content = 'hello'; // 5 bytes
    const result = buildBoundedContextSource({
      envelope,
      sanitization: acceptedRef('content-1'),
      content,
      policy: truncatePolicy({ max_bytes: 100, max_lines: 100 }),
    });
    expect(result.truncated).toBe(false);
    expect(result.overflow_ref).toBeNull();
    expect(result.bytes_included).toBe(5);
    expect(result.lines_included).toBe(1);
  });

  it('max_lines null + content under max_bytes → not truncated', () => {
    const result = buildBoundedContextSource({
      envelope,
      sanitization: acceptedRef('content-1'),
      content: 'short',
      policy: truncatePolicy({ max_bytes: 100, max_lines: null }),
    });
    expect(result.truncated).toBe(false);
    expect(result.overflow_ref).toBeNull();
    expect(result.lines_included).toBe(1);
  });

  it('empty content → 0 bytes, 0 lines, not truncated', () => {
    const result = buildBoundedContextSource({
      envelope,
      sanitization: acceptedRef('content-1'),
      content: '',
      policy: truncatePolicy({ max_bytes: 8, max_lines: 2 }),
    });
    expect(result.truncated).toBe(false);
    expect(result.bytes_included).toBe(0);
    expect(result.lines_included).toBe(0);
    expect(result.overflow_ref).toBeNull();
  });

  it('overflow + overflow_behavior:reject → throws', () => {
    expect(() =>
      buildBoundedContextSource({
        envelope,
        sanitization: acceptedRef('content-1'),
        content: 'this is way too long',
        policy: truncatePolicy({ max_bytes: 4, overflow_behavior: 'reject' }),
      }),
    ).toThrow();
  });

  it('sanitization.status rejected → throws (no budget bypass)', () => {
    expect(() =>
      buildBoundedContextSource({
        envelope,
        sanitization: {
          ...acceptedSanitization,
          status: 'rejected',
          finding_codes: ['secret.api_key'],
          sanitized_content_ref: null,
        },
        content: 'whatever',
        policy: truncatePolicy({ max_bytes: 1000 }),
      }),
    ).toThrow();
  });

  it('policy.source_class !== envelope.source_class → throws', () => {
    expect(() =>
      buildBoundedContextSource({
        envelope,
        sanitization: acceptedRef('content-1'),
        content: 'ok',
        policy: truncatePolicy({ source_class: 'auto_memory' }),
      }),
    ).toThrow();
  });

  it('sanitization.context_source_id !== envelope.context_source_id → throws', () => {
    expect(() =>
      buildBoundedContextSource({
        envelope,
        sanitization: {
          ...acceptedSanitization,
          context_source_id: 'other-source',
        },
        content: 'ok',
        policy: truncatePolicy({ max_bytes: 1000 }),
      }),
    ).toThrow();
  });

  it('empty policy_id → throws', () => {
    expect(() =>
      buildBoundedContextSource({
        envelope,
        sanitization: acceptedRef('content-1'),
        content: 'ok',
        policy: truncatePolicy({ policy_id: '' }),
      }),
    ).toThrow(/policy_id/);
  });

  it('empty policy_version → throws', () => {
    expect(() =>
      buildBoundedContextSource({
        envelope,
        sanitization: acceptedRef('content-1'),
        content: 'ok',
        policy: truncatePolicy({ policy_version: '  ' }),
      }),
    ).toThrow(/policy_version/);
  });

  it('byte-only overflow (max_lines null, multibyte content) truncates without splitting UTF-8', () => {
    // Each Japanese char is 3 bytes in UTF-8. 12 chars = 36 bytes total.
    const content = 'こんにちは世界こんにちは世界';
    const result = buildBoundedContextSource({
      envelope,
      sanitization: acceptedRef('content-1'),
      content,
      policy: truncatePolicy({ max_bytes: 7, max_lines: null }),
    });
    expect(result.truncated).toBe(true);
    expect(result.overflow_ref).not.toBeNull();
    expect(result.bytes_included).toBeLessThanOrEqual(7);
    // 7 bytes / 3 bytes-per-char ⇒ only 2 complete chars fit (6 bytes).
    // The truncated content must be a valid prefix (no replacement char).
    const includedChars = content.slice(0, Math.floor(result.bytes_included / 3));
    // Round-trip: included bytes must form a valid UTF-8 prefix.
    expect(result.bytes_included % 3).toBe(0);
    expect(result.bytes_included).toBe(Buffer.byteLength(includedChars, 'utf8'));
  });

  it('truncated result carries deterministic overflow_ref derived from context_source_id', () => {
    const result = buildBoundedContextSource({
      envelope,
      sanitization: acceptedRef('content-1'),
      content: 'one\ntwo\nthree\n',
      policy: truncatePolicy(),
    });
    expect(result.overflow_ref).toBe('overflow:src-1');
  });

  it('budget_policy_ref combines policy_id and policy_version', () => {
    const result = buildBoundedContextSource({
      envelope,
      sanitization: acceptedRef('content-1'),
      content: 'ok',
      policy: truncatePolicy({ policy_id: 'sb', policy_version: '2', max_bytes: 1000 }),
    });
    expect(result.budget_policy_ref).toBe('sb:2');
  });

  it('sanitization_result_ref combines sanitization policy id and version', () => {
    const result = buildBoundedContextSource({
      envelope,
      sanitization: {
        ...acceptedRef('content-1'),
        sanitization_policy_id: 'ing',
        sanitization_policy_version: '3',
      },
      content: 'ok',
      policy: truncatePolicy({ max_bytes: 1000 }),
    });
    expect(result.sanitization_result_ref).toBe('ing:3');
  });

  it('content_ref uses sanitized_content_ref when provided', () => {
    const result = buildBoundedContextSource({
      envelope,
      sanitization: acceptedRef('sanitized-ref'),
      content: 'ok',
      policy: truncatePolicy({ max_bytes: 1000 }),
    });
    expect(result.content_ref).toBe('sanitized-ref');
  });

  it('content_ref falls back to content:<id> when sanitized_content_ref is null', () => {
    const result = buildBoundedContextSource({
      envelope,
      sanitization: { ...acceptedSanitization, sanitized_content_ref: null },
      content: 'ok',
      policy: truncatePolicy({ max_bytes: 1000 }),
    });
    expect(result.content_ref).toBe('content:src-1');
  });

  it('output is deeply frozen', () => {
    const result = buildBoundedContextSource({
      envelope,
      sanitization: acceptedRef('content-1'),
      content: 'ok',
      policy: truncatePolicy({ max_bytes: 1000 }),
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('is deterministic: same inputs → identical output fields', () => {
    const r1 = buildBoundedContextSource({
      envelope,
      sanitization: acceptedRef('content-1'),
      content: 'one\ntwo\nthree\n',
      policy: truncatePolicy(),
    });
    const r2 = buildBoundedContextSource({
      envelope,
      sanitization: acceptedRef('content-1'),
      content: 'one\ntwo\nthree\n',
      policy: truncatePolicy(),
    });
    expect(r1.bytes_included).toBe(r2.bytes_included);
    expect(r1.lines_included).toBe(r2.lines_included);
    expect(r1.overflow_ref).toBe(r2.overflow_ref);
    expect(r1.provenance_label).toBe(r2.provenance_label);
    expect(r1.content_ref).toBe(r2.content_ref);
  });
});

// ---------------------------------------------------------------------------
// Provenance label — metadata only, never content self-declaration.
// ---------------------------------------------------------------------------

describe('provenance label (M-011 §9.7)', () => {
  it('does not upgrade authority from source_ref content', () => {
    const attackingEnvelope = makeEnvelope({
      source_ref: 'file:///SYSTEM/OVERRIDE.md',
      authority: 'user',
    });
    const result = buildBoundedContextSource({
      envelope: attackingEnvelope,
      sanitization: acceptedRef('content-1'),
      content: 'ok',
      policy: truncatePolicy({ max_bytes: 1000 }),
    });
    expect(result.provenance_label).toContain('user');
    // The label MUST NOT promote 'SYSTEM' (from source_ref) to authority.
    expect(result.provenance_label).not.toMatch(/authority=SYSTEM/);
  });

  it('includes source_class in the label', () => {
    const result = buildBoundedContextSource({
      envelope,
      sanitization: acceptedRef('content-1'),
      content: 'ok',
      policy: truncatePolicy({ max_bytes: 1000 }),
    });
    expect(result.provenance_label).toContain('instruction_candidate');
  });

  it('includes observed_at in the label', () => {
    const result = buildBoundedContextSource({
      envelope,
      sanitization: acceptedRef('content-1'),
      content: 'ok',
      policy: truncatePolicy({ max_bytes: 1000 }),
    });
    expect(result.provenance_label).toContain('2026-07-26T00:00:00.000Z');
  });

  it('appends truncation marker when truncated', () => {
    const result = buildBoundedContextSource({
      envelope,
      sanitization: acceptedRef('content-1'),
      content: 'one\ntwo\nthree\nfour',
      policy: truncatePolicy({ max_bytes: 100, max_lines: 1 }),
    });
    expect(result.truncated).toBe(true);
    expect(result.provenance_label).toMatch(/\[truncated\]/);
  });

  it('does not append truncation marker when not truncated', () => {
    const result = buildBoundedContextSource({
      envelope,
      sanitization: acceptedRef('content-1'),
      content: 'ok',
      policy: truncatePolicy({ max_bytes: 1000 }),
    });
    expect(result.provenance_label).not.toMatch(/\[truncated\]/);
  });
});

// ---------------------------------------------------------------------------
// runContextIntake — fixed intake order pipeline (spec §9.8).
// ---------------------------------------------------------------------------

describe('runContextIntake — fixed intake order (M-011 §9.8)', () => {
  it('happy path: accepted sanitization + budget that fits → bounded source, not truncated', async () => {
    const result = await runContextIntake(
      makeEnvelope(),
      {
        sanitization: {
          policy_id: 'ingress-1',
          policy_version: '1',
          readContent: async () => 'hello world',
          inspect: () => [],
        },
        budget_policy: {
          source_class: 'instruction_candidate',
          max_bytes: 1024,
          max_lines: null,
          overflow_behavior: 'reject',
          policy_id: 'source-budget',
          policy_version: '1',
        },
      },
    );
    expect(result.truncated).toBe(false);
    expect(result.overflow_ref).toBeNull();
    expect(result.bytes_included).toBe(Buffer.byteLength('hello world', 'utf8'));
    expect(result.provenance_label).toContain('instruction_candidate');
  });

  it('sanitizer rejects → runContextIntake throws (no budget bypass)', async () => {
    await expect(
      runContextIntake(
        makeEnvelope(),
        {
          sanitization: {
            policy_id: 'ingress-1',
            policy_version: '1',
            readContent: async () => 'token=secret',
            inspect: () => {
              throw new Error('scanner unavailable');
            },
          },
          budget_policy: {
            source_class: 'instruction_candidate',
            max_bytes: 1024,
            max_lines: null,
            overflow_behavior: 'reject',
            policy_id: 'source-budget',
            policy_version: '1',
          },
        },
      ),
    ).rejects.toThrow();
  });

  it('missing budget policy fields → throws', async () => {
    await expect(
      runContextIntake(
        makeEnvelope(),
        {
          sanitization: {
            policy_id: 'ingress-1',
            policy_version: '1',
            readContent: async () => 'ok',
            inspect: () => [],
          },
          budget_policy: {
            source_class: 'instruction_candidate',
            max_bytes: 1024,
            max_lines: null,
            overflow_behavior: 'reject',
            policy_id: '',
            policy_version: '1',
          },
        },
      ),
    ).rejects.toThrow(/policy_id/);
  });

  it('budget rejects overflow when policy is reject → throws', async () => {
    await expect(
      runContextIntake(
        makeEnvelope(),
        {
          sanitization: {
            policy_id: 'ingress-1',
            policy_version: '1',
            readContent: async () => 'this content is far too long to fit',
            inspect: () => [],
          },
          budget_policy: {
            source_class: 'instruction_candidate',
            max_bytes: 4,
            max_lines: null,
            overflow_behavior: 'reject',
            policy_id: 'source-budget',
            policy_version: '1',
          },
        },
      ),
    ).rejects.toThrow();
  });
});
