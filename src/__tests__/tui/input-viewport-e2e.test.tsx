// src/__tests__/tui/input-viewport-e2e.test.tsx
// 多行输入 + 视口窗口 端到端回归测试。
//
// 核心契约（E2E 防线）：如果此测试通过，屏幕上必然只渲染视口内的输入行，
// 且 footer 高度固定（历史区大小不随输入行数变化）。
//
// 测试策略（模拟真实应用流程）：
// 1. 渲染完整 App（alt-screen 布局：Logo + ScrollBox + Footer）
// 2. 注入 8 行输入文本（超 MAX_VISIBLE_INPUT_LINES=5）+ cursor 在第 6 行
// 3. 断言 stdout：
//    - 包含视口内行（viewportTop=4 → l4..l7 中 cursor 附近的行）
//    - 不含视口外的行（l0..l3）
//    - footer 高度固定（不随输入行数膨胀）
//
// 这是防止"视口不生效 / footer 撑动历史区"的最终防线。

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../../tui/App.js';
import { createSelectionStore } from '../../tui/state/selection-store.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';
import { createCompletionStore } from '../../tui/state/completion-store.js';
import { createOverlayStore } from '../../tui/state/overlay-store.js';
import { MAX_VISIBLE_INPUT_LINES, computeInputViewportLayout, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH } from '../../tui/state/input-viewport.js';
import { cursorScreenPos } from '../../tui/state/cursor-position.js';
import { computeInputViewport } from '../../tui/state/input-viewport.js';
import type { TuiMessage, StatusBarData, LogoData } from '../../tui/types.js';
import type { FlatLine } from '../../tui/selection/flatten-messages.js';

// 最小可渲染 fixtures
const STATUS: StatusBarData = { model: 'test', mode: 'auto', dir: '/tmp', branch: 'main', contextPct: 0 };
const LOGO: LogoData = { version: '1.0', dir: '/tmp' };
const EMPTY_FLAT_LINES: FlatLine[] = [];
const EMPTY_MESSAGES: TuiMessage[] = [];

function renderApp(input: string, cursor: number, rows = 24, flatLines: FlatLine[] = EMPTY_FLAT_LINES): { lastFrame: () => string | undefined } {
  const selectionStore = createSelectionStore();
  const spinnerStore = createSpinnerStore();
  const completionStore = createCompletionStore();
  const overlayStore = createOverlayStore();
  const layout = computeInputViewportLayout(input, cursor, 80, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH);
  return render(
    React.createElement(App, {
      messages: EMPTY_MESSAGES,
      status: STATUS,
      logo: LOGO,
      selectionStore,
      spinnerStore,
      completionStore,
      overlayStore,
      layout,
      scrollTop: 0,
      flatLines,
      cols: 80,
      rows,
    }),
  );
}

describe('多行输入 + 视口窗口 E2E', () => {
  it('契约 1：8 行输入时 stdout 只渲染视口内行，视口外行不出现', () => {
    expect.hasAssertions();
    // 8 行输入，cursor 在第 6 行行首。
    // viewportTop = clamp(cursorLine - floor(maxVisible/2), 0, maxScroll)
    //             = clamp(6-2, 0, 8-5) = clamp(4, 0, 3) = 3
    // 可见区间 [3, 8) = l3..l7；视口外 l0..l2 不应出现。
    const lines = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'];
    const input = lines.join('\n');
    const cursorLine = 6;
    const cursorPos = input.indexOf('l6'); // l6 行首
    const vp = computeInputViewport(lines.length, cursorLine, MAX_VISIBLE_INPUT_LINES);
    const { lastFrame } = renderApp(input, cursorPos);
    const frame = lastFrame() ?? '';
    // 视口内行应出现
    expect(frame).toContain('l3');
    expect(frame).toContain('l7');
    // 视口外行不应出现
    expect(frame).not.toContain('l0');
    expect(frame).not.toContain('l1');
    expect(frame).not.toContain('l2');
    // 单一真理源交叉验证
    expect(vp.viewportTop).toBe(3);
  });

  it('契约 2：输入行数 ≤ MAX_VISIBLE_INPUT_LINES 时全部渲染（不触发视口）', () => {
    expect.hasAssertions();
    const lines = ['l0', 'l1', 'l2']; // 3 行，未超 5
    const input = lines.join('\n');
    const { lastFrame } = renderApp(input, 0);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('l0');
    expect(frame).toContain('l1');
    expect(frame).toContain('l2');
  });

  it('契约 3：动态 footer——8 行输入比 1 行输入的 layout.visibleRowCount 大(物理行模型)', () => {
    expect.hasAssertions();
    // 旧"footer 高度固定"契约已被动态物理行模型取代(输入区 1-5 行,历史区相应伸缩)。
    // ink-testing-library 帧固定 rows 行,无法从帧行数判断 footer 高度;
    // 改为直接断言 layout.visibleRowCount 反映真实动态行为。
    const layout1 = computeInputViewportLayout('single', 6, 80, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH);
    const eightLines = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n');
    const layout8 = computeInputViewportLayout(eightLines, 18, 80, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH);
    // 8 行输入:visibleRowCount 锁 5(超 MAX_VISIBLE_INPUT_LINES);1 行输入:visibleRowCount=1
    expect(layout1.visibleRowCount).toBe(1);
    expect(layout8.visibleRowCount).toBe(5);
    expect(layout8.physicalRowCount).toBeGreaterThan(layout1.physicalRowCount);
  });

  it('契约 4：cursorScreenPos 与 computeInputViewport 协同——光标恒在视口内', () => {
    expect.hasAssertions();
    // 随机化 5 组，断言不变量
    for (let trial = 0; trial < 5; trial++) {
      const lineCount = 6 + Math.floor(Math.random() * 8);
      const lines: string[] = [];
      for (let i = 0; i < lineCount; i++) lines.push(`ln${String(i).padStart(2, '0')}`);
      const input = lines.join('\n');
      const cursorLine = Math.floor(Math.random() * lineCount);
      const cursorPos = input.indexOf(lines[cursorLine]!);
      const pos = cursorScreenPos(input, cursorPos, '❯ ');
      const vp = computeInputViewport(lineCount, pos.y, MAX_VISIBLE_INPUT_LINES);
      // 不变量：光标在视口可见区间
      const cursorViewportY = pos.y - vp.viewportTop;
      expect(cursorViewportY).toBeGreaterThanOrEqual(0);
      expect(cursorViewportY).toBeLessThan(MAX_VISIBLE_INPUT_LINES);
    }
  });
});
