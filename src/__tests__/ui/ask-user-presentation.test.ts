// src/__tests__/ui/ask-user-presentation.test.ts
// AUTO-0025 Phase B (Task 12):buildAskUserPresentation 纯函数测试。
//
// 物理本质:把 StructuredAskResult(UI 通道的结构化数据)转成展示模型。
// 返回 { summary, lines } 供 block-pipeline 渲染折叠态(⎿ Answered N questions)
// 与展开态(header → answer 配对)。null 表示不识别的版本,调用方回退 rawOutput。

import { describe, it, expect } from 'vitest';
import { buildAskUserPresentation } from '../../ui/ask-user-presentation.js';
import type { StructuredAskResult } from '../../agent/ask-user-types.js';

const makeResult = (overrides: Partial<StructuredAskResult> = {}): StructuredAskResult => ({
  version: 1,
  request: {
    questions: [
      {
        header: 'Auth',
        question: 'How to auth?',
        options: [
          { label: 'OAuth', description: 'd' },
          { label: 'Key', description: 'd' },
        ],
        multiSelect: false,
      },
      {
        header: 'Lib',
        question: 'Which lib?',
        options: [
          { label: 'A', description: 'd' },
          { label: 'B', description: 'd' },
        ],
        multiSelect: true,
      },
    ],
  },
  outcome: { kind: 'submitted', answers: { 'How to auth?': 'OAuth', 'Which lib?': 'A, B' } },
  ...overrides,
});

describe('buildAskUserPresentation', () => {
  it('submitted:折叠摘要含数量 + 展开 header→answer 配对', () => {
    const p = buildAskUserPresentation(makeResult());
    expect(p).not.toBeNull();
    expect(p!.summary).toContain('2');  // Answered 2 questions
    // 展开行用 header(短)配对 answer,不用 question 全文
    expect(p!.lines.some(l => l.includes('Auth') && l.includes('OAuth'))).toBe(true);
    expect(p!.lines.some(l => l.includes('Lib') && l.includes('A, B'))).toBe(true);
    // 不应出现 question 全文(证明走 header 配对,非 raw answers)
    expect(p!.lines.some(l => l.includes('How to auth?'))).toBe(false);
  });

  it('submitted 单个问题:summary 用单数 question', () => {
    const p = buildAskUserPresentation({
      version: 1,
      request: {
        questions: [{
          header: 'Auth',
          question: 'q1',
          options: [{ label: 'A', description: 'd' }, { label: 'B', description: 'd' }],
          multiSelect: false,
        }],
      },
      outcome: { kind: 'submitted', answers: { q1: 'A' } },
    });
    expect(p!.summary).toBe('Answered 1 question');
  });

  it('cancelled:Declined', () => {
    const p = buildAskUserPresentation(makeResult({ outcome: { kind: 'cancelled' } }));
    expect(p!.summary.toLowerCase()).toMatch(/declined/);
  });

  it('chat:含 feedback 文本', () => {
    const p = buildAskUserPresentation(makeResult({ outcome: { kind: 'chat', feedback: 'need more info' } }));
    expect(p!.summary).toContain('need more info');
  });

  it('submitted 某问题无答案:用 placeholder (no answer)', () => {
    const p = buildAskUserPresentation({
      version: 1,
      request: {
        questions: [{
          header: 'Auth',
          question: 'q1',
          options: [{ label: 'A', description: 'd' }, { label: 'B', description: 'd' }],
          multiSelect: false,
        }],
      },
      outcome: { kind: 'submitted', answers: {} },  // 无答案
    });
    expect(p!.lines.some(l => l.includes('Auth') && l.toLowerCase().includes('no answer'))).toBe(true);
  });

  it('不支持的 version:返回 null(fallback rawOutput)', () => {
    const p = buildAskUserPresentation({ version: 99, request: makeResult().request, outcome: makeResult().outcome } as StructuredAskResult);
    expect(p).toBeNull();
  });
});
