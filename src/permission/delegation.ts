/**
 * Wave C Task 10 (M-067 / CRC-5): Delegation Least-Privilege Gate.
 *
 * 物理本质: 项目经理(parent)派临时工(child)前的"权限审计窗口"。
 *
 *   - allow_once: child 的 scope/tools/mode 全部 ⊆ parent, 且 local + read-only + trusted
 *   - awaiting_user: child 请求触及扩张/side-effect/cross-machine, 需要用户显式批准
 *   - denied: 需要 ask 但无 channel (no_channel), 或 provenance 缺失
 *
 * 关键不变量 (INV-C10 / 规格 §11.3):
 *   1. 每次 delegation 都必须经过 policy evaluation
 *   2. child scope 不能超过 parent objective/scope
 *   3. child tool view 不能比 parent 当前可用视图更宽
 *   4. child control mode 不能绕过 parent Plan/side-effect boundary
 *   5. 跨机器/unknown provenance/side-effect/扩张 → 不可自动 allow
 *   6. local+read-only+同scope → 可由明确确定性 policy allow once
 *   7. ask 必须消费 BRC-6 PendingSecurityDecision, 无通道 deny
 *   8. approval 只绑定当前 delegation/action snapshot
 *
 * 不实现: delegation handoff classifier (Task 11), delegation Prompt 文本授权。
 *
 * Spec: docs/superpowers/specs/2026-07-26-agent-policy-contracts-wave-c-design.md §11.2/§11.3
 */

import { freezeSnapshot, requireIdentity } from '../agent/contracts/identities.js';
import { RuntimeSecurityGate } from './runtime-gate.js';
import type { UserDecisionChannel, PendingDecisionStore } from './runtime-gate.js';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Public types (frozen per spec §11.2/§11.3)
// ---------------------------------------------------------------------------

export const DELEGATION_PROTOCOL_VERSION = '1';

/**
 * Delegation 请求 (spec §11.2).
 * 由 spawn-agent-tool 在派发前构造, 绑定 parent session/turn/action snapshot。
 */
export interface DelegationRequest {
  delegation_protocol_version: string;
  delegation_id: string;
  parent_session_id: string;
  parent_turn_id: string;
  parent_action_snapshot_id: string;
  role_profile_snapshot_id: string;
  task_scope_ref: string;
  requested_tool_ids: string[];
  requested_control_mode: string;
  context_source_refs: string[];
  permission_snapshot_id: string;
  action_provenance_ref: string;
}

/**
 * Gate 决策依赖: parent 当前边界 + provenance + side-effect 判定 + 可选 ask channel。
 *
 * action_provenance 复用 BRC-6 的 ActionProvenance 形状 (origin_scope/content_trust 等),
 * 但这里只读不写, 不构造完整 ActionProvenance 对象。
 */
export interface DelegationGateDependencies {
  /** parent 当前 task scope (child 的 task_scope_ref 必须是其子集或相等) */
  parent_scope: string;
  /** parent 当前可用 tool ids (child 的 requested_tool_ids 必须是其子集) */
  parent_tool_ids: string[];
  /** parent 当前 control mode (child 的 requested_control_mode rank 不能更高) */
  parent_control_mode: string;
  /** action provenance (origin_scope: local/cross_machine/unknown) */
  action_provenance: {
    origin_scope: 'local' | 'cross_machine' | 'unknown';
    origin_ref: string;
    propagation_refs: string[];
    content_trust: 'trusted' | 'untrusted' | 'unknown';
  };
  /** 判定一个 tool 是否有 side-effect (write/delete/network 等) */
  isToolSideEffect: (toolId: string) => boolean;
  /** 关联的 SecurityDecision id (用于 trace, 由调用方在 PermissionChecker 侧产生) */
  securityDecisionRef: string;
  /** 可选: ask 通道 (无则 ask 降级为 denied no_channel) */
  askChannel?: UserDecisionChannel | null;
  /** 可选: pending store (有 askChannel 时必需) */
  pendingStore?: PendingDecisionStore;
  /** 可选: session id (用于 pending store) */
  sessionId?: string;
}

/**
 * Gate 决策结果 (spec §11.3).
 */
export interface DelegationGateDecision {
  delegation_id: string;
  security_decision_ref: string;
  effective_task_scope_ref: string | null;
  effective_tool_view_snapshot_id: string | null;
  effective_control_mode: string | null;
  status: 'allowed_once' | 'awaiting_user' | 'denied';
  reason_codes: string[];
}

// ---------------------------------------------------------------------------
// Control mode ranking (spec §11.3 rule 4: child mode 不能绕过 parent boundary)
//
// plan < build: plan 是只读规划(不执行副作用), build 可执行。
// child 的 mode rank 不能高于 parent (即 child=build + parent=plan 是扩张)。
// ---------------------------------------------------------------------------

const CONTROL_MODE_RANK: Readonly<Record<string, number>> = Object.freeze({
  plan: 0,
  build: 1,
});

function modeRank(mode: string): number {
  return CONTROL_MODE_RANK[mode] ?? 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 评估 delegation gate (spec §11.3).
 *
 * 算法:
 *   1. 计算 scope/tool/mode/side-effect/origin 的扩张情况
 *   2. 全部满足 (local + read-only + same scope + subset tools + mode ≤ parent + trusted)
 *      → allowed_once
 *   3. 任一扩张/side-effect/non-local → 需要 ask
 *      - askChannel 存在 → 走 RuntimeSecurityGate, 返回 awaiting_user 的最终结果
 *        (approved_once → allowed_once; rejected → denied)
 *      - askChannel 不存在 → denied (no_channel)
 *   4. provenance 缺失 (action_provenance_ref empty) → denied
 *
 * 返回 frozen DelegationGateDecision。
 */
export async function evaluateDelegationGate(
  request: DelegationRequest,
  deps: DelegationGateDependencies,
): Promise<DelegationGateDecision> {
  // identity 守门
  requireIdentity(request.delegation_id, 'delegation_id');
  requireIdentity(request.parent_action_snapshot_id, 'parent_action_snapshot_id');
  requireIdentity(request.action_provenance_ref, 'action_provenance_ref');
  requireIdentity(deps.securityDecisionRef, 'securityDecisionRef');

  const reason_codes: string[] = [];

  // --- 扩张检测 ---
  // scope: child task_scope_ref 必须等于 parent_scope (本 Wave 不实现 scope 层级包含,
  // 只做精确匹配; 后续 Wave 可引入 scope tree)
  const scopeExpanded = request.task_scope_ref !== deps.parent_scope;
  if (scopeExpanded) {
    reason_codes.push('delegation.scope_expanded');
  }

  // tools: 任一 requested tool 不在 parent_tool_ids 内
  const parentToolSet = new Set(deps.parent_tool_ids);
  const toolExpanded = request.requested_tool_ids.some((t) => !parentToolSet.has(t));
  if (toolExpanded) {
    reason_codes.push('delegation.tool_expanded');
  }

  // mode: child mode rank > parent mode rank
  const modeExpanded = modeRank(request.requested_control_mode) > modeRank(deps.parent_control_mode);
  if (modeExpanded) {
    reason_codes.push('delegation.mode_expanded');
  }

  // side-effect: 任一 requested tool 有 side-effect
  const hasSideEffect = request.requested_tool_ids.some((t) => deps.isToolSideEffect(t));
  if (hasSideEffect) {
    reason_codes.push('delegation.side_effect_tool');
  }

  // origin: 非 local 都需要 ask
  const nonLocalOrigin = deps.action_provenance.origin_scope !== 'local';
  if (nonLocalOrigin) {
    reason_codes.push(`delegation.non_local_origin:${deps.action_provenance.origin_scope}`);
  }

  // untrusted content 也需要 ask
  const untrustedContent = deps.action_provenance.content_trust !== 'trusted';
  if (untrustedContent) {
    reason_codes.push(`delegation.untrusted_content:${deps.action_provenance.content_trust}`);
  }

  // --- 决策 ---
  const needsAsk =
    scopeExpanded || toolExpanded || modeExpanded || hasSideEffect || nonLocalOrigin || untrustedContent;

  if (!needsAsk) {
    // 全部满足: local + read-only + same scope + subset tools + mode ≤ parent + trusted
    return freezeSnapshot<DelegationGateDecision>({
      delegation_id: request.delegation_id,
      security_decision_ref: deps.securityDecisionRef,
      effective_task_scope_ref: request.task_scope_ref,
      effective_tool_view_snapshot_id: null, // 由 Task 11 handoff 填充
      effective_control_mode: request.requested_control_mode,
      status: 'allowed_once',
      reason_codes: [],
    });
  }

  // 需要 ask
  // askChannel 不存在 → denied (no_channel)
  if (!deps.askChannel) {
    return freezeSnapshot<DelegationGateDecision>({
      delegation_id: request.delegation_id,
      security_decision_ref: deps.securityDecisionRef,
      effective_task_scope_ref: null,
      effective_tool_view_snapshot_id: null,
      effective_control_mode: null,
      status: 'denied',
      reason_codes: [...reason_codes, 'ask.no_channel'],
    });
  }

  if (!deps.pendingStore) {
    // 有 channel 但无 store → 无法持久化 pending, fail closed
    return freezeSnapshot<DelegationGateDecision>({
      delegation_id: request.delegation_id,
      security_decision_ref: deps.securityDecisionRef,
      effective_task_scope_ref: null,
      effective_tool_view_snapshot_id: null,
      effective_control_mode: null,
      status: 'denied',
      reason_codes: [...reason_codes, 'ask.no_pending_store'],
    });
  }

  // 走 RuntimeSecurityGate: 构造一个 ask SecurityDecision, 让 gate 阻塞等用户
  const gate = new RuntimeSecurityGate({
    pendingStore: deps.pendingStore,
    channel: deps.askChannel,
    sessionId: deps.sessionId ?? request.parent_session_id,
  });

  // 构造 ask decision (复用 SecurityDecision 结构)
  // decision_id 用 securityDecisionRef, action_snapshot_id 用 parent_action_snapshot_id
  const askDecision = {
    protocol_version: '1',
    decision_id: deps.securityDecisionRef,
    action: {
      kind: 'delegation',
      subject_id: request.delegation_id,
      snapshot_id: request.parent_action_snapshot_id,
    },
    behavior: 'ask' as const,
    deciding_layer: 'delegation_gate',
    risk_kind: 'delegation_expansion',
    policy_id: 'delegation-least-privilege',
    policy_version: '1',
    reason_code: reason_codes[0] ?? 'delegation.needs_ask',
    human_reason: `Delegation ${request.delegation_id} requires user approval: ${reason_codes.join(', ')}`,
    provenance_refs: [request.action_provenance_ref],
  };

  const outcome = await gate.authorize(askDecision);

  if (outcome.kind === 'authorized') {
    // 用户 approved_once → allowed_once (但 effective 边界仍受限: child 不能扩张)
    return freezeSnapshot<DelegationGateDecision>({
      delegation_id: request.delegation_id,
      security_decision_ref: deps.securityDecisionRef,
      // 即使 approved, effective 边界仍是 parent 边界与请求的交集 (least privilege)
      effective_task_scope_ref: deps.parent_scope,
      effective_tool_view_snapshot_id: null,
      effective_control_mode: deps.parent_control_mode,
      status: 'allowed_once',
      reason_codes,
    });
  }

  // denied (user rejected / channel failed / stale)
  return freezeSnapshot<DelegationGateDecision>({
    delegation_id: request.delegation_id,
    security_decision_ref: deps.securityDecisionRef,
    effective_task_scope_ref: null,
    effective_tool_view_snapshot_id: null,
    effective_control_mode: null,
    status: 'denied',
    reason_codes: [...reason_codes, outcome.reason_code],
  });
}

// ===========================================================================
// Wave C Task 11 (CRC-5 §11.4): Delegation Handoff Envelope
//
// 物理本质: 子代理干完活后, 把"工作成果"装进一个带封条的密封袋交给父代理。
// 封条上写着 "untrusted" —— 父代理必须自己拆开验证, 不能直接当真。
//
// 关键不变量 (规格 §11.4):
//   1. child result 默认 untrusted/unknown, 不允许直接成为 instruction
//   2. CompletionReport 结构合法不代表内容正确
//   3. parent 必须验证独立交付物和 evidence
//   4. result sanitizer 失败时不得把正文注入 parent Prompt
//   5. warning prefix 不能提升 trust
//   6. background DispatchReceipt 不等于 handoff completion
//   7. child 的 permission decision 不自动传播为 parent permission
// ===========================================================================

export const HANDOFF_PROTOCOL_VERSION = '1';

/**
 * Handoff envelope 输入 (spec §11.4)。
 *
 * 调用方(subagent 完成后)提供:
 *   - delegation_id / child_session_id / child_profile_snapshot_id: 身份
 *   - completion_report_ref: RC-4 CompletionReport 的 ref (空串 = dispatch-only)
 *   - result_content_ref: child 输出正文的 ref
 *   - sanitization_result_ref / sanitization_accepted: BRC-3 sanitizer 结果
 *   - completion_report_valid: CompletionReport 结构是否合法
 *   - verification_evidence_refs: 独立验证证据
 *   - warning_codes: 非阻塞警告(不提升 trust)
 */
export interface DelegationHandoffInput {
  delegation_id: string;
  child_session_id: string;
  child_profile_snapshot_id: string;
  completion_report_ref: string;
  result_content_ref: string;
  sanitization_result_ref: string;
  sanitization_accepted: boolean;
  completion_report_valid: boolean;
  verification_evidence_refs: string[];
  warning_codes: string[];
}

/**
 * Handoff envelope (spec §11.4 DelegationHandoffEnvelope)。
 *
 * result_trust 永远是 'untrusted' 或 'unknown', 绝不 'trusted'。
 * result_content_ref 在 CompletionReport 无效或 sanitizer 失败时为 null。
 */
export interface DelegationHandoffEnvelope {
  handoff_protocol_version: string;
  handoff_envelope_id: string;
  delegation_id: string;
  child_session_id: string;
  child_profile_snapshot_id: string;
  completion_report_ref: string;
  result_content_ref: string | null;
  result_trust: 'untrusted' | 'unknown';
  provenance_refs: string[];
  sanitization_result_ref: string;
  verification_evidence_refs: string[];
  warning_codes: string[];
}

/**
 * 构造一份 DelegationHandoffEnvelope (spec §11.4)。
 *
 * 算法:
 *   1. child result 默认 untrusted (绝不 trusted, 规格 rule 1)
 *   2. completion_report_valid=false 或 sanitization_accepted=false
 *      → result_content_ref=null (正文不进入 parent, 规格 rule 4)
 *   3. completion_report_ref 为空(dispatch-only)→ result_content_ref=null (规格 rule 6)
 *   4. warning_codes 原样保留, 但不影响 result_trust (规格 rule 5)
 *   5. provenance_refs = [delegation_id, child_session_id, sanitization_result_ref]
 *
 * 返回 frozen envelope。
 */
export function createDelegationHandoffEnvelope(
  input: DelegationHandoffInput,
): DelegationHandoffEnvelope {
  requireIdentity(input.delegation_id, 'delegation_id');
  requireIdentity(input.child_session_id, 'child_session_id');
  requireIdentity(input.child_profile_snapshot_id, 'child_profile_snapshot_id');
  requireIdentity(input.sanitization_result_ref, 'sanitization_result_ref');

  // child result 默认 untrusted (规格 §11.4 rule 1)
  // 即使所有证据齐全, 仍是 untrusted —— parent 必须独立验证
  const result_trust: 'untrusted' | 'unknown' = 'untrusted';

  // 决定 result_content_ref 是否可见
  // 规格 rule 4: sanitizer 失败 → 正文不进入 parent
  // 规格 rule 6: DispatchReceipt (无 completion_report_ref) → 不能构造 completion
  const contentVisible =
    input.completion_report_valid &&
    input.sanitization_accepted &&
    input.completion_report_ref.length > 0;
  const result_content_ref = contentVisible ? input.result_content_ref : null;

  // provenance: 记录 envelope 的来源链 (不携带 trust)
  const provenance_refs = [
    `delegation:${input.delegation_id}`,
    `child_session:${input.child_session_id}`,
    `sanitization:${input.sanitization_result_ref}`,
  ];

  // handoff_envelope_id: 确定性派生 (sha256 of canonical)
  const canonical = JSON.stringify({
    delegation_id: input.delegation_id,
    child_session_id: input.child_session_id,
    child_profile_snapshot_id: input.child_profile_snapshot_id,
    completion_report_ref: input.completion_report_ref,
    result_content_ref,
    result_trust,
    sanitization_result_ref: input.sanitization_result_ref,
    verification_evidence_refs: [...input.verification_evidence_refs].sort(),
    warning_codes: [...input.warning_codes].sort(),
  });
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);

  return freezeSnapshot<DelegationHandoffEnvelope>({
    handoff_protocol_version: HANDOFF_PROTOCOL_VERSION,
    handoff_envelope_id: `handoff:${hash}`,
    delegation_id: input.delegation_id,
    child_session_id: input.child_session_id,
    child_profile_snapshot_id: input.child_profile_snapshot_id,
    completion_report_ref: input.completion_report_ref,
    result_content_ref,
    result_trust,
    provenance_refs,
    sanitization_result_ref: input.sanitization_result_ref,
    verification_evidence_refs: [...input.verification_evidence_refs],
    warning_codes: [...input.warning_codes],
  });
}
