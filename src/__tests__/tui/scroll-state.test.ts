// src/__tests__/tui/scroll-state.test.ts
// ScrollState：虚拟滚动状态计算（charter §核心模块 1）

import { describe, it, expect } from 'vitest';
import { computeScrollState, clampScrollTop, sliceVisible } from '../../tui/components/scroll-state.js';

describe('computeScrollState（滚动状态计算）', () => {
  it('空列表：scrollTop=0, maxScroll=0', () => {
    const s = computeScrollState({ total: 0, visibleRows: 10, scrollTop: 0 });
    expect(s.scrollTop).toBe(0);
    expect(s.maxScroll).toBe(0);
    expect(s.visibleRows).toBe(10);
  });

  it('内容少于可视区：maxScroll=0，scrollTop 钳到 0', () => {
    const s = computeScrollState({ total: 3, visibleRows: 10, scrollTop: 5 });
    expect(s.maxScroll).toBe(0);
    expect(s.scrollTop).toBe(0);
  });

  it('内容刚好等于可视区：maxScroll=0', () => {
    const s = computeScrollState({ total: 10, visibleRows: 10, scrollTop: 0 });
    expect(s.maxScroll).toBe(0);
  });

  it('内容超过可视区：maxScroll = total - visibleRows', () => {
    const s = computeScrollState({ total: 20, visibleRows: 5, scrollTop: 0 });
    expect(s.maxScroll).toBe(15);
  });

  it('scrollTop 超过 maxScroll 时钳位', () => {
    const s = computeScrollState({ total: 20, visibleRows: 5, scrollTop: 999 });
    expect(s.scrollTop).toBe(15);
  });

  it('scrollTop 负数钳到 0', () => {
    const s = computeScrollState({ total: 20, visibleRows: 5, scrollTop: -5 });
    expect(s.scrollTop).toBe(0);
  });

  it('visibleRows=0 防御：maxScroll=total，不除零', () => {
    const s = computeScrollState({ total: 10, visibleRows: 0, scrollTop: 0 });
    expect(s.maxScroll).toBe(10);
  });
});

describe('clampScrollTop', () => {
  it('范围内不变', () => {
    expect(clampScrollTop(5, 10)).toBe(5);
  });
  it('超过 max 钳到 max', () => {
    expect(clampScrollTop(15, 10)).toBe(10);
  });
  it('负数钳到 0', () => {
    expect(clampScrollTop(-3, 10)).toBe(0);
  });
});

describe('sliceVisible（可视区间切片）', () => {
  it('返回 [scrollTop, scrollTop+visibleRows) 区间元素', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const visible = sliceVisible(items, { scrollTop: 2, visibleRows: 3, maxScroll: 7 });
    expect(visible).toEqual(['c', 'd', 'e']);
  });

  it('scrollTop=0 取前 visibleRows 个', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const visible = sliceVisible(items, { scrollTop: 0, visibleRows: 2, maxScroll: 3 });
    expect(visible).toEqual(['a', 'b']);
  });

  it('末尾不足 visibleRows 时取到数组末尾', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const visible = sliceVisible(items, { scrollTop: 3, visibleRows: 10, maxScroll: 0 });
    expect(visible).toEqual(['d', 'e']);
  });

  it('空数组返回空', () => {
    expect(sliceVisible([], { scrollTop: 0, visibleRows: 5, maxScroll: 0 })).toEqual([]);
  });

  it('scrollTop 超过数组长度时返回空', () => {
    const items = ['a', 'b'];
    expect(sliceVisible(items, { scrollTop: 10, visibleRows: 5, maxScroll: 0 })).toEqual([]);
  });
});
