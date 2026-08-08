import { describe, expect, it } from 'vitest';
import { mapPermissionAnswerToUserDecision } from '../../permission/permission-answer-mapping.js';
import { SECURITY_PROTOCOL_VERSION } from '../../permission/decisions.js';
import type { AskQuestionOutcome } from '../../agent/ask-user-types.js';

const decisionId = 'dec-1';

function submitted(label: string, value?: string): AskQuestionOutcome {
  return value === undefined
    ? { kind: 'submitted', answers: { q0: label } }
    : { kind: 'submitted', answers: { q0: label }, answerValues: { q0: value } };
}

describe('mapPermissionAnswerToUserDecision', () => {
  it.each([
    ['permission.allowOnce', false],
    ['permission.allowExactSession', true],
  ])('maps %s to approved_once without consulting the translated label', (value, remember) => {
    const decision = mapPermissionAnswerToUserDecision(
      decisionId,
      submitted('拒绝', value),
    );

    expect(decision).toMatchObject({ response: 'approved_once', remember });
  });

  it.each([
    ['permission.reject'],
    ['permission.allowAlways'],
    ['permission.unknown'],
    [''],
  ])('rejects unsupported direct-channel value %j even when the label says allow', (value) => {
    const decision = mapPermissionAnswerToUserDecision(
      decisionId,
      submitted('Allow once', value),
    );

    expect(decision.response).toBe('rejected');
  });

  it('rejects a label-only answer even when it matches the former English allow label', () => {
    const decision = mapPermissionAnswerToUserDecision(
      decisionId,
      submitted('Allow once'),
    );

    expect(decision.response).toBe('rejected');
  });

  it.each<AskQuestionOutcome>([
    { kind: 'submitted', answers: {} },
    { kind: 'submitted', answers: {}, answerValues: { q0: 'permission.allowOnce' } },
    { kind: 'submitted', answers: { q0: '允许一次' }, answerValues: {} },
    { kind: 'cancelled' },
    { kind: 'chat', feedback: 'discuss' },
  ])('rejects empty, missing-value, cancelled and chat outcomes', (outcome) => {
    expect(mapPermissionAnswerToUserDecision(decisionId, outcome).response).toBe('rejected');
  });

  it('preserves decision protocol metadata', () => {
    const decision = mapPermissionAnswerToUserDecision(
      decisionId,
      submitted('允许一次', 'permission.allowOnce'),
    );

    expect(decision.decision_id).toBe(decisionId);
    expect(decision.protocol_version).toBe(SECURITY_PROTOCOL_VERSION);
    expect(typeof decision.decided_at).toBe('string');
  });
});
