// src/tui/inline-v2/PendingAgentMessage.tsx
//
// 运行中子代理(pending-agent)的稳定单行指示器组件。
//
// 物理本质:PendingAgent(kind:'pending-agent')用固定一行的闪烁 ● 表示"子代理正在执行"。
// 与 PendingToolMessage/PendingThinkingMessage 同构:
// - 固定高度 height={1},过长用 wrap="truncate-end" 单行截断。
// - 闪烁 ● 复用共享 spinner 时钟(useSpinnerClock)。
// - 叶子订阅:本组件自己订阅 spinnerStore.time/active,tick 不拖动 InlineAppV2 重渲染。
// - 正文:`子代理 "label"` 或 `Agent "label"`(本地化)。

import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand/react';
import { useLocale } from '../../locale/context.js';
import type { SpinnerStore } from '../state/spinner-store.js';
import type { PendingAgent } from '../transcript-types.js';
import { isPendingGlyphVisible } from './pending-tool-indicator.js';

export interface PendingAgentMessageProps {
  agent: PendingAgent;
  cols: number;
  spinnerStore: SpinnerStore;
}

/**
 * PendingAgentMessage:运行中子代理的稳定单行指示器。
 *
 * 渲染契约与 PendingToolMessage 一致:
 * - height={1} width={cols},flexDirection="row"
 * - glyph 槽 width={2}(与工具行对齐),内容 ● 或空格
 * - 正文 `Agent "label"` truncate-end
 *
 * 闪烁逻辑:active=false → ● 始终可见;active=true → 按 isPendingGlyphVisible(time)。
 */
export const PendingAgentMessage = React.memo(function PendingAgentMessage({
  agent,
  cols,
  spinnerStore,
}: PendingAgentMessageProps): React.ReactElement {
  const time = useStore(spinnerStore, (state) => state.time);
  const active = useStore(spinnerStore, (state) => state.active);
  const visible = !active || isPendingGlyphVisible(time);
  const { t } = useLocale();
  const body = `${t('subagent.statusLineLabel')} "${agent.label}"`;

  return (
    <Box height={1} width={cols} flexDirection="row">
      <Box width={2} minWidth={2} height={1}>
        <Text>{visible ? '●' : ' '}</Text>
      </Box>
      <Text wrap="truncate-end">{body}</Text>
    </Box>
  );
});
