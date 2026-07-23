// src/__tests__/tui/pipeline-adapter.test.ts
// PipelineToStoreAdapter：把 PipelineRenderer 调用翻译成 messages-store 操作

import { describe, it, expect } from 'vitest';
import { createMessagesStore } from '../../tui/state/messages-store.js';
import { PipelineToStoreAdapter } from '../../tui/state/pipeline-adapter.js';

describe('PipelineToStoreAdapter', () => {
  it('printMessage → appendLine（按 role 映射）', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    adapter.printMessage('● 你好', 'system', { fg: 'brand' });
    const msgs = store.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.lines[0]!.content).toBe('● 你好');
    expect(msgs[0]!.lines[0]!.style).toMatchObject({ fg: 'brand' });
  });

  it('printMessage 连续 system 行 → 续接同一消息', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    adapter.printMessage('第一行', 'system');
    adapter.printMessage('第二行', 'system');
    const msgs = store.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.lines.length).toBe(2);
  });

  it('appendStreamingMarkdown 首次(isFinal=false) → startStreaming(prefix)', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    adapter.appendStreamingMarkdown('你', false, { firstLinePrefix: '● ' });
    const msgs = store.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.finalized).toBe(false);
    expect(msgs[0]!.streamingText).toBe('● 你');
  });

  it('appendStreamingMarkdown 多次 delta → updateStreaming 累加', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    adapter.appendStreamingMarkdown('你', false, { firstLinePrefix: '● ' });
    adapter.appendStreamingMarkdown('你好', false, { firstLinePrefix: '● ' });
    adapter.appendStreamingMarkdown('你好世界', false, { firstLinePrefix: '● ' });
    const m = store.getState().messages[0]!;
    expect(m.streamingText).toBe('● 你好世界');
    expect(m.finalized).toBe(false);
  });

  it('appendStreamingMarkdown isFinal=true → finalizeStreaming', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    adapter.appendStreamingMarkdown('你好', false, { firstLinePrefix: '● ' });
    adapter.appendStreamingMarkdown('你好', true, { firstLinePrefix: '● ' });
    const m = store.getState().messages[0]!;
    expect(m.finalized).toBe(true);
    expect(m.streamingText).toBeUndefined();
    // 固化行含格式化后的 ● 前缀
    expect(m.lines.some(l => l.content.includes('你好'))).toBe(true);
  });

  it('appendStreamingMarkdown 无 opts → 默认无前缀', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    adapter.appendStreamingMarkdown('text', false);
    const m = store.getState().messages[0]!;
    expect(m.streamingText).toBe('text');
  });

  it('sealStreaming → 固化当前流式（用 streamingText 渲染成行）', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    adapter.appendStreamingMarkdown('hello', false);
    adapter.sealStreaming();
    const m = store.getState().messages[0]!;
    expect(m.finalized).toBe(true);
    expect(m.lines.some(l => l.content.includes('hello'))).toBe(true);
  });

  it('clearMessages → store.clear()', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    adapter.printMessage('a', 'system');
    adapter.printMessage('b', 'system');
    adapter.clearMessages();
    expect(store.getState().messages).toEqual([]);
  });

  it('flushNow → 无操作（store 是响应式的，无需 flush）', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    expect(() => adapter.flushNow()).not.toThrow();
  });

  it('role 映射：assistant_text 流式 → assistant role', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    adapter.appendStreamingMarkdown('hi', false);
    expect(store.getState().messages[0]!.role).toBe('assistant');
  });

  // AUTO-0025 bug 修复:thinking_summary 必须创建独立 finalized message,
  // 不能被 mapRole 降级成 system 后经 appendLine 续接进已有的 system 空行消息。
  // 复现场景:thinking_start 时 openModelBlock() 先输出了一个 system 空行分隔符,
  // thinking_end 时 summary 进来,若走 appendLine('system') 会续接进那条空行消息,
  // 导致 summary 被埋进空白块的第 2 行,肉眼不可见。
  it('printMessage(thinking_summary) → 创建独立消息,不续接已有 system 空行', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    // 模拟真实时序:先有一条 system 空行分隔符(openModelBlock 产物)
    adapter.printMessage('', 'system');
    const gapMsg = store.getState().messages[store.getState().messages.length - 1]!;
    expect(gapMsg.lines[0]!.content).toBe(''); // 前置:确实是空行消息

    // thinking_end 的 summary 进来
    adapter.printMessage('  Thought for 1s (ctrl+o to expand)', 'thinking_summary');

    const msgs = store.getState().messages;
    // 必须创建新消息(不续接进空行消息)
    expect(msgs.length).toBe(2);
    // summary 在独立消息里(末条),不在空行消息的 lines 里
    const summaryMsg = msgs[msgs.length - 1]!;
    expect(summaryMsg.uuid).not.toBe(gapMsg.uuid);
    expect(summaryMsg.lines.some(l => l.content.includes('Thought for 1s'))).toBe(true);
    // 空行消息保持原样,不被污染
    expect(gapMsg.lines.length).toBe(1);
    expect(gapMsg.lines[0]!.content).toBe('');
  });

  it('printMessage(thinking_summary) 连续两条 summary → 各自独立消息', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    adapter.printMessage('  Thought for 1s', 'thinking_summary');
    adapter.printMessage('  Thought for 2s', 'thinking_summary');
    const msgs = store.getState().messages;
    // 每条 summary 都是独立消息,不互相续接
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.lines[0]!.content).toContain('Thought for 1s');
    expect(msgs[1]!.lines[0]!.content).toContain('Thought for 2s');
  });
});
