// src/__tests__/tui/inline-v2/finalize-atomic.test.ts
//
// finishAssistant / finalizeStreamingAsInterrupted 原子性防回归测试
// (Stage 4 Task 4.3)。
//
// 物理本质:V2 路径下,固化流式必须在**单个 set()** 内完成:
//   把 streaming-assistant 活动项就地替换为 assistant 已固化块。
//
// 原子性的意义:V2 用 zustand subscribe → Ink reconciler,subscribe 触发次数 = set 次数。
// 如果固化分多次 set(先改 text 再换 kind),subscribe 触发多次,
// 每次都可能触发 React 重渲染 → Ink createIncremental 多帧 diff,
// 中间帧可能看到"kind 已换但 text 还旧"的短暂不一致状态——这正是原始 bug
// "累积重复帧" 的根因之一。
//
// 单次 set 保证 subscribe 只触发 1 次,Ink 一次 diff 出最终状态,无中间帧。
//
// 注:本测试面向新的语义 store API(model: { items: TimelineItem[] }),
// 不再断言旧 messages/streamingText 投影。

import { describe, it, expect } from 'vitest';
import { createMessagesStore } from '../../../tui/state/messages-store.js';
import type { ActivityItem, AssistantBlock } from '../../../tui/transcript-types.js';

/**
 * updateStreaming 的语义等价:直接改 streaming-assistant 活动项的 text。
 * 生产代码用 startAssistant 后通过 store.setState 累积流式 token。
 */
function updateStreamingText(
  store: ReturnType<typeof createMessagesStore>,
  newText: string,
): void {
  store.setState((s) => {
    const items = [...s.model.items];
    const idx = items.findIndex((i) => i.kind === 'streaming-assistant');
    if (idx < 0) return s;
    const sa = items[idx];
    if (sa!.kind !== 'streaming-assistant') return s;
    items[idx] = { ...(sa as ActivityItem & { kind: 'streaming-assistant' }), text: newText };
    return { model: { ...s.model, items } };
  });
}

/** 读取唯一的 streaming-assistant 活动项(断言其存在)。 */
function getStreamingAssistant(store: ReturnType<typeof createMessagesStore>) {
  const sa = store.getState().model.items.find((i) => i.kind === 'streaming-assistant');
  if (!sa || sa.kind !== 'streaming-assistant') {
    throw new Error('expected a streaming-assistant activity item');
  }
  return sa;
}

/** 读取末条 assistant 已固化块。 */
function getLastAssistantBlock(store: ReturnType<typeof createMessagesStore>): AssistantBlock {
  const items = store.getState().model.items;
  const last = items[items.length - 1];
  if (!last || last.kind !== 'assistant') {
    throw new Error(`expected last item to be an assistant block, got ${JSON.stringify(last)}`);
  }
  return last;
}

describe('messagesStore.finishAssistant 原子性', () => {
  it('finishAssistant 在单个 set() 内完成(只触发 1 次 subscribe)', () => {
    const store = createMessagesStore();
    store.getState().startAssistant('partial text');

    let subscribeCount = 0;
    const unsubscribe = store.subscribe(() => { subscribeCount++; });

    store.getState().finishAssistant();
    unsubscribe();

    // 原子性:1 次 set → 1 次 subscribe
    expect(subscribeCount).toBe(1);

    // streaming-assistant 就地固化为 assistant 块,文本保留
    const last = getLastAssistantBlock(store);
    expect(last.kind).toBe('assistant');
    expect(last.text).toBe('partial text');
    expect(last.interrupted).toBeUndefined();

    // 无残留 streaming-assistant 活动项
    const stillStreaming = store.getState().model.items.some((i) => i.kind === 'streaming-assistant');
    expect(stillStreaming).toBe(false);
  });

  it('finalizeStreamingAsInterrupted 也是原子的(只触发 1 次 subscribe)', () => {
    const store = createMessagesStore();
    store.getState().startAssistant('interrupted text');

    let subscribeCount = 0;
    const unsubscribe = store.subscribe(() => { subscribeCount++; });

    store.getState().finalizeStreamingAsInterrupted();
    unsubscribe();

    expect(subscribeCount).toBe(1);

    const last = getLastAssistantBlock(store);
    expect(last.kind).toBe('assistant');
    // 中断固化:文本保留 + interrupted 标记
    expect(last.text).toBe('interrupted text');
    expect(last.interrupted).toBe(true);
  });

  it('startAssistant → updateStreamingText → finishAssistant 完整流程', () => {
    // 端到端验证:流式 token 到达(多次 set)→ finish(单次 set)→ 终态正确。
    const store = createMessagesStore();

    store.getState().startAssistant('');
    updateStreamingText(store, 'hello\n');
    updateStreamingText(store, 'hello\nworld\n');

    // 此时流式中,streaming-assistant 累积了全文
    const sa = getStreamingAssistant(store);
    expect(sa.kind).toBe('streaming-assistant');
    expect(sa.text).toBe('hello\nworld\n');

    // finish:把 streaming-assistant 固化为 assistant 块(文本原样保留)
    store.getState().finishAssistant();

    const finalBlock = getLastAssistantBlock(store);
    expect(finalBlock.kind).toBe('assistant');
    expect(finalBlock.text).toBe('hello\nworld\n');
    // 流式活动项已被消费
    const stillStreaming = store.getState().model.items.some((i) => i.kind === 'streaming-assistant');
    expect(stillStreaming).toBe(false);
  });

  it('finishAssistant 空操作:无 streaming-assistant 时不修改 items', () => {
    // 边界场景:没有正在流式的消息就调用 finish(例如 LLM 直接返回完整内容)。
    // finishAssistant 在 idx < 0 时返回原 model(reducer 短路),不新增/不修改 items。
    // (set 包装器仍会重新投影 messages 数组,故 subscribe 仍触发 1 次——
    //  这是过渡兼容层的行为,本测试只验证语义不变量:items 内容不变。)
    const store = createMessagesStore();

    const before = store.getState().model.items;

    let subscribeCount = 0;
    const unsubscribe = store.subscribe(() => { subscribeCount++; });

    store.getState().finishAssistant();
    unsubscribe();

    // 仍触发 1 次(set 包装器总是新建顶层对象),但 items 数组引用未变
    expect(subscribeCount).toBe(1);

    const after = store.getState().model.items;
    expect(after).toBe(before);            // 引用相等:reducer 短路返回原 model
    expect(after).toHaveLength(0);          // 无任何内容被追加
  });
});
