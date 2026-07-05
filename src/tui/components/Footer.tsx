// src/tui/components/Footer.tsx
// Footer：flexShrink=0 钉底（空消息时紧贴顶部，满消息时被挤到底）
//
// 物理本质：flexbox 列布局里 flexShrink=0 的固定高度块。
// 当上方消息区 flexGrow=1 没有内容时塌缩，footer 自然紧贴顶部；
// 消息撑开后消息区占满，footer 被推到最底。无需手算坐标。
//
// 结构（对齐 charter §顶层布局）：
//   ────────────────（上边框）
//   ❯ {input}       （输入框，本期单行）
//   ────────────────（下边框）
//   {status}        （状态栏）

import React from 'react';
import { Box, Text } from 'ink';
import { StatusBar } from './StatusBar.js';
import type { StatusBarData } from '../types.js';

const BORDER_COLOR = 'gray';
const PROMPT_COLOR = 'green';

export interface FooterProps {
  input: string;
  cursor: number;
  status: StatusBarData;
  cols: number;
}

export function Footer({ input, status, cols }: FooterProps): React.ReactElement {
  const border = '─'.repeat(Math.max(0, cols));
  return (
    <Box flexShrink={0} flexDirection="column">
      <Text color={BORDER_COLOR}>{border}</Text>
      <Text>
        <Text color={PROMPT_COLOR} bold>{'❯ '}</Text>
        {input}
      </Text>
      <Text color={BORDER_COLOR}>{border}</Text>
      <StatusBar status={status} />
    </Box>
  );
}
