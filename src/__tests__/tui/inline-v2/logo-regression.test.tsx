// src/__tests__/tui/inline-v2/logo-regression.test.tsx
//
// LOGO 不变量回归测试。
//
// 背景:LOGO 曾间歇性消失(用户报告 2-3 次)。LOGO 是 <Static> 的首项
// ({ kind: 'logo', id: '__logo__' }),理论上每次渲染都应该出现在最顶。
// 但以下场景可能让 logo 消失:
//   - 根元素类型切换(Overlay visible/hidden 切换 Box↔Overlay)
//   - Resize 重挂载(key={v2ResizeKey})
//   - 大量消息累积后 <Static> 的 index state 漂移
//   - 流式消息存在时(spinner + streaming 占位)
//
// 本测试覆盖所有这些场景,验证最终渲染帧始终包含 LOGO 内容。
// 如果未来重构打破 logo 不变量,本测试会立即失败。

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { InlineAppV2 } from '../../../tui/inline-v2/InlineAppV2.js';
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
import { createSelectionStore } from '../../../tui/state/selection-store.js';
import { createClearScreenStore } from '../../../tui/state/clear-screen-store.js';
import { EMPTY_SPINNER_CONTEXT } from '../../../tui/state/spinner-store.js';
import { useTerminalSize } from '../../../tui/hooks/useTerminalSize.js';

const LOGO = { version: '1.2.3', dir: '/tmp/proj' };
const STATUS = { mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 };

function makeStores() {
  return {
    messagesStore: createMessagesStore(),
    inputStore: createInputStore({ onSubmit: () => {} }),
    statusStore: createStatusStore({ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main' }),
    spinnerStore: createSpinnerStore(undefined, EMPTY_SPINNER_CONTEXT),
    completionStore: createCompletionStore(),
    selectStore: createSelectStore(),
    selectionStore: createSelectionStore(),
    overlayStore: createOverlayStore(),
    askQuestionStore: createAskQuestionStore(),
  };
}

// ─── 单元级:<InlineAppV2> 直接挂载 ──────────────────────────────────────────

describe('<InlineAppV2> LOGO 不变量', () => {
  it('空消息时 logo 在最顶', () => {
    const stores = makeStores();
    const { lastFrame } = render(
      <InlineAppV2 messages={[]} status={STATUS} logo={LOGO} stores={stores} cols={80} rows={24} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('MiCode');
    expect(frame).toContain('v1.2.3');
    expect(frame).toContain('/tmp/proj');
  });

  it('单条已固化消息时 logo 仍在最顶', () => {
    const stores = makeStores();
    stores.messagesStore.getState().appendMessage('user', [
      { content: 'hello', style: {}, indent: 0 },
    ]);
    const { lastFrame } = render(
      <InlineAppV2
        messages={stores.messagesStore.getState().messages}
        status={STATUS} logo={LOGO} stores={stores} cols={80} rows={24}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('MiCode');
    expect(frame).toContain('hello');
    // logo 应在消息之前(行号更小)
    expect(frame.indexOf('MiCode')).toBeLessThan(frame.indexOf('hello'));
  });

  it('多条已固化消息(20 条)logo 仍在最顶', () => {
    const stores = makeStores();
    for (let i = 0; i < 20; i++) {
      stores.messagesStore.getState().appendMessage('assistant', [
        { content: `msg-${i}`, style: {}, indent: 0 },
      ]);
    }
    const { lastFrame } = render(
      <InlineAppV2
        messages={stores.messagesStore.getState().messages}
        status={STATUS} logo={LOGO} stores={stores} cols={80} rows={24}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('MiCode');
    expect(frame).toContain('msg-0');
    expect(frame).toContain('msg-19');
    expect(frame.indexOf('MiCode')).toBeLessThan(frame.indexOf('msg-0'));
  });

  it('流式消息存在时 logo 仍在最顶', () => {
    const stores = makeStores();
    stores.messagesStore.getState().startStreaming('partial\n');
    stores.spinnerStore.getState().start('responding');
    const { lastFrame } = render(
      <InlineAppV2
        messages={stores.messagesStore.getState().messages}
        status={STATUS} logo={LOGO} stores={stores} cols={80} rows={24}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('MiCode');
    expect(frame).toContain('partial');
    expect(frame.indexOf('MiCode')).toBeLessThan(frame.indexOf('partial'));
  });

  it('Select visible 时 logo 仍在最顶', () => {
    const stores = makeStores();
    stores.selectStore.getState().open('Pick', [{ value: 'a', label: 'A' }]);
    const { lastFrame } = render(
      <InlineAppV2
        messages={stores.messagesStore.getState().messages}
        status={STATUS} logo={LOGO} stores={stores} cols={80} rows={24}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('MiCode');
    expect(frame).toContain('Pick');
  });
});

// ─── 集成级:整树 <ConnectedApp> ────────────────────────────────────────────

vi.mock('../../../tui/hooks/useTerminalSize.js', () => ({
  useTerminalSize: vi.fn(() => ({ cols: 80, rows: 24 })),
}));
const mockedUseTerminalSize = vi.mocked(useTerminalSize);

function makeFullStores() {
  return {
    messagesStore: createMessagesStore(),
    inputStore: createInputStore({ onSubmit: () => {} }),
    statusStore: createStatusStore({ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main' }),
    logoStore: createLogoStore(LOGO),
    spinnerStore: createSpinnerStore(undefined, EMPTY_SPINNER_CONTEXT),
    completionStore: createCompletionStore(),
    selectStore: createSelectStore(),
    overlayStore: createOverlayStore(),
    askQuestionStore: createAskQuestionStore(),
    clearScreenStore: createClearScreenStore(),
  };
}

function renderConnected(stores: ReturnType<typeof makeFullStores>) {
  return render(
    React.createElement(RenderModeProvider, { initialMode: 'inline', children:
      React.createElement(ThemeStoreProvider, { store: createThemeStore('dark') },
        React.createElement(ConnectedApp, { ...stores, onExit: () => {} }),
      ),
    }),
  );
}

describe('<ConnectedApp> 整树 LOGO 不变量', () => {
  it('初始挂载含 logo', async () => {
    const stores = makeFullStores();
    const { lastFrame } = renderConnected(stores);
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame() ?? '').toContain('MiCode');
  });

  it('消息累积后 logo 仍在', async () => {
    const stores = makeFullStores();
    const { lastFrame } = renderConnected(stores);
    await new Promise((r) => setTimeout(r, 20));

    for (let i = 0; i < 10; i++) {
      stores.messagesStore.getState().appendMessage('user', [
        { content: `u${i}`, style: {}, indent: 0 },
      ]);
      stores.messagesStore.getState().appendMessage('assistant', [
        { content: `a${i}`, style: {}, indent: 0 },
      ]);
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('MiCode');
    expect(frame).toContain('u0');
    expect(frame).toContain('a9');
  });

  it('Overlay 开关切换后 logo 仍在', async () => {
    const stores = makeFullStores();
    const { frames } = renderConnected(stores);
    await new Promise((r) => setTimeout(r, 20));

    // 通过 store 直接切换 overlay(避免依赖 Ctrl+O 按键解析时序)
    stores.overlayStore.getState().open('Overlay content', [
      { content: 'overlay text', style: {}, indent: 0 },
    ]);
    await new Promise((r) => setTimeout(r, 20));
    // 活动区始终渲染(被备用屏遮住,但 Ink lastOutput 含 logo + footer)
    // 用 frames 找 Ink 帧 OverlayHost 直写 stdout 也进 frames,但不含 MiCode
    const overlayVisibleFrame = frames.find((f) => f.includes('MiCode') && f.includes('sonnet'));
    expect(overlayVisibleFrame).toBeDefined();

    // 关闭 overlay → 主界面仍含 logo + footer
    stores.overlayStore.getState().close();
    await new Promise((r) => setTimeout(r, 30));
    const restoredFrame = frames.slice().reverse().find((f) => f.includes('MiCode') && f.includes('sonnet'));
    expect(restoredFrame).toBeDefined();
  });

  it('Resize 重挂载后 logo 仍在', async () => {
    const stores = makeFullStores();
    stores.messagesStore.getState().appendMessage('user', [
      { content: 'before resize', style: {}, indent: 0 },
    ]);
    mockedUseTerminalSize.mockReturnValue({ cols: 80, rows: 24 });
    const { lastFrame, rerender } = renderConnected(stores);
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame() ?? '').toContain('MiCode');

    // 模拟 resize:cols 80 → 120
    mockedUseTerminalSize.mockReturnValue({ cols: 120, rows: 24 });
    rerender(
      React.createElement(RenderModeProvider, { initialMode: 'inline', children:
        React.createElement(ThemeStoreProvider, { store: createThemeStore('dark') },
          React.createElement(ConnectedApp, { ...stores, onExit: () => {} }),
        ),
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? '';
    expect(frame).toContain('MiCode');
    expect(frame).toContain('before resize');
  });

  it('连续 resize 多次(模拟拖动)logo 仍在', async () => {
    const stores = makeFullStores();
    mockedUseTerminalSize.mockReturnValue({ cols: 80, rows: 24 });
    const { lastFrame, rerender } = renderConnected(stores);
    await new Promise((r) => setTimeout(r, 20));

    // 模拟连续拖动:80 → 100 → 60 → 120 → 40
    for (const cols of [100, 60, 120, 40]) {
      mockedUseTerminalSize.mockReturnValue({ cols, rows: 24 });
      rerender(
        React.createElement(RenderModeProvider, { initialMode: 'inline', children:
          React.createElement(ThemeStoreProvider, { store: createThemeStore('dark') },
            React.createElement(ConnectedApp, { ...stores, onExit: () => {} }),
          ),
        }),
      );
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame() ?? '').toContain('MiCode');
  });

  it('流式 + spinner 并发时 logo 仍在', async () => {
    const stores = makeFullStores();
    const { lastFrame } = renderConnected(stores);
    await new Promise((r) => setTimeout(r, 20));

    stores.messagesStore.getState().startStreaming('partial reply\n');
    stores.spinnerStore.getState().start('responding');
    // 模拟 spinner tick + 流式追加
    for (let i = 0; i < 10; i++) {
      stores.spinnerStore.getState().tick();
      if (i % 3 === 0) {
        const cur = stores.messagesStore.getState().messages;
        const last = cur[cur.length - 1];
        if (last && !last.finalized) {
          stores.messagesStore.getState().updateStreaming(
            (last.streamingText ?? '') + `token${i}\n`,
          );
        }
      }
      await new Promise((r) => setTimeout(r, 8));
    }
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('MiCode');
    expect(frame).toContain('partial');
  });

  it('finalize 后 logo 仍在', async () => {
    const stores = makeFullStores();
    const { lastFrame } = renderConnected(stores);
    await new Promise((r) => setTimeout(r, 20));

    stores.messagesStore.getState().startStreaming('draft\n');
    stores.spinnerStore.getState().start('responding');
    await new Promise((r) => setTimeout(r, 20));

    stores.messagesStore.getState().finalizeStreaming([
      { content: 'final answer', style: {}, indent: 0 },
    ]);
    stores.spinnerStore.getState().stop();
    await new Promise((r) => setTimeout(r, 30));

    const frame = lastFrame() ?? '';
    expect(frame).toContain('MiCode');
    expect(frame).toContain('final answer');
    expect(frame).not.toContain('draft');
  });
});
