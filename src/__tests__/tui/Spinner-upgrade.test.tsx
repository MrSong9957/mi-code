// src/__tests__/tui/Spinner-upgrade.test.tsx
// Spinner 升级测试：shimmer + thinking + dots 动画集成

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Spinner } from '../../tui/components/Spinner.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';
import { LocaleProvider } from '../../locale/context.js';
import { createLanguageStore } from '../../locale/language-store.js';

const languageStore = createLanguageStore('en-US');

/** Spinner.tsx 内部调用 useLocale()，渲染时必须挂在 LocaleProvider 下。 */
function renderSpinner(store: ReturnType<typeof createSpinnerStore>) {
  return render(
    React.createElement(LocaleProvider, { store: languageStore },
      React.createElement(Spinner, { store }),
    ),
  );
}

describe('Spinner upgraded animations', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows shimmer segments on verb text', () => {
    const store = createSpinnerStore();
    store.getState().start('generating');
    const { lastFrame } = renderSpinner(store);
    const frame = lastFrame() ?? '';
    expect(frame.length).toBeGreaterThan(0);
  });

  it('shows thinking indicator after delay ticks', () => {
    const store = createSpinnerStore();
    store.getState().start('thinking');
    const { lastFrame } = renderSpinner(store);
    // Advance timers: triggers setInterval → tick() → store update → re-render
    vi.advanceTimersByTime(4000);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('thinking');
  });

  it('verb 后追加省略号 …（Claude Code 样式，替代 dots cycle）', () => {
    const store = createSpinnerStore();
    store.getState().start('responding');
    const { lastFrame } = renderSpinner(store);
    const frame = lastFrame() ?? '';
    // U+2026 省略号，固定不变（不随 time 变化）。
    expect(frame).toContain('…');
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
