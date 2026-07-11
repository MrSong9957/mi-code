// src/__tests__/tui/input-viewport.test.ts
// 输入框视口窗口计算：固定高度 + 光标居中 + 边界钳位。
//
// 物理本质：长文本上的「取景器」。文本可能任意长，但 footer 只显示 maxVisibleLines 行。
// 光标是相机焦点，视口跟着光标走，光标始终落在窗口内。
//
// 防作弊设计：
// - expect.hasAssertions() 防空跑
// - 随机化输入（Math.random 造 total/cursorLine），断言「不变量」而非硬编码值
// - 模糊断言（toBeGreaterThanOrEqual / toBeLessThanOrEqual / toMatchObject）

import { describe, it, expect } from 'vitest';
import { computeInputViewport, MAX_VISIBLE_INPUT_LINES } from '../../tui/state/input-viewport.js';

describe('input-viewport（输入框视口计算）', () => {
  it('MAX_VISIBLE_INPUT_LINES 是正整数常量', () => {
    expect.hasAssertions();
    expect(Number.isInteger(MAX_VISIBLE_INPUT_LINES)).toBe(true);
    expect(MAX_VISIBLE_INPUT_LINES).toBeGreaterThan(0);
  });

  it('行数 ≤ 上限：viewportTop=0，不滚动', () => {
    expect.hasAssertions();
    // 刚好等于上限
    const vp = computeInputViewport(MAX_VISIBLE_INPUT_LINES, 2, MAX_VISIBLE_INPUT_LINES);
    expect(vp).toMatchObject({ viewportTop: 0, maxScroll: 0 });
    // 少于上限
    const vp2 = computeInputViewport(3, 1, MAX_VISIBLE_INPUT_LINES);
    expect(vp2.viewportTop).toBe(0);
    expect(vp2.maxScroll).toBe(0);
  });

  it('光标居中：超限时 viewportTop = cursorLine - floor(maxVisible/2)', () => {
    expect.hasAssertions();
    // total=10, maxVisible=5, cursor=7 → 居中 7-2=5
    const vp = computeInputViewport(10, 7, MAX_VISIBLE_INPUT_LINES);
    const expectedCenter = 7 - Math.floor(MAX_VISIBLE_INPUT_LINES / 2);
    expect(vp.viewportTop).toBe(expectedCenter);
  });

  it('边界保护：光标在首行时 viewportTop 钳到 0', () => {
    expect.hasAssertions();
    const vp = computeInputViewport(20, 0, MAX_VISIBLE_INPUT_LINES);
    expect(vp.viewportTop).toBe(0);
  });

  it('边界保护：光标在末行时 viewportTop 钳到 maxScroll（不越界）', () => {
    expect.hasAssertions();
    const total = 20;
    const vp = computeInputViewport(total, total - 1, MAX_VISIBLE_INPUT_LINES);
    const expectedMax = total - MAX_VISIBLE_INPUT_LINES;
    expect(vp.viewportTop).toBe(expectedMax);
    expect(vp.maxScroll).toBe(expectedMax);
  });

  it('不变量【防作弊随机化】：光标始终落在视口可见区间内', () => {
    expect.hasAssertions();
    // 随机 20 组 (total, cursorLine)，断言「光标必在 [viewportTop, viewportTop+maxVisible) 内」
    for (let i = 0; i < 20; i++) {
      const maxVisible = MAX_VISIBLE_INPUT_LINES;
      const total = maxVisible + 1 + Math.floor(Math.random() * 30); // 必触发滚动
      const cursorLine = Math.floor(Math.random() * total);
      const vp = computeInputViewport(total, cursorLine, maxVisible);
      const cursorViewportY = cursorLine - vp.viewportTop;
      // 核心不变量：光标在可见区间
      expect(cursorViewportY).toBeGreaterThanOrEqual(0);
      expect(cursorViewportY).toBeLessThan(maxVisible);
      // viewportTop 不越界
      expect(vp.viewportTop).toBeGreaterThanOrEqual(0);
      expect(vp.viewportTop).toBeLessThanOrEqual(vp.maxScroll);
    }
  });

  it('不变量【防作弊随机化 2】：viewportTop 钳位后窗口不超出文本范围', () => {
    expect.hasAssertions();
    // 另一组随机：断言窗口末行 [viewportTop + maxVisible) ≤ total
    for (let i = 0; i < 20; i++) {
      const maxVisible = MAX_VISIBLE_INPUT_LINES;
      const total = 1 + Math.floor(Math.random() * 40);
      const cursorLine = Math.floor(Math.random() * total);
      const vp = computeInputViewport(total, cursorLine, maxVisible);
      const windowEnd = vp.viewportTop + maxVisible;
      // 窗口末行不超过 total（除非 total < maxVisible，此时窗口=total）
      expect(windowEnd).toBeLessThanOrEqual(Math.max(total, maxVisible));
    }
  });

  it('返回结构完整性：含 totalLines/maxVisibleLines/viewportTop/maxScroll 四字段', () => {
    expect.hasAssertions();
    const vp = computeInputViewport(8, 3, MAX_VISIBLE_INPUT_LINES);
    expect(vp).toMatchObject({
      totalLines: 8,
      maxVisibleLines: MAX_VISIBLE_INPUT_LINES,
    });
    expect(typeof vp.viewportTop).toBe('number');
    expect(typeof vp.maxScroll).toBe('number');
  });
});
