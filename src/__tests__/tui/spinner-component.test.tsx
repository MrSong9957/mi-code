// src/__tests__/tui/spinner-component.test.tsx
// Spinner 组件（AltScreen 模式）：active 渲染符号+verb；inactive 不渲染

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Spinner } from '../../tui/components/Spinner.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';
import { SPINNER_VERBS } from '../../tui/state/spinner-verbs.js';

// 新符号序列（Claude Code 风格）
const SPINNER_SYMBOLS = ['·', '✢', '✳', '✶', '✻', '✽'];
const SYMBOL_RE = /[·✢✳✶✻✽]/;

describe('Spinner 组件', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('inactive：渲染空（无 spinner 符号）', () => {
    const store = createSpinnerStore();
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    const frame = lastFrame() ?? '';
    expect(frame).not.toMatch(SYMBOL_RE);
  });

  it('active：渲染符号 + verb', () => {
    const store = createSpinnerStore();
    store.getState().start('thinking');
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    const frame = lastFrame() ?? '';
    // 显示的是随机 verb（在词库内）
    const verbFound = SPINNER_VERBS.some(v => frame.includes(v));
    expect(verbFound).toBe(true);
    expect(frame).toMatch(SYMBOL_RE);
  });

  it('setInterval 推进 time（不抛错）', () => {
    const store = createSpinnerStore();
    store.getState().start('generating');
    const { unmount } = render(React.createElement(Spinner, { store }));
    // 推进 150ms = 3 个 tick（50ms）
    vi.advanceTimersByTime(150);
    // time 应已推进（store 层已测；这里只确保不抛错、不崩）
    expect(store.getState().time).toBeGreaterThan(0);
    unmount();
  });

  it('stop 后不再渲染符号', () => {
    const store = createSpinnerStore();
    store.getState().start('generating');
    const { lastFrame, rerender } = render(React.createElement(Spinner, { store }));
    store.getState().stop();
    rerender(React.createElement(Spinner, { store }));
    const frame = lastFrame() ?? '';
    expect(frame).not.toMatch(SYMBOL_RE);
  });

  it('工具模式：显示 label 而非 verb', () => {
    const store = createSpinnerStore();
    store.getState().start('generating');
    store.getState().setMode('tool');
    store.getState().setLabel('Running bash');
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Running bash');
  });
});
