// src/__tests__/tui/selection/click-detector.test.ts
// 多击分类：300ms 时序 + 位置偏差≤2 算同位置

import { describe, it, expect } from 'vitest';
import { classifyClick, type ClickState } from '../../../tui/selection/click-detector.js';

describe('classifyClick', () => {
  it('首次点击：single', () => {
    const r = classifyClick(null, 0, 10, 5, 1000);
    expect(r.kind).toBe('single');
    expect(r.state.count).toBe(1);
  });

  it('300ms 内同位置第二次：double', () => {
    let st: ClickState | null = null;
    let r = classifyClick(st, 0, 10, 5, 1000); st = r.state;
    r = classifyClick(st, 0, 10, 5, 1300);
    expect(r.kind).toBe('double');
    expect(r.state.count).toBe(2);
  });

  it('300ms 内同位置第三次：triple', () => {
    let st: ClickState | null = null;
    let r = classifyClick(st, 0, 10, 5, 1000); st = r.state;
    r = classifyClick(st, 0, 10, 5, 1300); st = r.state;
    r = classifyClick(st, 0, 10, 5, 1500);
    expect(r.kind).toBe('triple');
    expect(r.state.count).toBe(3);
  });

  it('第四次回归 single（循环）', () => {
    let st: ClickState | null = null;
    let r = classifyClick(st, 0, 10, 5, 1000); st = r.state;
    r = classifyClick(st, 0, 10, 5, 1300); st = r.state;
    r = classifyClick(st, 0, 10, 5, 1500); st = r.state;
    r = classifyClick(st, 0, 10, 5, 1700);
    expect(r.kind).toBe('single');
    expect(r.state.count).toBe(1);
  });

  it('超 300ms：重新计数 single', () => {
    let st: ClickState | null = null;
    let r = classifyClick(st, 0, 10, 5, 1000); st = r.state;
    r = classifyClick(st, 0, 10, 5, 1400); // 间隔 400ms
    expect(r.kind).toBe('single');
    expect(r.state.count).toBe(1);
  });

  it('位置偏差 >2：重置 single', () => {
    let st: ClickState | null = null;
    let r = classifyClick(st, 0, 10, 5, 1000); st = r.state;
    r = classifyClick(st, 0, 13, 5, 1300); // col 偏差 3
    expect(r.kind).toBe('single');
  });

  it('位置偏差 ≤2（边界）：算同位置 double', () => {
    let st: ClickState | null = null;
    let r = classifyClick(st, 0, 10, 5, 1000); st = r.state;
    r = classifyClick(st, 0, 12, 7, 1300); // col+2 row+2
    expect(r.kind).toBe('double');
  });

  it('换键（button 变）：重置 single', () => {
    let st: ClickState | null = null;
    let r = classifyClick(st, 0, 10, 5, 1000); st = r.state;
    r = classifyClick(st, 2, 10, 5, 1300); // 右键
    expect(r.kind).toBe('single');
  });

  it('刚好 300ms 边界：算同位置（含端点）', () => {
    let st: ClickState | null = null;
    let r = classifyClick(st, 0, 10, 5, 1000); st = r.state;
    r = classifyClick(st, 0, 10, 5, 1300); // 正好 300ms
    expect(r.kind).toBe('double');
  });
});
