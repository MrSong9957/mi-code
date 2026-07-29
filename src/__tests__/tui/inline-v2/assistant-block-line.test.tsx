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
