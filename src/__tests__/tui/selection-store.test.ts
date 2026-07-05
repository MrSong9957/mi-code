// src/__tests__/tui/selection-store.test.ts
// 行级选区 store：anchor/focus/isDragging（charter §核心模块 2 MVP）

import { describe, it, expect } from 'vitest';
import { createSelectionStore } from '../../tui/state/selection-store.js';

describe('selection-store（行级选区）', () => {
  it('初始：无选区，isDragging=false', () => {
    const store = createSelectionStore();
    const s = store.getState();
    expect(s.anchorRow).toBeNull();
    expect(s.focusRow).toBeNull();
    expect(s.isDragging).toBe(false);
  });

  it('startDrag(row)：设 anchor=focus=row，isDragging=true', () => {
    const store = createSelectionStore();
    store.getState().startDrag(5);
    const s = store.getState();
    expect(s.anchorRow).toBe(5);
    expect(s.focusRow).toBe(5);
    expect(s.isDragging).toBe(true);
  });

  it('dragTo(row)：拖拽更新 focus（anchor 不变）', () => {
    const store = createSelectionStore();
    store.getState().startDrag(3);
    store.getState().dragTo(7);
    store.getState().dragTo(8);
    const s = store.getState();
    expect(s.anchorRow).toBe(3);
    expect(s.focusRow).toBe(8);
    expect(s.isDragging).toBe(true);
  });

  it('dragTo 向上拖：focus 可小于 anchor', () => {
    const store = createSelectionStore();
    store.getState().startDrag(5);
    store.getState().dragTo(2);
    expect(store.getState().anchorRow).toBe(5);
    expect(store.getState().focusRow).toBe(2);
  });

  it('endDrag：isDragging=false，保留 anchor/focus（高亮持续到下次操作）', () => {
    const store = createSelectionStore();
    store.getState().startDrag(3);
    store.getState().dragTo(7);
    store.getState().endDrag();
    const s = store.getState();
    expect(s.isDragging).toBe(false);
    expect(s.anchorRow).toBe(3);
    expect(s.focusRow).toBe(7);
  });

  it('clear：清空所有（anchor/focus=null, isDragging=false）', () => {
    const store = createSelectionStore();
    store.getState().startDrag(3);
    store.getState().dragTo(7);
    store.getState().clear();
    const s = store.getState();
    expect(s.anchorRow).toBeNull();
    expect(s.focusRow).toBeNull();
    expect(s.isDragging).toBe(false);
  });

  it('hasSelection：anchor/focus 都非 null 时为 true', () => {
    const store = createSelectionStore();
    expect(store.getState().hasSelection()).toBe(false);
    store.getState().startDrag(3);
    expect(store.getState().hasSelection()).toBe(true);
    store.getState().clear();
    expect(store.getState().hasSelection()).toBe(false);
  });

  it('selectionRange：返回 [min, max] 或 null（无选区）', () => {
    const store = createSelectionStore();
    expect(store.getState().selectionRange()).toBeNull();
    store.getState().startDrag(5);
    store.getState().dragTo(2);
    expect(store.getState().selectionRange()).toEqual([2, 5]);
    store.getState().dragTo(8);
    expect(store.getState().selectionRange()).toEqual([5, 8]);
  });

  it('isSelected(row)：行号落在 [min,max] 区间（含端点）', () => {
    const store = createSelectionStore();
    store.getState().startDrag(3);
    store.getState().dragTo(7);
    const s = store.getState();
    expect(s.isSelected(2)).toBe(false);
    expect(s.isSelected(3)).toBe(true);
    expect(s.isSelected(5)).toBe(true);
    expect(s.isSelected(7)).toBe(true);
    expect(s.isSelected(8)).toBe(false);
  });

  it('isSelected 无选区时恒 false', () => {
    const store = createSelectionStore();
    expect(store.getState().isSelected(0)).toBe(false);
    expect(store.getState().isSelected(5)).toBe(false);
  });
});
