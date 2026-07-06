// src/__tests__/render/screen.test.ts
import { describe, it, expect } from 'vitest';
import { Screen } from '../../render/screen.js';
import { CharPool } from '../../render/char-pool.js';
import { StylePool } from '../../render/style-pool.js';
import { DEFAULT_STYLE } from '../../render/types.js';

function makeScreen(rows: number, cols: number): Screen {
  return new Screen(rows, cols, new CharPool(), new StylePool());
}

describe('Screen', () => {
  it('初始：Int32Array 长度 = rows*cols*2，全 0（空白+默认样式）', () => {
    const s = makeScreen(3, 4);
    expect(s.chars.length).toBe(3 * 4 * 2);
    for (let i = 0; i < s.chars.length; i++) {
      expect(s.chars[i]).toBe(0);
    }
  });

  it('cellAt(0,0) 初始返回 charId=0, encodedStyleId=0', () => {
    const s = makeScreen(2, 2);
    const cell = s.cellAt(0, 0);
    expect(cell.charId).toBe(0);
    expect(cell.encodedStyleId).toBe(0);
  });

  it('cellAt 越界返回 0/0（防御，不抛错）', () => {
    const s = makeScreen(2, 2);
    const cell = s.cellAt(99, 99);
    expect(cell.charId).toBe(0);
    expect(cell.encodedStyleId).toBe(0);
  });

  it('setCell：写入 (x,y) 的 charId + encodedStyleId', () => {
    const s = makeScreen(2, 3);
    s.setCell(1, 0, 42, 10);  // charId=42, encodedStyle=10
    const cell = s.cellAt(1, 0);
    expect(cell.charId).toBe(42);
    expect(cell.encodedStyleId).toBe(10);
  });

  it('setCell 不影响其它 cell', () => {
    const s = makeScreen(2, 3);
    s.setCell(1, 0, 42, 10);
    expect(s.cellAt(0, 0).charId).toBe(0);
    expect(s.cellAt(2, 0).charId).toBe(0);
  });

  it('clear：全部归 0', () => {
    const s = makeScreen(2, 2);
    s.setCell(0, 0, 5, 5);
    s.clear();
    expect(s.cellAt(0, 0).charId).toBe(0);
    expect(s.cellAt(0, 0).encodedStyleId).toBe(0);
  });

  it('resize：重建为新尺寸（数据丢失，全 0）', () => {
    const s = makeScreen(2, 3);
    s.setCell(0, 0, 5, 5);
    s.resize(4, 5);
    expect(s.rows).toBe(4);
    expect(s.cols).toBe(5);
    expect(s.chars.length).toBe(4 * 5 * 2);
    expect(s.cellAt(0, 0).charId).toBe(0);  // 全新
  });
});

describe('Screen pool 引用', () => {
  it('charPool/stylePool 可外部访问', () => {
    const cp = new CharPool();
    const sp = new StylePool();
    const s = new Screen(2, 2, cp, sp);
    expect(s.charPool).toBe(cp);
    expect(s.stylePool).toBe(sp);
  });

  it('换池子引用（resetPools 用）', () => {
    const s = makeScreen(2, 2);
    const newCp = new CharPool();
    const newSp = new StylePool();
    s.charPool = newCp;
    s.stylePool = newSp;
    expect(s.charPool).toBe(newCp);
    expect(s.stylePool).toBe(newSp);
  });
});
