// src/tui/state/selection-store.ts
// 行级选区 store（charter §核心模块 2 MVP）
//
// 物理本质：鼠标拖拽选中的「行区间记录簿」。
// anchor（按下点）+ focus（拖拽终点）两个屏幕行号（0-based），isDragging 标记拖拽中。
// 行级（非单元格级）—— MVP 高亮整行（inverse），复制提取选中行纯文本。
//
// 屏幕行号约定：相对 Ink 输出原点的全局行（含 LOGO_ROWS 偏移），
// 由 ScrollBox 在鼠标事件中换算（SGR 鼠标 row - 1 转 0-based）。

import { createStore, type StoreApi } from 'zustand/vanilla';

export interface SelectionState {
  /** 拖拽起点行（0-based 屏幕行），null=无选区 */
  anchorRow: number | null;
  /** 拖拽当前/终点行，null=无选区 */
  focusRow: number | null;
  /** 是否正在拖拽（mousedown→mouseup 之间） */
  isDragging: boolean;
  /** 开始拖拽：设 anchor=focus=row，isDragging=true */
  startDrag: (row: number) => void;
  /** 拖拽中：更新 focus（anchor 不变） */
  dragTo: (row: number) => void;
  /** 结束拖拽：isDragging=false，保留 anchor/focus（高亮持续） */
  endDrag: () => void;
  /** 清空选区 */
  clear: () => void;
  /** 是否有选区（anchor/focus 都非 null） */
  hasSelection: () => boolean;
  /** 选区行范围 [min,max]，无选区返回 null */
  selectionRange: () => [number, number] | null;
  /** 某行是否在选区内（含端点） */
  isSelected: (row: number) => boolean;
}

export type SelectionStore = StoreApi<SelectionState>;

export function createSelectionStore(): SelectionStore {
  return createStore<SelectionState>((set, get) => ({
    anchorRow: null,
    focusRow: null,
    isDragging: false,

    startDrag: (row) => set({ anchorRow: row, focusRow: row, isDragging: true }),
    dragTo: (row) => set((s) => s.anchorRow === null ? s : { focusRow: row }),
    endDrag: () => set({ isDragging: false }),
    clear: () => set({ anchorRow: null, focusRow: null, isDragging: false }),

    hasSelection: () => {
      const s = get();
      return s.anchorRow !== null && s.focusRow !== null;
    },
    selectionRange: () => {
      const s = get();
      if (s.anchorRow === null || s.focusRow === null) return null;
      return [Math.min(s.anchorRow, s.focusRow), Math.max(s.anchorRow, s.focusRow)];
    },
    isSelected: (row) => {
      const r = get().selectionRange();
      if (!r) return false;
      return row >= r[0] && row <= r[1];
    },
  }));
}
