import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { styledCharsFromTokens, tokenize } from '@alcalzone/ansi-tokenize';
import stringWidth from 'string-width';
import { LocaleProvider } from '../../../locale/context.js';
import { createLanguageStore } from '../../../locale/language-store.js';
import type { Language } from '../../../locale/types.js';
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
  TranscriptBlock,
} from '../../../tui/transcript-types.js';

function renderTranscriptBlock(
  block: TranscriptBlock,
  cols: number,
  language: Language = 'en-US',
): string {
  return render(
    <LocaleProvider store={createLanguageStore(language)}>
      <TranscriptBlockLine block={block} cols={cols} />
    </LocaleProvider>,
  ).lastFrame() ?? '';
}

function renderUser(text: string, cols: number, theme: Theme = darkTheme): string {
  const block: UserBlock = { id: 'user-layout', kind: 'user', text };
  return render(
    <ThemeProvider value={theme}>
      <LocaleProvider store={createLanguageStore('en-US')}>
        <TranscriptBlockLine block={block} cols={cols} />
      </LocaleProvider>
    </ThemeProvider>,
  ).lastFrame() ?? '';
}

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
      id: 't1',
      kind: 'tool',
      toolName: 'glob',
      presentations: [
        { toolUseId: 'g1', toolName: 'glob', summary: '*.ts → 1 file', details: [], status: 'success' },
      ],
      thinking: [],
    };
    const frame = stripAnsi(renderTranscriptBlock(block, 100));
    expect(frame).toContain('● Searched 1 pattern');
    expect(frame).toContain('⎿ *.ts → 1 file');
  });

  it('localizes tool block fixed labels in zh-CN through LocaleProvider', () => {
    const block: ToolBlock = {
      id: 't1-zh',
      kind: 'tool',
      toolName: 'glob',
      presentations: [
        { toolUseId: 'g1', toolName: 'glob', summary: '*.ts → 1 file', details: [], status: 'success' },
      ],
      thinking: [],
    };
    const frame = stripAnsi(renderTranscriptBlock(block, 100, 'zh-CN'));
    expect(frame).toContain('● 搜索了 1 个模式');
    expect(frame).toContain('⎿ *.ts → 1 file');
  });

  it('routes ask → AskBlockLine', () => {
    const block: AskBlock = {
      id: 'q1',
      kind: 'ask',
      summary: 'Answered 1 question',
      items: ['Auth → OAuth'],
    };
    const frame = stripAnsi(renderTranscriptBlock(block, 100));
    expect(frame).toContain('● Answered 1 question');
    expect(frame).toContain('⎿ Auth → OAuth');
  });

  it('routes user → user text', () => {
    const block: UserBlock = { id: 'u1', kind: 'user', text: 'hello' };
    const frame = stripAnsi(renderTranscriptBlock(block, 100));
    expect(frame).toContain('hello');
  });

  it('routes finalized assistant tables → AssistantBlockLine', () => {
    const block: AssistantBlock = {
      id: 'a1',
      kind: 'assistant',
      text: '| Tool | Use |\n| --- | --- |\n| glob | search |',
    };
    const frame = stripAnsi(renderTranscriptBlock(block, 80));
    expect(frame).toContain('┌');
    expect(frame).toContain('glob');
    expect(frame.match(/●/g)).toHaveLength(1);
  });

  it('colors only message markers instead of the full user and assistant text', () => {
    const assistant: AssistantBlock = { id: 'a1', kind: 'assistant', text: 'plain answer' };
    const user: UserBlock = { id: 'u1', kind: 'user', text: 'plain question' };
    const assistantFrame = renderTranscriptBlock(assistant, 100);
    const userFrame = renderTranscriptBlock(user, 100);

    expect(assistantFrame).not.toContain('\u001b[35m●plain answer');
    expect(userFrame).not.toContain('\u001b[32m\u001b[1m❯plain question');
  });

  it('routes thinking-summary system → dim text', () => {
    const block: SystemBlock = {
      id: 's1',
      kind: 'system',
      subkind: 'thinking-summary',
      text: 'Thought for 2s',
      durationMs: 2000,
      groupBoundary: 'transparent',
    };
    const frame = stripAnsi(renderTranscriptBlock(block, 100));
    expect(frame).toContain('Thought for 2s');
  });

  it('routes notification system → text', () => {
    const block: SystemBlock = {
      id: 's2',
      kind: 'system',
      subkind: 'notification',
      text: '[Hook] done',
      groupBoundary: 'break',
    };
    const frame = stripAnsi(renderTranscriptBlock(block, 100));
    expect(frame).toContain('[Hook] done');
  });

  it('routes turn-duration → verb text', () => {
    const block: TurnDurationBlock = {
      id: 'td1',
      kind: 'turn-duration',
      durationMs: 5000,
      verb: 'Cooked',
      prependBlankLine: false,
    };
    const frame = stripAnsi(renderTranscriptBlock(block, 100));
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
