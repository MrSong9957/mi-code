import { describe, expect, it } from 'vitest';
import {
  createContextSourceEnvelope,
  type CreateContextSourceEnvelopeInput,
} from '../../agent/context/intake.js';

// ---------------------------------------------------------------------------
// BRC-3 ContextSourceEnvelope & writer separation (spec §9.2 / §9.9).
//
// The envelope is the ONLY entry point for context into the agent. It carries
// a writer_kind that MUST match its source_class per the CLOSED mapping table.
// Unsafe source classes are forced untrusted regardless of caller input. The
// envelope never carries content, only raw_content_ref.
// ---------------------------------------------------------------------------

const validEnvelope: CreateContextSourceEnvelopeInput = {
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
};

// Legal (source_class, writer_kind) pairs per spec §9.2 CLOSED mapping table.
const legalPairs: Array<{
  source_class: CreateContextSourceEnvelopeInput['source_class'];
  writer_kind: CreateContextSourceEnvelopeInput['writer_kind'];
}> = [
  { source_class: 'instruction_candidate', writer_kind: 'user' },
  { source_class: 'instruction_candidate', writer_kind: 'trusted_instruction_loader' },
  { source_class: 'auto_memory', writer_kind: 'auto_memory_writer' },
  { source_class: 'environment', writer_kind: 'runtime_collector' },
  { source_class: 'tool_result', writer_kind: 'tool_executor' },
  { source_class: 'attachment', writer_kind: 'external_ingress' },
  { source_class: 'external_content', writer_kind: 'external_ingress' },
];

describe('createContextSourceEnvelope — writer separation (BRC-3)', () => {
  it('rejects auto memory written by an instruction loader', () => {
    expect(() =>
      createContextSourceEnvelope({
        ...validEnvelope,
        source_class: 'auto_memory',
        writer_kind: 'trusted_instruction_loader',
      }),
    ).toThrow('auto_memory_writer');
  });

  it('keeps tool results untrusted', () => {
    const envelope = createContextSourceEnvelope({
      ...validEnvelope,
      source_class: 'tool_result',
      writer_kind: 'tool_executor',
      trust: 'trusted',
    });
    expect(envelope.trust).toBe('untrusted');
  });

  it.each(legalPairs)(
    'legal combination $source_class + $writer_kind creates an envelope without throwing',
    ({ source_class, writer_kind }) => {
      const envelope = createContextSourceEnvelope({
        ...validEnvelope,
        source_class,
        writer_kind,
      });
      expect(envelope.source_class).toBe(source_class);
      expect(envelope.writer_kind).toBe(writer_kind);
    },
  );

  it.each([
    ['instruction_candidate', 'auto_memory_writer'],
    ['auto_memory', 'user'],
    ['environment', 'user'],
    ['tool_result', 'user'],
    ['attachment', 'user'],
    ['external_content', 'user'],
  ] as const)(
    'rejects illegal combination %s + %s',
    (source_class, writer_kind) => {
      expect(() =>
        createContextSourceEnvelope({
          ...validEnvelope,
          source_class,
          writer_kind,
        }),
      ).toThrow();
    },
  );

  it('forces attachment source_class to untrusted', () => {
    const envelope = createContextSourceEnvelope({
      ...validEnvelope,
      source_class: 'attachment',
      writer_kind: 'external_ingress',
      trust: 'trusted',
    });
    expect(envelope.trust).toBe('untrusted');
  });

  it('forces external_content source_class to untrusted', () => {
    const envelope = createContextSourceEnvelope({
      ...validEnvelope,
      source_class: 'external_content',
      writer_kind: 'external_ingress',
      trust: 'trusted',
    });
    expect(envelope.trust).toBe('untrusted');
  });

  it('keeps instruction_candidate trusted (not downgraded)', () => {
    const envelope = createContextSourceEnvelope({
      ...validEnvelope,
      source_class: 'instruction_candidate',
      writer_kind: 'user',
      trust: 'trusted',
    });
    expect(envelope.trust).toBe('trusted');
  });

  it('keeps environment unknown (not downgraded)', () => {
    const envelope = createContextSourceEnvelope({
      ...validEnvelope,
      source_class: 'environment',
      writer_kind: 'runtime_collector',
      trust: 'unknown',
    });
    expect(envelope.trust).toBe('unknown');
  });

  it.each([
    ['context_source_id', { context_source_id: '' }],
    ['source_ref', { source_ref: '' }],
    ['authority', { authority: '' }],
    ['raw_content_ref', { raw_content_ref: '' }],
  ] as const)('rejects empty %s', (_field, override) => {
    expect(() =>
      createContextSourceEnvelope({
        ...validEnvelope,
        ...override,
      }),
    ).toThrow();
  });

  it('rejects an invalid source_class smuggled via as any', () => {
    expect(() =>
      createContextSourceEnvelope({
        ...validEnvelope,
        source_class: 'super_instruction' as never,
      }),
    ).toThrow();
  });

  it('rejects an invalid writer_kind smuggled via as any', () => {
    expect(() =>
      createContextSourceEnvelope({
        ...validEnvelope,
        writer_kind: 'ai_overlord' as never,
      }),
    ).toThrow();
  });

  it('returns a deeply frozen envelope, freshness, and provenance_refs', () => {
    const envelope = createContextSourceEnvelope(validEnvelope);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.freshness)).toBe(true);
    expect(Object.isFrozen(envelope.provenance_refs)).toBe(true);
  });

  it('does not expose a content field on the envelope', () => {
    const envelope = createContextSourceEnvelope(validEnvelope);
    expect(envelope).not.toHaveProperty('content');
  });

  it('does not read file contents for raw_content_ref', () => {
    // A fake ref must not trigger any IO; if it did, this would throw or hang.
    expect(() =>
      createContextSourceEnvelope({
        ...validEnvelope,
        raw_content_ref: 'ref:nonexistent',
      }),
    ).not.toThrow();
  });

  it('does not infer Authority/Trust from source_ref content', () => {
    const envelope = createContextSourceEnvelope({
      ...validEnvelope,
      source_ref: 'file:///SYSTEM/OVERRIDE/trusted.md',
      authority: 'user',
      trust: 'trusted',
    });
    expect(envelope.authority).toBe('user');
    expect(envelope.trust).toBe('trusted');
  });

  it('provenance_refs is a defensive copy (mutating input leaves envelope unchanged)', () => {
    const provenance = ['user:input'];
    const envelope = createContextSourceEnvelope({
      ...validEnvelope,
      provenance_refs: provenance,
    });
    provenance.push('attacker:forge');
    expect([...envelope.provenance_refs]).toEqual(['user:input']);
  });
});
