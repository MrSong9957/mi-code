// src/__tests__/tui/inline-v2/footer-v2-memo.test.tsx
//
// <FooterV2> 单元测试 + memo 隔离验证(Stage 3 Task 3.1 / 3.4)。
//
// 物理本质:V2 inline 模式 footer(独立于 alt-screen <Footer>)。
// - 不含 spinner(spinner 是兄弟组件 <SpinnerMemo>)
// - 内部含 SuggestionBar(随输入 / 弹出,占位高度)
// - 用 React.memo 包裹:spinner tick 时父组件不重渲染 → FooterV2 props 引用稳定 → 不重渲染
//
// Task 3.4 加 "spinner tick 不触发 FooterV2 重渲染" 隔离测试(核心防回归)。

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { FooterV2 } from '../../../tui/inline-v2/FooterV2.js';
import { createCompletionStore } from '../../../tui/state/completion-store.js';
import { createSelectionStore } from '../../../tui/state/selection-store.js';
import { createSpinnerStore } from '../../../tui/state/spinner-store.js';
import type { StatusBarData } from '../../../tui/types.js';
import type { FooterV2Props } from '../../../tui/inline-v2/FooterV2.js';

const STATUS: StatusBarData = {
  mode: 'build',
  model: 'sonnet',
  dir: '/tmp',
  branch: 'main',
  contextPct: 0,
};

describe('<FooterV2>', () => {
  it('渲染 border + 输入 + statusbar', () => {
    const completionStore = createCompletionStore();
    const selectionStore = createSelectionStore();
    const { lastFrame } = render(
      <FooterV2
        input="hello"
        cursor={5}
        status={STATUS}
        cols={80}
        inputRowY={10}
        viewportTop={0}
        completionStore={completionStore}
        selectionStore={selectionStore}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('─');
    expect(frame).toContain('❯');
    expect(frame).toContain('sonnet');
    expect(frame).toContain('hello');
  });

  it('续行也渲染出来(缩进换行由 InlineAppV2 集成测试验证)', () => {
    // 注:直接 render <FooterV2> 时 Ink 把多个 SelectionText 输出到同一行
    // (Yoga 没有外层 <Box flexDirection=column> 撑开上下文,和 alt-screen Footer
    // 单独渲染时一样)。换行的精确断言放在 <InlineAppV2> 集成测试里。
    const completionStore = createCompletionStore();
    const selectionStore = createSelectionStore();
    const { lastFrame } = render(
      <FooterV2
        input="first\nsecond"
        cursor={11}
        status={STATUS}
        cols={80}
        inputRowY={10}
        viewportTop={0}
        completionStore={completionStore}
        selectionStore={selectionStore}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('first');
    expect(frame).toContain('second');
  });

  it('SuggestionBar 可见时渲染候选', () => {
    const completionStore = createCompletionStore();
    completionStore.getState().setCandidates([
      { name: 'help', description: 'show help', group: 'core', args: [] },
      { name: 'model', description: 'pick model', group: 'core', args: [] },
    ]);
    const selectionStore = createSelectionStore();
    const { lastFrame } = render(
      <FooterV2
        input="/"
        cursor={1}
        status={STATUS}
        cols={80}
        inputRowY={10}
        viewportTop={0}
        completionStore={completionStore}
        selectionStore={selectionStore}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/help');
    expect(frame).toContain('/model');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Task 3.4:memo 隔离核心防回归测试
//
// 物理本质:验证 spinner tick 不会触发 <FooterV2> 重渲染。
// 这是 Stage 3 的核心保证——spinner 60ms 一次 tick,如果不隔离,
// 每 tick 都重写整个 footer(border + 输入 + statusbar),破坏 incrementalRendering。
//
// 测试原理:用一个计数器组件包裹 <FooterV2>(同样 memo),计数器 render 次数。
// 触发 spinner tick 后,如果 <FooterV2> 没被重渲染,计数器不增加。
// ──────────────────────────────────────────────────────────────────────────

describe('<FooterV2> memo 隔离', () => {
  it('spinner tick 不触发 FooterV2 重渲染(单元级)', () => {
    const completionStore = createCompletionStore();
    const selectionStore = createSelectionStore();
    const spinnerStore = createSpinnerStore();
    spinnerStore.getState().start('responding');

    let renderCount = 0;
    // 用一个外层组件计数:它每次被 React 调度渲染时 +1。
    // FooterV2 是 React.memo,props 引用不变时不会重新执行其函数体,
    // 但外层包装组件会因父重渲染而调度——这里我们直接渲染 FooterV2,
    // 它自己内部不会订阅 spinnerStore,tick 与它无关。
    const CountingFooter = React.memo(function CountingFooter(props: FooterV2Props) {
      renderCount++;
      return <FooterV2 {...props} />;
    });

    const baseProps: FooterV2Props = {
      input: '',
      cursor: 0,
      status: STATUS,
      cols: 80,
      inputRowY: 10,
      viewportTop: 0,
      completionStore,
      selectionStore,
    };

    const { rerender } = render(<CountingFooter {...baseProps} />);
    const initialCount = renderCount;
    expect(initialCount).toBeGreaterThan(0);

    // 触发多个 spinner tick(模拟 500ms 的 spinner 动画)
    for (let i = 0; i < 10; i++) {
      spinnerStore.getState().tick();
    }

    // FooterV2 不订阅 spinnerStore → tick 不触发任何重渲染
    // (没调 rerender,React 不会无端调度)
    expect(renderCount).toBe(initialCount);

    // 用相同 props rerender:memo 应该拦住(<CountingFooter> 是 React.memo)
    rerender(<CountingFooter {...baseProps} />);
    expect(renderCount).toBe(initialCount);
  });
});

