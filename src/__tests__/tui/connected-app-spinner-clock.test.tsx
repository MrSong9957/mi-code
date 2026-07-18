import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ConnectedApp } from '../../tui/ConnectedApp.js';
import { InlineRenderer } from '../../tui/inline/InlineRenderer.js';
import { createCompletionStore } from '../../tui/state/completion-store.js';
import { createInputStore } from '../../tui/state/input-store.js';
import { createLogoStore } from '../../tui/state/logo-store.js';
import { createMessagesStore } from '../../tui/state/messages-store.js';
import { createOverlayStore } from '../../tui/state/overlay-store.js';
import {
  RenderModeProvider,
  type RenderMode,
} from '../../tui/state/render-mode.js';
import { createSelectStore } from '../../tui/state/select-store.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';
import { createStatusStore } from '../../tui/state/status-store.js';

function createMockStdout(): NodeJS.WriteStream {
  return {
    write: () => true,
  } as unknown as NodeJS.WriteStream;
}

function renderConnected(mode: RenderMode, withInlineRenderer: boolean) {
  const spinnerStore = createSpinnerStore();
  spinnerStore.getState().start('responding');
  const inlineRenderer = withInlineRenderer
    ? new InlineRenderer(createMockStdout())
    : undefined;

  const view = render(
    <RenderModeProvider initialMode={mode}>
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
        onExit={() => {}}
        inlineRenderer={inlineRenderer}
      />
    </RenderModeProvider>,
  );

  return { spinnerStore, view };
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
    ['inline with renderer', 'inline', true],
    ['inline without renderer', 'inline', false],
    ['alt-screen', 'alt-screen', false],
  ] as const)('%s has exactly one clock owner', (_, mode, withInlineRenderer) => {
    const { spinnerStore, view } = renderConnected(mode, withInlineRenderer);

    vi.advanceTimersByTime(150);
    const elapsed = spinnerStore.getState().time;

    view.unmount();
    vi.advanceTimersByTime(150);

    expect(elapsed).toBe(150);
    expect(spinnerStore.getState().time).toBe(elapsed);
  });
});
