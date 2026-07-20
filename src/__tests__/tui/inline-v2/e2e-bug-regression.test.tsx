// src/__tests__/tui/inline-v2/e2e-bug-regression.test.tsx
//
// V2 inline 模式 E2E 原始 bug 端到端复现(整树级别)。
//
// 与 incremental-rendering.test.tsx 的 POC 回归不同,这里走完整 <ConnectedApp>
// + 真实 useSpinnerClock + 真实 stores,模拟生产场景下流式 + spinner 并发。
//
// 原始 bug:V0 InlineRenderer.commit() 在每次 spinner tick / 流式 token 到达时
// 全量重写活动区,导致 scrollback 出现"几十份累积副本"。
// V2 修复:<Static> 把 finalized 一次性写入 scrollback,后续不再带;
// spinner/streaming 在活动区,Ink createIncremental 行级 diff。
//
// E2E 层面的验证:
// 1. 整树渲染稳定(无崩溃、无 React 警告)
// 2. 已固化消息文本在最终帧中只出现 1 次(<Static> 不重复)
// 3. spinner 持续 tick 时,<FooterV2> 的 statusbar 内容稳定(无重复)
//
// 注:ink-testing-library 的 frames 收集的是 Ink reconciler 渲染输出
// (而非真实终端 stdout 写入),所以"字节量"指标与 incremental-rendering.test.tsx
// 不直接可比。本测试关注"重复文本"——这是原始 bug 的可视标志。

import { describe, it, expect } from 'vitest';
import { createE2EHarness, waitMs } from './helpers/e2e-harness.js';

describe('V2 inline E2E - 原始 bug 端到端回归', () => {
  it('流式 + spinner 并发下,已固化消息文本不重复出现', async () => {
    const h = createE2EHarness();
    try {
      // 已固化消息(原始 bug 标志:此文本会被重写几十次)
      h.stores.messagesStore.getState().appendMessage('assistant', [
        { content: 'FINALIZED_UNIQUE_TOKEN_X12345', style: {}, indent: 0 },
      ]);
      // 开流式 + spinner
      h.stores.messagesStore.getState().startStreaming('');
      h.stores.spinnerStore.getState().start('responding');
      await waitMs(30);

      // 模拟流式 token 多次到达 + spinner 多次 tick
      for (let i = 0; i < 15; i++) {
        h.stores.spinnerStore.getState().tick();
        const cur = h.stores.messagesStore.getState().messages;
        const last = cur[cur.length - 1];
        if (last && !last.finalized && last.streamingText !== undefined) {
          h.stores.messagesStore.getState().updateStreaming(
            (last.streamingText ?? '') + 'token' + i + '\n',
          );
        }
        await waitMs(15);
      }
      await waitMs(30);

      // 取最终帧,断言 FINALIZED_UNIQUE_TOKEN_X12345 只出现 1 次
      const finalFrame = h.lastFrame() ?? '';
      const occurrences = (finalFrame.match(/FINALIZED_UNIQUE_TOKEN_X12345/g) ?? []).length;
      expect(
        occurrences,
        `已固化消息文本应只出现 1 次(原始 bug 标志:此值会达几十次),实际 ${occurrences} 次`,
      ).toBe(1);
    } finally {
      h.unmount();
    }
  });

  it('spinner tick 不让 statusbar 内容重复', async () => {
    const h = createE2EHarness({
      status: { mode: 'build', model: 'sonnet', dir: '/tmp/proj', branch: 'main' },
    });
    try {
      h.stores.spinnerStore.getState().start('responding');
      await waitMs(20);

      // 多次 tick
      for (let i = 0; i < 10; i++) {
        h.stores.spinnerStore.getState().tick();
        await waitMs(8);
      }

      // 最终帧中 statusbar 的 'sonnet' 应只出现 1 次(单行 statusbar,无重复)
      const frame = h.lastFrame() ?? '';
      const modelOccurrences = (frame.match(/sonnet/g) ?? []).length;
      expect(modelOccurrences).toBe(1);
    } finally {
      h.unmount();
    }
  });

  it('多轮对话后,所有消息文本都只出现 1 次', async () => {
    const h = createE2EHarness();
    try {
      // 3 轮对话
      for (let round = 1; round <= 3; round++) {
        h.stores.messagesStore.getState().appendMessage('user', [
          { content: `USER_TURN_${round}`, style: {}, indent: 0 },
        ]);
        h.stores.messagesStore.getState().appendMessage('assistant', [
          { content: `ASSISTANT_TURN_${round}`, style: {}, indent: 0 },
        ]);
      }
      // 模拟 spinner 跑一会(制造 tick + 重渲染压力)
      h.stores.spinnerStore.getState().start('responding');
      for (let i = 0; i < 5; i++) {
        h.stores.spinnerStore.getState().tick();
        await waitMs(10);
      }
      h.stores.spinnerStore.getState().stop();
      await waitMs(20);

      const frame = h.lastFrame() ?? '';
      // 每条消息文本应只出现 1 次
      for (let round = 1; round <= 3; round++) {
        const userOcc = (frame.match(new RegExp(`USER_TURN_${round}`, 'g')) ?? []).length;
        const assistantOcc = (frame.match(new RegExp(`ASSISTANT_TURN_${round}`, 'g')) ?? []).length;
        expect(userOcc, `USER_TURN_${round} 应只出现 1 次`).toBe(1);
        expect(assistantOcc, `ASSISTANT_TURN_${round} 应只出现 1 次`).toBe(1);
      }
    } finally {
      h.unmount();
    }
  });

  it('流式 finalize 后,草稿消失,固化消息只出现 1 次', async () => {
    const h = createE2EHarness();
    try {
      h.stores.messagesStore.getState().startStreaming('stream draft content\n');
      h.stores.spinnerStore.getState().start('responding');
      await waitMs(30);

      // finalize:草稿变固化
      h.stores.messagesStore.getState().finalizeStreaming([
        { content: 'FINAL_CONTENT_UNIQUE', style: {}, indent: 0 },
      ]);
      h.stores.spinnerStore.getState().stop();
      await waitMs(30);

      const frame = h.lastFrame() ?? '';
      // 固化后只有 FINAL_CONTENT_UNIQUE,没有草稿
      expect(frame).toContain('FINAL_CONTENT_UNIQUE');
      expect(frame).not.toContain('stream draft content');

      // FINAL_CONTENT_UNIQUE 只出现 1 次
      const occ = (frame.match(/FINAL_CONTENT_UNIQUE/g) ?? []).length;
      expect(occ).toBe(1);
    } finally {
      h.unmount();
    }
  });

  it('Select + spinner 并发时,Select 内容稳定无重复', async () => {
    const h = createE2EHarness();
    try {
      // spinner active + Select visible 并发(理论不会同时发生,但测试稳定性)
      h.stores.spinnerStore.getState().start('responding');
      h.stores.selectStore.getState().open('Pick', [
        { value: 'a', label: 'OPT_A_UNIQUE' },
        { value: 'b', label: 'OPT_B_UNIQUE' },
      ]);
      await waitMs(20);

      for (let i = 0; i < 5; i++) {
        h.stores.spinnerStore.getState().tick();
        await waitMs(10);
      }

      const frame = h.lastFrame() ?? '';
      expect(frame).toContain('OPT_A_UNIQUE');
      expect(frame).toContain('OPT_B_UNIQUE');
      const occA = (frame.match(/OPT_A_UNIQUE/g) ?? []).length;
      const occB = (frame.match(/OPT_B_UNIQUE/g) ?? []).length;
      expect(occA).toBe(1);
      expect(occB).toBe(1);
    } finally {
      h.unmount();
    }
  });
});
