// src/__tests__/tui/layout.test.tsx
// App 顶层布局：footer 紧贴 + 固定 LOGO 区 + StatusBar(tokens|elapsed)
//
// 物理本质：flexbox 列布局的副产品——消息区 flexGrow=1 占满剩余空间，
// LogoBox + Footer flexShrink=0 固定高度。空消息时消息区塌缩，LogoBox+Footer 紧贴顶部；
// 消息撑开后被挤到底。
//
// 断言（charter §顶层布局 + LOGO 固定区）：
// - LOGO 区含 ASCII art + model/dir/branch/mode（固定，不随滚动）
// - footer 含 ❯ + 边框 ─ + StatusBar(tokens: N | Ns)
// - 空消息时整体紧贴顶部

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { App } from '../../tui/App.js';
import type { TuiMessage, StatusBarData, LogoData } from '../../tui/types.js';

const STATUS: StatusBarData = { tokenCount: 42, elapsedSec: 7 };
const LOGO: LogoData = {
  version: '1.0.0', dir: '/tmp/proj', model: 'test-model', branch: 'main', mode: 'build',
};

function makeApp(messages: TuiMessage[] = []): { lastFrame: () => string | undefined } {
  return render(
    React.createElement(App, { messages, status: STATUS, logo: LOGO, input: '', cursor: 0 }),
  );
}

describe('App 顶层布局（flexbox footer 紧贴 + LOGO 固定区）', () => {
  it('空消息：LOGO + footer 紧贴顶部（无前置大段空行）', () => {
    const { lastFrame } = makeApp([]);
    const frame = lastFrame() ?? '';
    // LOGO 区要素
    expect(frame).toContain('MiCode v1.0.0');
    expect(frame).toContain('test-model');
    // footer 要素
    expect(frame).toContain('❯');
    expect(frame).toContain('─');
    // 空消息时整体上方不应有超过 2 行空行（紧贴顶部的证据）
    const lines = frame.split('\n');
    let firstNonEmptyIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim() !== '') { firstNonEmptyIdx = i; break; }
    }
    expect(firstNonEmptyIdx, '应至少有一行内容').toBeGreaterThanOrEqual(0);
    expect(firstNonEmptyIdx!, '紧贴顶部').toBeLessThanOrEqual(1);
  });

  it('有消息：消息内容出现在 LOGO/footer 之前（被挤到下方）', () => {
    const messages: TuiMessage[] = [
      {
        uuid: 'm1', role: 'assistant', finalized: true,
        lines: [{ content: '● 你好运', style: { fg: 'brand' }, indent: 0 }],
      },
    ];
    const { lastFrame } = makeApp(messages);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('● 你好运');
    // 消息在 LOGO（MiCode）之前还是之后？消息区 flexGrow 在上，LOGO+Footer 在下
    const msgIdx = frame.indexOf('● 你好运');
    const logoIdx = frame.indexOf('MiCode v1.0.0');
    expect(msgIdx).toBeGreaterThanOrEqual(0);
    expect(logoIdx).toBeGreaterThan(msgIdx);
  });

  it('LOGO 区固定显示：ASCII art + model/dir/branch/mode', () => {
    const { lastFrame } = makeApp([]);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('MiCode v1.0.0');
    expect(frame).toContain('TypeScript CLI · Node.js Runtime');
    expect(frame).toContain('/tmp/proj');
    expect(frame).toContain('model: test-model');
    expect(frame).toContain('branch: main');
    expect(frame).toContain('mode: build');
  });

  it('footer 含完整结构：上边框 + 输入框(❯) + 下边框 + StatusBar(tokens|elapsed)', () => {
    const { lastFrame } = makeApp([]);
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const inputIdx = lines.findIndex(l => l.includes('❯'));
    expect(inputIdx, '应有 ❯ 输入行').toBeGreaterThan(-1);
    const above = lines[inputIdx - 1];
    const below1 = lines[inputIdx + 1];
    const below2 = lines[inputIdx + 2];
    expect(above, '输入框上方应有上边框 ─').toContain('─');
    expect(below1, '输入框下方应有下边框 ─').toContain('─');
    expect(below2, '下边框下方应有状态栏 tokens|elapsed').toContain('tokens: 42 | 7s');
  });

  it('StatusBar 显示 tokens: N | Ns 格式（charter L89）', () => {
    const { lastFrame } = makeApp([]);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('tokens: 42 | 7s');
  });
});
