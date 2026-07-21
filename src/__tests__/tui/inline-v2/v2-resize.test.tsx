// src/__tests__/tui/inline-v2/v2-resize.test.tsx
//
// V2 resize 处理单元测试。
//
// 物理本质:验证 cols 变化时 ConnectedApp 写清屏 ANSI + 重挂载 <InlineAppV2>。
// 由于 ink-testing-library 的 stdout columns 固定,无法直接模拟 resize,
// 这里用两个独立 harness 实例(不同初始 cols)+ 监听 stdout.write 验证清屏序列。
//
// 注意:这是逻辑测试,不验证真实终端视觉行为(那个仍需手工 / 真 PTY)。
// 这里验证的是:cols 变化 → useEffect 触发 → 写 \x1b[2J\x1b[3J\x1b[H → key 变化。

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ConnectedApp } from '../../../tui/ConnectedApp.js';
import { RenderModeProvider } from '../../../tui/state/render-mode.js';
import { ThemeStoreProvider } from '../../../tui/state/theme-context.js';
import { createThemeStore } from '../../../tui/state/theme-store.js';
import { createMessagesStore } from '../../../tui/state/messages-store.js';
import { createInputStore } from '../../../tui/state/input-store.js';
import { createStatusStore } from '../../../tui/state/status-store.js';
import { createLogoStore } from '../../../tui/state/logo-store.js';
import { createSpinnerStore } from '../../../tui/state/spinner-store.js';
import { createCompletionStore } from '../../../tui/state/completion-store.js';
import { createSelectStore } from '../../../tui/state/select-store.js';
import { createOverlayStore } from '../../../tui/state/overlay-store.js';
import { createAskQuestionStore } from '../../../tui/state/ask-question-store.js';
import { createClearScreenStore } from '../../../tui/state/clear-screen-store.js';
import { EMPTY_SPINNER_CONTEXT } from '../../../tui/state/spinner-store.js';
import { useTerminalSize } from '../../../tui/hooks/useTerminalSize.js';

// 模拟 useTerminalSize 返回可控的 cols
vi.mock('../../../tui/hooks/useTerminalSize.js', () => ({
  useTerminalSize: vi.fn(() => ({ cols: 80, rows: 24 })),
}));

const mockedUseTerminalSize = vi.mocked(useTerminalSize);

function makeStores() {
  return {
    messagesStore: createMessagesStore(),
    inputStore: createInputStore({ onSubmit: () => {} }),
    statusStore: createStatusStore({ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main' }),
    logoStore: createLogoStore({ version: '1.0.0', dir: '/tmp' }),
    spinnerStore: createSpinnerStore(undefined, EMPTY_SPINNER_CONTEXT),
    completionStore: createCompletionStore(),
    selectStore: createSelectStore(),
    overlayStore: createOverlayStore(),
    askQuestionStore: createAskQuestionStore(),
    clearScreenStore: createClearScreenStore(),
  };
}

describe('V2 resize 处理', () => {
  it('cols 变化时写清屏 + scrollback 清除序列', () => {
    // 收集所有 process.stdout.write 调用
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });

    try {
      const stores = makeStores();
      mockedUseTerminalSize.mockReturnValue({ cols: 80, rows: 24 });

      const { rerender } = render(
        React.createElement(RenderModeProvider, { initialMode: 'inline', children:
          React.createElement(ThemeStoreProvider, { store: createThemeStore('dark') },
            React.createElement(ConnectedApp, {
              ...stores,
              onExit: () => {},
              // V2 路径:不传 inlineRenderer
            }),
          ),
        }),
      );

      // 清空之前的写入(初始渲染的不算)
      writes.length = 0;

      // 模拟 resize:cols 80 → 120
      mockedUseTerminalSize.mockReturnValue({ cols: 120, rows: 24 });
      rerender(
        React.createElement(RenderModeProvider, { initialMode: 'inline', children:
          React.createElement(ThemeStoreProvider, { store: createThemeStore('dark') },
            React.createElement(ConnectedApp, {
              ...stores,
              onExit: () => {},
            }),
          ),
        }),
      );

      // 应该写了清屏序列:ESC[2J(清屏)+ ESC[3J(清 scrollback)+ ESC[H(光标归位)
      const allOutput = writes.join('');
      expect(allOutput).toContain('\x1b[2J');
      expect(allOutput).toContain('\x1b[3J');
      expect(allOutput).toContain('\x1b[H');
    } finally {
      spy.mockRestore();
    }
  });

  it('cols 不变时不写清屏序列', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });

    try {
      const stores = makeStores();
      mockedUseTerminalSize.mockReturnValue({ cols: 80, rows: 24 });

      const { rerender } = render(
        React.createElement(RenderModeProvider, { initialMode: 'inline', children:
          React.createElement(ThemeStoreProvider, { store: createThemeStore('dark') },
            React.createElement(ConnectedApp, {
              ...stores,
              onExit: () => {},
            }),
          ),
        }),
      );

      writes.length = 0;

      // 同尺寸 rerender(不变化)
      rerender(
        React.createElement(RenderModeProvider, { initialMode: 'inline', children:
          React.createElement(ThemeStoreProvider, { store: createThemeStore('dark') },
            React.createElement(ConnectedApp, {
              ...stores,
              onExit: () => {},
            }),
          ),
        }),
      );

      // 不应该写清屏序列
      const allOutput = writes.join('');
      expect(allOutput).not.toContain('\x1b[2J');
      expect(allOutput).not.toContain('\x1b[3J');
    } finally {
      spy.mockRestore();
    }
  });
});
