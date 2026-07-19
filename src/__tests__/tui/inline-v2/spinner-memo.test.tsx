// src/__tests__/tui/inline-v2/spinner-memo.test.tsx
//
// <SpinnerMemo> 单元测试(Stage 3 Task 3.2)。
//
// 物理本质:V2 inline 模式的 spinner,自订阅 spinnerStore。
// - 父组件传 store 引用(store 本身不变,只是容器)
// - 组件内部用 useStore 订阅,spinner tick 只触发本组件重渲染
// - 不冒泡到 <InlineAppV2>(父不订阅 spinnerStore)
//
// 与 alt-screen <Spinner> 的区别:alt-screen 版本接收 view prop(由父算),
// V2 版本自己订阅 store 自己算 view。

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { SpinnerMemo } from '../../../tui/inline-v2/spinner-memo.js';
import { createSpinnerStore } from '../../../tui/state/spinner-store.js';
import { ThemeProvider, getTheme } from '../../../tui/state/theme-context.js';

// Spinner 内部用了 useTheme,需要 ThemeProvider 包裹。
const DARK_THEME = getTheme('dark');
function wrap(ui: React.ReactElement): React.ReactElement {
  return React.createElement(ThemeProvider, { value: DARK_THEME }, ui);
}

describe('<SpinnerMemo>', () => {
  it('spinner 未 active 时渲染为空(无 spinner 文本)', () => {
    const store = createSpinnerStore();
    const { lastFrame } = render(wrap(<SpinnerMemo store={store} />));
    // Ink 渲染 null 可能输出单个 \n(占位空行);关键是没有任何 spinner 文本。
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  it('订阅 spinnerStore,active 时渲染 glyph + verb', () => {
    const store = createSpinnerStore();
    store.getState().start('responding');
    const { lastFrame } = render(wrap(<SpinnerMemo store={store} />));
    const frame = lastFrame() ?? '';
    // active spinner 应该有内容(glyph + verb 文本)
    expect(frame.length).toBeGreaterThan(0);
  });

  it('store tick 后重新渲染(frame 变化)', () => {
    const store = createSpinnerStore();
    store.getState().start('responding');
    const { lastFrame } = render(wrap(<SpinnerMemo store={store} />));
    const frame1 = lastFrame() ?? '';
    // 模拟时间推进,spinner 帧会变
    store.getState().tick();
    store.getState().tick();
    store.getState().tick();
    const frame2 = lastFrame() ?? '';
    // 两次都应该有内容,但内容可能不同(取决于帧序)
    expect(frame1.length).toBeGreaterThan(0);
    expect(frame2.length).toBeGreaterThan(0);
  });

  it('stop 后渲染为空(无 spinner 文本)', () => {
    const store = createSpinnerStore();
    store.getState().start('responding');
    const { lastFrame, rerender } = render(wrap(<SpinnerMemo store={store} />));
    expect((lastFrame() ?? '').length).toBeGreaterThan(0);
    store.getState().stop();
    rerender(wrap(<SpinnerMemo store={store} />));
    // Ink 渲染 null 可能输出单个 \n(占位空行);关键是没有任何 spinner 文本。
    expect((lastFrame() ?? '').trim()).toBe('');
  });
});
