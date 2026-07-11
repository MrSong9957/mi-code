// src/tui/components/SelectionText.tsx
// 选区切片公共渲染组件：把一行文本按选区切片，选中段蓝底黑字，其它段透传样式。
//
// 物理本质：所有可被选中的区域（LOGO/消息/边框/输入/状态栏）共用同一套「切片+高亮」逻辑。
// 本组件自订阅 selectionStore（useStore 取 anchor/focus），调用方只需传 store 引用 + globalRow + content。
// 选中段用 backgroundColor="cyan" + color="black"（蓝底黑字，对比最强，避开 magenta/green/red/gray）。
//
// 调用方：ScrollBox（已固化行）、LogoBox（LOGO 行）、Footer（边框/输入行）。
// StatusBar 因整行分段彩色，单独处理（相交时退化为 SelectionText 单段，见 StatusBar.tsx）。

import React from 'react';
import { Text } from 'ink';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { createStore } from 'zustand/vanilla';
import stringWidth from 'string-width';
import type { InkTextStyle } from '../types.js';
import { sliceLineBySelection } from '../selection/slice-line.js';
import type { SelectionStore, Point } from '../state/selection-store.js';
import { useTheme } from '../state/theme-context.js';

/** selectionStore 缺省时的占位 store（永远返回 null anchor/focus，让 useStore hook 不崩） */
const _noopStore = createStore<{ anchor: Point | null; focus: Point | null }>(() => ({
  anchor: null, focus: null,
}));

export interface SelectionTextProps {
  /** 该行完整文本 */
  content: string;
  /** 该行在屏幕上的全局行号；不传则不高亮 */
  globalRow?: number;
  /** 选区 store（自订阅）；不传则用 noopStore（不高亮） */
  selectionStore?: SelectionStore;
  /** 非选中段的样式（调用方传入） */
  baseProps?: InkTextStyle;
  /** 缩进空格 */
  indent?: string;
}

/**
 * 用 anchor/focus 算某行的选区列范围（L 型语义，与 selection-store.colsForRow 同逻辑）。
 * 单行 [minCol,maxCol]；多行首行(anchor) [anchorCol,width]、末行(focus) [0,focusCol]、中间整行。
 */
function colsForRowFromPoints(
  anchor: Point | null,
  focus: Point | null,
  row: number,
  lineWidth: number,
): { start: number; end: number } | null {
  if (!anchor || !focus) return null;
  const minRow = Math.min(anchor.row, focus.row);
  const maxRow = Math.max(anchor.row, focus.row);
  if (row < minRow || row > maxRow) return null;
  if (minRow === maxRow) {
    return { start: Math.min(anchor.col, focus.col), end: Math.max(anchor.col, focus.col) };
  }
  if (row === anchor.row) return { start: anchor.col, end: lineWidth };
  if (row === focus.row) return { start: 0, end: focus.col };
  return { start: 0, end: lineWidth };
}

export function SelectionText({ content, globalRow, selectionStore, baseProps, indent = '' }: SelectionTextProps): React.ReactElement {
  const t = useTheme();
  // 自订阅选区 anchor/focus（useShallow 浅比较）。选区变化时相交行重渲染。
  const sel = useStore(
    selectionStore ?? _noopStore,
    useShallow((s: { anchor: Point | null; focus: Point | null }) => ({ anchor: s.anchor, focus: s.focus })),
  );

  let segs: Array<{ text: string; selected: boolean }>;
  if (globalRow !== undefined) {
    const lineWidth = stringWidth(content);
    const cols = colsForRowFromPoints(sel.anchor, sel.focus, globalRow, lineWidth);
    segs = sliceLineBySelection(content, cols && { startCol: cols.start, endCol: cols.end });
  } else {
    segs = [{ text: content, selected: false }];
  }

  const selectedProps: InkTextStyle = {
    backgroundColor: t.selectionBg,
    color: t.selectionFg,
    bold: true,
  };

  return (
    <Text {...baseProps}>
      {indent}
      {segs.map((seg, j) =>
        seg.selected
          ? <Text key={j} {...selectedProps}>{seg.text}</Text>
          : <Text key={j} {...baseProps}>{seg.text}</Text>
      )}
    </Text>
  );
}
