// src/ui/ask-user-presentation.ts
// AUTO-0025 Phase B (Task 12):ask_user_question 结构化结果 → 展示模型纯函数。
//
// 物理本质:把 UI 通道的 StructuredAskResult 转成 { summary, lines } 展示模型。
// 仿 subagent-presentation.ts 模式:返回结构化结果或 null(null = fallback rawOutput)。
//
// 关键:outcome.answers 的 key 是 question 全文,展示需要 header(短),
// 所以从 request.questions 反查 question→header 映射做配对。

import type { StructuredAskResult } from '../agent/ask-user-types.js';

/** ask_user_question 展示模型(仿 SubagentCompletionPresentation)。 */
export interface AskUserPresentation {
  /** 折叠时单行摘要,如 "Answered 2 questions" / "Declined to answer" */
  summary: string;
  /** 展开时每行内容(不含 ⎿ 前缀,由 block-pipeline 加) */
  lines: string[];
}

/**
 * 把 StructuredAskResult 转成展示模型。
 *
 * @param result 结构化问卷结果(来自 askOutcomeStore,经 streaming-query 透传)
 * @returns 展示模型,或 null(不识别的 version,调用方回退 rawOutput 通用展示)
 */
export function buildAskUserPresentation(result: StructuredAskResult): AskUserPresentation | null {
  // version 守卫:不识别的版本回退 null,让调用方走通用 rawOutput 路径(向后兼容)
  if (result.version !== 1) return null;

  const { request, outcome } = result;

  if (outcome.kind === 'cancelled') {
    return {
      summary: 'Declined to answer',
      lines: ['User declined to answer questions'],
    };
  }

  if (outcome.kind === 'chat') {
    return {
      summary: `Feedback: ${outcome.feedback}`,
      lines: [outcome.feedback],
    };
  }

  // submitted:用 request.questions 的 header 配对 outcome.answers 的 question 全文。
  // 顺序遵循 request.questions(模型定义的顺序),保证展示稳定。
  const entries = request.questions.map(q => ({
    header: q.header,
    answer: outcome.answers[q.question] ?? '(no answer)',
  }));

  const summary = `Answered ${entries.length} question${entries.length === 1 ? '' : 's'}`;
  const lines = entries.map(e => `${e.header} → ${e.answer}`);

  return { summary, lines };
}
