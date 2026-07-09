// src/tui/state/selection-store.ts
// 字符级选区 store（Point{row,col}）。
//
// 物理本质：鼠标拖拽选中的「二维坐标记录簿」。
// anchor（按下点）+ focus（拖拽终点）都是屏幕全局坐标（row 0-based 含 LOGO_ROWS 偏移，
// col 显示列 0-based，CJK 全角=1 col 由 string-width 算）。
//
// L 型选择语义（colsForRow）：
//  - 单行（minRow==maxRow）：[minCol, maxCol]
//  - 多行：首行（anchor 所在行）[anchorCol, lineWidth]、中间整行 [0, lineWidth]、
//          末行（focus 所在行）[0, focusCol]
//  注意：首/末按 anchor/focus 的 row 决定，与拖拽方向无关（向上拖时 anchor 在下）。
//
// 滚动捕获：scrolledOffAbove/Below 缓存拖拽超出视口的行文本，复制时拼接。
//
// 屏幕行号约定：相对 Ink 输出原点的全局行（含 LOGO_ROWS 偏移），
// 由 ScrollBox 在鼠标事件中换算（SGR row - 1 转 0-based）。

import { createStore, type StoreApi } from 'zustand/vanilla';
import stringWidth from 'string-width';
import { findWordBounds } from '../selection/word-boundary.js';

export interface Point {
  /** 屏幕全局行（0-based，含 LOGO_ROWS 偏移） */
  row: number;
  /** 显示列（0-based；CJK 全角=1 col） */
  col: number;
}

export type ClickKind = 'single' | 'double' | 'triple';

export interface AnchorSpan {
  row: number;
  colStart: number;
  colEnd: number;
}

export interface SelectionState {
  /** 拖拽起点（null=无选区） */
  anchor: Point | null;
  /** 拖拽当前/终点 */
  focus: Point | null;
  /** 是否拖拽中 */
  isDragging: boolean;
  /** 最近一次手势的多击类型 */
  lastClickKind: ClickKind | null;
  /** 双击/三击锚定的词/行边界 */
  anchorSpan: AnchorSpan | null;
  /** 拖拽超出视口时滚出上方/下方的行文本缓存 */
  scrolledOffAbove: string[];
  scrolledOffBelow: string[];

  // —— 操作 ——
  /** 开始拖拽：anchor=focus=p，isDragging=true */
  startDrag: (p: Point, kind?: ClickKind) => void;
  /** 拖拽中：更新 focus（anchor 不变）；anchor=null 时无效 */
  dragTo: (p: Point) => void;
  /** 结束拖拽：isDragging=false，保留 anchor/focus（高亮持续） */
  endDrag: () => void;
  /** 双击选词：以码点词边界扩展。返回是否命中（非词字符上返回 false） */
  selectWordAt: (row: number, col: number, fullLineContent: string) => boolean;
  /** 三击选行：整行选中 */
  selectLineAt: (row: number, fullLineContent: string) => void;
  /** 追加滚动捕获的行文本（'above'=向上滚出，'below'=向下滚出） */
  pushScrolledOff: (side: 'above' | 'below', text: string) => void;
  /** 清空选区（右键复制后调用，清全部含缓存） */
  clear: () => void;

  // —— 查询 ——
  hasSelection: () => boolean;
  /** 外包矩形 {minRow,maxRow,minCol,maxCol}；无选区 null */
  selectionRect: () => { minRow: number; maxRow: number; minCol: number; maxCol: number } | null;
  /** 某行是否与选区相交（含端点） */
  rowIntersects: (row: number) => boolean;
  /**
   * 某行的选区列范围 [start,end)（L 型语义）；行不在选区返回 null。
   * @param row       屏幕全局行
   * @param lineWidth 该行显示宽度（由调用方传 stringWidth(content)）
   */
  colsForRow: (row: number, lineWidth: number) => { start: number; end: number } | null;
}

export type SelectionStore = StoreApi<SelectionState>;

export function createSelectionStore(): SelectionStore {
  return createStore<SelectionState>((set, get) => ({
    anchor: null,
    focus: null,
    isDragging: false,
    lastClickKind: null,
    anchorSpan: null,
    scrolledOffAbove: [],
    scrolledOffBelow: [],

    startDrag: (p, kind = 'single') => set({
      anchor: p, focus: p, isDragging: true,
      lastClickKind: kind,
      anchorSpan: null,
      // 新拖拽手势清空滚动缓存（旧选区作废）
      scrolledOffAbove: [],
      scrolledOffBelow: [],
    }),

    dragTo: (p) => set((s) => s.anchor === null ? s : { focus: p }),

    endDrag: () => set({ isDragging: false }),

    selectWordAt: (row, col, fullLineContent) => {
      const codepoints = [...fullLineContent];
      let cpIndex = codepoints.length; // default: past end
      let acc = 0;
      for (let i = 0; i < codepoints.length; i++) {
        const w = stringWidth(codepoints[i]!);
        if (col < acc + w) { cpIndex = i; break; }   // col falls within this char's cells
        acc += w;
        cpIndex = i + 1;
      }
      const bounds = findWordBounds(fullLineContent, cpIndex);
      if (bounds.start === bounds.end) return false; // 非词字符
      // 把码点区间转回显示列区间
      const startCol = stringWidth(codepoints.slice(0, bounds.start).join(''));
      const endCol = stringWidth(codepoints.slice(0, bounds.end).join(''));
      set({
        anchor: { row, col: startCol },
        focus: { row, col: endCol },
        isDragging: false,
        lastClickKind: 'double',
        anchorSpan: { row, colStart: startCol, colEnd: endCol },
        scrolledOffAbove: [],
        scrolledOffBelow: [],
      });
      return true;
    },

    selectLineAt: (row, fullLineContent) => {
      const w = stringWidth(fullLineContent);
      set({
        anchor: { row, col: 0 },
        focus: { row, col: w },
        isDragging: false,
        lastClickKind: 'triple',
        anchorSpan: { row, colStart: 0, colEnd: w },
        scrolledOffAbove: [],
        scrolledOffBelow: [],
      });
    },

    pushScrolledOff: (side, text) => set((s) => {
      if (side === 'above') return { scrolledOffAbove: [...s.scrolledOffAbove, text] };
      return { scrolledOffBelow: [...s.scrolledOffBelow, text] };
    }),

    clear: () => set({
      anchor: null, focus: null, isDragging: false,
      lastClickKind: null, anchorSpan: null,
      scrolledOffAbove: [], scrolledOffBelow: [],
    }),

    hasSelection: () => {
      const s = get();
      return s.anchor !== null && s.focus !== null;
    },

    selectionRect: () => {
      const s = get();
      if (!s.anchor || !s.focus) return null;
      return {
        minRow: Math.min(s.anchor.row, s.focus.row),
        maxRow: Math.max(s.anchor.row, s.focus.row),
        minCol: Math.min(s.anchor.col, s.focus.col),
        maxCol: Math.max(s.anchor.col, s.focus.col),
      };
    },

    rowIntersects: (row) => {
      const r = get().selectionRect();
      if (!r) return false;
      return row >= r.minRow && row <= r.maxRow;
    },

    colsForRow: (row, lineWidth) => {
      const s = get();
      if (!s.anchor || !s.focus) return null;
      const minRow = Math.min(s.anchor.row, s.focus.row);
      const maxRow = Math.max(s.anchor.row, s.focus.row);
      if (row < minRow || row > maxRow) return null;

      if (minRow === maxRow) {
        // 单行
        return {
          start: Math.min(s.anchor.col, s.focus.col),
          end: Math.max(s.anchor.col, s.focus.col),
        };
      }
      // 多行 L 型
      if (row === s.anchor.row) {
        // anchor 所在行：[anchorCol, lineWidth]
        return { start: s.anchor.col, end: lineWidth };
      }
      if (row === s.focus.row) {
        // focus 所在行：[0, focusCol]
        return { start: 0, end: s.focus.col };
      }
      // 中间整行
      return { start: 0, end: lineWidth };
    },
  }));
}
