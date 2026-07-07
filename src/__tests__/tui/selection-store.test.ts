// src/__tests__/tui/selection-store.test.ts
// 字符级选区 store：Point{row,col} + L 型 colsForRow + scrolledOff 缓存

import { describe, it, expect } from 'vitest';
import { createSelectionStore } from '../../tui/state/selection-store.js';

describe('selection-store（Point 字符级）', () => {
  it('初始：无选区，isDragging=false，缓存空', () => {
    const s = createSelectionStore().getState();
    expect(s.anchor).toBeNull();
    expect(s.focus).toBeNull();
    expect(s.isDragging).toBe(false);
    expect(s.scrolledOffAbove).toEqual([]);
    expect(s.scrolledOffBelow).toEqual([]);
    expect(s.anchorSpan).toBeNull();
    expect(s.lastClickKind).toBeNull();
  });

  it('startDrag(p)：设 anchor=focus=p，isDragging=true', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 5, col: 3 });
    const s = store.getState();
    expect(s.anchor).toEqual({ row: 5, col: 3 });
    expect(s.focus).toEqual({ row: 5, col: 3 });
    expect(s.isDragging).toBe(true);
    expect(s.lastClickKind).toBe('single');
  });

  it('startDrag 带 kind=double', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 5, col: 3 }, 'double');
    expect(store.getState().lastClickKind).toBe('double');
  });

  it('dragTo：更新 focus，anchor 不变', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 3, col: 2 });
    store.getState().dragTo({ row: 7, col: 8 });
    const s = store.getState();
    expect(s.anchor).toEqual({ row: 3, col: 2 });
    expect(s.focus).toEqual({ row: 7, col: 8 });
  });

  it('dragTo 在 anchor=null 时无效（防御）', () => {
    const store = createSelectionStore();
    store.getState().dragTo({ row: 7, col: 8 });
    expect(store.getState().focus).toBeNull();
  });

  it('endDrag：isDragging=false，保留 anchor/focus', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 3, col: 2 });
    store.getState().dragTo({ row: 7, col: 8 });
    store.getState().endDrag();
    const s = store.getState();
    expect(s.isDragging).toBe(false);
    expect(s.anchor).toEqual({ row: 3, col: 2 });
    expect(s.focus).toEqual({ row: 7, col: 8 });
  });

  it('clear：清空全部（含缓存）', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 3, col: 2 });
    store.getState().selectLineAt(5, 'xxxx');
    store.getState().clear();
    const s = store.getState();
    expect(s.anchor).toBeNull();
    expect(s.focus).toBeNull();
    expect(s.scrolledOffAbove).toEqual([]);
    expect(s.scrolledOffBelow).toEqual([]);
    expect(s.anchorSpan).toBeNull();
  });

  it('selectionRect：返回外包矩形；无选区 null', () => {
    const store = createSelectionStore();
    expect(store.getState().selectionRect()).toBeNull();
    store.getState().startDrag({ row: 5, col: 10 });
    store.getState().dragTo({ row: 2, col: 3 });
    expect(store.getState().selectionRect()).toEqual({
      minRow: 2, maxRow: 5, minCol: 3, maxCol: 10,
    });
  });

  it('rowIntersects：行落在 [minRow,maxRow]', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 3, col: 2 });
    store.getState().dragTo({ row: 7, col: 8 });
    const s = store.getState();
    expect(s.rowIntersects(2)).toBe(false);
    expect(s.rowIntersects(3)).toBe(true);
    expect(s.rowIntersects(5)).toBe(true);
    expect(s.rowIntersects(7)).toBe(true);
    expect(s.rowIntersects(8)).toBe(false);
  });

  it('colsForRow 单行（minRow==maxRow）：[minCol,maxCol]', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 5, col: 2 });
    store.getState().dragTo({ row: 5, col: 8 });
    expect(store.getState().colsForRow(5, 100)).toEqual({ start: 2, end: 8 });
  });

  it('colsForRow 多行 L 型：首行[anchorCol,width] 中间[0,width] 末行[0,focusCol]', () => {
    const store = createSelectionStore();
    // anchor row=3 col=2，focus row=7 col=8（向下拖）
    store.getState().startDrag({ row: 3, col: 2 });
    store.getState().dragTo({ row: 7, col: 8 });
    const s = store.getState();
    expect(s.colsForRow(3, 50)).toEqual({ start: 2, end: 50 });  // 首行
    expect(s.colsForRow(5, 50)).toEqual({ start: 0, end: 50 });  // 中间整行
    expect(s.colsForRow(7, 50)).toEqual({ start: 0, end: 8 });   // 末行
  });

  it('colsForRow 向上拖（anchor 在下）：首末按 row 顺序不变', () => {
    const store = createSelectionStore();
    // anchor row=7 col=8，focus row=3 col=2（向上拖）
    store.getState().startDrag({ row: 7, col: 8 });
    store.getState().dragTo({ row: 3, col: 2 });
    const s = store.getState();
    // row=3 是末行（focus），row=7 是首行（anchor）
    expect(s.colsForRow(3, 50)).toEqual({ start: 0, end: 2 });   // focus 在此
    expect(s.colsForRow(5, 50)).toEqual({ start: 0, end: 50 });  // 中间
    expect(s.colsForRow(7, 50)).toEqual({ start: 8, end: 50 });  // anchor 在此
  });

  it('colsForRow 行不在选区：返回 null', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 3, col: 2 });
    store.getState().dragTo({ row: 5, col: 8 });
    expect(store.getState().colsForRow(10, 50)).toBeNull();
  });

  it('colsForRow 无选区：null', () => {
    const store = createSelectionStore();
    expect(store.getState().colsForRow(5, 50)).toBeNull();
  });

  it('selectWordAt：以词边界设 anchor/focus + anchorSpan', () => {
    const store = createSelectionStore();
    const hit = store.getState().selectWordAt(5, 2, 'hello world');
    expect(hit).toBe(true);
    const s = store.getState();
    // findWordBounds('hello world', codepoint 2) = [0,5) 码点
    // 转显示列：[0,5) 码点 → [0,5) 显示列（ASCII 等宽）
    expect(s.anchor).toEqual({ row: 5, col: 0 });
    expect(s.focus).toEqual({ row: 5, col: 5 });
    expect(s.anchorSpan).toEqual({ row: 5, colStart: 0, colEnd: 5 });
    expect(s.lastClickKind).toBe('double');
  });

  it('selectWordAt col 落非词字符：返回 false，不改状态', () => {
    const store = createSelectionStore();
    const hit = store.getState().selectWordAt(5, 5, 'hello world'); // col=5 显示列=空格位置
    expect(hit).toBe(false);
    expect(store.getState().anchor).toBeNull();
  });

  it('selectLineAt：整行选中（anchor col=0, focus col=width）', () => {
    const store = createSelectionStore();
    store.getState().selectLineAt(5, 'hello world');
    const s = store.getState();
    expect(s.anchor).toEqual({ row: 5, col: 0 });
    // stringWidth('hello world') = 11
    expect(s.focus).toEqual({ row: 5, col: 11 });
    expect(s.lastClickKind).toBe('triple');
  });

  it('pushScrolledOff：追加到 above/below 缓存', () => {
    const store = createSelectionStore();
    store.getState().pushScrolledOff('above', 'line1');
    store.getState().pushScrolledOff('above', 'line2');
    store.getState().pushScrolledOff('below', 'line3');
    const s = store.getState();
    expect(s.scrolledOffAbove).toEqual(['line1', 'line2']);
    expect(s.scrolledOffBelow).toEqual(['line3']);
  });
});
