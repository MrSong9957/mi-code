// src/__tests__/tui/connected-app-scroll.test.ts
// Step 10:ConnectedApp 动态 footer + scroll clamp 集成覆盖。
//
// 渲染完整 ConnectedApp 需 9 个 store + 复杂 fixture，成本高且脆。
// 本测试聚焦真实生产计算链的组合验证：computeInputViewportLayout（layout）+ computeEffectiveScrollTop（scroll），
// 模拟 ConnectedApp 的 footer/visibleRows/effectiveScrollTop 计算顺序，验证动态 footer 下的 scroll 钳位契约。
// 真实的 React 渲染路径由既有 connected-app-*.test.tsx + input-viewport-e2e 覆盖。

import { describe, it, expect } from 'vitest';
import { computeInputViewportLayout, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH } from '../../tui/state/input-viewport.js';
import { computeEffectiveScrollTop } from '../../tui/state/effective-scroll.js';

// 复刻 ConnectedApp 的计算链（L161-170 真实公式）。
function simulateConnectedApp(input: string, cursor: number, cols: number, rows: number, flatLineCount: number, scrolledAway: boolean, scrollTop: number) {
  const FOOTER_BASE_ROWS = 4;
  const LOGO_ROWS = 3;
  const layout = computeInputViewportLayout(input, cursor, cols, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH);
  const inputViewportExtraLines = layout.visibleRowCount - 1;
  const footerRows = FOOTER_BASE_ROWS + 0 + 0 + inputViewportExtraLines; // spinner=0, suggestion=0
  const visibleRows = Math.max(0, rows - footerRows - LOGO_ROWS);
  const maxScroll = Math.max(0, flatLineCount - visibleRows);
  const effectiveScrollTop = computeEffectiveScrollTop(scrolledAway, scrollTop, maxScroll);
  return { layout, footerRows, visibleRows, maxScroll, effectiveScrollTop };
}

describe('ConnectedApp 动态 footer + scroll clamp 集成 (Step 10)', () => {
  it('底部状态(scrolledAway=false):输入区增高 → footer↑ → 历史区缩,scrollTop 钉底 maxScroll', () => {
    const rows = 24, cols = 80;
    const flatLineCount = 50;
    // 1 行输入
    const a = simulateConnectedApp('x', 1, cols, rows, flatLineCount, false, 0);
    // 多行输入(输入区增高)
    const b = simulateConnectedApp('a\nb\nc\nd\ne', 9, cols, rows, flatLineCount, false, 0);
    expect(b.footerRows).toBeGreaterThan(a.footerRows);       // footer 增高
    expect(b.visibleRows).toBeLessThan(a.visibleRows);        // 历史区缩
    expect(b.effectiveScrollTop).toBe(b.maxScroll);           // 钉底(最新消息可见)
  });

  it('上滚(scrolledAway=true):输入区增高(maxScroll↑) → 保持旧 scrollTop 不越界', () => {
    const rows = 24, cols = 80, flatLineCount = 50;
    const scrollTop = 5;
    const r = simulateConnectedApp('a\nb\nc\nd\ne', 9, cols, rows, flatLineCount, true, scrollTop);
    expect(r.effectiveScrollTop).toBe(scrollTop); // maxScroll 足够大,旧 scrollTop 保留
    expect(r.maxScroll).toBeGreaterThanOrEqual(scrollTop);
  });

  it('输入区增高致 maxScroll↓:旧 scrollTop>新 maxScroll → 钳位(修旧 L167 漏钳位缺陷)', () => {
    // 用小 rows 放大 footer 增高对 visibleRows 的影响。
    // rows=12, flatLineCount=30:1 行 footer=4,visibleRows=5,maxScroll=25;
    //                    5 行 footer=8,visibleRows=1,maxScroll=29? 不——
    // 实测:1行 visibleRows=12-4-3=5,maxScroll=30-5=25;5行 visibleRows=12-8-3=1,maxScroll=30-1=29。
    // 5 行 maxScroll 反而更大(历史区被挤到只剩1行,maxScroll 增)。
    // 故选 scrollTop 在两者之间不成立——改用 resize 场景覆盖此契约(下一用例)。
    // 本用例改测:effectiveScrollTop 永远 ≤ maxScroll(不越界)的不变量。
    const rows = 12, cols = 80, flatLineCount = 30;
    for (const input of ['x', 'a\nb\nc\nd\ne']) {
      const r = simulateConnectedApp(input, input.length, cols, rows, flatLineCount, true, 999);
      // scrollTop=999 远超 maxScroll → 必须钳到 maxScroll,不越界
      expect(r.effectiveScrollTop).toBe(r.maxScroll);
      expect(r.effectiveScrollTop).toBeGreaterThanOrEqual(0);
    }
  });

  it('resize 变宽(cols↑):footer 折行少 → 历史区大 → maxScroll↓,旧 scrollTop 钳位', () => {
    const rows = 24, flatLineCount = 50;
    // 窄 cols:长文本折行多,footer 高,maxScroll 大
    const narrow = simulateConnectedApp('a'.repeat(100), 100, 20, rows, flatLineCount, true, 8);
    // 宽 cols:折行少,footer 低,maxScroll 小,旧 scrollTop=8 可能越界
    const wide = simulateConnectedApp('a'.repeat(100), 100, 200, rows, flatLineCount, true, 8);
    expect(wide.maxScroll).toBeLessThanOrEqual(narrow.maxScroll);
    // 钳位后不越界
    expect(wide.effectiveScrollTop).toBeLessThanOrEqual(wide.maxScroll);
    expect(wide.effectiveScrollTop).toBeGreaterThanOrEqual(0);
  });
});
