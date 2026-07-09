// thinking 流式 + 折叠测试（RED 阶段）
//
// 验证 BlockPipeline 的 thinking 行为从"隐藏"改为"流式 + 折叠"：
// 1. thinking_delta → 调用 renderer.appendStreamingThinking（流式渲染灰色思考过程）
// 2. thinking_end → 注册 expandable 块 + 打印摘要 + eraseStreamingThinking（折叠）

import { describe, it, expect } from 'vitest';
import { BlockPipeline, type PipelineRenderer } from '../../ui/block-pipeline.js';
import type { FormattedLine, UIMessageStyle } from '../../ui/types.js';

/** mock renderer：捕获所有调用，验证 pipeline 行为 */
function createMockRenderer(): PipelineRenderer & { calls: string[] } {
  const calls: string[] = [];
  const renderer: PipelineRenderer = {
    printMessage(text, role?, style?, raw?) {
      calls.push(`printMessage(${JSON.stringify(text.slice(0, 40))}, ${role ?? '?'})`);
    },
    appendStreamingMarkdown(text, isFinal, opts?) {
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

describe('BlockPipeline thinking 流式渲染', () => {
  it('thinking_delta 调用 appendStreamingThinking（流式输出思考过程）', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    renderer.calls.length = 0; // 清掉 start 的调用

    pipeline.emit({ kind: 'thinking_delta', content: '我在想' });
    pipeline.emit({ kind: 'thinking_delta', content: '我在想这个问题' });

    // 关键：thinking_delta 应触发 appendStreamingThinking
    const thinkingCalls = renderer.calls.filter(c => c.startsWith('appendStreamingThinking'));
    expect(thinkingCalls.length).toBeGreaterThanOrEqual(2);
    // 最后一次含完整累积文本
    expect(thinkingCalls[thinkingCalls.length - 1]).toContain('我在想这个问题');
  });

  it('thinking_end 打印摘要行 + eraseStreamingThinking（折叠）', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '一些思考内容' });
    renderer.calls.length = 0;

    pipeline.emit({ kind: 'thinking_end', durationSec: 3, filesRead: 0 });

    // 关键：thinking_end 后应打印摘要（含 Thought for）
    const summaryCall = renderer.calls.find(c => c.includes('Thought for'));
    expect(summaryCall).toBeDefined();
    // 关键：应调用 eraseStreamingThinking（擦除流式草稿，折叠为摘要）
    const eraseCall = renderer.calls.find(c => c.includes('eraseStreamingThinking'));
    expect(eraseCall).toBeDefined();
  });

  it('thinking_end 后 getLastExpandableFullLines 含完整思考内容（供 ctrl+o 展开）', () => {
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '完整思考过程内容' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 5, filesRead: 0 });

    const expandable = pipeline.getLastExpandableFullLines();
    expect(expandable).not.toBeNull();
    expect(expandable!.kind).toBe('thinking');
    // 展开内容含完整思考文本
    const fullText = expandable!.lines.map(l => l.content).join('\n');
    expect(fullText).toContain('完整思考过程内容');
  });

  it('thinking_end 摘要行作为独立消息（不续接到 ● Thinking… 消息）', () => {
    // 根因：print(summary, 'assistant') 会续接到已固化的 ● Thinking… 消息，
    // 导致 InlineApp 的 renderedCountRef 跳过它（该消息已计为已渲染）。
    // 修复：摘要用独立 role，确保是 messages 数组中的新消息。
    const renderer = createMockRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'thinking_start' });
    renderer.calls.length = 0;
    pipeline.emit({ kind: 'thinking_end', durationSec: 3, filesRead: 0 });

    // 摘要行的 printMessage 调用，role 不应是 'assistant'（否则续接）
    const summaryCall = renderer.calls.find(c => c.includes('Thought for'));
    expect(summaryCall).toBeDefined();
    // 关键：role 不是 assistant（强制新建消息，让 InlineApp 识别为新渲染项）
    expect(summaryCall).not.toMatch(/assistant/);
  });
});
