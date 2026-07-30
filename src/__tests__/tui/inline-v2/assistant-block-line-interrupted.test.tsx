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
    expect(output.match(/●/g)).toHaveLength(1);
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
    expect(output.match(/●/g)).toHaveLength(1);
    expect(lexerSpy).toHaveBeenCalledOnce();
  });

  it('skips marked.lexer when the content width is unavailable', () => {
    lexerSpy.mockClear();
    const text = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const output = stripAnsi(render(
      <AssistantBlockLine
        block={{ id: 'a3', kind: 'assistant', text }}
        cols={2}
      />,
    ).lastFrame() ?? '');

    expect(output).toContain('| A | B |');
    expect(lexerSpy).not.toHaveBeenCalled();
  });
});
