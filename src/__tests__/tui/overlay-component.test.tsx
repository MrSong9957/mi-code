// src/__tests__/tui/overlay-component.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Overlay } from '../../tui/components/Overlay.js';
import { createOverlayStore } from '../../tui/state/overlay-store.js';

describe('Overlay 组件', () => {
  it('invisible：渲染空', () => {
    const store = createOverlayStore();
    const { lastFrame } = render(React.createElement(Overlay, { store, cols: 80 }));
    expect(lastFrame() ?? '').toBe('');
  });

  it('visible：渲染 title + 内容 + 提示', () => {
    const store = createOverlayStore();
    store.getState().open('Thinking', [
      { content: 'step 1', style: {}, indent: 0 },
      { content: 'step 2', style: {}, indent: 0 },
    ]);
    const { lastFrame } = render(React.createElement(Overlay, { store, cols: 80 }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Thinking');
    expect(frame).toContain('step 1');
    expect(frame).toContain('step 2');
    expect(frame).toContain('返回');
  });

  it('CJK 截断按显示宽度（不溢出 cols）：10 个汉字在 cols=20 内全显示', () => {
    const store = createOverlayStore();
    const tenHan = '汉字汉字汉字汉字汉字'; // 10 码点，显示宽度 20
    store.getState().open('T', [{ content: tenHan, style: {}, indent: 0 }]);
    const { lastFrame } = render(React.createElement(Overlay, { store, cols: 20 }));
    const frame = lastFrame() ?? '';
    // 10 个汉字显示宽=20，正好填满 cols=20 → 应全部保留
    expect(frame).toContain(tenHan);
  });

  it('CJK 截断按显示宽度：cols=10 时 10 个汉字只保留前 5 个', () => {
    const store = createOverlayStore();
    const tenHan = '汉字汉字汉字汉字汉字'; // 10 码点，显示宽度 20
    store.getState().open('T', [{ content: tenHan, style: {}, indent: 0 }]);
    const { lastFrame } = render(React.createElement(Overlay, { store, cols: 10 }));
    const frame = lastFrame() ?? '';
    // cols=10 → 只能容 5 个汉字（每个宽 2）
    expect(frame).toContain('汉字汉字汉字汉字汉字'.slice(0, 5));
    // 第 6 个汉字不应出现（否则说明截断没按显示宽度）
    const six = '汉字汉字汉字汉字汉字汉字'.slice(0, 6);
    expect(frame).not.toContain(six);
  });
});
