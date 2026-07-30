// src/tui/inline-v2/ToolBlockLine.tsx
//
// 渲染一个已固化的 ToolBlock(分组工具调用)。
//
// 物理本质:把 reducer 产出的语义 ToolBlock 渲染成终端行:
//   ● Searched 4 patterns           ← 标题(buildToolGroupTitle)
//     ⎿ src/**/*.test.ts → 11 files  ← 每个展示的 summary(⎿ 前缀 + 2 空格缩进)
//     ⎿ Thought 3s (2 entries)       ← 思考元数据(如有)
//
// 渲染规则:
// - ● 属于本组件(标题行)
// - 每个可见 summary 用 `  ⎿ ` 前缀
// - status 控制语义颜色:success=正常,empty=dim,error=red
// - 展示按 orderToolPresentations 排序(success → empty → error)
// - thinking 元数据是最后一个子行(summarizeThinking)
// - layout:'compact-completion' 保持单行截断行为(spawn_agent)
// - Phase 1 不展开 details,但数据仍可达(可展开注册)

import React from 'react';
import { Box, Text } from 'ink';
import type { ToolBlock, ToolPresentation } from '../transcript-types.js';
import {
  orderToolPresentations,
  summarizeThinking,
} from '../state/transcript-reducer.js';
import { buildToolGroupTitle } from '../../ui/tool-presentation.js';

export interface ToolBlockLineProps {
  block: ToolBlock;
  cols: number;
}

export function ToolBlockLine({ block, cols }: ToolBlockLineProps): React.ReactElement {
  const title = buildToolGroupTitle(block.toolName, block.presentations.length);
  const ordered = orderToolPresentations(block.presentations);
  const thinkingSummary = summarizeThinking(block.thinking);

  // compact-completion(spawn_agent):单行截断,不换行展示子项。
  const isCompact = block.presentations.some(p => p.layout === 'compact-completion');
  if (isCompact) {
    const line = block.presentations[0]?.summary ?? title;
    return (
      <Box width={cols}>
        <Text wrap="truncate-end">{'● ' + line}</Text>
      </Box>
    );
  }

  // 用 Box flexDirection="column" 让每行自然换行,避免手动 \n 导致末尾空行。
  return (
    <Box flexDirection="column" width={cols}>
      <Text>{'● ' + title}</Text>
      {ordered.map((p: ToolPresentation) => (
        <Text
          key={p.toolUseId}
          color={p.status === 'error' ? 'red' : undefined}
          dimColor={p.status === 'empty'}
        >
          {'  ⎿ ' + p.summary}
        </Text>
      ))}
      {thinkingSummary && (
        <Text dimColor>{'  ⎿ ' + thinkingSummary}</Text>
      )}
    </Box>
  );
}
