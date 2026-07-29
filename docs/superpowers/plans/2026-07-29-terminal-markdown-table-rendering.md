# Terminal Markdown Table Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render completed Inline V2 assistant Markdown tables as width-aware terminal tables while preserving raw Markdown during streaming and interruption.

**Architecture:** Add one pure `table-layout.ts` module as the core anchor: it converts `marked` inline tokens into styled runs, calculates the three width modes, and emits terminal lines whose borders and content share one width model. Add `AssistantBlockLine.tsx` as the render-layer adapter that parses finalized text, keeps non-table tokens raw, catches parser/table failures, and maps styled runs to Ink; `TranscriptBlockLine` remains a routing component and the store remains unchanged.

**Tech Stack:** TypeScript 6, React 19, Ink 7, `marked@^18.0.5`, Vitest, `ink-testing-library`

## Global Constraints

- Do not add a dependency; reuse `marked.lexer`, `Tokens.Table`, `displayWidth`, Ink, and Vitest.
- `AssistantBlock.text` remains raw Markdown and is never rewritten with border characters.
- Streaming and `interrupted: true` assistant content remains raw Markdown.
- Only table tokens receive enhanced rendering; every non-table token continues to use `token.raw`.
- Measure terminal display columns, not `string.length`; CJK/full-width characters count as 2 and ANSI SGR sequences as 0.
- Every bordered physical line must use the same final column-width array and have identical `displayWidth`.
- Width modes are deterministic: optimal bordered, wrapped bordered, then borderless key-value.
- A table-local failure falls back to that table's `token.raw`; a lexer failure falls back to the whole assistant raw text.
- Borders and padding use the default foreground color; only inline code, links, emphasis, and deletion retain necessary styles.
- Work in the current repository state without cleaning or rewriting unrelated user changes.

---

### Task 1: Inline token semantics and style-preserving width primitives

**Files:**
- Create: `src/tui/markdown/table-layout.ts`
- Create: `src/__tests__/tui/table-layout.test.ts`

**Interfaces:**
- Consumes: `Token[]` and `Tokens.Table` from `marked`; `displayWidth(text)` from `src/tui/inline/text-layout.ts`.
- Produces:

```ts
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

export function tableLineText(line: TableLayoutLine): string;
export function layoutMarkdownTable(
  table: Tokens.Table,
  availableWidth: number,
): TableLayout;
```

- Internal invariant: one cell is represented as `TableSpan[][]`, where the outer array contains logical lines split by `br`.

- [ ] **Step 1: Write failing tests for visible inline-token semantics**

Add a `tableFrom()` helper that obtains the real `Tokens.Table` produced by the installed `marked` version, then assert visible width rather than Markdown source width:

```ts
import { describe, expect, it } from 'vitest';
import { lexer, type Tokens } from 'marked';
import { displayWidth } from '../../tui/inline/text-layout.js';
import {
  layoutMarkdownTable,
  tableLineText,
  type TableLayout,
} from '../../tui/markdown/table-layout.js';

function tableFrom(markdown: string): Tokens.Table {
  const token = lexer(markdown).find(
    (candidate): candidate is Tokens.Table => candidate.type === 'table',
  );
  if (!token) throw new Error('test fixture did not produce a table token');
  return token;
}

function texts(layout: TableLayout): string[] {
  return layout.lines.map(tableLineText);
}

describe('layoutMarkdownTable inline token semantics', () => {
  it('measures formatted text by visible content and preserves styles', () => {
    const table = tableFrom(
      '| Kind | Value |\n'
      + '| --- | --- |\n'
      + '| **bold** | `code` |\n'
      + '| [docs](https://example.com) | *em* |',
    );

    const layout = layoutMarkdownTable(table, 80);
    expect(texts(layout).join('\n')).toContain('│ bold │ code  │');
    expect(layout.lines.flatMap((line) => line.spans).some(
      (span) => span.text === 'bold' && span.styles.includes('strong'),
    )).toBe(true);
    expect(layout.lines.flatMap((line) => line.spans).some(
      (span) => span.text === 'code' && span.styles.includes('code'),
    )).toBe(true);
    expect(texts(layout).join('\n')).not.toContain('https://example.com');
  });

  it('uses the widest br-delimited logical line as the cell width', () => {
    const table = tableFrom('| H |\n| --- |\n| short separator much-longer |');
    table.rows[0]![0]!.tokens = [
      { type: 'text', raw: 'short', text: 'short' },
      { type: 'br', raw: '<br>' },
      { type: 'text', raw: 'much-longer', text: 'much-longer' },
    ];
    const layout = layoutMarkdownTable(table, 80);
    const lines = texts(layout);
    expect(lines).toContain('│ much-longer │');
    expect(layout.columnWidths).toEqual([11]);
  });

  it('measures image alt text, bare links, and unknown tokens without dropping text', () => {
    const table = tableFrom(
      '| Image | URL |\n| --- | --- |\n'
      + '| ![diagram](diagram.png) | https://example.com |',
    );
    table.rows[0]![0]!.tokens.push({
      type: 'extension-token',
      raw: '<fallback>',
    });

    const rendered = texts(layoutMarkdownTable(table, 120)).join('\n');
    expect(rendered).toContain('diagram');
    expect(rendered).toContain('https://example.com');
    expect(rendered).toContain('<fallback>');
  });

  it('counts CJK as two display columns and ignores ANSI SGR width', () => {
    const table = tableFrom('| 项目 | 值 |\n| --- | --- |\n| 中文 | A |');
    const layout = layoutMarkdownTable(table, 40);
    for (const line of texts(layout)) {
      expect(displayWidth(line)).toBe(displayWidth(texts(layout)[0]!));
    }
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run src/__tests__/tui/table-layout.test.ts
```

Expected: FAIL because `src/tui/markdown/table-layout.ts` does not exist.

- [ ] **Step 3: Implement token-to-logical-line conversion and public types**

Create `table-layout.ts` with the public contracts above and these concrete internal rules:

```ts
import type { Token, Tokens } from 'marked';
import { displayWidth } from '../inline/text-layout.js';

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

export function tableLineText(line: TableLayoutLine): string {
  return line.spans.map((span) => span.text).join('');
}
```

The style array order is canonical: recursive traversal appends the current token's style to its
ancestor styles, so equal nesting produces equal array order. The element-by-element comparison
avoids temporary strings and makes that invariant explicit.

For the installed `marked@18`, both `<https://example.com>` autolinks and bare
`https://example.com` URLs are emitted as `link` tokens, whose visible label is processed by the
recursive child-token branch. Any extension-provided or future inline token not covered by the
explicit branches reaches `tokenFallbackText(token)`, which uses string `token.text` when
available and otherwise `token.raw`; it must never be silently skipped.

Implement the first minimal `layoutMarkdownTable` slice for optimal-width, non-wrapping tables only. It must:

- reject `availableWidth < 1`, an empty header, non-array cell tokens, and row/header length mismatch with `TypeError`;
- compute each cell contribution as `max(logicalLineWidth(...))`;
- compute `columnWidths[col]` from the maximum header/data contribution, with an empty header minimum of 1;
- construct `┌─┬─┐`, `│ ... │`, `├─┼─┤`, and `└─┴─┘` from that same array;
- retain spans for content and use unstyled spans for borders/padding;
- return `mode: 'bordered'`.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run:

```bash
npx vitest run src/__tests__/tui/table-layout.test.ts
```

Expected: all four inline-semantics tests PASS.

- [ ] **Step 5: Commit the independently testable token/layout foundation**

```bash
git add src/tui/markdown/table-layout.ts src/__tests__/tui/table-layout.test.ts
git commit -m "feat: add markdown table layout primitives"
```

---

### Task 2: Deterministic bordered layout, wrapping, and alignment

**Files:**
- Modify: `src/tui/markdown/table-layout.ts`
- Modify: `src/__tests__/tui/table-layout.test.ts`

**Interfaces:**
- Consumes: the `TableSpan`, `TableLayoutLine`, `TableLayout`, and logical-cell primitives from Task 1.
- Produces: the complete bordered branch of `layoutMarkdownTable(table, availableWidth)`.
- Invariant: `optimalTotalWidth` and `minimumTotalWidth` both use `Σ(width + 2) + N + 1`.

- [ ] **Step 1: Add failing tests for optimal and wrapped bordered modes**

Append these behavior groups:

```ts
describe('layoutMarkdownTable bordered modes', () => {
  it('uses optimal widths when the complete table fits', () => {
    const table = tableFrom(
      '| Tool | Purpose |\n| --- | --- |\n'
      + '| read_file | Read a file |\n| glob | Find files |',
    );
    const layout = layoutMarkdownTable(table, 80);
    const lines = texts(layout);

    expect(layout.mode).toBe('bordered');
    expect(layout.columnWidths).toEqual([9, 11]);
    expect(lines).toEqual([
      '┌───────────┬─────────────┐',
      '│ Tool      │ Purpose     │',
      '├───────────┼─────────────┤',
      '│ read_file │ Read a file │',
      '│ glob      │ Find files  │',
      '└───────────┴─────────────┘',
    ]);
  });

  it('shrinks the widest eligible column first and wraps cell content', () => {
    const table = tableFrom(
      '| A | Description |\n| --- | --- |\n'
      + '| x | abcdefghijklmnop |',
    );
    const layout = layoutMarkdownTable(table, 22);
    const lines = texts(layout);

    expect(layout.mode).toBe('bordered');
    expect(lines.every((line) => displayWidth(line) === 22)).toBe(true);
    expect(lines.some((line) => line.includes('abcdefghijk'))).toBe(true);
    expect(lines.some((line) => line.includes('lmnop'))).toBe(true);
  });

  it('keeps every border at the same display column for mixed CJK rows', () => {
    const table = tableFrom(
      '| 工具 | Description |\n| --- | --- |\n'
      + '| 读取 | mixed 中文 and English text |',
    );
    const lines = texts(layoutMarkdownTable(table, 28));
    expect(new Set(lines.map(displayWidth))).toEqual(new Set([28]));
    expect(lines.filter((line) => line.includes('│')).every(
      (line) => line.indexOf('│') >= 0,
    )).toBe(true);
  });

  it('applies left, center, and right alignment inside content widths', () => {
    const table = tableFrom(
      '| Left | Center | Right |\n'
      + '| :--- | :---: | ---: |\n'
      + '| x | y | z |',
    );
    const lines = texts(layoutMarkdownTable(table, 80));
    const row = lines.find((line) => line.includes(' x '));
    expect(row).toBe('│ x    │   y    │     z │');
  });

  it('keeps style spans attached after a styled value wraps', () => {
    const table = tableFrom(
      '| H | Description |\n| --- | --- |\n'
      + '| x | **abcdefghijklmnop** |',
    );
    const layout = layoutMarkdownTable(table, 22);
    const styledFragments = layout.lines.flatMap((line) => line.spans)
      .filter((span) => /[a-p]/.test(span.text));
    expect(styledFragments.length).toBeGreaterThan(1);
    expect(styledFragments.every((span) => span.styles.includes('strong'))).toBe(true);
  });
});
```

Keep the exact alignment literal. Its widths are `[4, 6, 5]`: left `x` receives 0/3 content
padding, centered `y` receives 2/3 because the odd remainder goes on the right, and right-aligned
`z` receives 4/0. Each cell then receives one additional outer space on both sides. Do not weaken
the assertion to `toContain`.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
npx vitest run src/__tests__/tui/table-layout.test.ts
```

Expected: FAIL on width shrinking, wrapped physical rows, and alignment.

- [ ] **Step 3: Implement shared width calculation and stable shrinking**

Add these helpers and use them before rendering:

```ts
function totalTableWidth(widths: readonly number[]): number {
  return widths.reduce((total, width) => total + width + 2, 0) + widths.length + 1;
}

/**
 * Precondition: totalTableWidth(minimum) <= availableWidth.
 * The caller routes narrower terminals to layoutKeyValueTable before calling this helper.
 */
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
```

Before calling `shrinkWidths`, calculate header-derived `minimumWidths` and:

```ts
if (totalTableWidth(minimumWidths) > availableWidth) {
  return layoutKeyValueTable(table, availableWidth);
}
```

The `layoutKeyValueTable` symbol is implemented in Task 3. Until then, add a private function that throws `TypeError('key-value layout not implemented')`; Task 2 fixtures must all remain at or above minimum width, so they do not enter it.

- [ ] **Step 4: Implement style-preserving wrapping, padding, and row height**

Add a span-aware fold function that iterates Unicode code points, starts a new physical line before the next character would exceed the budget, and copies the source span's `styles` onto each fragment:

```ts
function foldLogicalLine(line: LogicalLine, width: number): LogicalCell {
  const output: LogicalCell = [[]];
  let used = 0;
  for (const span of line) {
    for (const character of span.text) {
      const characterWidth = displayWidth(character);
      if (used > 0 && used + characterWidth > width) {
        output.push([]);
        used = 0;
      }
      appendSpan(output.at(-1)!, character, span.styles);
      used += characterWidth;
    }
  }
  return output;
}
```

For pre-existing `br` logical lines, fold each line separately and concatenate the results. Render one data record at `max(wrappedCell.length)` physical rows, inserting an empty logical line for shorter cells.

Create one `alignLine(line, width, align)` helper:

```ts
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
```

Construct every border from `finalWidths` and every data line from the same array. Assert in tests, not production code, that all emitted line widths match.

- [ ] **Step 5: Run the layout tests and confirm GREEN**

Run:

```bash
npx vitest run src/__tests__/tui/table-layout.test.ts
```

Expected: all inline and bordered-mode tests PASS.

- [ ] **Step 6: Commit the bordered table algorithm**

```bash
git add src/tui/markdown/table-layout.ts src/__tests__/tui/table-layout.test.ts
git commit -m "feat: add width-aware bordered table layout"
```

---

### Task 3: Extreme-width key-value fallback and defensive table-local failures

**Files:**
- Modify: `src/tui/markdown/table-layout.ts`
- Modify: `src/__tests__/tui/table-layout.test.ts`

**Interfaces:**
- Consumes: logical cells and style-preserving fold primitives from Tasks 1–2.
- Produces: `layoutKeyValueTable(table, availableWidth)` used when `minimumTotalWidth > availableWidth`.
- Error contract: invalid AST or `availableWidth < 1` throws; the render adapter in Task 4 owns raw fallback.

- [ ] **Step 1: Add failing tests for key-value fallback and defensive boundaries**

```ts
describe('layoutMarkdownTable key-value fallback', () => {
  it('falls back when header minimum widths plus borders do not fit', () => {
    const table = tableFrom(
      '| Tool | Description |\n| --- | --- |\n'
      + '| x | abcdef |',
    );
    const layout = layoutMarkdownTable(table, 18);
    expect(layout.mode).toBe('key-value');
    expect(texts(layout)).toEqual([
      'Tool: x',
      'Description: abcde',
      '             f',
    ]);
    expect(texts(layout).every((line) => displayWidth(line) <= 18)).toBe(true);
  });

  it('indents wrapped values to the value start column', () => {
    const table = tableFrom(
      '| Key | Value |\n| --- | --- |\n'
      + '| a | 123456789012345 |',
    );
    const lines = texts(layoutMarkdownTable(table, 12));
    expect(lines).toEqual([
      'Key: a',
      'Value: 12345',
      '       67890',
      '       12345',
    ]);
  });

  it('emits every field for three columns and separates records', () => {
    const table = tableFrom(
      '| A | B | C |\n| --- | --- | --- |\n'
      + '| 1 | 2 | 3 |\n| 4 | 5 | 6 |',
    );
    expect(texts(layoutMarkdownTable(table, 8))).toEqual([
      'A: 1', 'B: 2', 'C: 3', '',
      'A: 4', 'B: 5', 'C: 6',
    ]);
  });

  it('keeps empty cells and uses a minimum width of one for empty headers', () => {
    const table = tableFrom('|  | B |\n| --- | --- |\n|  | value |');
    const layout = layoutMarkdownTable(table, 7);
    expect(layout.columnWidths[0]).toBeGreaterThanOrEqual(1);
    expect(texts(layout).join('\n')).toContain(': ');
  });

  it('rejects unavailable width and malformed row shapes', () => {
    const table = tableFrom('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(() => layoutMarkdownTable(table, 0)).toThrow(TypeError);
    table.rows[0]!.pop();
    expect(() => layoutMarkdownTable(table, 40)).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
npx vitest run src/__tests__/tui/table-layout.test.ts
```

Expected: FAIL because the key-value function still throws.

- [ ] **Step 3: Implement key-value records with exact continuation rules**

Replace the temporary throwing function with a real implementation:

```ts
function layoutKeyValueTable(
  table: Tokens.Table,
  availableWidth: number,
): TableLayout {
  const lines: TableLayoutLine[] = [];
  const headers = table.header.map((cell) => inlineTokenLines(cell.tokens));

  table.rows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      const label = headers[columnIndex] ?? [[]];
      const value = inlineTokenLines(cell.tokens);
      const labelText = label.flat().map((span) => span.text).join('');
      const prefix = `${labelText}: `;
      const prefixWidth = displayWidth(prefix);

      if (prefixWidth >= availableWidth) {
        lines.push({ spans: [{ text: prefix.trimEnd(), styles: EMPTY_STYLES }] });
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
        spans: [{ text: prefix, styles: EMPTY_STYLES }, ...first],
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
```

Continuations have only `availableWidth - prefixWidth` columns after indentation, while the branch where the label occupies the line folds at full `availableWidth`. When implementing the snippet, iterate each logical value line separately so an explicit `br` always begins a new physical line with the same continuation indentation.

- [ ] **Step 4: Run the complete pure-layout suite**

Run:

```bash
npx vitest run src/__tests__/tui/table-layout.test.ts
```

Expected: all table-layout tests PASS, including exact key-value line arrays and malformed-input throws.

- [ ] **Step 5: Commit the fallback mode**

```bash
git add src/tui/markdown/table-layout.ts src/__tests__/tui/table-layout.test.ts
git commit -m "feat: add narrow terminal table fallback"
```

---

### Task 4: Finalized assistant render adapter and Inline V2 routing

**Files:**
- Create: `src/tui/inline-v2/AssistantBlockLine.tsx`
- Modify: `src/tui/inline-v2/TranscriptBlockLine.tsx`
- Create: `src/__tests__/tui/inline-v2/assistant-block-line.test.tsx`
- Create: `src/__tests__/tui/inline-v2/assistant-block-line-interrupted.test.tsx`
- Create: `src/__tests__/tui/inline-v2/assistant-block-line-table-fallback.test.tsx`
- Modify: `src/__tests__/tui/inline-v2/transcript-block-line.test.tsx`

**Interfaces:**
- Consumes: `AssistantBlock`, `cols`, `lexer`, `layoutMarkdownTable`, `tableLineText`, and `getTheme`.
- Produces:

```ts
export interface AssistantBlockLineProps {
  block: AssistantBlock;
  cols: number;
}

export function AssistantBlockLine(
  props: AssistantBlockLineProps,
): React.ReactElement;
```

- `TranscriptBlockLine` assistant branch becomes exactly:

```tsx
case 'assistant':
  return <AssistantBlockLine block={block} cols={cols} />;
```

- [ ] **Step 1: Write failing component tests for finalized, mixed, multiple, and local fallback behavior**

In `assistant-block-line.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { AssistantBlockLine } from '../../../tui/inline-v2/AssistantBlockLine.js';
import type { AssistantBlock } from '../../../tui/transcript-types.js';

function frame(text: string, cols = 80): string {
  const block: AssistantBlock = { id: 'a1', kind: 'assistant', text };
  return stripAnsi(render(
    <AssistantBlockLine block={block} cols={cols} />,
  ).lastFrame() ?? '');
}

describe('AssistantBlockLine', () => {
  it('renders a finalized table with one assistant marker and aligned borders', () => {
    const output = frame(
      '| Tool | Purpose |\n| --- | --- |\n| read_file | Read files |',
    );
    expect(output).toContain('┌');
    expect(output).toContain('read_file');
    expect(output.match(/●/g)).toHaveLength(1);
    expect(output).not.toContain('| --- |');
  });

  it('keeps non-table tokens raw around a rendered table', () => {
    const output = frame(
      '### Tools\n\n| Tool | Purpose |\n| --- | --- |\n| glob | Find files |\n\n**done**',
    );
    expect(output).toContain('### Tools');
    expect(output).toContain('┌');
    expect(output).toContain('**done**');
  });

  it('renders two table tokens in source order', () => {
    const output = frame(
      '| A |\n| --- |\n| first |\n\nbetween\n\n'
      + '| B |\n| --- |\n| second |',
    );
    expect(output.indexOf('first')).toBeLessThan(output.indexOf('between'));
    expect(output.indexOf('between')).toBeLessThan(output.indexOf('second'));
    expect(output.match(/┌/g)).toHaveLength(2);
  });

  it('recomputes table layout when remounted at a new terminal width', () => {
    const text = '| H | Description |\n| --- | --- |\n| x | abcdefghijklmnop |';
    const wide = frame(text, 80);
    const narrow = frame(text, 22);
    expect(wide).not.toBe(narrow);
    expect(narrow.split('\n').filter((line) => line.includes('│')).length)
      .toBeGreaterThan(wide.split('\n').filter((line) => line.includes('│')).length);
  });
});
```

In `assistant-block-line-table-fallback.test.tsx`, isolate the table-local failure:

```tsx
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';

const { layoutSpy } = vi.hoisted(() => ({ layoutSpy: vi.fn() }));
vi.mock('../../../tui/markdown/table-layout.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../tui/markdown/table-layout.js')
  >('../../../tui/markdown/table-layout.js');
  layoutSpy.mockImplementation((table, width) => {
    if (table.header[0]?.text === 'Broken') throw new TypeError('broken table');
    return actual.layoutMarkdownTable(table, width);
  });
  return { ...actual, layoutMarkdownTable: layoutSpy };
});

import { AssistantBlockLine } from '../../../tui/inline-v2/AssistantBlockLine.js';

describe('AssistantBlockLine table-local fallback', () => {
  it('keeps only the failed table raw and renders later tables', () => {
    const text = '| Broken |\n| --- |\n| first |\n\n'
      + '| Healthy |\n| --- |\n| second |';
    const output = stripAnsi(render(
      <AssistantBlockLine
        block={{ id: 'a1', kind: 'assistant', text }}
        cols={80}
      />,
    ).lastFrame() ?? '');
    expect(output).toContain('| Broken |');
    expect(output).toContain('second');
    expect(output).toContain('┌');
    expect(layoutSpy).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Write a failing isolated test proving interruption skips parsing**

In `assistant-block-line-interrupted.test.tsx`, use a hoisted lexer spy:

```tsx
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';

const { lexerSpy } = vi.hoisted(() => ({ lexerSpy: vi.fn() }));
vi.mock('marked', async () => ({
  ...(await vi.importActual<typeof import('marked')>('marked')),
  lexer: lexerSpy,
}));

import { AssistantBlockLine } from '../../../tui/inline-v2/AssistantBlockLine.js';

describe('AssistantBlockLine interrupted branch', () => {
  it('renders raw Markdown without invoking marked.lexer', () => {
    const text = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const output = stripAnsi(render(
      <AssistantBlockLine
        block={{ id: 'a1', kind: 'assistant', text, interrupted: true }}
        cols={80}
      />,
    ).lastFrame() ?? '');

    expect(output).toContain('| A | B |');
    expect(output).not.toContain('┌');
    expect(lexerSpy).not.toHaveBeenCalled();
  });

  it('falls back to the whole raw block when marked.lexer throws', () => {
    lexerSpy.mockImplementationOnce(() => {
      throw new Error('lexer failed');
    });
    const text = 'before\n\n| A | B |\n| --- | --- |\n| 1 | 2 |';
    const output = stripAnsi(render(
      <AssistantBlockLine
        block={{ id: 'a2', kind: 'assistant', text }}
        cols={80}
      />,
    ).lastFrame() ?? '');
    expect(output).toContain('| A | B |');
    expect(output).not.toContain('┌');
    expect(lexerSpy).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 3: Run the component tests and confirm RED**

Run:

```bash
npx vitest run src/__tests__/tui/inline-v2/assistant-block-line.test.tsx src/__tests__/tui/inline-v2/assistant-block-line-interrupted.test.tsx src/__tests__/tui/inline-v2/assistant-block-line-table-fallback.test.tsx src/__tests__/tui/inline-v2/transcript-block-line.test.tsx
```

Expected: FAIL because `AssistantBlockLine.tsx` is missing and routing still renders plain text.

- [ ] **Step 4: Implement the assistant render adapter**

Create `AssistantBlockLine.tsx` with:

```tsx
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
      {line.spans.map((span, index) => (
        <StyledSpan key={index} span={span} />
      ))}
    </Text>
  );
}

function rawContent(text: string): React.ReactElement {
  return <Text>{text}</Text>;
}
```

The component control flow must be:

1. Render `rawContent(block.text)` immediately when `block.interrupted` or `cols - 2 < 1`.
2. Otherwise call `lexer(block.text)` once inside a whole-block `try/catch`.
3. Map non-table tokens to `<Text key={index}>{token.raw}</Text>`.
4. For each table token, call `layoutMarkdownTable(token as Tokens.Table, cols - 2)` inside its own `try/catch`; map successful lines through `TableLine`, and render `token.raw` on local failure.
5. On lexer failure, render the entire `block.text` raw.
6. Return a row with one fixed marker column and one content column:

```tsx
return (
  <Box width={cols} flexDirection="row">
    <Text color="magenta">● </Text>
    <Box width={Math.max(1, cols - 2)} flexDirection="column">
      {content}
    </Box>
  </Box>
);
```

Do not color the content column or border spans.

- [ ] **Step 5: Route assistant blocks through the new component**

Import `AssistantBlockLine` in `TranscriptBlockLine.tsx`, replace only the `assistant` switch branch, and leave all other branches byte-for-byte unchanged.

Update the existing assistant routing test to assert the marker count and bordered output for a table block:

```tsx
it('routes finalized assistant tables → AssistantBlockLine', () => {
  const block: AssistantBlock = {
    id: 'a1',
    kind: 'assistant',
    text: '| Tool | Use |\n| --- | --- |\n| glob | search |',
  };
  const frame = stripAnsi(render(
    <TranscriptBlockLine block={block} cols={80} />,
  ).lastFrame() ?? '');
  expect(frame).toContain('┌');
  expect(frame).toContain('glob');
  expect(frame.match(/●/g)).toHaveLength(1);
});
```

- [ ] **Step 6: Run component tests and confirm GREEN**

Run:

```bash
npx vitest run src/__tests__/tui/inline-v2/assistant-block-line.test.tsx src/__tests__/tui/inline-v2/assistant-block-line-interrupted.test.tsx src/__tests__/tui/inline-v2/assistant-block-line-table-fallback.test.tsx src/__tests__/tui/inline-v2/transcript-block-line.test.tsx
```

Expected: all assistant and routing tests PASS.

- [ ] **Step 7: Commit the render-layer integration**

```bash
git add src/tui/inline-v2/AssistantBlockLine.tsx src/tui/inline-v2/TranscriptBlockLine.tsx src/__tests__/tui/inline-v2/assistant-block-line.test.tsx src/__tests__/tui/inline-v2/assistant-block-line-interrupted.test.tsx src/__tests__/tui/inline-v2/assistant-block-line-table-fallback.test.tsx src/__tests__/tui/inline-v2/transcript-block-line.test.tsx
git commit -m "feat: render finalized assistant markdown tables"
```

---

### Task 5: Lifecycle integration regressions and final verification

**Files:**
- Modify: `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx`
- Modify only if a real regression is exposed: `src/tui/inline-v2/AssistantBlockLine.tsx`
- Modify only if a real regression is exposed: `src/tui/markdown/table-layout.ts`

**Interfaces:**
- Consumes: existing `messagesStore.startAssistant`, `finishAssistant`, semantic timeline selectors, `<Static>`, and `StreamingText`.
- Produces: no new production interface; locks the user-visible lifecycle and store ownership contract.

- [ ] **Step 1: Add integration tests for streaming → finalized and raw-store ownership**

Add a focused describe block using existing `createStores()`, `makeProps()`, and `updateStreamingAssistantText()` helpers:

```tsx
describe('<InlineAppV2> finalized Markdown table lifecycle', () => {
  const markdown = '| Tool | Purpose |\n| --- | --- |\n| glob | Find files |';

  it('shows raw Markdown while streaming, then one bordered table after finish', () => {
    const stores = createStores();
    stores.messagesStore.getState().startAssistant(markdown);

    const streamingRender = render(<InlineAppV2 {...makeProps(stores)} />);
    expect(stripAnsi(streamingRender.lastFrame() ?? '')).toContain('| Tool | Purpose |');
    expect(stripAnsi(streamingRender.lastFrame() ?? '')).not.toContain('┌');
    streamingRender.unmount();

    stores.messagesStore.getState().finishAssistant();
    const finalizedRender = render(<InlineAppV2 {...makeProps(stores)} />);
    const finalized = stripAnsi(finalizedRender.lastFrame() ?? '');
    expect(finalized).toContain('┌');
    expect(finalized.match(/glob/g)).toHaveLength(1);
    expect(finalized.match(/●/g)).toHaveLength(1);
  });

  it('keeps raw Markdown in the finalized AssistantBlock', () => {
    const stores = createStores();
    stores.messagesStore.getState().startAssistant(markdown);
    stores.messagesStore.getState().finishAssistant();

    const assistant = stores.messagesStore.getState().model.items.find(
      (item) => item.kind === 'assistant',
    );
    expect(assistant?.text).toBe(markdown);
    expect(assistant?.text).not.toContain('┌');
  });

  it('keeps interrupted assistant Markdown raw after finalization', () => {
    const stores = createStores();
    stores.messagesStore.getState().startAssistant(markdown);
    stores.messagesStore.getState().finalizeStreamingAsInterrupted();

    const output = stripAnsi(render(
      <InlineAppV2 {...makeProps(stores)} />,
    ).lastFrame() ?? '');
    expect(output).toContain('| Tool | Purpose |');
    expect(output).not.toContain('┌');
  });

  it('remounts a finalized table against a narrower cols value', () => {
    const stores = createStores();
    stores.messagesStore.getState().startAssistant(
      '| H | Description |\n| --- | --- |\n| x | abcdefghijklmnop |',
    );
    stores.messagesStore.getState().finishAssistant();

    const wideRender = render(<InlineAppV2 {...makeProps(stores)} cols={80} />);
    const wide = stripAnsi(wideRender.lastFrame() ?? '');
    wideRender.unmount();
    const narrow = stripAnsi(render(
      <InlineAppV2 {...makeProps(stores)} cols={22} />,
    ).lastFrame() ?? '');

    expect(narrow).not.toBe(wide);
    expect(narrow).toContain('┌');
    expect(narrow.split('\n').filter((line) => line.includes('│')).length)
      .toBeGreaterThan(wide.split('\n').filter((line) => line.includes('│')).length);
  });
});
```

- [ ] **Step 2: Run the lifecycle integration test and confirm its signal**

Run:

```bash
npx vitest run src/__tests__/tui/inline-v2/inline-app-v2.test.tsx
```

Expected before any necessary adjustment: new lifecycle tests PASS if Tasks 1–4 are correct. If one fails, confirm it fails on the intended streaming/finalization/resize contract before changing production code.

- [ ] **Step 3: Run the affected TUI test slice**

Run:

```bash
npx vitest run src/__tests__/tui/table-layout.test.ts src/__tests__/tui/inline-v2/assistant-block-line.test.tsx src/__tests__/tui/inline-v2/assistant-block-line-interrupted.test.tsx src/__tests__/tui/inline-v2/assistant-block-line-table-fallback.test.tsx src/__tests__/tui/inline-v2/transcript-block-line.test.tsx src/__tests__/tui/inline-v2/streaming-text.test.tsx src/__tests__/tui/inline-v2/inline-app-v2.test.tsx src/__tests__/tui/render-markdown.test.tsx
```

Expected: all listed test files PASS. `render-markdown.test.tsx` protects the existing Markdown renderer from collateral behavior changes.

- [ ] **Step 4: Run static verification on the touched implementation**

Run:

```bash
npx tsc --noEmit
npx eslint src/tui/markdown/table-layout.ts src/tui/inline-v2/AssistantBlockLine.tsx src/tui/inline-v2/TranscriptBlockLine.tsx src/__tests__/tui/table-layout.test.ts src/__tests__/tui/inline-v2/assistant-block-line.test.tsx src/__tests__/tui/inline-v2/assistant-block-line-interrupted.test.tsx src/__tests__/tui/inline-v2/assistant-block-line-table-fallback.test.tsx src/__tests__/tui/inline-v2/transcript-block-line.test.tsx
```

Expected: both commands exit 0 with no TypeScript, unused-symbol, or floating-promise errors.

- [ ] **Step 5: Run the project build and full test suite**

Run:

```bash
npm run build
npm test
```

Expected: build exits 0 and the full suite passes. If unrelated dirty-worktree tests fail, record the exact failing test names and prove the complete affected slice from Step 3 still passes; do not modify unrelated files.

Only label a full-suite failure as **pre-existing** when the same test and assertion can be
reproduced in an isolated clean worktree at the implementation-start commit. If that comparison
cannot be run, report the failure as unclassified rather than assuming it predates this feature.

- [ ] **Step 6: Inspect the final diff for scope and accidental store changes**

Run:

```bash
git diff --check
git diff -- src/tui/markdown/table-layout.ts src/tui/inline-v2/AssistantBlockLine.tsx src/tui/inline-v2/TranscriptBlockLine.tsx src/__tests__/tui/table-layout.test.ts src/__tests__/tui/inline-v2/assistant-block-line.test.tsx src/__tests__/tui/inline-v2/assistant-block-line-interrupted.test.tsx src/__tests__/tui/inline-v2/assistant-block-line-table-fallback.test.tsx src/__tests__/tui/inline-v2/transcript-block-line.test.tsx src/__tests__/tui/inline-v2/inline-app-v2.test.tsx
git diff -- src/tui/state/messages-store.ts src/tui/transcript-types.ts
```

Expected:

- no whitespace errors;
- only the files listed in this plan contain feature changes;
- the store/type diff contains no table-border persistence or new table state;
- no dependency manifest or lockfile changes.

- [ ] **Step 7: Commit lifecycle coverage and any narrowly required corrections**

```bash
git add src/__tests__/tui/inline-v2/inline-app-v2.test.tsx src/tui/inline-v2/AssistantBlockLine.tsx src/tui/markdown/table-layout.ts
git commit -m "test: cover finalized table rendering lifecycle"
```

Before running `git add`, omit either production path when it has no Task 5 change. Never stage unrelated dirty-worktree files.

---

## Final acceptance checklist

- [ ] The sample tool list renders as a complete aligned border table after `finishAssistant`.
- [ ] Optimal, wrapped, and key-value modes each have a failure-first unit test.
- [ ] CJK, inline styles, `br`, image, bare URL, and unknown-token fallback are covered.
- [ ] Every bordered physical line has the same terminal display width.
- [ ] Streaming and interrupted content remain raw Markdown.
- [ ] Parser failures and table-local failures return raw content at the documented scope.
- [ ] Resize/remount recomputes from raw store text and does not duplicate the table.
- [ ] Native physical-frame output contains border characters; no raw-copy mapping is introduced.
- [ ] No store, dependency, heading, list, or horizontal-rule behavior is expanded.
- [ ] Focused tests, affected tests, TypeScript, scoped ESLint, build, and the full suite have recorded results.
