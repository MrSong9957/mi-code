// src/tui/components/MessageRow.tsx
// 单条消息渲染（支持字符级选区高亮）。
//
// 物理本质：把一条 TuiMessage 翻译成 Ink 组件树。
// - 已固化行（lines: FormattedLine[]）：逐行渲染，缩进 + 语义样式
// - 流式 assistant（finalized=false 且 streamingText 非空）：用 StreamingMarkdown 渲染
//   （流式块不参与选区，与 spec §3.2.2 决策一致）
// - 选区高亮：调 sliceLineBySelection 把每行 content 按选区列范围切片，
//   选中段加 inverse（SGR 7 反色）。CJK 钳位由 slice-line 处理。
//
// 缩进+前缀都参与选区（终端原生语义）：FormattedLine.content 含缩进空格和前缀（●⎿❯），
// 屏幕列 == content 内列，无需坐标转换。

import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { createStore } from 'zustand/vanilla';
import stringWidth from 'string-width';
import type { TuiMessage } from '../types.js';
import { styleToInkProps } from '../types.js';
import { StreamingMarkdown } from '../streaming/streaming-markdown.js';
import { sliceLineBySelection } from '../selection/slice-line.js';
import type { SelectionStore, Point } from '../state/selection-store.js';

/** selectionStore 缺省时的占位 store（永远返回 null anchor/focus，让 useStore hook 不崩）。
 *  用 createStore 造真 store 以满足 zustand 类型契约。 */
const _noopStore = createStore<{ anchor: Point | null; focus: Point | null }>(() => ({
  anchor: null,
  focus: null,
}));

export interface MessageRowProps {
  message: TuiMessage;
  /** 该消息在屏幕上的全局起始行（用于 selectionStore 查询）；流式块可不传 */
  globalRow?: number;
  /** 选区 store；不传则不高亮（流式块场景） */
  selectionStore?: SelectionStore;
}

export function MessageRow({ message, globalRow, selectionStore }: MessageRowProps): React.ReactElement {
  // ⚠️ 订阅选区（修根因 #3）：原代码用 selectionStore.getState() 直读，无 React 订阅，
  // 选区变化不触发重渲染 → 高亮画不出来。改为 useStore 订阅 anchor/focus（最小稳定切片），
  // dragTo 每次更新 focus → 触发订阅 → 本组件重渲染。
  // 必须在早返回之前调（hooks 规则）；流式块订阅它是浪费但 anchor/focus 通常 null，开销可忽略。
  // 用 useShallow 浅比较 Point|null，避免无限重渲染。
  const store = selectionStore ?? _noopStore;
  const sel = useStore(
    store,
    useShallow((s) => ({ anchor: s.anchor, focus: s.focus })),
  );

  // 流式 assistant：用 StreamingMarkdown 渲染累积文本（不参与选区）
  if (!message.finalized && message.role === 'assistant' && message.streamingText !== undefined) {
    return (
      <Box flexDirection="column">
        <StreamingMarkdown text={message.streamingText} />
      </Box>
    );
  }

  // 已固化行：逐行渲染，按选区切片高亮
  return (
    <Box flexDirection="column">
      {message.lines.map((line, i) => {
        const props = styleToInkProps(line.style);
        const indent = ' '.repeat(line.indent ?? 0);

        // 选区切片：globalRow + selectionStore 都有才查。
        // 用订阅到的 sel.anchor/focus 算该行的列范围（复用 store 的 colsForRow 逻辑）。
        let segs: Array<{ text: string; selected: boolean }>;
        if (globalRow !== undefined && selectionStore) {
          const lineWidth = stringWidth(line.content);
          const cols = colsForRowFromPoints(sel.anchor, sel.focus, globalRow + i, lineWidth);
          // colsForRow 返回 {start,end}，sliceLineBySelection 入参为 {startCol,endCol}，做字段映射
          // （与 get-selected-text.ts 同一映射范式）
          segs = sliceLineBySelection(line.content, cols && { startCol: cols.start, endCol: cols.end });
        } else {
          segs = [{ text: line.content, selected: false }];
        }

        return (
          <Text key={i} {...props}>
            {indent}
            {segs.map((seg, j) =>
              seg.selected
                ? <Text key={j} bold inverse>{seg.text}</Text>
                : <Text key={j} {...props}>{seg.text}</Text>
            )}
          </Text>
        );
      })}
    </Box>
  );
}

/**
 * 用订阅到的 anchor/focus 算某行的选区列范围（L 型语义，与 selection-store.colsForRow 同逻辑）。
 * 提取为纯函数：MessageRow 不再调 store.getState()，纯靠订阅值重算，确保订阅触发重渲染生效。
 * 与 SelectionState.colsForRow 实现保持一致（首行 [anchorCol,width]、末行 [0,focusCol]、中间整行）。
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
    return {
      start: Math.min(anchor.col, focus.col),
      end: Math.max(anchor.col, focus.col),
    };
  }
  if (row === anchor.row) {
    return { start: anchor.col, end: lineWidth };
  }
  if (row === focus.row) {
    return { start: 0, end: focus.col };
  }
  return { start: 0, end: lineWidth };
}
