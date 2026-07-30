// src/__tests__/tui/inline-v2/ask-block-line.test.tsx
// AskBlockLine 渲染测试:验证 ask 结果块的视觉输出。

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { AskBlockLine } from '../../../tui/inline-v2/AskBlockLine.js';
import type { AskBlock } from '../../../tui/transcript-types.js';

describe('AskBlockLine', () => {
  it('renders summary + items with correct prefixes', () => {
    const block: AskBlock = {
      id: 'q1',
      kind: 'ask',
      summary: 'Answered 2 questions',
      items: ['Auth → OAuth', 'Lib → A, B'],
    };
    const { lastFrame } = render(<AskBlockLine block={block} cols={100} />);
    expect(stripAnsi(lastFrame() ?? '')).toBe([
      '● Answered 2 questions',
      '  ⎿ Auth → OAuth',
      '  ⎿ Lib → A, B',
    ].join('\n'));
  });

  it('renders cancelled with single item', () => {
    const block: AskBlock = {
      id: 'q2',
      kind: 'ask',
      summary: 'Declined to answer',
      items: ['User declined to answer questions'],
    };
    const { lastFrame } = render(<AskBlockLine block={block} cols={100} />);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame.split('\n')[0]).toBe('● Declined to answer');
    expect(frame).toContain('⎿ User declined to answer questions');
  });

  it('renders feedback with single item', () => {
    const block: AskBlock = {
      id: 'q3',
      kind: 'ask',
      summary: 'Feedback: Use the simpler path',
      items: ['Use the simpler path'],
    };
    const { lastFrame } = render(<AskBlockLine block={block} cols={100} />);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame.split('\n')[0]).toBe('● Feedback: Use the simpler path');
  });
});
