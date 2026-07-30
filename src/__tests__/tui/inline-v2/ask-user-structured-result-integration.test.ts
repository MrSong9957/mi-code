// src/__tests__/tui/inline-v2/ask-user-structured-result-integration.test.ts
// ask_user_question structured result e2e(语义版)。
//
// 验证 BlockPipeline 把 ask_user_question + structuredOutcome 路由到 finishAsk(AskBlock),
// 而非通用 finishToolCall。断言 AskBlock 的 summary/items/outcome,不绑定渲染细节。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BlockPipeline, type PipelineRenderer } from '../../../ui/block-pipeline.js';
import type { ToolPresentation, AskBlock } from '../../../tui/transcript-types.js';
import type { ThinkingSummaryBlock, BoundaryBlock } from '../../../tui/state/transcript-reducer.js';
import { askOutcomeStore } from '../../../agent/ask-outcome-store.js';
import type { StructuredAskResult } from '../../../agent/ask-user-types.js';

/** recording renderer:记录 finishAsk / finishToolCall 调用。 */
function createRecordingRenderer(): PipelineRenderer & {
  askBlocks: AskBlock[];
  toolPresentations: { toolUseId: string; presentation: ToolPresentation }[];
} {
  const askBlocks: AskBlock[] = [];
  const toolPresentations: { toolUseId: string; presentation: ToolPresentation }[] = [];
  const renderer: PipelineRenderer = {
    startToolCall: vi.fn(),
    finishToolCall(toolUseId, presentation) {
      toolPresentations.push({ toolUseId, presentation });
      return true;
    },
    finishAsk(_toolUseId, block) {
      askBlocks.push(block);
      return true;
    },
    appendStreamingMarkdown: vi.fn(),
    sealStreaming: vi.fn(),
    startThinking: vi.fn(() => ''),
    updateThinking: vi.fn(),
    eraseThinking: vi.fn(),
    finishThinking: vi.fn((_summary: ThinkingSummaryBlock) => {}),
    appendTranscriptBlock: vi.fn((_block: BoundaryBlock) => {}),
    flushNow: vi.fn(),
    clearMessages: vi.fn(),
  };
  return Object.assign(renderer, { askBlocks, toolPresentations });
}

describe('ask_user_question structured result e2e (semantic)', () => {
  beforeEach(() => askOutcomeStore.clear());

  it('submitted 完整链路 → finishAsk(AskBlock),非 finishToolCall', () => {
    const renderer = createRecordingRenderer();
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({
      kind: 'tool_call', name: 'ask_user_question', toolUseId: 'tuu-e2e-1',
      input: { questions: [] },
    });

    const structured: StructuredAskResult = {
      version: 1,
      request: {
        questions: [
          { header: 'Auth', question: 'Which auth method?', options: [{ label: 'OAuth', description: 'd' }, { label: 'Key', description: 'd' }], multiSelect: false },
          { header: 'Lib', question: 'Which library?', options: [{ label: 'A', description: 'd' }, { label: 'B', description: 'd' }], multiSelect: true },
        ],
      },
      outcome: { kind: 'submitted', answers: { 'Which auth method?': 'OAuth', 'Which library?': 'A, B' } },
    };
    pipeline.emit({
      kind: 'tool_result', name: 'ask_user_question', toolUseId: 'tuu-e2e-1',
      output: 'User has answered your questions: ...',
      structuredOutcome: structured,
    });

    // 走 finishAsk,不走 finishToolCall
    expect(renderer.askBlocks).toHaveLength(1);
    expect(renderer.toolPresentations).toHaveLength(0);

    const block = renderer.askBlocks[0]!;
    expect(block.kind).toBe('ask');
    expect(block.summary).toBe('Answered 2 questions');
    expect(block.items).toEqual(['Auth → OAuth', 'Lib → A, B']);
    expect(block.outcome).toEqual({ kind: 'submitted', answers: { 'Which auth method?': 'OAuth', 'Which library?': 'A, B' } });

    // items 用 header 配对(不含 question 全文);outcome 保留原始 answers key(question 全文)
    expect(block.items.join('\n')).not.toContain('Which auth method?');
    // 不含 API 字符串
    expect(JSON.stringify(block)).not.toContain('User has answered');
    // 不含 agent-completion(旧 kind 已移除)
    expect(JSON.stringify(block)).not.toContain('agent-completion');

    // 不注册 expandable
    expect(pipeline.getLastExpandableFullLines()).toBeNull();
  });

  it('cancelled outcome → AskBlock with Declined summary', () => {
    const renderer = createRecordingRenderer();
    const pipeline = new BlockPipeline(renderer);
    pipeline.emit({
      kind: 'tool_call', name: 'ask_user_question', toolUseId: 'tuu-e2e-2',
      input: { questions: [] },
    });
    pipeline.emit({
      kind: 'tool_result', name: 'ask_user_question', toolUseId: 'tuu-e2e-2',
      output: 'User declined',
      structuredOutcome: {
        version: 1,
        request: { questions: [{ header: 'X', question: 'q', options: [{ label: 'a', description: 'd' }, { label: 'b', description: 'd' }], multiSelect: false }] },
        outcome: { kind: 'cancelled' },
      },
    });

    expect(renderer.askBlocks).toHaveLength(1);
    expect(renderer.askBlocks[0]!.summary).toBe('Declined to answer');
    expect(renderer.askBlocks[0]!.items).toEqual(['User declined to answer questions']);
  });

  it('API 通道零污染:output(API 字符串)不进 AskBlock', () => {
    const renderer = createRecordingRenderer();
    const pipeline = new BlockPipeline(renderer);
    pipeline.emit({
      kind: 'tool_call', name: 'ask_user_question', toolUseId: 'tuu-e2e-3',
      input: { questions: [] },
    });
    const apiString = 'User has answered your questions: "q"="A". You can now continue...';
    pipeline.emit({
      kind: 'tool_result', name: 'ask_user_question', toolUseId: 'tuu-e2e-3',
      output: apiString,
      structuredOutcome: {
        version: 1,
        request: { questions: [{ header: 'Cfg', question: 'q', options: [{ label: 'A', description: 'd' }, { label: 'B', description: 'd' }], multiSelect: false }] },
        outcome: { kind: 'submitted', answers: { q: 'A' } },
      },
    });

    const block = renderer.askBlocks[0]!;
    expect(block.summary).toBe('Answered 1 question');
    expect(block.items).toEqual(['Cfg → A']);
    expect(JSON.stringify(block)).not.toContain(apiString);
    expect(JSON.stringify(block)).not.toContain('You can now continue');
  });
});
