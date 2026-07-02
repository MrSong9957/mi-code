// 单测：ansi.ts —— CSI/DEC 转义原语
//
// 物理本质：搬运/擦格子的"指令积木"。每个函数返回一段固定字节串，
// 上层把它拼成完整的终端指令。约定：屏幕坐标全部 0-based（row 0=顶行，col 0=最左列）。

import { describe, it, expect } from 'vitest';
import {
  cr, eraseLine, eraseScreen, cursorHome,
  cursorUp, cursorDown, cursorForward, cursorBack,
  cursorMove, cup, cursorColumn,
  enterAltScreen, exitAltScreen,
  showCursor, hideCursor,
  bsu, esu,
  enableMouseTracking, disableMouseTracking,
  enableAutowrap, disableAutowrap,
  setScrollRegion, resetScrollRegion,
  saveCursor, restoreCursor,
} from '../renderer/ansi.js';

describe('ansi primitives', () => {
  describe('单字节 / 整行 / 整屏操作', () => {
    it('cr 返回回车（回本行最左）', () => {
      expect(cr()).toBe('\r');
    });
    it('eraseLine 擦整行', () => {
      expect(eraseLine()).toBe('\x1b[2K');
    });
    it('eraseScreen 擦整屏', () => {
      expect(eraseScreen()).toBe('\x1b[2J');
    });
    it('cursorHome 回左上角原点', () => {
      expect(cursorHome()).toBe('\x1b[H');
    });
  });

  describe('相对移动（CUU/CUD/CUF/CUB）', () => {
    it('cursorUp(n) 往上 n 行', () => expect(cursorUp(3)).toBe('\x1b[3A'));
    it('cursorDown(n) 往下 n 行', () => expect(cursorDown(4)).toBe('\x1b[4B'));
    it('cursorForward(n) 往右 n 格', () => expect(cursorForward(2)).toBe('\x1b[2C'));
    it('cursorBack(n) 往左 n 格', () => expect(cursorBack(5)).toBe('\x1b[5D'));
    it('n=0 不发指令', () => {
      expect(cursorUp(0)).toBe('');
      expect(cursorDown(0)).toBe('');
      expect(cursorForward(0)).toBe('');
      expect(cursorBack(0)).toBe('');
    });
    it('n<0 视为 0（防御）', () => {
      expect(cursorUp(-1)).toBe('');
      expect(cursorForward(-2)).toBe('');
    });
  });

  describe('cursorMove(dx, dy) 组合相对移动（dx=列，+=右；dy=行，+=下）', () => {
    it('dx>0, dy>0 → 先右后下', () => {
      expect(cursorMove(2, 3)).toBe('\x1b[2C\x1b[3B');
    });
    it('dx<0, dy<0 → 先左后上', () => {
      expect(cursorMove(-2, -3)).toBe('\x1b[2D\x1b[3A');
    });
    it('dx>0, dy<0 → 先右后上', () => {
      expect(cursorMove(2, -3)).toBe('\x1b[2C\x1b[3A');
    });
    it('dx=0, dy=0 → 空串', () => {
      expect(cursorMove(0, 0)).toBe('');
    });
    it('仅 dx', () => {
      expect(cursorMove(5, 0)).toBe('\x1b[5C');
    });
    it('仅 dy', () => {
      expect(cursorMove(0, 5)).toBe('\x1b[5B');
    });
  });

  describe('绝对定位（0-based 网格 → 1-based ANSI）', () => {
    it('cup(0,0) → 左上角（1;1）', () => {
      expect(cup(0, 0)).toBe('\x1b[1;1H');
    });
    it('cup(row,col) 把 0-based 转成 1-based', () => {
      expect(cup(5, 6)).toBe('\x1b[6;7H');
    });
    it('cursorColumn(col) 0-based → 1-based（CHA）', () => {
      expect(cursorColumn(0)).toBe('\x1b[1G');
      expect(cursorColumn(9)).toBe('\x1b[10G');
    });
  });

  describe('DEC 私有模式', () => {
    it('enterAltScreen / exitAltScreen（DEC 1049）', () => {
      expect(enterAltScreen()).toBe('\x1b[?1049h');
      expect(exitAltScreen()).toBe('\x1b[?1049l');
    });
    it('showCursor / hideCursor（DEC 25）', () => {
      expect(showCursor()).toBe('\x1b[?25h');
      expect(hideCursor()).toBe('\x1b[?25l');
    });
    it('bsu / esu（DEC 2026 同步更新）', () => {
      expect(bsu()).toBe('\x1b[?2026h');
      expect(esu()).toBe('\x1b[?2026l');
    });
    it('enableAutowrap / disableAutowrap（DEC 7）', () => {
      expect(enableAutowrap()).toBe('\x1b[?7h');
      expect(disableAutowrap()).toBe('\x1b[?7l');
    });
    it('enableMouseTracking（1000 + 1006 SGR）', () => {
      expect(enableMouseTracking()).toBe('\x1b[?1000h\x1b[?1006h');
    });
    it('disableMouseTracking（反序：先 1006 再 1000）', () => {
      expect(disableMouseTracking()).toBe('\x1b[?1006l\x1b[?1000l');
    });
  });

  describe('滚动区域 DECSTBM + 光标存取', () => {
    it('setScrollRegion(top, bottom) 0-based → 1-based（DECSTBM \\x1b[top;bottom r）', () => {
      // top=0, bottom=20 → region 覆盖行 0..20（1-based 1..21）
      expect(setScrollRegion(0, 20)).toBe('\x1b[1;21r');
    });
    it('setScrollRegion(2, 9) → \\x1b[3;10r', () => {
      expect(setScrollRegion(2, 9)).toBe('\x1b[3;10r');
    });
    it('resetScrollRegion() 重置为全屏（空参数 DECSTBM）', () => {
      expect(resetScrollRegion()).toBe('\x1b[r');
    });
    it('saveCursor / restoreCursor（DECSC/DECRC）', () => {
      expect(saveCursor()).toBe('\x1b[s');
      expect(restoreCursor()).toBe('\x1b[u');
    });
  });
});
