// UI 问卷 answer → UserDecision 的精确映射。
// 物理本质:柜台三按钮,只有前两个能放行,其余一律视为拒绝。
// 关键安全不变量:Reject / unknown / empty / 非 submitted 绝不映射成 approved_once。
import { SECURITY_PROTOCOL_VERSION, type UserDecision } from './decisions.js';
import type { AskQuestionOutcome } from '../agent/ask-user-types.js';

/** 两个放行选项的文案常量(单一真相源)。
 * mapPermissionAnswerToUserDecision 精确匹配;index.ts 构造 Permission options 也用这两个常量,
 * 不再重复硬编码 label,保证 UI 显示与 answer 映射永远一致。 */
export const ALLOW_ONCE_LABEL = 'Allow once';
export const ALLOW_EXACT_LABEL = 'Allow this exact action for this session';

export function mapPermissionAnswerToUserDecision(
  decisionId: string,
  outcome: AskQuestionOutcome,
): UserDecision {
  const base = {
    protocol_version: SECURITY_PROTOCOL_VERSION,
    decision_id: decisionId,
    decided_at: new Date().toISOString(),
  };

  // 非 submitted(cancelled / chat)→ rejected
  if (outcome.kind !== 'submitted') {
    return { ...base, response: 'rejected' };
  }

  // submitted:取第一个 answer(单选问卷)。无值 → rejected
  const answer = Object.values(outcome.answers)[0];
  if (answer === undefined) {
    return { ...base, response: 'rejected' };
  }

  // 精确匹配两个放行选项;其余一律 rejected
  if (answer === ALLOW_ONCE_LABEL) {
    return { ...base, response: 'approved_once', remember: false };
  }
  if (answer === ALLOW_EXACT_LABEL) {
    return { ...base, response: 'approved_once', remember: true };
  }
  // Reject / unknown → rejected(绝不 approved_once)
  return { ...base, response: 'rejected' };
}
