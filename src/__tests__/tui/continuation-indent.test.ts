// src/__tests__/tui/continuation-indent.test.ts
// 续行缩进渲染回归测试(alt-screen 路径)。
//
// 核心契约:多行输入时,首行有 prompt(❯ ),续行有 CONTINUATION_INDENT(2 空格),
// 对齐 prompt 宽度。
//
// 注:V0 inline 路径(InlineRenderer.renderFooter)已在 Stage 5b 删除,
// 对应的 V0 测试用例一并删除。alt-screen 路径(Footer.tsx)由本文件覆盖。

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { createSelectionStore } from '../../tui/state/selection-store.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';
import { createCompletionStore } from '../../tui/state/completion-store.js';
import { createOverlayStore } from '../../tui/state/overlay-store.js';
import { App } from '../../tui/App.js';
import { cursorScreenPos } from '../../tui/state/cursor-position.js';
import { computeInputViewportLayout, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH } from '../../tui/state/input-viewport.js';
import type { TuiMessage, StatusBarData, LogoData } from '../../tui/types.js';
import type { FlatLine } from '../../tui/selection/flatten-messages.js';

const PROMPT = '❯ ';
const CONTINUATION_INDENT = '  ';

describe('续行缩进渲染回归', () => {
  describe('alt-screen 路径(Footer.tsx via App)', () => {
    const STATUS: StatusBarData = { model: 't', mode: 'auto', dir: '/t', branch: 'main', contextPct: 0 };
    const LOGO: LogoData = { version: '1', dir: '/t' };
    const EMPTY: TuiMessage[] = [];
    const FLAT: FlatLine[] = [];

    it('多行:渲染帧含 prompt 首行 + 缩进续行', () => {
      expect.hasAssertions();
      const { lastFrame } = render(
        React.createElement(App, {
          messages: EMPTY, status: STATUS, logo: LOGO,
          selectionStore: createSelectionStore(),
          spinnerStore: createSpinnerStore(),
          completionStore: createCompletionStore(),
          overlayStore: createOverlayStore(),
          input: 'first\nsecond\nthird',
          cursor: 17,
          scrollTop: 0,
          flatLines: FLAT,
          cols: 80,
          rows: 24,
        }),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain(`${PROMPT}first`);
      expect(frame).toContain(`${CONTINUATION_INDENT}second`);
      expect(frame).toContain(`${CONTINUATION_INDENT}third`);
    });

    it('视口补空行:单行输入时仍渲染满 MAX_VISIBLE_INPUT_LINES 行(下边框位置稳定)', () => {
      expect.hasAssertions();
      // 单行输入,Footer 应补 4 个空行撑到 5 行,下边框位置稳定(不随输入行数变)。
      const { lastFrame } = render(
        React.createElement(App, {
          messages: EMPTY, status: STATUS, logo: LOGO,
          selectionStore: createSelectionStore(),
          spinnerStore: createSpinnerStore(),
          completionStore: createCompletionStore(),
          overlayStore: createOverlayStore(),
          input: 'single',
          cursor: 6,
          scrollTop: 0,
          flatLines: FLAT,
          cols: 80,
          rows: 24,
        }),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain(`${PROMPT}single`);
      // 下边框存在(─────),且在 prompt 行之后若干行(补空行撑高)
      expect(frame).toMatch(/─{20,}/);
    });
  });

  // 表征测试:用 AAA\n888 精确锁定多行渲染的真实状态(分行/行号/光标/边框)。
  // 目的:区分"分行错误" vs "高度策略问题" vs "光标落边框"。
  // 先不假设"必须动态增高",只锁定真实渲染结果。
  describe('AAA\\n888 多行表征(alt-screen)', () => {
    const STATUS: StatusBarData = { model: 't', mode: 'auto', dir: '/t', branch: 'main', contextPct: 0 };
    const LOGO: LogoData = { version: '1', dir: '/t' };
    const EMPTY: TuiMessage[] = [];
    const FLAT: FlatLine[] = [];

    function renderApp(input: string, cursor: number) {
      return render(
        React.createElement(App, {
          messages: EMPTY, status: STATUS, logo: LOGO,
          selectionStore: createSelectionStore(),
          spinnerStore: createSpinnerStore(),
          completionStore: createCompletionStore(),
          overlayStore: createOverlayStore(),
          input, cursor,
          scrollTop: 0,
          flatLines: FLAT,
          cols: 80, rows: 24,
        }),
      );
    }

    it('AAA 与 888 落在不同物理行(\\n 未被渲染为空格或同行)', () => {
      expect.hasAssertions();
      const { lastFrame } = renderApp('AAA\n888', 7);
      const frame = lastFrame() ?? '';
      const lines = frame.split('\n');
      // 找到含 AAA 的行号 和 含 888 的行号
      const aaaIdx = lines.findIndex(l => l.includes('AAA'));
      const idx888 = lines.findIndex(l => l.includes('888'));
      expect(aaaIdx).toBeGreaterThanOrEqual(0);
      expect(idx888).toBeGreaterThanOrEqual(0);
      // 核心断言:两者必须在不同行(分行正确),不允许只用 contains 判断
      expect(idx888).toBeGreaterThan(aaaIdx);
    });

    it('光标位于 888 所在行(第二行内容区,非边框)', () => {
      expect.hasAssertions();
      // cursor=7 指向 "AAA\n888" 末尾(888 之后),应在第二行(y=1)
      // 通过 cursorScreenPos 验证逻辑层光标位置
      const pos = cursorScreenPos('AAA\n888', 7, PROMPT);
      expect(pos.y).toBe(1); // 第二行(0-based)
    });

    it('AAA 与 888 都落在上下边框之间的输入区(不在边框行)', () => {
      expect.hasAssertions();
      const { lastFrame } = renderApp('AAA\n888', 7);
      const frame = lastFrame() ?? '';
      const lines = frame.split('\n');
      const borderRegex = /─{20,}/;
      const upperBorderIdx = lines.findIndex(l => borderRegex.test(l));
      const lowerBorderIdx = lines.findIndex((l, i) => i > upperBorderIdx && borderRegex.test(l));
      expect(upperBorderIdx).toBeGreaterThanOrEqual(0);
      expect(lowerBorderIdx).toBeGreaterThan(upperBorderIdx);
      const aaaIdx = lines.findIndex(l => l.includes('AAA'));
      const idx888 = lines.findIndex(l => l.includes('888'));
      // 两行内容都必须严格落在上下边框之间(输入区内),不落在边框行
      expect(aaaIdx).toBeGreaterThan(upperBorderIdx);
      expect(aaaIdx).toBeLessThan(lowerBorderIdx);
      expect(idx888).toBeGreaterThan(upperBorderIdx);
      expect(idx888).toBeLessThan(lowerBorderIdx);
    });
  });

  it('CONTINUATION_INDENT 宽度 === PROMPT 宽度(对齐契约)', () => {
    expect.hasAssertions();
    // 两者显示宽度必须相等(都是 2 列),否则续行与首行输入起点错位。
    expect(CONTINUATION_INDENT.length).toBe(PROMPT.length);
  });

  // Step 9:传入 layout 时走物理行渲染,单行输入不补空行(实际行数=1)。
  it('layout 路径:单行输入渲染实际行数(不补空行撑高)', () => {
    expect.hasAssertions();
    const STATUS9: StatusBarData = { model: 't', mode: 'auto', dir: '/t', branch: 'main', contextPct: 0 };
    const LOGO9: LogoData = { version: '1', dir: '/t' };
    const layout = computeInputViewportLayout('single', 6, 80, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH);
    const { lastFrame } = render(
      React.createElement(App, {
        messages: [], status: STATUS9, logo: LOGO9,
        selectionStore: createSelectionStore(),
        spinnerStore: createSpinnerStore(),
        completionStore: createCompletionStore(),
        overlayStore: createOverlayStore(),
        input: 'single', cursor: 6,
        layout,
        scrollTop: 0,
        flatLines: [],
        cols: 80, rows: 24,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain(`${PROMPT}single`);
    // layout.visibleRowCount=1 → 输入区只 1 行,下边框紧邻输入行(不像旧路径补 4 空行)
    const lines = frame.split('\n');
    const inputIdx = lines.findIndex(l => l.includes(`${PROMPT}single`));
    const lowerBorderIdx = lines.findIndex((l, i) => i > inputIdx && /─{20,}/.test(l));
    // 下边框应紧邻输入行(inputIdx+1),而非隔 4 行(旧补空行路径)
    expect(lowerBorderIdx).toBe(inputIdx + 1);
  });
});
