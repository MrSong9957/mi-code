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
});
