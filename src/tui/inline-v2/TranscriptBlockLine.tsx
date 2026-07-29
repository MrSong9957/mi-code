// src/tui/inline-v2/TranscriptBlockLine.tsx
//
// 已固化 TranscriptBlock 的渲染路由组件。
//
// 物理本质:把语义 TranscriptBlock(kind 判别)路由到对应的渲染组件。
// 这是 <Static> 的 children render prop 入口——InlineAppV2 把每个
// selectCommittedTranscript() 返回的块交给本组件。
//
// 渲染分派(穷尽 switch,无字符串匹配):
// - user → 用户输入(❯ 前缀,success 色)
// - assistant → 助手文本(● 前缀,brand 色)
// - tool → ToolBlockLine
// - ask → AskBlockLine
// - system(thinking-summary) → dim 思考摘要
// - system(notification) → 系统通知
// - turn-duration → ✻ verb for Ns(dim)
// - default → assertNever(编译期穷尽检查)

import React from 'react';
import { Box, Text } from 'ink';
import type { TranscriptBlock } from '../transcript-types.js';
import { ToolBlockLine } from './ToolBlockLine.js';
import { AskBlockLine } from './AskBlockLine.js';
import { AssistantBlockLine } from './AssistantBlockLine.js';
import { formatSpinnerDuration } from '../state/spinner-store.js';

export interface TranscriptBlockLineProps {
  block: TranscriptBlock;
  cols: number;
}

/** 穷尽性检查:union 收窄到底时报错。 */
function assertNever(value: never): never {
  throw new Error(`Unexpected transcript block: ${JSON.stringify(value)}`);
}

export function TranscriptBlockLine({ block, cols }: TranscriptBlockLineProps): React.ReactElement {
  switch (block.kind) {
    case 'user':
      return (
        <Box width={cols}>
          <Text>
            <Text color="green" bold>❯</Text>
            {' ' + block.text}
          </Text>
        </Box>
      );

    case 'assistant':
      return <AssistantBlockLine block={block} cols={cols} />;

    case 'tool':
      return <ToolBlockLine block={block} cols={cols} />;

    case 'ask':
      return <AskBlockLine block={block} cols={cols} />;

    case 'system':
      if (block.subkind === 'thinking-summary') {
        return (
          <Box width={cols}>
            <Text dimColor>{'  ' + block.text}</Text>
          </Box>
        );
      }
      // notification
      return (
        <Box width={cols}>
          <Text color={block.tone === 'error' ? 'red' : undefined}>{block.text}</Text>
        </Box>
      );

    case 'turn-duration':
      return (
        <Box width={cols}>
          <Text dimColor>{'✻ ' + block.verb + ' for ' + formatSpinnerDuration(block.durationMs)}</Text>
        </Box>
      );

    default:
      return assertNever(block);
  }
}
