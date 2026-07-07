// src/__tests__/tui/selection/word-boundary.test.ts
// 词边界识别：双击选词用。col 按码点索引（不是显示列），与 slice-line 不同。

import { describe, it, expect } from 'vitest';
import { findWordBounds } from '../../../tui/selection/word-boundary.js';

describe('findWordBounds', () => {
  it('ASCII 词中段：扩展到词两端', () => {
    // 'hello world' col=2 → 'hello' [0,5)
    expect(findWordBounds('hello world', 2)).toEqual({ start: 0, end: 5 });
  });

  it('落在空格上：无词，返回 [col,col)', () => {
    expect(findWordBounds('hello world', 5)).toEqual({ start: 5, end: 5 });
  });

  it('跨空格到下一个词：col=6 在 world 中段', () => {
    expect(findWordBounds('hello world', 7)).toEqual({ start: 6, end: 11 });
  });

  it('标点是词边界：foo,bar col=2 在 foo', () => {
    expect(findWordBounds('foo,bar', 2)).toEqual({ start: 0, end: 3 });
  });

  it('标点上：col=3 在逗号上 → 无词', () => {
    expect(findWordBounds('foo,bar', 3)).toEqual({ start: 3, end: 3 });
  });

  it('下划线算词字符：foo_bar', () => {
    expect(findWordBounds('foo_bar', 5)).toEqual({ start: 0, end: 7 });
  });

  it('CJK 整段算一个词：你好world col=1 在「好」', () => {
    // 中文字符相邻成词；col=1 码点（第二个字符「好」）—— 但中文连续到 world 连成一词
    // 码点角度：你(0) 好(1) w(2) o(3) r(4) l(5) d(6)
    // col=1 在「好」，词扩展覆盖 [0,7)（中文+字母都是词字符，连续）
    expect(findWordBounds('你好world', 1)).toEqual({ start: 0, end: 7 });
  });

  it('前缀符 ● 是非词字符：col 在 ● 上无词', () => {
    // '● hello' col=0 在 ● 上
    expect(findWordBounds('● hello', 0)).toEqual({ start: 0, end: 0 });
  });

  it('前缀符后接词：col=3 在 hello 中', () => {
    // '● hello' 码点：●(0) ' '(1) h(2) e(3) l(4) l(5) o(6)
    // col=3 在 'e' → 词 [2,7)
    expect(findWordBounds('● hello', 3)).toEqual({ start: 2, end: 7 });
  });

  it('col 超出文本：钳到边界', () => {
    expect(findWordBounds('hi', 99)).toEqual({ start: 0, end: 2 });
  });

  it('col 为负：当 0 处理', () => {
    expect(findWordBounds('hi', -5)).toEqual({ start: 0, end: 2 });
  });

  it('空字符串：返回 {0,0}', () => {
    expect(findWordBounds('', 0)).toEqual({ start: 0, end: 0 });
  });
});
