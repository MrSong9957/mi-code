// RC-5 SecurityDecision：可签名、可追踪、provenance 完整的结构化决策单。
//
// 物理本质：安检员开出的正式通行单。
//   - 旧 PermissionDecision { behavior, reason } 像口头放行/拦截；
//   - SecurityDecision 是书面单据——带身份、带原因码、带来源引用、带协议版本，
//     跨进程跨边界都能验明正身。
//
// 关键不变量（spec §11.6）：
//   1. 所有身份字段非空（requireIdentity）；
//   2. behavior 只能是 allow|ask|deny，未知值 fail closed（创建处 throw）；
//   3. allow 必须有 provenance（无来源不能放行，spec §11.6.5）；
//   4. 输出是 frozen 的深拷贝；
//   5. 输出 NEVER 携带 approved 字段（Wave A 不实现 ask 通道）；
//   6. human_reason 仅用于人类阅读，绝不参与机器分支判断。
//
// 合并规则（mergeSecurityDecisions，spec §11.6.8）：
//   - 显式 rank map: allow=0 < ask=1 < deny=2（绝不字符串比较）；
//   - 取最严格的行为（rank 最大）；
//   - 同 rank 内按 deciding_layer ASC、decision_id ASC 决出 winner；
//   - provenance 是全部输入的并集（去重+排序）；
//   - 空输入 → 确定性 "missing policy" deny（fail closed）。

import { requireIdentity, freezeSnapshot } from '../agent/contracts/identities.js';

/** Wave A 安全协议版本（硬编码 '1'） */
export const SECURITY_PROTOCOL_VERSION = '1';

/** behavior 顺序由显式 rank map 决定，绝不依赖字符串序（spec §11.6.8） */
const behaviorRank = { allow: 0, ask: 1, deny: 2 } as const;

/** 合法的 SecurityDecision behavior 集合 */
const ALLOWED_BEHAVIORS = new Set<string>(['allow', 'ask', 'deny']);

/**
 * 安全动作：被判定的事物。
 * - kind：动作类别（'tool_call' / 'command' / 'path_write' / ...）
 * - subject_id：工具名 / 命令哈希 / 路径等动作主体的稳定标识
 * - snapshot_id：动作 payload 的哈希/身份
 */
export interface SecurityAction {
  kind: string;
  subject_id: string;
  snapshot_id: string;
}

/**
 * 安全决策：安检员开出的正式单据。
 *
 * 注意：`human_reason` 只是人类可读的解释，任何机器分支判断都不应读取它。
 */
export interface SecurityDecision {
  protocol_version: string;
  decision_id: string;
  action: SecurityAction;
  behavior: 'allow' | 'ask' | 'deny';
  deciding_layer: string;
  risk_kind: string;
  policy_id: string;
  policy_version: string;
  reason_code: string;
  human_reason: string;
  provenance_refs: string[];
}

/**
 * 用户对 ask 决策的回应（Wave A 仅定义类型，不实现 ask 通道）。
 *
 * 注意：UserDecision 只有 approved_once / rejected 两种 response，
 * 它没有 `approved` boolean 字段——这是有意的设计，避免与口头 "approved"
 * 字符串混淆。
 */
export interface UserDecision {
  protocol_version: string;
  decision_id: string;
  response: 'approved_once' | 'rejected';
  decided_at: string;
}

/**
 * 创建 SecurityDecision 的输入（与 SecurityDecision 字段同构，但 action 是平铺数据）。
 */
export interface CreateSecurityDecisionInput {
  protocol_version: string;
  decision_id: string;
  action: SecurityAction;
  behavior: 'allow' | 'ask' | 'deny';
  deciding_layer: string;
  risk_kind: string;
  policy_id: string;
  policy_version: string;
  reason_code: string;
  human_reason: string;
  provenance_refs: string[];
}

/**
 * 创建一个 SecurityDecision。
 *
 * 校验顺序：
 *   1. 身份字段非空（requireIdentity）—— protocol_version, decision_id,
 *      action.subject_id, action.snapshot_id, policy_id, policy_version,
 *      reason_code, deciding_layer；
 *   2. behavior 必须是 allow|ask|deny —— 未知值 THROW（让调用方知道传错）；
 *   3. allow + 空 provenance_refs → throw（无来源不能放行）；
 *   4. provenance_refs 必须是 string[]；
 *   5. 深拷贝 action + provenance_refs 后冻结。
 *
 * 返回的决策单 NEVER 含 approved 字段。
 */
export function createSecurityDecision(input: CreateSecurityDecisionInput): SecurityDecision {
  // 1. 身份校验（requireIdentity 统一抛出带字段名的错误）
  requireIdentity(input.protocol_version, 'protocol_version');
  requireIdentity(input.decision_id, 'decision_id');
  requireIdentity(input.deciding_layer, 'deciding_layer');
  requireIdentity(input.policy_id, 'policy_id');
  requireIdentity(input.policy_version, 'policy_version');
  requireIdentity(input.reason_code, 'reason_code');

  // action 字段
  if (input.action === null || typeof input.action !== 'object') {
    throw new Error('action must be an object');
  }
  requireIdentity(input.action.kind, 'action.kind');
  requireIdentity(input.action.subject_id, 'action.subject_id');
  requireIdentity(input.action.snapshot_id, 'action.snapshot_id');

  // 2. behavior 严格校验（fail closed at creator — throw 而非 coerce）
  if (typeof input.behavior !== 'string' || !ALLOWED_BEHAVIORS.has(input.behavior)) {
    throw new Error(
      `behavior must be exactly 'allow' | 'ask' | 'deny', got: ${String(input.behavior)}`,
    );
  }

  // 4. provenance_refs 必须是 string[]
  if (!Array.isArray(input.provenance_refs)) {
    throw new Error('provenance_refs must be an array of strings');
  }
  for (const ref of input.provenance_refs) {
    if (typeof ref !== 'string') {
      throw new Error('provenance_refs must contain only strings');
    }
  }

  // 3. allow 必须有 provenance（spec §11.6.5：跨边界 action 无 provenance 不能 allow）
  if (input.behavior === 'allow' && input.provenance_refs.length === 0) {
    throw new Error('allow decision requires non-empty provenance_refs');
  }

  // 5. 深拷贝 action 和 provenance_refs，然后冻结
  // 注：human_reason 不参与任何分支判断，只是存档
  const decision: SecurityDecision = {
    protocol_version: input.protocol_version,
    decision_id: input.decision_id,
    action: {
      kind: input.action.kind,
      subject_id: input.action.subject_id,
      snapshot_id: input.action.snapshot_id,
    },
    behavior: input.behavior,
    deciding_layer: input.deciding_layer,
    risk_kind: input.risk_kind,
    policy_id: input.policy_id,
    policy_version: input.policy_version,
    reason_code: input.reason_code,
    human_reason: input.human_reason,
    provenance_refs: [...input.provenance_refs],
  };

  return freezeSnapshot(decision) as SecurityDecision;
}

/**
 * 构造空输入（policy evaluation 失败）时的确定性 deny 决策。
 *
 * spec §11.6.8：空输入 → fail closed 为 "missing policy" deny。
 * 这里直接构造并冻结（不经 createSecurityDecision，因为缺 policy 的情况下
 * 某些字段是固定常量，且 allow-provenance 规则不适用于 deny）。
 */
function createMissingPolicyDecision(): SecurityDecision {
  const decision: SecurityDecision = {
    protocol_version: SECURITY_PROTOCOL_VERSION,
    decision_id: 'merge:missing-policy',
    action: {
      kind: 'unknown',
      subject_id: 'unknown',
      snapshot_id: 'unknown',
    },
    behavior: 'deny',
    deciding_layer: 'permission',
    risk_kind: 'policy_failure',
    policy_id: 'policy:missing',
    policy_version: '0',
    reason_code: 'policy.missing',
    human_reason: 'No security decisions were provided; failing closed.',
    provenance_refs: ['policy:missing'],
  };
  return freezeSnapshot(decision) as SecurityDecision;
}

/**
 * 合并多个 SecurityDecision。
 *
 * 规则（spec §11.6.8）：
 *   - 空输入 → 确定性 missing-policy deny（fail closed）；
 *   - 非空：按 rank DESC、deciding_layer ASC、decision_id ASC 选 winner；
 *   - decision_id = 'merge:' + winner.decision_id（确定性派生）；
 *   - provenance_refs = 所有输入 provenance 的并集（去重 + 排序）；
 *   - 返回 NEW frozen 对象，绝不修改输入。
 *
 * 不存在字符串比较决定行为——rank 由 behaviorRank 显式给出。
 */
export function mergeSecurityDecisions(decisions: readonly SecurityDecision[]): SecurityDecision {
  if (decisions.length === 0) {
    return createMissingPolicyDecision();
  }

  // defensive copy before sorting (don't mutate caller's array)
  const sorted = [...decisions].sort((a, b) => {
    const rankA = behaviorRank[a.behavior];
    const rankB = behaviorRank[b.behavior];
    // rank DESC（更严格的在前）
    if (rankA !== rankB) return rankB - rankA;
    // deciding_layer ASC
    if (a.deciding_layer !== b.deciding_layer) {
      return a.deciding_layer < b.deciding_layer ? -1 : 1;
    }
    // decision_id ASC
    if (a.decision_id !== b.decision_id) {
      return a.decision_id < b.decision_id ? -1 : 1;
    }
    return 0;
  });

  const winner = sorted[0];

  // provenance 并集：去重 + 排序
  const provenanceSet = new Set<string>();
  for (const d of decisions) {
    for (const ref of d.provenance_refs) {
      provenanceSet.add(ref);
    }
  }
  const provenanceUnion = [...provenanceSet].sort();

  // 构造合并后的决策单（NEW 对象，从 winner 继承所有字段，decision_id 派生）
  const merged: SecurityDecision = {
    protocol_version: winner.protocol_version,
    decision_id: `merge:${winner.decision_id}`,
    action: {
      kind: winner.action.kind,
      subject_id: winner.action.subject_id,
      snapshot_id: winner.action.snapshot_id,
    },
    behavior: winner.behavior,
    deciding_layer: winner.deciding_layer,
    risk_kind: winner.risk_kind,
    policy_id: winner.policy_id,
    policy_version: winner.policy_version,
    reason_code: winner.reason_code,
    human_reason: winner.human_reason,
    provenance_refs: provenanceUnion,
  };

  return freezeSnapshot(merged) as SecurityDecision;
}
