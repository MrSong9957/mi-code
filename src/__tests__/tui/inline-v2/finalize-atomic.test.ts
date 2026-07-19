// src/__tests__/tui/inline-v2/finalize-atomic.test.ts
//
// finalizeStreaming / finalizeStreamingAsInterrupted 原子性防回归测试
// (Stage 4 Task 4.3)。
//
// 物理本质:V2 路径下,finalize 必须在**单个 set()** 内完成三件事:
//   1. 标记 finalized=true
//   2. 清空 streamingText
//   3. 写入 lines
//
// 原子性的意义:V2 用 zustand subscribe → Ink reconciler,subscribe 触发次数 = set 次数。
// 如果这三件事分多次 set(先 finalize 后清 streamingText 后写 lines),subscribe 触发多次,
// 每次都可能触发 React 重渲染 → Ink createIncremental 多帧 diff,
// 中间帧可能看到"finalized=true 但 lines 还空"或"lines 已写但 streamingText 还在"的
// 短暂不一致状态——这正是原始 bug "累积重复帧" 的根因之一。
//
// 单次 set 保证 subscribe 只触发 1 次,Ink 一次 diff 出最终状态,无中间帧。

import { describe, it, expect } from 'vitest';
import { createMessagesStore } from '../../../tui/state/messages-store.js';

describe('messagesStore.finalizeStreaming 原子性', () => {
  it('finalizeStreaming 在单个 set() 内完成(只触发 1 次 subscribe)', () => {
    const store = createMessagesStore();
    store.getState().startStreaming('partial text');

    let subscribeCount = 0;
    const unsubscribe = store.subscribe(() => { subscribeCount++; });

    store.getState().finalizeStreaming([{ content: 'final line', style: {}, indent: 0 }]);
    unsubscribe();

    // 原子性:1 次 set → 1 次 subscribe
    expect(subscribeCount).toBe(1);

    // 三件事都完成
    const last = store.getState().messages[store.getState().messages.length - 1]!;
    expect(last.finalized).toBe(true);
    expect(last.streamingText).toBeUndefined();
    expect(last.lines).toEqual([{ content: 'final line', style: {}, indent: 0 }]);
  });

  it('finalizeStreamingAsInterrupted 也是原子的(只触发 1 次 subscribe)', () => {
    const store = createMessagesStore();
    store.getState().startStreaming('interrupted text');

    let subscribeCount = 0;
    const unsubscribe = store.subscribe(() => { subscribeCount++; });

    store.getState().finalizeStreamingAsInterrupted();
    unsubscribe();

    expect(subscribeCount).toBe(1);

    const last = store.getState().messages[store.getState().messages.length - 1]!;
    expect(last.finalized).toBe(true);
    expect(last.streamingText).toBeUndefined();
    // 中断固化会追加 [interrupted] 标记
    expect(last.lines.some((l) => l.content.includes('interrupted'))).toBe(true);
  });

  it('startStreaming → updateStreaming → finalizeStreaming 完整流程', () => {
    // 端到端验证:流式 token 到达(多次 set)→ finalize(单次 set)→ 终态正确。
    const store = createMessagesStore();

    store.getState().startStreaming('');
    store.getState().updateStreaming('hello\n');
    store.getState().updateStreaming('hello\nworld\n');
    // 此时流式中,streamingText 累积了全文
    const streamingMsg = store.getState().messages[0]!;
    expect(streamingMsg.finalized).toBe(false);
    expect(streamingMsg.streamingText).toBe('hello\nworld\n');

    // finalize:把 BlockPipeline 的 FormattedLine 数组固化进去
    store.getState().finalizeStreaming([
      { content: 'hello', style: {}, indent: 0 },
      { content: 'world', style: {}, indent: 0 },
    ]);

    const finalMsg = store.getState().messages[0]!;
    expect(finalMsg.finalized).toBe(true);
    expect(finalMsg.streamingText).toBeUndefined();
    expect(finalMsg.lines).toHaveLength(2);
    expect(finalMsg.lines[0]!.content).toBe('hello');
    expect(finalMsg.lines[1]!.content).toBe('world');
  });

  it('finalizeStreaming 幂等性:无流式消息时当作普通 append', () => {
    // 边界场景:没有正在流式的消息就调用 finalize(例如 LLM 直接返回完整内容)
    const store = createMessagesStore();

    let subscribeCount = 0;
    const unsubscribe = store.subscribe(() => { subscribeCount++; });

    store.getState().finalizeStreaming([
      { content: 'direct content', style: {}, indent: 0 },
    ]);
    unsubscribe();

    expect(subscribeCount).toBe(1);
    const msg = store.getState().messages[0]!;
    expect(msg.finalized).toBe(true);
    expect(msg.role).toBe('assistant');
    expect(msg.lines[0]!.content).toBe('direct content');
  });
});
