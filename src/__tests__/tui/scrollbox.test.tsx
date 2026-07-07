// src/__tests__/tui/scrollbox.test.tsx
// ScrollBox：虚拟滚动（按行切片渲染，纯受控组件）
//
// 改动背景：ScrollBox 现在按「行」坐标工作（flatLines），不再按消息切片。
// 滚动状态由 ConnectedApp 持有，ScrollBox 纯受控（scrollTop 传入）。
// 自动跟随逻辑在 ConnectedApp，本测试只验证 ScrollBox 按 flatLines + scrollTop 渲染正确行。

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ScrollBox } from '../../tui/components/ScrollBox.js';
import { createSelectionStore } from '../../tui/state/selection-store.js';
import { flattenMessages } from '../../tui/selection/flatten-messages.js';
import type { TuiMessage } from '../../tui/types.js';

function makeMessages(n: number, prefix = 'msg'): TuiMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    uuid: `${prefix}-${i}`,
    role: 'system' as const,
    finalized: true,
    lines: [{ content: `${prefix} #${i}`, style: {}, indent: 0 }],
  }));
}

/** 造一个 ScrollBox（flatLines 由 messages 展开得到，scrollTop 受控传入） */
function makeScrollBox(messages: TuiMessage[], visibleRows: number, scrollTop = 0) {
  const flatLines = flattenMessages(messages);
  return React.createElement(ScrollBox, {
    messages, flatLines, visibleRows, scrollTop,
    selectionStore: createSelectionStore(),
  });
}

describe('ScrollBox（按行虚拟滚动）', () => {
  it('内容少于可视区：全部渲染', () => {
    const msgs = makeMessages(3);
    const { lastFrame } = render(makeScrollBox(msgs, 10));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('msg #0');
    expect(frame).toContain('msg #1');
    expect(frame).toContain('msg #2');
  });

  it('内容超过可视区 + scrollTop 钉到底：渲染最后 visibleRows 行', () => {
    const msgs = makeMessages(20);
    // scrollTop=15 → 显示行 15..19（#15-#19）
    const { lastFrame } = render(makeScrollBox(msgs, 5, 15));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('msg #19');
    expect(frame).toContain('msg #15');
    expect(frame).not.toContain('msg #0');
    expect(frame).not.toContain('msg #14');
  });

  it('scrollTop=0：渲染最前面 visibleRows 行', () => {
    const msgs = makeMessages(20);
    const { lastFrame } = render(makeScrollBox(msgs, 5, 0));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('msg #0');
    expect(frame).toContain('msg #4');
    expect(frame).not.toContain('msg #5');
  });

  it('多行消息：每行独立渲染（行号不撞车）', () => {
    const msgs: TuiMessage[] = [{
      uuid: 'multi', role: 'assistant', finalized: true,
      lines: [
        { content: 'lineA', style: {}, indent: 0 },
        { content: 'lineB', style: {}, indent: 0 },
        { content: 'lineC', style: {}, indent: 0 },
      ],
    }];
    const { lastFrame } = render(makeScrollBox(msgs, 10));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('lineA');
    expect(frame).toContain('lineB');
    expect(frame).toContain('lineC');
  });

  it('空消息列表：无内容渲染（不崩）', () => {
    const { lastFrame } = render(makeScrollBox([], 5));
    expect(() => lastFrame()).not.toThrow();
  });
});
