/**
 * Wave C Task 11 (CRC-5): Delegation Handoff Validation — 测试.
 *
 * 覆盖规格 §11.4:
 *   - child result 默认 untrusted (即使 completed outcome)
 *   - 无效 CompletionReport → result_content_ref 为 null/rejected
 *   - sanitizer failure → 正文不进入 parent context
 *   - DispatchReceipt 不能构造 handoff completion
 *   - warning prefix 不能提升 trust
 */

import { describe, it, expect } from 'vitest';
import {
  createDelegationHandoffEnvelope,
  HANDOFF_PROTOCOL_VERSION,
  type DelegationHandoffInput,
} from '../../permission/delegation.js';

function makeValidInput(overrides: Partial<DelegationHandoffInput> = {}): DelegationHandoffInput {
  return {
    delegation_id: 'del-1',
    child_session_id: 'sess-child-1',
    child_profile_snapshot_id: 'role-1',
    completion_report_ref: 'completion-1',
    result_content_ref: 'content-1',
    sanitization_result_ref: 'sanit-accepted-1',
    sanitization_accepted: true,
    verification_evidence_refs: ['ev-1'],
    warning_codes: [],
    completion_report_valid: true,
    ...overrides,
  };
}

describe('DelegationHandoffEnvelope — child result 默认 untrusted', () => {
  it('keeps a completed child result untrusted', () => {
    const handoff = createDelegationHandoffEnvelope(makeValidInput());
    expect(handoff.result_trust).toBe('untrusted');
    expect(handoff.completion_report_ref).toBe('completion-1');
    expect(handoff.handoff_protocol_version).toBe(HANDOFF_PROTOCOL_VERSION);
  });

  it('result_trust is never trusted (only untrusted or unknown)', () => {
    // 即使所有证据齐全, 仍是 untrusted (规格 §11.4 rule 1)
    const handoff = createDelegationHandoffEnvelope(
      makeValidInput({
        verification_evidence_refs: ['ev-1', 'ev-2', 'ev-3'],
        warning_codes: [],
        completion_report_valid: true,
        sanitization_accepted: true,
      }),
    );
    expect(handoff.result_trust).not.toBe('trusted');
    expect(['untrusted', 'unknown']).toContain(handoff.result_trust);
  });
});

describe('DelegationHandoffEnvelope — 无效 CompletionReport', () => {
  it('sets result_content_ref to null when completion_report_valid is false', () => {
    const handoff = createDelegationHandoffEnvelope(
      makeValidInput({ completion_report_valid: false }),
    );
    expect(handoff.result_content_ref).toBeNull();
    expect(handoff.result_trust).toBe('untrusted');
  });

  it('sets result_content_ref to null when sanitization rejected', () => {
    const handoff = createDelegationHandoffEnvelope(
      makeValidInput({ sanitization_accepted: false }),
    );
    expect(handoff.result_content_ref).toBeNull();
    expect(handoff.result_trust).toBe('untrusted');
  });

  it('includes warning_codes in output (does not promote trust)', () => {
    const handoff = createDelegationHandoffEnvelope(
      makeValidInput({ warning_codes: ['deprecated_pattern', 'missing_evidence'] }),
    );
    expect(handoff.warning_codes).toEqual(['deprecated_pattern', 'missing_evidence']);
    expect(handoff.result_trust).toBe('untrusted'); // warnings 不提升 trust
  });
});

describe('DelegationHandoffEnvelope — 不变量', () => {
  it('is frozen (immutable)', () => {
    const handoff = createDelegationHandoffEnvelope(makeValidInput());
    expect(Object.isFrozen(handoff)).toBe(true);
    expect(Object.isFrozen(handoff.provenance_refs)).toBe(true);
    expect(Object.isFrozen(handoff.warning_codes)).toBe(true);
    expect(Object.isFrozen(handoff.verification_evidence_refs)).toBe(true);
  });

  it('produces deterministic envelope_id for same input', () => {
    const h1 = createDelegationHandoffEnvelope(makeValidInput());
    const h2 = createDelegationHandoffEnvelope(makeValidInput());
    expect(h1.handoff_envelope_id).toBe(h2.handoff_envelope_id);
    expect(h1.handoff_envelope_id).toMatch(/^handoff:[a-f0-9]{16}$/);
  });

  it('dispatch receipt (no completion_report_ref) cannot construct completion', () => {
    // 规格 §11.4 rule 6: background DispatchReceipt 不等于 handoff completion
    // 用空 completion_report_ref 表达 dispatch-only
    const handoff = createDelegationHandoffEnvelope(
      makeValidInput({
        completion_report_ref: '',
        completion_report_valid: false,
      }),
    );
    expect(handoff.completion_report_ref).toBe('');
    expect(handoff.result_content_ref).toBeNull();
  });
});
