// thinking_end → assistant 间距回归测试
//
// 已反复出现过的错误：Thought for 与下一条 assistant 消息之间没有空行间隔。
// 本测试从数据层 + 渲染层双重验证间距不会退化。

import { describe, it, expect } from 'vitest';
import { BlockPipeline } from '../../ui/block-pipeline.js';
import { PipelineToStoreAdapter } from '../../tui/state/pipeline-adapter.js';
import { createMessagesStore } from '../../tui/state/messages-store.js';
import { renderFinalizedLine } from './text-layout.js';

/** 构造完整流程的 store（user → thinking → assistant），返回 messages */
function setupFullConversation() {
  const store = createMessagesStore();
  const adapter = new PipelineToStoreAdapter(store);
  const pipeline = new BlockPipeline(adapter);
  pipeline.emit({ kind: 'user_input', text: '你是谁？' });
  pipeline.emit({ kind: 'thinking_start' });
  pipeline.emit({ kind: 'thinking_delta', content: '思考' });
  pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
  pipeline.emit({ kind: 'assistant_text', text: '你好！', isFinal: true });
  return store.getState().messages;
}

describe('thinking_end → assistant 间距数据契约', () => {
  it('完整流程后，Thought for 与 assistant 之间在数据上有 gap 空行', () => {
    const msgs = setupFullConversation();
    // 展开所有消息的所有行
    const allLines = msgs.flatMap(m => m.lines.map(l => ({ role: m.role, content: l.content })));

    const thoughtIdx = allLines.findIndex(l => l.content.includes('Thought for'));
    const assistantIdx = allLines.findIndex(l =>
      l.content.startsWith('●') && !l.content.includes('Thinking') && !l.content.includes('thought')
    );

    expect(thoughtIdx).toBeGreaterThanOrEqual(0);
    expect(assistantIdx).toBeGreaterThan(thoughtIdx);

    // 关键：Thought for 和 assistant 之间至少有一个空行
    const between = allLines.slice(thoughtIdx + 1, assistantIdx);
    const hasGap = between.some(l => l.content === '');
    expect(hasGap).toBe(true);
  });
});

describe('renderFinalizedLine 不吞空行', () => {
  it('content="" 的 system 行渲染为 [""]（appendLine 会补 \\n 形成视觉空行）', () => {
    const result = renderFinalizedLine('system', { content: '', style: {}, indent: 0 }, 80);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('');
  });

  it('content="" 的 assistant 行也渲染为 [""]（不被 highlightLine 吞掉）', () => {
    const result = renderFinalizedLine('assistant', { content: '', style: {}, indent: 0 }, 80);
    expect(result).toHaveLength(1);
  });
});
