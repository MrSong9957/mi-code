// src/__tests__/tui/spinner-component.test.tsx
// Spinner 组件：active 渲染 braille+label；inactive 不渲染

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Spinner } from '../../tui/components/Spinner.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';

describe('Spinner 组件', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('inactive：渲染空（无 braille）', () => {
    const store = createSpinnerStore();
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    const frame = lastFrame() ?? '';
    // inactive 时不应出现任何 braille 帧
    expect(frame).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  it('active：渲染 braille + label', () => {
    const store = createSpinnerStore();
    store.getState().start('Thinking…');
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Thinking…');
    expect(frame).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  it('setInterval 120ms 推进帧（不抛错）', () => {
    const store = createSpinnerStore();
    store.getState().start('x');
    const { unmount } = render(React.createElement(Spinner, { store }));
    // 推进 360ms = 3 个 tick
    vi.advanceTimersByTime(360);
    // frameIndex 应已推进（store 层已测；这里只确保不抛错、不崩）
    expect(store.getState().frameIndex).toBeGreaterThan(0);
    unmount();
  });

  it('stop 后不再渲染 braille', () => {
    const store = createSpinnerStore();
    store.getState().start('x');
    const { lastFrame, rerender } = render(React.createElement(Spinner, { store }));
    store.getState().stop();
    rerender(React.createElement(Spinner, { store }));
    const frame = lastFrame() ?? '';
    expect(frame).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });
});
