import type { Token, Tokens } from 'marked';
import { displayWidth } from '../inline/text-layout.js';

export type TableTextStyle = 'strong' | 'em' | 'code' | 'link' | 'del';

export interface TableSpan {
  text: string;
  styles: readonly TableTextStyle[];
}

export interface TableLayoutLine {
  spans: readonly TableSpan[];
}

export interface TableLayout {
  mode: 'bordered' | 'key-value';
  lines: readonly TableLayoutLine[];
  columnWidths: readonly number[];
}

type LogicalLine = TableSpan[];
type LogicalCell = LogicalLine[];

const EMPTY_STYLES: readonly TableTextStyle[] = [];

function appendSpan(line: LogicalLine, text: string, styles: readonly TableTextStyle[]): void {
  if (text === '') return;
  const previous = line.at(-1);
  const sameStyles = previous
    && previous.styles.length === styles.length
    && previous.styles.every((style, index) => style === styles[index]);
  if (sameStyles) {
    previous.text += text;
    return;
  }
  line.push({ text, styles: [...styles] });
}

function hasTokenArray(token: Token): token is Token & { tokens: Token[] } {
  return 'tokens' in token && Array.isArray(token.tokens);
}

function tokenFallbackText(token: Token): string {
  if ('text' in token && typeof token.text === 'string') return token.text;
  return typeof token.raw === 'string' ? token.raw : '';
}

function inlineTokenLines(
  tokens: Token[],
  inherited: readonly TableTextStyle[] = EMPTY_STYLES,
): LogicalCell {
  const lines: LogicalCell = [[]];

  const appendNested = (nested: LogicalCell): void => {
    nested.forEach((nestedLine, index) => {
      if (index > 0) lines.push([]);
      for (const span of nestedLine) appendSpan(lines.at(-1)!, span.text, span.styles);
    });
  };

  for (const token of tokens) {
    if (token.type === 'br') {
      lines.push([]);
      continue;
    }

    const style = token.type === 'strong' ? 'strong'
      : token.type === 'em' ? 'em'
      : token.type === 'codespan' ? 'code'
      : token.type === 'link' ? 'link'
      : token.type === 'del' ? 'del'
      : undefined;
    const styles = style ? [...inherited, style] : inherited;

    if (token.type === 'codespan') {
      appendSpan(lines.at(-1)!, token.text, styles);
    } else if (token.type === 'image') {
      appendSpan(lines.at(-1)!, token.text, inherited);
    } else if (hasTokenArray(token) && token.tokens.length > 0) {
      appendNested(inlineTokenLines(token.tokens, styles));
    } else {
      appendSpan(lines.at(-1)!, tokenFallbackText(token), styles);
    }
  }
  return lines;
}

function logicalLineWidth(line: LogicalLine): number {
  return line.reduce((width, span) => width + displayWidth(span.text), 0);
}

function logicalCellWidth(cell: LogicalCell): number {
  return Math.max(0, ...cell.map(logicalLineWidth));
}

function appendUnstyled(line: LogicalLine, text: string): void {
  appendSpan(line, text, EMPTY_STYLES);
}

function borderLine(widths: readonly number[], left: string, join: string, right: string): TableLayoutLine {
  const spans: LogicalLine = [];
  appendUnstyled(spans, left);
  widths.forEach((width, index) => {
    if (index > 0) appendUnstyled(spans, join);
    appendUnstyled(spans, '─'.repeat(width + 2));
  });
  appendUnstyled(spans, right);
  return { spans };
}

function contentLine(cells: readonly LogicalCell[], lineIndex: number, widths: readonly number[]): TableLayoutLine {
  const spans: LogicalLine = [];
  appendUnstyled(spans, '│');
  cells.forEach((cell, column) => {
    const content = cell[lineIndex] ?? [];
    appendUnstyled(spans, ' ');
    for (const span of content) appendSpan(spans, span.text, span.styles);
    appendUnstyled(spans, ' '.repeat(widths[column]! - logicalLineWidth(content) + 1));
    appendUnstyled(spans, '│');
  });
  return { spans };
}

function validateTable(table: Tokens.Table, availableWidth: number): void {
  if (availableWidth < 1 || table.header.length === 0) {
    throw new TypeError('table requires a positive available width and non-empty header');
  }
  const cells = [...table.header, ...table.rows.flat()];
  if (cells.some((cell) => !Array.isArray(cell.tokens))) {
    throw new TypeError('table cells require inline tokens');
  }
  if (table.rows.some((row) => row.length !== table.header.length)) {
    throw new TypeError('table rows must match the header length');
  }
}

export function tableLineText(line: TableLayoutLine): string {
  return line.spans.map((span) => span.text).join('');
}

export function layoutMarkdownTable(table: Tokens.Table, availableWidth: number): TableLayout {
  validateTable(table, availableWidth);

  const header = table.header.map((cell) => inlineTokenLines(cell.tokens));
  const rows = table.rows.map((row) => row.map((cell) => inlineTokenLines(cell.tokens)));
  const columnWidths = table.header.map((_, column) => Math.max(
    1,
    logicalCellWidth(header[column]!),
    ...rows.map((row) => logicalCellWidth(row[column]!)),
  ));
  const lines: TableLayoutLine[] = [borderLine(columnWidths, '┌', '┬', '┐')];

  lines.push(...Array.from(
    { length: Math.max(...header.map((cell) => cell.length)) },
    (_, lineIndex) => contentLine(header, lineIndex, columnWidths),
  ));
  lines.push(borderLine(columnWidths, '├', '┼', '┤'));
  for (const row of rows) {
    lines.push(...Array.from(
      { length: Math.max(...row.map((cell) => cell.length)) },
      (_, lineIndex) => contentLine(row, lineIndex, columnWidths),
    ));
  }
  lines.push(borderLine(columnWidths, '└', '┴', '┘'));

  return { mode: 'bordered', lines, columnWidths };
}
