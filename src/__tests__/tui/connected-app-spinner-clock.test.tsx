// ConnectedApp spinner clock wiring:V2 inline 和 alt-screen 两种模式。
//
// V0(InlineRenderer 路径)已在 Stage 5b 删除。
// V2(inline 无 InlineRenderer,走 Ink reconciler)和 alt-screen 都应该恰好有
// 一个 spinner clock owner(useSpinnerClock)。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ConnectedApp } from '../../tui/ConnectedApp.js';
import { createCompletionStore } from '../../tui/state/completion-store.js';
import { createInputStore } from '../../tui/state/input-store.js';
import { createLogoStore } from '../../tui/state/logo-store.js';
import { createMessagesStore } from '../../tui/state/messages-store.js';
import { createOverlayStore } from '../../tui/state/overlay-store.js';
import { createAskQuestionStore } from '../../tui/state/ask-question-store.js';
import {
  RenderModeProvider,
  type RenderMode,
} from '../../tui/state/render-mode.js';
import { createSelectStore } from '../../tui/state/select-store.js';
import {
  createSpinnerStore,
  TICK_MS,
} from '../../tui/state/spinner-store.js';
import { createStatusStore } from '../../tui/state/status-store.js';
import { createClearScreenStore } from '../../tui/state/clear-screen-store.js';
import { LocaleProvider } from '../../locale/context.js';
import { createLanguageStore } from '../../locale/language-store.js';

const languageStore = createLanguageStore('en-US');

function renderConnected(mode: RenderMode) {
  const spinnerStore = createSpinnerStore();
  spinnerStore.getState().start('responding');
  const tickSpy = vi.spyOn(spinnerStore.getState(), 'tick');

  const view = render(
    <RenderModeProvider initialMode={mode}>
      <LocaleProvider store={languageStore}>
        <ConnectedApp
          messagesStore={createMessagesStore()}
          inputStore={createInputStore()}
          statusStore={createStatusStore({
            mode: 'chat', model: 'test', dir: '/tmp', branch: 'main',
          })}
          logoStore={createLogoStore({ version: '0.0.0', dir: '/tmp' })}
          spinnerStore={spinnerStore}
          completionStore={createCompletionStore()}
          selectStore={createSelectStore()}
          overlayStore={createOverlayStore()}
          askQuestionStore={createAskQuestionStore()}
          clearScreenStore={createClearScreenStore()}
          onExit={() => {}}
        />
      </LocaleProvider>
    </RenderModeProvider>,
  );

  return { tickSpy, view };
}

describe('ConnectedApp spinner clock wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['V2 inline', 'inline'],
    ['alt-screen', 'alt-screen'],
  ] as const)('%s has exactly one clock owner', (_, mode) => {
    const { tickSpy, view } = renderConnected(mode);

    vi.advanceTimersByTime(150);
    const callsBeforeUnmount = tickSpy.mock.calls.length;

    view.unmount();
    vi.advanceTimersByTime(150);
    const callsAfterUnmount = tickSpy.mock.calls.length;

    expect(callsBeforeUnmount).toBe(150 / TICK_MS);
    expect(callsAfterUnmount).toBe(callsBeforeUnmount);
  });
});
