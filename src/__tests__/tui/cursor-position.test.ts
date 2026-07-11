// src/__tests__/tui/cursor-position.test.ts
// 光标屏幕坐标工具：CJK 全角=2 列 + 多行 (x,y) 都要正确

import { describe, it, expect } from 'vitest';
import { cursorScreenPos } from '../../tui/state/cursor-position.js';

describe('cursorScreenPos（CJK + 多行 → 屏幕列/行）', () => {
  it('纯 ASCII：光标在末尾，x = promptWidth + textLen', () => {
    // '❯ ' + 'hello'，光标在末尾（5）
    const pos = cursorScreenPos('hello', 5, '❯ ');
    expect(pos).toEqual({ x: 2 + 5, y: 0 });
  });

  it('纯 ASCII：光标在中间', () => {
    // '❯ ' + 'hel|lo'，cursor=3
    const pos = cursorScreenPos('hello', 3, '❯ ');
    expect(pos).toEqual({ x: 2 + 3, y: 0 });
  });

  it('CJK 末尾：你好world cursor=7，显示宽度=2+2+2+5=11（不是 9）', () => {
    // 关键回归断言：旧 bug 是 x = 2+7 = 9（落在「好」中间）
    const pos = cursorScreenPos('你好world', 7, '❯ ');
    expect(pos.x).toBe(2 + 2 + 2 + 5); // 11
    expect(pos.y).toBe(0);
  });

  it('CJK 中间：你|好world cursor=1，x = 2 + 2（「你」宽 2）= 4', () => {
    const pos = cursorScreenPos('你好world', 1, '❯ ');
    expect(pos.x).toBe(2 + 2);
    expect(pos.y).toBe(0);
  });

  it('全 emoji：👋 cursor=1，x = 2 + 2', () => {
    const pos = cursorScreenPos('👋', 1, '❯ ');
    expect(pos.x).toBe(2 + 2);
  });

  it('多行：第 0 行末尾换行，光标在第 1 行行首', () => {
    // 'abc\ndef'，cursor=4（在 \n 之后）。
    // 续行渲染时有 CONTINUATION_INDENT（与 promptWidth=2 等宽），故 x = promptWidth + 0 = 2。
    const pos = cursorScreenPos('abc\ndef', 4, '❯ ');
    expect(pos).toEqual({ x: 2, y: 1 });
  });

  it('多行：光标在第 1 行中间（含 CJK）', () => {
    // 'abc\n你def'，cursor=5（「你」之后）。
    // 续行 x = promptWidth + stringWidth('你') = 2 + 2 = 4。
    const pos = cursorScreenPos('abc\n你def', 5, '❯ ');
    expect(pos).toEqual({ x: 4, y: 1 });
  });

  it('空 prompt：x 纯文本宽度', () => {
    const pos = cursorScreenPos('hi', 2, '');
    expect(pos).toEqual({ x: 2, y: 0 });
  });

  it('cursor=0：x=promptWidth', () => {
    const pos = cursorScreenPos('hello', 0, '❯ ');
    expect(pos).toEqual({ x: 2, y: 0 });
  });

  it('cursor 超出 text.length：钳到末尾（防御）', () => {
    const pos = cursorScreenPos('hi', 99, '❯ ');
    expect(pos).toEqual({ x: 4, y: 0 });
  });
});
