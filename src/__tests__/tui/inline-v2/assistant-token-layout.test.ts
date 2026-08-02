import { describe, expect, it } from 'vitest';
import { lexer, type Token } from 'marked';
import {
  layoutCompletedAssistantTokens,
  type AssistantTokenRenderRow,
} from '../../../tui/inline-v2/assistant-token-layout.js';

function visible(rows: AssistantTokenRenderRow[]): string[] {
  return rows.map((row) => {
    if (row.kind === 'blank') return '';
    if (row.kind === 'raw') return row.text;
    return row.line.spans.map((span) => span.text).join('');
  });
}

describe('layoutCompletedAssistantTokens', () => {
  it('normalizes a paragraph boundary to exactly one blank row', () => {
    expect(visible(layoutCompletedAssistantTokens(lexer('one\n\ntwo'), 40)))
      .toEqual(['one', '', 'two']);
  });

  it('collapses consecutive space tokens and ignores leading/trailing boundaries', () => {
    const tokens = [
      { type: 'space', raw: '\n\n' },
      { type: 'paragraph', raw: 'one', text: 'one', tokens: [] },
      { type: 'space', raw: '\n\n' },
      { type: 'space', raw: '\n\n' },
      { type: 'paragraph', raw: 'two', text: 'two', tokens: [] },
      { type: 'space', raw: '\n\n' },
    ] as unknown as Token[];

    expect(visible(layoutCompletedAssistantTokens(tokens, 40)))
      .toEqual(['one', '', 'two']);
  });

  it('counts renderer leading/trailing blanks without stacking another row', () => {
    const tokens = [
      { type: 'paragraph', raw: 'one\n', text: 'one', tokens: [] },
      { type: 'space', raw: '\n\n' },
      { type: 'paragraph', raw: '\ntwo', text: 'two', tokens: [] },
    ] as unknown as Token[];

    expect(visible(layoutCompletedAssistantTokens(tokens, 40)))
      .toEqual(['one', '', 'two']);
  });

  it.each<[string, string, string, string[]]>([
    [
      'fenced code',
      'code',
      'before\n\n~~~\nline one\n\nline three\n~~~\n\nafter',
      ['before', '', '~~~', 'line one', '', 'line three', '~~~', '', 'after'],
    ],
    [
      'loose list',
      'list',
      'before\n\n- one\n\n- two\n\nafter',
      ['before', '', '- one', '', '- two', '', 'after'],
    ],
    [
      'blockquote',
      'blockquote',
      'before\n\n> first\n>\n> third\n\nafter',
      ['before', '', '> first', '>', '> third', '', 'after'],
    ],
  ])('preserves the real internal blank row of one %s token', (
    _name,
    structuralType,
    markdown,
    expected,
  ) => {
    const tokens = lexer(markdown);
    expect(tokens.filter((token) => token.type !== 'space').map((token) => token.type))
      .toEqual(['paragraph', structuralType, 'paragraph']);
    expect(visible(layoutCompletedAssistantTokens(tokens, 40))).toEqual(expected);
  });

  it('keeps table layout rows and one blank boundary on each side', () => {
    const rows = layoutCompletedAssistantTokens(lexer(
      'before\n\n| A |\n| ---- |\n| x |\n\nafter',
    ), 20);
    const lines = visible(rows);
    const top = lines.findIndex((line) => line.startsWith('┌'));
    const bottom = lines.findIndex((line) => line.startsWith('└'));

    expect(top).toBeGreaterThan(1);
    expect(lines[top - 1]).toBe('');
    expect(lines[bottom + 1]).toBe('');
    expect(lines[bottom + 2]).toBe('after');
  });
});
