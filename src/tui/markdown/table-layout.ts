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
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

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

function hasInlineTokenArray(
  token: Token,
): token is Tokens.Strong | Tokens.Em | Tokens.Link | Tokens.Del {
  return (token.type === 'strong' || token.type === 'em' || token.type === 'link' || token.type === 'del')
    && Array.isArray(token.tokens);
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

    const style: TableTextStyle | undefined = token.type === 'strong' ? 'strong'
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
    } else if (hasInlineTokenArray(token) && token.tokens.length > 0) {
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

function logicalCellMaxCharacterWidth(cell: LogicalCell): number {
  let maximum = 0;
  for (const line of cell) {
    for (const span of line) {
      for (const character of span.text) maximum = Math.max(maximum, displayWidth(character));
    }
  }
  return maximum;
}

function maxSingleCharWidthInColumn(
  header: LogicalCell,
  rows: readonly LogicalCell[][],
  column: number,
): number {
  return Math.max(
    logicalCellMaxCharacterWidth(header),
    ...rows.map((row) => logicalCellMaxCharacterWidth(row[column]!)),
  );
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

function totalTableWidth(widths: readonly number[]): number {
  return widths.reduce((total, width) => total + width + 2, 0) + widths.length + 1;
}

function shrinkWidths(
  optimal: readonly number[],
  minimum: readonly number[],
  availableWidth: number,
): number[] {
  const widths = [...optimal];
  let total = totalTableWidth(widths);
  while (total > availableWidth) {
    let candidate = -1;
    for (let index = 0; index < widths.length; index += 1) {
      if (widths[index]! <= minimum[index]!) continue;
      if (candidate === -1 || widths[index]! > widths[candidate]!) candidate = index;
    }
    if (candidate === -1) {
      throw new TypeError('table widths cannot shrink to the available width');
    }
    widths[candidate] -= 1;
    total -= 1;
  }
  return widths;
}

function foldLogicalLine(line: LogicalLine, width: number): LogicalCell {
  const output: LogicalCell = [[]];
  let used = 0;
  let activeSgr = '';

  const appendCharacter = (character: string, styles: readonly TableTextStyle[]): void => {
    const characterWidth = displayWidth(character);
    if (used > 0 && used + characterWidth > width) {
      if (activeSgr !== '') appendSpan(output.at(-1)!, '\x1b[0m', styles);
      output.push([]);
      if (activeSgr !== '') appendSpan(output.at(-1)!, activeSgr, styles);
      used = 0;
    }
    appendSpan(output.at(-1)!, character, styles);
    used += characterWidth;
  };

  for (const span of line) {
    let textIndex = 0;
    for (const match of span.text.matchAll(ANSI_SGR)) {
      const matchIndex = match.index ?? 0;
      for (const character of span.text.slice(textIndex, matchIndex)) {
        appendCharacter(character, span.styles);
      }
      const sgr = match[0];
      appendSpan(output.at(-1)!, sgr, span.styles);
      activeSgr = sgr === '\x1b[0m' ? '' : `${activeSgr}${sgr}`;
      textIndex = matchIndex + sgr.length;
    }
    for (const character of span.text.slice(textIndex)) {
      appendCharacter(character, span.styles);
    }
  }
  if (activeSgr !== '') appendSpan(output.at(-1)!, '\x1b[0m', EMPTY_STYLES);
  return output;
}

function foldLogicalCell(cell: LogicalCell, width: number): LogicalCell {
  return cell.flatMap((line) => foldLogicalLine(line, width));
}

function alignLine(
  line: LogicalLine,
  width: number,
  align: Tokens.Table['align'][number],
): LogicalLine {
  const remaining = width - logicalLineWidth(line);
  const left = align === 'right' ? remaining
    : align === 'center' ? Math.floor(remaining / 2)
      : 0;
  const right = remaining - left;
  return [
    { text: ' '.repeat(left), styles: EMPTY_STYLES },
    ...line,
    { text: ' '.repeat(right), styles: EMPTY_STYLES },
  ];
}

function contentLine(
  cells: readonly LogicalCell[],
  lineIndex: number,
  widths: readonly number[],
  alignments: readonly Tokens.Table['align'][number][],
): TableLayoutLine {
  const spans: LogicalLine = [];
  appendUnstyled(spans, '│');
  cells.forEach((cell, column) => {
    const content = alignLine(cell[lineIndex] ?? [], widths[column]!, alignments[column]!);
    appendUnstyled(spans, ' ');
    for (const span of content) appendSpan(spans, span.text, span.styles);
    appendUnstyled(spans, ' ');
    appendUnstyled(spans, '│');
  });
  return { spans };
}

function layoutKeyValueTable(table: Tokens.Table, availableWidth: number): TableLayout {
  const lines: TableLayoutLine[] = [];
  const headers = table.header.map((cell) => inlineTokenLines(cell.tokens));

  table.rows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      const label = headers[columnIndex] ?? [[]];
      const value = inlineTokenLines(cell.tokens);
      const labelSpans = label.flat();
      const labelText = labelSpans.map((span) => span.text).join('');
      const prefix = `${labelText}: `;
      const prefixWidth = displayWidth(prefix);

      if (prefixWidth >= availableWidth) {
        lines.push({
          spans: [...labelSpans, { text: ':', styles: EMPTY_STYLES }],
        });
        for (const logicalLine of value) {
          for (const folded of foldLogicalLine(logicalLine, availableWidth)) {
            lines.push({ spans: folded });
          }
        }
        return;
      }

      const firstBudget = availableWidth - prefixWidth;
      const foldedValue = value.flatMap((logicalLine) => foldLogicalLine(logicalLine, firstBudget));
      const first = foldedValue.shift() ?? [];
      lines.push({
        spans: [...labelSpans, { text: ': ', styles: EMPTY_STYLES }, ...first],
      });
      for (const continuation of foldedValue) {
        lines.push({
          spans: [
            { text: ' '.repeat(prefixWidth), styles: EMPTY_STYLES },
            ...continuation,
          ],
        });
      }
    });
    if (rowIndex < table.rows.length - 1) lines.push({ spans: [] });
  });

  return {
    mode: 'key-value',
    lines,
    columnWidths: table.header.map((cell) => Math.max(
      1,
      ...inlineTokenLines(cell.tokens).map(logicalLineWidth),
    )),
  };
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
  const minimumWidths = header.map((cell, column) => Math.max(
    1,
    logicalCellWidth(cell),
    maxSingleCharWidthInColumn(cell, rows, column),
  ));
  if (totalTableWidth(minimumWidths) > availableWidth) {
    if (table.rows.length === 0) {
      throw new TypeError('header-only table cannot use key-value fallback');
    }
    return layoutKeyValueTable(table, availableWidth);
  }
  const optimalWidths = table.header.map((_, column) => Math.max(
    1,
    minimumWidths[column]!,
    ...rows.map((row) => logicalCellWidth(row[column]!)),
  ));
  const columnWidths = shrinkWidths(optimalWidths, minimumWidths, availableWidth);
  const alignments = table.align;
  const wrappedHeader = header.map((cell, column) => foldLogicalCell(cell, columnWidths[column]!));
  const wrappedRows = rows.map((row) => row.map(
    (cell, column) => foldLogicalCell(cell, columnWidths[column]!),
  ));
  const lines: TableLayoutLine[] = [borderLine(columnWidths, '┌', '┬', '┐')];

  lines.push(...Array.from(
    { length: Math.max(...wrappedHeader.map((cell) => cell.length)) },
    (_, lineIndex) => contentLine(wrappedHeader, lineIndex, columnWidths, alignments),
  ));
  lines.push(borderLine(columnWidths, '├', '┼', '┤'));
  for (const row of wrappedRows) {
    lines.push(...Array.from(
      { length: Math.max(...row.map((cell) => cell.length)) },
      (_, lineIndex) => contentLine(row, lineIndex, columnWidths, alignments),
    ));
  }
  lines.push(borderLine(columnWidths, '└', '┴', '┘'));

  return { mode: 'bordered', lines, columnWidths };
}
