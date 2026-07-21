import { describe, expect, it, vi } from 'vitest';
import type { AskQuestionRequest } from '../../agent/ask-user-types.js';
import { createAskQuestionStore } from '../../tui/state/ask-question-store.js';

const request: AskQuestionRequest = {
  questions: [
    {
      question: 'Q1', header: 'One', multiSelect: false,
      options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }],
    },
    {
      question: 'Q2', header: 'Two', multiSelect: true,
      options: [{ label: 'C', description: 'third' }, { label: 'D', description: 'fourth' }],
    },
  ],
};

function openStore(value = request) {
  const store = createAskQuestionStore();
  const onOutcome = vi.fn();
  store.getState().open('req-1', value, onOutcome);
  return { store, onOutcome };
}

function expectReset(store: ReturnType<typeof createAskQuestionStore>) {
  expect(store.getState()).toMatchObject({
    visible: false, requestId: null, request: null, pageIndex: 0, focusIndex: 0,
    inputMode: false, otherDraft: '', otherCursor: 0, selected: {}, others: {},
  });
}

describe('AskQuestionStore', () => {
  it('submits selected answers after moving through a two-question request', () => {
    const { store, onOutcome } = openStore();
    store.getState().activateFocused();
    store.getState().activateFocused();
    store.getState().moveFocusNext();
    store.getState().activateFocused();
    store.getState().nextPage();
    store.getState().activateFocused();

    expect(onOutcome).toHaveBeenCalledWith('req-1', {
      kind: 'submitted', answers: { Q1: 'A', Q2: 'C, D' },
    });
    expectReset(store);
  });

  it('advances a single-choice question directly to submit and submits it', () => {
    const single: AskQuestionRequest = { questions: [request.questions[0]!] };
    const { store, onOutcome } = openStore(single);
    store.getState().activateFocused();
    expect(store.getState()).toMatchObject({ pageIndex: 1, focusIndex: 0 });
    store.getState().activateFocused();
    expect(onOutcome).toHaveBeenCalledWith('req-1', { kind: 'submitted', answers: { Q1: 'A' } });
  });

  it('keeps multi-select questions open while toggling choices', () => {
    const multi: AskQuestionRequest = { questions: [request.questions[1]!] };
    const { store } = openStore(multi);
    store.getState().activateFocused();
    expect(store.getState()).toMatchObject({ pageIndex: 0, selected: { Q2: ['C'] } });
  });

  it('moves forward and backward through question and submit tabs', () => {
    const { store } = openStore();
    store.getState().nextPage();
    expect(store.getState()).toMatchObject({ pageIndex: 1, focusIndex: 0 });
    store.getState().nextPage();
    expect(store.getState()).toMatchObject({ pageIndex: 2, focusIndex: 0 });
    store.getState().previousPage();
    expect(store.getState()).toMatchObject({ pageIndex: 1, focusIndex: 0 });
    store.getState().previousPage();
    expect(store.getState()).toMatchObject({ pageIndex: 0, focusIndex: 0 });
  });

  it('allows submitting with unanswered questions and omits their answers', () => {
    const { store, onOutcome } = openStore();
    store.getState().nextPage();
    store.getState().nextPage();
    store.getState().submit();
    expect(onOutcome).toHaveBeenCalledWith('req-1', { kind: 'submitted', answers: {} });
  });

  it('cancels and resets every transient field', () => {
    const { store, onOutcome } = openStore();
    store.getState().activateFocused();
    store.getState().moveFocusNext();
    store.getState().moveFocusNext();
    store.getState().activateFocused();
    store.getState().insertOther('draft');
    store.getState().cancel();
    expect(onOutcome).toHaveBeenCalledWith('req-1', { kind: 'cancelled' });
    expectReset(store);
  });

  it('sends the Task 1 chat feedback fixture and resets', () => {
    const { store, onOutcome } = openStore();
    store.getState().chat();
    expect(onOutcome).toHaveBeenCalledWith('req-1', {
      kind: 'chat', feedback: `The user wants to clarify these questions.\nThis means they may have additional information, context or questions for you.\nTake their response into account and then reformulate the questions if appropriate.\nStart by asking them what they would like to clarify.\n\nQuestions asked:\n- "Q1"\n  (No answer provided)\n- "Q2"\n  (No answer provided)`,
    });
    expectReset(store);
  });

  it('ignores a close for a different request id and closes the matching request without outcome', () => {
    const { store, onOutcome } = openStore();
    store.getState().close('req-other');
    expect(store.getState().visible).toBe(true);
    store.getState().close('req-1');
    expect(onOutcome).not.toHaveBeenCalled();
    expectReset(store);
  });

  it('uses a non-empty Other answer in preference to selected options', () => {
    const { store, onOutcome } = openStore({
      questions: [{ ...request.questions[1]!, question: 'Languages?' }],
    });
    store.getState().activateFocused();
    store.getState().moveFocusNext();
    store.getState().moveFocusNext();
    store.getState().activateFocused();
    store.getState().insertOther('Rust');
    store.getState().moveOtherCursorLeft();
    store.getState().deleteOther();
    store.getState().insertOther('t');
    store.getState().submitOther();
    store.getState().submit();
    expect(onOutcome).toHaveBeenCalledWith('req-1', {
      kind: 'submitted', answers: { 'Languages?': 'Rust' },
    });
  });

  it('does not count blank Other answers and keeps custom otherLabel out of the outcome', () => {
    const { store, onOutcome } = openStore({
      questions: [{ ...request.questions[1]!, question: 'Languages?' }], otherLabel: 'Something else',
    });
    store.getState().moveFocusNext();
    store.getState().moveFocusNext();
    store.getState().activateFocused();
    store.getState().insertOther('  ');
    store.getState().submitOther();
    store.getState().submit();
    expect(onOutcome).toHaveBeenCalledWith('req-1', { kind: 'submitted', answers: {} });
  });

  it('wraps focus across question controls and submit controls', () => {
    const { store } = openStore();
    store.getState().moveFocusPrevious();
    expect(store.getState().focusIndex).toBe(3);
    store.getState().moveFocusNext();
    expect(store.getState().focusIndex).toBe(0);
    store.getState().nextPage();
    store.getState().nextPage();
    store.getState().moveFocusPrevious();
    expect(store.getState().focusIndex).toBe(1);
  });
});
