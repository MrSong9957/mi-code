import { describe, it, expect, beforeEach } from 'vitest';
import { LayoutScheduler } from '../../output/layout-scheduler.js';

describe('LayoutScheduler', () => {
  let scheduler: LayoutScheduler;

  beforeEach(() => {
    scheduler = new LayoutScheduler({ rows: 24, cols: 80 });
  });

  describe('calculateLayout', () => {
    it('should calculate basic layout', () => {
      const layout = scheduler.calculateLayout({
        messageLines: 10,
        inputLines: 1,
      });

      expect(layout.messageArea.startY).toBe(0);
      expect(layout.messageArea.height).toBe(10);
      expect(layout.inputArea.startY).toBe(11); // 10 (messages) + 1 (top border)
      expect(layout.inputArea.height).toBe(1);
      expect(layout.statusBar.y).toBe(13); // 10 + 2 (borders) + 1 (input)
    });

    it('should handle content overflow', () => {
      const layout = scheduler.calculateLayout({
        messageLines: 100,
        inputLines: 1,
      });

      // 内容超出终端高度时，viewport 取最后 N 行
      // contentHeight = 100 + 2 (border) + 1 (input) + 1 (status) = 104
      // viewportY = max(0, 104 - 24) = 80
      expect(layout.viewportY).toBe(80);
      expect(layout.contentHeight).toBe(104);
    });

    it('should handle multi-line input', () => {
      const layout = scheduler.calculateLayout({
        messageLines: 5,
        inputLines: 3,
      });

      expect(layout.inputArea.startY).toBe(6); // 5 (messages) + 1 (top border)
      expect(layout.inputArea.height).toBe(3);
    });
  });

  describe('getViewportY', () => {
    it('should return 0 when content fits', () => {
      expect(scheduler.getViewportY(10)).toBe(0);
    });

    it('should return correct offset when content overflows', () => {
      expect(scheduler.getViewportY(100)).toBe(76); // 100 - 24
    });
  });

  describe('updateTermSize', () => {
    it('should update terminal size', () => {
      scheduler.updateTermSize({ rows: 40, cols: 120 });
      const layout = scheduler.calculateLayout({
        messageLines: 10,
        inputLines: 1,
      });
      // 40 rows now, so no overflow
      expect(layout.viewportY).toBe(0);
    });
  });
});
