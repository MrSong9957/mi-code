// src/__tests__/tui/inline-v2/pending-agent-message.test.tsx
//
// PendingAgentMessage 单元测试:运行中子代理的稳定单行指示器。
//
// 物理本质:PendingAgent(kind:'pending-agent')用固定一行的闪烁 ● 表示"正在执行"。
// 与 PendingToolMessage/PendingThinkingMessage 同构:
// - 固定高度 height={1},过长用 wrap="truncate-end" 单行截断。
// - 闪烁 ● 复用共享 spinner 时钟。
// - 叶子订阅:tick 不拖动 InlineAppV2 重渲染。

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { LocaleProvider } from '../../../locale/context.js';
import { createLanguageStore } from '../../../locale/language-store.js';
import { createSpinnerStore } from '../../../tui/state/spinner-store.js';
import { PendingAgentMessage } from '../../../tui/inline-v2/PendingAgentMessage.js';
import type { PendingAgent } from '../../../tui/transcript-types.js';

function renderPendingAgent(
  agent: PendingAgent,
  cols: number,
  spinnerStore = createSpinnerStore(),
): { frame: string; spinnerStore: ReturnType<typeof createSpinnerStore> } {
  const { lastFrame } = render(
    <LocaleProvider store={createLanguageStore('en-US')}>
      <PendingAgentMessage agent={agent} cols={cols} spinnerStore={spinnerStore} />
    </LocaleProvider>,
  );
  return { frame: lastFrame() ?? '', spinnerStore };
}

describe('<PendingAgentMessage>', () => {
  it('renders one row with agent label and ● glyph', () => {
    const agent: PendingAgent = { id: 'a1', kind: 'pending-agent', label: 'explore' };
    const { frame } = renderPendingAgent(agent, 80);
    expect(frame.replace(/\n+$/, '').split('\n')).toHaveLength(1);
    expect(frame).toContain('●');
    expect(frame).toContain('Agent "explore"');
  });

  it('active=false forces ● visible (no spinner started)', () => {
    const agent: PendingAgent = { id: 'a2', kind: 'pending-agent', label: 'plan' };
    const { frame } = renderPendingAgent(agent, 80);
    expect(frame).toContain('●');
  });

  it('glyph slot is fixed 2 columns wide; body starts at consistent column', () => {
    const agent: PendingAgent = { id: 'a3', kind: 'pending-agent', label: 'explore' };
    const { frame } = renderPendingAgent(agent, 80);
    // ● in glyph slot, body text follows
    expect(frame).toContain('● Agent "explore"');
  });

  it('long label truncates to one row (no line wrap)', () => {
    const longLabel = 'x'.repeat(100);
    const agent: PendingAgent = { id: 'a4', kind: 'pending-agent', label: longLabel };
    const { frame } = renderPendingAgent(agent, 40);
    expect(frame.replace(/\n+$/, '').split('\n')).toHaveLength(1);
    // Truncated content still starts with the agent prefix
    expect(frame).toContain('Agent');
  });
});
