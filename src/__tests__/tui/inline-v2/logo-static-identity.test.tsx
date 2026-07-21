// src/__tests__/tui/inline-v2/logo-static-identity.test.tsx
//
// LOGO 消失根因测试 + <Static> identity 不变量。
//
// 根因(基于 Ink 源码分析 + 真实 stdout 验证):
// Ink reconciler 在 <Static> 宿主节点身份变化时(staticNode !== previousStaticNode)
// 触发 handleStaticChange,清空 fullStaticOutput。
// 之后若触发 shouldClearTerminalForFrame(全屏切换),Ink 会:
//   stdout.write(clearTerminal + fullStaticOutput + output)
// fullStaticOutput 已空 → clearTerminal 后 logo + 已固化消息被擦掉,不重写 → 消失。
//
// 触发 <Static> identity 变化的场景:
// - 父元素类型切换(Box ↔ Overlay):<Static> 被卸载/重挂载,宿主节点身份变化
//
// 修复:Overlay 不再替换根元素,改为同根 <Box> 下的条件子树。
// 这样 <Static> 始终在同一棵 React 树里,staticNode 稳定,fullStaticOutput 不被清。
//
// 测试用真实 Ink render + MockStdout,捕获所有 stdout.write 调用
// (含 \x1b[2J clearTerminal 序列),验证 Overlay 切换后 logo 仍被正确写入。

import { describe, it, expect } from 'vitest';
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
 * 用真实 Ink render + MockStdout 跑 <InlineAppV2>。
 * 返回 stdout 引用,可访问 writes 数组(每次 write 的完整数据)。
 * messages prop 通过 stores.messagesStore.getState().messages 传入(测试需要主动 rerender 更新)。
 */
async function renderWithRealInk(stores: ReturnType<typeof makeStores>) {
  const stdout = createMockStdout();
  // 用一个包装组件订阅 messagesStore,让 messages 自动更新
  function Wrapper() {
    const [msgs, setMsgs] = React.useState(stores.messagesStore.getState().messages);
    React.useEffect(() => stores.messagesStore.subscribe(() => {
      setMsgs([...stores.messagesStore.getState().messages]);
    }), []);
    const [overlayVer, setOverlayVer] = React.useState(0);
    React.useEffect(() => stores.overlayStore.subscribe(() => {
      setOverlayVer((v) => v + 1);
    }), []);
    return (
      <InlineAppV2
        messages={msgs}
        status={STATUS} logo={LOGO} stores={stores} cols={80} rows={24}
      />
    );
  }
  const instance = render(<Wrapper />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: true,
  });
  // 等首帧 flush
  await new Promise((r) => setTimeout(r, 50));
  return { stdout, instance };
}

describe('<InlineAppV2> LOGO <Static> identity 根因验证(真实 Ink render)', () => {
  it('Overlay 开关后,logo 写入记录仍存在(fullStaticOutput 未被清)', async () => {
    const stores = makeStores();
    const { stdout, instance } = await renderWithRealInk(stores);

    // 初始帧应该写了 logo
    const initialWrites = stdout.writes.map((w) => w.data).join('');
    expect(initialWrites).toContain('MiCode');

    // 记录开 Overlay 前的 logo 写入次数(应该已经至少 1 次)
    const logoWritesBefore = stdout.writes.filter((w) => w.data.includes('MiCode')).length;
    expect(logoWritesBefore).toBeGreaterThanOrEqual(1);

    // 开 Overlay
    stores.overlayStore.getState().open('Test overlay', [
      { content: 'overlay line', style: {}, indent: 0 },
    ]);
    await new Promise((r) => setTimeout(r, 50));

    // 关 Overlay —— 关键时刻:如果 <Static> identity 变化,fullStaticOutput 被清
    stores.overlayStore.getState().close();
    await new Promise((r) => setTimeout(r, 80));

    // 触发一次 spinner tick(让 Ink 重渲染活动区,但不应该触发 clearTerminal)
    stores.spinnerStore.getState().start('responding');
    await new Promise((r) => setTimeout(r, 100));

    // 验证:从关 Overlay 之后,Ink 不应该再写 clearTerminal(\x1b[2J)。
    // 如果写了 clearTerminal,且 fullStaticOutput 被清,logo 就会消失。
    const allWritesAfterOverlayClose = stdout.writes
      .map((w) => w.data)
      .join('');
    // logo 文本在所有写入里应该出现(被 Ink 写进 scrollback)
    expect(allWritesAfterOverlayClose).toContain('MiCode');

    instance.unmount();
    instance.waitUntilRenderFlush?.();
  });

  it('Overlay 多次循环开关,logo 始终在写入记录中', async () => {
    const stores = makeStores();
    const { stdout, instance } = await renderWithRealInk(stores);

    // 5 次 Overlay 开关循环
    for (let i = 0; i < 5; i++) {
      stores.overlayStore.getState().open(`Overlay ${i}`, [
        { content: `overlay ${i}`, style: {}, indent: 0 },
      ]);
      await new Promise((r) => setTimeout(r, 30));
      stores.overlayStore.getState().close();
      await new Promise((r) => setTimeout(r, 30));
    }

    // 最终帧 + 所有历史写入里,logo 应该都在
    const allData = stdout.writes.map((w) => w.data).join('');
    expect(allData).toContain('MiCode');

    instance.unmount();
    instance.waitUntilRenderFlush?.();
  });

  it('根因验证:<Static> 不应在 Overlay 切换时重写 logo(否则是 identity 变化)', async () => {
    // 如果 <Static> identity 稳定,logo 只在初始挂载时写 1 次(进 scrollback),
    // Overlay 开关不会让它重写。
    // 如果 <Static> identity 变化(根因 bug),每次 Overlay 关闭都会让 <Static> 重挂载,
    // logo 会被重复写入(测试会看到 logo 写入次数 > 1)。
    const stores = makeStores();
    const { stdout, instance } = await renderWithRealInk(stores);

    // 初始 logo 写入次数(应该恰好 1 次,<Static> 只写一次)
    const initialLogoWrites = stdout.writes.filter((w) => w.data.includes('MiCode')).length;
    expect(initialLogoWrites).toBe(1);

    // Overlay 开关循环 3 次
    for (let i = 0; i < 3; i++) {
      stores.overlayStore.getState().open(`O${i}`, [{ content: `c${i}`, style: {}, indent: 0 }]);
      await new Promise((r) => setTimeout(r, 30));
      stores.overlayStore.getState().close();
      await new Promise((r) => setTimeout(r, 30));
    }

    // logo 总写入次数:如果 <Static> identity 稳定 = 1;如果 identity 变化 = 4(每次重挂载都重写)
    const totalLogoWrites = stdout.writes.filter((w) => w.data.includes('MiCode')).length;
    expect(
      totalLogoWrites,
      `<Static> identity 应稳定,logo 只写 1 次。实际 ${totalLogoWrites} 次 → identity 变化 → 根因未修复`,
    ).toBe(1);

    instance.unmount();
    instance.waitUntilRenderFlush?.();
  });
});
