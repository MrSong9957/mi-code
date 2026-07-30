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

  it('keeps table borders uncolored after an ANSI-styled wrapped cell', () => {
    const raw = render(
      <AssistantBlockLine
        block={{
          id: 'ansi',
          kind: 'assistant',
          text: '| H | Description |\n| --- | --- |\n| x | \x1b[31mabcdefghijklmnop\x1b[0m |',
        }}
        cols={20}
      />,
    ).lastFrame() ?? '';
    const visible = stripAnsi(raw);

    const firstRed = raw.indexOf('\x1b[31m');
    expect(firstRed).toBeGreaterThanOrEqual(0);
    expect(raw.slice(firstRed)).toContain('\x1b[39m');
    expect(visible.split('\n').filter((line) => line.includes('│')).every(
      (line) => line.endsWith('│'),
    )).toBe(true);
  });

  it('resets an unclosed ANSI SGR before the final right border', () => {
    const raw = render(
      <AssistantBlockLine
        block={{
          id: 'unclosed-ansi',
          kind: 'assistant',
          text: '| H | Description |\n| --- | --- |\n| x | \x1b[31mabcdefghijklmnop |',
        }}
        cols={22}
      />,
    ).lastFrame() ?? '';
    const finalStyledLine = raw.split('\n').find((line) => line.includes('op'));

    expect(finalStyledLine).toBeDefined();
    expect(finalStyledLine!.indexOf('\x1b[39m')).toBeGreaterThanOrEqual(0);
    expect(finalStyledLine!.indexOf('\x1b[39m')).toBeLessThan(
      finalStyledLine!.lastIndexOf('│'),
    );
  });

  it('keeps a physical blank line between key-value records', () => {
    expect(frame(
      '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |',
      8,
    )).toContain('● A: 1\n  B: 2\n\n  A: 3\n  B: 4');
  });
});
