// src/__tests__/tui/inline-v2/transcript-block-line.test.tsx
// TranscriptBlockLine 路由测试:验证各类型 TranscriptBlock 分派到正确渲染。

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { styledCharsFromTokens, tokenize } from '@alcalzone/ansi-tokenize';
import stringWidth from 'string-width';
import { TranscriptBlockLine } from '../../../tui/inline-v2/TranscriptBlockLine.js';
import { ThemeProvider } from '../../../tui/state/theme-context.js';
import { darkTheme, lightTheme, type Theme } from '../../../utils/theme.js';
import type {
  ToolBlock,
  AskBlock,
  UserBlock,
  AssistantBlock,
  SystemBlock,
  TurnDurationBlock,
} from '../../../tui/transcript-types.js';

function renderUser(text: string, cols: number, theme: Theme = darkTheme): string {
  const block: UserBlock = { id: 'user-layout', kind: 'user', text };
  return render(
    <ThemeProvider value={theme}>
      <TranscriptBlockLine block={block} cols={cols} />
    </ThemeProvider>,
  ).lastFrame() ?? '';
}

/**
 * Ink 在 FORCE_COLOR='1'（vitest.config.ts 设定）下把 hex 背景色渲染为
 * 24-bit RGB SGR 序列（\u001b[48;2;R;G;Bm），而非 16 色 [10Xm。
 * 本函数从 theme.bgMuted 推导出每一行必须出现的精确 ANSI 背景序列，
 * 用于断言「每个物理行都承载该主题的 bgMuted」这一规格契约。
 */
function bgMutedAnsi(theme: Theme): string {
  const hex = theme.bgMuted.replace('#', '');
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `\u001b[48;2;${r};${g};${b}m`;
}

const BG_MUTED_CASES: ReadonlyArray<readonly [string, Theme, string]> = [
  ['dark-derived', { ...darkTheme, bgMuted: '#ff00ff' }, bgMutedAnsi({ ...darkTheme, bgMuted: '#ff00ff' })],
  ['light-derived', { ...lightTheme, bgMuted: '#00ffff' }, bgMutedAnsi({ ...lightTheme, bgMuted: '#00ffff' })],
];

function styleCodesForCharacter(raw: string, value: string): string[] {
  const character = styledCharsFromTokens(tokenize(raw)).find((entry) => entry.value === value);
  expect(character).toBeDefined();
  return character!.styles.map((style) => style.code);
}

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

  it.each(BG_MUTED_CASES)(
    'renders every physical row with the exact %s bgMuted sentinel',
    (_name, theme, backgroundAnsi) => {
      const raw = renderUser('请执行：\n\n\tsudo whoami', 12, theme);
      const rawLines = raw.split('\n');
      const visible = stripAnsi(raw).split('\n').map((line) => line.trimEnd());
      const physicalLines = stripAnsi(raw).split('\n');

      expect(visible).toEqual(['❯ 请执行：', '', '    sudo', 'whoami']);
      expect(physicalLines).toHaveLength(4);
      expect(physicalLines.every((line) => stringWidth(line) === 11)).toBe(true);
      expect(rawLines.every((line) => line.includes(backgroundAnsi))).toBe(true);
    },
  );

  it('keeps green and bold styles on the marker but not the body regardless of ANSI order', () => {
    const [, theme, backgroundAnsi] = BG_MUTED_CASES[0]!;
    const raw = renderUser('plain question', 20, theme);
    const markerCodes = styleCodesForCharacter(raw, '❯');
    const bodyCodes = styleCodesForCharacter(raw, 'p');

    expect(markerCodes).toEqual(expect.arrayContaining([
      '\u001b[32m',
      '\u001b[1m',
      backgroundAnsi,
    ]));
    expect(bodyCodes).toContain(backgroundAnsi);
    expect(bodyCodes).not.toContain('\u001b[32m');
    expect(bodyCodes).not.toContain('\u001b[1m');
    expect(stripAnsi(raw).trimEnd()).toContain('❯ plain question');
  });
});
