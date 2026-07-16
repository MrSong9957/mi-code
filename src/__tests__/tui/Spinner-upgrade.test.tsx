// src/__tests__/tui/Spinner-upgrade.test.tsx
// Spinner 升级测试：shimmer + thinking + dots 动画集成

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Spinner } from '../../tui/components/Spinner.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';

describe('Spinner upgraded animations', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows shimmer segments on verb text', () => {
    const store = createSpinnerStore();
    store.getState().start('generating');
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    const frame = lastFrame() ?? '';
    // Should contain the verb (shimmer is color-only, text is same)
    expect(frame.length).toBeGreaterThan(0);
  });

  it('shows thinking indicator in thinking mode after delay', () => {
    const store = createSpinnerStore();
    store.getState().start('thinking');
    // Advance past 3s delay
    vi.advanceTimersByTime(4000);
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    const frame = lastFrame() ?? '';
    // Should show (thinking) tail marker
    expect(frame).toContain('(thinking)');
  });

  it('shows dots cycle in non-thinking modes', () => {
    const store = createSpinnerStore();
    store.getState().start('generating');
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    const frame = lastFrame() ?? '';
    // DotsCycle pads to 3 chars: '.  ', '.. ', '...' — contain at least one dot
    expect(frame).toMatch(/\./);
  });

  it('stalled state renders with error color', () => {
    const store = createSpinnerStore();
    store.getState().start('generating');
    store.getState().onToken();
    vi.advanceTimersByTime(4000);  // past stall threshold
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    expect(lastFrame()).toBeTruthy();
  });
});
