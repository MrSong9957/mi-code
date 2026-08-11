// src/__tests__/tui/inline-v2/agent-block-line.test.tsx
//
// AgentBlockLine 单元测试:一等公民子代理完成块的单行渲染。
//
// 物理本质:验证 AgentBlock(kind:'agent')被渲染为单行
// `● Agent "label" <statusWord> · <duration>`(en-US 本地化)。
// cancelled/partial/unknown → dimColor;failed → red;completed → 正常。
// 无 durationMs → 不追加 `· <dur>` 后缀。

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import React from 'react';
import { LocaleProvider } from '../../../locale/context.js';
import { createLanguageStore } from '../../../locale/language-store.js';
import type { Language } from '../../../locale/types.js';
import { AgentBlockLine } from '../../../tui/inline-v2/AgentBlockLine.js';
import type { AgentBlock } from '../../../tui/transcript-types.js';

function renderAgentBlock(
  block: AgentBlock,
  cols: number,
  language: Language = 'en-US',
): string {
  return render(
    <LocaleProvider store={createLanguageStore(language)}>
      <AgentBlockLine block={block} cols={cols} />
    </LocaleProvider>,
  ).lastFrame() ?? '';
}

describe('<AgentBlockLine>', () => {
  it('renders completed agent as ● Agent "label" finished · Ns', () => {
    const block: AgentBlock = {
      id: 'a1', kind: 'agent', label: 'explore', status: 'completed',
      summary: 'found 3 files', durationMs: 4000,
    };
    const frame = stripAnsi(renderAgentBlock(block, 100));
    expect(frame).toContain('● Agent "explore" finished · 4s');
  });

  it('renders cancelled agent with dim styling', () => {
    const block: AgentBlock = {
      id: 'a2', kind: 'agent', label: 'explore', status: 'cancelled',
    };
    const raw = renderAgentBlock(block, 100);
    const frame = stripAnsi(raw);
    expect(frame).toContain('● Agent "explore" cancelled');
    // cancelled → dimColor (raw ANSI contains dim escape)
    expect(raw).toContain('\u001b[2m');
  });

  it('renders failed agent with red color', () => {
    const block: AgentBlock = {
      id: 'a3', kind: 'agent', label: 'explore', status: 'failed',
    };
    const raw = renderAgentBlock(block, 100);
    const frame = stripAnsi(raw);
    expect(frame).toContain('● Agent "explore" failed');
    // failed → red
    expect(raw).toContain('\u001b[31m');
  });

  it('renders partial agent with dim styling', () => {
    const block: AgentBlock = {
      id: 'a4', kind: 'agent', label: 'explore', status: 'partial',
    };
    const raw = renderAgentBlock(block, 100);
    expect(stripAnsi(raw)).toContain('● Agent "explore" partial');
    expect(raw).toContain('\u001b[2m');
  });

  it('renders unknown agent with dim styling', () => {
    const block: AgentBlock = {
      id: 'a5', kind: 'agent', label: 'explore', status: 'unknown',
    };
    const raw = renderAgentBlock(block, 100);
    expect(stripAnsi(raw)).toContain('● Agent "explore" unknown');
    expect(raw).toContain('\u001b[2m');
  });

  it('omits duration suffix when durationMs is undefined', () => {
    const block: AgentBlock = {
      id: 'a6', kind: 'agent', label: 'explore', status: 'completed',
    };
    const frame = stripAnsi(renderAgentBlock(block, 100));
    expect(frame).toContain('● Agent "explore" finished');
    expect(frame).not.toContain('·');
  });

  it('renders only one physical row', () => {
    const block: AgentBlock = {
      id: 'a7', kind: 'agent', label: 'explore', status: 'completed', durationMs: 5000,
    };
    const frame = stripAnsi(renderAgentBlock(block, 100));
    expect(frame.replace(/\n+$/, '').split('\n')).toHaveLength(1);
  });

  it('localizes in zh-CN', () => {
    const block: AgentBlock = {
      id: 'a8', kind: 'agent', label: '查找', status: 'completed', durationMs: 5000,
    };
    const frame = stripAnsi(renderAgentBlock(block, 100, 'zh-CN'));
    expect(frame).toContain('● 子代理 "查找" 已完成 · 5 秒');
  });
});
