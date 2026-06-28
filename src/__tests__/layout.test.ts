// 单测：layout.ts —— 分区算术
//
// 物理本质：竖着把书桌切两格——上面大格（消息区，占满剩余高度），
// 下面小格（状态栏 + 输入框，钉死底部）。由 (rows, cols) 算每区的 y 偏移与高度。
// 分家靠纯算术（flexbox 思路），不靠 DECSTBM（文档§5.2）。

import { describe, it, expect } from 'vitest';
import { computeLayout, type LayoutOptions } from '../renderer/layout.js';

describe('computeLayout', () => {
  describe('标准分区', () => {
    it('20×80：状态栏 1 行 + 输入框 1 行 → 消息区 height=18', () => {
      const layout = computeLayout(20, 80, { statusBarHeight: 1, inputHeight: 1 });
      expect(layout.message.top).toBe(0);
      expect(layout.message.height).toBe(18);
      expect(layout.statusBar.top).toBe(18);
      expect(layout.statusBar.height).toBe(1);
      expect(layout.input.top).toBe(19);
      expect(layout.input.height).toBe(1);
    });

    it('消息区 + 状态栏 + 输入框 高度之和 = rows', () => {
      const layout = computeLayout(30, 100, { statusBarHeight: 1, inputHeight: 2 });
      const total = layout.message.height + layout.statusBar.height + layout.input.height;
      expect(total).toBe(30);
    });

    it('各区域 top 连续无重叠', () => {
      const layout = computeLayout(24, 80, { statusBarHeight: 1, inputHeight: 1 });
      expect(layout.statusBar.top).toBe(layout.message.top + layout.message.height);
      expect(layout.input.top).toBe(layout.statusBar.top + layout.statusBar.height);
    });
  });

  describe('输入框多行', () => {
    it('输入框 2 行时，消息区相应减少', () => {
      const layout = computeLayout(20, 80, { statusBarHeight: 1, inputHeight: 2 });
      expect(layout.message.height).toBe(17);
      expect(layout.input.height).toBe(2);
      expect(layout.input.top).toBe(18);
    });
  });

  describe('极端尺寸', () => {
    it('刚好够页脚（rows = status + input）→ 消息区 height=0', () => {
      const layout = computeLayout(2, 80, { statusBarHeight: 1, inputHeight: 1 });
      expect(layout.message.height).toBe(0);
      expect(layout.statusBar.height).toBe(1);
      expect(layout.input.height).toBe(1);
    });
    it('不够页脚 → 页脚优先，消息区 0，页脚可能被压', () => {
      // rows=1，但需要 2 行页脚：保证不返回负数
      const layout = computeLayout(1, 80, { statusBarHeight: 1, inputHeight: 1 });
      expect(layout.message.height).toBeGreaterThanOrEqual(0);
      expect(layout.input.top).toBeGreaterThanOrEqual(0);
    });
    it('cols 宽度直接透传', () => {
      const layout = computeLayout(20, 100, {});
      expect(layout.cols).toBe(100);
    });
  });

  describe('默认值', () => {
    it('不传 options → 默认 status=1, input=1', () => {
      const layout = computeLayout(10, 80);
      expect(layout.message.height).toBe(8);
      expect(layout.statusBar.height).toBe(1);
      expect(layout.input.height).toBe(1);
    });
  });

  describe('页脚总高度助手', () => {
    it('footerHeight = status + input', () => {
      const layout = computeLayout(20, 80, { statusBarHeight: 1, inputHeight: 1 });
      expect(layout.footerHeight).toBe(2);
    });
    it('footerTop = statusBar.top', () => {
      const layout = computeLayout(20, 80, {});
      expect(layout.footerTop).toBe(layout.statusBar.top);
    });
  });
});

// 让类型被引用（确保导出形状稳定）
const _opts: LayoutOptions = { statusBarHeight: 1, inputHeight: 1 };
void _opts;
