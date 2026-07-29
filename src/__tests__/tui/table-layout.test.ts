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
