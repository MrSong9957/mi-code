// 单测：status-bar.ts —— 状态栏内容拼装
//
// 物理本质：把"当前在用什么模型、在哪个分支、正在跑什么工具"这些状态，
// 拼成一行格子（cells），钉在屏幕底部状态栏那一行。

import { describe, it, expect } from 'vitest';
import { buildStatusBar, type StatusBarState } from '../renderer/status-bar.js';
import { stringWidth } from '../renderer/cell.js';

function cellsText(cells: ReturnType<typeof buildStatusBar>): string {
  return cells.map(c => c.char).join('');
}

describe('buildStatusBar', () => {
  describe('基本内容', () => {
    it('包含 model 与 branch', () => {
      const cells = buildStatusBar({
        model: 'claude-3',
        branch: 'main',
        cols: 80,
      } as StatusBarState);
      const text = cellsText(cells);
      expect(text).toContain('claude-3');
      expect(text).toContain('main');
    });

    it('空闲时不显示工具进度', () => {
      const cells = buildStatusBar({
        model: 'm', branch: 'b', cols: 80,
      } as StatusBarState);
      const text = cellsText(cells);
      expect(text).not.toContain('running');
      expect(text).not.toContain('⏳');
    });

    it('工具运行中显示工具名 + 进行中标记', () => {
      const cells = buildStatusBar({
        model: 'm', branch: 'b', cols: 80,
        tool: { name: 'read_file', status: 'running' },
      } as StatusBarState);
      const text = cellsText(cells);
      expect(text).toContain('read_file');
    });
  });

  describe('宽度截断', () => {
    it('宽度不足时截断到 cols，不溢出', () => {
      const cells = buildStatusBar({
        model: 'very-long-model-name-here',
        branch: 'feature-branch-name',
        cols: 10,
      } as StatusBarState);
      expect(stringWidth(cellsText(cells))).toBeLessThanOrEqual(10);
    });
    it('cols=0 → 空行', () => {
      const cells = buildStatusBar({
        model: 'm', branch: 'b', cols: 0,
      } as StatusBarState);
      expect(cells).toHaveLength(0);
    });
  });

  describe('样式', () => {
    it('状态栏用 RGB 明亮色（不再用 dim 压暗）', () => {
      const cells = buildStatusBar({
        model: 'm', branch: 'b', cols: 80,
      } as StatusBarState);
      // 不应有任何 cell 带 dim（dim 会污染后续渲染，已移除）
      expect(cells.every(c => !c.style.dim)).toBe(true);
      // 应有 RGB 颜色（truecolor 明亮色）
      expect(cells.some(c => typeof c.style.fg === 'string' && c.style.fg.startsWith('rgb:'))).toBe(true);
    });
    it('工具运行中相关标记带颜色（醒目）', () => {
      const cells = buildStatusBar({
        model: 'm', branch: 'b', cols: 80,
        tool: { name: 'bash', status: 'running' },
      } as StatusBarState);
      // 至少有非 dim 的彩色 cell
      expect(cells.some(c => c.style.fg && !c.style.dim)).toBe(true);
    });
  });

  describe('稳定性（可缓存）', () => {
    it('相同输入产出相同内容', () => {
      const state = { model: 'm', branch: 'b', cols: 80 } as StatusBarState;
      const a = cellsText(buildStatusBar(state));
      const b = cellsText(buildStatusBar(state));
      expect(a).toBe(b);
    });
    it('状态变化时内容变化', () => {
      const idle = cellsText(buildStatusBar({ model: 'm', branch: 'b', cols: 80 } as StatusBarState));
      const running = cellsText(buildStatusBar({
        model: 'm', branch: 'b', cols: 80,
        tool: { name: 'bash', status: 'running' },
      } as StatusBarState));
      expect(idle).not.toBe(running);
    });
  });
});
