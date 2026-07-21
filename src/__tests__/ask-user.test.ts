import { describe, expect, it, vi } from 'vitest';
import { AskUserManager } from '../agent/ask-user-manager.js';
import type {
  AskQuestionOutcome,
  AskQuestionOutcomeCallback,
  AskQuestionRequest,
} from '../agent/ask-user-types.js';
import { createAskUserTool } from '../agent/tools/ask-user-tool.js';

const request: AskQuestionRequest = {
  questions: [{
    question: 'Which cache?',
    header: 'Cache',
    options: [
      { label: 'Redis', description: 'Use Redis' },
      { label: 'Memory', description: 'Use process memory' },
    ],
    multiSelect: false,
  }],
};

function makeManager() {
  const ui = {
    open: vi.fn<(id: string, value: AskQuestionRequest, done: AskQuestionOutcomeCallback) => void>(),
    close: vi.fn<(id: string) => void>(),
  };
  return { manager: new AskUserManager(ui), ui };
}

function completeLatest(
  ui: ReturnType<typeof makeManager>['ui'],
  outcome: AskQuestionOutcome,
): void {
  const call = ui.open.mock.calls.at(-1)!;
  call[2](call[0], outcome);
}

describe('AskUserManager', () => {
  it('opens the UI and resolves the submitted outcome', async () => {
    const { manager, ui } = makeManager();

    const pending = manager.ask(request);
    const [requestId, openedRequest, done] = ui.open.mock.calls[0]!;

    expect(requestId).toEqual(expect.any(String));
    expect(openedRequest).toBe(request);
    done(requestId, { kind: 'submitted', answers: { 'Which cache?': 'Redis' } });
    await expect(pending).resolves.toEqual({
      kind: 'submitted',
      answers: { 'Which cache?': 'Redis' },
    });
  });

  it('cancels the previous request and ignores its stale callback', async () => {
    const { manager, ui } = makeManager();
    const first = manager.ask(request);
    const [firstId, , finishFirst] = ui.open.mock.calls[0]!;

    const secondRequest: AskQuestionRequest = {
      questions: [{ ...request.questions[0]!, question: 'Which database?' }],
    };
    const second = manager.ask(secondRequest);
    const [secondId, , finishSecond] = ui.open.mock.calls[1]!;

    await expect(first).resolves.toEqual({ kind: 'cancelled' });
    expect(ui.close).toHaveBeenCalledWith(firstId);

    let secondSettled = false;
    void second.then(() => { secondSettled = true; });
    finishFirst(firstId, { kind: 'submitted', answers: { 'Which cache?': 'Redis' } });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    finishSecond(secondId, { kind: 'cancelled' });
    await expect(second).resolves.toEqual({ kind: 'cancelled' });
  });
});

describe('createAskUserTool', () => {
  it('publishes only the nested questionnaire schema', () => {
    const { manager } = makeManager();
    const { definition } = createAskUserTool(manager);
    const properties = definition.parameters.properties!;
    const questionProperties = properties.questions!.items!.properties!;
    const optionProperties = questionProperties.options!.items!.properties!;

    expect(definition.name).toBe('ask_user_question');
    expect(definition.parameters.required).toEqual(['questions']);
    expect(properties).not.toHaveProperty('question');
    expect(questionProperties).toEqual(expect.objectContaining({
      question: expect.any(Object),
      header: expect.any(Object),
      options: expect.any(Object),
      multiSelect: expect.any(Object),
    }));
    expect(optionProperties).toEqual(expect.objectContaining({
      label: expect.any(Object),
      description: expect.any(Object),
    }));
    expect(definition).not.toHaveProperty('preview');
    expect(definition).not.toHaveProperty('annotations');
    expect(JSON.stringify(definition.parameters)).not.toContain('presentation');
  });

  it('ignores unknown fields and passes only validated input to the manager', async () => {
    const { manager, ui } = makeManager();
    const { executor } = createAskUserTool(manager);
    const input = {
      ...request,
      unknownRoot: true,
      questions: [{
        ...request.questions[0]!,
        unknownQuestion: 'ignored',
        options: request.questions[0]!.options.map((option) => ({ ...option, unknownOption: 1 })),
      }],
    };

    const result = executor(input);
    expect(ui.open.mock.calls[0]![1]).toEqual(request);
    completeLatest(ui, { kind: 'cancelled' });
    await expect(result).resolves.toBe('User declined to answer questions');
  });

  it('returns validator errors without opening the UI', async () => {
    const { manager, ui } = makeManager();
    const { executor } = createAskUserTool(manager);

    await expect(executor({})).resolves.toBe('Error: questions must be an array');
    expect(ui.open).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'submitted',
      outcome: { kind: 'submitted', answers: { 'Which cache?': 'Redis' } } as AskQuestionOutcome,
      expected: 'User has answered your questions: "Which cache?"="Redis". You can now continue with the user\'s answers in mind.',
    },
    {
      name: 'cancelled',
      outcome: { kind: 'cancelled' } as AskQuestionOutcome,
      expected: 'User declined to answer questions',
    },
    {
      name: 'chat',
      outcome: { kind: 'chat', feedback: 'Please clarify the tradeoff.' } as AskQuestionOutcome,
      expected: 'Please clarify the tradeoff.',
    },
  ])('serializes the $name outcome exactly', async ({ outcome, expected }) => {
    const { manager, ui } = makeManager();
    const { executor } = createAskUserTool(manager);

    const result = executor(request);
    completeLatest(ui, outcome);
    await expect(result).resolves.toBe(expected);
  });
});
