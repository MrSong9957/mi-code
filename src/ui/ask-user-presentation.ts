// src/ui/ask-user-presentation.ts
// AUTO-0025 Phase B (Task 12):ask_user_question 结构化结果 → 展示模型纯函数。
//
// 物理本质:把 UI 通道的 StructuredAskResult 转成 { summary, lines } 展示模型。
// 仿 subagent-presentation.ts 模式:返回结构化结果或 null(null = fallback rawOutput)。
//
// 关键:outcome.answers 的 key 是 question 全文,展示需要 header(短),
// 所以从 request.questions 反查 question→header 映射做配对。

import type { StructuredAskResult } from '../agent/ask-user-types.js';
import type { Translator } from '../locale/types.js';
import type { AskBlock } from '../tui/transcript-types.js';

/** ask_user_question 展示模型(仿 SubagentCompletionPresentation)。 */
export interface AskUserPresentation {
  /** 折叠时单行摘要,如 "Answered 2 questions" / "Declined to answer" */
  summary: string;
  /** 展开时每行内容(不含 ⎿ 前缀,由 block-pipeline 加) */
  lines: string[];
}

const ANSWERED_SUMMARY_KEYS = {
  one: 'ask.presentation.answered.one',
  other: 'ask.presentation.answered.other',
} as const;

function pluralKey(count: number): 'one' | 'other' {
  return count === 1 ? 'one' : 'other';
}

/**
 * 把 StructuredAskResult 转成展示模型。
 *
 * @param result 结构化问卷结果(来自 askOutcomeStore,经 streaming-query 透传)
 * @returns 展示模型,或 null(不识别的 version,调用方回退 rawOutput 通用展示)
 */
export function buildAskUserPresentation(
  result: StructuredAskResult,
  translator: Translator,
): AskUserPresentation | null {
  // version 守卫:不识别的版本回退 null,让调用方走通用 rawOutput 路径(向后兼容)
  if (result.version !== 1) return null;

  const { request, outcome } = result;

  if (outcome.kind === 'cancelled') {
    return {
      summary: translator.t('ask.presentation.declinedSummary'),
      lines: [translator.t('ask.presentation.declinedLine')],
    };
  }

  if (outcome.kind === 'chat') {
    return {
      summary: translator.t('ask.presentation.feedbackSummary', { feedback: outcome.feedback }),
      lines: [outcome.feedback],
    };
  }

  // submitted:用 request.questions 的 header 配对 outcome.answers 的 question 全文。
  // 顺序遵循 request.questions(模型定义的顺序),保证展示稳定。
  const entries = request.questions.map(q => ({
    header: q.header,
    answer: outcome.answers[q.question] ?? translator.t('ask.presentation.noAnswer'),
  }));

  const summary = translator.t(ANSWERED_SUMMARY_KEYS[pluralKey(entries.length)], {
    count: entries.length,
  });
  const lines = entries.map(e => `${e.header} → ${e.answer}`);

  return { summary, lines };
}

/**
 * 把任意值安全转成 AskBlock。
 *
 * 包装 {@link buildAskUserPresentation}:接受 unknown,非 version-1 StructuredAskResult
 * 或畸形嵌套时返回 null(不抛穿 pipeline)。保留 submitted/cancelled/chat 三种 outcome
 * 的精确 summary/items。
 *
 * @param id     AskBlock 的唯一 id(通常用 toolUseId)
 * @param result 任意值(通常是 StructuredAskResult)
 * @returns AskBlock 或 null(null → 调用方走通用 tool fallback)
 */
export function buildAskBlock(id: string, result: unknown, translator: Translator): AskBlock | null {
  if (result === null || typeof result !== 'object') return null;
  const r = result as { version?: unknown; request?: unknown; outcome?: unknown };
  if (r.version !== 1 || !r.request || !r.outcome) return null;

  let presentation: AskUserPresentation | null = null;
  try {
    presentation = buildAskUserPresentation(r as StructuredAskResult, translator);
  } catch {
    return null;
  }
  if (!presentation) return null;

  const block: AskBlock = {
    id,
    kind: 'ask',
    summary: presentation.summary,
    items: presentation.lines,
  };

  // 保留原始 outcome(submitted/cancelled/chat),供下游消费。
  const outcome = r.outcome as StructuredAskResult['outcome'];
  if (outcome) {
    block.outcome = outcome;
  }

  return block;
}
