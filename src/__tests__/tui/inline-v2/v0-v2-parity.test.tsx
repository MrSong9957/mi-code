// src/__tests__/tui/inline-v2/v0-v2-parity.test.tsx
//
// V0/V2 行为等价性对比测试。
//
// 物理本质:V0(InlineRenderer 手动渲染)和 V2(Ink reconciler + <Static>)
// 是两条不同的渲染路径,但它们共享同一个 <ConnectedApp> + useInputHandler + stores。
// 本测试验证:在相同输入下,V0 和 V2 的**行为**(回调触发、store 状态变化)等价。
//
// 不验证渲染输出本身(V0/V2 格式天然不同 — V0 拼 ANSI,V2 走 Ink reconciler)。
// 只验证行为契约:按下同一个键,V0 和 V2 都触发同一个回调 / 改同一个 store。
//
// 这为 Stage 5b(删除 V0)提供信心 — 如果 V0/V2 行为等价,删 V0 不会改变用户体验。

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ConnectedApp } from '../../../tui/ConnectedApp.js';
import { InlineRenderer } from '../../../tui/inline/InlineRenderer.js';
import { RenderModeProvider } from '../../../tui/state/render-mode.js';
import { createCompletionStore } from '../../../tui/state/completion-store.js';
import { createInputStore } from '../../../tui/state/input-store.js';
import { createLogoStore } from '../../../tui/state/logo-store.js';
import { createMessagesStore } from '../../../tui/state/messages-store.js';
import { createOverlayStore } from '../../../tui/state/overlay-store.js';
import { createSelectStore } from '../../../tui/state/select-store.js';
import { createSpinnerStore, EMPTY_SPINNER_CONTEXT } from '../../../tui/state/spinner-store.js';
import { createStatusStore } from '../../../tui/state/status-store.js';
import { createSelectionStore } from '../../../tui/state/selection-store.js';

function createMockStdout(): NodeJS.WriteStream {
  return {
    write: () => true,
    columns: 80,
    rows: 24,
    on: () => {}, off: () => {}, removeListener: () => {},
    isTTY: false,
  } as unknown as NodeJS.WriteStream;
}

interface Callbacks {
  onSubmit: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  onTab: ReturnType<typeof vi.fn>;
  onToggleOverlay: ReturnType<typeof vi.fn>;
  onAbortStream: ReturnType<typeof vi.fn>;
  onRewindLastTurn: ReturnType<typeof vi.fn>;
}

function makeCallbacks(): Callbacks {
  return {
    onSubmit: vi.fn(),
    onExit: vi.fn(),
    onTab: vi.fn(),
    onToggleOverlay: vi.fn(),
    onAbortStream: vi.fn(),
    onRewindLastTurn: vi.fn(),
  };
}

interface RenderOptions {
  withInlineRenderer: boolean;
  callbacks: Callbacks;
}

function renderConnected(opts: RenderOptions) {
  const stores = {
    messagesStore: createMessagesStore(),
    inputStore: createInputStore({ onSubmit: opts.callbacks.onSubmit }),
    statusStore: createStatusStore({ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main' }),
    logoStore: createLogoStore({ version: '1.0.0', dir: '/tmp' }),
    spinnerStore: createSpinnerStore(undefined, EMPTY_SPINNER_CONTEXT),
    completionStore: createCompletionStore(),
    selectStore: createSelectStore(),
    overlayStore: createOverlayStore(),
  };
  const inlineRenderer = opts.withInlineRenderer
    ? new InlineRenderer(createMockStdout())
    : undefined;

  const view = render(
    React.createElement(RenderModeProvider, { initialMode: 'inline' },
      React.createElement(ConnectedApp, {
        ...stores,
        onExit: opts.callbacks.onExit,
        onTab: opts.callbacks.onTab,
        onToggleOverlay: opts.callbacks.onToggleOverlay,
        onAbortStream: opts.callbacks.onAbortStream,
        onRewindLastTurn: opts.callbacks.onRewindLastTurn,
        inlineRenderer,
      }),
    ),
  );

  return { view, stores };
}

async function typeAndSubmit(view: ReturnType<typeof render>, text: string): Promise<void> {
  view.stdin.write(text);
  await new Promise((r) => setTimeout(r, 10));
  view.stdin.write('\r');
  await new Promise((r) => setTimeout(r, 10));
}

// ─── 测试:V0 和 V2 在相同输入下触发相同回调 ─────────────────────────────

describe('V0/V2 行为等价性', () => {
  it('输入 + 回车:V0 和 V2 都触发 onSubmit(相同文本)', async () => {
    for (const withInlineRenderer of [true, false]) {
      const label = withInlineRenderer ? 'V0' : 'V2';
      const callbacks = makeCallbacks();
      const { view } = renderConnected({ withInlineRenderer, callbacks });
      await typeAndSubmit(view, 'hello world');
      expect(callbacks.onSubmit, `${label}: onSubmit 应被调用`).toHaveBeenCalledTimes(1);
      expect(callbacks.onSubmit, `${label}: onSubmit 应收到 'hello world'`).toHaveBeenCalledWith('hello world');
      view.unmount();
    }
  });

  it('空输入 + 回车:V0 和 V2 都不触发 onSubmit', async () => {
    for (const withInlineRenderer of [true, false]) {
      const label = withInlineRenderer ? 'V0' : 'V2';
      const callbacks = makeCallbacks();
      const { view } = renderConnected({ withInlineRenderer, callbacks });
      view.stdin.write('\r');
      await new Promise((r) => setTimeout(r, 10));
      expect(callbacks.onSubmit, `${label}: 空输入不应触发 onSubmit`).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  it('Ctrl+C:V0 和 V2 都触发 onExit', async () => {
    for (const withInlineRenderer of [true, false]) {
      const label = withInlineRenderer ? 'V0' : 'V2';
      const callbacks = makeCallbacks();
      const { view } = renderConnected({ withInlineRenderer, callbacks });
      view.stdin.write('\u0003'); // Ctrl+C
      await new Promise((r) => setTimeout(r, 10));
      expect(callbacks.onExit, `${label}: Ctrl+C 应触发 onExit`).toHaveBeenCalledTimes(1);
      view.unmount();
    }
  });

  it('Ctrl+O:V0 和 V2 都触发 onToggleOverlay', async () => {
    for (const withInlineRenderer of [true, false]) {
      const label = withInlineRenderer ? 'V0' : 'V2';
      const callbacks = makeCallbacks();
      const { view } = renderConnected({ withInlineRenderer, callbacks });
      view.stdin.write('\u000f'); // Ctrl+O
      await new Promise((r) => setTimeout(r, 10));
      expect(callbacks.onToggleOverlay, `${label}: Ctrl+O 应触发 onToggleOverlay`).toHaveBeenCalledTimes(1);
      view.unmount();
    }
  });

  it('ESC(spinner active):V0 和 V2 都触发 onAbortStream', async () => {
    for (const withInlineRenderer of [true, false]) {
      const label = withInlineRenderer ? 'V0' : 'V2';
      const callbacks = makeCallbacks();
      const { view, stores } = renderConnected({ withInlineRenderer, callbacks });
      // 等 React + V0 InlineRenderer 完全 mount(V0 有更多初始化副作用)
      await new Promise((r) => setTimeout(r, 30));
      // 模拟流式运行中
      stores.spinnerStore.getState().start('responding');
      await new Promise((r) => setTimeout(r, 30));
      view.stdin.write('\u001b'); // ESC
      await new Promise((r) => setTimeout(r, 30));
      expect(callbacks.onAbortStream, `${label}: ESC 流式中应触发 onAbortStream`).toHaveBeenCalledTimes(1);
      view.unmount();
    }
  });

  it('ESC(spinner 未 active):V0 和 V2 都不触发 onAbortStream', async () => {
    for (const withInlineRenderer of [true, false]) {
      const label = withInlineRenderer ? 'V0' : 'V2';
      const callbacks = makeCallbacks();
      const { view } = renderConnected({ withInlineRenderer, callbacks });
      view.stdin.write('\u001b'); // ESC
      await new Promise((r) => setTimeout(r, 10));
      expect(callbacks.onAbortStream, `${label}: 无流式时 ESC 不应触发 onAbortStream`).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  it('双击 ESC(400ms 内):V0 和 V2 都触发 onRewindLastTurn', async () => {
    for (const withInlineRenderer of [true, false]) {
      const label = withInlineRenderer ? 'V0' : 'V2';
      const callbacks = makeCallbacks();
      const { view } = renderConnected({ withInlineRenderer, callbacks });
      await new Promise((r) => setTimeout(r, 30));
      view.stdin.write('\u001b');
      await new Promise((r) => setTimeout(r, 50));
      view.stdin.write('\u001b');
      await new Promise((r) => setTimeout(r, 30));
      expect(callbacks.onRewindLastTurn, `${label}: 双击 ESC 应触发 onRewindLastTurn`).toHaveBeenCalledTimes(1);
      view.unmount();
    }
  });

  it('Tab:V0 和 V2 都触发 onTab', async () => {
    for (const withInlineRenderer of [true, false]) {
      const label = withInlineRenderer ? 'V0' : 'V2';
      const callbacks = makeCallbacks();
      const { view } = renderConnected({ withInlineRenderer, callbacks });
      view.stdin.write('\t');
      await new Promise((r) => setTimeout(r, 10));
      expect(callbacks.onTab, `${label}: Tab 应触发 onTab`).toHaveBeenCalled();
      view.unmount();
    }
  });
});

// ─── 测试:V0 和 V2 的 store 行为等价 ─────────────────────────────────────

describe('V0/V2 store 行为等价性', () => {
  it('输入文本:V0 和 V2 的 inputStore.text 都正确更新', async () => {
    for (const withInlineRenderer of [true, false]) {
      const label = withInlineRenderer ? 'V0' : 'V2';
      const callbacks = makeCallbacks();
      const { view, stores } = renderConnected({ withInlineRenderer, callbacks });
      view.stdin.write('abc');
      await new Promise((r) => setTimeout(r, 10));
      expect(stores.inputStore.getState().text, `${label}: 输入后 text 应为 'abc'`).toBe('abc');
      expect(stores.inputStore.getState().cursor, `${label}: cursor 应为 3`).toBe(3);
      view.unmount();
    }
  });

  it('Backspace:V0 和 V2 都正确删除字符', async () => {
    for (const withInlineRenderer of [true, false]) {
      const label = withInlineRenderer ? 'V0' : 'V2';
      const callbacks = makeCallbacks();
      const { view, stores } = renderConnected({ withInlineRenderer, callbacks });
      view.stdin.write('hello');
      await new Promise((r) => setTimeout(r, 10));
      view.stdin.write('\u0008'); // Backspace
      await new Promise((r) => setTimeout(r, 10));
      expect(stores.inputStore.getState().text, `${label}: Backspace 后 text 应为 'hell'`).toBe('hell');
      view.unmount();
    }
  });

  it('Select 打开后按 ↑↓:V0 和 V2 的 selectStore.index 都变化', async () => {
    for (const withInlineRenderer of [true, false]) {
      const label = withInlineRenderer ? 'V0' : 'V2';
      const callbacks = makeCallbacks();
      const { view, stores } = renderConnected({ withInlineRenderer, callbacks });
      stores.selectStore.getState().open('Pick', [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
        { value: 'c', label: 'C' },
      ]);
      await new Promise((r) => setTimeout(r, 10));
      expect(stores.selectStore.getState().index, `${label}: 初始 index=0`).toBe(0);

      view.stdin.write('\u001b[B'); // ↓
      await new Promise((r) => setTimeout(r, 10));
      expect(stores.selectStore.getState().index, `${label}: ↓ 后 index=1`).toBe(1);

      view.stdin.write('\u001b[A'); // ↑
      await new Promise((r) => setTimeout(r, 10));
      expect(stores.selectStore.getState().index, `${label}: ↑ 后 index=0`).toBe(0);
      view.unmount();
    }
  });
});
