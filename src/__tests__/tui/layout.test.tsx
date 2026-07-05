// src/__tests__/tui/layout.test.tsx
// App 顶层布局：footer 紧贴 + 固定 LOGO 区 + StatusBar(mode|model|dir|branch|进度条)

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { App } from '../../tui/App.js';
import type { TuiMessage, StatusBarData, LogoData } from '../../tui/types.js';

const STATUS: StatusBarData = {
  mode: 'build', model: 'sonnet', dir: 'Projects/mi-code', branch: 'main', contextPct: 0.25,
};
const LOGO: LogoData = { version: '1.0.0', dir: '/tmp/proj' };

function makeApp(messages: TuiMessage[] = []): { lastFrame: () => string | undefined } {
  return render(
    React.createElement(App, { messages, status: STATUS, logo: LOGO, input: '', cursor: 0 }),
  );
}

describe('App 顶层布局（flexbox footer 紧贴 + LOGO 固定区）', () => {
  it('空消息：LOGO + footer 紧贴顶部', () => {
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
    const frame = lastFrame() ?? '';
    // 25% → 10 格条 = ███░░░░░░░（round(0.25*10)=3 满）
    expect(frame).toContain('build | sonnet | Projects/mi-code | main |');
    expect(frame).toContain('[███░░░░░░░] 25%');
  });

  it('StatusBar 进度条随 contextPct 变化', () => {
    const status50: StatusBarData = { ...STATUS, contextPct: 0.5 };
    const { lastFrame } = render(
      React.createElement(App, { messages: [], status: status50, logo: LOGO, input: '', cursor: 0 }),
    );
    const frame = lastFrame() ?? '';
    // 50% → round(0.5*10)=5 满
    expect(frame).toContain('[█████░░░░░] 50%');
  });
});
