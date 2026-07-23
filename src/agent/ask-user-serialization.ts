import type { AskQuestionOutcome } from './ask-user-types.js';

export function serializeAskQuestionOutcome(outcome: AskQuestionOutcome): string {
  if (outcome.kind === 'cancelled') return 'User declined to answer questions';
  if (outcome.kind === 'chat') return outcome.feedback;

  const answers = Object.entries(outcome.answers)
    .map(([question, answer]) => `${JSON.stringify(question)}=${JSON.stringify(answer)}`)
    .join(', ');
  return `User has answered your questions: ${answers}. You can now continue with the user's answers in mind.`;
}
