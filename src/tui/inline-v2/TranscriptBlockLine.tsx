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
import { getUsableWidth } from '../state/wrap-line.js';
import { useTheme } from '../state/theme-context.js';
import { ToolBlockLine } from './ToolBlockLine.js';
import { AskBlockLine } from './AskBlockLine.js';
import { AssistantBlockLine } from './AssistantBlockLine.js';
import {
  layoutUserBlockRows,
  shouldShowUserPrompt,
  USER_PROMPT,
} from './user-block-layout.js';
import { formatSpinnerDuration } from '../state/spinner-store.js';

export interface TranscriptBlockLineProps {
  block: TranscriptBlock;
  cols: number;
}

/** 穷尽性检查:union 收窄到底时报错。 */
function assertNever(value: never): never {
  throw new Error(`Unexpected transcript block: ${JSON.stringify(value)}`);
}

/**
 * UserBlock 渲染叶子：纯布局函数产出未填充的可见文本行，整行背景由
 * Ink Box width + backgroundColor 承载（不向文本追加视觉填充空格）。
 * 首物理行按需前缀绿色粗体 '❯'，正文前景色保持现状。
 */
function UserBlockLine({ text, width }: { text: string; width: number }): React.ReactElement {
  const theme = useTheme();
  const rows = layoutUserBlockRows(text, width);
  const showPrompt = shouldShowUserPrompt(text, width);

  return (
    <Box width={width} flexDirection="column">
      {rows.map((row, index) => {
        const isPromptRow = index === 0 && showPrompt;
        const body = isPromptRow ? row.slice(USER_PROMPT.length) : row;
        return (
          <Box
            key={`user-row-${index}`}
            width={width}
            height={1}
            backgroundColor={theme.bgMuted}
          >
            <Text>
              {isPromptRow && <Text color="green" bold>❯</Text>}
              {isPromptRow ? ` ${body}` : body}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function TranscriptBlockLine({ block, cols }: TranscriptBlockLineProps): React.ReactElement {
  switch (block.kind) {
    case 'user': {
      const width = getUsableWidth(cols);
      return <UserBlockLine text={block.text} width={width} />;
    }

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
