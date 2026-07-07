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
import stringWidth from 'string-width';
import type { TuiMessage } from '../types.js';
import { styleToInkProps } from '../types.js';
import { StreamingMarkdown } from '../streaming/streaming-markdown.js';
import { sliceLineBySelection } from '../selection/slice-line.js';
import type { SelectionStore } from '../state/selection-store.js';

export interface MessageRowProps {
  message: TuiMessage;
  /** 该消息在屏幕上的全局起始行（用于 selectionStore 查询）；流式块可不传 */
  globalRow?: number;
  /** 选区 store；不传则不高亮（流式块场景） */
  selectionStore?: SelectionStore;
}

export function MessageRow({ message, globalRow, selectionStore }: MessageRowProps): React.ReactElement {
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

        // 选区切片：globalRow + selectionStore 都有才查
        let segs: Array<{ text: string; selected: boolean }>;
        if (globalRow !== undefined && selectionStore) {
          const lineWidth = stringWidth(line.content);
          const cols = selectionStore.getState().colsForRow(globalRow + i, lineWidth);
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
                ? <Text key={j} {...props} inverse>{seg.text}</Text>
                : <Text key={j} {...props}>{seg.text}</Text>
            )}
          </Text>
        );
      })}
    </Box>
  );
}
