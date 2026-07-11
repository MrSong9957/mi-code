/**
 * SuggestionBar 渲染回归测试
 *
 * 验证：filter 触发后，SuggestionBar 真的渲染出文本到 lastFrame()。
 * 这是防止"盲补"的关键测试——store 数据正确但渲染层无输出时，此测试会报红。
 */
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { SuggestionBar } from '../../tui/components/SuggestionBar.js';
import { createCompletionStore } from '../../tui/state/completion-store.js';

describe('SuggestionBar filter → 渲染', () => {
  it('filter("") 后渲染前 8 个命令', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    const { lastFrame } = render(React.createElement(SuggestionBar, { store }));
    const frame = lastFrame() ?? '';
    // COMMAND_NAMES 前 8 个：config, login, provider, model, compact, build, plan, auto
    expect(frame).toContain('/config');
    expect(frame).toContain('/login');
    expect(frame).toContain('/build');
    expect(frame).toContain('/plan');
    // theme 排第 17，不在前 8 个可见窗口内
    expect(frame).not.toContain('/theme');
  });

  it('filter("th") 后只渲染 theme', () => {
    const store = createCompletionStore();
    store.getState().filter('th');
    const { lastFrame } = render(React.createElement(SuggestionBar, { store }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/theme');
    // 不应包含其他命令
    expect(frame).not.toContain('/help');
    expect(frame).not.toContain('/config');
  });

  it('filter("zzz") 后渲染空', () => {
    const store = createCompletionStore();
    store.getState().filter('zzz');
    const { lastFrame } = render(React.createElement(SuggestionBar, { store }));
    expect(lastFrame() ?? '').toBe('');
  });

  it('filter 后选中项有 ▸ 前缀', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    const { lastFrame } = render(React.createElement(SuggestionBar, { store }));
    const frame = lastFrame() ?? '';
    // 第一个命令被选中，应有 ▸ 前缀
    const firstCmd = store.getState().candidates[0];
    expect(frame).toContain(`▸/${firstCmd}`);
  });

  it('cycle 后选中项变化', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    store.getState().cycle(); // index → 1
    const { lastFrame } = render(React.createElement(SuggestionBar, { store }));
    const frame = lastFrame() ?? '';
    const secondCmd = store.getState().candidates[1];
    expect(frame).toContain(`▸/${secondCmd}`);
    // 第一个命令不再是选中态
    const firstCmd = store.getState().candidates[0];
    expect(frame).not.toContain(`▸/${firstCmd}`);
  });
});
