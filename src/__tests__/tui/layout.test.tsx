// src/__tests__/tui\layout.test.tsx
// App 顶层布局：footer 紧贴行为（Claude Code 风格）
//
// 物理本质：flexbox 列布局的副产品——消息区 flexGrow=1 占满剩余空间，
// footer flexShrink=0 固定高度。空消息时消息区高度塌缩为 0，footer 紧贴顶部；
// 消息撑开后 footer 被挤到底。这是 charter §"顶层布局结构"的核心契约。
//
// 本期断言布局结构（不依赖具体终端高度）：
// - footer 含 ❯ 提示符 + 边框 ─ + 状态栏
// - 空消息时 footer 出现在输出的靠前位置（无大量空行垫在 footer 上方）
// - 有消息时消息内容出现在 footer 之前

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { App } from '../../tui/App.js';
import type { TuiMessage, StatusBarData } from '../../tui/types.js';

const STATUS: StatusBarData = {
  mode: 'build', model: 'test-model', branch: 'main', dir: '/tmp', contextUsage: 0,
};

function makeApp(messages: TuiMessage[] = []): { lastFrame: () => string | undefined } {
  return render(
    React.createElement(App, { messages, status: STATUS, input: '', cursor: 0 }),
  );
}

describe('App 顶层布局（flexbox footer 紧贴）', () => {
  it('空消息：footer 紧贴顶部（❯ 输入框、边框、状态栏都在，无前置大段空行）', () => {
    const { lastFrame } = makeApp([]);
    const frame = lastFrame() ?? '';
    // footer 三要素都在
    expect(frame).toContain('❯');
    expect(frame).toContain('─');
    expect(frame).toContain('test-model');
    // 空消息时 footer 上方不应有超过 2 行空行（紧贴顶部的证据）
    const lines = frame.split('\n');
    // 找到第一个非空行（footer 开始的位置）
    let firstNonEmptyIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim() !== '') { firstNonEmptyIdx = i; break; }
    }
    expect(firstNonEmptyIdx, '应至少有一行内容（footer）').toBeGreaterThanOrEqual(0);
    // 紧贴顶部：第一个非空行应在很靠前的位置（允许最多 1 行空白前导）
    expect(firstNonEmptyIdx!).toBeLessThanOrEqual(1);
  });

  it('有消息：消息内容出现在 footer 之前（footer 被挤到下方）', () => {
    const messages: TuiMessage[] = [
      {
        uuid: 'm1', role: 'assistant', finalized: true,
        lines: [{ content: '● 你好运', style: { fg: 'brand' }, indent: 0 }],
      },
      {
        uuid: 'm2', role: 'user', finalized: true,
        lines: [{ content: '❯ 用户输入', style: { fg: 'success', bold: true }, indent: 0 }],
      },
    ];
    const { lastFrame } = makeApp(messages);
    const frame = lastFrame() ?? '';
    // 消息内容在
    expect(frame).toContain('● 你好运');
    expect(frame).toContain('❯ 用户输入');
    // footer（状态栏 test-model）在消息之后
    const msgIdx = frame.indexOf('● 你好运');
    const footerIdx = frame.indexOf('test-model');
    expect(msgIdx).toBeGreaterThanOrEqual(0);
    expect(footerIdx).toBeGreaterThan(msgIdx);
  });

  it('footer 含完整结构：上边框 + 输入框(❯) + 下边框 + 状态栏', () => {
    const { lastFrame } = makeApp([]);
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    // 找 ❯ 行
    const inputIdx = lines.findIndex(l => l.includes('❯'));
    expect(inputIdx, '应有 ❯ 输入行').toBeGreaterThan(-1);
    // 上方应有边框 ─，下方应有边框 ─ 和状态栏
    const above = lines[inputIdx - 1];
    const below1 = lines[inputIdx + 1];
    const below2 = lines[inputIdx + 2];
    expect(above, '输入框上方应有上边框 ─').toContain('─');
    expect(below1, '输入框下方应有下边框 ─').toContain('─');
    expect(below2, '下边框下方应有状态栏（含 model）').toContain('test-model');
  });

  it('状态栏显示 mode/model/branch/dir', () => {
    const { lastFrame } = makeApp([]);
    const frame = lastFrame() ?? '';
    // 状态栏含这些字段（具体格式由 StatusBar 决定，这里只断言存在性）
    expect(frame).toContain('main');
    expect(frame).toContain('build');
  });
});
