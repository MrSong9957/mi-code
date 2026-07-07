// src/__tests__/tui/selection/slice-line.test.ts
// 单行选区切片：ASCII/CJK 钳位/边界/null

import { describe, it, expect } from 'vitest';
import { sliceLineBySelection } from '../../../tui/selection/slice-line.js';

describe('sliceLineBySelection', () => {
  it('range=null：单段不选中', () => {
    const segs = sliceLineBySelection('hello', null);
    expect(segs).toEqual([{ text: 'hello', selected: false }]);
  });

  it('ASCII 中段选中：3 段', () => {
    // 'hello'，[1,4) → 'h' | 'ell' | 'o'
    const segs = sliceLineBySelection('hello', { startCol: 1, endCol: 4 });
    expect(segs).toEqual([
      { text: 'h', selected: false },
      { text: 'ell', selected: true },
      { text: 'o', selected: false },
    ]);
  });

  it('选中到行首：2 段（前段空丢弃）', () => {
    const segs = sliceLineBySelection('hello', { startCol: 0, endCol: 2 });
    expect(segs).toEqual([
      { text: 'he', selected: true },
      { text: 'llo', selected: false },
    ]);
  });

  it('选中到行尾：2 段（后段空丢弃）', () => {
    const segs = sliceLineBySelection('hello', { startCol: 3, endCol: 5 });
    expect(segs).toEqual([
      { text: 'hel', selected: false },
      { text: 'lo', selected: true },
    ]);
  });

  it('整行选中：单段 selected=true', () => {
    const segs = sliceLineBySelection('hello', { startCol: 0, endCol: 5 });
    expect(segs).toEqual([{ text: 'hello', selected: true }]);
  });

  it('CJK 钳位：startCol 落在全角字符中间向左钳', () => {
    // '你好world' 显示宽度：你=2,好=2,w=1...
    // 累积：你[0,2) 好[2,4) w[4,5) o[5,6)...
    // startCol=1 落在「你」中间 → 钳到 0；endCol=3 落在「好」中间 → 钳到 4
    const segs = sliceLineBySelection('你好world', { startCol: 1, endCol: 3 });
    // 钳位后 [0,4) → 「你好」选中，world 不选
    expect(segs).toEqual([
      { text: '你好', selected: true },
      { text: 'world', selected: false },
    ]);
  });

  it('CJK 钳位：startCol 落在全角字符起点不钳', () => {
    // startCol=2 正好在「好」起点，不钳
    const segs = sliceLineBySelection('你好world', { startCol: 2, endCol: 4 });
    expect(segs).toEqual([
      { text: '你', selected: false },
      { text: '好', selected: true },
      { text: 'world', selected: false },
    ]);
  });

  it('CJK 选中半个字符区间：钳到完整字符', () => {
    // '你好' [1,3) → startCol=1 钳到 0，endCol=3 钳到 4 → [0,4) 整行
    const segs = sliceLineBySelection('你好', { startCol: 1, endCol: 3 });
    expect(segs).toEqual([{ text: '你好', selected: true }]);
  });

  it('emoji 当 1 个码点（显示宽 2）：切片按码点', () => {
    // 'a👋b' 显示宽度：a=1 👋=2 b=1，累积 a[0,1) 👋[1,3) b[3,4)
    const segs = sliceLineBySelection('a👋b', { startCol: 1, endCol: 3 });
    expect(segs).toEqual([
      { text: 'a', selected: false },
      { text: '👋', selected: true },
      { text: 'b', selected: false },
    ]);
  });

  it('空字符串：返回空数组', () => {
    expect(sliceLineBySelection('', null)).toEqual([]);
    expect(sliceLineBySelection('', { startCol: 0, endCol: 5 })).toEqual([]);
  });

  it('range 超出文本宽度：钳到行尾', () => {
    // 'hi' 宽 2，[0,99) → 整行选中
    const segs = sliceLineBySelection('hi', { startCol: 0, endCol: 99 });
    expect(segs).toEqual([{ text: 'hi', selected: true }]);
  });

  it('range 不相交（endCol<=0 或 startCol>=width）：单段不选中', () => {
    expect(sliceLineBySelection('hi', { startCol: 5, endCol: 9 }))
      .toEqual([{ text: 'hi', selected: false }]);
    expect(sliceLineBySelection('hi', { startCol: 0, endCol: 0 }))
      .toEqual([{ text: 'hi', selected: false }]);
  });
});
