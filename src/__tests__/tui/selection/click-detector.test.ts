// src/__tests__/tui/selection/click-detector.test.ts
// 多击分类：single/double/triple 主流程
// 精简版：保留单/双/三击主链路，删除 ms 精度/位置偏差/换键边界穷举

import { describe, it, expect } from 'vitest';
import { classifyClick, type ClickState } from '../../../tui/selection/click-detector.js';

describe('classifyClick', () => {
  it('首次点击：single', () => {
    const r = classifyClick(null, 0, 10, 5, 1000);
    expect(r.kind).toBe('single');
  });

  it('300ms 内同位置连续：single → double → triple', () => {
    let st: ClickState | null = null;
    let r = classifyClick(st, 0, 10, 5, 1000); st = r.state;
    expect(r.kind).toBe('single');
    r = classifyClick(st, 0, 10, 5, 1300); st = r.state;
    expect(r.kind).toBe('double');
    r = classifyClick(st, 0, 10, 5, 1500);
    expect(r.kind).toBe('triple');
  });
});
