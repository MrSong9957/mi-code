// @vitest-environment jsdom
// thinking_end 摘要行与下一条 assistant 消息之间的空行 gap 回归测试（RED → GREEN）
//
// 历史缺陷：`Thought for Ns (ctrl+o to expand)` 后直接紧跟 `● 我是一个AI助手`，
// 中间没有空行间隔，视觉上两条消息粘在一起。
//
// 根因：InlineApp 用 renderedCountRef 按「消息数」追踪已渲染进度。thinking_end
// 帧渲染了 thinking_summary 消息（只含 Thought for 行），renderedCountRef 指向它。
// 随后 assistant 首 delta 到达时，pipeline 的 openModelBlock → ensureGap 给
// thinking_summary 消息「追加」gap 空行（appendLine 续接到同 role system 消息）。
// 但 InlineApp 的 slice(renderedCountRef) 只取它「之后」的消息，已渲染过的
// thinking_summary 新增的 gap 行永远不会被 appendLine 到 stdout。
//
// 物理模型：邮递员（InlineApp）按门牌号（消息序号）送信，送过的门牌不再回头。
// 但 pipeline 在已送过的门牌里「补塞了一封信」（gap 空行），邮递员不会回头取，
// 这封信就丢了。
//
// 修复方向：追踪每个消息「已渲染的行数」而非消息数，已渲染消息新增的行也补写。
//
// 本测试用真实 BlockPipeline + PipelineToStoreAdapter 驱动数据流，spy 拦截
// InlineRenderer.appendLine，断言 Thought for 之后、assistant 正文之前有一个
// 空行 appendLine 调用。

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';
import { BlockPipeline } from '../../ui/block-pipeline.js';
import { PipelineToStoreAdapter } from '../../tui/state/pipeline-adapter.js';
import { createMessagesStore } from '../state/messages-store.js';
import { createInputStore } from '../state/input-store.js';
import { createStatusStore } from '../state/status-store.js';
import { createSpinnerStore } from '../state/spinner-store.js';
import { createCompletionStore } from '../state/completion-store.js';
import { createSelectionStore } from '../state/selection-store.js';
import { createOverlayStore } from '../state/overlay-store.js';
import { InlineRenderer } from './InlineRenderer.js';
import { InlineDynamicGrid } from './inline-dynamic-grid.js';
import { InlineApp } from './InlineApp.js';
import type { TuiMessage, StatusBarData, LogoData } from '../types.js';

const dummyStatus: StatusBarData = {
  mode: 'chat', model: 'test', dir: '/tmp', branch: 'main', contextPct: 0,
};
const dummyLogo: LogoData = { version: '0.0.0', dir: '/tmp' };

/**
 * 挂载真实 InlineApp + 真实 pipeline 数据流。
 * spy appendLine 收集所有追加调用（去 ANSI 后的纯文本）。
 */
function setupWithPipeline() {
  const written: string[] = [];
  const mock = {
    written,
    write: (s: string) => { written.push(s); return true; },
    columns: 80,
  };
  const messagesStore = createMessagesStore();
  const adapter = new PipelineToStoreAdapter(messagesStore);
  const pipeline = new BlockPipeline(adapter);
  const renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  const dynamicGrid = new InlineDynamicGrid(mock as unknown as NodeJS.WriteStream);

  // 收集所有 appendLine 调用的纯文本（去 ANSI）
  const appended: string[] = [];
  vi.spyOn(renderer, 'appendLine').mockImplementation((text: string) => {
    appended.push(text.replace(/\x1b\[[0-9;]*m/g, ''));
  });
  vi.spyOn(dynamicGrid, 'commit').mockImplementation(() => {});
  vi.spyOn(dynamicGrid, 'clear').mockImplementation(() => {});

  const props = {
    messages: [] as TuiMessage[],
    status: dummyStatus,
    logo: dummyLogo,
    renderer,
    dynamicGrid,
    messagesStore,
    inputStore: createInputStore(),
    statusStore: createStatusStore({ mode: 'chat', model: 'test', dir: '/tmp', branch: 'main' }),
    spinnerStore: createSpinnerStore(),
    completionStore: createCompletionStore(),
    selectionStore: createSelectionStore(),
    overlayStore: createOverlayStore(),
    cols: 80,
  };

  const utils = render(React.createElement(InlineApp, props));

  /** emit 一个 pipeline 事件并触发 InlineApp 重新渲染（传入最新 messages） */
  const emit = (block: Parameters<typeof pipeline.emit>[0]) => {
    act(() => { pipeline.emit(block); });
    utils.rerender(React.createElement(InlineApp, {
      ...props, messages: messagesStore.getState().messages,
    }));
  };

  return { utils, pipeline, messagesStore, renderer, appended, emit };
}

describe('Thought for 与 assistant 之间的空行 gap', () => {
  it('RED→GREEN: Thought for 之后、assistant 正文之前必须有一个空行 appendLine', () => {
    const { emit, appended } = setupWithPipeline();

    emit({ kind: 'user_input', text: '你是谁？' });
    emit({ kind: 'thinking_start' });
    emit({ kind: 'thinking_delta', content: '思考' });
    emit({ kind: 'thinking_end', durationSec: 3, filesRead: 0 });
    emit({ kind: 'assistant_text', text: '我是一个', isFinal: false });
    emit({ kind: 'assistant_text', text: '我是一个AI助手', isFinal: true });

    // 在 appendLine 序列中找 Thought for 和 assistant 正文的位置
    const thoughtIdx = appended.findIndex(s => s.includes('Thought for'));
    expect(thoughtIdx).toBeGreaterThanOrEqual(0);

    // 找 Thought for 之后第一个 assistant 正文（以 ● 开头，排除 ● Thinking…）
    const assistantIdx = appended.findIndex((s, i) =>
      i > thoughtIdx && s.startsWith('●') && !s.includes('Thinking'),
    );
    expect(assistantIdx).toBeGreaterThan(thoughtIdx);

    // 关键断言：Thought for 和 assistant 之间至少有一个空行 appendLine（内容为空）
    // bug 代码下：gap 空行不被 appendLine → thoughtIdx+1 就是 assistantIdx，中间无空行 → FAIL (RED)
    // 修复后：gap 空行被 appendLine → thoughtIdx 和 assistantIdx 之间有空行 → PASS (GREEN)
    const between = appended.slice(thoughtIdx + 1, assistantIdx);
    const hasBlankGap = between.some(s => s === '');
    expect(hasBlankGap).toBe(true);
  });

  it('RED→GREEN: 多个 assistant 段之间也应有 gap（第二个 assistant 块）', () => {
    // 验证 assistant 段间 gap 机制不依赖 thinking（纯 assistant 块间也有 openModelBlock）
    const { emit, appended } = setupWithPipeline();

    emit({ kind: 'user_input', text: '继续' });
    emit({ kind: 'assistant_text', text: '第一段', isFinal: true });
    emit({ kind: 'assistant_text', text: '第二段', isFinal: true });

    const firstIdx = appended.findIndex(s => s.includes('第一段'));
    const secondIdx = appended.findIndex(s => s.includes('第二段'));
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);

    // 两段之间应有空行
    const between = appended.slice(firstIdx + 1, secondIdx);
    expect(between.some(s => s === '')).toBe(true);
  });
});
