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
    expect(frame.length).toBeGreaterThan(0);
  });

  it('shows thinking indicator after delay ticks', () => {
    const store = createSpinnerStore();
    store.getState().start('thinking');
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    // Advance timers: triggers setInterval → tick() → store update → re-render
    vi.advanceTimersByTime(4000);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('thinking');
  });

  it('shows dots cycle in non-thinking modes', () => {
    const store = createSpinnerStore();
    store.getState().start('generating');
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/\./);
  });

  it('stalled state triggers after stall threshold', () => {
    const store = createSpinnerStore();
    store.getState().start('generating');
    expect(store.getState().stalled).toBe(false);
    // Advance Date.now() past STALL_MS (3000ms)
    vi.advanceTimersByTime(3500);
    // Tick to pick up the stalled check (tick reads Date.now() - lastTokenAt)
    store.getState().tick();
    expect(store.getState().stalled).toBe(true);
  });
});
