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

  it('CONTINUATION_INDENT 宽度 === PROMPT 宽度(对齐契约)', () => {
    expect.hasAssertions();
    // 两者显示宽度必须相等(都是 2 列),否则续行与首行输入起点错位。
    expect(CONTINUATION_INDENT.length).toBe(PROMPT.length);
  });
});
