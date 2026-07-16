// src/__tests__/tui/pipeline-integration.test.ts
// 端到端：BlockPipeline + PipelineToStoreAdapter + messages-store
//
// 物理本质：整条数据流的「联调验收」。
// 真实 BlockPipeline（不经 mock）emit 各种 Block，PipelineToStoreAdapter 实现 PipelineRenderer
// 接口把数据推进 store。验证 store 最终状态符合预期——这是 Phase 4 的交付证据。

import { describe, it, expect } from 'vitest';
import { BlockPipeline } from '../../ui/block-pipeline.js';
import { createMessagesStore } from '../../tui/state/messages-store.js';
import { PipelineToStoreAdapter } from '../../tui/state/pipeline-adapter.js';

function setup(): { pipeline: BlockPipeline; store: ReturnType<typeof createMessagesStore> } {
  const store = createMessagesStore();
  const adapter = new PipelineToStoreAdapter(store);
  const pipeline = new BlockPipeline(adapter);
  return { pipeline, store };
}

describe('BlockPipeline → store 端到端', () => {
  it('user_input → store 末条 user 消息含 ❯ 前缀', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'user_input', text: '你好' });
    const msgs = store.getState().messages;
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    const last = msgs[msgs.length - 1]!;
    expect(last.role).toBe('user');
    expect(last.lines.some(l => l.content.includes('❯') && l.content.includes('你好'))).toBe(true);
  });

  it('thinking_start + thinking_end → store 含 thought for 摘要（不再有 ● Thinking… 占位行）', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '思考内容' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 5, filesRead: 2 });
    const allLines = store.getState().messages.flatMap(m => m.lines.map(l => l.content));
    // thinking_start 不再 print 占位行（对标 Claude Code：thinking 在 spinner 行显示）
    expect(allLines.some(t => t.includes('Thinking'))).toBe(false);
    expect(allLines.some(t => t.includes('thought for 5s'))).toBe(true);
  });

  it('assistant_text 流式 → store 末条 assistant streamingText 累加，isFinal 固化', () => {
    const { pipeline, store } = setup();
    // 先建一个前置块（让 assistant 不被当作首块强制加空行逻辑干扰）
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });

    pipeline.emit({ kind: 'assistant_text', text: '你', isFinal: false });
    pipeline.emit({ kind: 'assistant_text', text: '你好', isFinal: false });
    pipeline.emit({ kind: 'assistant_text', text: '你好世界', isFinal: false });

    // 流式中：末条 assistant finalized=false，streamingText 累加
    const streaming = store.getState().messages.filter(m => m.role === 'assistant' && !m.finalized);
    expect(streaming.length).toBe(1);
    expect(streaming[0]!.streamingText).toContain('你好世界');

    // 固化
    pipeline.emit({ kind: 'assistant_text', text: '你好世界', isFinal: true });
    const finalized = store.getState().messages.filter(m => m.role === 'assistant' && m.finalized);
    expect(finalized.length).toBeGreaterThanOrEqual(1);
    const last = finalized[finalized.length - 1]!;
    expect(last.lines.some(l => l.content.includes('你好世界'))).toBe(true);
    expect(last.streamingText).toBeUndefined();
  });

  it('tool_call + tool_result 配对 → store 含 ● 工具名 和 ⎿ 结果', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' }, toolUseId: 't1' });
    pipeline.emit({ kind: 'tool_result', name: 'run_bash', output: 'file1\nfile2', toolUseId: 't1' });
    const allLines = store.getState().messages.flatMap(m => m.lines.map(l => l.content));
    expect(allLines.some(t => t.includes('●') && t.includes('Bash(ls)'))).toBe(true);
    expect(allLines.some(t => t.includes('⎿') && (t.includes('file1') || t.includes('file2')))).toBe(true);
  });

  it('hook 紧跟 tool_result → store 含 hook 文本', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'x.ts' }, toolUseId: 'h1' });
    pipeline.emit({ kind: 'tool_result', name: 'read_file', output: 'X', toolUseId: 'h1' });
    pipeline.emit({ kind: 'hook', text: '[Hook] read_file done' });
    const allLines = store.getState().messages.flatMap(m => m.lines.map(l => l.content));
    expect(allLines.some(t => t.includes('[Hook] read_file done'))).toBe(true);
  });

  it('clear → store 清空', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'user_input', text: 'hi' });
    expect(store.getState().messages.length).toBeGreaterThan(0);
    pipeline.clear();
    expect(store.getState().messages).toEqual([]);
  });
});
