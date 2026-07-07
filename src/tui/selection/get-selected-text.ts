// src/tui/selection/get-selected-text.ts
// 选区→纯文本提取（L 型 + scrolledOff 缓存拼接 + 流式块跳过）。
//
// 物理本质：把选区覆盖的所有屏幕格子的字符按行拼成纯文本。
// L 型语义：首行（anchor 所在）[anchorCol, 行尾]、中间整行、末行（focus 所在）[行首, focusCol]。
// 拖拽方向不影响首末归属（anchor 永远是 anchor，focus 永远是 focus）。
//
// 屏幕行→消息行映射：row - viewportTopRow = 消息内线性行号；
// 再按 messages[i].lines.length 累计定位 (messageIndex, lineIndex)。
//
// 流式块（!finalized）：跳过，返回空。
// 滚动缓存：scrolledOffAbove + 视口内 + scrolledOffBelow。

import stringWidth from 'string-width';
import type { TuiMessage } from '../types.js';
import type { SelectionState } from '../state/selection-store.js';
import { sliceLineBySelection } from './slice-line.js';

export interface GetSelectedTextParams {
  messages: TuiMessage[];
  /** ScrollBox 当前 scrollTop */
  scrollTop: number;
  /** 视口可见行数 */
  visibleRows: number;
  /** 视口顶全局行（= LOGO_ROWS + scrollTop） */
  viewportTopRow: number;
  /** selectionStore 当前状态 */
  selection: SelectionState;
}

/** 屏幕全局行 → (messageIndex, lineIndex)；不在任何 finalized 消息内返回 null */
function mapRowToMessage(
  row: number,
  messages: TuiMessage[],
  viewportTopRow: number,
): { messageIndex: number; lineIndex: number } | null {
  // 消息内线性行号（相对所有 finalized 消息的 lines 拉平）
  const flatRow = row - viewportTopRow;
  if (flatRow < 0) return null;
  let acc = 0;
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]!;
    if (!msg.finalized) continue; // 流式块不可定位
    const lineCount = msg.lines.length;
    if (flatRow < acc + lineCount) {
      return { messageIndex: mi, lineIndex: flatRow - acc };
    }
    acc += lineCount;
  }
  return null;
}

/**
 * 提取选中文本。无选区返回 ''。
 *
 * 拼接顺序：scrolledOffAbove（上方缓存）→ 视口内行（按 row 升序）→ scrolledOffBelow（下方缓存）。
 * 视口内每行通过 colsForRow(row, lineWidth) 取 L 型列范围，再用 sliceLineBySelection 切出选中片段。
 * 流式块（finalized=false）在 mapRowToMessage 中被跳过，整选区都在流式块上时返回空（不含缓存）。
 */
export function getSelectedText(params: GetSelectedTextParams): string {
  const { messages, visibleRows, viewportTopRow, selection } = params;
  const rect = selection.selectionRect();
  if (!rect) return '';

  const parts: string[] = [...selection.scrolledOffAbove];

  // 视口内的行范围（与 ScrollBox 可见区对齐）
  const viewportBottomRow = viewportTopRow + visibleRows - 1;
  const startRow = Math.max(rect.minRow, viewportTopRow);
  const endRow = Math.min(rect.maxRow, viewportBottomRow);

  for (let row = startRow; row <= endRow; row++) {
    const loc = mapRowToMessage(row, messages, viewportTopRow);
    if (!loc) continue; // 流式块或越界，跳过（空行不补，符合「该行无可见 finalized 文本」）
    const msg = messages[loc.messageIndex]!;
    if (!msg.finalized) continue;
    const line = msg.lines[loc.lineIndex];
    if (!line) continue;
    const lineWidth = stringWidth(line.content);
    const cols = selection.colsForRow(row, lineWidth);
    // colsForRow 返回 {start,end}，sliceLineBySelection 入参为 {startCol,endCol}，做字段映射
    const segs = sliceLineBySelection(line.content, cols && { startCol: cols.start, endCol: cols.end });
    const selectedText = segs.filter(s => s.selected).map(s => s.text).join('');
    parts.push(selectedText);
  }

  parts.push(...selection.scrolledOffBelow);

  return parts.join('\n');
}
