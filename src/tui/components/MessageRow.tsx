// src/tui/components/MessageRow.tsx
// 单条消息渲染（一期纯文本：按 FormattedLine 逐行渲染，带语义样式）
//
// 物理本质：把一条 TuiMessage 的 FormattedLine[] 翻译成 Ink <Text> 树。
// 每行：缩进（前置空格）+ 内容 + 样式（语义 token → Ink props via styleToInkProps）。
//
// 本期：纯文本 + 样式，不做 Markdown（Phase 5 接入）。
// 流式 assistant（finalized=false 且有 streamingText）：由 StreamingMarkdown 渲染，
// 本组件只渲染已固化行；streamingText 的渲染在 App 层分流（本期先按 finalized 决定）。

import React from 'react';
import { Box, Text } from 'ink';
import type { TuiMessage } from '../types.js';
import { styleToInkProps } from '../types.js';

export function MessageRow({ message }: { message: TuiMessage }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {message.lines.map((line, i) => {
        const indent = ' '.repeat(line.indent ?? 0);
        const props = styleToInkProps(line.style);
        return (
          <Text key={i} {...props}>
            {indent}
            {line.content}
          </Text>
        );
      })}
    </Box>
  );
}
