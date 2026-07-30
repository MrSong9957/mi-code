import React from 'react';
import { Box, Text } from 'ink';
import { lexer, type Token, type Tokens } from 'marked';
import { getTheme } from '../../utils/theme.js';
import type { AssistantBlock } from '../transcript-types.js';
import {
  layoutMarkdownTable,
  type TableLayoutLine,
  type TableSpan,
} from '../markdown/table-layout.js';

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

  let tokens: Token[];
  try {
    tokens = lexer(block.text);
  } catch {
    return rawContent(block.text, cols);
  }

  const content = tokens.flatMap((token, index) => {
    if (token.type !== 'table') return <Text key={index}>{token.raw}</Text>;

    try {
      return layoutMarkdownTable(token as Tokens.Table, cols - 2).lines.map((line, lineIndex) => (
        <TableLine key={`${index}-${lineIndex}`} line={line} />
      ));
    } catch {
      return <Text key={index}>{token.raw}</Text>;
    }
  });

  return assistantShell(content, cols);
}
