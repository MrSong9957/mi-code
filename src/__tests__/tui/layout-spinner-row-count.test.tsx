import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { App } from '../../tui/App.js';
import { createCompletionStore } from '../../tui/state/completion-store.js';
import { createOverlayStore } from '../../tui/state/overlay-store.js';
import { createSelectionStore } from '../../tui/state/selection-store.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';
import { computeInputViewportLayout, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH } from '../../tui/state/input-viewport.js';
import { LocaleProvider } from '../../locale/context.js';
import { createLanguageStore } from '../../locale/language-store.js';

const languageStore = createLanguageStore('en-US');

describe('spinner layout reservation', () => {
  it('uses SpinnerView.rowCount to reserve every auxiliary row before the input', () => {
    const spinnerStore = createSpinnerStore();
    spinnerStore.getState().setContext({
      variant: 'normal', teammates: [],
      tasks: [{ id: '1', content: 'Ship', status: 'pending', owner: null, activeForm: null, blockedBy: [] }],
      spinnerTip: 'custom tip', hasUsedBtw: true,
      budgetText: null, nextTaskText: null,
    });
    spinnerStore.getState().start('responding');
    const rendered = render(
      <LocaleProvider store={languageStore}>
        <App
          messages={[]}
          status={{ mode: 'build', model: 'sonnet', dir: 'Projects/mi-code', branch: 'main', contextPct: 0.25 }}
          logo={{ version: '1.0.0', dir: '/tmp/proj' }}
          selectionStore={createSelectionStore()}
          spinnerStore={spinnerStore}
          completionStore={createCompletionStore()}
          overlayStore={createOverlayStore()}
          layout={computeInputViewportLayout('', 0, 80, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH)}
          scrollTop={0}
          flatLines={[]}
        />
      </LocaleProvider>,
    );
    const lines = (rendered.lastFrame() ?? '').split('\n');
    const inputRow = lines.findIndex(line => line.includes('❯'));

    expect(lines.map(stripAnsi).some(line => line.includes('[ ] Ship'))).toBe(true);
    expect(lines.map(stripAnsi).some(line => line.includes('custom tip'))).toBe(true);
    expect(inputRow).toBe(7); // 3 logo + 3 spinner rows + upper border
  });
});
