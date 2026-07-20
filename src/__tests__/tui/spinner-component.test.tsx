// src/__tests__/tui/spinner-component.test.tsx
// Spinner 组件（AltScreen 模式）：active 渲染符号+verb；inactive 不渲染

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Spinner } from '../../tui/components/Spinner.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';
import { SPINNER_VERBS } from '../../tui/state/spinner-verbs.js';

// 新符号序列（Claude Code 风格）
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

  it('pure rendering does not own an interval', () => {
    const store = createSpinnerStore();
    store.getState().start('responding');
    const { unmount } = render(React.createElement(Spinner, { store }));
    // 推进 150ms = 3 个 tick（50ms）
    vi.advanceTimersByTime(150);
    // time 应已推进（store 层已测；这里只确保不抛错、不崩）
    expect(store.getState().time).toBe(0);
    unmount();
  });

  it('renders normal auxiliary rows in order and hides them in brief mode', () => {
    const store = createSpinnerStore();
    store.getState().setContext({
      variant: 'normal',
      teammates: [],
      tasks: [{ id: '1', content: 'Ship', status: 'pending', owner: null, activeForm: null, blockedBy: [] }],
      spinnerTip: 'custom tip',
      hasUsedBtw: true,
      budgetText: 'Budget: 10m',
      nextTaskText: 'Next: verify',
    });
    store.getState().start('responding');
    const rendered = render(React.createElement(Spinner, { store }));
    const normal = rendered.lastFrame() ?? '';
    expect(normal).toContain('[ ] Ship');
    expect(normal).toContain('custom tip');
    expect(normal).toContain('Budget: 10m');
    expect(normal).toContain('Next: verify');
    expect(normal.indexOf('[ ] Ship')).toBeLessThan(normal.indexOf('custom tip'));
    expect(normal.indexOf('custom tip')).toBeLessThan(normal.indexOf('Budget: 10m'));
    expect(normal.indexOf('Budget: 10m')).toBeLessThan(normal.indexOf('Next: verify'));

    store.getState().setContext({ ...store.getState().context, variant: 'brief' });
    rendered.rerender(React.createElement(Spinner, { store }));
    const brief = rendered.lastFrame() ?? '';
    expect(brief).not.toContain('[ ] Ship');
    expect(brief).not.toContain('custom tip');
    expect(brief).not.toContain('Budget: 10m');
    expect(brief).not.toContain('Next: verify');
  });

  it('stop 后不再渲染符号', () => {
    const store = createSpinnerStore();
    store.getState().start('responding');
    const { lastFrame, rerender } = render(React.createElement(Spinner, { store }));
    store.getState().stop();
    rerender(React.createElement(Spinner, { store }));
    const frame = lastFrame() ?? '';
    expect(frame).not.toMatch(SYMBOL_RE);
  });

  it('工具模式：显示 label 而非 verb', () => {
    const store = createSpinnerStore();
    store.getState().start('responding');
    store.getState().setMode('tool-use');
    store.getState().setLabel('Running bash');
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Running bash');
  });

  it('verbose 模式未满 30 秒也显示计时器', () => {
    const store = createSpinnerStore();
    store.getState().start('responding');
    store.getState().setVerbose(true);
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    expect(lastFrame()).toContain('1s');
  });

  it('有活跃 teammate 时未满 30 秒也显示计时器', () => {
    const store = createSpinnerStore();
    store.getState().start('responding');
    store.getState().setContext({
      ...store.getState().context,
      teammates: [{ name: 'alice', role: 'coder', status: 'working' }],
    });
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    expect(lastFrame()).toContain('1s');
  });

  it('显示 leader 与 teammate token 总和，并按模式显示箭头', () => {
    const store = createSpinnerStore();
    store.getState().start('requesting');
    store.getState().setVerbose(true);
    store.getState().onToken(800);
    store.getState().setTeammateTokens(30);
    store.getState().tick();
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    expect(lastFrame()).toContain('↑ 80');
  });

  it('thinking 显示 effort，退出后显示临时耗时摘要', () => {
    vi.setSystemTime(0);
    const store = createSpinnerStore();
    store.getState().setThinkingEffort('hard');
    store.getState().start('thinking');
    const { lastFrame, rerender } = render(React.createElement(Spinner, { store }));
    expect(lastFrame()).toContain('(thinking hard)');

    vi.setSystemTime(1_500);
    store.getState().tick();
    store.getState().setMode('responding');
    rerender(React.createElement(Spinner, { store }));
    expect(lastFrame()).toContain('(thought for 2s)');
  });
});
