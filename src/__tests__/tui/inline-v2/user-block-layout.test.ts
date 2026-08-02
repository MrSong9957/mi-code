import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import {
  layoutUserBlockRows,
  shouldShowUserPrompt,
} from '../../../tui/inline-v2/user-block-layout.js';

describe('layoutUserBlockRows', () => {
  it('expands tabs only in the render result and preserves logical blank lines', () => {
    const input = '请执行：\n\n\tsudo whoami\n\n\t返回执行结果。';
    const before = input;

    expect(layoutUserBlockRows(input, 40)).toEqual([
      '❯ 请执行：',
      '',
      '    sudo whoami',
      '',
      '    返回执行结果。',
    ]);
    expect(input).toBe(before);
  });

  it('does not append background padding spaces', () => {
    const rows = layoutUserBlockRows('short', 20);
    expect(rows).toEqual(['❯ short']);
    expect(rows[0]!.endsWith(' ')).toBe(false);
  });

  it('is deterministic for the same text and local width', () => {
    const input = 'a\n\t中🤖';
    expect(layoutUserBlockRows(input, 6)).toEqual(layoutUserBlockRows(input, 6));
  });

  it.each<[number, string[]]>([
    [4, ['❯ ', '    ', 'sudo', 'whoa', 'mi']],
    [8, ['❯ ', '    sudo', 'whoami']],
    [11, ['❯ ', '    sudo', 'whoami']],
  ])('preserves four source-derived leading spaces at width %i', (width, expected) => {
    expect(layoutUserBlockRows('\n\tsudo whoami', width)).toEqual(expected);
  });

  it('does not combine indentation with a wide grapheme when the row would overflow', () => {
    const rows = layoutUserBlockRows('\n  中', 3);

    expect(rows).toEqual(['❯ ', '  ', '中']);
    expect(rows.join('')).toBe('❯   中');
    for (const row of rows) {
      expect(stringWidth(row)).toBeLessThanOrEqual(3);
    }
  });

  it('shows the prompt at width 3 for ASCII but omits it for CJK', () => {
    expect(shouldShowUserPrompt('a', 3)).toBe(true);
    expect(layoutUserBlockRows('a', 3)).toEqual(['❯ a']);

    expect(shouldShowUserPrompt('中', 3)).toBe(false);
    expect(layoutUserBlockRows('中', 3)).toEqual(['中']);
  });

  it('uses the full local width after the first physical row', () => {
    expect(layoutUserBlockRows('abcd', 3)).toEqual(['❯ a', 'bcd']);
  });

  it('keeps CJK, emoji ZWJ sequences and combining graphemes intact', () => {
    expect(layoutUserBlockRows('中文', 2)).toEqual(['中', '文']);
    expect(layoutUserBlockRows('👨‍👩‍👧‍👦x', 1)).toEqual(['👨‍👩‍👧‍👦', 'x']);
    expect(layoutUserBlockRows('e\u0301x', 1)).toEqual(['e\u0301', 'x']);
  });

  it('allows overflow only for one indivisible grapheme wider than width', () => {
    const rows = layoutUserBlockRows('中a', 1);
    expect(rows).toEqual(['中', 'a']);
    expect(stringWidth(rows[0]!)).toBe(2);
    expect(stringWidth(rows[1]!)).toBeLessThanOrEqual(1);
  });

  it('clamps non-finite and non-positive widths without dropping text', () => {
    expect(layoutUserBlockRows('ab', 0).join('')).toBe('ab');
    expect(layoutUserBlockRows('ab', Number.NaN).join('')).toBe('ab');
  });
});
