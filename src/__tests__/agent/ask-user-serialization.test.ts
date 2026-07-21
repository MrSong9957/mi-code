import { describe, expect, it } from 'vitest';
import { serializeAskQuestionOutcome } from '../../agent/ask-user-serialization.js';
import { CHAT_FEEDBACK_FIXTURE } from '../fixtures/ask-user-chat-feedback.js';

describe('serializeAskQuestionOutcome', () => {
  it('serializes submitted answers in insertion order with JSON escaping', () => {
    expect(serializeAskQuestionOutcome({
      kind: 'submitted',
      answers: { Q1: 'A1', Q2: 'A2' },
    })).toBe('User has answered your questions: "Q1"="A1", "Q2"="A2". You can now continue with the user\'s answers in mind.');
    expect(serializeAskQuestionOutcome({
      kind: 'submitted',
      answers: { 'Q"1': 'A\n1' },
    })).toBe('User has answered your questions: "Q\\"1"="A\\n1". You can now continue with the user\'s answers in mind.');
  });

  it('serializes cancellation exactly', () => {
    expect(serializeAskQuestionOutcome({ kind: 'cancelled' }))
      .toBe('User declined to answer questions');
  });

  it('returns chat feedback unchanged', () => {
    expect(serializeAskQuestionOutcome({ kind: 'chat', feedback: CHAT_FEEDBACK_FIXTURE }))
      .toBe(CHAT_FEEDBACK_FIXTURE);
  });
});
