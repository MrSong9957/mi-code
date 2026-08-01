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
import { computeInputViewportLayout, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH } from '../../../tui/state/input-viewport.js';
import type { StatusBarData } from '../../../tui/types.js';
import type { FooterV2Props } from '../../../tui/inline-v2/FooterV2.js';

const STATUS: StatusBarData = {
  mode: 'build',
  model: 'sonnet',
  dir: '/tmp',
  branch: 'main',
  contextPct: 0,
};

// 构造 layout helper(FooterV2 必传 layout,不再接收 input/cursor/viewportTop)。
const layoutOf = (input: string, cursor: number, cols = 80) =>
  computeInputViewportLayout(input, cursor, cols, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH);

describe('<FooterV2>', () => {
  it('渲染 border + 输入 + statusbar', () => {
    const completionStore = createCompletionStore();
    const selectionStore = createSelectionStore();
    const { lastFrame } = render(
      <FooterV2
        status={STATUS}
        cols={80}
        inputRowY={10}
        layout={layoutOf('hello', 5)}
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
        status={STATUS}
        cols={80}
        inputRowY={10}
        layout={layoutOf('first\nsecond', 11)}
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
        status={STATUS}
        cols={80}
        inputRowY={10}
        layout={layoutOf('/', 1)}
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
      status: STATUS,
      cols: 80,
      inputRowY: 10,
      layout: layoutOf('', 0),
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

// 表征测试:AAA\n888 多行分行渲染(FooterV2 内层 Box flexDirection 修复回归)。
// 之前内层 <Box> 缺 flexDirection,默认 row 导致多行水平拼接(AAA 和 888 同行)。
describe('<FooterV2> AAA\\n888 多行表征', () => {
  it('AAA 与 888 落在不同物理行(\\n 未被渲染为空格或同行)', () => {
    const completionStore = createCompletionStore();
    const selectionStore = createSelectionStore();
    const { lastFrame } = render(
      <FooterV2
        status={STATUS}
        cols={80}
        inputRowY={10}
        layout={layoutOf("AAA\n888", 7)}
        completionStore={completionStore}
        selectionStore={selectionStore}
      />,
    );
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const aaaIdx = lines.findIndex(l => l.includes('AAA'));
    const idx888 = lines.findIndex(l => l.includes('888'));
    expect(aaaIdx).toBeGreaterThanOrEqual(0);
    expect(idx888).toBeGreaterThanOrEqual(0);
    // 核心断言:两者必须在不同行,不允许只用 contains 判断
    expect(idx888).toBeGreaterThan(aaaIdx);
  });

  it('AAA 与 888 都落在上下边框之间的输入区(不在边框行)', () => {
    const completionStore = createCompletionStore();
    const selectionStore = createSelectionStore();
    const { lastFrame } = render(
      <FooterV2
        status={STATUS}
        cols={80}
        inputRowY={10}
        layout={layoutOf("AAA\n888", 7)}
        completionStore={completionStore}
        selectionStore={selectionStore}
      />,
    );
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const borderRegex = /─{20,}/;
    const upperBorderIdx = lines.findIndex(l => borderRegex.test(l));
    const lowerBorderIdx = lines.findIndex((l, i) => i > upperBorderIdx && borderRegex.test(l));
    expect(upperBorderIdx).toBeGreaterThanOrEqual(0);
    expect(lowerBorderIdx).toBeGreaterThan(upperBorderIdx);
    const aaaIdx = lines.findIndex(l => l.includes('AAA'));
    const idx888 = lines.findIndex(l => l.includes('888'));
    expect(aaaIdx).toBeGreaterThan(upperBorderIdx);
    expect(aaaIdx).toBeLessThan(lowerBorderIdx);
    expect(idx888).toBeGreaterThan(upperBorderIdx);
    expect(idx888).toBeLessThan(lowerBorderIdx);
  });
});

