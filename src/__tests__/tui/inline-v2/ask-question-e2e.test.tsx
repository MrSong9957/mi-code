import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskQuestionRequest } from '../../../agent/ask-user-types.js';
import { resetPasteState } from '../../../tui/input/paste-handler.js';
import { createE2EHarness, KEYS, waitMs } from './helpers/e2e-harness.js';

const singleRequest: AskQuestionRequest = {
  questions: [{
    header: 'Runtime',
    question: 'Choose a runtime',
    multiSelect: false,
    options: [
      { label: 'Node.js', description: 'Use Node.js' },
      { label: 'Bun', description: 'Use Bun' },
    ],
  }],
};

const multiRequest: AskQuestionRequest = {
  questions: [
    {
      header: 'Runtime',
      question: 'Choose a runtime',
      multiSelect: false,
      options: [{ label: 'Node.js', description: 'Use Node.js' }],
    },
    {
      header: 'Checks',
      question: 'Choose checks',
      multiSelect: true,
      options: [{ label: 'Tests', description: 'Run tests' }],
    },
  ],
};

describe('V2 inline E2E - questionnaire user paths', () => {
  beforeEach(() => { resetPasteState(); });

  it('settles a single-choice question immediately and preserves the existing input draft byte-for-byte', async () => {
    const h = createE2EHarness();
    const draft = ' pre-existing\n草稿 😀 ';
    const onOutcome = vi.fn();
    try {
      h.stores.inputStore.getState().setText(draft);
      h.stores.askQuestionStore.getState().open('ask-1', singleRequest, onOutcome);
      await waitMs(20);

      expect(h.lastFrame() ?? '').toContain('Choose a runtime');
      h.stdin.write(KEYS.ENTER);
      await waitMs(20);

      expect(onOutcome).toHaveBeenCalledWith('ask-1', {
        kind: 'submitted', answers: { 'Choose a runtime': 'Node.js' },
      });
      expect(h.stores.askQuestionStore.getState().visible).toBe(false);
      expect(h.stores.inputStore.getState().text).toBe(draft);
    } finally {
      h.unmount();
    }
  });

  it('swallows bracketed paste while a questionnaire is visible outside Other mode', async () => {
    const h = createE2EHarness();
    const draft = 'draft stays byte-for-byte';
    try {
      h.stores.inputStore.getState().setText(draft);
      h.stores.askQuestionStore.getState().open('ask-paste-1', singleRequest, () => {});
      await waitMs(20);

      h.stdin.write('\x1b[200~alpha\nbeta\x1b[201~');
      await waitMs(20);

      expect(h.stores.inputStore.getState().text).toBe(draft);
      expect(h.stores.askQuestionStore.getState().otherDraft).toBe('');
    } finally {
      h.unmount();
    }
  });

  it('routes raw bracketed paste text into Other mode without changing the normal input draft', async () => {
    const h = createE2EHarness();
    const draft = 'draft stays byte-for-byte';
    const pasted = 'alpha\nbeta';
    try {
      h.stores.inputStore.getState().setText(draft);
      h.stores.askQuestionStore.getState().open('ask-paste-2', singleRequest, () => {});
      h.stores.askQuestionStore.getState().moveFocusNext();
      h.stores.askQuestionStore.getState().moveFocusNext();
      h.stores.askQuestionStore.getState().activateFocused();
      expect(h.stores.askQuestionStore.getState().inputMode).toBe(true);

      h.stdin.write(`\x1b[200~${pasted}\x1b[201~`);
      await waitMs(20);

      expect(h.stores.askQuestionStore.getState().otherDraft).toBe(pasted);
      expect(h.stores.inputStore.getState().text).toBe(draft);
    } finally {
      h.unmount();
    }
  });

  it('keeps the existing placeholder paste behavior after the questionnaire closes', async () => {
    const h = createE2EHarness();
    try {
      h.stores.askQuestionStore.getState().open('ask-paste-3', singleRequest, () => {});
      h.stores.askQuestionStore.getState().close('ask-paste-3');

      h.stdin.write('\x1b[200~alpha\nbeta\x1b[201~');
      await waitMs(20);

      expect(h.stores.inputStore.getState().text).toContain('[Pasted text #1');
      expect(h.stores.inputStore.getState().text).not.toContain('alpha\nbeta');
    } finally {
      h.unmount();
    }
  });

  it('moves through multiple questions to the Submit page and submits selected answers', async () => {
    const h = createE2EHarness();
    const onOutcome = vi.fn();
    try {
      h.stores.askQuestionStore.getState().open('ask-2', multiRequest, onOutcome);
      await waitMs(20);

      h.stdin.write(KEYS.ENTER);
      await waitMs(10);
      expect(h.lastFrame() ?? '').toContain('Choose checks');
      h.stdin.write(KEYS.ENTER);
      h.stdin.write(KEYS.TAB);
      await waitMs(20);
      // e2e harness 使用 en-US，Submit 页焦点项文案为 'Submit answers'
      expect(h.lastFrame() ?? '').toContain('❯ Submit answers');
      h.stdin.write(KEYS.ENTER);
      await waitMs(20);

      expect(onOutcome).toHaveBeenCalledWith('ask-2', {
        kind: 'submitted',
        answers: { 'Choose a runtime': 'Node.js', 'Choose checks': 'Tests' },
      });
    } finally {
      h.unmount();
    }
  });

  it('Esc cancels an open questionnaire', async () => {
    const h = createE2EHarness();
    const onOutcome = vi.fn();
    try {
      h.stores.askQuestionStore.getState().open('ask-3', singleRequest, onOutcome);
      await waitMs(20);
      h.stdin.write(KEYS.ESC);
      await waitMs(30);

      expect(onOutcome).toHaveBeenCalledWith('ask-3', { kind: 'cancelled' });
      expect(h.stores.askQuestionStore.getState().visible).toBe(false);
    } finally {
      h.unmount();
    }
  });

  it('settles with Chat feedback from the Chat control', async () => {
    const h = createE2EHarness();
    const onOutcome = vi.fn();
    try {
      h.stores.askQuestionStore.getState().open('ask-4', singleRequest, onOutcome);
      await waitMs(20);
      h.stdin.write(KEYS.DOWN_ARROW);
      h.stdin.write(KEYS.DOWN_ARROW);
      h.stdin.write(KEYS.DOWN_ARROW);
      h.stdin.write(KEYS.ENTER);
      await waitMs(20);

      expect(onOutcome).toHaveBeenCalledWith('ask-4', expect.objectContaining({
        kind: 'chat',
        feedback: expect.stringContaining('Choose a runtime'),
      }));
    } finally {
      h.unmount();
    }
  });

  it('replaces spinner and footer while visible, then restores both after settling', async () => {
    const h = createE2EHarness({ status: { model: 'FOOTER_MARKER' } });
    try {
      h.stores.inputStore.getState().setText('draft marker');
      h.stores.spinnerStore.getState().start('tool-use');
      h.stores.spinnerStore.getState().setLabel('SPINNER_MARKER');
      await waitMs(20);
      expect(h.lastFrame() ?? '').toContain('SPINNER_MARKER');
      expect(h.lastFrame() ?? '').toContain('FOOTER_MARKER');

      h.stores.askQuestionStore.getState().open('ask-5', singleRequest, () => {});
      await waitMs(20);
      const questionnaireFrame = h.lastFrame() ?? '';
      expect(questionnaireFrame).toContain('Choose a runtime');
      expect(questionnaireFrame).not.toContain('SPINNER_MARKER');
      expect(questionnaireFrame).not.toContain('FOOTER_MARKER');
      expect(questionnaireFrame).not.toContain('draft marker');

      h.stdin.write(KEYS.ESC);
      await waitMs(30);
      const restoredFrame = h.lastFrame() ?? '';
      expect(restoredFrame).toContain('SPINNER_MARKER');
      expect(restoredFrame).toContain('FOOTER_MARKER');
      expect(restoredFrame).toContain('draft marker');
      expect(h.stores.inputStore.getState().text).toBe('draft marker');
    } finally {
      h.unmount();
    }
  });
});
