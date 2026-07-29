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

  it('uses text instead of nested tokens for an unknown token', () => {
    const table = tableFrom('| Value |\n| --- |\n| known |');
    table.rows[0]![0]!.tokens = [{
      type: 'extension-token',
      raw: '<raw>',
      text: 'visible',
      tokens: [{ type: 'text', raw: 'nested', text: 'nested' }],
    } as unknown as Tokens.Text];

    const rendered = texts(layoutMarkdownTable(table, 80)).join('\n');
    expect(rendered).toContain('visible');
    expect(rendered).not.toContain('nested');
  });

  it('counts CJK as two display columns and ignores ANSI SGR width', () => {
    const table = tableFrom('| 项目 | 值 |\n| --- | --- |\n| 中文 | A |');
    const layout = layoutMarkdownTable(table, 40);
    for (const line of texts(layout)) {
      expect(displayWidth(line)).toBe(displayWidth(texts(layout)[0]!));
    }
  });
});

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
    expect(lines.some((line) => line.includes('op'))).toBe(true);
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
      .filter((span) => span.text === 'abcdefghijklmn' || span.text === 'op');
    expect(styledFragments).toHaveLength(2);
    expect(styledFragments.every((span) => span.styles.includes('strong'))).toBe(true);
  });
});
