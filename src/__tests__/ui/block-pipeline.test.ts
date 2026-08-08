// src/__tests__/ui/block-pipeline.test.ts
// 统一输出管道 BlockPipeline 测试(语义块模型)
//
// 物理本质:验证 BlockPipeline.emit() 的路由逻辑——把 Block(union)翻译成
// PipelineRenderer 的语义调用(startToolCall / finishToolCall / startThinking / ...)。
//
// 策略:用一个 RecordingRenderer 实现 PipelineRenderer,记录所有收到的语义调用,
// 然后断言 recorder.calls。这聚焦于 pipeline 的路由/配对逻辑,不耦合 store 状态机。

import { describe, it, expect } from 'vitest';
import { BlockPipeline, type PipelineRenderer } from '../../ui/block-pipeline.js';
import { createLanguageStore } from '../../locale/language-store.js';
import { createTranslator } from '../../locale/translator.js';
import type { ToolPresentation, AskBlock } from '../../tui/transcript-types.js';
import type {
  BoundaryBlock,
  ThinkingSummaryBlock,
} from '../../tui/state/transcript-reducer.js';

// ────────────────────────────────────────────────────────────────────
// RecordingRenderer:记录所有语义调用,供断言
// ────────────────────────────────────────────────────────────────────

type RecordedCall =
  | { type: 'startToolCall'; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: 'finishToolCall'; toolUseId: string; presentation: ToolPresentation; result: boolean }
  | { type: 'finishAsk'; toolUseId: string; block: AskBlock; result: boolean }
  | { type: 'appendStreamingMarkdown'; text: string; isFinal: boolean }
  | { type: 'sealStreaming' }
  | { type: 'startThinking'; text: string }
  | { type: 'updateThinking'; text: string }
  | { type: 'eraseThinking' }
  | { type: 'finishThinking'; summary: ThinkingSummaryBlock }
  | { type: 'appendTranscriptBlock'; block: BoundaryBlock }
  | { type: 'flushNow' }
  | { type: 'clearMessages' }
  | { type: 'closeOpenToolGroup' };

class RecordingRenderer implements PipelineRenderer {
  readonly calls: RecordedCall[] = [];

  startToolCall(call: {
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
  }): void {
    this.calls.push({
      type: 'startToolCall',
      toolUseId: call.toolUseId,
      name: call.name,
      input: call.input,
    });
  }

  finishToolCall(toolUseId: string, presentation: ToolPresentation): boolean {
    this.calls.push({ type: 'finishToolCall', toolUseId, presentation, result: true });
    return true;
  }

  finishAsk(toolUseId: string, block: AskBlock): boolean {
    this.calls.push({ type: 'finishAsk', toolUseId, block, result: true });
    return true;
  }

  closeOpenToolGroup(): void {
    this.calls.push({ type: 'closeOpenToolGroup' });
  }

  appendStreamingMarkdown(text: string, isFinal: boolean): void {
    this.calls.push({ type: 'appendStreamingMarkdown', text, isFinal });
  }

  sealStreaming(): void {
    this.calls.push({ type: 'sealStreaming' });
  }

  startThinking(text: string): string {
    this.calls.push({ type: 'startThinking', text });
    return 'thinking-id';
  }

  updateThinking(text: string): void {
    this.calls.push({ type: 'updateThinking', text });
  }

  eraseThinking(): void {
    this.calls.push({ type: 'eraseThinking' });
  }

  finishThinking(summary: ThinkingSummaryBlock): void {
    this.calls.push({ type: 'finishThinking', summary });
  }

  appendTranscriptBlock(block: BoundaryBlock): void {
    this.calls.push({ type: 'appendTranscriptBlock', block });
  }

  flushNow(): void {
    this.calls.push({ type: 'flushNow' });
  }

  clearMessages(): void {
    this.calls.push({ type: 'clearMessages' });
  }

  /** 取指定类型的所有调用(过滤 view)。 */
  of<T extends RecordedCall['type']>(type: T): Extract<RecordedCall, { type: T }>[] {
    return this.calls.filter((c): c is Extract<RecordedCall, { type: T }> => c.type === type);
  }

  /** 简化的类型序列(便于断言路由顺序)。 */
  types(): RecordedCall['type'][] {
    return this.calls.map(c => c.type);
  }
}

/** 每个测试都创建新的 pipeline + recorder。 */
function setup() {
  const recorder = new RecordingRenderer();
  const pipeline = new BlockPipeline(recorder, createTranslator(createLanguageStore('zh-CN')));
  return { recorder, pipeline };
}

// ════════════════════════════════════════════════════════════════════
// emit 路由:语义调用映射
// ════════════════════════════════════════════════════════════════════

describe('BlockPipeline emit 路由', () => {
  // 1. user_input
  it('user_input → appendTranscriptBlock({ kind: "user", text })', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({ kind: 'user_input', text: '你好' });

    const blocks = recorder.of('appendTranscriptBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.block).toMatchObject({ kind: 'user', text: '你好' });
    expect(blocks[0]!.block.id).toEqual(expect.stringMatching(/^user-\d+$/));
  });

  // 2. thinking_start(幂等)
  it('thinking_start → startThinking("Thinking…");重复 start 幂等(只一次)', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_start' }); // 重复,幂等
    pipeline.emit({ kind: 'thinking_start' }); // 三次,仍幂等

    const starts = recorder.of('startThinking');
    expect(starts).toHaveLength(1);
    expect(starts[0]!.text).toBe('Thinking…');
  });

  // 3. thinking_delta(只累积,不触发调用)
  it('thinking_delta → 不触发额外 renderer 调用(只在内部累积 buffer)', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({ kind: 'thinking_start' });
    const callsBeforeDelta = recorder.calls.length;

    pipeline.emit({ kind: 'thinking_delta', content: '用户问...' });
    pipeline.emit({ kind: 'thinking_delta', content: '更多思考' });

    // delta 完全不产生 renderer 调用(只累积到内部 buffer)
    expect(recorder.calls.length).toBe(callsBeforeDelta);
    expect(recorder.of('updateThinking')).toHaveLength(0);
  });

  // 4. thinking_end(需先 active)
  it('thinking_end → eraseThinking + finishThinking(thinking-summary SystemBlock)', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '实质内容' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 5, filesRead: 2 });

    // eraseThinking 被调一次(擦除临时行)
    expect(recorder.of('eraseThinking')).toHaveLength(1);

    // finishThinking 收到 thinking-summary SystemBlock
    const finishes = recorder.of('finishThinking');
    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.summary).toMatchObject({
      kind: 'system',
      subkind: 'thinking-summary',
      text: 'Thought for 5s',
      durationMs: 5000,
      groupBoundary: 'transparent',
    });
    expect(finishes[0]!.summary.id).toEqual(expect.stringMatching(/^thinking-\d+$/));
    expect(finishes[0]!.summary.expandableId).toBe(finishes[0]!.summary.id);
  });

  it('thinking_end 未 start(idle)→ 不产生摘要,只确保回到 idle', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({ kind: 'thinking_end', durationSec: 5, filesRead: 0 });

    expect(recorder.of('eraseThinking')).toHaveLength(0);
    expect(recorder.of('finishThinking')).toHaveLength(0);
  });

  // 5 & 6. assistant_text(isFinal 分支)
  it('assistant_text isFinal=false → appendStreamingMarkdown(text, false),不 seal', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({ kind: 'assistant_text', text: '部分', isFinal: false });

    const marks = recorder.of('appendStreamingMarkdown');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ text: '部分', isFinal: false });
    expect(recorder.of('sealStreaming')).toHaveLength(0);
  });

  it('assistant_text isFinal=true → appendStreamingMarkdown(text, true) + sealStreaming', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({ kind: 'assistant_text', text: '最终', isFinal: true });

    const marks = recorder.of('appendStreamingMarkdown');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ text: '最终', isFinal: true });
    expect(recorder.of('sealStreaming')).toHaveLength(1);
  });

  // 7. tool_call
  it('tool_call → startToolCall({ toolUseId, name, input })', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({
      kind: 'tool_call',
      name: 'run_bash',
      input: { command: 'ls -la' },
      toolUseId: 't1',
    });

    const starts = recorder.of('startToolCall');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      toolUseId: 't1',
      name: 'run_bash',
      input: { command: 'ls -la' },
    });
  });

  it('tool_call 无 toolUseId → pipeline 生成自动 id(startToolCall 仍被调用)', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'glob', input: { pattern: '*.ts' } });

    const starts = recorder.of('startToolCall');
    expect(starts).toHaveLength(1);
    expect(starts[0]!.name).toBe('glob');
    expect(starts[0]!.toolUseId).toEqual(expect.stringMatching(/^auto-\d+-glob$/));
  });

  // 8. tool_result(配对 + buildToolPresentation)
  it('tool_result → finishToolCall(toolUseId, ToolPresentation);presentation 含 toolName/summary/status', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({
      kind: 'tool_call', name: 'run_bash', input: { command: 'ls' }, toolUseId: 'r1',
    });
    pipeline.emit({
      kind: 'tool_result', name: 'run_bash', output: 'file1\nfile2', toolUseId: 'r1',
    });

    const finishes = recorder.of('finishToolCall');
    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.toolUseId).toBe('r1');
    const p = finishes[0]!.presentation;
    expect(p.toolName).toBe('run_bash');
    expect(p.status).toBe('success');
    expect(p.summary).toContain('file1');
  });

  it('tool_result 输出空 → presentation.status === "empty"', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({
      kind: 'tool_call', name: 'run_bash', input: { command: 'true' }, toolUseId: 'r2',
    });
    pipeline.emit({
      kind: 'tool_result', name: 'run_bash', output: '   ', toolUseId: 'r2',
    });

    const finishes = recorder.of('finishToolCall');
    expect(finishes[0]!.presentation.status).toBe('empty');
  });

  it('tool_result 输出 Error: 前缀 → presentation.status === "error" + errorMessage', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({
      kind: 'tool_call', name: 'run_bash', input: { command: 'bad' }, toolUseId: 'r3',
    });
    pipeline.emit({
      kind: 'tool_result', name: 'run_bash', output: 'Error: something broke', toolUseId: 'r3',
    });

    const finishes = recorder.of('finishToolCall');
    expect(finishes[0]!.presentation.status).toBe('error');
    expect(finishes[0]!.presentation.errorMessage).toBeDefined();
  });

  // 9. tool_result 无 toolUseId → FIFO 配对
  it('tool_result 无 toolUseId → FIFO 配对(第一个未 resolved 的 buffer 项)', () => {
    const { recorder, pipeline } = setup();
    // 两个 call 各自带 id;result 都不带 id,走 FIFO 队列
    pipeline.emit({
      kind: 'tool_call', name: 'run_bash', input: { command: 'first' }, toolUseId: 'fifo-1',
    });
    pipeline.emit({
      kind: 'tool_call', name: 'run_bash', input: { command: 'second' }, toolUseId: 'fifo-2',
    });
    pipeline.emit({ kind: 'tool_result', name: 'run_bash', output: 'out-1' }); // 无 id
    pipeline.emit({ kind: 'tool_result', name: 'run_bash', output: 'out-2' }); // 无 id

    const finishes = recorder.of('finishToolCall');
    expect(finishes).toHaveLength(2);
    // FIFO:第 1 个 result 配对第 1 个 call(fifo-1),第 2 个配第 2 个(fifo-2)
    expect(finishes[0]!.toolUseId).toBe('fifo-1');
    expect(finishes[1]!.toolUseId).toBe('fifo-2');
  });

  // 10. tool_result spawn_agent → layout: 'compact-completion'
  it('tool_result spawn_agent → finishToolCall 带 layout:"compact-completion" 的 presentation', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({
      kind: 'tool_call', name: 'spawn_agent', toolUseId: 'a1',
      input: { role: 'explore', description: '查找实现', prompt: '...' },
    });
    pipeline.emit({
      kind: 'tool_result', name: 'spawn_agent', toolUseId: 'a1', durationMs: 5000,
      output: '[Subagent status=completed]\nfull child result body',
    });

    const finishes = recorder.of('finishToolCall');
    expect(finishes).toHaveLength(1);
    const p = finishes[0]!.presentation;
    expect(p.layout).toBe('compact-completion');
    expect(p.toolName).toBe('spawn_agent');
    expect(p.status).toBe('success');
    // summary 来自 buildSubagentCompletionPresentation(line)
    expect(p.summary).toContain('Agent "查找实现"');
    expect(p.summary).toContain('finished');
  });

  it('spawn_agent malformed(无 envelope)→ 走通用降级,无 compact-completion layout', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({
      kind: 'tool_call', name: 'spawn_agent', toolUseId: 'a2',
      input: { role: 'explore', prompt: '...' },
    });
    pipeline.emit({
      kind: 'tool_result', name: 'spawn_agent', toolUseId: 'a2',
      output: 'malformed output',
    });

    const finishes = recorder.of('finishToolCall');
    expect(finishes[0]!.presentation.layout).toBeUndefined();
  });

  // 11. hook → appendTranscriptBlock({ kind:'system', subkind:'notification' })
  it('hook → appendTranscriptBlock({ kind:"system", subkind:"notification" })', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({ kind: 'hook', text: '[Hook] run_bash done' });

    const blocks = recorder.of('appendTranscriptBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.block).toMatchObject({
      kind: 'system',
      subkind: 'notification',
      text: '[Hook] run_bash done',
      groupBoundary: 'break',
    });
    expect(blocks[0]!.block.id).toEqual(expect.stringMatching(/^hook-\d+$/));
  });

  // orphan 兜底:result 无对应 call
  it('tool_result 无对应 call → 兜底 startToolCall + finishToolCall(orphan),不丢失', () => {
    const { recorder, pipeline } = setup();
    // 没有 tool_call,直接 emit result
    pipeline.emit({
      kind: 'tool_result', name: 'run_bash', output: 'orphan out', toolUseId: 'missing-1',
    });

    // orphan 路径:pipeline 自动 startToolCall + finishToolCall
    const starts = recorder.of('startToolCall');
    const finishes = recorder.of('finishToolCall');
    expect(starts).toHaveLength(1);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.presentation.toolName).toBe('run_bash');
  });
});

// ════════════════════════════════════════════════════════════════════
// 12 & 13. clear() / clearTurnState()
// ════════════════════════════════════════════════════════════════════

describe('BlockPipeline clear / clearTurnState', () => {
  it('clear() → closeOpenToolGroup + clearMessages(eraseThinking 不触发,因 eraseIfActive=false)', () => {
    const { recorder, pipeline } = setup();
    // 先有一些内容(包括 active thinking)
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'tool_call', name: 'run_bash', input: {}, toolUseId: 'c1' });

    const callsBeforeClear = recorder.calls.length;
    pipeline.clear();

    // 新增的调用应包含 closeOpenToolGroup + clearMessages
    const newCalls = recorder.calls.slice(callsBeforeClear);
    const types = newCalls.map(c => c.type);
    expect(types).toContain('closeOpenToolGroup');
    expect(types).toContain('clearMessages');
    // eraseThinking 不触发(eraseIfActive=false 是 clear 的语义)
    expect(types).not.toContain('eraseThinking');
  });

  it('clearTurnState() → closeOpenToolGroup + eraseThinking(若 thinking active)', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({ kind: 'thinking_start' }); // active
    pipeline.emit({ kind: 'tool_call', name: 'run_bash', input: {}, toolUseId: 'ct1' });

    const callsBefore = recorder.calls.length;
    pipeline.clearTurnState();
    const newCalls = recorder.calls.slice(callsBefore);
    const types = newCalls.map(c => c.type);

    expect(types).toContain('closeOpenToolGroup');
    expect(types).toContain('eraseThinking');
    // clearTurnState 不清屏
    expect(types).not.toContain('clearMessages');
  });

  it('clearTurnState() 若 thinking 未 active → 不触发 eraseThinking', () => {
    const { recorder, pipeline } = setup();
    // 没有 thinking_start,thinking 是 idle
    pipeline.emit({ kind: 'tool_call', name: 'run_bash', input: {}, toolUseId: 'ct2' });

    const callsBefore = recorder.calls.length;
    pipeline.clearTurnState();
    const newCalls = recorder.calls.slice(callsBefore);
    expect(newCalls.map(c => c.type)).not.toContain('eraseThinking');
    expect(newCalls.map(c => c.type)).toContain('closeOpenToolGroup');
  });

  it('clear() 后 toolBuffer 清空(后续 orphan result 视为新 orphan)', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({
      kind: 'tool_call', name: 'run_bash', input: { command: 'x' }, toolUseId: 'cl-1',
    });
    pipeline.clear();
    // clear 后 buffer 已空,result 找不到配对 → orphan 路径
    pipeline.emit({
      kind: 'tool_result', name: 'run_bash', output: 'late', toolUseId: 'cl-1',
    });
    // 又一次 startToolCall(orphan 兜底)
    const starts = recorder.of('startToolCall');
    expect(starts.length).toBeGreaterThanOrEqual(2);
  });
});

// ════════════════════════════════════════════════════════════════════
// 14. getLastExpandableFullLines() —— 可折叠块注册
// ════════════════════════════════════════════════════════════════════

describe('BlockPipeline getLastExpandableFullLines(可折叠块注册)', () => {
  it('thinking_end 注册可折叠块 → getLastExpandableFullLines 返回 kind:"thinking" + 完整思考内容', () => {
    const { pipeline } = setup();
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '完整思考内容' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 3, filesRead: 0 });

    const exp = pipeline.getLastExpandableFullLines();
    expect(exp).not.toBeNull();
    expect(exp!.kind).toBe('thinking');
    expect(exp!.lines.some(l => l.content.includes('完整思考内容'))).toBe(true);
  });

  it('thinking 无 delta → expandable fullLines 显示 "(No thinking content received)" 占位', () => {
    const { pipeline } = setup();
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });

    const exp = pipeline.getLastExpandableFullLines();
    expect(exp).not.toBeNull();
    expect(exp!.lines.some(l => l.content.includes('No thinking content received'))).toBe(true);
  });

  it('长 tool_result(>500 字符)注册可折叠块 → getLastExpandableFullLines 返回 kind:"tool_result"', () => {
    const { pipeline } = setup();
    pipeline.emit({
      kind: 'tool_call', name: 'run_bash', input: { command: 'cat' }, toolUseId: 'long-1',
    });
    // 输出 >500 字符触发 expandable 注册
    const longOutput = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\n' + 'x'.repeat(600);
    pipeline.emit({
      kind: 'tool_result', name: 'run_bash', output: longOutput, toolUseId: 'long-1',
    });

    const exp = pipeline.getLastExpandableFullLines();
    expect(exp).not.toBeNull();
    expect(exp!.kind).toBe('tool_result');
    // 完整输出在 fullLines 里(含 l7 行)
    expect(exp!.lines.some(l => l.content.includes('l7'))).toBe(true);
  });

  it('短 tool_result(<=500 字符)不注册可折叠块', () => {
    const { pipeline } = setup();
    pipeline.emit({
      kind: 'tool_call', name: 'run_bash', input: { command: 'ls' }, toolUseId: 'short-1',
    });
    pipeline.emit({
      kind: 'tool_result', name: 'run_bash', output: 'short out', toolUseId: 'short-1',
    });

    expect(pipeline.getLastExpandableFullLines()).toBeNull();
  });

  it('无可折叠块时 getLastExpandableFullLines 返回 null', () => {
    const { pipeline } = setup();
    expect(pipeline.getLastExpandableFullLines()).toBeNull();
  });

  it('clearTurnState() 清空可折叠块 → getLastExpandableFullLines 返回 null', () => {
    const { pipeline } = setup();
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '内容' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
    expect(pipeline.getLastExpandableFullLines()).not.toBeNull();

    pipeline.clearTurnState();
    expect(pipeline.getLastExpandableFullLines()).toBeNull();
  });

  it('clear() 清空可折叠块 → getLastExpandableFullLines 返回 null', () => {
    const { pipeline } = setup();
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_delta', content: '内容' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
    expect(pipeline.getLastExpandableFullLines()).not.toBeNull();

    pipeline.clear();
    expect(pipeline.getLastExpandableFullLines()).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════
// 15. 并行工具配对(按 toolUseId,而非 FIFO)
// ════════════════════════════════════════════════════════════════════

describe('BlockPipeline 并行工具配对(按 toolUseId)', () => {
  it('4 个并行 tool_call + 4 个 tool_result:按 toolUseId 精确配对(即使 result 乱序到达)', () => {
    const { recorder, pipeline } = setup();
    // 阶段 1:4 个 call 背靠背 emit
    pipeline.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'a' }, toolUseId: 'id-1' });
    pipeline.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'b' }, toolUseId: 'id-2' });
    pipeline.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'c' }, toolUseId: 'id-3' });
    pipeline.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'd' }, toolUseId: 'id-4' });

    // 阶段 2:result 乱序到达(id-3 先,id-1 次,id-4 三,id-2 末)
    pipeline.emit({ kind: 'tool_result', name: 'run_bash', output: 'out-c', toolUseId: 'id-3' });
    pipeline.emit({ kind: 'tool_result', name: 'run_bash', output: 'out-a', toolUseId: 'id-1' });
    pipeline.emit({ kind: 'tool_result', name: 'run_bash', output: 'out-d', toolUseId: 'id-4' });
    pipeline.emit({ kind: 'tool_result', name: 'run_bash', output: 'out-b', toolUseId: 'id-2' });

    const starts = recorder.of('startToolCall');
    const finishes = recorder.of('finishToolCall');
    expect(starts).toHaveLength(4);
    expect(finishes).toHaveLength(4);

    // 关键:每个 finishToolCall 的 toolUseId 与 result 自带的 id 匹配,
    // presentation.toolUseId 也来自该配对 call(证明按 id 而非 FIFO 配对)。
    // 顺序应是 result 到达的顺序:id-3, id-1, id-4, id-2
    expect(finishes.map(f => f.toolUseId)).toEqual(['id-3', 'id-1', 'id-4', 'id-2']);
    for (const f of finishes) {
      expect(f.presentation.toolUseId).toBe(f.toolUseId);
    }
  });

  it('重复 tool_result(同 toolUseId)→ 第二个走 orphan 路径(配对项已 resolved)', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'run_bash', input: {}, toolUseId: 'dup-1' });
    pipeline.emit({ kind: 'tool_result', name: 'run_bash', output: 'first', toolUseId: 'dup-1' });
    // 第二次同 id result:缓冲项已 splice,findIndex 找不到 → orphan 兜底
    pipeline.emit({ kind: 'tool_result', name: 'run_bash', output: 'second', toolUseId: 'dup-1' });

    const starts = recorder.of('startToolCall');
    const finishes = recorder.of('finishToolCall');
    expect(starts).toHaveLength(2); // 原 call + orphan startToolCall
    expect(finishes).toHaveLength(2);
  });

  it('混合配对:部分 result 带 id,部分不带(FIFO 兜底)', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({ kind: 'tool_call', name: 'run_bash', input: {}, toolUseId: 'mix-1' });
    pipeline.emit({ kind: 'tool_call', name: 'run_bash', input: {}, toolUseId: 'mix-2' });
    pipeline.emit({ kind: 'tool_call', name: 'run_bash', input: {}, toolUseId: 'mix-3' });

    // 第 1 个 result 带 id(精确配对 mix-2)
    pipeline.emit({ kind: 'tool_result', name: 'run_bash', output: 'b', toolUseId: 'mix-2' });
    // 第 2 个 result 不带 id → FIFO 配对第一个未 resolved(mix-1)
    pipeline.emit({ kind: 'tool_result', name: 'run_bash', output: 'a' });
    // 第 3 个 result 不带 id → FIFO 配对剩下的(mix-3)
    pipeline.emit({ kind: 'tool_result', name: 'run_bash', output: 'c' });

    const finishes = recorder.of('finishToolCall');
    expect(finishes.map(f => f.toolUseId)).toEqual(['mix-2', 'mix-1', 'mix-3']);
  });
});

// ════════════════════════════════════════════════════════════════════
// commit()(flushNow 透传)
// ════════════════════════════════════════════════════════════════════

describe('BlockPipeline commit', () => {
  it('commit() → 调 renderer.flushNow()', () => {
    const { recorder, pipeline } = setup();
    pipeline.emit({ kind: 'user_input', text: 'hi' });
    pipeline.commit();
    expect(recorder.of('flushNow')).toHaveLength(1);
  });
});
