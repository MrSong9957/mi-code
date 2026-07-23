// src/tui/inline-v2/PendingThinkingMessage.tsx
//
// AUTO-0025-transient Task 1:模型 thinking 的临时闪烁活动行。
//
// 物理本质:模型思考时显示一条固定高度的闪烁 ● Thinking… 行,完成后消失,
// 留下永久 Thought 摘要。与 PendingToolMessage 同构:
// - 固定高度 height={1},文本固定 "Thinking…"(不消费 msg,因为内容是固定的标题)
// - 闪烁 ● 复用共享 spinner 时钟,600ms 周期
// - 叶子订阅:tick 不拖动 InlineAppV2 重渲染
//
// 设计决策:组件不接收 msg prop。thinking 临时行的文本永远是 "Thinking…",
// 真正的推理内容只缓存在 BlockPipeline.thinkingBuffer(供 Ctrl+O 展开),不显示在这里。

import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand/react';
import type { SpinnerStore } from '../state/spinner-store.js';
import { isPendingGlyphVisible } from './pending-tool-indicator.js';

export interface PendingThinkingMessageProps {
  cols: number;
  spinnerStore: SpinnerStore;
}

/**
 * PendingThinkingMessage:thinking 临时闪烁行。
 *
 * 渲染契约与 PendingToolMessage 一致:
 * - height={1} width={cols},flexDirection="row"
 * - glyph 槽 width={2}(与工具行对齐),内容 ● 或空格
 * - 正文 "Thinking…" truncate-end
 *
 * 闪烁逻辑:active=false → ● 始终可见;active=true → 按 isPendingGlyphVisible(time)。
 */
export const PendingThinkingMessage = React.memo(function PendingThinkingMessage({
  cols,
  spinnerStore,
}: PendingThinkingMessageProps): React.ReactElement {
  const time = useStore(spinnerStore, (state) => state.time);
  const active = useStore(spinnerStore, (state) => state.active);
  const visible = !active || isPendingGlyphVisible(time);

  return (
    <Box height={1} width={cols} flexDirection="row">
      <Box width={2} minWidth={2} height={1}>
        <Text>{visible ? '●' : ' '}</Text>
      </Box>
      <Text wrap="truncate-end">Thinking…</Text>
    </Box>
  );
});
