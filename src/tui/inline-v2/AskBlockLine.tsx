// src/tui/inline-v2/AskBlockLine.tsx
//
// 渲染一个已固化的 AskBlock(ask_user_question 结果)。
//
// 输出契约(与旧 agent-completion 渲染一致):
//   ● Answered 2 questions     ← summary(brand 色)
//     ⎿ Auth → OAuth           ← 每个 item(dim 色,⎿ 前缀)
//     ⎿ Lib → A, B
//
// 组件不检查 toolName/agent-completion/raw structured outcome——只消费语义 AskBlock。

import React from 'react';
import { Box, Text } from 'ink';
import type { AskBlock } from '../transcript-types.js';

export interface AskBlockLineProps {
  block: AskBlock;
  cols: number;
}

export function AskBlockLine({ block, cols }: AskBlockLineProps): React.ReactElement {
  return (
    <Box flexDirection="column" width={cols}>
      <Text>
        <Text color="magenta">●</Text>
        {' ' + block.summary}
      </Text>
      {block.items.map((item, i) => (
        <Text key={i} dimColor>{'  ⎿ ' + item}</Text>
      ))}
    </Box>
  );
}
