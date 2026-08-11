// src/tui/inline-v2/AgentBlockLine.tsx
//
// 一等公民子代理完成块的单行渲染组件。
//
// 物理本质:把 AgentBlock(kind:'agent')渲染成终端单行:
//   ● Agent "label" <statusWord> · <duration>
//
// spawn_agent 在 pipeline 层被路由到 agent 生命周期(startAgent/finishAgent/cancelAgent),
// 完成后固化为 AgentBlock,由本组件渲染(不再作为 ToolBlock 处理)。
//
// 渲染规则:
// - ● 属于本组件(标题行前缀)
// - status 词复用 subagent.presentation.status.* 本地化 key
// - 颜色:completed → 正常;cancelled/partial/unknown → dim;failed → red
// - durationMs 存在时追加 `· <dur>` 后缀(复用 formatDurationFromMs)

import React from 'react';
import { Box, Text } from 'ink';
import { useLocale } from '../../locale/context.js';
import { formatDurationFromMs } from '../../ui/subagent-presentation.js';
import type { AgentBlock } from '../transcript-types.js';

export interface AgentBlockLineProps {
  block: AgentBlock;
  cols: number;
}

const STATUS_KEYS: Record<AgentBlock['status'], string> = {
  completed: 'subagent.presentation.status.finished',
  partial: 'subagent.presentation.status.partial',
  failed: 'subagent.presentation.status.failed',
  cancelled: 'subagent.presentation.status.cancelled',
  unknown: 'subagent.presentation.status.unknown',
};

/**
 * AgentBlockLine:一等公民子代理完成块的单行渲染。
 *
 * 与 ToolBlockLine 的 compact-completion 渲染对齐:
 * `● Agent "label" finished · 5s`(en-US)。
 */
export function AgentBlockLine({ block, cols }: AgentBlockLineProps): React.ReactElement {
  const { t } = useLocale();
  const statusWord = t(STATUS_KEYS[block.status] as 'subagent.presentation.status.finished');
  const durationSuffix = block.durationMs !== undefined
    ? ' · ' + formatDurationFromMs(block.durationMs, { t })
    : '';

  const line = `● ${t('subagent.statusLineLabel')} "${block.label}" ${statusWord}${durationSuffix}`;

  const dim = block.status === 'cancelled' || block.status === 'partial' || block.status === 'unknown';
  const red = block.status === 'failed';

  return (
    <Box width={cols}>
      <Text
        wrap="truncate-end"
        color={red ? 'red' : undefined}
        dimColor={dim}
      >
        {line}
      </Text>
    </Box>
  );
}
