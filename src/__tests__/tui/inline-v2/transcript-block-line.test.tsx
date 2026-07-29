// src/__tests__/tui/inline-v2/transcript-block-line.test.tsx
// TranscriptBlockLine 路由测试:验证各类型 TranscriptBlock 分派到正确渲染。

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { TranscriptBlockLine } from '../../../tui/inline-v2/TranscriptBlockLine.js';
import type {
  ToolBlock,
  AskBlock,
  UserBlock,
  AssistantBlock,
  SystemBlock,
  TurnDurationBlock,
} from '../../../tui/transcript-types.js';

describe('TranscriptBlockLine', () => {
  it('routes tool → ToolBlockLine', () => {
    const block: ToolBlock = {
      id: 't1', kind: 'tool', toolName: 'glob',
      presentations: [
        { toolUseId: 'g1', toolName: 'glob', summary: '*.ts → 1 file', details: [], status: 'success' },
      ],
      thinking: [],
    };
    const { lastFrame } = render(<TranscriptBlockLine block={block} cols={100} />);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('● Searched 1 pattern');
    expect(frame).toContain('⎿ *.ts → 1 file');
  });

  it('routes ask → AskBlockLine', () => {
    const block: AskBlock = {
      id: 'q1', kind: 'ask', summary: 'Answered 1 question', items: ['Auth → OAuth'],
    };
    const { lastFrame } = render(<TranscriptBlockLine block={block} cols={100} />);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('● Answered 1 question');
    expect(frame).toContain('⎿ Auth → OAuth');
  });

  it('routes user → user text', () => {
    const block: UserBlock = { id: 'u1', kind: 'user', text: 'hello' };
    const { lastFrame } = render(<TranscriptBlockLine block={block} cols={100} />);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('hello');
  });

  it('routes finalized assistant tables → AssistantBlockLine', () => {
    const block: AssistantBlock = {
      id: 'a1',
      kind: 'assistant',
      text: '| Tool | Use |\n| --- | --- |\n| glob | search |',
    };
    const frame = stripAnsi(render(
      <TranscriptBlockLine block={block} cols={80} />,
    ).lastFrame() ?? '');
    expect(frame).toContain('┌');
    expect(frame).toContain('glob');
    expect(frame.match(/●/g)).toHaveLength(1);
  });

  it('colors only message markers instead of the full user and assistant text', () => {
    const assistant: AssistantBlock = { id: 'a1', kind: 'assistant', text: 'plain answer' };
    const user: UserBlock = { id: 'u1', kind: 'user', text: 'plain question' };
    const assistantFrame = render(
      <TranscriptBlockLine block={assistant} cols={100} />,
    ).lastFrame() ?? '';
    const userFrame = render(
      <TranscriptBlockLine block={user} cols={100} />,
    ).lastFrame() ?? '';

    expect(assistantFrame).not.toContain('\u001b[35m● plain answer');
    expect(userFrame).not.toContain('\u001b[32m\u001b[1m❯ plain question');
  });

  it('routes thinking-summary system → dim text', () => {
    const block: SystemBlock = {
      id: 's1', kind: 'system', subkind: 'thinking-summary',
      text: 'Thought for 2s', durationMs: 2000, groupBoundary: 'transparent',
    };
    const { lastFrame } = render(<TranscriptBlockLine block={block} cols={100} />);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Thought for 2s');
  });

  it('routes notification system → text', () => {
    const block: SystemBlock = {
      id: 's2', kind: 'system', subkind: 'notification',
      text: '[Hook] done', groupBoundary: 'break',
    };
    const { lastFrame } = render(<TranscriptBlockLine block={block} cols={100} />);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('[Hook] done');
  });

  it('routes turn-duration → verb text', () => {
    const block: TurnDurationBlock = {
      id: 'td1', kind: 'turn-duration', durationMs: 5000, verb: 'Cooked', prependBlankLine: false,
    };
    const { lastFrame } = render(<TranscriptBlockLine block={block} cols={100} />);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Cooked');
    expect(frame).toContain('5s');
  });
});
