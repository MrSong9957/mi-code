// src/__tests__/tui/inline-v2/select-overlay.test.tsx
//
// <SelectOverlayV2> 单元测试(Stage 5a Task 5a.1)。
//
// 物理本质:V2 inline 模式的交互式选择器(独立组件,自订阅 selectStore)。
// visible 时渲染 title + 选项列表 + 操作提示,替代 spinner+footer 占据活动区。
// 用户按 ↑↓ 移动 → store.cycle/cyclePrev → 本组件重渲染高亮项;
// Enter → store.confirm → 触发 onConfirm 回调并关闭。
//
// 与 V0 的 buildSelectView 区别:V0 用纯函数拼 ANSI,V2 用 React 元素,
// Ink createIncremental 自动 diff 高亮变化(只重写变化的行)。

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { SelectOverlayV2 } from '../../../tui/inline-v2/SelectOverlayV2.js';
import { createSelectStore } from '../../../tui/state/select-store.js';

describe('<SelectOverlayV2>', () => {
  it('selectStore 未 open 时不渲染', () => {
    const store = createSelectStore();
    const { lastFrame } = render(<SelectOverlayV2 store={store} cols={80} />);
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  it('open 后渲染 title + 选项', () => {
    const store = createSelectStore();
    store.getState().open('Select model', [
      { value: 'gpt-4o', label: 'GPT-4o', description: 'OpenAI flagship' },
      { value: 'sonnet', label: 'Claude Sonnet', description: 'Anthropic' },
    ]);
    const { lastFrame } = render(<SelectOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Select model');
    expect(frame).toContain('GPT-4o');
    expect(frame).toContain('Claude Sonnet');
  });

  it('选中项有高亮标记(> 前缀)', () => {
    const store = createSelectStore();
    store.getState().open('Select', [
      { value: 'a', label: 'Aaa' },
      { value: 'b', label: 'Bbb' },
    ]);
    // 默认 index=0,Aaa 是选中项
    const { lastFrame } = render(<SelectOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('> Aaa');
  });

  it('cycle 后高亮切换', async () => {
    const store = createSelectStore();
    store.getState().open('Select', [
      { value: 'a', label: 'Aaa' },
      { value: 'b', label: 'Bbb' },
    ]);
    const { lastFrame } = render(<SelectOverlayV2 store={store} cols={80} />);
    expect(lastFrame()).toContain('> Aaa');

    store.getState().cycle();  // 下移到 Bbb
    // 等 ink-testing-library 异步调度刷新 frame
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame()).toContain('> Bbb');
    expect(lastFrame() ?? '').not.toContain('> Aaa');
  });

  it('渲染操作提示', () => {
    const store = createSelectStore();
    store.getState().open('Select', [{ value: 'a', label: 'A' }]);
    const { lastFrame } = render(<SelectOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Enter');
    expect(frame).toContain('Esc');
  });
});
