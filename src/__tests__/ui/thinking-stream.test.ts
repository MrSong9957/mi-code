// thinking 协议生命周期状态机测试 (AUTO-0025-transient 修正版)
//
// 验证 BlockPipeline 的 thinking 两态状态机(idle ↔ active):
// - thinking_start 是 thinking block 生命周期开始的权威协议事件,立即显示闪烁行
// - thinking_delta 只在 active 态累积 buffer(供 Ctrl+O),idle 时完全忽略
// - thinking_end 生成摘要 + 可展开详情,空 buffer 用明确 placeholder
//
// 测试按审查边界矩阵覆盖 12 条契约。

import { describe, it, expect } from 'vitest';
import { BlockPipeline, type PipelineRenderer } from '../../ui/block-pipeline.js';

/** mock renderer:捕获所有调用顺序,验证 pipeline 行为。 */
function createMockRenderer(): PipelineRenderer & { calls: string[] } {
  const calls: string[] = [];
  const renderer: PipelineRenderer = {
    printMessage(text, role?, _style?, _raw?) {
      calls.push(`printMessage(${JSON.stringify(text.slice(0, 50))}, ${role ?? '?'})`);
    },
    appendStreamingMarkdown(text, isFinal, _opts?) {
      calls.push(`appendStreamingMarkdown(${JSON.stringify(text.slice(0, 30))}, final=${isFinal})`);
    },
    appendStreamingThinking(text) {
      calls.push(`appendStreamingThinking(${JSON.stringify(text.slice(0, 30))})`);
    },
    eraseStreamingThinking() {
      calls.push('eraseStreamingThinking');
    },
    sealStreaming() { calls.push('sealStreaming'); },
    flushNow() { calls.push('flushNow'); },
    clearMessages() { calls.push('clearMessages'); },
  };
  return Object.assign(renderer, { calls });
}

describe('BlockPipeline thinking 状态机 (AUTO-0025-transient 修正)', () => {
  // ── 边界 1: start → end(无 delta)── 生产回归 ──

  it('shows and finalizes thinking when start is followed directly by end', () => {
    // Regression: providers may emit empty thinking deltas,
    // which index.ts filters before they reach BlockPipeline.
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    // start 立即显示闪烁行
    expect(renderer.calls.filter(c => c.startsWith('appendStreamingThinking'))).toHaveLength(1);

    pipeline.emit({ kind: 'thinking_end', durationSec: 2, filesRead: 0 });
    // end 生成摘要(大写 Thought)
    expect(renderer.calls.some(c => c.includes('Thought for 2s'))).toBe(true);
    // end 擦除临时行
    expect(renderer.calls.some(c => c === 'eraseStreamingThinking')).toBe(true);
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
    // placeholder 不取代摘要行(摘要行在 printMessage,不在 expandable full)
    expect(fullText).not.toContain('Thought for');
  });

  // ── 边界 2: start → delta(非空) → end ──

  it('start→delta(非空)→end:闪烁行 + 摘要 + Ctrl+O 含真实内容', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    expect(renderer.calls.filter(c => c.startsWith('appendStreamingThinking'))).toHaveLength(1);
    renderer.calls.length = 0;

    pipeline.emit({ kind: 'thinking_delta', content: '真实推理内容' });
    // delta 不再触发额外显示(只累积)
    expect(renderer.calls.filter(c => c.startsWith('appendStreamingThinking'))).toHaveLength(0);

    pipeline.emit({ kind: 'thinking_end', durationSec: 3, filesRead: 0 });
    expect(renderer.calls.some(c => c.includes('Thought for 3s'))).toBe(true);
    const expandable = pipeline.getLastExpandableFullLines();
    expect(expandable!.lines.map(l => l.content).join('\n')).toContain('真实推理内容');
  });

  // ── 边界 3: start → delta(纯空白) → end ──

  it('uses the unavailable-content detail for whitespace-only thinking', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '  \n\t' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });

    const expandable = pipeline.getLastExpandableFullLines();
    expect(expandable).not.toBeNull();
    const fullText = expandable!.lines.map(l => l.content).join('\n');
    // 纯白 delta trim 后为空 → placeholder
    expect(fullText).toContain('No thinking content received');
  });

  // ── 边界 4: 重复 start(start → start → end)── 幂等 ──

  it('start→start→end:第二次 start 完全无副作用', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_start' }); // 重复
    // 只一次 appendStreamingThinking
    expect(renderer.calls.filter(c => c.startsWith('appendStreamingThinking'))).toHaveLength(1);
    // 只一次 openModelBlock 引起的空行(printMessage('', 'system'))
    const gapCount = renderer.calls.filter(c => c.startsWith('printMessage("",')).length;
    expect(gapCount).toBe(1);

    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
    // 只一个摘要
    expect(renderer.calls.filter(c => c.includes('Thought for')).length).toBe(1);
  });

  // ── 边界 5: start → delta("A") → start → delta("B") → end ── 关键:buffer 保留 ──

  it('start→delta(A)→start→delta(B)→end:buffer 保留 A+B,计时不重置', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: 'A' });
    pipeline.emit({ kind: 'thinking_start' }); // 重复 start:不清空 buffer
    pipeline.emit({ kind: 'thinking_delta', content: 'B' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 5, filesRead: 0 });

    // 只一次 appendStreamingThinking
    expect(renderer.calls.filter(c => c.startsWith('appendStreamingThinking'))).toHaveLength(1);
    // Ctrl+O 详情同时含 A 和 B(buffer 保留)
    const expandable = pipeline.getLastExpandableFullLines();
    const fullText = expandable!.lines.map(l => l.content).join('\n');
    expect(fullText).toContain('A');
    expect(fullText).toContain('B');
  });

  // ── 边界 6: 无 start 的 end ── 完全无害 ──

  it('end without start:完全无害,不生成摘要', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
    expect(renderer.calls.some(c => c.includes('Thought for'))).toBe(false);
    expect(renderer.calls.some(c => c === 'eraseStreamingThinking')).toBe(false);
    expect(pipeline.getLastExpandableFullLines()).toBeNull();
  });

  // ── 边界 7: 无 start 的 delta ── 完全忽略 ──

  it('ignores thinking_delta while idle', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_delta', content: 'orphan content' });
    // idle 时不显示
    expect(renderer.calls.some(c => c.startsWith('appendStreamingThinking'))).toBe(false);

    // 后续正常 block 不被污染
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
    const expandable = pipeline.getLastExpandableFullLines();
    const fullText = expandable!.lines.map(l => l.content).join('\n');
    expect(fullText).not.toContain('orphan content');
    // 空 buffer → placeholder
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
    expect(renderer.calls.some(c => c === 'eraseStreamingThinking')).toBe(false);
  });

  // ── 边界 10: start → clear ── 临时行清除,无摘要,回 idle ──

  it('start→clear:临时行清除,无摘要,回 idle', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.clear();
    // clear 调 clearMessages(resetThinkingState(false) 不单独 erase)
    // clear 后状态重置,后续 end 不产摘要
    renderer.calls.length = 0;
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
    expect(renderer.calls.some(c => c.includes('Thought for'))).toBe(false);
  });

  // ── 边界 11: start → clearTurnState ── 同上 ──

  it('start→clearTurnState:擦除临时行,回 idle', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.clearTurnState();
    // clearTurnState 对 active 态调 eraseStreamingThinking
    expect(renderer.calls.some(c => c === 'eraseStreamingThinking')).toBe(true);
    // 后续 end 不产摘要
    renderer.calls.length = 0;
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
    expect(renderer.calls.some(c => c.includes('Thought for'))).toBe(false);
  });

  // ── 边界 12: start → end → start → end ── 两个独立摘要,不串联 ──

  it('start→end→start→end:两个独立摘要,buffer 不串联', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '第一个' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '第二个' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 2, filesRead: 0 });

    // 两个摘要
    expect(renderer.calls.filter(c => c.includes('Thought for')).length).toBe(2);
    // 两次闪烁行
    expect(renderer.calls.filter(c => c.startsWith('appendStreamingThinking'))).toHaveLength(2);
    // Ctrl+O 只返回第二个(most-recent 语义)
    const expandable = pipeline.getLastExpandableFullLines();
    const fullText = expandable!.lines.map(l => l.content).join('\n');
    expect(fullText).toContain('第二个');
    expect(fullText).not.toContain('第一个');
  });

  // ── 摘要 role 契约:不续接 assistant ──

  it('thinking_end 摘要行作为独立消息(role 非 assistant)', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: 'x' });
    renderer.calls.length = 0;
    pipeline.emit({ kind: 'thinking_end', durationSec: 3, filesRead: 0 });

    const summaryCall = renderer.calls.find(c => c.includes('Thought for'));
    expect(summaryCall).toBeDefined();
    expect(summaryCall).not.toMatch(/assistant/);
  });
});
