// 单测：cell.ts —— 格子 + 样式打包 + 显示宽度
//
// 物理本质：给画布上每个小方格贴一个"字符标签 + 样式标签"。
// 显示宽度：一个字符在终端里横向占几个格子（中文/全角=2，半角=1）。

import { describe, it, expect } from 'vitest';
import {
  type Style,
  EMPTY_CELL,
  makeCell,
  cellsEqual,
  packStyle,
  stringWidth,
  stringToCells,
} from '../renderer/cell.js';
import { setColorLevel } from '../renderer/colors.js';

describe('cell module', () => {
  setColorLevel('ansi16'); // 测试固定 16 色模式，断言 \x1b[3Xm 码
  describe('Style 与 Cell 构造', () => {
    it('EMPTY_CELL 是空格 + 默认样式', () => {
      expect(EMPTY_CELL.char).toBe(' ');
      expect(EMPTY_CELL.style).toEqual({});
    });

    it('makeCell 默认字符为空格', () => {
      const c = makeCell();
      expect(c.char).toBe(' ');
    });

    it('makeCell 带字符与样式', () => {
      const c = makeCell('A', { fg: 'red', bold: true });
      expect(c.char).toBe('A');
      expect(c.style.fg).toBe('red');
      expect(c.style.bold).toBe(true);
    });

    it('makeCell 强制单字符（多字符只取首个）', () => {
      expect(makeCell('XYZ').char).toBe('X');
    });
  });

  describe('cellsEqual', () => {
    it('字符与样式都相同 → true', () => {
      expect(cellsEqual(makeCell('A', { fg: 'red' }), makeCell('A', { fg: 'red' }))).toBe(true);
    });
    it('字符不同 → false', () => {
      expect(cellsEqual(makeCell('A'), makeCell('B'))).toBe(false);
    });
    it('样式不同 → false', () => {
      expect(cellsEqual(makeCell('A', { fg: 'red' }), makeCell('A', { fg: 'blue' }))).toBe(false);
    });
    it('空样式对象与 undefined 视为相等', () => {
      expect(cellsEqual(makeCell('A', {}), makeCell('A'))).toBe(true);
    });
    it('bold 开关不同 → false', () => {
      expect(cellsEqual(makeCell('A', { bold: true }), makeCell('A', { bold: false }))).toBe(false);
    });
  });

  describe('packStyle', () => {
    it('空样式 → 空串', () => {
      expect(packStyle({})).toBe('');
      expect(packStyle(undefined)).toBe('');
    });
    it('包含 fg → 含 SGR 前景码并以 reset 结尾', () => {
      const s = packStyle({ fg: 'red' });
      expect(s).toContain('\x1b[31m');
      expect(s.endsWith('\x1b[0m')).toBe(true);
    });
    it('bold + fg 组合', () => {
      const s = packStyle({ bold: true, fg: 'green' });
      expect(s).toContain('\x1b[1m');
      expect(s).toContain('\x1b[32m');
    });
    it('dim + italic + underline', () => {
      const s = packStyle({ dim: true, italic: true, underline: true });
      expect(s).toContain('\x1b[2m');
      expect(s).toContain('\x1b[3m');
      expect(s).toContain('\x1b[4m');
    });
    it('相同样式打包结果稳定（可缓存）', () => {
      const a = packStyle({ fg: 'cyan', bold: true });
      const b = packStyle({ fg: 'cyan', bold: true });
      expect(a).toBe(b);
    });
  });

  describe('stringWidth', () => {
    it('ASCII 半角每个占 1', () => {
      expect(stringWidth('abc')).toBe(3);
    });
    it('中文每个占 2', () => {
      expect(stringWidth('中文')).toBe(4);
    });
    it('中英混合', () => {
      expect(stringWidth('中文ab')).toBe(6);
    });
    it('全角标点占 2', () => {
      expect(stringWidth('，。')).toBe(4);
    });
    it('空串 → 0', () => {
      expect(stringWidth('')).toBe(0);
    });
    it('含 emoji（代理对）占 2', () => {
      // 😀 是 U+1F600，UTF-16 代理对
      expect(stringWidth('😀')).toBe(2);
    });
  });

  describe('stringToCells', () => {
    it('ASCII → 每字符一个 cell', () => {
      const cells = stringToCells('Hi');
      expect(cells).toHaveLength(2);
      expect(cells[0]!.char).toBe('H');
      expect(cells[1]!.char).toBe('i');
    });
    it('中文 → 每字符一个 cell（不拆字节）', () => {
      const cells = stringToCells('中');
      expect(cells).toHaveLength(1);
      expect(cells[0]!.char).toBe('中');
    });
    it('带样式', () => {
      const cells = stringToCells('A', { fg: 'red' });
      expect(cells[0]!.style.fg).toBe('red');
    });
    it('emoji 不被拆成代理对两半', () => {
      const cells = stringToCells('😀');
      expect(cells).toHaveLength(1);
      expect(cells[0]!.char).toBe('😀');
    });
    it('代理对在 stringWidth 上的宽度可被算回', () => {
      const cells = stringToCells('a😀b');
      expect(cells).toHaveLength(3);
      expect(stringWidth(cells.map(c => c.char).join(''))).toBe(4);
    });
  });

  describe('Style 类型完整性', () => {
    it('Style 支持所有已知属性', () => {
      const style: Style = { fg: 'red', bg: 'blue', bold: true, dim: true, italic: true, underline: true };
      const s = packStyle(style);
      expect(s).toContain('\x1b[31m'); // fg red
      expect(s).toContain('\x1b[44m'); // bg blue
    });
  });
});
