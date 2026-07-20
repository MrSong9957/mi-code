// V0/V2 路径对比:spinner clock wiring。
// V0(inline + InlineRenderer)和 V2(inline 无 InlineRenderer,走 Ink reconciler)
// 都应该恰好有一个 spinner clock owner(useSpinnerClock)。
// Stage 5a 后 V2 已实装,本测试覆盖 V0 + V2 + alt-screen 三种模式。

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
import {
  createSpinnerStore,
  TICK_MS,
} from '../../tui/state/spinner-store.js';
import { createStatusStore } from '../../tui/state/status-store.js';

function createMockStdout(): NodeJS.WriteStream {
  return {
    write: () => true,
  } as unknown as NodeJS.WriteStream;
}

function renderConnected(mode: RenderMode, withInlineRenderer: boolean) {
  const spinnerStore = createSpinnerStore();
  spinnerStore.getState().start('responding');
  const tickSpy = vi.spyOn(spinnerStore.getState(), 'tick');
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
    ['V0 inline with renderer', 'inline', true],
    ['V2 inline (no renderer)', 'inline', false],
    ['alt-screen', 'alt-screen', false],
  ] as const)('%s has exactly one clock owner', (_, mode, withInlineRenderer) => {
    const { tickSpy, view } = renderConnected(mode, withInlineRenderer);

    vi.advanceTimersByTime(150);
    const callsBeforeUnmount = tickSpy.mock.calls.length;

    view.unmount();
    vi.advanceTimersByTime(150);
    const callsAfterUnmount = tickSpy.mock.calls.length;

    expect(callsBeforeUnmount).toBe(150 / TICK_MS);
    expect(callsAfterUnmount).toBe(callsBeforeUnmount);
  });
});
