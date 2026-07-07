// src/__tests__/tui/scrollbox-mouse-routing.test.tsx
// ScrollBox 鼠标事件路由集成测试（修根因 #1 的回归保护）：
// 验证 SGR 鼠标序列经 Ink useInput 通道 → ScrollBox → selectionStore 的完整链路。
//
// 背景：旧实现用 stdin.on('data') 监听，与 Ink 7 的 'readable'+read() 流模式冲突，
// 鼠标字节被 Ink InputParser 抢先消费、经 useInput 交付（前导 \x1b 被剥），
// 永远到不了 stdin.on('data')。改用 useInput 后，SGR 残片形如 [<0;5;5M。
// ink-testing-library 的 stdin.write() 走 Ink 的 InputParser，与生产路径一致。
//
// 本测试喂完整 \x1b[<...> 序列（含前导 \x1b），Ink 会剥前导 \x1b 后交付给 useInput，
// ScrollBox 在 useInput 回调里识别 SGR 残片并补回 \x1b 喂给 mouseParser。

import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ScrollBox } from '../../tui/components/ScrollBox.js';
import { createSelectionStore } from '../../tui/state/selection-store.js';
import type { TuiMessage } from '../../tui/types.js';

/** 造 3 条消息，每条 1 行，内容各 5 字符（屏幕行 = LOGO_ROWS=3 + 0/1/2 = 3/4/5） */
function make3Messages(): TuiMessage[] {
  return [
    { uuid: 'a', role: 'assistant', finalized: true, lines: [{ content: 'hello', style: {}, indent: 0 }] },
    { uuid: 'b', role: 'assistant', finalized: true, lines: [{ content: 'world', style: {}, indent: 0 }] },
    { uuid: 'c', role: 'assistant', finalized: true, lines: [{ content: 'foo42', style: {}, indent: 0 }] },
  ];
}

/** SGR 左键按下：button=0，col/row 为 1-origin */
function sgrDown(button: number, col: number, row: number): string {
  return `\x1b[<${button};${col};${row}M`;
}
/** SGR 释放：m 后缀 */
function sgrUp(button: number, col: number, row: number): string {
  return `\x1b[<${button};${col};${row}m`;
}
/** SGR 拖拽：button 含 motion bit (32) */
function sgrDrag(button: number, col: number, row: number): string {
  return `\x1b[<${button};${col};${row}M`;
}

describe('ScrollBox 鼠标事件路由（useInput 通道）', () => {
  it('左键拖拽：startDrag → dragTo → endDrag（选区建立）', () => {
    const store = createSelectionStore();
    const messages = make3Messages();
    const { stdin } = render(
      React.createElement(ScrollBox, { messages, visibleRows: 10, selectionStore: store }),
    );
    // 在屏幕行 4（world）、col 2 按下，拖到行 5（foo42）、col 3
    // SGR 是 1-origin，故屏幕行 4 → SGR row=5；col 2 → SGR col=3
    stdin.write(sgrDown(0, 3, 5));
    stdin.write(sgrDrag(32, 4, 6));
    stdin.write(sgrUp(0, 4, 6));

    const s = store.getState();
    expect(s.anchor).toEqual({ row: 4, col: 2 });
    expect(s.focus).toEqual({ row: 5, col: 3 });
    expect(s.isDragging).toBe(false);
    expect(s.hasSelection()).toBe(true);
  });

  it('右键（button=2）：触发复制 + 清高亮', async () => {
    const store = createSelectionStore();
    const messages = make3Messages();
    // 先建立选区
    store.getState().startDrag({ row: 3, col: 0 });
    store.getState().dragTo({ row: 3, col: 5 });
    store.getState().endDrag();
    expect(store.getState().hasSelection()).toBe(true);

    // mock writeClipboard（经 clipboard 模块的 spawn/OSC52 链路；测试里只验证 clear 生效）
    const { stdin } = render(
      React.createElement(ScrollBox, { messages, visibleRows: 10, selectionStore: store }),
    );
    // 右键按下 button=2，任意位置
    stdin.write(sgrDown(2, 1, 4));

    // 等微任务（copyOnRightClick 是 async）
    await new Promise((r) => setTimeout(r, 50));

    // clear 已执行（选区清空）
    expect(store.getState().hasSelection()).toBe(false);
    expect(store.getState().anchor).toBeNull();
  });

  it('滚轮：wheelup 不建立选区（路由到 scrollTop 而非 selectionStore）', () => {
    const store = createSelectionStore();
    const messages = make3Messages();
    const { stdin } = render(
      React.createElement(ScrollBox, { messages, visibleRows: 2, selectionStore: store }),
    );
    // 滚轮上：button=64（多次，确保触发）
    stdin.write(sgrDown(64, 1, 1));
    stdin.write(sgrDown(64, 1, 1));
    stdin.write(sgrDown(64, 1, 1));

    // 滚轮不应建立选区（核心断言：滚轮路由到 scrollTop，不碰 selectionStore）
    expect(store.getState().hasSelection()).toBe(false);
    expect(store.getState().anchor).toBeNull();
  });

  it('SGR 残片识别：非鼠标 input 不被误判', () => {
    const store = createSelectionStore();
    const messages = make3Messages();
    const { stdin } = render(
      React.createElement(ScrollBox, { messages, visibleRows: 10, selectionStore: store }),
    );
    // 写一段非鼠标字节（普通文本，Ink 会当键盘）
    stdin.write('abc');
    // 不应建立任何选区
    expect(store.getState().hasSelection()).toBe(false);
  });
});
