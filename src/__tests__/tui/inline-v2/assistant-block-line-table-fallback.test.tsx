import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { lexer, type Tokens } from 'marked';

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

  it('keeps a header-only marked table raw when layout rejects its empty rows', () => {
    layoutSpy.mockClear();
    const text = '| Header one | Header two |\n| --- | --- |';
    const token = lexer(text).find(
      (candidate): candidate is Tokens.Table => candidate.type === 'table',
    );
    expect(token?.rows).toEqual([]);
    const output = stripAnsi(render(
      <AssistantBlockLine
        block={{ id: 'header-only', kind: 'assistant', text }}
        cols={12}
      />,
    ).lastFrame() ?? '');

    expect(output).toContain('| Header');
    expect(output).toContain('Header two');
    expect(output).toContain('| --- |');
    expect(output).not.toContain('┌');
    expect(output.match(/●/g)).toHaveLength(1);
    expect(layoutSpy).toHaveBeenCalledOnce();
  });
});
