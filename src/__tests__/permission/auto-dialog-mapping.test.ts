import { describe, expect, test } from 'vitest';
import { mapDialogResult } from '../../permission/permission-answer-mapping.js';
import type { AskQuestionOutcome } from '../../agent/ask-user-types.js';

function submitted(label: string, value?: string): AskQuestionOutcome {
  return value === undefined
    ? { kind: 'submitted', answers: { q0: label } }
    : { kind: 'submitted', answers: { q0: label }, answerValues: { q0: value } };
}

describe('mapDialogResult', () => {
  test.each([
    ['permission.allowOnce', { kind: 'approved_once' }],
    ['permission.allowExactSession', { kind: 'approved_session' }],
    ['permission.allowAlways', { kind: 'approved_always' }],
    ['permission.reject', { kind: 'rejected' }],
  ] as const)('maps stable value %s without consulting the display label', (value, expected) => {
    expect(mapDialogResult(submitted('任意翻译标签', value))).toEqual(expected);
  });

  test.each<AskQuestionOutcome>([
    submitted('Allow once'),
    submitted('允许一次', 'permission.unknown'),
    submitted('允许一次', ''),
    { kind: 'submitted', answers: {} },
    { kind: 'submitted', answers: {}, answerValues: { q0: 'permission.allowOnce' } },
    { kind: 'submitted', answers: { q0: '允许一次' }, answerValues: {} },
    { kind: 'chat', feedback: 'later' },
  ])('rejects missing, unknown, empty and chat outcomes', (outcome) => {
    expect(mapDialogResult(outcome)).toEqual({ kind: 'rejected' });
  });

  test('maps cancellation to escape', () => {
    expect(mapDialogResult({ kind: 'cancelled' })).toEqual({ kind: 'escape' });
  });
});
