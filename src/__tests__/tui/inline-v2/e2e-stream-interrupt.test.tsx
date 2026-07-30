// src/__tests__/tui/inline-v2/e2e-stream-interrupt.test.tsx
//
// V2 inline 模式 E2E 流式中断场景(plan Task 5a.5)。
//
// 覆盖:
// - 流式中按 ESC → onAbortStream 触发 → 调 finalizeStreamingAsInterrupted
//   半成品进 <Static>,标记 interrupted:true
// - 双击 ESC → onRewindLastTurn 触发
//
// 注:本测试面向新的语义 store API(startAssistant + finalizeStreamingAsInterrupted),
// 不再使用旧 startStreaming。断言改为读 model.items 的 assistant 块(interrupted 标记),
// 不再断言旧 messages 投影的 lines/streamingText。

import { describe, it, expect } from 'vitest';
import { createE2EHarness, KEYS, waitMs } from './helpers/e2e-harness.js';

describe('V2 inline E2E - 流式中断', () => {
  it('场景 4:流式中按 ESC → 触发 onAbortStream', async () => {
    let abortCount = 0;
    const h = createE2EHarness({
      onAbortStream: () => {
        abortCount++;
        // 模拟 agent loop 的中断响应:固化半成品为 interrupted
        h.stores.messagesStore.getState().finalizeStreamingAsInterrupted();
        h.stores.spinnerStore.getState().stop();
      },
    });
    try {
      // 开流式
      h.stores.messagesStore.getState().startAssistant('partial answer\n');
      h.stores.spinnerStore.getState().start('responding');
      await waitMs(30);

      // 流式中,frame 应有 partial answer
      expect(h.lastFrame() ?? '').toContain('partial answer');

      // 按 ESC
      h.stdin.write(KEYS.ESC);
      await waitMs(30);

      // onAbortStream 被调用 1 次
      expect(abortCount).toBe(1);
      // spinner 停了
      expect(h.stores.spinnerStore.getState().active).toBe(false);

      // 末项已固化为 assistant 块,带 interrupted 标记
      const items = h.stores.messagesStore.getState().model.items;
      const last = items[items.length - 1]!;
      expect(last.kind).toBe('assistant');
      if (last.kind !== 'assistant') throw new Error('unreachable');
      expect(last.interrupted).toBe(true);
      // 半成品作为已固化消息保留(进入 <Static>):
      //   - 流式时的草稿文本 'partial answer' 现在作为 assistant 块 text 仍在
      //   - interrupted:true 标记该消息被中断
      expect(last.text).toContain('partial answer');
      // 无残留 streaming-assistant 活动项
      const stillStreaming = items.some((i) => i.kind === 'streaming-assistant');
      expect(stillStreaming).toBe(false);

      const frame = h.lastFrame() ?? '';
      expect(frame).toContain('partial answer');
    } finally {
      h.unmount();
    }
  });

  it('流式未运行时按 ESC → 不触发 onAbortStream', async () => {
    let abortCount = 0;
    const h = createE2EHarness({
      onAbortStream: () => { abortCount++; },
    });
    try {
      // spinner 未 active
      expect(h.stores.spinnerStore.getState().active).toBe(false);

      h.stdin.write(KEYS.ESC);
      await waitMs(20);

      // 没有流式运行 → 不该触发 abort
      expect(abortCount).toBe(0);
    } finally {
      h.unmount();
    }
  });

  it('场景:双击 ESC → 触发 onRewindLastTurn', async () => {
    let rewindCount = 0;
    const h = createE2EHarness({
      onRewindLastTurn: () => { rewindCount++; },
    });
    try {
      // 第一次 ESC(spinner 未 active → 不 abort,但记时间戳)
      h.stdin.write(KEYS.ESC);
      await waitMs(50);
      // 第二次 ESC 在窗口内(400ms)→ 触发 rewind
      h.stdin.write(KEYS.ESC);
      await waitMs(30);

      expect(rewindCount).toBe(1);
    } finally {
      h.unmount();
    }
  });

  it('场景:双击 ESC 超时窗口 → 第二次当首次处理(不 rewind)', async () => {
    let rewindCount = 0;
    const h = createE2EHarness({
      onRewindLastTurn: () => { rewindCount++; },
    });
    try {
      h.stdin.write(KEYS.ESC);
      await waitMs(500);  // 超过 400ms 窗口
      h.stdin.write(KEYS.ESC);
      await waitMs(30);

      // 超出窗口 → 第二次当首次处理,不 rewind
      expect(rewindCount).toBe(0);
    } finally {
      h.unmount();
    }
  });

  it('场景:Ctrl+C → 触发 onExit', async () => {
    let exitCount = 0;
    const h = createE2EHarness({
      onExit: () => { exitCount++; },
    });
    try {
      h.stdin.write(KEYS.CTRL_C);
      await waitMs(20);
      expect(exitCount).toBe(1);
    } finally {
      h.unmount();
    }
  });

  it('场景:Select visible 时按 ESC → 关闭 Select(不触发 abort)', async () => {
    let abortCount = 0;
    const h = createE2EHarness({
      onAbortStream: () => { abortCount++; },
    });
    try {
      h.stores.selectStore.getState().open('Pick', [{ value: 'a', label: 'A' }]);
      // 即使 spinner active,Select visible 时 ESC 应优先关闭 Select
      h.stores.spinnerStore.getState().start('responding');
      await waitMs(20);

      h.stdin.write(KEYS.ESC);
      await waitMs(20);

      // Select 关闭
      expect(h.stores.selectStore.getState().visible).toBe(false);
      // 不触发 abort(Select 的 ESC 优先)
      expect(abortCount).toBe(0);
      // spinner 仍在
      expect(h.stores.spinnerStore.getState().active).toBe(true);
    } finally {
      h.unmount();
    }
  });
});
