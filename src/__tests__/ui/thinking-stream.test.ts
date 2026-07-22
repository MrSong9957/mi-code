// thinking 临时行状态机测试 (AUTO-0025-transient Task 2)
//
// 验证 BlockPipeline 的 thinking 状态机:
// - thinking_start → awaitingContent(不立即固化标题行)
// - thinking_delta 首个非空 → visible(appendStreamingThinking 一次)
// - thinking_delta 纯空白 → 不显示临时行
// - thinking_end → registerExpandable 先于 eraseStreamingThinking,留 Thought 摘要

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

describe('BlockPipeline thinking 状态机 (AUTO-0025-transient)', () => {
  it('thinking_start 不立即固化 Thinking 标题行', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });

    // awaitingContent:不打印任何标题行
    expect(renderer.calls).not.toContainEqual(expect.stringContaining('Thinking'));
    expect(renderer.calls.some(c => c.startsWith('appendStreamingThinking'))).toBe(false);
  });

  it('thinking_delta 纯空白不显示临时行', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '   \n' });

    expect(renderer.calls.some(c => c.startsWith('appendStreamingThinking'))).toBe(false);
  });

  it('首个非空 delta 调用 appendStreamingThinking 一次', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '真实内容' });

    const thinkingCalls = renderer.calls.filter(c => c.startsWith('appendStreamingThinking'));
    expect(thinkingCalls).toHaveLength(1);
  });

  it('no-start 非空 delta 也能创建 visible 态', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    // 不 emit thinking_start,直接 delta(隐式 start)
    pipeline.emit({ kind: 'thinking_delta', content: '隐式内容' });

    expect(renderer.calls.filter(c => c.startsWith('appendStreamingThinking'))).toHaveLength(1);
  });

  it('thinking_end:Thought 摘要(大写 T) + eraseStreamingThinking', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '一些思考' });
    renderer.calls.length = 0;

    pipeline.emit({ kind: 'thinking_end', durationSec: 2, filesRead: 0 });

    // 摘要用大写 Thought
    const summaryCall = renderer.calls.find(c => c.includes('Thought for'));
    expect(summaryCall).toBeDefined();
    // eraseStreamingThinking 被调用(擦除临时行)
    expect(renderer.calls.some(c => c === 'eraseStreamingThinking')).toBe(true);
  });

  it('thinking_end:expandable 已注册且 erase 被调用(顺序隐含正确)', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '完整思考内容' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 5, filesRead: 0 });

    // erase 被调用(擦除临时行)
    expect(renderer.calls.some(c => c === 'eraseStreamingThinking')).toBe(true);
    // expandable 已注册且含完整内容(register 在 erase 前,否则内容丢失)
    const expandable = pipeline.getLastExpandableFullLines();
    expect(expandable).not.toBeNull();
    expect(expandable!.kind).toBe('thinking');
    expect(expandable!.lines.map(l => l.content).join('\n')).toContain('完整思考内容');
    // 摘要在 erase 之后打印(erase 先擦临时行,再 print 摘要)
    const eraseIdx = renderer.calls.indexOf('eraseStreamingThinking');
    const summaryIdx = renderer.calls.findIndex(c => c.includes('Thought for'));
    expect(summaryIdx).toBeGreaterThan(eraseIdx);
  });

  it('thinking_end 摘要行作为独立消息(role 非 assistant,不续接)', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: 'x' });
    renderer.calls.length = 0;
    pipeline.emit({ kind: 'thinking_end', durationSec: 3, filesRead: 0 });

    const summaryCall = renderer.calls.find(c => c.includes('Thought for'));
    expect(summaryCall).toBeDefined();
    // role 不是 assistant(强制新建消息)
    expect(summaryCall).not.toMatch(/assistant/);
  });

  it('纯空白 thinking_start + end 不产生摘要也不产生临时行', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '   ' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });

    // 无临时行
    expect(renderer.calls.some(c => c.startsWith('appendStreamingThinking'))).toBe(false);
    // 无摘要
    expect(renderer.calls.some(c => c.includes('Thought for'))).toBe(false);
    // 无 expandable
    expect(pipeline.getLastExpandableFullLines()).toBeNull();
  });

  it('重复 thinking_start 在 awaitingContent 和 visible 都幂等', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_start' }); // awaitingContent 重复
    pipeline.emit({ kind: 'thinking_delta', content: 'x' }); // → visible
    pipeline.emit({ kind: 'thinking_start' }); // visible 重复

    // 只一次 appendStreamingThinking
    expect(renderer.calls.filter(c => c.startsWith('appendStreamingThinking'))).toHaveLength(1);
  });

  it('重复 thinking_end 幂等', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: 'x' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 2, filesRead: 0 });
    renderer.calls.length = 0;
    pipeline.emit({ kind: 'thinking_end', durationSec: 2, filesRead: 0 }); // 重复

    // 重复 end 不再产生摘要或 erase
    expect(renderer.calls.some(c => c.includes('Thought for'))).toBe(false);
    expect(renderer.calls.some(c => c === 'eraseStreamingThinking')).toBe(false);
  });

  it('visible 后 clear 重置状态,后续 thinking_end 不产生摘要', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: 'x' });
    pipeline.clear();
    renderer.calls.length = 0;
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });

    expect(renderer.calls.some(c => c.includes('Thought for'))).toBe(false);
  });

  it('clearTurnState 擦除 visible 临时行并重置,保留已固化消息', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'user_input', text: 'hi' });
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: 'x' });
    renderer.calls.length = 0;

    pipeline.clearTurnState();
    // visible 临时行被擦除
    expect(renderer.calls.some(c => c === 'eraseStreamingThinking')).toBe(true);
  });

  it('两个 thinking 块留下两个永久摘要,Ctrl+O 只返回第二个', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '第一个思考' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '第二个思考' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 2, filesRead: 0 });

    // 两个摘要
    const summaryCalls = renderer.calls.filter(c => c.includes('Thought for'));
    expect(summaryCalls).toHaveLength(2);
    // Ctrl+O 返回第二个
    const expandable = pipeline.getLastExpandableFullLines();
    expect(expandable).not.toBeNull();
    expect(expandable!.lines.map(l => l.content).join('\n')).toContain('第二个思考');
  });
});
