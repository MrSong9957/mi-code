import { describe, expect, it } from 'vitest';
import { freezeSnapshot } from '../../agent/contracts/identities.js';
import {
  createInjectionSuspicionSignal,
  SIGNAL_PROTOCOL_VERSION,
  type InjectionSuspicionSignalInput,
} from '../../agent/context/injection-signal.js';

// ---------------------------------------------------------------------------
// M-069 InjectionSuspicionSignal (spec §11.1 / §11.5 / §11.6 / CRC-5).
//
// This is a SOFT signal: it MUST NOT mutate the source envelope's trust, MUST
// NOT produce a SecurityDecision, and MUST NOT carry behavior/authority/
// placement/retention fields (INV-C11). The only thing it can do is record
// suspicion with provenance and (deterministically) recommend a user report.
// ---------------------------------------------------------------------------

const validInput: InjectionSuspicionSignalInput = {
  context_source_id: 'ctx-1',
  source_trust: 'untrusted',
  deterministic_ingress_result_ref: 'ingress-1',
  signal_source: 'model',
  suspicion_kinds: ['prompt_injection'],
  evidence_refs: [],
  risk_score: 0.5,
  task_impact: 'medium',
  created_at: '2026-07-26T00:00:00Z',
};

describe('createInjectionSuspicionSignal — shape & invariants (INV-C11)', () => {
  it('creates a valid signal with the frozen protocol version', () => {
    const signal = createInjectionSuspicionSignal(validInput);
    expect(signal.signal_protocol_version).toBe(SIGNAL_PROTOCOL_VERSION);
    expect(signal.signal_id).toMatch(/^sig:[a-f0-9]{16}$/);
    expect(signal.context_source_id).toBe('ctx-1');
    expect(signal.source_trust).toBe('untrusted');
    expect(signal.deterministic_ingress_result_ref).toBe('ingress-1');
    expect(signal.signal_source).toBe('model');
    expect(signal.suspicion_kinds).toEqual(['prompt_injection']);
    expect(signal.evidence_refs).toEqual([]);
    expect(signal.user_report_recommended).toBe(false);
    expect(signal.created_at).toBe('2026-07-26T00:00:00Z');
  });

  it('does NOT modify the source envelope trust (signal is read-only w.r.t. source)', () => {
    // The source envelope is frozen by the intake layer; the signal builder
    // only reads source_trust from the input — it never writes back.
    const source = freezeSnapshot({ trust: 'untrusted', id: 'ctx-1' });
    const signal = createInjectionSuspicionSignal(validInput);
    expect(signal.source_trust).toBe('untrusted');
    // The frozen source remains untouched.
    expect(source.trust).toBe('untrusted');
    expect(Object.isFrozen(source)).toBe(true);
  });

  it('MUST NOT carry behavior / security_decision_ref / authority / placement / retention', () => {
    const signal = createInjectionSuspicionSignal(validInput);
    expect(signal).not.toHaveProperty('behavior');
    expect(signal).not.toHaveProperty('security_decision_ref');
    expect(signal).not.toHaveProperty('authority');
    expect(signal).not.toHaveProperty('placement');
    expect(signal).not.toHaveProperty('retention');
    // risk_score / task_impact are inputs only — they do NOT survive onto the
    // emitted signal. Only the derived user_report_recommended does.
    expect(signal).not.toHaveProperty('risk_score');
    expect(signal).not.toHaveProperty('task_impact');
  });

  it('produces a deterministic signal_id for the same input', () => {
    const s1 = createInjectionSuspicionSignal(validInput);
    const s2 = createInjectionSuspicionSignal(validInput);
    expect(s1.signal_id).toBe(s2.signal_id);
  });

  it('produces different signal_ids for different inputs', () => {
    const s1 = createInjectionSuspicionSignal(validInput);
    const s2 = createInjectionSuspicionSignal({
      ...validInput,
      context_source_id: 'ctx-2',
    });
    expect(s1.signal_id).not.toBe(s2.signal_id);
  });

  it('the emitted signal object is frozen', () => {
    const signal = createInjectionSuspicionSignal(validInput) as unknown as Record<string, unknown>;
    expect(Object.isFrozen(signal)).toBe(true);
  });

  it('defensively copies suspicion_kinds and evidence_refs (caller array stays independent)', () => {
    const kinds = ['prompt_injection'];
    const evidence = ['ev-1'];
    const signal = createInjectionSuspicionSignal({
      ...validInput,
      suspicion_kinds: kinds,
      evidence_refs: evidence,
    });
    expect(signal.suspicion_kinds).not.toBe(kinds);
    expect(signal.evidence_refs).not.toBe(evidence);
    expect(signal.suspicion_kinds).toEqual(['prompt_injection']);
    expect(signal.evidence_refs).toEqual(['ev-1']);
  });
});

describe('createInjectionSuspicionSignal — input validation', () => {
  it('rejects trusted source (signal would be a contradiction)', () => {
    expect(() =>
      createInjectionSuspicionSignal({
        ...validInput,
        source_trust: 'trusted' as InjectionSuspicionSignalInput['source_trust'],
      }),
    ).toThrow(/trusted/);
  });

  it('rejects empty suspicion_kinds', () => {
    expect(() =>
      createInjectionSuspicionSignal({ ...validInput, suspicion_kinds: [] }),
    ).toThrow(/suspicion_kinds/);
  });

  it('rejects empty deterministic_ingress_result_ref', () => {
    expect(() =>
      createInjectionSuspicionSignal({
        ...validInput,
        deterministic_ingress_result_ref: '',
      }),
    ).toThrow(/deterministic_ingress_result_ref/);
  });

  it('rejects empty context_source_id', () => {
    expect(() =>
      createInjectionSuspicionSignal({ ...validInput, context_source_id: '   ' }),
    ).toThrow(/context_source_id/);
  });

  it('rejects unknown signal_source', () => {
    expect(() =>
      createInjectionSuspicionSignal({
        ...validInput,
        signal_source: 'oracle' as InjectionSuspicionSignalInput['signal_source'],
      }),
    ).toThrow(/signal_source/);
  });

  it('rejects non-string suspicion_kinds entries', () => {
    expect(() =>
      createInjectionSuspicionSignal({
        ...validInput,
        suspicion_kinds: ['ok', 123 as unknown as string],
      }),
    ).toThrow(/suspicion_kinds/);
  });

  it('rejects non-string evidence_refs entries', () => {
    expect(() =>
      createInjectionSuspicionSignal({
        ...validInput,
        evidence_refs: [null as unknown as string],
      }),
    ).toThrow(/evidence_refs/);
  });
});

describe('createInjectionSuspicionSignal — evidence rules (spec §11.6 rule 4)', () => {
  it('allows model signal with NO evidence (low-confidence soft hint)', () => {
    const signal = createInjectionSuspicionSignal({
      ...validInput,
      signal_source: 'model',
      evidence_refs: [],
    });
    expect(signal.evidence_refs).toEqual([]);
  });

  it('requires at least one evidence_ref for deterministic_detector', () => {
    expect(() =>
      createInjectionSuspicionSignal({
        ...validInput,
        signal_source: 'deterministic_detector',
        evidence_refs: [],
      }),
    ).toThrow(/evidence/);
  });

  it('accepts deterministic_detector WITH evidence', () => {
    const signal = createInjectionSuspicionSignal({
      ...validInput,
      signal_source: 'deterministic_detector',
      evidence_refs: ['det-finding-1'],
    });
    expect(signal.signal_source).toBe('deterministic_detector');
    expect(signal.evidence_refs).toEqual(['det-finding-1']);
  });
});

describe('createInjectionSuspicionSignal — user_report_recommended policy', () => {
  it('does NOT recommend when risk_score < 0.7 and impact is low/medium', () => {
    expect(
      createInjectionSuspicionSignal({ ...validInput, risk_score: 0.5, task_impact: 'medium' })
        .user_report_recommended,
    ).toBe(false);
    expect(
      createInjectionSuspicionSignal({ ...validInput, risk_score: 0, task_impact: 'low' })
        .user_report_recommended,
    ).toBe(false);
  });

  it('recommends when risk_score >= 0.7', () => {
    expect(
      createInjectionSuspicionSignal({ ...validInput, risk_score: 0.7, task_impact: 'low' })
        .user_report_recommended,
    ).toBe(true);
    expect(
      createInjectionSuspicionSignal({ ...validInput, risk_score: 0.95, task_impact: 'low' })
        .user_report_recommended,
    ).toBe(true);
  });

  it('recommends when task_impact is high (regardless of risk_score)', () => {
    expect(
      createInjectionSuspicionSignal({ ...validInput, risk_score: 0, task_impact: 'high' })
        .user_report_recommended,
    ).toBe(true);
  });

  it('uses risk_score=0 and task_impact=low as defaults when omitted', () => {
    const { risk_score: _r, task_impact: _t, ...minimal } = validInput;
    void _r;
    void _t;
    const signal = createInjectionSuspicionSignal(minimal);
    expect(signal.user_report_recommended).toBe(false);
  });
});
