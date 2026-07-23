// src/__tests__/tui/inline-v2/ask-user-structured-result-integration.test.ts
// AUTO-0025 Phase B (Task 16b):端到端集成测试(BlockPipeline integration 层级)。
//
// 这是 PR2 最重要的 FR 保险:把 Task 13(block-pipeline 分支)+ Task 14(透传)
// 的协作一次性验证,证明完整数据链路语义正确。
//
// 断言范围约束(防脆性):只验证数据链路语义,禁止绑定 Ink 行布局、ANSI 转义码、
// 具体颜色值、空格数量等 UI 细节。断言针对 mockRenderer 收到的 resultLines 文本内容。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BlockPipeline } from '../../../ui/block-pipeline.js';
import { askOutcomeStore } from '../../../agent/ask-outcome-store.js';
import type { StructuredAskResult } from '../../../agent/ask-user-types.js';

/** mock Renderer:记录所有 finishToolCall 调用的 lines(参考 block-pipeline.test.ts 的 mockRenderer) */
function mockRenderer() {
  const finishToolCalls: { toolUseId: string; lines: { content: string }[]; finalKind?: string }[] = [];
  const prints: { text: string }[] = [];
  const renderer = {
    printMessage: vi.fn((text: string) => { prints.push({ text }); }),
    appendStreamingMarkdown: vi.fn(),
    appendStreamingThinking: vi.fn(),
    eraseStreamingThinking: vi.fn(),
    sealStreaming: vi.fn(),
    startToolCall: vi.fn(),
    finishToolCall: vi.fn((toolUseId: string, lines: { content: string }[], finalKind?: string) => {
      finishToolCalls.push({ toolUseId, lines, finalKind });
      // 模拟真实 Ink adapter:把 lines 内容推进 prints(供文本断言)
      for (const l of lines) prints.push({ text: l.content });
      return true;
    }),
    appendToolHook: vi.fn(() => true),
    flushNow: vi.fn(),
    clearMessages: vi.fn(),
  };
  return { renderer, finishToolCalls, prints };
}

describe('AUTO-0025 Phase B (Task 16b):ask_user_question structured result e2e', () => {
  beforeEach(() => askOutcomeStore.clear());

  it('submitted 完整链路:structuredOutcome → presentation → 结构化渲染(非 Bash 折叠)', () => {
    const { renderer, finishToolCalls, prints } = mockRenderer();
    const pipeline = new BlockPipeline(renderer);

    // 模拟 streaming-query 阶段1:tool_call
    pipeline.emit({
      kind: 'tool_call', name: 'ask_user_question', toolUseId: 'tuu-e2e-1',
      input: { questions: [] },
    });

    // 模拟 Task 14 透传后的 tool_result(带 structuredOutcome,UI 通道)
    const structured: StructuredAskResult = {
      version: 1,
      request: {
        questions: [
          {
            header: 'Auth',
            question: 'Which auth method?',
            options: [{ label: 'OAuth', description: 'd' }, { label: 'Key', description: 'd' }],
            multiSelect: false,
          },
          {
            header: 'Lib',
            question: 'Which library?',
            options: [{ label: 'A', description: 'd' }, { label: 'B', description: 'd' }],
            multiSelect: true,
          },
        ],
      },
      outcome: { kind: 'submitted', answers: { 'Which auth method?': 'OAuth', 'Which library?': 'A, B' } },
    };
    pipeline.emit({
      kind: 'tool_result', name: 'ask_user_question', toolUseId: 'tuu-e2e-1',
      output: 'User has answered your questions: ...',  // API 通道字符串(仍存在,但 UI 不展示它)
      structuredOutcome: structured,
    });

    // ── 必断 1:折叠态(可见区 prints)含 "Answered"(证明走结构化路径,非 Bash 折叠)
    const allText = prints.map(p => p.text).join('\n');
    expect(allText).toContain('Answered');

    // ── 必断 2:折叠态不含 question 全文(证明走 summary,非 raw answers)
    expect(allText).not.toContain('Which auth method?');

    // ── 必断 3:finishToolCall 用了 agent-completion(跳过 call 行)
    expect(finishToolCalls).toHaveLength(1);
    expect(finishToolCalls[0]?.finalKind).toBe('agent-completion');
    // agent-completion 的 lines 只有 resultLines(不含 ● ask_user_question call 行)
    const resultLineContents = finishToolCalls[0]!.lines.map(l => l.content).join('\n');
    expect(resultLineContents).not.toContain('ask_user_question');

    // ── 必断 4:展开态(Ctrl+O,expandable store)含 header → answer 配对,不含 question 全文
    // 注意:展开态行不进 prints(延迟到 Ctrl+O 才渲染),用 getLastExpandableFullLines 访问。
    const expandable = pipeline.getLastExpandableFullLines();
    expect(expandable).not.toBeNull();
    const fullText = expandable!.lines.map(l => l.content).join('\n');
    expect(fullText).toContain('Auth → OAuth');
    expect(fullText).toContain('Lib → A, B');
    expect(fullText).not.toContain('Which auth method?');
  });

  it('cancelled outcome 渲染 Declined', () => {
    const { renderer, prints } = mockRenderer();
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
    const allText = prints.map(p => p.text).join('\n');
    expect(allText.toLowerCase()).toContain('declined');
  });

  it('API 通道零污染:block.output(API 字符串)与 structuredOutcome(UI 对象)并存但不混淆', () => {
    // 此测试验证设计契约:同一个 tool_result 事件携带两个通道的数据,
    // 但 block-pipeline 渲染时只用 structuredOutcome(UI),output(API)不进渲染。
    const { renderer, prints } = mockRenderer();
    const pipeline = new BlockPipeline(renderer);
    pipeline.emit({
      kind: 'tool_call', name: 'ask_user_question', toolUseId: 'tuu-e2e-3',
      input: { questions: [] },
    });
    const apiString = 'User has answered your questions: "q"="A". You can now continue...';
    pipeline.emit({
      kind: 'tool_result', name: 'ask_user_question', toolUseId: 'tuu-e2e-3',
      output: apiString,  // 这是 API 通道的内容
      structuredOutcome: {
        version: 1,
        request: { questions: [{ header: 'Cfg', question: 'q', options: [{ label: 'A', description: 'd' }, { label: 'B', description: 'd' }], multiSelect: false }] },
        outcome: { kind: 'submitted', answers: { q: 'A' } },
      },
    });
    const allText = prints.map(p => p.text).join('\n');
    // UI 渲染走结构化:折叠态含结构化摘要,不含 API 字符串原文
    expect(allText).toContain('Answered');
    expect(allText).not.toContain(apiString);
    expect(allText).not.toContain('You can now continue');
    // 展开态含 header → answer 配对(UI 通道数据),不含 API 字符串
    const expandable = pipeline.getLastExpandableFullLines();
    expect(expandable).not.toBeNull();
    const fullText = expandable!.lines.map(l => l.content).join('\n');
    expect(fullText).toContain('Cfg → A');
    expect(fullText).not.toContain(apiString);
  });
});
