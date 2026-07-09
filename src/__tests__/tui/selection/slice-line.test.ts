// src/__tests__/tui/selection/slice-line.test.ts
// 单行选区切片：核心逻辑（无选区 / ASCII 分段 / CJK 钳位 / 整行选中）
// 精简版：保留核心路径，删除边界穷举（行首行尾/emoji/超出/不相交）

import { describe, it, expect } from 'vitest';
import { sliceLineBySelection } from '../../../tui/selection/slice-line.js';

describe('sliceLineBySelection', () => {
  it('range=null：单段不选中', () => {
    const segs = sliceLineBySelection('hello', null);
    expect(segs).toEqual([{ text: 'hello', selected: false }]);
  });

  it('ASCII 中段选中：3 段（前/选中/后）', () => {
    // 'hello'，[1,4) → 'h' | 'ell' | 'o'
    const segs = sliceLineBySelection('hello', { startCol: 1, endCol: 4 });
    expect(segs).toEqual([
      { text: 'h', selected: false },
      { text: 'ell', selected: true },
      { text: 'o', selected: false },
    ]);
  });

  it('整行选中：单段 selected=true', () => {
    const segs = sliceLineBySelection('hello', { startCol: 0, endCol: 5 });
    expect(segs).toEqual([{ text: 'hello', selected: true }]);
  });

  it('CJK 钳位：startCol 落在全角字符中间向左钳到完整字符', () => {
    // '你好world'：startCol=1 落在「你」中间 → 钳到 0；endCol=3 落在「好」中间 → 钳到 4
    const segs = sliceLineBySelection('你好world', { startCol: 1, endCol: 3 });
    expect(segs).toEqual([
      { text: '你好', selected: true },
      { text: 'world', selected: false },
    ]);
  });
});
