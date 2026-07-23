import type { AskQuestion, AskQuestionOption, AskQuestionRequest, ValidationResult } from './ask-user-types.js';

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const MAX_HEADER_LENGTH = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(error: string): ValidationResult {
  return { ok: false, error };
}

export function validateAskUserInput(input: Record<string, unknown>): ValidationResult {
  if (!isRecord(input)) return invalid('input must be an object');

  const rawQuestions = input.questions;
  if (!Array.isArray(rawQuestions)) return invalid('questions must be an array');
  if (rawQuestions.length < 1) return invalid('questions must contain at least 1 question');
  if (rawQuestions.length > MAX_QUESTIONS) return invalid(`questions must contain at most ${MAX_QUESTIONS} questions`);

  const questions: AskQuestion[] = [];
  const questionTexts = new Set<string>();

  for (let questionIndex = 0; questionIndex < rawQuestions.length; questionIndex += 1) {
    const rawQuestion = rawQuestions[questionIndex];
    const path = `questions[${questionIndex}]`;
    if (!isRecord(rawQuestion)) return invalid(`${path} must be an object`);

    if (typeof rawQuestion.question !== 'string') return invalid(`${path}.question must be a string`);
    const question = rawQuestion.question.trim();
    if (!question) return invalid(`${path}.question must not be empty`);
    if (questionTexts.has(question)) return invalid(`${path}.question must be unique`);
    questionTexts.add(question);

    if (typeof rawQuestion.header !== 'string') return invalid(`${path}.header must be a string`);
    const header = rawQuestion.header.trim();
    if (!header) return invalid(`${path}.header must not be empty`);
    if ([...header].length > MAX_HEADER_LENGTH) return invalid(`${path}.header must be at most ${MAX_HEADER_LENGTH} characters`);

    if (!Array.isArray(rawQuestion.options)) return invalid(`${path}.options must be an array`);
    if (rawQuestion.options.length < 2) return invalid(`${path}.options must contain at least 2 options`);
    if (rawQuestion.options.length > MAX_OPTIONS) return invalid(`${path}.options must contain at most ${MAX_OPTIONS} options`);

    const options: AskQuestionOption[] = [];
    const optionLabels = new Set<string>();
    for (let optionIndex = 0; optionIndex < rawQuestion.options.length; optionIndex += 1) {
      const rawOption = rawQuestion.options[optionIndex];
      const optionPath = `${path}.options[${optionIndex}]`;
      if (!isRecord(rawOption)) return invalid(`${optionPath} must be an object`);

      if (typeof rawOption.label !== 'string') return invalid(`${optionPath}.label must be a string`);
      const label = rawOption.label.trim();
      if (!label) return invalid(`${optionPath}.label must not be empty`);
      if (optionLabels.has(label)) return invalid(`${optionPath}.label must be unique`);
      optionLabels.add(label);

      if (typeof rawOption.description !== 'string') return invalid(`${optionPath}.description must be a string`);
      const description = rawOption.description.trim();
      if (!description) return invalid(`${optionPath}.description must not be empty`);
      options.push({ label, description });
    }

    if (rawQuestion.multiSelect !== undefined && typeof rawQuestion.multiSelect !== 'boolean') {
      return invalid(`${path}.multiSelect must be a boolean`);
    }
    questions.push({ question, header, options, multiSelect: rawQuestion.multiSelect ?? false });
  }

  const value: AskQuestionRequest = { questions };
  return { ok: true, value };
}
