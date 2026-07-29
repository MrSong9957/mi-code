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
