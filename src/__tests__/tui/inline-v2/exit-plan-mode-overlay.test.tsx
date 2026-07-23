// src/__tests__/tui/inline-v2/exit-plan-mode-overlay.test.tsx
//
// ExitPlanModeOverlayV2 单元测试：纯展示组件（计划正文 + 审批操作）。
// 所有键盘交互由 useInputHandler 路由到 AskQuestionStore，本组件不处理输入。

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ExitPlanModeOverlayV2 } from '../../../tui/inline-v2/ExitPlanModeOverlayV2.js';
import { createAskQuestionStore } from '../../../tui/state/ask-question-store.js';
import type { AskQuestionRequest } from '../../../agent/ask-user-types.js';

const planRequest: AskQuestionRequest = {
  questions: [
    {
      question: 'Claude 已拟定执行方案，是否继续？',
      header: 'Plan',
      options: [
        { label: '确认执行，清空上下文并使用自动模式', description: '重置对话（已占用 5%），Agent 自动执行所有修改' },
        { label: '确认执行，使用自动模式', description: '保留当前上下文，Agent 自动执行所有修改' },
        { label: '确认执行，手动审核修改', description: '保留当前上下文，每步修改需你确认' },
      ],
      multiSelect: false,
    },
  ],
  otherLabel: '提出修改意见',
  presentation: {
    kind: 'plan-approval',
    content: '# 测试计划\n\n这是 **粗体** 和 `代码`。\n\n1. 第一步\n2. 第二步',
    filePath: '/tmp/plan.md',
  },
};

function openStore() {
  const store = createAskQuestionStore();
  store.getState().open('plan-1', planRequest, () => {});
  return store;
}

describe('<ExitPlanModeOverlayV2>', () => {
  it('renders the Chinese title and guidance text', () => {
    const store = openStore();
    const { lastFrame } = render(<ExitPlanModeOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('准备开始编码？');
    expect(frame).toContain('以下是 Agent 拟定的计划：');
    expect(frame).toContain('Agent 已完成计划，是否继续执行？');
  });

  it('renders the plan Markdown body', () => {
    const store = openStore();
    const { lastFrame } = render(<ExitPlanModeOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('测试计划');
    expect(frame).toContain('粗体');
    expect(frame).toContain('代码');
    expect(frame).toContain('第一步');
  });

  it('renders the three approval options and their descriptions', () => {
    const store = openStore();
    const { lastFrame } = render(<ExitPlanModeOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('确认执行，清空上下文并使用自动模式');
    expect(frame).toContain('确认执行，使用自动模式');
    expect(frame).toContain('确认执行，手动审核修改');
    expect(frame).toContain('重置对话（已占用 5%），Agent 自动执行所有修改');
    expect(frame).toContain('保留当前上下文，Agent 自动执行所有修改');
    expect(frame).toContain('保留当前上下文，每步修改需你确认');
  });

  it('does not render the generic question tabs', () => {
    const store = openStore();
    const { lastFrame } = render(<ExitPlanModeOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).not.toContain('Submit');
    expect(frame).not.toContain('○ Plan');
    expect(frame).not.toContain('✓');
  });

  it('does not repeat the internal header/question text', () => {
    const store = openStore();
    const { lastFrame } = render(<ExitPlanModeOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).not.toContain('Claude 已拟定执行方案');
  });

  it('does not render checkbox markers (neither brackets nor the empty box)', () => {
    const store = openStore();
    const { lastFrame } = render(<ExitPlanModeOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).not.toContain('[x]');
    expect(frame).not.toContain('[ ]');
    expect(frame).not.toContain('☐');
  });

  it('renders a native round border (verticals and corners)', () => {
    const store = openStore();
    const { lastFrame } = render(<ExitPlanModeOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('│');
    expect(frame).toContain('╭');
  });

  it('renders the custom Other label', () => {
    const store = openStore();
    const { lastFrame } = render(<ExitPlanModeOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('提出修改意见');
  });

  it('renders the Chat affordance in Chinese', () => {
    const store = openStore();
    const { lastFrame } = render(<ExitPlanModeOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('与 Agent 讨论此计划');
  });

  it('renders the help text', () => {
    const store = openStore();
    const { lastFrame } = render(<ExitPlanModeOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('↑↓ 导航 · Enter 选择 · Esc 取消');
  });

  it('marks the first option as focused by default', () => {
    const store = openStore();
    const { lastFrame } = render(<ExitPlanModeOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('❯ 确认执行，清空上下文');
  });

  it('renders the Other input cursor and the input-mode help', () => {
    const store = openStore();
    store.setState({ inputMode: true, otherDraft: '改一下', otherCursor: 1 });
    const { lastFrame } = render(<ExitPlanModeOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('提出修改意见：改|一下');
    expect(frame).toContain('Enter 保存修改意见');
  });

  it('shows a fallback when the plan body is empty', () => {
    const store = openStore();
    store.setState({
      request: {
        ...planRequest,
        presentation: { kind: 'plan-approval', content: '   ', filePath: '/tmp/plan.md' },
      },
    });
    const { lastFrame } = render(<ExitPlanModeOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('未找到计划正文');
    // approval options still present
    expect(frame).toContain('确认执行，清空上下文并使用自动模式');
  });

  it('wraps long option text to the content width on a narrow terminal', () => {
    const store = openStore();
    const { lastFrame } = render(<ExitPlanModeOverlayV2 store={store} cols={20} />);
    const frame = lastFrame() ?? '';

    // 原生 borderStyle="round" 在 ink-testing-library 下按 stdout.columns(固定 100)
    // pad 每行，无法直接断言逐行 ≤ cols。但可以验证关键长文本确实被折行：
    // cols=20 → contentWidth=16，"确认执行，清空上下文并使用自动模式"(18 CJK = 36 列)
    // 必须被 truncateLine/foldLine 切断，不应作为一整行完整出现。
    const ansi = /\x1b\[[0-9;]*m/g;
    const clean = frame.replace(ansi, '');
    // 完整未截断的 label(含焦点前缀)不应出现——说明宽度约束生效
    expect(clean).not.toContain('❯ 确认执行，清空上下文并使用自动模式');
  });

  it('returns null when not visible', () => {
    const store = createAskQuestionStore();
    const { lastFrame } = render(<ExitPlanModeOverlayV2 store={store} cols={80} />);
    expect(lastFrame()).toBe('');
  });
});
