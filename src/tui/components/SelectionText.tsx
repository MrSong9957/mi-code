// src/tui/components/SelectionText.tsx
// 选区切片公共渲染组件：把一行文本按选区切片，选中段蓝底黑字，其它段透传样式。
//
// 物理本质：所有可被选中的区域（LOGO/消息/边框/输入/状态栏）共用同一套「切片+高亮」逻辑。
// 选中段用 backgroundColor="cyan" + color="black"（蓝底黑字，对比最强，避开 magenta/green/red/gray 语义色）；
// 非选中段用调用方传入的 props。
//
// 调用方需订阅 selectionStore（useStore + useShallow 取 anchor/focus），把当前行的 globalRow +
// 订阅值传入。本组件用纯函数 colsForRowFromPoints（与 MessageRow 同逻辑）算该行列范围。

import React from 'react';
import { Text } from 'ink';
import stringWidth from 'string-width';
import type { InkTextStyle } from '../types.js';
import { sliceLineBySelection } from '../selection/slice-line.js';
import type { Point } from '../state/selection-store.js';

export interface SelectionTextProps {
  /** 该行完整文本 */
  content: string;
  /** 该行在屏幕上的全局行号；不传或 selection 为 null 则不高亮 */
  globalRow?: number;
  /** 订阅到的选区 anchor（来自 useStore selectionStore） */
  anchor?: Point | null;
  /** 订阅到的选区 focus */
  focus?: Point | null;
  /** 非选中段的样式（调用方传入，如 LOGO 的 magenta、消息的语义样式） */
  baseProps?: InkTextStyle;
  /** 缩进空格（消息行有 indent，其它区域通常无） */
  indent?: string;
}

/**
 * 用 anchor/focus 算某行的选区列范围（L 型语义，与 selection-store.colsForRow 同逻辑）。
 * 单行 [minCol,maxCol]；多行首行(anchor) [anchorCol,width]、末行(focus) [0,focusCol]、中间整行。
 */
function colsForRowFromPoints(
  anchor: Point | null | undefined,
  focus: Point | null | undefined,
  row: number,
  lineWidth: number,
): { start: number; end: number } | null {
  if (!anchor || !focus) return null;
  const minRow = Math.min(anchor.row, focus.row);
  const maxRow = Math.max(anchor.row, focus.row);
  if (row < minRow || row > maxRow) return null;

  if (minRow === maxRow) {
    return {
      start: Math.min(anchor.col, focus.col),
      end: Math.max(anchor.col, focus.col),
    };
  }
  if (row === anchor.row) return { start: anchor.col, end: lineWidth };
  if (row === focus.row) return { start: 0, end: focus.col };
  return { start: 0, end: lineWidth };
}

/** 选区高亮样式：蓝底黑字加粗（避开 magenta/green/red/gray 语义色，对比最强） */
const SELECTED_PROPS: InkTextStyle = {
  backgroundColor: 'cyan',
  color: 'black',
  bold: true,
};

export function SelectionText({ content, globalRow, anchor, focus, baseProps, indent = '' }: SelectionTextProps): React.ReactElement {
  let segs: Array<{ text: string; selected: boolean }>;
  if (globalRow !== undefined && (anchor || focus)) {
    const lineWidth = stringWidth(content);
    const cols = colsForRowFromPoints(anchor, focus, globalRow, lineWidth);
    segs = sliceLineBySelection(content, cols && { startCol: cols.start, endCol: cols.end });
  } else {
    segs = [{ text: content, selected: false }];
  }

  return (
    <Text {...baseProps}>
      {indent}
      {segs.map((seg, j) =>
        seg.selected
          ? <Text key={j} {...SELECTED_PROPS}>{seg.text}</Text>
          : <Text key={j} {...baseProps}>{seg.text}</Text>
      )}
    </Text>
  );
}
