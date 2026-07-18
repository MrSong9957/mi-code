// src/__tests__/tui/spinner-integration.test.tsx
// Spinner 集成测试：端到端动画周期验证
//
// 验证 GlimmerMessage + ThinkingIndicator + DotsCycle 在完整
// responding → thinking → stop 流程中协同工作。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Spinner } from '../../tui/components/Spinner.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('Spinner integration', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('full animation cycle: generating → thinking → stop', () => {
    const store = createSpinnerStore();

    // Phase 1: responding with shimmer + dots + always-on timer
    store.getState().start('responding');
    const { lastFrame, rerender } = render(React.createElement(Spinner, { store }));
    vi.advanceTimersByTime(1000);
    rerender(React.createElement(Spinner, { store }));
    const genFrame = stripAnsi(lastFrame() ?? '');
    // Shimmer symbols present
    expect(genFrame).toMatch(/[·✢✳✶✻✽]/);
    // Dots present in responding mode (padded to 3 chars), 后跟始终显示的计时器
    expect(genFrame).toMatch(/\.{1,3}/);
    expect(genFrame).toMatch(/\d+s/);

    // Phase 2: switch to thinking via setMode
    store.getState().setMode('thinking');
    vi.advanceTimersByTime(4000);  // past 3s delay
    rerender(React.createElement(Spinner, { store }));
    const thinkFrame = stripAnsi(lastFrame() ?? '');
    expect(thinkFrame).toContain('(thinking)');

    // Phase 3: stop
    store.getState().stop();
    rerender(React.createElement(Spinner, { store }));
    expect(lastFrame()).toBe('');
  });
});
