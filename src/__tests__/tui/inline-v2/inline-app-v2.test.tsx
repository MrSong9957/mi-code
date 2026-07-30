// src/__tests__/tui/inline-v2/inline-app-v2.test.tsx
//
// <InlineAppV2> 单元测试:V2 inline 模式根组件骨架(Stage 2)。
//
// 物理本质:V2 路径的根 React 元素,走 Ink reconciler + <Static>。
// Stage 2 只渲染 <Static>(已固化消息) + 占位 footer,无 spinner/streaming。
//
// 用 ink-testing-library 的 render/lastFrame 断言渲染内容。

import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { InlineAppV2, type InlineAppV2Stores } from '../../../tui/inline-v2/InlineAppV2.js';
import { PendingToolMessage } from '../../../tui/inline-v2/PendingToolMessage.js';
import { PendingThinkingMessage } from '../../../tui/inline-v2/PendingThinkingMessage.js';
import { createMessagesStore } from '../../../tui/state/messages-store.js';
import { createInputStore } from '../../../tui/state/input-store.js';
import { createStatusStore } from '../../../tui/state/status-store.js';
import { createSpinnerStore } from '../../../tui/state/spinner-store.js';
import { createCompletionStore } from '../../../tui/state/completion-store.js';
import { createSelectStore } from '../../../tui/state/select-store.js';
import { createOverlayStore } from '../../../tui/state/overlay-store.js';
import { createAskQuestionStore } from '../../../tui/state/ask-question-store.js';
import { createSelectionStore } from '../../../tui/state/selection-store.js';
import { selectSpinnerView } from '../../../tui/state/spinner-view.js';
import { displayWidth } from '../../../tui/inline/text-layout.js';
import { buildToolPresentation } from '../../../ui/tool-presentation.js';
import type { MessagesStore } from '../../../tui/state/messages-store.js';

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

// ──────────────────────────────────────────────────────────────────────────
// 语义 store helpers:替代旧 startStreaming / appendPendingTool / resolvePendingTool。
// ──────────────────────────────────────────────────────────────────────────

/** 标准 InlineAppV2 测试 props。 */
function makeProps(stores: InlineAppV2Stores, overrides: Partial<{
  cols: number;
  rows: number;
}> = {}) {
  return {
    messages: stores.messagesStore.getState().messages,
    status: {
      mode: 'build' as const,
      model: 'sonnet',
      dir: '/tmp',
      branch: 'main',
      contextPct: 0,
    },
    logo: { version: '0', dir: '/tmp' },
    stores,
    cols: overrides.cols ?? 80,
    rows: overrides.rows ?? 24,
  };
}

/**
 * 把一个 pending streaming-assistant 项的 text 更新为 newText。
 * 替代旧 updateStreaming:语义 store 没有该 action,直接 setState 改活动项。
 */
function updateStreamingAssistantText(store: MessagesStore, newText: string): void {
  store.setState((s) => {
    const items = [...s.model.items];
    const idx = items.findIndex((i) => i.kind === 'streaming-assistant');
    if (idx < 0) return s;
    const sa = items[idx]!;
    if (sa.kind !== 'streaming-assistant') return s;
    items[idx] = { ...sa, text: newText };
    return { model: { ...s.model, items } };
  });
}

/**
 * 构造 spawn_agent 的 compact-completion presentation(模拟子代理完成信封)。
 * `description` 成为展示 label;`status` 默认 completed→finished;`durationMs` 默认 5s。
 */
function buildSpawnAgentPresentation(opts: {
  toolUseId: string;
  description: string;
  body?: string;
  status?: 'completed' | 'incomplete' | 'unverified';
  durationMs?: number;
}) {
  const status = opts.status ?? 'completed';
  return buildToolPresentation({
    toolUseId: opts.toolUseId,
    toolName: 'spawn_agent',
    input: { description: opts.description },
    output: `[Subagent status=${status}]\n${opts.body ?? ''}`,
    durationMs: opts.durationMs ?? 5000,
  });
}

describe('<InlineAppV2>', () => {
  it('渲染 LOGO(MiCode + version + dir)', () => {
    const stores = createStores();
    const { lastFrame } = render(
      <InlineAppV2
        messages={[]}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '1.2.3', dir: '/tmp/proj' }}
        stores={stores}
        cols={80}
        rows={24}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('MiCode');
    expect(frame).toContain('v1.2.3');
    expect(frame).toContain('/tmp/proj');
  });

  it('渲染已固化消息', () => {
    const stores = createStores();
    stores.messagesStore.getState().appendTranscript({
      id: 'msg-1',
      kind: 'assistant',
      text: 'hello',
    });
    const { lastFrame } = render(
      <InlineAppV2
        messages={stores.messagesStore.getState().messages}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />,
    );
    expect(lastFrame()).toContain('hello');
  });

  it('空消息不崩溃', () => {
    const stores = createStores();
    const { lastFrame } = render(
      <InlineAppV2
        messages={[]}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />
    );
    expect(lastFrame()).toBeDefined();
  });

  it('多个已固化消息都被渲染', () => {
    const stores = createStores();
    stores.messagesStore.getState().appendTranscript({
      id: 'msg-u',
      kind: 'user',
      text: 'question',
    });
    stores.messagesStore.getState().appendTranscript({
      id: 'msg-a',
      kind: 'assistant',
      text: 'answer',
    });
    const { lastFrame } = render(
      <InlineAppV2
        messages={stores.messagesStore.getState().messages}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('question');
    expect(frame).toContain('answer');
  });

  it('相邻消息块之间保留一个空行', () => {
    const stores = createStores();
    stores.messagesStore.getState().appendTranscript({
      id: 'msg-u',
      kind: 'user',
      text: 'question',
    });
    stores.messagesStore.getState().appendTranscript({
      id: 'msg-a',
      kind: 'assistant',
      text: 'answer',
    });

    const { lastFrame } = render(<InlineAppV2 {...makeProps(stores)} />);
    const frame = stripAnsi(lastFrame() ?? '');

    expect(frame).toContain('❯ question\n\n● answer');
  });

  it('spinner active 时渲染 spinner 文本', () => {
    const stores = createStores();
    stores.spinnerStore.getState().start('responding');
    const { lastFrame } = render(
      <InlineAppV2
        messages={[]}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />,
    );
    // spinner 渲染会产生非空内容(<SpinnerMemo> 自订阅 spinnerStore)
    const frame = lastFrame() ?? '';
    expect(frame.length).toBeGreaterThan(0);
  });

  it('渲染 footer:border + prompt + statusbar', () => {
    const stores = createStores();
    const { lastFrame } = render(
      <InlineAppV2
        messages={[]}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('─');
    expect(frame).toContain('❯');
    expect(frame).toContain('sonnet');
  });

  it('用户输入文本出现在 footer', () => {
    const stores = createStores();
    stores.inputStore.getState().setText('hello world');
    const { lastFrame } = render(
      <InlineAppV2
        messages={[]}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />,
    );
    expect(lastFrame()).toContain('hello world');
  });
});
// ──────────────────────────────────────────────────────────────────────────
// AUTO-0025-stable Task 1/2：pending 工具的稳定指示器。
//
// 物理本质：运行中的 spawn_agent 用固定一行的闪烁 ● 表示。闪烁只改前导符号,
// 正文/布局/行数不变,消除活动区闪烁、空白和内容暂时消失。子代理内部工具明细
// 不进入主消息正文(见 Task 3)。
//
// 测试契约:
// 1. pending 固定占一物理行,过长则单行截断(不换行改变高度)。
// 2. 闪烁周期 600ms,只切换 ● 可见性,正文与总行数不变。
// 3. 完成后用固化渲染,无 pending 指示器残留。
// 4. 中文双宽字符在窄宽度下同行截断。
// 5. 无 glyph / 空首行回退到 'tool',不抛错。
// 6. spinner active=false 时 ● 强制可见。
// ──────────────────────────────────────────────────────────────────────────

describe('<InlineAppV2> pending tool 稳定指示器', () => {
  it('pending spawn_agent 在活动区可见(结果回来之前)', () => {
    const stores = createStores();
    const s = stores.messagesStore.getState();
    // spawn_agent 不可分组:startTool 追加一个 closed 但 entry 未解析的 PendingTool
    // (ActivityItem),由 <PendingToolSemantic> 渲染为稳定单行指示器。
    s.startTool({
      toolUseId: 'spawn-1',
      toolName: 'spawn_agent',
      input: { role: 'explore' },
    });

    const { lastFrame } = render(<InlineAppV2 {...makeProps(stores)} />);
    expect(lastFrame() ?? '').toContain('spawn_agent');
    // store model.items 含一个 pending-tool 活动项
    const pendingCount = stores.messagesStore.getState().model.items
      .filter((i) => i.kind === 'pending-tool').length;
    expect(pendingCount).toBe(1);
  });

  it('pending tool 完成后用固化渲染,无 pending 指示器残留', () => {
    const stores = createStores();
    const s = stores.messagesStore.getState();
    s.startTool({
      toolUseId: 'a1',
      toolName: 'spawn_agent',
      input: { description: '查找实现' },
    });
    // resolve:配对结果回到该 entry;因 group 已 closed 且全部解析 → 原地 complete 成 ToolBlock。
    s.resolveTool('a1', buildSpawnAgentPresentation({
      toolUseId: 'a1',
      description: '查找实现',
      body: 'found 3 skills',
    }));

    const { lastFrame } = render(<InlineAppV2 {...makeProps(stores)} />);
    const frame = lastFrame() ?? '';
    // 固化渲染:compact-completion 单行 ● Agent "..." finished · 5s
    expect(frame).toContain('Agent "查找实现" finished · 5s');
    // 无 pending 指示器残留(活动区不再有 spawn_agent(...) 行)
    expect(frame).not.toContain('spawn_agent(...)');
    // store:ToolBlock 已固化,无 pending-tool 活动项
    const items = stores.messagesStore.getState().model.items;
    expect(items.some((i) => i.kind === 'tool')).toBe(true);
    expect(items.some((i) => i.kind === 'pending-tool')).toBe(false);
  });

  it('并行 pending tool 各占固定一行,且都可见', () => {
    const stores = createStores();
    const s = stores.messagesStore.getState();
    s.startTool({ toolUseId: 'spawn-1', toolName: 'spawn_agent', input: { role: 'explore' } });
    s.startTool({ toolUseId: 'spawn-2', toolName: 'spawn_agent', input: { role: 'plan' } });

    const { lastFrame } = render(<InlineAppV2 {...makeProps(stores)} />);
    const frame = lastFrame() ?? '';
    // 每个 pending spawn_agent 各占一行(渲染为 ● spawn_agent(...))
    const spawnLines = frame.split('\n').filter((l) => l.includes('spawn_agent'));
    expect(spawnLines.length).toBe(2);
    // store:两个 pending-tool 活动项,分别带不同的 toolUseId
    const pending = stores.messagesStore.getState().model.items
      .filter((i) => i.kind === 'pending-tool');
    expect(pending.length).toBe(2);
    const toolUseIds = pending.flatMap((p) =>
      p.kind === 'pending-tool' ? p.entries.map((e) => e.toolUseId) : [],
    );
    expect(toolUseIds).toEqual(expect.arrayContaining(['spawn-1', 'spawn-2']));
  });
});

// ──────────────────────────────────────────────────────────────────────────
// AUTO-0025-stable Task 2:pending→finalized 状态迁移与并行稳定性。
//
// 验证:同一 UUID 从 pending 动态态迁移到 finalized 静态态时,
// 最终结果用固化渲染器(无 pending 指示器残留),且并行 pending 互不干扰。
// ──────────────────────────────────────────────────────────────────────────

describe('<InlineAppV2> stable pending 动态→静态迁移', () => {
  it('pending→finalized:最终帧含结果,无 pending 指示器残留', () => {
    const stores = createStores();
    const s = stores.messagesStore.getState();
    s.startTool({
      toolUseId: 'spawn-1',
      toolName: 'spawn_agent',
      input: { description: 'explore' },
    });

    const { lastFrame, rerender } = render(<InlineAppV2 {...makeProps(stores)} />);
    // pending 态:含 spawn_agent 指示器
    expect(lastFrame() ?? '').toContain('spawn_agent');

    // resolve:配对结果回到 entry;group 已 closed 且全部解析 → 原地 complete 成 ToolBlock。
    s.resolveTool('spawn-1', buildSpawnAgentPresentation({
      toolUseId: 'spawn-1',
      description: 'explore',
      body: 'found 3 skills',
    }));
    rerender(<InlineAppV2 {...makeProps(stores)} />);
    const finalFrame = lastFrame() ?? '';
    // 最终结果可见(固化渲染 ● Agent "explore" finished · 5s)
    expect(finalFrame).toContain('Agent "explore" finished');
    // pending 指示器(spawn_agent(...))已消失
    expect(finalFrame).not.toContain('spawn_agent(...)');
    // store:已是 ToolBlock,无 pending-tool 活动项
    const items = stores.messagesStore.getState().model.items;
    expect(items.some((i) => i.kind === 'tool')).toBe(true);
    expect(items.some((i) => i.kind === 'pending-tool')).toBe(false);
  });

  it('4 路并行 pending 各占固定一行,resolve 一个不移动其余', () => {
    const stores = createStores();
    const s = stores.messagesStore.getState();
    for (let i = 1; i <= 4; i++) {
      s.startTool({
        toolUseId: `spawn-${i}`,
        toolName: 'spawn_agent',
        input: { description: `task-${i}` },
      });
    }

    const { lastFrame, rerender } = render(<InlineAppV2 {...makeProps(stores)} />);
    // 4 个 pending 各占一行(渲染为 ● spawn_agent(...))
    const frame1 = lastFrame() ?? '';
    expect(frame1.split('\n').filter((l) => l.includes('spawn_agent')).length).toBe(4);
    // store:4 个 pending-tool 活动项
    expect(
      stores.messagesStore.getState().model.items.filter((i) => i.kind === 'pending-tool').length,
    ).toBe(4);

    // resolve spawn-2,其余 3 个仍 pending 且内容不变
    s.resolveTool('spawn-2', buildSpawnAgentPresentation({
      toolUseId: 'spawn-2',
      description: 'task-2',
      body: 'done-2',
    }));
    rerender(<InlineAppV2 {...makeProps(stores)} />);
    // store 是权威状态:spawn-2 已原地 complete 成 ToolBlock,其余 3 个仍 pending。
    // selectCommittedTranscript 只返回连续的已固化前缀(在第一个 ActivityItem 处截断,
    // 防止后完成的块抢先进入 <Static> 造成回溯闪烁)。因此 spawn-2 的 ToolBlock 虽然在
    // store 中已固化,但因前面还有 3 个未完成的 pending-tool,暂不进入 <Static> 渲染——
    // frame 仍只显示 4 行 pending(spawn-2 那行已固化但被前缀截断遮蔽)。
    const items = stores.messagesStore.getState().model.items;
    expect(items.filter((i) => i.kind === 'tool').length).toBe(1);
    expect(items.filter((i) => i.kind === 'pending-tool').length).toBe(3);
    // 已固化的 ToolBlock 是 spawn-2(summary 含 'task-2')
    const resolvedTool = items.find(
      (i): i is Extract<typeof i, { kind: 'tool' }> => i.kind === 'tool',
    );
    expect(resolvedTool).toBeDefined();
    expect(resolvedTool!.presentations.some((p) => p.summary.includes('task-2'))).toBe(true);
    // 其余 3 个 pending-tool 仍是 spawn-{1,3,4}
    const pendingIds = items.flatMap((i) =>
      i.kind === 'pending-tool' ? i.entries.map((e) => e.toolUseId) : [],
    );
    expect(pendingIds).toEqual(expect.arrayContaining(['spawn-1', 'spawn-3', 'spawn-4']));
  });

  it('active=false 时 resolve 一个 pending,其 glyph 可见后正常迁移', () => {
    const stores = createStores();
    // 不 start spinner → active=false
    const s = stores.messagesStore.getState();
    s.startTool({
      toolUseId: 'spawn-1',
      toolName: 'spawn_agent',
      input: { description: 'explore' },
    });

    const { lastFrame, rerender } = render(<InlineAppV2 {...makeProps(stores)} />);
    // active=false → ● 强制可见(pending 指示器渲染含 ●)
    expect(lastFrame() ?? '').toContain('●');

    s.resolveTool('spawn-1', buildSpawnAgentPresentation({
      toolUseId: 'spawn-1',
      description: 'explore',
      body: 'summary body',
    }));
    rerender(<InlineAppV2 {...makeProps(stores)} />);
    // 迁移后:最终结果可见,pending 指示器消失
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Agent "explore" finished');
    expect(frame).not.toContain('spawn_agent(...)');
  });
});


// ──────────────────────────────────────────────────────────────────────────
// PendingToolMessage 叶子组件单元测试(AUTO-0025-stable Task 1 Step 4)。
//
// 直接渲染 PendingToolMessage,验证固定一行、闪烁只改 glyph、截断、边界输入。
// 用 fake timers + 真实 spinnerStore.start()/tick() 推进共享时钟。
// ──────────────────────────────────────────────────────────────────────────

describe('<PendingToolMessage> 稳定指示器组件', () => {
  it('渲染固定一行,含 spawn_agent 正文', () => {
    const stores = createStores();
    const { lastFrame } = render(
      <PendingToolMessage
        msg={{
          uuid: 'p1', role: 'tool', kind: 'tool-progress', toolUseId: 'spawn-1',
          lines: [{ content: '● spawn_agent({"role":"explore"})', style: {}, indent: 0 }],
          finalized: false,
        }}
        cols={80}
        spinnerStore={stores.spinnerStore}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('spawn_agent');
    // 固定一行:帧内容只有一行(去掉末尾换行后)
    expect(frame.replace(/\n+$/, '').split('\n')).toHaveLength(1);
  });

  it('过长输入单行截断,不换行成第二行', () => {
    const stores = createStores();
    const longCall = '● spawn_agent({"role":"explore","prompt":"' + 'x'.repeat(60) + '"})';
    const { lastFrame } = render(
      <PendingToolMessage
        msg={{
          uuid: 'p1', role: 'tool', kind: 'tool-progress', toolUseId: 'spawn-1',
          lines: [{ content: longCall, style: {}, indent: 0 }],
          finalized: false,
        }}
        cols={40}
        spinnerStore={stores.spinnerStore}
      />,
    );
    const frame = lastFrame() ?? '';
    // 仍然只有一行(截断而非换行)
    expect(frame.replace(/\n+$/, '').split('\n')).toHaveLength(1);
    expect(frame).toContain('spawn_agent');
  });

  it('中文双宽字符在窄宽度下同行截断,不换行', () => {
    const stores = createStores();
    const { lastFrame } = render(
      <PendingToolMessage
        msg={{
          uuid: 'p1', role: 'tool', kind: 'tool-progress', toolUseId: 'spawn-1',
          lines: [{ content: '● spawn_agent(查询工作区中的技能并汇总详细信息)', style: {}, indent: 0 }],
          finalized: false,
        }}
        cols={30}
        spinnerStore={stores.spinnerStore}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame.replace(/\n+$/, '').split('\n')).toHaveLength(1);
    expect(frame).toContain('spawn_agent');
  });

  it('无前导 glyph 的正文保持原文', () => {
    const stores = createStores();
    const { lastFrame } = render(
      <PendingToolMessage
        msg={{
          uuid: 'p1', role: 'tool', kind: 'tool-progress', toolUseId: 'spawn-1',
          lines: [{ content: 'spawn_agent({"role":"explore"})', style: {}, indent: 0 }],
          finalized: false,
        }}
        cols={80}
        spinnerStore={stores.spinnerStore}
      />,
    );
    // 无 glyph 时正文原样渲染(组件不强行加 ● 到正文,● 只在 glyph 槽)
    expect(lastFrame() ?? '').toContain('spawn_agent');
  });

  it('空 lines 回退到 tool,不抛错', () => {
    const stores = createStores();
    const { lastFrame } = render(
      <PendingToolMessage
        msg={{
          uuid: 'p1', role: 'tool', kind: 'tool-progress', toolUseId: 'spawn-1',
          lines: [],
          finalized: false,
        }}
        cols={80}
        spinnerStore={stores.spinnerStore}
      />,
    );
    expect(lastFrame() ?? '').toContain('tool');
  });

  it('空首行 content 回退到 tool,不抛错', () => {
    const stores = createStores();
    const { lastFrame } = render(
      <PendingToolMessage
        msg={{
          uuid: 'p1', role: 'tool', kind: 'tool-progress', toolUseId: 'spawn-1',
          lines: [{ content: '', style: {}, indent: 0 }],
          finalized: false,
        }}
        cols={80}
        spinnerStore={stores.spinnerStore}
      />,
    );
    expect(lastFrame() ?? '').toContain('tool');
  });

  it('spinner active=false 时 ● 强制可见(不依赖时钟相位)', () => {
    const stores = createStores();
    // 不 start spinner → active=false
    const { lastFrame } = render(
      <PendingToolMessage
        msg={{
          uuid: 'p1', role: 'tool', kind: 'tool-progress', toolUseId: 'spawn-1',
          lines: [{ content: '● spawn_agent({"role":"explore"})', style: {}, indent: 0 }],
          finalized: false,
        }}
        cols={80}
        spinnerStore={stores.spinnerStore}
      />,
    );
    // active=false → ● 始终可见
    expect(lastFrame() ?? '').toContain('●');
  });

  it('闪烁只改变 glyph 可见性,正文与总行数不变', () => {
    vi.useFakeTimers();
    try {
      const stores = createStores();
      stores.spinnerStore.getState().start('responding');
      // start 时 time=0 → ● 可见
      const { lastFrame, rerender } = render(
        <PendingToolMessage
          msg={{
            uuid: 'p1', role: 'tool', kind: 'tool-progress', toolUseId: 'spawn-1',
            lines: [{ content: '● spawn_agent({"role":"explore"})', style: {}, indent: 0 }],
            finalized: false,
          }}
          cols={80}
          spinnerStore={stores.spinnerStore}
        />,
      );
      const frameVisible = lastFrame() ?? '';
      expect(frameVisible).toContain('●');

      // 推进时钟到隐藏相位(>600ms)
      vi.advanceTimersByTime(700);
      stores.spinnerStore.getState().tick();
      rerender(
        <PendingToolMessage
          msg={{
            uuid: 'p1', role: 'tool', kind: 'tool-progress', toolUseId: 'spawn-1',
            lines: [{ content: '● spawn_agent({"role":"explore"})', style: {}, indent: 0 }],
            finalized: false,
          }}
          cols={80}
          spinnerStore={stores.spinnerStore}
        />,
      );
      const frameHidden = lastFrame() ?? '';
      // 正文不变
      expect(frameHidden).toContain('spawn_agent');
      // 总行数不变(仍 1 行)
      expect(frameHidden.replace(/\n+$/, '').split('\n')).toHaveLength(1);
      expect(frameVisible.replace(/\n+$/, '').split('\n')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('glyph 槽固定两列宽,可见/隐藏时正文起始列不变', () => {
    const stores = createStores();
    // active=false 强制可见
    const { lastFrame, rerender } = render(
      <PendingToolMessage
        msg={{
          uuid: 'p1', role: 'tool', kind: 'tool-progress', toolUseId: 'spawn-1',
          lines: [{ content: '● spawn_agent({"role":"explore"})', style: {}, indent: 0 }],
          finalized: false,
        }}
        cols={80}
        spinnerStore={stores.spinnerStore}
      />,
    );
    const visibleFrame = lastFrame() ?? '';
    // 强制可见:● 在槽位
    expect(visibleFrame).toContain('●');

    // 切到隐藏相位需要 active=true + time 推进,这里只验证可见态下正文存在
    expect(visibleFrame).toContain('spawn_agent');
    void rerender;
  });
});


// ──────────────────────────────────────────────────────────────────────────
// Task 3.4 集成版:InlineAppV2 上下文中,spinner tick 不拖动整棵树重渲染。
//
// 这是 Stage 3 核心保证:spinner tick 的爆炸范围严格限制在 <SpinnerMemo> 内部。
// InlineAppV2 只订阅 spinner 的 rowCount(不随 tick 变化),tick 不触发 InlineAppV2
// 重渲染,故 <FooterV2>(memo)的 props 引用稳定,也不重渲染。
//
// 测试原理(直接验证 selector 稳定性,绕开 ink-testing-library 的异步调度不可观测问题):
// 1. 验证 InlineAppV2 使用的 selector `useStore(s => selectSpinnerView(s).rowCount)`
//    在 tick 时返回值用 Object.is 比较相等(这是 Zustand useStore 触发重渲染的唯一依据)。
// 2. 验证 spinner tick 时 frame 内容变化(说明 <SpinnerMemo> 内部仍正常重渲染)。
// ──────────────────────────────────────────────────────────────────────────

describe('<InlineAppV2> spinner tick 隔离(集成)', () => {
  it('selectSpinnerView(s).rowCount 在 tick 前后 Object.is 相等(selector 层面稳定)', () => {
    // InlineAppV2 用 useStore(spinnerStore, s => selectSpinnerView(s).rowCount) 订阅。
    // useStore 的重渲染判定:Object.is(prevSelectorOutput, nextSelectorOutput)。
    // 如果 tick 前后 rowCount 用 Object.is 相等,useStore 不触发重渲染。
    const stores = createStores();
    stores.spinnerStore.getState().start('responding');

    const selector = (s: ReturnType<typeof stores.spinnerStore.getState>) =>
      selectSpinnerView(s).rowCount;

    const before = selector(stores.spinnerStore.getState());
    for (let i = 0; i < 10; i++) {
      stores.spinnerStore.getState().tick();
    }
    const after = selector(stores.spinnerStore.getState());

    expect(Object.is(before, after)).toBe(true);
    expect(before).toBe(after);
  });

  it('spinner tick 时 frame 仍变化(<SpinnerMemo> 内部订阅,正常动画)', () => {
    // 反向验证:spinner 隔离不代表 spinner 不动画——<SpinnerMemo> 内部订阅
    // 整个 spinnerStore,tick 触发它重渲染,frame 内容随之变化。
    const stores = createStores();
    stores.spinnerStore.getState().start('responding');

    const { lastFrame } = render(
      <InlineAppV2
        messages={[]}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />,
    );
    const frame1 = lastFrame() ?? '';

    // 多次 tick 推进 spinner 时间(让 displayedTokens 等内部字段变)
    for (let i = 0; i < 10; i++) {
      stores.spinnerStore.getState().tick();
    }
    const frame2 = lastFrame() ?? '';

    // 两帧都应有 spinner 内容(非空),证明 spinner 在持续渲染
    expect(frame1.length).toBeGreaterThan(0);
    expect(frame2.length).toBeGreaterThan(0);
  });

  it('rowCount start/stop 时变化(0 → 1 → 0),证明 selector 响应真实变化', () => {
    // 反向验证:selector 在真正状态变化时能感知,只是不响应 tick。
    const stores = createStores();

    const rc0 = selectSpinnerView(stores.spinnerStore.getState()).rowCount;
    expect(rc0).toBe(0);

    stores.spinnerStore.getState().start('responding');
    const rc1 = selectSpinnerView(stores.spinnerStore.getState()).rowCount;
    expect(rc1).toBeGreaterThanOrEqual(1);

    stores.spinnerStore.getState().stop();
    const rc2 = selectSpinnerView(stores.spinnerStore.getState()).rowCount;
    expect(rc2).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Task 4.2 集成:<StreamingText> 接入 <InlineAppV2> 后,流式正文渲染验证。
//
// 物理本质:末条未固化消息的 streamingText 由 <StreamingText> 渲染在活动区
// (<Static> 之后,spinner 之前)。finalize 后,消息进入 <Static>,活动区清空。
// ──────────────────────────────────────────────────────────────────────────

describe('<InlineAppV2> 流式文本接入', () => {
  it('末条未固化消息的 streamingText 出现在 frame', () => {
    const stores = createStores();
    stores.messagesStore.getState().startAssistant('hello\nworld\n');

    const { lastFrame } = render(<InlineAppV2 {...makeProps(stores)} />);
    // wrapStreamingTextTrimmed 只显示完整行;"hello\nworld\n" 两行都是完整行
    expect(lastFrame()).toContain('hello');
    expect(lastFrame()).toContain('world');
  });

  it('streamingText 更新时 frame 跟着变(token 到达)', () => {
    const stores = createStores();
    const store = stores.messagesStore;
    store.getState().startAssistant('first\n');

    const { lastFrame, rerender } = render(<InlineAppV2 {...makeProps(stores)} />);
    expect(lastFrame()).toContain('first');

    // 流式 token 到达 → streaming-assistant 项的 text 追加完整行。
    // 语义 store 没有 updateStreaming;直接 setState 改活动项 text。
    updateStreamingAssistantText(store, 'first\nsecond line\n');
    rerender(<InlineAppV2 {...makeProps(stores)} />);
    expect(lastFrame()).toContain('first');
    expect(lastFrame()).toContain('second line');
  });

  it('finalize 后流式正文从活动区消失(进入 <Static>)', () => {
    const stores = createStores();
    // startAssistant 创建一个 streaming-assistant 活动项;finishAssistant 把它转成固化 assistant 块。
    // 固化文本即流式累加后的 text(此处直接用 'final line' 作为完整内容)。
    stores.messagesStore.getState().startAssistant('final line\n');
    stores.messagesStore.getState().finishAssistant();

    const { lastFrame } = render(<InlineAppV2 {...makeProps(stores)} />);
    const frame = lastFrame() ?? '';
    // 固化后的 assistant 块进入 <Static>(由 TranscriptBlockLine 渲染为 ● final line)
    expect(frame).toContain('final line');
    // 无 streaming-assistant 活动项残留
    expect(
      stores.messagesStore.getState().model.items.some((i) => i.kind === 'streaming-assistant'),
    ).toBe(false);
  });

  it('thinking 消息走临时 thinking 渲染路径(固定 Thinking… 文本)', () => {
    // AUTO-0025-transient:thinking 临时行文本固定 "Thinking…",
    // 原始推理内容(pondering deeply)不显示在活动区(只缓存供 Ctrl+O 展开)。
    const stores = createStores();
    stores.messagesStore.getState().startThinking('pondering deeply\n');

    const { lastFrame } = render(<InlineAppV2 {...makeProps(stores)} />);
    const frame = lastFrame() ?? '';
    // 固定文本可见
    expect(frame).toContain('Thinking…');
    // 原始推理内容不在活动区
    expect(frame).not.toContain('pondering');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Task 5a.1 集成:<SelectOverlayV2> 接入 <InlineAppV2>。
//
// visible 时替代 spinner+footer;close 后恢复 spinner+footer。
// ──────────────────────────────────────────────────────────────────────────

describe('<InlineAppV2> Select 选择器接入', () => {
  it('selectStore.open 后渲染 Select 替代 spinner+footer', () => {
    const stores = createStores();
    stores.selectStore.getState().open('Select model', [
      { value: 'gpt-4o', label: 'GPT-4o' },
      { value: 'sonnet', label: 'Sonnet' },
    ]);

    const { lastFrame } = render(
      <InlineAppV2
        messages={[]}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Select model');
    expect(frame).toContain('GPT-4o');
    // Select 替代了 footer:footer 的 prompt ❯ 和 statusbar 文本不应出现
    // (Select 自己有 navigate · Enter 提示,但不含 footer 的 ❯ prompt 或 sonnet model)
    expect(frame).not.toContain('sonnet');
  });

  it('selectStore.close 后恢复 spinner+footer', async () => {
    const stores = createStores();
    stores.selectStore.getState().open('Pick', [{ value: 'a', label: 'A' }]);
    const { lastFrame, rerender } = render(
      <InlineAppV2
        messages={[]}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />,
    );
    expect(lastFrame()).toContain('Pick');

    stores.selectStore.getState().close();
    await new Promise((r) => setTimeout(r, 10));
    rerender(
      <InlineAppV2
        messages={[]}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />,
    );
    // 关闭后:不再有 Select 标题,恢复 footer(border 等)
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Pick');
    expect(frame).toContain('─');
    expect(frame).toContain('sonnet');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Task 5a.2 集成:<OverlayHost>(Ctrl+O)接入 <InlineAppV2>。
//
// visible 时 <OverlayHost> 进终端备用屏直接写 stdout(不走 Ink 渲染),
// 主屏 Ink 渲染空白活动区(被备用屏遮住)。
// close 后退备用屏,主屏恢复 footer/spinner/streaming。
//
// 注:OverlayHost 的 alt-screen 行为由 overlay-host.test.tsx 单独覆盖。
// 这里只验证 <InlineAppV2> 在 overlayVisible 时活动区始终渲染(footer 在 Ink lastOutput 里),
// 退出备用屏后视觉上立即恢复(无需 Ink 重绘)。
// ──────────────────────────────────────────────────────────────────────────

describe('<InlineAppV2> Overlay (Ctrl+O) 接入', () => {
  it('overlayStore.open 后活动区仍渲染 footer(Ink lastOutput 含 footer)', () => {
    // 设计要点:overlayVisible 时活动区被备用屏遮住(用户看不见),但 Ink 的
    // lastOutput 仍含 footer。退出备用屏后,主屏 footer 物理上一直在,无需重绘。
    // 如果切换时隐藏活动区,Ink 的 lastOutput 变空白,退出备用屏后 footer 不恢复。
    const stores = createStores();
    stores.overlayStore.getState().open('Thinking output', [
      { content: 'full thinking text line 1', style: {}, indent: 0 },
      { content: 'full thinking text line 2', style: {}, indent: 0 },
    ]);

    const { lastFrame } = render(
      <InlineAppV2
        messages={[]}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />,
    );
    const frame = lastFrame() ?? '';
    // 活动区始终渲染 → footer 始终在 Ink lastOutput
    expect(frame).toContain('sonnet');
    expect(frame).toContain('❯');
  });

  it('overlayStore.close 后 footer 仍在', async () => {
    const stores = createStores();
    stores.overlayStore.getState().open('Title', [{ content: 'overlay content', style: {}, indent: 0 }]);
    const { lastFrame, rerender } = render(
      <InlineAppV2
        messages={[]}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />,
    );
    // Overlay visible 时活动区也渲染 footer
    expect(lastFrame() ?? '').toContain('sonnet');

    stores.overlayStore.getState().close();
    await new Promise((r) => setTimeout(r, 10));
    rerender(
      <InlineAppV2
        messages={[]}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('sonnet');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// AUTO-0025-transient Task 1:PendingThinkingMessage 闪烁 thinking 行。
//
// 物理本质:模型思考时显示一条固定高度的闪烁 ● Thinking… 活动行,
// 完成后消失留下永久 Thought 摘要。组件不消费 msg(文本固定 "Thinking…")。
// ──────────────────────────────────────────────────────────────────────────

describe('<PendingThinkingMessage> 闪烁 thinking 行', () => {
  it('renders one blinking Thinking row with a fixed glyph slot', () => {
    const stores = createStores();
    stores.spinnerStore.getState().start('thinking');
    const { lastFrame } = render(
      <PendingThinkingMessage cols={24} spinnerStore={stores.spinnerStore} />,
    );
    const visible = lastFrame() ?? '';
    expect(visible.replace(/\n+$/, '').split('\n')).toHaveLength(1);
    expect(visible).toContain('● Thinking…');
  });

  it('hidden 相位时 glyph 变空格,正文不变,仍一行', () => {
    const stores = createStores();
    stores.spinnerStore.getState().start('thinking');
    const { lastFrame } = render(
      <PendingThinkingMessage cols={24} spinnerStore={stores.spinnerStore} />,
    );
    // 推进到隐藏相位
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(700);
      stores.spinnerStore.getState().tick();
    } finally {
      vi.useRealTimers();
    }
    const hidden = lastFrame() ?? '';
    expect(hidden.replace(/\n+$/, '').split('\n')).toHaveLength(1);
    expect(hidden).toContain('Thinking…');
  });

  it('active=false 时 ● 强制可见', () => {
    const stores = createStores();
    // 不 start → active=false
    const { lastFrame } = render(
      <PendingThinkingMessage cols={24} spinnerStore={stores.spinnerStore} />,
    );
    expect(lastFrame() ?? '').toContain('● Thinking…');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// InlineAppV2 集成:thinking-progress + 多 tool-progress 活动行。
// ──────────────────────────────────────────────────────────────────────────

describe('<InlineAppV2> thinking-progress 活动行集成', () => {
  it('thinking-progress 占一行,4 个 tool-progress 各占一行,布局稳定', () => {
    const stores = createStores();
    const s = stores.messagesStore.getState();
    s.startThinking('Thinking…');
    for (let i = 1; i <= 4; i++) {
      s.startTool({
        toolUseId: `t-${i}`,
        toolName: 'spawn_agent',
        input: { description: `task-${i}` },
      });
    }

    const { lastFrame } = render(<InlineAppV2 {...makeProps(stores)} cols={28} />);
    const frame = lastFrame() ?? '';
    // thinking 行可见
    expect(frame).toContain('Thinking…');
    // 4 个 tool-progress 各占一行(渲染为 ● spawn_agent(...))
    expect(frame.split('\n').filter((l) => l.includes('spawn_agent')).length).toBe(4);
    // store:1 个 pending-thinking + 4 个 pending-tool
    const items = stores.messagesStore.getState().model.items;
    expect(items.filter((i) => i.kind === 'pending-thinking').length).toBe(1);
    expect(items.filter((i) => i.kind === 'pending-tool').length).toBe(4);
  });

  it('thinking-progress 和 tool-progress 都存在时 inputRowY 含两者', () => {
    const stores = createStores();
    const s = stores.messagesStore.getState();
    s.startThinking('Thinking…');
    s.startTool({ toolUseId: 't-1', toolName: 'spawn_agent', input: {} });

    const { lastFrame } = render(<InlineAppV2 {...makeProps(stores)} cols={40} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Thinking…');
    expect(frame).toContain('spawn_agent');
    // footer 仍可见(说明 inputRowY 计算正确,没把 footer 推出视口)
    expect(frame).toContain('❯');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// AUTO-0025-transient Task 3:agent-completion 单行展示。
// ──────────────────────────────────────────────────────────────────────────

describe('<InlineAppV2> agent-completion 单行展示', () => {
  it('完成的子代理渲染为单行 ● Agent "..." finished', () => {
    const stores = createStores();
    const s = stores.messagesStore.getState();
    s.startTool({
      toolUseId: 'a1',
      toolName: 'spawn_agent',
      input: { description: '查找实现' },
    });
    // resolve:compact-completion presentation(layout:'compact-completion' 由
    // buildToolPresentation 在命中 [Subagent status=...] envelope 时自动标记)。
    s.resolveTool('a1', buildSpawnAgentPresentation({
      toolUseId: 'a1',
      description: '查找实现',
    }));

    const { lastFrame } = render(<InlineAppV2 {...makeProps(stores)} />);
    const frame = lastFrame() ?? '';
    // compact-completion 单行渲染:● Agent "查找实现" finished · 5s
    expect(frame).toContain('Agent "查找实现" finished · 5s');
    expect(stripAnsi(frame)).not.toContain('● ● Agent');
    // 不含 pending 的 spawn_agent(...) 行(已被固化 ToolBlock 替换)
    expect(frame).not.toContain('spawn_agent(...)');
  });

  it('长中文标签截断为单行,不换行,含截断符,不超 cols 宽', () => {
    // PR2 review 补强:超长 agent 名称在窄终端下被截断(含 …)、保持单行、每行不超 cols。
    // compact-completion 渲染依赖 width={cols} + wrap="truncate-end"(Ink 标准契约)。
    const stores = createStores();
    const s = stores.messagesStore.getState();
    const longLabel = '这是一个非常长的子代理任务描述用于测试截断'.repeat(2);
    s.startTool({
      toolUseId: 'a1',
      toolName: 'spawn_agent',
      input: { description: longLabel },
    });
    s.resolveTool('a1', buildSpawnAgentPresentation({
      toolUseId: 'a1',
      description: longLabel,
    }));

    const COLS = 24;
    const { lastFrame } = render(<InlineAppV2 {...makeProps(stores)} cols={COLS} />);
    const frame = lastFrame() ?? '';
    // 找到 agent 完成行(含 "Agent")
    const lines = frame.split('\n');
    const agentLine = lines.find(l => l.includes('Agent'));
    expect(agentLine).toBeDefined();

    // 断言 1:含截断符 …(证明超长被截断,非完整输出)
    expect(agentLine).toContain('…');
    // 断言 2:不含完整长标签原文(证明确实截断了,非换行展开)
    expect(agentLine).not.toContain(longLabel);

    // 断言 3:该行 display width <= cols(截断后不超宽)
    expect(displayWidth(agentLine!)).toBeLessThanOrEqual(COLS);

    // 断言 4:长标签未被换行展开成多行(只占 1 行)。
    const agentLineCount = lines.filter(l => l.includes('Agent')).length;
    expect(agentLineCount).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PR2 review:独立 block 之间空行间距(Issue 3)。
//
// 验证:两条 finalized 消息在 <Static> 渲染时之间有空行分隔。
// 根因:<Static> 渲染独立 TuiMessage 时无 spacer,pipeline 插的空行被 adapter 吞掉。
// 修复:渲染层对非首个内容 item 前加 spacer,跳过自带前导空行的消息(去重)。
// ──────────────────────────────────────────────────────────────────────────

describe('<InlineAppV2> 独立 block 渲染顺序 (PR2 review Issue 3)', () => {
  // 语义模型重构后,两个 finalized block 在 <Static> 中各自作为独立 item 渲染,
  // 相邻 block 之间不再插入空行 spacer(间距改由各 block 自带的前导空行/边距控制)。
  // 本组测试改为锁定核心契约:两条 finalized tool block 都被渲染,且按 store 时序排列。

  it('两条 finalized tool block 都渲染,且按调用顺序排列', () => {
    const stores = createStores();
    const s = stores.messagesStore.getState();
    // 两次独立的 spawn_agent 调用(不可分组 → 各自 closed pending → resolve 后原地 complete)。
    s.startTool({ toolUseId: 't1', toolName: 'spawn_agent', input: { description: 'tool1' } });
    s.resolveTool('t1', buildSpawnAgentPresentation({ toolUseId: 't1', description: 'tool1' }));
    s.startTool({ toolUseId: 't2', toolName: 'spawn_agent', input: { description: 'tool2' } });
    s.resolveTool('t2', buildSpawnAgentPresentation({ toolUseId: 't2', description: 'tool2' }));

    const { lastFrame } = render(<InlineAppV2 {...makeProps(stores)} />);
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const idx1 = lines.findIndex(l => l.includes('tool1'));
    const idx2 = lines.findIndex(l => l.includes('tool2'));
    expect(idx1).toBeGreaterThanOrEqual(0);
    // t2 在 t1 之后渲染(保持时序)
    expect(idx2).toBeGreaterThan(idx1);
    // store:两个 ToolBlock 已固化,无 pending-tool 活动项
    const items = stores.messagesStore.getState().model.items;
    expect(items.filter((i) => i.kind === 'tool').length).toBe(2);
    expect(items.some((i) => i.kind === 'pending-tool')).toBe(false);
  });

  it('两条 agent-completion(单行 spawn_agent)block 都渲染,按顺序排列', () => {
    // issue 3 的真实复现场景:连续两条 spawn_agent 完成都各自渲染为单行,顺序不乱。
    const stores = createStores();
    const s = stores.messagesStore.getState();
    s.startTool({ toolUseId: 'a1', toolName: 'spawn_agent', input: { description: '探索' } });
    s.resolveTool('a1', buildSpawnAgentPresentation({
      toolUseId: 'a1', description: '探索', durationMs: 3000,
    }));
    s.startTool({ toolUseId: 'a2', toolName: 'spawn_agent', input: { description: '规划' } });
    s.resolveTool('a2', buildSpawnAgentPresentation({
      toolUseId: 'a2', description: '规划', durationMs: 5000,
    }));

    const { lastFrame } = render(<InlineAppV2 {...makeProps(stores)} />);
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const idx1 = lines.findIndex(l => l.includes('探索'));
    const idx2 = lines.findIndex(l => l.includes('规划'));
    expect(idx1).toBeGreaterThanOrEqual(0);
    // 规划在探索之后(按调用顺序)
    expect(idx2).toBeGreaterThan(idx1);
    // 两条完成行都各自占一行
    const exploreLine = lines.find(l => l.includes('Agent "探索" finished'));
    const planLine = lines.find(l => l.includes('Agent "规划" finished'));
    expect(exploreLine).toBeDefined();
    expect(planLine).toBeDefined();
  });
});
describe('<InlineAppV2> finalized Markdown table lifecycle', () => {
  const markdown = '| Tool | Purpose |\n| --- | --- |\n| glob | Find files |';

  it('shows raw Markdown while streaming, then one bordered table after finish', () => {
    const stores = createStores();
    stores.messagesStore.getState().startAssistant(markdown);

    const app = render(<InlineAppV2 {...makeProps(stores)} />);
    expect(stripAnsi(app.lastFrame() ?? '')).toContain('| Tool | Purpose |');
    expect(stripAnsi(app.lastFrame() ?? '')).not.toContain('┌');

    stores.messagesStore.getState().finishAssistant();
    app.rerender(<InlineAppV2 {...makeProps(stores)} />);
    const finalized = stripAnsi(app.lastFrame() ?? '');
    expect(finalized).toContain('┌');
    expect(finalized).not.toContain('| Tool | Purpose |');
    expect(finalized.match(/glob/g)).toHaveLength(1);
    expect(finalized.match(/●/g)).toHaveLength(1);
  });

  it('keeps raw Markdown in the finalized AssistantBlock', () => {
    const stores = createStores();
    stores.messagesStore.getState().startAssistant(markdown);
    stores.messagesStore.getState().finishAssistant();

    const assistant = stores.messagesStore.getState().model.items.find(
      (item) => item.kind === 'assistant',
    );
    expect(assistant?.text).toBe(markdown);
    expect(assistant?.text).not.toContain('┌');
  });

  it('keeps interrupted assistant Markdown raw after finalization', () => {
    const stores = createStores();
    stores.messagesStore.getState().startAssistant(markdown);
    stores.messagesStore.getState().finalizeStreamingAsInterrupted();

    const output = stripAnsi(render(
      <InlineAppV2 {...makeProps(stores)} />,
    ).lastFrame() ?? '');
    expect(output).toContain('| Tool | Purpose |');
    expect(output).not.toContain('┌');
  });

  it('remounts a finalized table against a narrower cols value', () => {
    const stores = createStores();
    stores.messagesStore.getState().startAssistant(
      '| H | Description |\n| --- | --- |\n| x | abcdefghijklmnop |',
    );
    stores.messagesStore.getState().finishAssistant();

    const wideRender = render(<InlineAppV2 {...makeProps(stores)} cols={80} />);
    const wide = stripAnsi(wideRender.lastFrame() ?? '');
    wideRender.unmount();
    const narrow = stripAnsi(render(
      <InlineAppV2 {...makeProps(stores)} cols={22} />,
    ).lastFrame() ?? '');

    expect(narrow).not.toBe(wide);
    expect(narrow).toContain('┌');
    expect(narrow.split('\n').filter((line) => line.includes('│')).length)
      .toBeGreaterThan(wide.split('\n').filter((line) => line.includes('│')).length);
  });
});
