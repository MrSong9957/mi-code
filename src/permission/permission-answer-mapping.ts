// UI 问卷 answer → UserDecision 的精确映射。
// 物理本质:柜台三按钮,只有前两个能放行,其余一律视为拒绝。
// 关键安全不变量:Reject / unknown / empty / 非 submitted 绝不映射成 approved_once。
import { SECURITY_PROTOCOL_VERSION, type UserDecision } from './decisions.js';
import type { DialogResult } from './interactive-ask.js';
import type { AskQuestionOutcome } from '../agent/ask-user-types.js';

export const PERMISSION_ANSWER_VALUES = {
  allowOnce: 'permission.allowOnce',
  allowExactSession: 'permission.allowExactSession',
  allowAlways: 'permission.allowAlways',
  reject: 'permission.reject',
} as const;

function firstSubmittedAnswerValue(outcome: AskQuestionOutcome): string | undefined {
  if (outcome.kind !== 'submitted') return undefined;
  if (!Object.values(outcome.answers)[0]) return undefined;
  return Object.values(outcome.answerValues ?? {})[0];
}

export function mapPermissionAnswerToUserDecision(
  decisionId: string,
  outcome: AskQuestionOutcome,
): UserDecision {
  const base = {
    protocol_version: SECURITY_PROTOCOL_VERSION,
    decision_id: decisionId,
    decided_at: new Date().toISOString(),
  };

  const answerValue = firstSubmittedAnswerValue(outcome);
  if (answerValue === PERMISSION_ANSWER_VALUES.allowOnce) {
    return { ...base, response: 'approved_once', remember: false };
  }
  if (answerValue === PERMISSION_ANSWER_VALUES.allowExactSession) {
    return { ...base, response: 'approved_once', remember: true };
  }
  return { ...base, response: 'rejected' };
}

/**
 * auto permission dialog 问卷 outcome → DialogResult（spec §5.2 adapter 边界）。
 * 纯函数：只做映射，不触发副作用。cancelled→escape 安全性见 spec §3 / §7.3 #8。
 */
export function mapDialogResult(outcome: AskQuestionOutcome): DialogResult {
  if (outcome.kind !== 'submitted') {
    return outcome.kind === 'cancelled' ? { kind: 'escape' } : { kind: 'rejected' };
  }
  const answerValue = firstSubmittedAnswerValue(outcome);
  if (answerValue === PERMISSION_ANSWER_VALUES.allowOnce) return { kind: 'approved_once' };
  if (answerValue === PERMISSION_ANSWER_VALUES.allowExactSession) return { kind: 'approved_session' };
  if (answerValue === PERMISSION_ANSWER_VALUES.allowAlways) return { kind: 'approved_always' };
  return { kind: 'rejected' };
}
