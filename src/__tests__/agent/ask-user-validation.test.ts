import { describe, expect, it } from 'vitest';
import { validateAskUserInput } from '../../agent/ask-user-validation.js';

const validQuestion = {
  question: 'Choose cache?',
  header: 'Cache',
  options: [
    { label: 'Redis', description: 'Shared cache' },
    { label: 'Memory', description: 'Process local' },
  ],
};

describe('validateAskUserInput', () => {
  it.each([
    ['one question with two options', { questions: [validQuestion] }, 1, 2],
    ['four questions with four options', {
      questions: Array.from({ length: 4 }, (_, index) => ({
        question: `Question ${index + 1}?`,
        header: `Header ${index + 1}`,
        options: Array.from({ length: 4 }, (_, optionIndex) => ({
          label: `Option ${optionIndex + 1}`,
          description: `Description ${optionIndex + 1}`,
        })),
        multiSelect: true,
      })),
    }, 4, 4],
  ])('accepts %s', (_name, input, questionCount, optionCount) => {
    const result = validateAskUserInput(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.questions).toHaveLength(questionCount);
      expect(result.value.questions[0]!.options).toHaveLength(optionCount);
    }
  });

  it('trims strings and defaults multiSelect to false without mutating input', () => {
    const input = {
      questions: [{
        question: '  Choose cache?  ',
        header: '  Cache  ',
        options: [
          { label: '  Redis  ', description: '  Shared cache  ' },
          { label: '  Memory  ', description: '  Process local  ' },
        ],
      }],
    };

    expect(validateAskUserInput(input)).toEqual({
      ok: true,
      value: {
        questions: [{
          question: 'Choose cache?',
          header: 'Cache',
          options: [
            { label: 'Redis', description: 'Shared cache' },
            { label: 'Memory', description: 'Process local' },
          ],
          multiSelect: false,
        }],
      },
    });
    expect(input.questions[0]!.question).toBe('  Choose cache?  ');
  });

  it('counts header length by Unicode code point', () => {
    expect(validateAskUserInput({
      questions: [{ ...validQuestion, header: '🧪'.repeat(12) }],
    }).ok).toBe(true);
    expect(validateAskUserInput({
      questions: [{ ...validQuestion, header: '🧪'.repeat(13) }],
    })).toEqual({ ok: false, error: 'questions[0].header must be at most 12 characters' });
  });

  it.each([
    ['input is not an object', null, 'input must be an object'],
    ['questions is missing', {}, 'questions must be an array'],
    ['questions is empty', { questions: [] }, 'questions must contain at least 1 question'],
    ['too many questions', { questions: Array.from({ length: 5 }, () => validQuestion) }, 'questions must contain at most 4 questions'],
    ['question is not an object', { questions: ['question'] }, 'questions[0] must be an object'],
    ['question text is missing', { questions: [{ ...validQuestion, question: undefined }] }, 'questions[0].question must be a string'],
    ['question text is blank', { questions: [{ ...validQuestion, question: '  ' }] }, 'questions[0].question must not be empty'],
    ['header is missing', { questions: [{ ...validQuestion, header: undefined }] }, 'questions[0].header must be a string'],
    ['header is blank', { questions: [{ ...validQuestion, header: '  ' }] }, 'questions[0].header must not be empty'],
    ['header is too long', { questions: [{ ...validQuestion, header: '1234567890123' }] }, 'questions[0].header must be at most 12 characters'],
    ['options is missing', { questions: [{ ...validQuestion, options: undefined }] }, 'questions[0].options must be an array'],
    ['too few options', { questions: [{ ...validQuestion, options: [validQuestion.options[0]] }] }, 'questions[0].options must contain at least 2 options'],
    ['too many options', { questions: [{ ...validQuestion, options: Array.from({ length: 5 }, () => validQuestion.options[0]) }] }, 'questions[0].options must contain at most 4 options'],
    ['option is not an object', { questions: [{ ...validQuestion, options: ['Redis', validQuestion.options[1]] }] }, 'questions[0].options[0] must be an object'],
    ['option label is missing', { questions: [{ ...validQuestion, options: [{ ...validQuestion.options[0], label: undefined }, validQuestion.options[1]] }] }, 'questions[0].options[0].label must be a string'],
    ['option label is blank', { questions: [{ ...validQuestion, options: [{ ...validQuestion.options[0], label: ' ' }, validQuestion.options[1]] }] }, 'questions[0].options[0].label must not be empty'],
    ['option description is missing', { questions: [{ ...validQuestion, options: [{ ...validQuestion.options[0], description: undefined }, validQuestion.options[1]] }] }, 'questions[0].options[0].description must be a string'],
    ['option description is blank', { questions: [{ ...validQuestion, options: [{ ...validQuestion.options[0], description: ' ' }, validQuestion.options[1]] }] }, 'questions[0].options[0].description must not be empty'],
    ['multiSelect is not boolean', { questions: [{ ...validQuestion, multiSelect: 'yes' }] }, 'questions[0].multiSelect must be a boolean'],
    ['questions duplicate after trimming', { questions: [validQuestion, { ...validQuestion, question: ' Choose cache? ', header: 'Other' }] }, 'questions[1].question must be unique'],
    ['option labels duplicate after trimming', { questions: [{ ...validQuestion, options: [{ ...validQuestion.options[0] }, { ...validQuestion.options[1], label: ' Redis ' }] }] }, 'questions[0].options[1].label must be unique'],
  ])('rejects when %s', (_name, input, error) => {
    expect(validateAskUserInput(input as Record<string, unknown>)).toEqual({ ok: false, error });
  });
});
