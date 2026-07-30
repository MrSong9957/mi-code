// thinking 协议生命周期状态机测试 (语义版)
//
// 验证 BlockPipeline 的 thinking 两态状态机(idle ↔ active):
// - thinking_start → startThinking('Thinking…'),重复幂等
// - thinking_delta 只在 active 态累积 buffer(供 Ctrl+O),不触发额外调用
// - thinking_end → eraseThinking + finishThinking(SystemBlock thinking-summary)
//
// 测试用 recording mock renderer 断言语义调用,不再断言 printMessage 字符串。

import { describe, it, expect } from 'vitest';
import { BlockPipeline, type PipelineRenderer } from '../../ui/block-pipeline.js';
import type { ToolPresentation } from '../../tui/transcript-types.js';
import type { ThinkingSummaryBlock, BoundaryBlock } from '../../tui/state/transcript-reducer.js';

/** recording mock renderer:捕获所有语义调用。 */
function createMockRenderer(): PipelineRenderer & { calls: string[] } {
  const calls: string[] = [];
  const renderer: PipelineRenderer = {
    startToolCall(call) {
      calls.push(`startToolCall(${call.toolUseId}, ${call.name})`);
    },
    finishToolCall(toolUseId, presentation: ToolPresentation) {
      calls.push(`finishToolCall(${toolUseId}, ${presentation.summary.slice(0, 30)})`);
      return true;
    },
    appendStreamingMarkdown(text, isFinal) {
      calls.push(`appendStreamingMarkdown(${JSON.stringify(text.slice(0, 30))}, final=${isFinal})`);
    },
    sealStreaming() { calls.push('sealStreaming'); },
    startThinking(text) {
      calls.push(`startThinking(${JSON.stringify(text.slice(0, 30))})`);
      return `th-${calls.length}`;
    },
    updateThinking(_text) {
      calls.push('updateThinking');
    },
    eraseThinking() {
      calls.push('eraseThinking');
    },
    finishThinking(summary: ThinkingSummaryBlock) {
      calls.push(`finishThinking(${summary.text})`);
    },
    appendTranscriptBlock(block: BoundaryBlock) {
      const text = 'text' in block ? String(block.text ?? block.kind).slice(0, 50) : block.kind;
      calls.push(`appendTranscriptBlock(${block.kind}, ${JSON.stringify(text)})`);
    },
    flushNow() { calls.push('flushNow'); },
    clearMessages() { calls.push('clearMessages'); },
  };
  return Object.assign(renderer, { calls });
}

describe('BlockPipeline thinking 状态机 (semantic)', () => {
  // ── 边界 1: start → end(无 delta)── 生产回归 ──

  it('start → end:显示闪烁行,生成摘要,擦除临时行', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    expect(renderer.calls.filter(c => c.startsWith('startThinking'))).toHaveLength(1);

    pipeline.emit({ kind: 'thinking_end', durationSec: 2, filesRead: 0 });
    expect(renderer.calls.some(c => c.includes('Thought for 2s'))).toBe(true);
    expect(renderer.calls.some(c => c === 'eraseThinking')).toBe(true);
  });

  it('start→end 无 delta 的 Ctrl+O 详情显示 placeholder', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });

    const expandable = pipeline.getLastExpandableFullLines();
    expect(expandable).not.toBeNull();
    const fullText = expandable!.lines.map(l => l.content).join('\n');
    expect(fullText).toContain('No thinking content received');
    expect(fullText).not.toContain('Thought for');
  });

  // ── 边界 2: start → delta(非空) → end ──

  it('start→delta(非空)→end:闪烁行 + 摘要 + Ctrl+O 含真实内容', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    expect(renderer.calls.filter(c => c.startsWith('startThinking'))).toHaveLength(1);
    renderer.calls.length = 0;

    pipeline.emit({ kind: 'thinking_delta', content: '真实推理内容' });
    // delta 不触发额外显示
    expect(renderer.calls.filter(c => c.startsWith('startThinking'))).toHaveLength(0);

    pipeline.emit({ kind: 'thinking_end', durationSec: 3, filesRead: 0 });
    expect(renderer.calls.some(c => c.includes('Thought for 3s'))).toBe(true);
    const expandable = pipeline.getLastExpandableFullLines();
    expect(expandable!.lines.map(l => l.content).join('\n')).toContain('真实推理内容');
  });

  // ── 边界 3: start → delta(纯空白) → end ──

  it('纯白 delta → placeholder', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '  \n\t' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });

    const expandable = pipeline.getLastExpandableFullLines();
    expect(expandable).not.toBeNull();
    expect(expandable!.lines.map(l => l.content).join('\n')).toContain('No thinking content received');
  });

  // ── 边界 4: 重复 start ── 幂等 ──

  it('start→start→end:第二次 start 无副作用', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_start' });
    expect(renderer.calls.filter(c => c.startsWith('startThinking'))).toHaveLength(1);

    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
    expect(renderer.calls.filter(c => c.includes('Thought for')).length).toBe(1);
  });

  // ── 边界 5: start → delta(A) → start → delta(B) → end ── buffer 保留 ──

  it('start→delta(A)→start→delta(B)→end:buffer 保留 A+B', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: 'A' });
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: 'B' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 5, filesRead: 0 });

    expect(renderer.calls.filter(c => c.startsWith('startThinking'))).toHaveLength(1);
    const expandable = pipeline.getLastExpandableFullLines();
    const fullText = expandable!.lines.map(l => l.content).join('\n');
    expect(fullText).toContain('A');
    expect(fullText).toContain('B');
  });

  // ── 边界 6: 无 start 的 end ── 完全无害 ──

  it('end without start:完全无害', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
    expect(renderer.calls.some(c => c.includes('Thought for'))).toBe(false);
    expect(renderer.calls.some(c => c === 'eraseThinking')).toBe(false);
    expect(pipeline.getLastExpandableFullLines()).toBeNull();
  });

  // ── 边界 7: 无 start 的 delta ── 完全忽略 ──

  it('ignores thinking_delta while idle', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_delta', content: 'orphan content' });
    expect(renderer.calls.some(c => c.startsWith('startThinking'))).toBe(false);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
    const expandable = pipeline.getLastExpandableFullLines();
    const fullText = expandable!.lines.map(l => l.content).join('\n');
    expect(fullText).not.toContain('orphan content');
    expect(fullText).toContain('No thinking content received');
  });

  // ── 边界 8: end → end ── 均无害 ──

  it('end→end:均无害', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
    expect(renderer.calls.some(c => c.includes('Thought for'))).toBe(false);
  });

  // ── 边界 9: start → end → end ── 只一次摘要 ──

  it('start→end→end:只生成一次摘要', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 2, filesRead: 0 });
    renderer.calls.length = 0;
    pipeline.emit({ kind: 'thinking_end', durationSec: 2, filesRead: 0 });

    expect(renderer.calls.some(c => c.includes('Thought for'))).toBe(false);
    expect(renderer.calls.some(c => c === 'eraseThinking')).toBe(false);
  });

  // ── 边界 10: start → clear ── 回 idle ──

  it('start→clear:回 idle,后续 end 不产摘要', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.clear();
    renderer.calls.length = 0;
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
    expect(renderer.calls.some(c => c.includes('Thought for'))).toBe(false);
  });

  // ── 边界 11: start → clearTurnState ── 擦除临时行 ──

  it('start→clearTurnState:擦除临时行,回 idle', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.clearTurnState();
    expect(renderer.calls.some(c => c === 'eraseThinking')).toBe(true);
    renderer.calls.length = 0;
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
    expect(renderer.calls.some(c => c.includes('Thought for'))).toBe(false);
  });

  // ── 边界 12: start → end → start → end ── 两个独立摘要 ──

  it('start→end→start→end:两个独立摘要,buffer 不串联', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '第一个' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '第二个' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 2, filesRead: 0 });

    expect(renderer.calls.filter(c => c.includes('Thought for')).length).toBe(2);
    expect(renderer.calls.filter(c => c.startsWith('startThinking'))).toHaveLength(2);
    const expandable = pipeline.getLastExpandableFullLines();
    const fullText = expandable!.lines.map(l => l.content).join('\n');
    expect(fullText).toContain('第二个');
    expect(fullText).not.toContain('第一个');
  });

  // ── 摘要作为独立 system 块 ──

  it('thinking_end 摘要通过 finishThinking 投递(非 assistant)', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: 'x' });
    renderer.calls.length = 0;
    pipeline.emit({ kind: 'thinking_end', durationSec: 3, filesRead: 0 });

    const finishCall = renderer.calls.find(c => c.startsWith('finishThinking'));
    expect(finishCall).toBeDefined();
    expect(finishCall).toContain('Thought for 3s');
    // 不经过 appendStreamingMarkdown(那是 assistant 专属)
    expect(renderer.calls.some(c => c.startsWith('appendStreamingMarkdown'))).toBe(false);
  });
});
