// src/tui/components/ScrollBox.tsx
// 虚拟滚动容器（纯受控组件，按行坐标滚动 + 渲染）。
//
// 物理本质：长列表「取景器」。按「行」滚动——已固化消息展开成行数组（flatLines），
// 每行独立 globalRow（杜绝多行消息行号撞车，修根因 2a）。
// 流式块（最后一条未固化 assistant）单独渲染在可见已固化行之后（StreamingMarkdown，
// 不参与行号映射/选区，与 spec §3.2.2 一致）。
//
// 滚动状态全由 ConnectedApp 持有（scrollTop 受控传入）；本组件不再有自动跟随 effect
// （移到 ConnectedApp 同步算 effectiveScrollTop，修根因 1b）。

import React from 'react';
import { Box } from 'ink';
import type { TuiMessage } from '../types.js';
import { computeScrollState, sliceVisible } from './scroll-state.js';
import { SelectionText } from './SelectionText.js';
import { StreamingMarkdown } from '../streaming/streaming-markdown.js';
import { styleToInkProps } from '../types.js';
import type { FlatLine } from '../selection/flatten-messages.js';
import type { SelectionStore } from '../state/selection-store.js';

/** LOGO 区占的行数（与 App.tsx LOGO_ROWS 一致） */
const LOGO_ROWS = 3;

export interface ScrollBoxProps {
  messages: TuiMessage[];
  /** 已固化消息展开后的行列表（按行坐标） */
  flatLines: FlatLine[];
  visibleRows: number;
  /** 当前 scrollTop（按行坐标，受控） */
  scrollTop: number;
  selectionStore: SelectionStore;
}

export function ScrollBox({ messages, flatLines, visibleRows, scrollTop, selectionStore }: ScrollBoxProps): React.ReactElement {
  const state = computeScrollState({ total: flatLines.length, visibleRows, scrollTop });
  const visible: FlatLine[] = sliceVisible(flatLines, state);

  // 流式块：messages 里最后一条未固化且 streamingText 非空的 assistant 块。
  // 它紧跟在已固化行之后渲染（占可变行数，不参与行号/选区）。
  const streamingMsg = messages.find(m => !m.finalized && m.role === 'assistant' && m.streamingText !== undefined);

  return (
    <Box flexGrow={1} flexDirection="column" overflow="hidden">
      {visible.map((fl, i) => {
        // 每行独立 globalRow（i 是行索引，flatLines 已按行展开，不再撞车）
        const globalRow = LOGO_ROWS + state.scrollTop + i;
        const line = fl.line;
        return (
          <SelectionText
            key={`${fl.messageUuid}-${fl.lineIndex}`}
            content={line.content}
            globalRow={globalRow}
            selectionStore={selectionStore}
            baseProps={styleToInkProps(line.style)}
            indent={' '.repeat(line.indent ?? 0)}
          />
        );
      })}
      {streamingMsg && streamingMsg.streamingText !== undefined && (
        <StreamingMarkdown text={streamingMsg.streamingText} />
      )}
    </Box>
  );
}
