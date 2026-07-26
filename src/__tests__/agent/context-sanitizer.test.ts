import { describe, expect, it } from 'vitest';
import {
  sanitizeContextSource,
  extractTrustedStructure,
} from '../../agent/context/intake/sanitizer.js';
import {
  createContextSourceEnvelope,
  type ContextSourceEnvelope,
} from '../../agent/context/intake.js';

// ---------------------------------------------------------------------------
// M-040 Deterministic Context Sanitization (spec §9.4 / BRC-3).
//
// The sanitizer is the deterministic gate between raw context content and the
// rest of the agent. It MUST fail closed: any scanner/transform error rejects
// the source, and the result NEVER carries raw content or secret material.
// The sanitizer NEVER promotes trust — it does not mutate the envelope and the
// result has no `trust` field. Only the three-gate extractTrustedStructure
// path can mint a new TrustedStructuredContext, and it is the caller's policy
// (the gate) that decides that — not the envelope's existing trust label.
// ---------------------------------------------------------------------------

const envelope: ContextSourceEnvelope = createContextSourceEnvelope({
  context_protocol_version: '1',
  context_source_id: 'src-1',
  source_class: 'instruction_candidate',
  source_ref: 'file:///x.md',
  scope_ref: 'project',
  authority: 'user',
  trust: 'trusted',
  freshness: { observed_at: '2026-07-26T00:00:00.000Z', expires_at: null },
  requested_placement: null,
  retention: 'session',
  writer_kind: 'user',
  raw_content_ref: 'ref:1',
  provenance_refs: ['user:input'],
});

describe('sanitizeContextSource — deterministic sanitization (M-040)', () => {
  it('rejects on inspect failure without returning raw content', async () => {
    const result = await sanitizeContextSource(envelope, {
      policy_id: 'ingress-1',
      policy_version: '1',
      readContent: async () => 'token=secret-value',
      inspect: () => {
        throw new Error('scanner unavailable');
      },
    });
    expect(result).toMatchObject({
      context_source_id: 'src-1',
      sanitization_policy_id: 'ingress-1',
      sanitization_policy_version: '1',
      status: 'rejected',
      sanitized_content_ref: null,
      finding_codes: ['inspect.error'],
      transformation_codes: [],
    });
    // Critical: the raw content / secret MUST NOT leak into the result.
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(JSON.stringify(result)).not.toContain('token=');
  });

  it('rejects on readContent failure with read.failure finding and no leak', async () => {
    const result = await sanitizeContextSource(envelope, {
      policy_id: 'ingress-1',
      policy_version: '1',
      readContent: async () => {
        throw new Error('storage unavailable');
      },
      inspect: () => [],
    });
    expect(result).toMatchObject({
      status: 'rejected',
      sanitized_content_ref: null,
      transformation_codes: [],
    });
    expect(result.finding_codes).toContain('read.failure');
    // readContent threw — there is no content to leak, but the result still
    // MUST NOT contain the error message body, and it MUST NOT carry a raw
    // `content` value field (the only legitimate `*content*` field name is
    // `sanitized_content_ref`, which is null here).
    expect(JSON.stringify(result)).not.toContain('storage unavailable');
    expect(result).not.toHaveProperty('content');
    expect(result.sanitized_content_ref).toBeNull();
  });

  it('rejects when inspect returns findings, with finding_codes equal to findings', async () => {
    const result = await sanitizeContextSource(envelope, {
      policy_id: 'ingress-1',
      policy_version: '1',
      readContent: async () => 'token=secret-value',
      inspect: () => ['secret.api_key'],
    });
    expect(result).toMatchObject({
      status: 'rejected',
      sanitized_content_ref: null,
    });
    expect(result.finding_codes).toEqual(['secret.api_key']);
    expect(result.transformation_codes).toEqual([]);
  });

  it('accepts when no findings and no transform, sanitized_content_ref null', async () => {
    const result = await sanitizeContextSource(envelope, {
      policy_id: 'ingress-1',
      policy_version: '1',
      readContent: async () => 'harmless content',
      inspect: () => [],
    });
    expect(result).toMatchObject({
      context_source_id: 'src-1',
      sanitization_policy_id: 'ingress-1',
      sanitization_policy_version: '1',
      status: 'accepted',
      sanitized_content_ref: null,
      finding_codes: [],
    });
    expect(result.transformation_codes).toEqual([]);
  });

  it('transforms when no findings and transform provided, sanitized_content_ref null without store', async () => {
    const result = await sanitizeContextSource(envelope, {
      policy_id: 'ingress-1',
      policy_version: '1',
      readContent: async () => 'token=secret-value',
      inspect: () => [],
      transform: (content) => ({
        content: content.replace('secret-value', '[REDACTED]'),
        codes: ['redact.token'],
      }),
    });
    expect(result).toMatchObject({
      status: 'transformed',
      sanitized_content_ref: null,
    });
    expect(result.transformation_codes).toEqual(['redact.token']);
    expect(result.finding_codes).toEqual([]);
  });

  it('transforms and stores via store when provided, returning sanitized_content_ref', async () => {
    const result = await sanitizeContextSource(envelope, {
      policy_id: 'ingress-1',
      policy_version: '1',
      readContent: async () => 'token=secret-value',
      inspect: () => [],
      transform: (content) => ({
        content: content.replace('secret-value', '[REDACTED]'),
        codes: ['redact.token'],
      }),
      store: async () => 'stored-ref-1',
    });
    expect(result).toMatchObject({
      status: 'transformed',
      sanitized_content_ref: 'stored-ref-1',
    });
    expect(result.transformation_codes).toEqual(['redact.token']);
  });

  it('rejects with transform.error when transform throws', async () => {
    const result = await sanitizeContextSource(envelope, {
      policy_id: 'ingress-1',
      policy_version: '1',
      readContent: async () => 'harmless',
      inspect: () => [],
      transform: () => {
        throw new Error('redactor crashed');
      },
    });
    expect(result).toMatchObject({
      status: 'rejected',
      sanitized_content_ref: null,
    });
    expect(result.finding_codes).toEqual(['transform.error']);
  });

  it('never carries a trust field on the result', async () => {
    const result = await sanitizeContextSource(envelope, {
      policy_id: 'ingress-1',
      policy_version: '1',
      readContent: async () => 'ok',
      inspect: () => [],
    });
    expect(result).not.toHaveProperty('trust');
  });

  it('deep-freezes the result (arrays included)', async () => {
    const result = await sanitizeContextSource(envelope, {
      policy_id: 'ingress-1',
      policy_version: '1',
      readContent: async () => 'ok',
      inspect: () => ['secret.api_key'],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.finding_codes)).toBe(true);
    expect(Object.isFrozen(result.transformation_codes)).toBe(true);
  });

  it('does not mutate the source envelope', async () => {
    const snapshotBefore = JSON.stringify(envelope);
    await sanitizeContextSource(envelope, {
      policy_id: 'ingress-1',
      policy_version: '1',
      readContent: async () => 'ok',
      inspect: () => [],
      transform: (c) => ({ content: c.toUpperCase(), codes: ['redact.x'] }),
      store: async () => 'ref',
    });
    expect(JSON.stringify(envelope)).toBe(snapshotBefore);
    expect(envelope.trust).toBe('trusted');
  });

  it('throws on empty policy_id (requireIdentity)', async () => {
    await expect(
      sanitizeContextSource(envelope, {
        policy_id: '',
        policy_version: '1',
        readContent: async () => 'ok',
        inspect: () => [],
      }),
    ).rejects.toThrow(/policy_id/);
  });

  it('throws on empty policy_version (requireIdentity)', async () => {
    await expect(
      sanitizeContextSource(envelope, {
        policy_id: 'ingress-1',
        policy_version: '  ',
        readContent: async () => 'ok',
        inspect: () => [],
      }),
    ).rejects.toThrow(/policy_version/);
  });

  it('supports async inspect returning findings', async () => {
    const result = await sanitizeContextSource(envelope, {
      policy_id: 'ingress-1',
      policy_version: '1',
      readContent: async () => '../../etc/passwd',
      inspect: async () => ['path.escape'],
    });
    expect(result.status).toBe('rejected');
    expect(result.finding_codes).toEqual(['path.escape']);
  });
});

describe('extractTrustedStructure — three-gate trusted extraction (M-040)', () => {
  it('returns a TrustedStructuredContext when all three gates are true', () => {
    const trusted = extractTrustedStructure(
      envelope,
      {
        trusted_source_policy: true,
        schema_valid: true,
        deterministic_loader: true,
      },
      { hello: 'world' },
      'schema:user-profile:1',
    );
    expect(trusted).toMatchObject({
      context_source_id: 'src-1',
      trusted_extraction_policy_id: 'wave-a-frozen-three-gate',
      trusted: true,
      schema_id: 'schema:user-profile:1',
      data: { hello: 'world' },
    });
  });

  it('throws when trusted_source_policy is false, mentioning the gate', () => {
    expect(() =>
      extractTrustedStructure(
        envelope,
        {
          trusted_source_policy: false,
          schema_valid: true,
          deterministic_loader: true,
        },
        {},
        's:1',
      ),
    ).toThrow(/trusted_source_policy/);
  });

  it('throws when schema_valid is false, mentioning the gate', () => {
    expect(() =>
      extractTrustedStructure(
        envelope,
        {
          trusted_source_policy: true,
          schema_valid: false,
          deterministic_loader: true,
        },
        {},
        's:1',
      ),
    ).toThrow(/schema_valid/);
  });

  it('throws when deterministic_loader is false, mentioning the gate', () => {
    expect(() =>
      extractTrustedStructure(
        envelope,
        {
          trusted_source_policy: true,
          schema_valid: true,
          deterministic_loader: false,
        },
        {},
        's:1',
      ),
    ).toThrow(/deterministic_loader/);
  });

  it('deep-freezes the returned TrustedStructuredContext', () => {
    const trusted = extractTrustedStructure(
      envelope,
      {
        trusted_source_policy: true,
        schema_valid: true,
        deterministic_loader: true,
      },
      { a: ['x', 'y'] },
      's:1',
    );
    expect(Object.isFrozen(trusted)).toBe(true);
    expect(Object.isFrozen((trusted.data as { a: string[] }).a)).toBe(true);
  });

  it('does not mutate the source envelope (trust stays unchanged)', () => {
    const snapshotBefore = JSON.stringify(envelope);
    extractTrustedStructure(
      envelope,
      {
        trusted_source_policy: true,
        schema_valid: true,
        deterministic_loader: true,
      },
      { z: 1 },
      's:1',
    );
    expect(JSON.stringify(envelope)).toBe(snapshotBefore);
    expect(envelope.trust).toBe('trusted');
  });
});
