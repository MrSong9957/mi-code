// scripts/tty-verify/render-scenarios.tsx
//
// ConPTY 渲染驱动:构造 Issue 1/2/3 的消息数据,用真实 Ink render 输出到 stdout。
// 由外层 node-pty 在真实伪终端里 spawn 此脚本,捕获 ANSI 流还原成屏幕断言。
//
// 用法(由 run-verify.mjs 调用):
//   node --import tsx scripts/tty-verify/render-scenarios.tsx <scenario> <cols>
//
// scenario:
//   ask-answered   Issue 1:ask_user_question 父子结构
//   assistant-cont Issue 2:assistant 续行缩进
//   agent-spacing  Issue 3:连续 agent-completion 间距
//   truncate       Issue 3:超长标签截断

import React from 'react';
import { render } from 'ink';
import { InlineAppV2, type InlineAppV2Stores } from '../../src/tui/inline-v2/InlineAppV2.js';
import { createMessagesStore } from '../../src/tui/state/messages-store.js';
import { createInputStore } from '../../src/tui/state/input-store.js';
import { createStatusStore } from '../../src/tui/state/status-store.js';
import { createSpinnerStore } from '../../src/tui/state/spinner-store.js';
import { createCompletionStore } from '../../src/tui/state/completion-store.js';
import { createSelectStore } from '../../src/tui/state/select-store.js';
import { createOverlayStore } from '../../src/tui/state/overlay-store.js';
import { createAskQuestionStore } from '../../src/tui/state/ask-question-store.js';
import { createSelectionStore } from '../../src/tui/state/selection-store.js';
import { LocaleProvider } from '../../src/locale/context.js';
import { createLanguageStore } from '../../src/locale/language-store.js';

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

function buildScenario(scenario: string, stores: InlineAppV2Stores) {
  const s = stores.messagesStore.getState();
  if (scenario === 'ask-answered') {
    // Issue 1:ask_user_question 父标题 + 子项(经真实 block-pipeline 装配)
    s.finishAsk('q1', {
      id: 'q1',
      kind: 'ask',
      summary: 'Answered 2 questions',
      items: ['日志库 → winston', '日志级别 → debug'],
    });
  } else if (scenario === 'assistant-cont') {
    // Issue 2:assistant 多段文本(含 \n),固化后走 renderFinalizedLine
    s.startAssistant('第一段内容,选择了 Winston\n第二段内容,开始探索项目');
    s.finishAssistant();
  } else if (scenario === 'agent-spacing') {
    // Issue 3:连续 agent-completion 单行消息
    s.startTool({ toolUseId: 'a1', toolName: 'spawn_agent', input: { description: '探索' } });
    s.resolveTool('a1', {
      toolUseId: 'a1',
      toolName: 'spawn_agent',
      summary: 'Agent "探索" finished · 3s',
      details: [],
      status: 'success',
      layout: 'compact-completion',
    });
    s.startTool({ toolUseId: 'a2', toolName: 'spawn_agent', input: { description: '规划' } });
    s.resolveTool('a2', {
      toolUseId: 'a2',
      toolName: 'spawn_agent',
      summary: 'Agent "规划" finished · 5s',
      details: [],
      status: 'success',
      layout: 'compact-completion',
    });
  } else if (scenario === 'truncate') {
    // Issue 3:超长 agent 标签截断
    const longLabel = '这是一个非常长的子代理任务描述用于测试截断'.repeat(2);
    s.startTool({ toolUseId: 'a1', toolName: 'spawn_agent', input: { description: longLabel } });
    s.resolveTool('a1', {
      toolUseId: 'a1',
      toolName: 'spawn_agent',
      summary: `Agent "${longLabel}" finished · 5s`,
      details: [],
      status: 'success',
      layout: 'compact-completion',
    });
  }
}

const scenario = process.argv[2] ?? 'ask-answered';
const cols = parseInt(process.argv[3] ?? '80', 10);
const rows = 24;

const stores = createStores();
buildScenario(scenario, stores);
const languageStore = createLanguageStore('en-US');

// 真实 Ink render:输出到 stdout(在 ConPTY 里就是 PTY 的从机端)
const { unmount } = render(
  <LocaleProvider store={languageStore}>
    <InlineAppV2
      messages={stores.messagesStore.getState().messages}
      status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
      logo={{ version: '0', dir: '/tmp' }}
      stores={stores}
      cols={cols}
      rows={rows}
    />
  </LocaleProvider>,
  { stdout: process.stdout } as any,
);

// 等 Ink flush 后退出(由外层 PTY 捕获完整输出)
setTimeout(() => { unmount(); setTimeout(() => process.exit(0), 100); }, 300);
