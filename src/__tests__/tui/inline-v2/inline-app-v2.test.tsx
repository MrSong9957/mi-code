// src/__tests__/tui/inline-v2/inline-app-v2.test.tsx
//
// <InlineAppV2> 单元测试:V2 inline 模式根组件骨架(Stage 2)。
//
// 物理本质:V2 路径的根 React 元素,走 Ink reconciler + <Static>。
// Stage 2 只渲染 <Static>(已固化消息) + 占位 footer,无 spinner/streaming。
//
// 用 ink-testing-library 的 render/lastFrame 断言渲染内容。

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { InlineAppV2, type InlineAppV2Stores } from '../../../tui/inline-v2/InlineAppV2.js';
import { createMessagesStore } from '../../../tui/state/messages-store.js';
import { createInputStore } from '../../../tui/state/input-store.js';
import { createStatusStore } from '../../../tui/state/status-store.js';
import { createSpinnerStore } from '../../../tui/state/spinner-store.js';
import { createCompletionStore } from '../../../tui/state/completion-store.js';
import { createSelectStore } from '../../../tui/state/select-store.js';
import { createOverlayStore } from '../../../tui/state/overlay-store.js';
import { createSelectionStore } from '../../../tui/state/selection-store.js';

function createStores(): InlineAppV2Stores {
  return {
    messagesStore: createMessagesStore(),
    inputStore: createInputStore({ onSubmit: () => {} }),
    statusStore: createStatusStore({ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main' }),
    spinnerStore: createSpinnerStore(),
    completionStore: createCompletionStore(),
    selectStore: createSelectStore(),
    selectionStore: createSelectionStore(),
    overlayStore: createOverlayStore(),
  };
}

describe('<InlineAppV2>', () => {
  it('渲染已固化消息', () => {
    const stores = createStores();
    stores.messagesStore.getState().appendMessage('assistant', [
      { content: 'hello', style: {}, indent: 0 },
    ]);
    const { lastFrame } = render(
      <InlineAppV2
        messages={stores.messagesStore.getState().messages}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />
    );
    expect(lastFrame()).toContain('hello');
  });

  it('空消息不崩溃', () => {
    const stores = createStores();
    const { lastFrame } = render(
      <InlineAppV2
        messages={[]}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />
    );
    expect(lastFrame()).toBeDefined();
  });

  it('多个已固化消息都被渲染', () => {
    const stores = createStores();
    stores.messagesStore.getState().appendMessage('user', [
      { content: 'question', style: {}, indent: 0 },
    ]);
    stores.messagesStore.getState().appendMessage('assistant', [
      { content: 'answer', style: {}, indent: 0 },
    ]);
    const { lastFrame } = render(
      <InlineAppV2
        messages={stores.messagesStore.getState().messages}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('question');
    expect(frame).toContain('answer');
  });
});
