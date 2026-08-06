// §7.1 mapDialogResult pure-function unit tests. Depends ONLY on Task 2.
import { describe, test, expect } from 'vitest';
import {
  mapDialogResult,
  ALLOW_ALWAYS_LABEL,
  ALLOW_ONCE_LABEL,
  ALLOW_EXACT_LABEL,
} from '../../permission/permission-answer-mapping.js';
import type { AskQuestionOutcome } from '../../agent/ask-user-types.js';

describe('[auto-dialog] mapDialogResult unit', () => {
  test('submitted Allow once -> approved_once', () => {
    const o: AskQuestionOutcome = { kind: 'submitted', answers: { q: ALLOW_ONCE_LABEL } };
    expect(mapDialogResult(o)).toEqual({ kind: 'approved_once' });
  });
  test('submitted Allow session -> approved_session', () => {
    const o: AskQuestionOutcome = { kind: 'submitted', answers: { q: ALLOW_EXACT_LABEL } };
    expect(mapDialogResult(o)).toEqual({ kind: 'approved_session' });
  });
  test('submitted Always allow -> approved_always', () => {
    const o: AskQuestionOutcome = { kind: 'submitted', answers: { q: ALLOW_ALWAYS_LABEL } };
    expect(mapDialogResult(o)).toEqual({ kind: 'approved_always' });
  });
  test('submitted Reject -> rejected', () => {
    const o: AskQuestionOutcome = { kind: 'submitted', answers: { q: 'Reject' } };
    expect(mapDialogResult(o)).toEqual({ kind: 'rejected' });
  });
  test('submitted unknown/empty -> rejected', () => {
    expect(mapDialogResult({ kind: 'submitted', answers: {} })).toEqual({ kind: 'rejected' });
    expect(mapDialogResult({ kind: 'submitted', answers: { q: 'whatever' } })).toEqual({ kind: 'rejected' });
  });
  test('cancelled -> escape', () => {
    expect(mapDialogResult({ kind: 'cancelled' })).toEqual({ kind: 'escape' });
  });
  test('chat -> rejected', () => {
    expect(mapDialogResult({ kind: 'chat', feedback: 'later' })).toEqual({ kind: 'rejected' });
  });
});
