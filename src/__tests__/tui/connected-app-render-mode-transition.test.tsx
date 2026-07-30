import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { render } from 'ink-testing-library';
import { ConnectedApp } from '../../tui/ConnectedApp.js';
import {
  RenderModeProvider,
  useRenderMode,
  type RenderMode,
} from '../../tui/state/render-mode.js';
import { createCompletionStore } from '../../tui/state/completion-store.js';
import { createInputStore } from '../../tui/state/input-store.js';
import { createLogoStore } from '../../tui/state/logo-store.js';
import { createMessagesStore } from '../../tui/state/messages-store.js';
import { createOverlayStore } from '../../tui/state/overlay-store.js';
import { createAskQuestionStore } from '../../tui/state/ask-question-store.js';
import { createSelectStore } from '../../tui/state/select-store.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';
import { createStatusStore } from '../../tui/state/status-store.js';
import { createClearScreenStore } from '../../tui/state/clear-screen-store.js';

let switchMode: ((mode: RenderMode) => void) | undefined;

function ModeControl(): null {
  switchMode = useRenderMode().setMode;
  return null;
}

function TestTree(): React.ReactElement {
  return (
    <RenderModeProvider initialMode="inline">
      <ModeControl />
      <ConnectedApp
        messagesStore={createMessagesStore()}
        inputStore={createInputStore()}
        statusStore={createStatusStore({
          mode: 'chat',
          model: 'test',
          dir: '/tmp',
          branch: 'main',
        })}
        logoStore={createLogoStore({ version: '0.0.0', dir: '/tmp' })}
        spinnerStore={createSpinnerStore()}
        completionStore={createCompletionStore()}
        selectStore={createSelectStore()}
        overlayStore={createOverlayStore()}
        askQuestionStore={createAskQuestionStore()}
        clearScreenStore={createClearScreenStore()}
        onExit={() => {}}
      />
    </RenderModeProvider>
  );
}

describe('ConnectedApp render-mode transition', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // React 把 Hook 顺序违规作为 console.error 报告（不抛异常），
    // 这里捕获它以便断言“切换模式不改变 Hook 顺序”。
    errorSpy = vi.spyOn(console, 'error');
  });

  afterEach(() => {
    errorSpy.mockRestore();
    switchMode = undefined;
  });

  it('switches inline -> alt-screen -> inline without changing hook order', () => {
    const view = render(<TestTree />);
    expect(switchMode).toBeTypeOf('function');

    act(() => switchMode?.('alt-screen'));
    act(() => switchMode?.('inline'));

    const hookOrderErrors = errorSpy.mock.calls
      .map((args) => String(args[0] ?? ''))
      .filter((msg) => msg.includes('order of Hooks'));

    expect(hookOrderErrors).toHaveLength(0);

    view.unmount();
  });
});
