// src/tui/inline-v2/PendingToolMessage.tsx
//
// AUTO-0025-stable Task 1:运行中工具(pending spawn_agent)的稳定指示器组件。
//
// 物理本质:pending 工具用固定一行的闪烁 ● 表示"正在执行"。
// - 固定高度:height={1},过长输入用 wrap="truncate-end" 单行截断,绝不换行。
// - 闪烁:● 每 600ms 切换可见/隐藏,复用共享 spinner 时钟(useSpinnerClock)。
// - 叶子订阅:本组件自己订阅 spinnerStore.time/active,tick 不拖动 InlineAppV2 重渲染。
// - 正文不变:闪烁只改 glyph 槽(固定 2 列宽),正文起始列和总宽度恒定。
//
// 关键设计:组件只读 msg.lines[0],从结构上保证子代理内部明细(lines[1..])不影响高度。
// 这与旧实现(把子工具进度追加到 lines 导致行数爆炸、活动区闪烁)形成对比。

import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand/react';
import type { SpinnerStore } from '../state/spinner-store.js';
import type { TuiMessage } from '../types.js';
import { isPendingToolGlyphVisible } from './pending-tool-indicator.js';

export interface PendingToolMessageProps {
  msg: TuiMessage;
  cols: number;
  spinnerStore: SpinnerStore;
}

/**
 * 剥离开头的工具 glyph(●)及紧随空格,不修改正文中其他字符。
 *
 * 输入契约来自 formatToolCall() 的输出 `● ${display}`:
 * - 规范输入 `● spawn_agent(...)` → 返回 `spawn_agent(...)`(只删开头 ● + 空格)
 * - 无 glyph `spawn_agent(...)` → 原样返回
 * - 空/缺失/仅空白 → 返回 'tool'(回退占位,保证总有可见正文)
 *
 * 注意:只匹配开头的 ●,不误删正文里出现的 ●(如参数里的)。
 */
export function stripLeadingToolGlyph(content?: string): string {
  if (!content || content.trim().length === 0) return 'tool';
  // 只剥离开头的 ● + 紧随的一个空格(如果存在)
  if (content.startsWith('● ')) return content.slice(2);
  if (content.startsWith('●')) return content.slice(1);
  return content;
}

/**
 * PendingToolMessage:运行中工具的稳定单行指示器。
 *
 * 渲染契约:
 * - 整体 height={1} width={cols},flexDirection="row"
 * - glyph 槽:width={2} minWidth={2} height={1},内容 ● 或空格
 * - 正文槽:wrap="truncate-end",占剩余宽度
 *
 * 闪烁逻辑:
 * - active=false(spinner 未启动) → ● 始终可见(避免 pending 刚创建时空白)
 * - active=true → 按 isPendingToolGlyphVisible(time) 切换
 */
export const PendingToolMessage = React.memo(function PendingToolMessage({
  msg,
  cols,
  spinnerStore,
}: PendingToolMessageProps): React.ReactElement {
  // 叶子订阅:tick 只触发本组件重渲染,不冒泡到 InlineAppV2。
  const time = useStore(spinnerStore, (state) => state.time);
  const active = useStore(spinnerStore, (state) => state.active);
  const visible = !active || isPendingToolGlyphVisible(time);
  const callText = stripLeadingToolGlyph(msg.lines[0]?.content);

  return (
    <Box height={1} width={cols} flexDirection="row">
      <Box width={2} minWidth={2} height={1}>
        <Text>{visible ? '●' : ' '}</Text>
      </Box>
      <Text wrap="truncate-end">{callText}</Text>
    </Box>
  );
});
