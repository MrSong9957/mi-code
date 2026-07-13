// @vitest-environment jsdom
// Inline 模式 resize 渲染契约测试。
//
// 历史：Bug B 尝试让 cols 变化触发 effect 重跑以"跟随 resize"，但在 Windows
// ConPTY 下，resize 时 ConPTY 会用新宽度重放整个历史输出，与应用层的
// renderFooter 写入异步交错，导致 footer 堆叠（EL/DL/full-repaint/debounce
// 均无法解决）。
//
// 当前契约（ConPTY 兼容性回退）：
//   1. cols 故意不在 InlineApp effect 依赖数组里 → 纯 resize 不主动重绘 → 不堆叠
//   2. cols 仍作为 prop 传入，effect body 用 cols 渲染 → 下次 messages/input
//      变化触发 effect 时，自然用最新 cols（wordWrap 更新延迟到下次交互）
//   3. 保留 cols prop 接口，未来通过 layout/render pipeline 重构重新支持动态 resize
//
// 本测试验证这两个契约。

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';
import { BlockPipeline } from '../../ui/block-pipeline.js';
import { PipelineToStoreAdapter } from '../../tui/state/pipeline-adapter.js';
import { createMessagesStore } from '../../tui/state/messages-store.js';
import { createInputStore } from '../../tui/state/input-store.js';
import { createStatusStore } from '../../tui/state/status-store.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';
import { createCompletionStore } from '../../tui/state/completion-store.js';
import { createSelectionStore } from '../../tui/state/selection-store.js';
import { createOverlayStore } from '../../tui/state/overlay-store.js';
import { InlineRenderer } from '../../tui/inline/InlineRenderer.js';
import { InlineApp } from '../../tui/inline/InlineApp.js';
import type { TuiMessage, StatusBarData, LogoData } from '../../tui/types.js';

const dummyStatus: StatusBarData = {
  mode: 'chat', model: 'test', dir: '/tmp', branch: 'main', contextPct: 0,
};
const dummyLogo: LogoData = { version: '0.0.0', dir: '/tmp' };

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    get output() { return written.join(''); },
    write: (s: string) => { written.push(s); return true; },
    columns: 80,
  };
}

function setup(initialCols: number = 80) {
  const mock = createMockStdout();
  const messagesStore = createMessagesStore();
  const adapter = new PipelineToStoreAdapter(messagesStore);
  const pipeline = new BlockPipeline(adapter);
  const renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);

  // spy writeFooter（Phase 2：footer 写入走 writeFooter，接收 FooterLayout）
  const writeFooterCalls: { usableWidth: number; height: number }[] = [];
  vi.spyOn(renderer, 'writeFooter').mockImplementation((layout) => {
    writeFooterCalls.push({ usableWidth: layout.usableWidth, height: layout.height });
    return undefined;
  });
  vi.spyOn(renderer, 'appendLine').mockImplementation(() => undefined);

  const baseProps = {
    messages: [] as TuiMessage[],
    status: dummyStatus,
    logo: dummyLogo,
    renderer,
    messagesStore,
    inputStore: createInputStore(),
    statusStore: createStatusStore({ mode: 'chat', model: 'test', dir: '/tmp', branch: 'main' }),
    spinnerStore: createSpinnerStore(),
    completionStore: createCompletionStore(),
    selectionStore: createSelectionStore(),
    overlayStore: createOverlayStore(),
    cols: initialCols,
  };

  const utils = render(React.createElement(InlineApp, baseProps));

  /** emit pipeline 事件并 rerender（messages + cols 可变） */
  const emit = (block: Parameters<typeof pipeline.emit>[0], newCols?: number) => {
    act(() => { pipeline.emit(block); });
    utils.rerender(React.createElement(InlineApp, {
      ...baseProps,
      messages: messagesStore.getState().messages,
      cols: newCols ?? baseProps.cols,
    }));
  };

  /** 只改 cols（不 emit 消息），触发 rerender */
  const changeCols = (newCols: number) => {
    utils.rerender(React.createElement(InlineApp, {
      ...baseProps,
      messages: messagesStore.getState().messages,
      cols: newCols,
    }));
  };

  return { utils, pipeline, renderer, writeFooterCalls, emit, changeCols, baseProps };
}

describe('Inline 模式 resize 渲染契约（ConPTY 兼容性回退）', () => {
  it('纯 cols 变化（无新消息）不触发 writeFooter → 不堆叠', () => {
    const { emit, changeCols, writeFooterCalls } = setup(80);

    // 先 emit 一条消息建立 footer
    emit({ kind: 'user_input', text: 'hello' });
    const callsAfterFirstMsg = writeFooterCalls.length;
    expect(callsAfterFirstMsg).toBeGreaterThan(0);

    // 纯改 cols（无新消息）：writeFooter 不应被再次调用
    changeCols(40);
    changeCols(120);
    changeCols(60);
    expect(writeFooterCalls.length).toBe(callsAfterFirstMsg);
  });

  it('有新消息时 footer layout 用最新 cols 渲染（wordWrap 延迟更新）', () => {
    const { emit, writeFooterCalls } = setup(80);

    emit({ kind: 'user_input', text: 'hello' });
    const lastBefore = writeFooterCalls[writeFooterCalls.length - 1]!;
    // usableWidth = cols - 1 = 79
    expect(lastBefore.usableWidth).toBe(79);

    // emit 新消息 + 同时改 cols：effect 重跑（messages 变化），footer 用新 cols 布局
    emit({ kind: 'assistant_text', text: 'reply', isFinal: true }, 40);
    const lastAfter = writeFooterCalls[writeFooterCalls.length - 1]!;
    // usableWidth = 40 - 1 = 39
    expect(lastAfter.usableWidth).toBe(39);
  });
});
