// src/__tests__/tui/scrollbox.test.tsx
// ScrollBox：虚拟滚动 + 自动跟随

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ScrollBox } from '../../tui/components/ScrollBox.js';
import { createSelectionStore } from '../../tui/state/selection-store.js';
import type { TuiMessage } from '../../tui/types.js';

function makeMessages(n: number, prefix = 'msg'): TuiMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    uuid: `${prefix}-${i}`,
    role: 'system' as const,
    finalized: true,
    lines: [{ content: `${prefix} #${i}`, style: {}, indent: 0 }],
  }));
}

/** ScrollBox 现在是受控组件（scrollTop 由父级持有）。造一个 wrapper 持有滚动状态。
 *  wrapper 模拟 ConnectedApp 的行为：scrolledAway=false 时每次 render 同步把 scrollTop
 *  钉到 maxScroll（自动跟随），不用 effect（避免 ink-testing-library 异步时序问题）。 */
function ScrollBoxWrapper({ messages, visibleRows }: { messages: TuiMessage[]; visibleRows: number }): React.ReactElement {
  const selectionStoreRef = React.useRef(createSelectionStore());
  const [scrollTop, setScrollTop] = React.useState(0);
  const scrolledAwayRef = React.useRef(false);
  // 同步自动跟随：未主动上滚时钉到 maxScroll
  const maxScroll = Math.max(0, messages.length - visibleRows);
  const effectiveScrollTop = scrolledAwayRef.current ? scrollTop : maxScroll;
  return React.createElement(ScrollBox, {
    messages, visibleRows, selectionStore: selectionStoreRef.current,
    scrollTop: effectiveScrollTop,
    onScrollTopChange: (updater: (prev: number) => number) => {
      const next = updater(effectiveScrollTop);
      scrolledAwayRef.current = next < maxScroll;
      setScrollTop(next);
    },
    scrolledAway: scrolledAwayRef.current,
  });
}

/** 造一个 ScrollBox（带 selectionStore + 受控滚动状态） */
function makeScrollBox(messages: TuiMessage[], visibleRows: number) {
  return React.createElement(ScrollBoxWrapper, { messages, visibleRows });
}

describe('ScrollBox（虚拟滚动）', () => {
  it('内容少于可视区：全部渲染', () => {
    const msgs = makeMessages(3);
    const { lastFrame } = render(makeScrollBox(msgs, 10));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('msg #0');
    expect(frame).toContain('msg #1');
    expect(frame).toContain('msg #2');
  });

  it('内容超过可视区：只渲染可视区间（visibleRows 条），老的裁掉', () => {
    const msgs = makeMessages(20);
    const { lastFrame } = render(makeScrollBox(msgs, 5));
    const frame = lastFrame() ?? '';
    // 自动跟随到底：渲染最后 5 条（#15-#19），前面的裁掉
    expect(frame).toContain('msg #19');
    expect(frame).toContain('msg #15');
    // #14 及更早不应出现（被裁剪）
    expect(frame).not.toContain('msg #0');
    expect(frame).not.toContain('msg #14');
  });

  it('自动跟随：新消息追加后，可视区追到最新', () => {
    const msgs1 = makeMessages(10);
    const inst = render(makeScrollBox(msgs1, 3));
    // 初始：最后 3 条（#7,8,9）
    let frame = inst.lastFrame() ?? '';
    expect(frame).toContain('msg #9');

    // 追加 5 条（共 15 条），应自动跟随到最后 3 条（#12,13,14）
    const msgs2 = makeMessages(15);
    inst.rerender(makeScrollBox(msgs2, 3));
    frame = inst.lastFrame() ?? '';
    expect(frame).toContain('msg #14');
    expect(frame).not.toContain('msg #9');
  });

  it('空消息列表：无内容渲染（不崩）', () => {
    const { lastFrame } = render(makeScrollBox([], 5));
    expect(() => lastFrame()).not.toThrow();
  });
});
