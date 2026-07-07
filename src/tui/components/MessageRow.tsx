// src/tui/components/MessageRow.tsx
// 单条消息渲染（支持字符级选区高亮）。
//
// 物理本质：把一条 TuiMessage 翻译成 Ink 组件树。
// - 已固化行（lines: FormattedLine[]）：逐行渲染，缩进 + 语义样式
// - 流式 assistant（finalized=false 且 streamingText 非空）：用 StreamingMarkdown 渲染
//   （流式块不参与选区，与 spec §3.2.2 决策一致）
// - 选区高亮：复用 SelectionText 公共组件（蓝底黑字，避开语义色冲突）。
//
// 缩进+前缀都参与选区（终端原生语义）：FormattedLine.content 含缩进空格和前缀（●⎿❯），
// 屏幕列 == content 内列，无需坐标转换。

import React from 'react';
import { Box } from 'ink';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { createStore } from 'zustand/vanilla';
import type { TuiMessage } from '../types.js';
import { styleToInkProps } from '../types.js';
import { StreamingMarkdown } from '../streaming/streaming-markdown.js';
import { SelectionText } from './SelectionText.js';
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
  // 订阅选区 anchor/focus（useShallow 浅比较）。必须在早返回之前调（hooks 规则）。
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

  // 已固化行：逐行渲染，复用 SelectionText 做选区切片高亮
  return (
    <Box flexDirection="column">
      {message.lines.map((line, i) => (
        <SelectionText
          key={i}
          content={line.content}
          globalRow={globalRow !== undefined ? globalRow + i : undefined}
          anchor={sel.anchor}
          focus={sel.focus}
          baseProps={styleToInkProps(line.style)}
          indent={' '.repeat(line.indent ?? 0)}
        />
      ))}
    </Box>
  );
}
