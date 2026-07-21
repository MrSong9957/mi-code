import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { AskQuestionOverlayV2 } from '../../../tui/inline-v2/AskQuestionOverlayV2.js';
import { displayWidth } from '../../../tui/inline/text-layout.js';
import { createAskQuestionStore } from '../../../tui/state/ask-question-store.js';

const request = {
  questions: [
    {
      header: 'One',
      question: 'Q1',
      options: [
        { label: 'A', description: 'first' },
        { label: 'B', description: 'second' },
      ],
      multiSelect: true,
    },
    {
      header: 'Two',
      question: 'Q2',
      options: [{ label: 'C', description: 'third' }],
      multiSelect: false,
    },
  ],
};

function openStore() {
  const store = createAskQuestionStore();
  store.getState().open('question-1', request, () => {});
  return store;
}

describe('<AskQuestionOverlayV2>', () => {
  it('renders the current question, options, and chat affordance', () => {
    const store = openStore();
    const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('One');
    expect(frame).toContain('Q1');
    expect(frame).toContain('A');
    expect(frame).toContain('first');
    expect(frame).toContain('Other');
    expect(frame).toContain('Chat about this');
  });

  it('renders completion tabs and a Submit tab', () => {
    const store = openStore();
    store.setState({ selected: { Q1: ['A'] } });
    const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('✓');
    expect(frame).toContain('○');
    expect(frame).toContain('Submit');
  });

  it('renders multi-select checkboxes', () => {
    const store = openStore();
    store.setState({ selected: { Q1: ['A'] } });
    const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('[x] A');
    expect(frame).toContain('[ ] B');
  });

  it('renders the custom Other label and input cursor state', () => {
    const store = openStore();
    store.setState({
      request: { ...request, otherLabel: '提出修改意见' },
      inputMode: true,
      otherDraft: 'because',
      otherCursor: 3,
    });
    const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('提出修改意见');
    expect(frame).toContain('bec|ause');
  });

  it('warns when the Submit page has unanswered questions', () => {
    const store = openStore();
    store.setState({ pageIndex: request.questions.length });
    const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);

    expect(lastFrame()).toContain('Answer all questions before submitting');
  });

  it('renders focused Submit answers and Cancel actions on the Submit page', async () => {
    const store = openStore();
    store.getState().nextPage();
    store.getState().nextPage();
    const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);

    expect(lastFrame()).toContain('> Submit answers');
    expect(lastFrame()).toContain('  Cancel');

    store.getState().moveFocusNext();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastFrame()).toContain('  Submit answers');
    expect(lastFrame()).toContain('> Cancel');
  });

  it('renders contextual help for Other input mode', () => {
    const store = openStore();
    store.setState({ inputMode: true });
    const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);

    expect(lastFrame()).toContain('Enter save Other');
  });

  it('keeps every rendered line within the terminal width', () => {
    const store = openStore();
    store.setState({ inputMode: true, otherDraft: 'a very long response that must be shortened', otherCursor: 10 });
    const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={32} />);

    for (const line of (lastFrame() ?? '').split('\n')) {
      expect(displayWidth(line)).toBeLessThanOrEqual(32);
    }
  });
});
