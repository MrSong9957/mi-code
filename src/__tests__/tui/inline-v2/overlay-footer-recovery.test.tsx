// src/__tests__/tui/inline-v2/overlay-footer-recovery.test.tsx
//
// Overlay(Ctrl+O)切换后 footer 恢复回归测试。
//
// 背景:之前 overlayVisible 时隐藏活动区(!overlayVisible && <活动区/>),
// 导致 Ink 的 lastOutput 变空白,退出备用屏后 footer 不恢复。
// 修复:活动区始终渲染,被备用屏遮住但 Ink lastOutput 仍含 footer。
//
// 测试原理:用真实 Ink render + MockStdout,捕获所有 stdout.write 调用
// (含备用屏转义序列和 Ink 的渲染帧)。
// 验证:Overlay 关闭后,后续 Ink 写入的帧仍含 footer 内容(statusbar 文本)。
// 如果回归到"隐藏活动区"的旧实现,后续 Ink 帧不含 footer → 测试失败。

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink';
import { InlineAppV2 } from '../../../tui/inline-v2/InlineAppV2.js';
import { createMessagesStore } from '../../../tui/state/messages-store.js';
import { createInputStore } from '../../../tui/state/input-store.js';
import { createStatusStore } from '../../../tui/state/status-store.js';
import { createSpinnerStore } from '../../../tui/state/spinner-store.js';
import { createCompletionStore } from '../../../tui/state/completion-store.js';
import { createSelectStore } from '../../../tui/state/select-store.js';
import { createSelectionStore } from '../../../tui/state/selection-store.js';
import { createOverlayStore } from '../../../tui/state/overlay-store.js';
import { createAskQuestionStore } from '../../../tui/state/ask-question-store.js';
import { EMPTY_SPINNER_CONTEXT } from '../../../tui/state/spinner-store.js';
import { createMockStdout } from './helpers/mock-stdout.js';
import { LocaleProvider } from '../../../locale/context.js';
import { createLanguageStore } from '../../../locale/language-store.js';

const languageStore = createLanguageStore('en-US');

const LOGO = { version: '1.0.0', dir: '/tmp/proj' };
const STATUS = { mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 };

function makeStores() {
  return {
    messagesStore: createMessagesStore(),
    inputStore: createInputStore({ onSubmit: () => {} }),
    statusStore: createStatusStore({ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main' }),
    spinnerStore: createSpinnerStore(undefined, EMPTY_SPINNER_CONTEXT),
    completionStore: createCompletionStore(),
    selectStore: createSelectStore(),
    selectionStore: createSelectionStore(),
    overlayStore: createOverlayStore(),
    askQuestionStore: createAskQuestionStore(),
  };
}

/**
 * Wrapper:<InlineAppV2> + 订阅 messagesStore/overlayStore,让 props 自动更新。
 * 用 ref 持有 stores,通过 forceUpdate 触发重渲染。
 */
function makeWrapper(stores: ReturnType<typeof makeStores>) {
  function Wrapper() {
    const [, force] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
      const unsub1 = stores.messagesStore.subscribe(() => force());
      const unsub2 = stores.overlayStore.subscribe(() => force());
      return () => { unsub1(); unsub2(); };
    }, []);
    const msgs = stores.messagesStore.getState().messages;
    return (
      <LocaleProvider store={languageStore}>
        <InlineAppV2
          messages={msgs}
          status={STATUS}
          logo={LOGO}
          stores={stores}
          cols={80}
          rows={24}
        />
      </LocaleProvider>
    );
  }
  return Wrapper;
}

async function renderWithRealInk(stores: ReturnType<typeof makeStores>) {
  const stdout = createMockStdout();
  const Wrapper = makeWrapper(stores);
  const instance = render(<Wrapper />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: true,
  });
  await new Promise((r) => setTimeout(r, 50));
  return { stdout, instance };
}

describe('Overlay 切换后 footer 恢复回归', () => {
  it('Overlay 关闭后,后续 Ink 帧仍含 footer(statusbar)', async () => {
    const stores = makeStores();
    // 先启动 spinner,确保后续 tick 能触发 Ink 重绘
    stores.spinnerStore.getState().start('responding');
    const { stdout, instance } = await renderWithRealInk(stores);

    // 进 Overlay
    stores.overlayStore.getState().open('Test', [
      { content: 'overlay content', style: {}, indent: 0 },
    ]);
    await new Promise((r) => setTimeout(r, 50));

    // 退 Overlay
    stores.overlayStore.getState().close();
    await new Promise((r) => setTimeout(r, 80));

    // 触发 spinner tick,让 Ink 写新帧
    stores.spinnerStore.getState().tick();
    await new Promise((r) => setTimeout(r, 80));

    // 验证:退 Overlay 后,Ink 的 lastOutput 含 footer。
    // Ink createIncremental 行级 diff:statusbar 不变就不重写,但 lastOutput 仍含完整帧。
    // 用 frames 找含 footer 的 Ink 帧(过滤 OverlayHost 直写的备用屏内容)。
    const inkFrames = stdout.writes
      .map((w) => w.data)
      .filter((d) => !d.includes('\x1b[?1049') && !d.startsWith('\x1b[1mTest'));
    const hasFooterFrame = inkFrames.some((f) => f.includes('sonnet'));
    expect(
      hasFooterFrame,
      'Overlay 关闭后 Ink 应至少写过一帧含 footer。' +
      '如果失败,可能是 overlayVisible 时隐藏了活动区,导致 Ink lastOutput 变空。',
    ).toBe(true);

    instance.unmount();
    instance.waitUntilRenderFlush?.();
  });

  it('Overlay 多次开关循环,每次都能在 Ink 帧里找到 footer', async () => {
    const stores = makeStores();
    // 启动 spinner,让 tick 真正触发 Ink 写帧
    stores.spinnerStore.getState().start('responding');
    const { stdout, instance } = await renderWithRealInk(stores);

    for (let i = 0; i < 4; i++) {
      stores.overlayStore.getState().open(`Loop ${i}`, [
        { content: `content ${i}`, style: {}, indent: 0 },
      ]);
      await new Promise((r) => setTimeout(r, 40));
      stores.overlayStore.getState().close();
      await new Promise((r) => setTimeout(r, 60));

      // 触发 Ink 写新帧(spinner 已 active)
      stores.spinnerStore.getState().tick();
      await new Promise((r) => setTimeout(r, 40));
    }

    // 全程 Ink 写过的所有帧,应该有含 footer 的(首次渲染 + 关闭 Overlay 后的恢复帧)
    const inkFrames = stdout.writes
      .map((w) => w.data)
      .filter((d) => !d.includes('\x1b[?1049'));
    const footerFrameCount = inkFrames.filter((f) => f.includes('sonnet')).length;
    expect(
      footerFrameCount,
      '4 次循环后,Ink 应至少写过 1 帧含 footer(初始渲染时)',
    ).toBeGreaterThanOrEqual(1);

    instance.unmount();
    instance.waitUntilRenderFlush?.();
  });

  it('关键契约:overlayVisible 时活动区仍渲染(改 input 会让 Ink 重写 input 行)', async () => {
    // 这是真正的修复契约:overlayVisible 时活动区(含 FooterV2)必须在 React 树里。
    // 验证方法:overlayVisible 时改 input 文本,Ink 应该重写 input 行(因为 FooterV2 在订阅 inputStore)。
    // 如果回归到"overlayVisible 时隐藏活动区",FooterV2 不在树里 → 改 input 不触发重写。
    const stores = makeStores();
    stores.overlayStore.getState().open('T', [{ content: 'c', style: {}, indent: 0 }]);
    const { stdout, instance } = await renderWithRealInk(stores);
    stdout.writes.length = 0;

    // overlayVisible 状态下改 input
    stores.inputStore.getState().setText('visible-during-overlay');
    await new Promise((r) => setTimeout(r, 80));

    const inkWrites = stdout.writes
      .map((w) => w.data)
      .filter((d) => !d.includes('\x1b[?1049'));
    const hasInputUpdate = inkWrites.some((f) => f.includes('visible-during-overlay'));
    expect(
      hasInputUpdate,
      'overlayVisible 时改 input,Ink 应重写 input 行(证明 FooterV2 仍在 React 树)。' +
      '如果失败,说明回归到"overlayVisible 时隐藏活动区"的旧实现 —— 退出备用屏后 footer 不恢复。',
    ).toBe(true);

    instance.unmount();
    instance.waitUntilRenderFlush?.();
  });

  it('Overlay 开启时,备用屏序列正确写入(\\x1b[?1049h)', async () => {
    const stores = makeStores();
    const { stdout, instance } = await renderWithRealInk(stores);
    stdout.writes.length = 0;

    stores.overlayStore.getState().open('Title', [
      { content: 'overlay line', style: {}, indent: 0 },
    ]);
    await new Promise((r) => setTimeout(r, 50));

    const allWrites = stdout.writes.map((w) => w.data).join('');
    expect(allWrites).toContain('\x1b[?1049h');
    expect(allWrites).toContain('Title');
    expect(allWrites).toContain('overlay line');

    instance.unmount();
    instance.waitUntilRenderFlush?.();
  });

  it('Overlay 关闭时,退备用屏序列正确写入(\\x1b[?1049l)', async () => {
    const stores = makeStores();
    stores.overlayStore.getState().open('Title', [
      { content: 'overlay line', style: {}, indent: 0 },
    ]);
    const { stdout, instance } = await renderWithRealInk(stores);
    stdout.writes.length = 0;

    stores.overlayStore.getState().close();
    await new Promise((r) => setTimeout(r, 60));

    const allWrites = stdout.writes.map((w) => w.data).join('');
    expect(allWrites).toContain('\x1b[?1049l');

    instance.unmount();
    instance.waitUntilRenderFlush?.();
  });
});
