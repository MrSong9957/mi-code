import { describe, expect, it, vi } from 'vitest';
import { BlockPipeline, type PipelineRenderer } from '../../ui/block-pipeline.js';
import { createLanguageStore } from '../../locale/language-store.js';
import { createTranslator } from '../../locale/translator.js';
import type { StructuredAskResult } from '../../agent/ask-user-types.js';
import type { AskBlock, ToolPresentation } from '../../tui/transcript-types.js';
import type { BoundaryBlock, ThinkingSummaryBlock } from '../../tui/state/transcript-reducer.js';

function createRecordingRenderer(): PipelineRenderer & {
  asks: AskBlock[];
  tools: ToolPresentation[];
  thinkingSummaries: ThinkingSummaryBlock[];
} {
  const asks: AskBlock[] = [];
  const tools: ToolPresentation[] = [];
  const thinkingSummaries: ThinkingSummaryBlock[] = [];

  const renderer: PipelineRenderer = {
    startToolCall: vi.fn(),
    finishToolCall(_toolUseId, presentation) {
      tools.push(presentation);
      return true;
    },
    finishAsk(_toolUseId, block) {
      asks.push(block);
      return true;
    },
    appendStreamingMarkdown: vi.fn(),
    sealStreaming: vi.fn(),
    startThinking: vi.fn(() => 'thinking-id'),
    updateThinking: vi.fn(),
    eraseThinking: vi.fn(),
    finishThinking(summary) {
      thinkingSummaries.push(summary);
    },
    appendTranscriptBlock: vi.fn((_block: BoundaryBlock) => {}),
    flushNow: vi.fn(),
    clearMessages: vi.fn(),
  };

  return Object.assign(renderer, { asks, tools, thinkingSummaries });
}

function askStructuredResult(answer: string): StructuredAskResult {
  return {
    version: 1,
    request: {
      questions: [{
        header: 'Raw Header',
        question: 'Which option?',
        options: [
          { label: 'Raw A', description: 'Raw A description' },
          { label: 'Raw B', description: 'Raw B description' },
        ],
        multiSelect: false,
      }],
    },
    outcome: { kind: 'submitted', answers: { 'Which option?': answer } },
  };
}

function emitGlobNoMatches(pipeline: BlockPipeline, id: string, pattern: string): void {
  pipeline.emit({
    kind: 'tool_call',
    name: 'glob',
    input: { pattern },
    toolUseId: id,
  });
  pipeline.emit({
    kind: 'tool_result',
    name: 'glob',
    output: '',
    toolUseId: id,
  });
}

function emitAsk(pipeline: BlockPipeline, id: string, answer: string): void {
  pipeline.emit({
    kind: 'tool_call',
    name: 'ask_user_question',
    input: { questions: [] },
    toolUseId: id,
  });
  pipeline.emit({
    kind: 'tool_result',
    name: 'ask_user_question',
    output: 'raw ask tool feedback must not enter AskBlock',
    toolUseId: id,
    structuredOutcome: askStructuredResult(answer),
  });
}

function emitThinkingSummary(pipeline: BlockPipeline, durationSec: number): void {
  pipeline.emit({ kind: 'thinking_start' });
  pipeline.emit({ kind: 'thinking_delta', content: 'raw thought body' });
  pipeline.emit({ kind: 'thinking_end', durationSec, filesRead: 0 });
}

describe('BlockPipeline locale store switching', () => {
  it('uses the shared LanguageStore language for each next tool, ask, and thinking presentation', () => {
    const languageStore = createLanguageStore('zh-CN');
    const renderer = createRecordingRenderer();
    const pipeline = new BlockPipeline(renderer, createTranslator(languageStore));

    emitGlobNoMatches(pipeline, 'glob-zh', '*.missing');
    emitAsk(pipeline, 'ask-zh', 'Raw A');
    emitThinkingSummary(pipeline, 2);

    languageStore.getState().setLanguage('en-US');

    emitGlobNoMatches(pipeline, 'glob-en', '*.missing');
    emitAsk(pipeline, 'ask-en', 'Raw B');
    emitThinkingSummary(pipeline, 3);

    expect(renderer.tools.map(p => p.summary)).toEqual([
      '*.missing → 无匹配',
      '*.missing → no matches',
    ]);
    expect(renderer.asks.map(block => ({ summary: block.summary, items: block.items }))).toEqual([
      { summary: '已回答 1 个问题', items: ['Raw Header → Raw A'] },
      { summary: 'Answered 1 question', items: ['Raw Header → Raw B'] },
    ]);
    expect(renderer.thinkingSummaries.map(summary => summary.text)).toEqual([
      '思考了 2 秒',
      'Thought for 3s',
    ]);

    expect(renderer.asks[0]!.outcome).toEqual({
      kind: 'submitted',
      answers: { 'Which option?': 'Raw A' },
    });
    expect(JSON.stringify(renderer.asks)).not.toContain('raw ask tool feedback');
  });
});

describe('BlockPipeline thinking label locale switching', () => {
  it('thinking_start 临时标签随 store 语言切换:zh "思考中…" → en "Thinking…"', () => {
    const languageStore = createLanguageStore('zh-CN');
    const renderer = createRecordingRenderer();
    const pipeline = new BlockPipeline(renderer, createTranslator(languageStore));

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });

    languageStore.getState().setLanguage('en-US');

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });

    const starts = (renderer.startThinking as ReturnType<typeof vi>).mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(starts).toEqual(['思考中…', 'Thinking…']);
  });

  it('thinking 无 delta → noContent 占位随 store 语言切换,保留前导 2 空格', () => {
    const languageStore = createLanguageStore('zh-CN');
    const renderer = createRecordingRenderer();
    const pipeline = new BlockPipeline(renderer, createTranslator(languageStore));

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });

    let exp = pipeline.getLastExpandableFullLines();
    expect(exp).not.toBeNull();
    expect(exp!.lines.some(l => l.content === '  （无思考内容）')).toBe(true);

    languageStore.getState().setLanguage('en-US');

    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });

    exp = pipeline.getLastExpandableFullLines();
    expect(exp).not.toBeNull();
    expect(exp!.lines.some(l => l.content === '  (No thinking content received)')).toBe(true);
  });
});
