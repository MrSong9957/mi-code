// 单测：screen.ts —— 画布 ScreenBuffer（rows×cols 二维格子网格）
//
// 物理本质：一张和屏幕一样大的格子纸。每格贴一个字符+样式。
// 渲染器用它表示"一帧"——新旧两张格子纸逐格比对就是 diff。

import { describe, it, expect } from 'vitest';
import { Screen } from '../renderer/screen.js';
import { makeCell } from '../renderer/cell.js';

describe('Screen', () => {
  describe('构造与基本属性', () => {
    it('构造时尺寸正确', () => {
      const s = new Screen(5, 10);
      expect(s.rows).toBe(5);
      expect(s.cols).toBe(10);
    });
    it('构造后全空（每个格子是空格）', () => {
      const s = new Screen(3, 3);
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 3; x++) {
          expect(s.getCell(x, y).char).toBe(' ');
        }
      }
    });
    it('零尺寸不崩', () => {
      const s = new Screen(0, 0);
      expect(s.rows).toBe(0);
      expect(s.cols).toBe(0);
    });
  });

  describe('setCell / getCell', () => {
    it('写入后读出一致', () => {
      const s = new Screen(3, 3);
      s.setCell(1, 2, makeCell('A', { fg: 'red' }));
      expect(s.getCell(1, 2).char).toBe('A');
      expect(s.getCell(1, 2).style.fg).toBe('red');
    });
    it('坐标越界静默忽略（不抛错）', () => {
      const s = new Screen(3, 3);
      expect(() => s.setCell(10, 10, makeCell('X'))).not.toThrow();
      // 越界读取返回空 cell
      expect(s.getCell(10, 10).char).toBe(' ');
    });
    it('负坐标忽略', () => {
      const s = new Screen(3, 3);
      expect(() => s.setCell(-1, 0, makeCell('X'))).not.toThrow();
    });
  });

  describe('writeRow —— 写一整行文本', () => {
    it('把字符串从指定列开始铺进某一行', () => {
      const s = new Screen(3, 10);
      s.writeRow(0, 'Hello', {});
      expect(s.getCell(0, 0).char).toBe('H');
      expect(s.getCell(4, 0).char).toBe('o');
      expect(s.getCell(5, 0).char).toBe(' '); // 后面保持空
    });
    it('带样式', () => {
      const s = new Screen(1, 5);
      s.writeRow(0, 'AB', { fg: 'cyan' });
      expect(s.getCell(0, 0).style.fg).toBe('cyan');
      expect(s.getCell(1, 0).style.fg).toBe('cyan');
    });
    it('宽字符占两格：第二格为占位（读到也是该宽字符，但宽度=2）', () => {
      const s = new Screen(1, 5);
      s.writeRow(0, '中', {});
      expect(s.getCell(0, 0).char).toBe('中');
      // 第 1 列是宽字符的延续占位（实现细节：可读，但渲染层应跳过）
      // 不强制占位内容，只校验后续 ASCII 不与"中"叠字
      s.writeRow(0, '中A', {});
      expect(s.getCell(0, 0).char).toBe('中');
      expect(s.getCell(2, 0).char).toBe('A'); // A 落在第 2 列（中占 0,1）
    });
    it('超出宽度的部分被裁剪', () => {
      const s = new Screen(1, 3);
      s.writeRow(0, 'ABCDE', {});
      expect(s.getCell(0, 0).char).toBe('A');
      expect(s.getCell(2, 0).char).toBe('C');
      // 没有 D（被裁）
    });
    it('可从指定起始列写入', () => {
      const s = new Screen(1, 5);
      s.writeRow(0, 'X', {}, 2);
      expect(s.getCell(2, 0).char).toBe('X');
      expect(s.getCell(0, 0).char).toBe(' ');
    });
  });

  describe('clearRow / clear', () => {
    it('clearRow 把某行清空', () => {
      const s = new Screen(2, 3);
      s.writeRow(0, 'ABC', {});
      s.clearRow(0);
      expect(s.getCell(0, 0).char).toBe(' ');
      expect(s.getCell(2, 0).char).toBe(' ');
    });
    it('clear 清空整屏', () => {
      const s = new Screen(2, 2);
      s.writeRow(0, 'AB', {});
      s.writeRow(1, 'CD', {});
      s.clear();
      expect(s.getCell(0, 0).char).toBe(' ');
      expect(s.getCell(0, 1).char).toBe(' ');
    });
  });

  describe('clone', () => {
    it('深拷贝：改原不影响副本', () => {
      const s = new Screen(2, 2);
      s.writeRow(0, 'AB', { fg: 'red' });
      const c = s.clone();
      s.setCell(0, 0, makeCell('Z'));
      expect(c.getCell(0, 0).char).toBe('A'); // 副本不变
      expect(s.getCell(0, 0).char).toBe('Z');
    });
    it('副本尺寸一致', () => {
      const s = new Screen(4, 7);
      const c = s.clone();
      expect(c.rows).toBe(4);
      expect(c.cols).toBe(7);
    });
  });

  describe('resize', () => {
    it('放大：旧内容保留，新增区域为空', () => {
      const s = new Screen(2, 2);
      s.writeRow(0, 'AB', {});
      s.resize(3, 3);
      expect(s.rows).toBe(3);
      expect(s.cols).toBe(3);
      expect(s.getCell(0, 0).char).toBe('A'); // 旧内容保留
      expect(s.getCell(1, 0).char).toBe('B');
      expect(s.getCell(2, 2).char).toBe(' '); // 新区域空
    });
    it('缩小：超出部分裁掉', () => {
      const s = new Screen(3, 3);
      s.writeRow(2, 'XYZ', {});
      s.resize(2, 2);
      expect(s.rows).toBe(2);
      expect(s.cols).toBe(2);
      expect(s.getCell(0, 0).char).toBe(' ');
    });
  });

  describe('diffCells —— 逐格比对助手', () => {
    it('返回变化格子的坐标列表', () => {
      const a = new Screen(2, 2);
      const b = a.clone();
      b.setCell(0, 0, makeCell('X'));
      b.setCell(1, 1, makeCell('Y'));
      const diffs = Screen.diffCells(a, b);
      expect(diffs).toContainEqual([0, 0]);
      expect(diffs).toContainEqual([1, 1]);
      expect(diffs).toHaveLength(2);
    });
    it('全同 → 空列表', () => {
      const a = new Screen(2, 2);
      const b = a.clone();
      expect(Screen.diffCells(a, b)).toHaveLength(0);
    });
  });
});
