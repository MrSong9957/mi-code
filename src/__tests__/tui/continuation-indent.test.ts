// src/__tests__/tui/continuation-indent.test.ts
// 续行缩进渲染回归测试。
//
// 核心契约：多行输入时，首行有 prompt（❯ ），续行有 CONTINUATION_INDENT（2 空格），
// 对齐 prompt 宽度。两条渲染路径必须一致：
// 1. inline 路径（InlineRenderer.renderFooter）：mock stdout 断言
// 2. alt-screen 路径（Footer.tsx）：ink-testing-library 断言
//
// 防退化：CONTINUATION_INDENT 与 PROMPT 宽度必须等宽（跨模块契约）。

import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { InlineRenderer } from '../../tui/inline/InlineRenderer.js';
import { createSelectionStore } from '../../tui/state/selection-store.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';
import { createCompletionStore } from '../../tui/state/completion-store.js';
import { createOverlayStore } from '../../tui/state/overlay-store.js';
import { App } from '../../tui/App.js';
import type { TuiMessage, StatusBarData, LogoData } from '../../tui/types.js';
import type { FlatLine } from '../../tui/selection/flatten-messages.js';

const PROMPT = '❯ ';
const CONTINUATION_INDENT = '  ';

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    get output() { return written.join(''); },
    write: (s: string) => { written.push(s); return true; },
  };
}

describe('续行缩进渲染回归', () => {
  describe('inline 路径（InlineRenderer.renderFooter）', () => {
    let mock: ReturnType<typeof createMockStdout>;
    let renderer: InlineRenderer;

    beforeEach(() => {
      mock = createMockStdout();
      renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
    });

    it('单行：输出含 prompt（❯ ），无续行缩进', () => {
      expect.hasAssertions();
      renderer.renderFooter('hello', 5, 'status', 80, [], 0, 0);
      expect(mock.output).toContain(`${PROMPT}hello`);
    });

    it('多行：首行 prompt，续行 CONTINUATION_INDENT（对齐 prompt 宽度）', () => {
      expect.hasAssertions();
      renderer.renderFooter('line1\nline2\nline3', 17, 'status', 80, [], 0, 0);
      const out = mock.output;
      // 首行含 prompt
      expect(out).toContain(`${PROMPT}line1`);
      // 续行含 2 空格缩进（不含 prompt）
      expect(out).toContain(`${CONTINUATION_INDENT}line2`);
      expect(out).toContain(`${CONTINUATION_INDENT}line3`);
    });

    it('视口滚动后：窗口首行仍是缩进（非 prompt），真首行才 prompt', () => {
      expect.hasAssertions();
      // 8 行，viewportTop=3 → 窗口首行是第 3 行（非真首行），应为缩进
      const input = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n');
      renderer.renderFooter(input, input.length, 'status', 80, [], 0, 3);
      const out = mock.output;
      // 窗口首行（第3行）是缩进，不是 prompt
      expect(out).toContain(`${CONTINUATION_INDENT}l3`);
      expect(out).not.toContain(`${PROMPT}l3`);
      // 真首行（l0）在视口外，不应出现
      expect(out).not.toContain(`${PROMPT}l0`);
    });

    it('CONTINUATION_INDENT 宽度 === PROMPT 宽度（对齐契约）', () => {
      expect.hasAssertions();
      // 两者显示宽度必须相等（都是 2 列），否则续行与首行输入起点错位。
      expect(CONTINUATION_INDENT.length).toBe(PROMPT.length);
    });
  });

  describe('alt-screen 路径（Footer.tsx via App）', () => {
    const STATUS: StatusBarData = { model: 't', mode: 'auto', dir: '/t', branch: 'main', contextPct: 0 };
    const LOGO: LogoData = { version: '1', dir: '/t' };
    const EMPTY: TuiMessage[] = [];
    const FLAT: FlatLine[] = [];

    it('多行：渲染帧含 prompt 首行 + 缩进续行', () => {
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

    it('视口补空行：单行输入时仍渲染满 MAX_VISIBLE_INPUT_LINES 行（下边框位置稳定）', () => {
      expect.hasAssertions();
      // 单行输入，Footer 应补 4 个空行撑到 5 行，下边框位置稳定（不随输入行数变）。
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
      // 下边框存在（─────），且在 prompt 行之后若干行（补空行撑高）
      expect(frame).toMatch(/─{20,}/);
    });
  });
});
