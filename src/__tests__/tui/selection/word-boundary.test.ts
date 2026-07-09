// src/__tests__/tui/selection/word-boundary.test.ts
// 词边界识别：双击选词用。col 按码点索引（不是显示列）。
// 精简版：保留 ASCII 选词 / 标点边界 / CJK 整段，删除空格/前缀/越界穷举

import { describe, it, expect } from 'vitest';
import { findWordBounds } from '../../../tui/selection/word-boundary.js';

describe('findWordBounds', () => {
  it('ASCII 词中段：扩展到词两端', () => {
    // 'hello world' col=2 → 'hello' [0,5)
    expect(findWordBounds('hello world', 2)).toEqual({ start: 0, end: 5 });
  });

  it('标点是词边界：foo,bar col=2 在 foo', () => {
    expect(findWordBounds('foo,bar', 2)).toEqual({ start: 0, end: 3 });
  });

  it('CJK 整段算一个词：你好world col=1 在「好」', () => {
    expect(findWordBounds('你好world', 1)).toEqual({ start: 0, end: 7 });
  });
});
