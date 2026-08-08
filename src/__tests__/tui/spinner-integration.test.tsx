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
import { LocaleProvider } from '../../locale/context.js';
import { createLanguageStore } from '../../locale/language-store.js';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

const languageStore = createLanguageStore('en-US');

/** Spinner.tsx 内部调用 useLocale()，渲染时必须挂在 LocaleProvider 下。 */
function spinnerElement(store: ReturnType<typeof createSpinnerStore>): React.ReactElement {
  return React.createElement(LocaleProvider, { store: languageStore },
    React.createElement(Spinner, { store }),
  );
}

describe('Spinner integration', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('full animation cycle: generating → thinking → stop', () => {
    const store = createSpinnerStore();

    // Phase 1: responding with shimmer + 省略号 + always-on metrics
    store.getState().start('responding');
    const { lastFrame, rerender } = render(spinnerElement(store));
    vi.advanceTimersByTime(1000);
    rerender(spinnerElement(store));
    const genFrame = stripAnsi(lastFrame() ?? '');
    // Shimmer symbols present
    expect(genFrame).toMatch(/[·✢✳✶✻✽]/);
    // Claude Code 样式：verb 后固定省略号 …，不再用 1-3 点 dots cycle。
    expect(genFrame).toContain('…');
    expect(genFrame).not.toMatch(/\.{3}/);
    // 末尾 metrics 段（始终显示，括号包裹）。
    expect(genFrame).toMatch(/\(\d+s\)/);

    // Phase 2: switch to thinking via setMode
    store.getState().setMode('thinking');
    vi.advanceTimersByTime(4000);  // past 3s delay
    rerender(spinnerElement(store));
    const thinkFrame = stripAnsi(lastFrame() ?? '');
    expect(thinkFrame).toContain('(thinking)');

    // Phase 3: stop
    store.getState().stop();
    rerender(spinnerElement(store));
    expect(lastFrame()).toBe('');
  });
});
