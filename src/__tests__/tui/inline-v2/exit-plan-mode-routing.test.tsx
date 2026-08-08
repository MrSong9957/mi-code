// src/__tests__/tui/inline-v2/exit-plan-mode-routing.test.tsx
//
// <InlineAppV2> 路由分发集成测试：presentation.kind === 'plan-approval' 时
// 渲染 <ExitPlanModeOverlayV2>，否则回退到 <AskQuestionOverlayV2>。
//
// 物理本质：InlineAppV2 根据 askQuestionStore.request.presentation?.kind 决定
// 渲染哪个 overlay 组件。这是 AUTO-0025 的路由分发契约。
//
// 测试覆盖（对应设计文档"集成与回归测试"章节）：
// 1. plan-approval → ExitPlanModeOverlayV2（含"准备开始编码？"，不含"Submit"）
// 2. 无 presentation 的普通问卷 → AskQuestionOverlayV2（含"Submit"，不含"准备开始编码？"）
// 3. 未知 presentation kind → 回退 AskQuestionOverlayV2
// 4. 问卷不可见时不渲染任何 overlay

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { InlineAppV2, type InlineAppV2Stores } from '../../../tui/inline-v2/InlineAppV2.js';
import { createMessagesStore } from '../../../tui/state/messages-store.js';
import { createInputStore } from '../../../tui/state/input-store.js';
import { createStatusStore } from '../../../tui/state/status-store.js';
import { createSpinnerStore } from '../../../tui/state/spinner-store.js';
import { createCompletionStore } from '../../../tui/state/completion-store.js';
import { createSelectStore } from '../../../tui/state/select-store.js';
import { createOverlayStore } from '../../../tui/state/overlay-store.js';
import { createAskQuestionStore } from '../../../tui/state/ask-question-store.js';
import { createSelectionStore } from '../../../tui/state/selection-store.js';
import type { AskQuestionRequest } from '../../../agent/ask-user-types.js';
import { LocaleProvider } from '../../../locale/context.js';
import { createLanguageStore } from '../../../locale/language-store.js';

// createStores：构造 InlineAppV2 所需的全部 store。
// （inline-app-v2.test.tsx 的同名 helper 是模块私有，这里内联一份权威实现。）
function createStores(): InlineAppV2Stores {
  return {
    messagesStore: createMessagesStore(),
    inputStore: createInputStore({ onSubmit: () => {} }),
    statusStore: createStatusStore({ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main' }),
    spinnerStore: createSpinnerStore(),
    completionStore: createCompletionStore(),
    selectStore: createSelectStore(),
    selectionStore: createSelectionStore(),
    overlayStore: createOverlayStore(),
    askQuestionStore: createAskQuestionStore(),
  };
}

// plan-approval request：带 presentation.kind === 'plan-approval'。
const planApprovalRequest: AskQuestionRequest = {
  questions: [
    {
      question: 'Claude 已拟定执行方案，是否继续？',
      header: 'Plan',
      options: [
        { label: '确认执行，清空上下文并使用自动模式', description: '重置对话，Agent 自动执行所有修改' },
        { label: '确认执行，使用自动模式', description: '保留当前上下文，Agent 自动执行所有修改' },
        { label: '确认执行，手动审核修改', description: '保留当前上下文，每步修改需你确认' },
      ],
      multiSelect: false,
    },
  ],
  otherLabel: '提出修改意见',
  presentation: {
    kind: 'plan-approval',
    content: '# 计划正文\n\n这是拟定的执行计划。',
    filePath: '/tmp/plan.md',
  },
};

// 普通多题 request：不带 presentation。
const plainRequest: AskQuestionRequest = {
  questions: [
    {
      header: 'One',
      question: 'Q1',
      options: [
        { label: 'A', description: 'first' },
        { label: 'B', description: 'second' },
      ],
      multiSelect: true,
    },
    {
      header: 'Two',
      question: 'Q2',
      options: [{ label: 'C', description: 'third' }],
      multiSelect: false,
    },
  ],
};

// 未知 presentation kind（模拟未来扩展，应安全回退到通用问卷）。
const unknownKindRequest = {
  questions: [
    {
      header: 'Future',
      question: 'Q?',
      options: [{ label: 'X', description: 'desc' }],
      multiSelect: false,
    },
  ],
  presentation: {
    kind: 'unknown-future',
    content: 'something',
  },
} as unknown as AskQuestionRequest;

const baseProps = {
  messages: [] as [],
  status: { mode: 'build' as const, model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 },
  logo: { version: '0', dir: '/tmp' },
  cols: 80,
  rows: 24,
};

// AskQuestionOverlayV2 通过 useLocale() 消费 locale，InlineAppV2 渲染 overlay 时
// 必须挂在 LocaleProvider 下（与 bootstrap.tsx 装配一致）。
const languageStore = createLanguageStore('en-US');
function renderInlineApp(stores: InlineAppV2Stores) {
  return render(
    React.createElement(
      LocaleProvider,
      { store: languageStore },
      React.createElement(InlineAppV2, { ...baseProps, stores }),
    ),
  );
}

describe('<InlineAppV2> plan-approval 路由分发', () => {
  it('plan-approval 路由到 ExitPlanModeOverlayV2（含"准备开始编码？"，不含"Submit"）', () => {
    const stores = createStores();
    stores.askQuestionStore.getState().open('plan-1', planApprovalRequest, () => {});

    const { lastFrame } = renderInlineApp(stores);
    const frame = lastFrame() ?? '';

    // ExitPlanModeOverlayV2 的标题
    expect(frame).toContain('准备开始编码？');
    // AskQuestionOverlayV2 的 tabs 标志不应出现
    expect(frame).not.toContain('Submit');
  });

  it('无 presentation 的普通问卷仍用 AskQuestionOverlayV2（含"Submit"，不含"准备开始编码？"）', () => {
    const stores = createStores();
    stores.askQuestionStore.getState().open('question-1', plainRequest, () => {});

    const { lastFrame } = renderInlineApp(stores);
    const frame = lastFrame() ?? '';

    // AskQuestionOverlayV2 的 tabs 含 Submit
    expect(frame).toContain('Submit');
    // ExitPlanModeOverlayV2 的标题不应出现
    expect(frame).not.toContain('准备开始编码？');
  });

  it('未知 presentation kind 回退到 AskQuestionOverlayV2', () => {
    const stores = createStores();
    stores.askQuestionStore.getState().open('unknown-1', unknownKindRequest, () => {});

    const { lastFrame } = renderInlineApp(stores);
    const frame = lastFrame() ?? '';

    // 回退到通用问卷
    expect(frame).toContain('Submit');
    expect(frame).not.toContain('准备开始编码？');
  });

  it('问卷不可见时不渲染任何 overlay（不含"准备开始编码？"，不含"Submit" tabs）', () => {
    const stores = createStores();
    // askQuestionStore 未 open，visible=false

    const { lastFrame } = renderInlineApp(stores);
    const frame = lastFrame() ?? '';

    // 两个 overlay 都不应渲染
    expect(frame).not.toContain('准备开始编码？');
    expect(frame).not.toContain('Submit');
  });
});
