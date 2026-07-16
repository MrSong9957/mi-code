// @vitest-environment jsdom
// Inline 模式 resize 渲染契约测试。
//
// 历史：Bug B 尝试让 cols 变化触发 effect 重跑以"跟随 resize"，但在 Windows
// ConPTY 下，resize 时 ConPTY 会用新宽度重放整个历史输出，与应用层的
// renderFooter 写入异步交错，导致 footer 堆叠（EL/DL/full-repaint/debounce
// 均无法解决）。
//
// 当前契约（ConPTY 兼容性回退）：
//   1. cols 在 InlineApp effect 依赖数组里，但纯 cols 变化只更新 prevColsRef，
//      不主动重绘 footer → 不堆叠
//   2. cols 仍作为 prop 传入，effect body 用 cols 渲染 → 下次 messages/input
//      变化触发 effect 时，自然用最新 cols（wordWrap 更新延迟到下次交互）
//   3. Bug 3（resize 堆叠）暂不修复——ConPTY 回退避免更严重错乱
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
import { createSelectStore } from '../../tui/state/select-store.js';
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

  // spy writeFooter（footer 写入走 renderer.commit → writeFooter）
  const writeFooterCalls: { usableWidth: number; height: number }[] = [];
  vi.spyOn(renderer, 'writeFooter').mockImplementation((layout: { usableWidth: number; height: number }) => {
    writeFooterCalls.push({ usableWidth: layout.usableWidth, height: layout.height });
  });
  // spy appendLine：commit 内部的 appendLine 仍走这里（固化消息）
  vi.spyOn(renderer, 'appendLine').mockImplementation(() => undefined);
  // spy commit：记录 frame.prefix，但仍然调用 writeFooter 让测试能检查 footer 布局
  const commitCalls: { prefix?: string[] }[] = [];
  const realCommit = renderer.commit.bind(renderer);
  vi.spyOn(renderer, 'commit').mockImplementation((frame: Parameters<typeof realCommit>[0]) => {
    commitCalls.push({ prefix: frame.prefix });
    // 调用 writeFooter 让测试能检查 footer 布局
    renderer.writeFooter(frame.footer);
  });

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
    selectStore: createSelectStore(),
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

  return { utils, pipeline, renderer, writeFooterCalls, commitCalls, emit, changeCols, baseProps };
}

describe('Inline 模式 resize 渲染契约', () => {
  it('纯 cols 变化（resize）触发 writeFooter，用新宽度布局', () => {
    const { emit, changeCols, writeFooterCalls } = setup(80);

    // 先 emit 一条消息建立 footer
    emit({ kind: 'user_input', text: 'hello' });
    expect(writeFooterCalls.length).toBeGreaterThan(0);
    const lastBefore = writeFooterCalls[writeFooterCalls.length - 1]!;
    expect(lastBefore.usableWidth).toBe(79); // 80-1

    // 纯改 cols（resize）：effect 重跑，footer 用新宽度
    changeCols(40);
    const lastAfter40 = writeFooterCalls[writeFooterCalls.length - 1]!;
    expect(lastAfter40.usableWidth).toBe(39); // 40-1

    changeCols(120);
    const lastAfter120 = writeFooterCalls[writeFooterCalls.length - 1]!;
    expect(lastAfter120.usableWidth).toBe(119); // 120-1
  });

  it('有新消息时 footer layout 用最新 cols 渲染', () => {
    const { emit, writeFooterCalls } = setup(80);

    emit({ kind: 'user_input', text: 'hello' });
    const lastBefore = writeFooterCalls[writeFooterCalls.length - 1]!;
    expect(lastBefore.usableWidth).toBe(79);

    // emit 新消息 + 同时改 cols：effect 重跑（messages 变化），footer 用新 cols 布局
    emit({ kind: 'assistant_text', text: 'reply', isFinal: true }, 40);
    const lastAfter = writeFooterCalls[writeFooterCalls.length - 1]!;
    expect(lastAfter.usableWidth).toBe(39);
  });

  it('resize 清屏 + 清 scrollback + 状态重置', () => {
    const { emit, changeCols, commitCalls, renderer } = setup(80);

    // 先 emit 一条消息建立渲染账本
    emit({ kind: 'user_input', text: 'hello' });
    expect(renderer.state.renderedCount).toBeGreaterThan(0);

    // 记录 resize 前的 commit 调用数
    const callsBefore = commitCalls.length;

    // resize
    changeCols(40);

    // resize 后 commit 的 frame.prefix 应包含清屏序列
    const resizeCommits = commitCalls.slice(callsBefore);
    // 找到含 prefix 的 commit
    const prefixCommit = resizeCommits.find(c => c.prefix && c.prefix.length > 0);
    expect(prefixCommit).toBeDefined();
    const allPrefixOutput = (prefixCommit!.prefix ?? []).join('');

    // \x1b[2J 清屏
    expect(allPrefixOutput).toContain('\x1b[2J');
    // \x1b[3J 清 scrollback（防止多次 resize 累积重复内容）
    expect(allPrefixOutput).toContain('\x1b[3J');
    // \x1b[H 光标归位
    expect(allPrefixOutput).toContain('\x1b[H');
    // logo 重写（含版本号）
    expect(allPrefixOutput).toContain('MiCode');
  });
});
