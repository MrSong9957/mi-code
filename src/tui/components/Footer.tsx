// src/tui/components/Footer.tsx
// Footer：flexShrink=0 钉底 + 输入框光标定位
//
// 物理本质：flexbox 列布局里 flexShrink=0 的固定高度块。
// 结构（对齐 charter §顶层布局）：上边框 / ❯ 输入 / 下边框 / 状态栏。
//
// 光标定位（Bug 1 修复）：用 Ink useCursor 把终端光标定位到输入框 `❯ ` 之后 + cursor 偏移处。
// y 坐标由 App 算好传入（输入行的全局 y = ScrollBox 实际行数 + LOGO_ROWS + 上边框）。

import React from 'react';
import { Box, Text, useCursor } from 'ink';
import { StatusBar } from './StatusBar.js';
import { cursorScreenPos } from '../state/cursor-position.js';
import type { StatusBarData } from '../types.js';

const PROMPT = '❯ '; // 第 0 行 prompt（影响 x 偏移）

export interface FooterProps {
  input: string;
  cursor: number;
  status: StatusBarData;
  cols: number;
  /** 输入行在 Ink 输出中的全局 y 坐标（用于光标定位） */
  inputRowY: number;
}

export function Footer({ input, cursor, status, cols, inputRowY }: FooterProps): React.ReactElement {
  const { setCursorPosition } = useCursor();
  // 光标定位（Bug 1 修复）：用 stringWidth 算显示宽度，CJK 不再被一分为二。
  // 多行时 y 还要加上光标所在行偏移。
  const pos = cursorScreenPos(input, cursor, PROMPT);
  setCursorPosition({ x: pos.x, y: inputRowY + pos.y });

  const border = '─'.repeat(Math.max(0, cols));
  return (
    <Box flexShrink={0} flexDirection="column">
      <Text color="gray">{border}</Text>
      <Text>
        <Text color="green" bold>❯ </Text>
        {input}
      </Text>
      <Text color="gray">{border}</Text>
      <StatusBar status={status} />
    </Box>
  );
}
