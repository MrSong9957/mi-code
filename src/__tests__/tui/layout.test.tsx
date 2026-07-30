// src/__tests__/tui/layout.test.tsx
// App 顶层布局：footer 紧贴 + 固定 LOGO 区 + StatusBar(mode|model|dir|branch|进度条)

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { App } from '../../tui/App.js';
import { createSelectionStore } from '../../tui/state/selection-store.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';
import { createCompletionStore } from '../../tui/state/completion-store.js';
import { createOverlayStore } from '../../tui/state/overlay-store.js';
import { flattenMessages } from '../../tui/selection/flatten-messages.js';
import type { TuiMessage, StatusBarData, LogoData } from '../../tui/types.js';

const STATUS: StatusBarData = {
  mode: 'build', model: 'sonnet', dir: 'Projects/mi-code', branch: 'main', contextPct: 0.25,
};
const LOGO: LogoData = { version: '1.0.0', dir: '/tmp/proj' };

function makeApp(messages: TuiMessage[] = []): { lastFrame: () => string | undefined } {
  const flatLines = flattenMessages(messages);
  return render(
    React.createElement(App, { messages, status: STATUS, logo: LOGO, selectionStore: createSelectionStore(), spinnerStore: createSpinnerStore(), completionStore: createCompletionStore(), overlayStore: createOverlayStore(), input: '', cursor: 0, scrollTop: 0, flatLines }),
  );
}

describe('App 顶层布局（flexbox footer 紧贴 + LOGO 固定区）', () => {
  it('空消息：LOGO + footer 紧贴顶部（LOGO 在第 0 行）', () => {
    const { lastFrame } = makeApp([]);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('MiCode v1.0.0');
    expect(frame).toContain('❯');
    expect(frame).toContain('─');
    const lines = frame.split('\n');
    let firstNonEmptyIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim() !== '') { firstNonEmptyIdx = i; break; }
    }
    expect(firstNonEmptyIdx!, '紧贴顶部').toBeLessThanOrEqual(1);
    // LOGO 第 0 行（ASCII art 最先）
    expect(lines[0]).toContain('MiCode v1.0.0');
  });

  it('有消息：顺序为 LOGO(顶) → 消息(中) → Footer(底)', () => {
    const messages: TuiMessage[] = [
      {
        uuid: 'm1', role: 'assistant', finalized: true,
        lines: [{ content: '● 你好运', style: { fg: 'brand' }, indent: 0 }],
      },
    ];
    const { lastFrame } = makeApp(messages);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('● 你好运');
    // 顺序断言：LOGO 在消息之前，消息在 Footer(❯) 之前
    const logoIdx = frame.indexOf('MiCode v1.0.0');
    const msgIdx = frame.indexOf('● 你好运');
    const footerIdx = frame.indexOf('❯');
    expect(logoIdx, 'LOGO 应存在').toBeGreaterThanOrEqual(0);
    expect(msgIdx, '消息应存在').toBeGreaterThan(logoIdx);
    expect(footerIdx, 'Footer 应在消息之后').toBeGreaterThan(msgIdx);
  });

  it('LOGO 区固定显示：ASCII art + version + dir（无 model/branch/mode，那些在 StatusBar）', () => {
    const { lastFrame } = makeApp([]);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('MiCode v1.0.0');
    expect(frame).toContain('TypeScript CLI · Node.js Runtime');
    expect(frame).toContain('/tmp/proj');
  });

  it('footer 含完整结构：上边框 + 输入框(❯) + 下边框 + StatusBar', () => {
    const { lastFrame } = makeApp([]);
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const inputIdx = lines.findIndex(l => l.includes('❯'));
    expect(inputIdx, '应有 ❯ 输入行').toBeGreaterThan(-1);
    expect(lines[inputIdx - 1], '上边框').toContain('─');
    expect(lines[inputIdx + 1], '下边框').toContain('─');
    expect(lines[inputIdx + 2], '状态栏').toContain('build');
  });

  it('StatusBar 格式：mode | model | dir | branch | [进度条] pct%', () => {
    const { lastFrame } = makeApp([]);
    const frame = stripAnsi(lastFrame() ?? '');
    // 25% → 10 格条 = ███░░░░░░░（round(0.25*10)=3 满）
    // 分隔符为 box-drawing │（见 StatusBar 多色高亮），进度条无括号
    expect(frame).toContain('build │ sonnet │ Projects/mi-code │ main │');
    expect(frame).toContain('███░░░░░░░ 25%');
  });

  it('StatusBar 进度条随 contextPct 变化', () => {
    const status50: StatusBarData = { ...STATUS, contextPct: 0.5 };
    const { lastFrame } = render(
      React.createElement(App, { messages: [], status: status50, logo: LOGO, selectionStore: createSelectionStore(), spinnerStore: createSpinnerStore(), completionStore: createCompletionStore(), overlayStore: createOverlayStore(), input: '', cursor: 0, scrollTop: 0, flatLines: [] }),
    );
    const frame = stripAnsi(lastFrame() ?? '');
    // 50% → round(0.5*10)=5 满（进度条无括号，见 StatusBar 多色高亮）
    expect(frame).toContain('█████░░░░░ 50%');
  });
});
