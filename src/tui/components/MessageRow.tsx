// src/tui/components/MessageRow.tsx
// 单条消息渲染（支持选区高亮）
//
// 物理本质：把一条 TuiMessage 翻译成 Ink 组件树。
// - 已固化行（lines: FormattedLine[]）：逐行渲染，缩进 + 语义样式
// - 流式 assistant（finalized=false 且 streamingText 非空）：用 StreamingMarkdown 渲染
// - selected=true：每行叠加 inverse（SGR 7 反转高亮，charter §核心模块 2 选区视觉）

import React from 'react';
import { Box, Text } from 'ink';
import type { TuiMessage } from '../types.js';
import { styleToInkProps } from '../types.js';
import { StreamingMarkdown } from '../streaming/streaming-markdown.js';

export interface MessageRowProps {
  message: TuiMessage;
  /** 是否在选区内（行级高亮，叠加 inverse） */
  selected?: boolean;
}

export function MessageRow({ message, selected = false }: MessageRowProps): React.ReactElement {
  // 流式 assistant：用 StreamingMarkdown 渲染累积文本
  // （流式中文本在变，不参与选区高亮——selected 对流式块忽略）
  if (!message.finalized && message.role === 'assistant' && message.streamingText !== undefined) {
    return (
      <Box flexDirection="column">
        <StreamingMarkdown text={message.streamingText} />
      </Box>
    );
  }

  // 已固化行：逐行渲染
  return (
    <Box flexDirection="column">
      {message.lines.map((line, i) => {
        const indent = ' '.repeat(line.indent ?? 0);
        const props = styleToInkProps(line.style);
        return (
          <Text key={i} {...props} inverse={selected || props.inverse}>
            {indent}
            {line.content}
          </Text>
        );
      })}
    </Box>
  );
}
