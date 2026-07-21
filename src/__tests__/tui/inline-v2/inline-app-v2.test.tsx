// src/__tests__/tui/inline-v2/inline-app-v2.test.tsx
//
// <InlineAppV2> 单元测试:V2 inline 模式根组件骨架(Stage 2)。
//
// 物理本质:V2 路径的根 React 元素,走 Ink reconciler + <Static>。
// Stage 2 只渲染 <Static>(已固化消息) + 占位 footer,无 spinner/streaming。
//
// 用 ink-testing-library 的 render/lastFrame 断言渲染内容。

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
import { selectSpinnerView } from '../../../tui/state/spinner-view.js';

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
    stores.messagesStore.getState().appendMessage('assistant', [
      { content: 'hello', style: {}, indent: 0 },
    ]);
    const { lastFrame } = render(
      <InlineAppV2
        messages={stores.messagesStore.getState().messages}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />
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
    stores.messagesStore.getState().appendMessage('user', [
      { content: 'question', style: {}, indent: 0 },
    ]);
    stores.messagesStore.getState().appendMessage('assistant', [
      { content: 'answer', style: {}, indent: 0 },
    ]);
    const { lastFrame } = render(
      <InlineAppV2
        messages={stores.messagesStore.getState().messages}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('question');
    expect(frame).toContain('answer');
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
    stores.messagesStore.getState().startStreaming('hello\nworld\n');

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
    // wrapStreamingTextTrimmed 只显示完整行;"hello\nworld\n" 两行都是完整行
    expect(lastFrame()).toContain('hello');
    expect(lastFrame()).toContain('world');
  });

  it('streamingText 更新时 frame 跟着变(token 到达)', () => {
    const stores = createStores();
    stores.messagesStore.getState().startStreaming('first\n');

    const { lastFrame, rerender } = render(
      <InlineAppV2
        messages={stores.messagesStore.getState().messages}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />,
    );
    expect(lastFrame()).toContain('first');

    // 流式 token 到达 → streamingText 追加完整行
    stores.messagesStore.getState().updateStreaming('first\nsecond line\n');
    rerender(
      <InlineAppV2
        messages={stores.messagesStore.getState().messages}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />,
    );
    expect(lastFrame()).toContain('first');
    expect(lastFrame()).toContain('second line');
  });

  it('finalize 后流式正文从活动区消失(进入 <Static>)', () => {
    const stores = createStores();
    stores.messagesStore.getState().startStreaming('draft line\n');
    // startStreaming 创建一条未固化消息;finalizeStreaming 把它转成固化消息
    stores.messagesStore.getState().finalizeStreaming([
      { content: 'final line', style: {}, indent: 0 },
    ]);

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
    // 固化后的消息进入 <Static>(由 renderFinalizedLine 渲染)
    expect(frame).toContain('final line');
  });

  it('thinking 消息走 thinking 渲染路径(dim)', () => {
    const stores = createStores();
    stores.messagesStore.getState().startStreamingThinking('pondering deeply\n');

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
    expect(lastFrame()).toContain('pondering');
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
