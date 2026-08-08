import { describe, expect, it } from 'vitest';
import { buildAskBlock } from '../../ui/ask-user-presentation.js';
import type {
  AskQuestionOutcome,
  StructuredAskResult,
} from '../../agent/ask-user-types.js';
import { createLanguageStore } from '../../locale/language-store.js';
import { createTranslator } from '../../locale/translator.js';

const translator = createTranslator(createLanguageStore('en-US'));

function askResult(outcome: AskQuestionOutcome): StructuredAskResult {
  return {
    version: 1,
    request: {
      questions: [{
        header: 'Auth',
        question: 'Which auth?',
        options: [
          { label: 'OAuth', description: 'OAuth' },
          { label: 'Key', description: 'API key' },
        ],
        multiSelect: false,
      }],
    },
    outcome,
  };
}

describe('buildAskBlock', () => {
  it('maps submitted answers to a typed AskBlock', () => {
    expect(buildAskBlock('q1', askResult({
      kind: 'submitted',
      answers: { 'Which auth?': 'OAuth' },
    }), translator)).toEqual({
      id: 'q1',
      kind: 'ask',
      summary: 'Answered 1 question',
      items: ['Auth → OAuth'],
      outcome: {
        kind: 'submitted',
        answers: { 'Which auth?': 'OAuth' },
      },
    });
  });

  it('preserves cancelled presentation semantics', () => {
    expect(buildAskBlock('q2', askResult({ kind: 'cancelled' }), translator)).toMatchObject({
      id: 'q2',
      kind: 'ask',
      summary: 'Declined to answer',
      items: ['User declined to answer questions'],
    });
  });

  it('preserves feedback/chat presentation semantics', () => {
    expect(buildAskBlock('q3', askResult({
      kind: 'chat',
      feedback: 'Use the simpler path',
    }), translator)).toMatchObject({
      id: 'q3',
      kind: 'ask',
      summary: 'Feedback: Use the simpler path',
      items: ['Use the simpler path'],
    });
  });

  it('returns null for unsupported or malformed input', () => {
    expect(buildAskBlock('q4', { version: 2 }, translator)).toBeNull();
    expect(buildAskBlock('q5', { version: 1 }, translator)).toBeNull();
    expect(buildAskBlock('q6', null, translator)).toBeNull();
  });
});
