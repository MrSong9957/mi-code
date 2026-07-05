// src/tui/components/MessageRow.tsx
// 单条消息渲染
//
// 物理本质：把一条 TuiMessage 翻译成 Ink 组件树。
// - 已固化行（lines: FormattedLine[]）：逐行渲染，缩进 + 语义样式
// - 流式 assistant（finalized=false 且 streamingText 非空）：用 StreamingMarkdown 渲染
//   （charter §核心模块 3.2：稳定/不稳定分段缓存，降流式开销）
//
// 非 assistant 的固化行用纯文本（带样式 token）；assistant 的固化行（Phase 5 后）
// 也可选走 Markdown，但本期固化行直接用 FormattedLine 内容（BlockPipeline 已格式化）。

import React from 'react';
import { Box, Text } from 'ink';
import type { TuiMessage } from '../types.js';
import { styleToInkProps } from '../types.js';
import { StreamingMarkdown } from '../streaming/streaming-markdown.js';

export function MessageRow({ message }: { message: TuiMessage }): React.ReactElement {
  // 流式 assistant：用 StreamingMarkdown 渲染累积文本
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
          <Text key={i} {...props}>
            {indent}
            {line.content}
          </Text>
        );
      })}
    </Box>
  );
}
