import React from 'react';
import { Box, Text } from 'ink';
import { lexer } from 'marked';
import { getTheme } from '../../utils/theme.js';
import type { AssistantBlock } from '../transcript-types.js';
import {
  type TableLayoutLine,
  type TableSpan,
} from '../markdown/table-layout.js';
import {
  layoutCompletedAssistantTokens,
  type AssistantTokenRenderRow,
} from './assistant-token-layout.js';

export interface AssistantBlockLineProps {
  block: AssistantBlock;
  cols: number;
}

function StyledSpan({ span }: { span: TableSpan }): React.ReactElement {
  const theme = getTheme();
  return (
    <Text
      bold={span.styles.includes('strong')}
      italic={span.styles.includes('em')}
      underline={span.styles.includes('link')}
      strikethrough={span.styles.includes('del')}
      color={span.styles.includes('code') ? theme.mdCode
        : span.styles.includes('link') ? theme.mdLink
          : undefined}
    >
      {span.text}
    </Text>
  );
}

function TableLine({ line }: { line: TableLayoutLine }): React.ReactElement {
  return (
    <Text>
      {line.spans.length === 0
        ? ' '
        : line.spans.map((span, index) => (
          <StyledSpan key={index} span={span} />
        ))}
    </Text>
  );
}

/**
 * 把 Assistant 专用局部 token 行渲染为 React 节点。
 * - raw：正文行原样输出（Markdown 源文本，由终端自行理解）。
 * - table：交给 TableLine（含 key-value 记录分隔的空 spans）。
 * - blank：段落边界归一化后的唯一空白物理行。
 */
function AssistantRow({ row }: { row: AssistantTokenRenderRow }): React.ReactElement {
  switch (row.kind) {
    case 'raw':
      return <Text>{row.text}</Text>;
    case 'table':
      return <TableLine line={row.line} />;
    case 'blank':
      return <Text>{' '}</Text>;
  }
}

function assistantShell(content: React.ReactNode, cols: number): React.ReactElement {
  return (
    <Box width={cols} flexDirection="row">
      <Text color="magenta">● </Text>
      <Box width={Math.max(1, cols - 2)} flexDirection="column">
        {content}
      </Box>
    </Box>
  );
}

function rawContent(text: string, cols: number): React.ReactElement {
  return assistantShell(<Text>{text}</Text>, cols);
}

export function AssistantBlockLine(
  { block, cols }: AssistantBlockLineProps,
): React.ReactElement {
  if (cols - 2 < 1) return <Text>{block.text}</Text>;
  if (block.interrupted) return rawContent(block.text, cols);

  let tokens;
  try {
    tokens = lexer(block.text);
  } catch {
    return rawContent(block.text, cols);
  }

  let rows: AssistantTokenRenderRow[];
  try {
    rows = layoutCompletedAssistantTokens(tokens, cols - 2);
  } catch {
    return rawContent(block.text, cols);
  }

  const content = rows.map((row, index) => (
    <AssistantRow key={`assistant-row-${index}`} row={row} />
  ));

  return assistantShell(content, cols);
}
