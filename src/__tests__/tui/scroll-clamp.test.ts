// src/__tests__/tui/scroll-clamp.test.ts
// Step 8:computeEffectiveScrollTop 决策函数（从 ConnectedApp 内联提取）。
// 本步只新增函数,不接入 ConnectedApp——生产缺陷(漏钳位)在 Step 10 接入后才算修复。

import { describe, it, expect } from 'vitest';
import { computeEffectiveScrollTop } from '../../tui/state/effective-scroll.js';

describe('computeEffectiveScrollTop', () => {
  it('底部(scrolledAway=false):返回 maxScroll(钉底)', () => {
    expect(computeEffectiveScrollTop(false, 5, 10)).toBe(10);
  });
  it('上滚(scrolledAway=true) maxScroll↑:保持旧 scrollTop', () => {
    expect(computeEffectiveScrollTop(true, 5, 10)).toBe(5);
  });
  it('删内容 maxScroll↓:旧 scrollTop>新 maxScroll 钳位', () => {
    expect(computeEffectiveScrollTop(true, 8, 3)).toBe(3);
  });
  it('resize 变窄 maxScroll↑:钳位正确', () => {
    expect(computeEffectiveScrollTop(true, 4, 9)).toBe(4);
  });
  it('resize 变宽 maxScroll↓:旧 scrollTop>新 maxScroll 必须钳位', () => {
    expect(computeEffectiveScrollTop(true, 9, 4)).toBe(4);
  });
});
