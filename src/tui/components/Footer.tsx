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
import { Spinner } from './Spinner.js';
import type { SpinnerStore } from '../state/spinner-store.js';
import { SuggestionBar } from './SuggestionBar.js';
import type { CompletionStore } from '../state/completion-store.js';

const PROMPT = '❯ '; // 第 0 行 prompt（影响 x 偏移）

export interface FooterProps {
  input: string;
  cursor: number;
  status: StatusBarData;
  cols: number;
  /** 输入行在 Ink 输出中的全局 y 坐标（用于光标定位） */
  inputRowY: number;
  /** spinner store（active 时渲染加载指示） */
  spinnerStore: SpinnerStore;
  /** 补全候选 store（visible 时渲染候选条） */
  completionStore: CompletionStore;
}

export function Footer({ input, cursor, status, cols, inputRowY, spinnerStore, completionStore }: FooterProps): React.ReactElement {
  const { setCursorPosition } = useCursor();
  // 光标定位（Bug 1 修复）：用 stringWidth 算显示宽度，CJK 不再被一分为二。
  // 多行时 y 还要加上光标所在行偏移。
  const pos = cursorScreenPos(input, cursor, PROMPT);
  setCursorPosition({ x: pos.x, y: inputRowY + pos.y });

  // 输入行光标目标标记：yoga-walk 遍历时读这个 Box 的绝对 y 定位终端光标。
  // ⚠️ Ink <Box> 默认不转发 internal_cursorTarget（它只转发 ref/style/internal_accessibility/children），
  // 故 patches/ink+7.1.0.patch 给 Box.js 打了补丁让它透传该 prop 到底层 <ink-box> host
  // component，reconciler 在 createInstance 时挂到 node.internal_cursorTarget。
  // 之前用 ref 回调打标记的方案失败：Ink 的 resetAfterCommit（调 renderer）早于 React
  // 的 ref attach，renderer 遍历时标记还没设上 → cursorTargetY 永远 undefined。
  const border = '─'.repeat(Math.max(0, cols));
  return (
    <Box flexShrink={0} flexDirection="column">
      <Spinner store={spinnerStore} />
      <SuggestionBar store={completionStore} />
      <Text color="gray">{border}</Text>
      <Box {...{ internal_cursorTarget: true } as Record<string, unknown>}>
        <Text>
          <Text color="green" bold>❯ </Text>
          {input}
        </Text>
      </Box>
      <Text color="gray">{border}</Text>
      <StatusBar status={status} />
    </Box>
  );
}
