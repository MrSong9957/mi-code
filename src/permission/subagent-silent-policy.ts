// 子代理静默执行策略:把"已通过 PermissionChecker 安全判定的 ask"按 reason_code 分流。
// deny/allow 透传(引用相等);ask 按 reason_code 别名分流。未知 ask fail-closed deny。
//
// 关键不变量:
//   1. deny / allow 透传,返回同一引用(零分配);
//   2. SecurityDecision 是 frozen,改写一律经 createSecurityDecision 构造 NEW 对象;
//   3. 未知 ask fail-closed 为 deny(绝不静默放行未知类别);
//   4. rewriteToAllow 仅供 session allowlist 命中场景(Task 5)使用,不在此处自动触发。

import { createSecurityDecision, SECURITY_PROTOCOL_VERSION, type SecurityDecision } from './decisions.js';

/** safety_uncertain 别名:checker 产出的"无法确认安全"类 reason_code。 */
const SAFETY_UNCERTAIN = new Set([
  'permission.command_unparseable',
  'permission.command_unresolvable_var',
]);
/** build 写确认别名:已通过危险/越界检查,仅策略要求确认。 */
const BUILD_WRITE_CONFIRMATION = 'permission.user_confirmation_required';

/** rewriteToAllow 命中 allowlist 时的 reason_code。 */
const SESSION_ALLOWLIST_HIT = 'permission.session_allowlist_hit';

/** rewrite 辅助的默认 provenance 标签(用于 provenance 为空的 deny 派生场景)。 */
const PROVENANCE_TAG = 'permission:subagent-silent-policy';

/** rewriteToAllow 在 base 无 provenance 时注入的 allowlist 来源标签。 */
const ALLOWLIST_PROVENANCE_TAG = 'permission:session-allowlist';

/**
 * 应用子代理静默执行策略:
 * - deny / allow → 透传(引用相等,零分配);
 * - ask + BUILD_WRITE_CONFIRMATION → 静默 allow;
 * - ask + SAFETY_UNCERTAIN → 静默 deny;
 * - 未知 ask → fail-closed deny。
 *
 * 注意:调用方必须保证输入 decision 已经过完整 PermissionChecker 安全判定;
 * 此函数只负责把"已判定安全但需人类确认"的 ask 在子代理上下文里静默化。
 */
export function applySubagentSilentPolicy(decision: SecurityDecision): SecurityDecision {
  if (decision.behavior === 'deny' || decision.behavior === 'allow') {
    return decision; // 透传,引用相等
  }
  const rc = decision.reason_code;
  if (rc === BUILD_WRITE_CONFIRMATION) {
    return rewriteDecision(decision, 'allow', 'permission.subagent.silent_allow.build_write');
  }
  if (SAFETY_UNCERTAIN.has(rc)) {
    return rewriteDecision(decision, 'deny', 'permission.subagent.silent_deny.safety_uncertain');
  }
  return rewriteDecision(decision, 'deny', 'permission.subagent.silent_deny.unknown_ask');
}

/**
 * 把任意 base 决策改写为 allow,reason_code 固定为 session_allowlist_hit。
 * 供 session allowlist 命中场景(Task 5)使用:exact-match 命中后绕过 ask。
 *
 * 保留 action / identity / provenance,仅切换 behavior 与 reason_code。
 * 经 createSecurityDecision 构造 NEW frozen 对象,绝不原地修改 base。
 */
export function rewriteToAllow(base: SecurityDecision): SecurityDecision {
  return rewriteDecision(base, 'allow', SESSION_ALLOWLIST_HIT, ALLOWLIST_PROVENANCE_TAG);
}

/**
 * 共享 rewrite helper:用 createSecurityDecision 构造一个新的 frozen SecurityDecision,
 * 复制 base 的 action / identity / provenance,只覆盖 behavior 与 reason_code。
 *
 * provenance 规则:若 base 无 provenance 则注入 fallbackTag(allow 仍满足"非空 provenance"约束)。
 */
function rewriteDecision(
  base: SecurityDecision,
  behavior: 'allow' | 'deny',
  reasonCode: string,
  fallbackTag: string = PROVENANCE_TAG,
): SecurityDecision {
  return createSecurityDecision({
    protocol_version: SECURITY_PROTOCOL_VERSION,
    decision_id: base.decision_id,
    action: { ...base.action },
    behavior,
    deciding_layer: base.deciding_layer,
    risk_kind: base.risk_kind,
    policy_id: base.policy_id,
    policy_version: base.policy_version,
    reason_code: reasonCode,
    human_reason: base.human_reason,
    provenance_refs:
      base.provenance_refs.length > 0 ? [...base.provenance_refs] : [fallbackTag],
  });
}
