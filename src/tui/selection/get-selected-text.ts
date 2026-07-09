// src/tui/selection/get-selected-text.ts
// 选区→纯文本提取（区域无关，L 型 + scrolledOff 缓存拼接）。
//
// 物理本质：把选区覆盖的所有屏幕格子的字符按行拼成纯文本。
// 文本来源统一走 RowTextMap（跨 LOGO/消息/边框/输入/状态栏），不再硬编码消息区。
//
// L 型语义：首行（anchor 所在）[anchorCol, 行尾]、中间整行、末行（focus 所在）[行首, focusCol]。
// 拖拽方向不影响首末归属（anchor 永远是 anchor，focus 永远是 focus）。
//
// 流式块（!finalized）：RowTextMap 已返回 null，本函数跳过（continue）。
// 滚动缓存：scrolledOffAbove + 选区行（按 row 升序）+ scrolledOffBelow。

import stringWidth from 'string-width';
import type { SelectionState } from '../state/selection-store.js';
import type { RowTextMap } from './row-text-map.js';
import { sliceLineBySelection } from './slice-line.js';

export interface GetSelectedTextParams {
  /** 统一行文本映射（由 buildRowTextMap 构建） */
  rowTextMap: RowTextMap;
  /** selectionStore 当前状态 */
  selection: SelectionState;
}

/**
 * 提取选中文本。无选区返回 ''。
 *
 * 拼接顺序：scrolledOffAbove → 选区行 [minRow, maxRow]（按 row 升序，每行经 RowTextMap 取文本）→ scrolledOffBelow。
 * 每行通过 colsForRow(row, lineWidth) 取 L 型列范围，再用 sliceLineBySelection 切出选中片段。
 * RowTextMap 返回 null 的行（流式块/越界/空白行）跳过。
 */
export function getSelectedText(params: GetSelectedTextParams): string {
  const { rowTextMap, selection } = params;
  const rect = selection.selectionRect();
  if (!rect) return '';

  const parts: string[] = [...selection.scrolledOffAbove];

  for (let row = rect.minRow; row <= rect.maxRow; row++) {
    const content = rowTextMap.getLineContent(row);
    if (content === null) continue; // 流式块/越界/空白行，跳过
    const lineWidth = stringWidth(content);
    const cols = selection.colsForRow(row, lineWidth);
    // colsForRow 返回 {start,end}，sliceLineBySelection 入参为 {startCol,endCol}，做字段映射
    const segs = sliceLineBySelection(content, cols && { startCol: cols.start, endCol: cols.end });
    const selectedText = segs.filter(s => s.selected).map(s => s.text).join('');
    parts.push(selectedText);
  }

  parts.push(...selection.scrolledOffBelow);

  return parts.join('\n');
}
