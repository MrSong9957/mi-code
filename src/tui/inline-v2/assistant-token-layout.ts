import type { Token, Tokens } from 'marked';
import {
  layoutMarkdownTable,
  type TableLayoutLine,
} from '../markdown/table-layout.js';

export type AssistantTokenRenderRow =
  | { kind: 'raw'; text: string }
  | { kind: 'table'; line: TableLayoutLine }
  | { kind: 'blank' };

function rawRows(raw: string): AssistantTokenRenderRow[] {
  return raw.split('\n').map((text): AssistantTokenRenderRow => (
    text === '' ? { kind: 'blank' } : { kind: 'raw', text }
  ));
}

function renderToken(token: Token, availableWidth: number): AssistantTokenRenderRow[] {
  if (token.type !== 'table') return rawRows(token.raw);

  try {
    return layoutMarkdownTable(token as Tokens.Table, availableWidth).lines.map(
      (line): AssistantTokenRenderRow => ({ kind: 'table', line }),
    );
  } catch {
    return rawRows(token.raw);
  }
}

function isBoundaryBlank(row: AssistantTokenRenderRow): boolean {
  return row.kind === 'blank';
}

export function layoutCompletedAssistantTokens(
  tokens: Token[],
  availableWidth: number,
): AssistantTokenRenderRow[] {
  const output: AssistantTokenRenderRow[] = [];
  let pendingBoundary = false;

  for (const token of tokens) {
    if (token.type === 'space') {
      pendingBoundary = true;
      continue;
    }

    const rendered = renderToken(token, availableWidth);
    let start = 0;
    let end = rendered.length;
    while (start < end && isBoundaryBlank(rendered[start]!)) start += 1;
    while (end > start && isBoundaryBlank(rendered[end - 1]!)) end -= 1;

    const hasLeadingBoundary = start > 0;
    const hasTrailingBoundary = end < rendered.length;
    const content = rendered.slice(start, end);
    if (content.length === 0) {
      pendingBoundary = pendingBoundary || hasLeadingBoundary || hasTrailingBoundary;
      continue;
    }

    if (output.length > 0 && (pendingBoundary || hasLeadingBoundary)) {
      output.push({ kind: 'blank' });
    }
    output.push(...content);
    pendingBoundary = hasTrailingBoundary;
  }

  return output;
}
