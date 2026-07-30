// src/__tests__/tui/pipeline-adapter.test.ts
// PipelineToStoreAdapter:把语义 renderer 调用翻译成 store 操作
//
// 物理本质:验证 adapter 是"薄桥接"——不解析输出、不生成字形,
// 只把 startToolCall/finishToolCall/startAssistant 等调用转发给 store。

import { describe, it, expect } from 'vitest';
import { createMessagesStore } from '../../tui/state/messages-store.js';
import { PipelineToStoreAdapter } from '../../tui/state/pipeline-adapter.js';
import type { ToolPresentation } from '../../tui/transcript-types.js';

function globPresentation(toolUseId: string): ToolPresentation {
  return {
    toolUseId,
    toolName: 'glob',
    summary: `${toolUseId} → 1 file`,
    details: [{ kind: 'path', path: `${toolUseId}.ts` }],
    status: 'success',
  };
}

describe('PipelineToStoreAdapter (semantic)', () => {
  it('startToolCall → store.startTool(PendingTool)', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    adapter.startToolCall({ toolUseId: 'g1', name: 'glob', input: { pattern: '*.ts' } });
    expect(store.getState().model.items.some(i => i.kind === 'pending-tool')).toBe(true);
  });

  it('finishToolCall → store.resolveTool(ToolBlock)', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    adapter.startToolCall({ toolUseId: 'g1', name: 'glob', input: { pattern: '*.ts' } });
    adapter.finishToolCall('g1', globPresentation('g1'));
    adapter.closeOpenToolGroup();

    const items = store.getState().model.items;
    expect(items.some(i => i.kind === 'tool')).toBe(true);
  });

  it('appendStreamingMarkdown 首次 → startAssistant', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    adapter.appendStreamingMarkdown('hello', false, { firstLinePrefix: '● ' });
    expect(store.getState().model.items.some(i => i.kind === 'streaming-assistant')).toBe(true);
  });

  it('does not store presentation glyphs in assistant semantic text', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);

    adapter.appendStreamingMarkdown('hello', false, { firstLinePrefix: '● ' });
    adapter.appendStreamingMarkdown('hello', true, { firstLinePrefix: '● ' });

    expect(store.getState().model.items).toContainEqual({
      id: expect.any(String),
      kind: 'assistant',
      text: 'hello',
    });
  });

  it('appendStreamingMarkdown isFinal=true → finishAssistant', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    adapter.appendStreamingMarkdown('hello', false);
    adapter.appendStreamingMarkdown('hello', true);
    const items = store.getState().model.items;
    expect(items.some(i => i.kind === 'assistant')).toBe(true);
    expect(items.some(i => i.kind === 'streaming-assistant')).toBe(false);
  });

  it('sealStreaming → finishAssistant', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    adapter.appendStreamingMarkdown('hello', false);
    adapter.sealStreaming();
    expect(store.getState().model.items.some(i => i.kind === 'assistant')).toBe(true);
  });

  it('clearMessages → store.clear()', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    adapter.startToolCall({ toolUseId: 'g1', name: 'glob', input: {} });
    adapter.clearMessages();
    expect(store.getState().model.items).toEqual([]);
  });

  it('flushNow → 无操作(不崩)', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    expect(() => adapter.flushNow()).not.toThrow();
  });

  it('finishAsk → store.finishAsk(AskBlock)', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    adapter.finishAsk('q1', {
      id: 'q1', kind: 'ask',
      summary: 'Answered 1 question',
      items: ['Auth → OAuth'],
    });
    expect(store.getState().model.items.some(i => i.kind === 'ask')).toBe(true);
  });

  it('appendTranscriptBlock → store.appendTranscript', () => {
    const store = createMessagesStore();
    const adapter = new PipelineToStoreAdapter(store);
    adapter.appendTranscriptBlock({ id: 'u1', kind: 'user', text: 'hello' });
    expect(store.getState().model.items.some(i => i.kind === 'user')).toBe(true);
  });
});
