// src/__tests__/tui/status-bar.test.tsx
// StatusBar 多色高亮：mode/model/dir/branch/进度条 各自独立颜色

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { StatusBar } from '../../tui/components/StatusBar.js';
import type { StatusBarData } from '../../tui/types.js';

const STATUS: StatusBarData = {
  mode: 'build', model: 'sonnet', dir: 'Projects/mi-code', branch: 'main', contextPct: 0.5,
};

describe('StatusBar 多色高亮', () => {
  it('渲染所有 5 段内容', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { status: STATUS }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('build');
    expect(frame).toContain('sonnet');
    expect(frame).toContain('Projects/mi-code');
    expect(frame).toContain('main');
    expect(frame).toContain('50%');
  });

  it('用 box-drawing 分隔符 │（不是 ASCII |）', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { status: STATUS }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('│');
  });

  it('进度条 50% 渲染 5 格填充', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { status: STATUS }));
    const frame = lastFrame() ?? '';
    // 10 格 BAR，50% → 5 个 █
    expect(frame).toContain('█████');
    expect(frame).toContain('░░░░░');
  });

  it('contextPct=0 渲染全空进度条', () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, { status: { ...STATUS, contextPct: 0 } }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('░░░░░░░░░░');
    expect(frame).toContain('0%');
  });

  it('contextPct 钳位（>1 当 1 处理）', () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, { status: { ...STATUS, contextPct: 1.5 } }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('██████████');
    expect(frame).toContain('100%');
  });
});
