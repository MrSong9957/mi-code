// Memory Admission (DRC-2 / M-044)
//
// 物理本质:candidate → "是否允许交给 M-045 持久化" 的纯函数判定器。
//
// 这个文件只做三件事:
//   1. 校验 MemoryAdmissionInput 是否满足 §8.8 reject 规则 —— 命中即 reject。
//   2. 校验是否满足 §8.8 defer 规则 —— 命中即 defer。
//   3. 否则 admit —— 但 admit ≠ persisted ≠ selected ≠ use (INV-D6),
//      admit 仍要求后续 use verification (INV-D7 / §8.9-5)。
//
// 这个文件 *不* 做的事 (INV-D5/D6/D7 / §8.11):
//   - 不读写 MemoryManager (route/admission/use/persistence/selection/retention 是六个独立状态 §8.11-12)。
//   - 不实现 Memory 持久化或选择 —— 那是 M-045 / M-047。
//   - 不实现 Memory use decision —— 那是 M-046。
//   - 不把 confidence=1 当事实 (§8.9-5):confidence=1 仍需 evidence/freshness/use verification。
//   - 不接受 Project Instruction 直接 admission (§8.11-1/4):只接受来自 auto_memory channel 的 candidate。
//
// 规格来源:docs/superpowers/specs/2026-07-26-agent-integrated-capabilities-wave-d-design.md
//   §8.6 / §8.7 / §8.8 / §8.9 / §8.11

import { createHash } from 'node:crypto';
import { freezeSnapshot, requireIdentity } from '../agent/contracts/identities.js';
import type { AutoMemoryType } from './candidates.js';

/**
 * admission 协议版本。结构变化时递增。
 * 独立于 candidate / use 的 protocol version (§8.11-8:admission 与 use 必须有独立 protocol/decision ID)。
 */
export const MEMORY_ADMISSION_PROTOCOL_VERSION = '1';

/**
 * 集成契约引用。admission policy 属于某个 frozen integrated contract。
 */
export interface IntegratedContractRef {
  contract_id: string;
  contract_version: string;
}

/**
 * candidate 内容来源通道 (BRC-3/CRC-3)。
 * 只有 'auto_memory' channel 的 typed candidate 才能 admission。
 */
export type MemoryCandidateSourceChannel =
  | 'auto_memory'
  | 'project_instruction'
  | 'tool_result'
  | 'other';

/**
 * content class —— credential/secret 检测。
 * candidate 构造期 (M-043) 已对 claim 做 sensitive keyword 检测,
 * 这里在 admission 层再做一次 content_class 分类,作为最后一道防线。
 */
export type MemoryContentClass = 'normal' | 'credential' | 'secret';

/**
 * validity scope —— memory 生效范围。
 * 'current_turn' 的临时状态不属于 long-term memory (§8.8 reject)。
 */
export type MemoryValidityScope = 'persistent' | 'current_turn' | 'session';

/**
 * freshness status —— observation 的新鲜度。
 */
export type MemoryFreshnessStatus = 'fresh' | 'stale' | 'unknown';

/**
 * admission input。字段从 TypedMemoryCandidate + admission 上下文复制而来。
 *
 * INV-D5:input 必须源自 auto_memory channel 的 typed candidate。
 * Project Instruction、Tool Result 原文、模型 summary、任意 Markdown 不能绕过 typed candidate 直接 admission。
 */
export interface MemoryAdmissionInput {
  admission_protocol_version: string;
  memory_candidate_id: string;
  memory_policy_ref: IntegratedContractRef;
  current_context_snapshot_id: string;
  project_version_ref: string | null;

  // candidate 字段(从 TypedMemoryCandidate 复制关键字段)
  candidate_evidence_refs: string[];
  candidate_type: AutoMemoryType;
  candidate_claim: string;
  candidate_confidence: number;
  candidate_scope_ref: string;
  candidate_context_refs: string[];
  candidate_invalidation_conditions: string[];
  candidate_sensitivity_labels: string[];
  candidate_observed_at: string;
  candidate_expires_at: string | null;

  // 通道验证(必须来自 auto_memory channel)
  candidate_source_channel: MemoryCandidateSourceChannel;

  // content class(用于 credential 检测)
  content_class: MemoryContentClass;

  // validity scope
  validity_scope: MemoryValidityScope;

  // freshness
  freshness_status: MemoryFreshnessStatus;
  refresh_path_available: boolean;
}

export type MemoryAdmissionStatus = 'admit' | 'reject' | 'defer';

/**
 * admission decision。一旦生成就不可变。
 *
 * INV-D6:admit 只表示允许交给后续 M-045 持久化,不表示已经写入,
 *         也不表示以后可以无验证使用 —— use 必须 M-046 再判定。
 */
export interface MemoryAdmissionDecision {
  admission_protocol_version: string;
  admission_decision_id: string;
  memory_candidate_id: string;
  policy_ref: IntegratedContractRef;
  current_context_snapshot_id: string;
  status: MemoryAdmissionStatus;
  accepted_scope_ref: string | null; // 仅 admit 非空
  accepted_type: AutoMemoryType | null; // 仅 admit 非空
  verification_requirements: string[]; // admit 也非空:指向 M-046 use verification
  reason_codes: string[];
  evidence_refs: string[];
}

/**
 * admission policy —— type-specific confidence threshold + 全局开关。
 *
 * §8.9-4:threshold 必须属于明确的 type-specific policy,不能全局排序。
 */
export interface MemoryAdmissionPolicy {
  /** type → confidence threshold。未列出的 type 走 default。 */
  confidence_thresholds: Readonly<Record<string, number>>;
  /** 未在 map 里的 type 的默认 threshold。 */
  default_confidence_threshold: number;
  /** 是否要求 candidate evidence 非空。 */
  require_evidence: boolean;
  /** 是否要求 freshness 已确认。 */
  require_freshness: boolean;
}

/**
 * 默认 admit 路径的 verification requirements。
 * admit ≠ use:被 admit 的 memory 进入 prompt/answer/behavior 前仍需 M-046 重新验证 (§8.7)。
 */
const ADMIT_VERIFICATION_REQUIREMENTS: readonly string[] = [
  'memory.use_verification_required:before use, re-verify against current context snapshot (M-046)',
  'memory.freshness_recheck_required:stale memory cannot be used without refresh',
];

/**
 * sensitivity label 中触发 reject 的关键词 (大小写不敏感整词匹配)。
 * label 含 secret/credential 即视为敏感内容,不能 admission (§8.8)。
 */
const SENSITIVE_LABEL_KEYWORDS: readonly string[] = [
  'secret',
  'credential',
  'api_key',
  'apikey',
  'token',
  'password',
  'passwd',
  'private_key',
];

function labelIsSensitive(label: string): boolean {
  const lower = label.toLowerCase();
  return SENSITIVE_LABEL_KEYWORDS.some((kw) => lower.includes(kw));
}

function isValidConfidence(c: number): boolean {
  return (
    typeof c === 'number' &&
    !Number.isNaN(c) &&
    Number.isFinite(c) &&
    c >= 0 &&
    c <= 1
  );
}

/**
 * 计算 admission decision 的内容寻址 id。
 * 前缀随 status 变化 (admit: / reject: / defer:),便于下游识别。
 *
 * canonical 覆盖 candidate id + status + policy ref + snapshot ——
 * 相同 candidate 在相同 policy/snapshot 下产生相同 decision,可去重。
 */
function computeDecisionId(
  status: MemoryAdmissionStatus,
  fields: {
    memory_candidate_id: string;
    policy_ref: IntegratedContractRef;
    current_context_snapshot_id: string;
  },
): string {
  const canonical = JSON.stringify({
    status,
    memory_candidate_id: fields.memory_candidate_id,
    policy_ref: fields.policy_ref,
    current_context_snapshot_id: fields.current_context_snapshot_id,
  });
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `${status}:${hash.slice(0, 16)}`;
}

function buildDecision(
  status: MemoryAdmissionStatus,
  input: MemoryAdmissionInput,
  reason_codes: string[],
  opts: {
    accepted_scope_ref?: string | null;
    accepted_type?: AutoMemoryType | null;
    verification_requirements?: string[];
  } = {},
): MemoryAdmissionDecision {
  const decision: MemoryAdmissionDecision = {
    admission_protocol_version: input.admission_protocol_version,
    admission_decision_id: computeDecisionId(status, {
      memory_candidate_id: input.memory_candidate_id,
      policy_ref: input.memory_policy_ref,
      current_context_snapshot_id: input.current_context_snapshot_id,
    }),
    memory_candidate_id: input.memory_candidate_id,
    policy_ref: input.memory_policy_ref,
    current_context_snapshot_id: input.current_context_snapshot_id,
    status,
    accepted_scope_ref: opts.accepted_scope_ref ?? null,
    accepted_type: opts.accepted_type ?? null,
    verification_requirements: opts.verification_requirements ?? [],
    reason_codes,
    evidence_refs: input.candidate_evidence_refs,
  };
  return freezeSnapshot(decision) as MemoryAdmissionDecision;
}

/**
 * 判定一个 candidate 是否可 admission。
 *
 * 纯函数:不读写 MemoryManager、不触发持久化、不修改 input。
 *
 * 判定顺序(规格 §8.8):
 *   1. protocol version 不匹配 → reject(优先,避免下游用过期 schema)
 *   2. reject 规则(credential/临时状态/缺证据/错通道/非法 confidence/sensitive label)
 *   3. defer 规则(stale+refresh / unknown+require_freshness / 低 confidence)
 *   4. 否则 admit
 *
 * 注:低 confidence 归 defer 而非 reject —— candidate 本身合法,只是证据不足,
 *     可通过补充 evidence 或后续重观察进入 admit;这是 §8.8 "evidence 存在但上下文不足" 的延伸。
 */
export function decideMemoryAdmission(
  input: MemoryAdmissionInput,
  policy: MemoryAdmissionPolicy,
): MemoryAdmissionDecision {
  // 结构性字段校验 —— 防止 undefined/空字符串混入 canonical。
  requireIdentity(input.admission_protocol_version, 'admission_protocol_version');
  requireIdentity(input.memory_candidate_id, 'memory_candidate_id');
  requireIdentity(input.current_context_snapshot_id, 'current_context_snapshot_id');
  requireIdentity(input.candidate_scope_ref, 'candidate_scope_ref');

  // ─── reject: protocol version 不匹配 (规格 §8.12:policy/snapshot/version 不匹配 → reject 或 defer,不猜测)
  // admission_protocol_version 是 input 自报的 schema 版本;若与当前协议不符,下游 schema 假设会破裂。
  if (input.admission_protocol_version !== MEMORY_ADMISSION_PROTOCOL_VERSION) {
    return buildDecision('reject', input, ['memory.protocol_version_mismatch']);
  }

  // ─── reject 规则 (§8.8) ───────────────────────────────────────────
  // 顺序:从"内容性质"到"结构合法性"。一旦命中立即返回。
  // reason_codes 使用纯短码(可枚举,便于下游 programmatic 消费),数值上下文不在 code 中。

  // 1. credential / secret 内容 (§8.8 + §8.11)
  if (input.content_class === 'credential' || input.content_class === 'secret') {
    return buildDecision('reject', input, ['memory.credential_content']);
  }

  // 2. 仅当前 turn 有效的临时状态 (§8.8)
  if (input.validity_scope === 'current_turn') {
    return buildDecision('reject', input, ['memory.temporary_state']);
  }

  // 3. evidence 缺失 (且 policy 要求) (§8.8 / §8.9-5:confidence=1 仍需 evidence)
  if (
    policy.require_evidence &&
    (!Array.isArray(input.candidate_evidence_refs) ||
      input.candidate_evidence_refs.length === 0)
  ) {
    return buildDecision('reject', input, ['memory.missing_evidence']);
  }

  // 4. channel 不匹配 (§8.8 + §8.11-1/4:project_instruction 不能改写为 auto_memory)
  if (input.candidate_source_channel !== 'auto_memory') {
    return buildDecision('reject', input, ['memory.wrong_channel']);
  }

  // 5. confidence 非法 (§8.9-1/6:NaN/Infinity/越界)
  if (!isValidConfidence(input.candidate_confidence)) {
    return buildDecision('reject', input, ['memory.invalid_confidence']);
  }

  // 6. sensitivity_labels 含 secret/credential 等 (§8.8)
  //    label 不是"脱敏出口"——label 标记敏感即视为敏感内容。
  const hasSensitiveLabel = input.candidate_sensitivity_labels.some(
    (label) => typeof label === 'string' && labelIsSensitive(label),
  );
  if (hasSensitiveLabel) {
    return buildDecision('reject', input, ['memory.sensitive_label']);
  }

  // ─── defer 规则 (§8.8) ────────────────────────────────────────────
  const deferReasons: string[] = [];

  // 1. stale 且有刷新路径 → defer(可恢复新鲜度)
  if (input.freshness_status === 'stale' && input.refresh_path_available) {
    deferReasons.push('memory.freshness.refresh_required');
  } else if (input.freshness_status === 'stale' && !input.refresh_path_available) {
    // stale 且无刷新路径:无法恢复 → reject(不是 defer,因为没有可走的恢复路径)
    return buildDecision('reject', input, ['memory.freshness.stale_no_refresh']);
  }

  // 2. freshness unknown 且 policy 要求 freshness → defer
  if (input.freshness_status === 'unknown' && policy.require_freshness) {
    deferReasons.push('memory.freshness.unknown');
  }

  // 3. confidence 低于 type-specific threshold → defer(证据不足,可补)
  //    §8.9-4:threshold 必须来自 type-specific policy。
  const threshold =
    policy.confidence_thresholds[input.candidate_type] ??
    policy.default_confidence_threshold;
  if (input.candidate_confidence < threshold) {
    deferReasons.push('memory.confidence_below_threshold');
  }

  if (deferReasons.length > 0) {
    return buildDecision('defer', input, deferReasons);
  }

  // ─── admit (§8.7) ─────────────────────────────────────────────────
  // 全部 reject / defer 条件未命中 → admit。
  // 但 admit ≠ persisted ≠ selected ≠ use (INV-D6):
  //   - 持久化是 M-045 的独立状态
  //   - use 必须 M-046 在当前 context snapshot 下重新验证 (§8.7)
  //   - confidence=1 仍需 use verification (§8.9-5)
  return buildDecision('admit', input, [], {
    accepted_scope_ref: input.candidate_scope_ref,
    accepted_type: input.candidate_type,
    verification_requirements: [...ADMIT_VERIFICATION_REQUIREMENTS],
  });
}

// ===========================================================================
// Memory Use Decision (DRC-2 / M-044 T6)
//
// 物理本质:stored memory → "当前 context 下是否可以使用,且哪些 claim 可用"
// 的纯函数判定器。与 admission 是分离状态 (INV-D6 / §8.11-12)。
//
// 这个追加段只做四件事:
//   1. 校验 MemoryUseInput 的 identity 字段。
//   2. 检测 prior decision context 漂移 (§8.10)。
//   3. 应用 §8.12 错误语义(verifier unavailable / conflicting evidence)。
//   4. 输出 MemoryUseDecision(use / do_not_use / needs_refresh)。
//
// 这个段 *不* 做的事:
//   - 不读写 MemoryManager(route/admission/use/persistence/selection/retention
//     是独立状态 §8.11-12)。
//   - 不把 needs_refresh 当低置信 use(§8.10)。
//   - 不改变原 admission decision(INV-D6:use 是 admission 的只读消费者)。
//   - 不输出 writer failure / TurnOutcome(§8.11-11/12)。
//
// 规格来源:§8.10 Memory use decision / §8.11-7,8,12 / §8.12 错误语义。
// ===========================================================================

/**
 * use 协议版本。独立于 admission 的 protocol version (§8.11-8)。
 * 结构变化时递增。
 */
export const MEMORY_USE_PROTOCOL_VERSION = '1';

/**
 * use decision 状态 (§8.10)。
 * - 'use':全部 claim 已在当前 context 验证通过,可实际使用。
 * - 'do_not_use':不可使用(冲突 / 无 verified claim / context 漂移 / verifier 缺失)。
 * - 'needs_refresh':verifier 暂时不可用但可刷新;**不是**低置信 use (§8.10)。
 */
export type MemoryUseStatus = 'use' | 'do_not_use' | 'needs_refresh';

/**
 * stored memory 中的 claim(进入 prompt/answer/behavior 前需重新验证)。
 * 这里只复制 claim id/text/evidence_refs 用于审计与 traceability。
 */
export interface MemoryUseCandidateClaim {
  claim_id: string;
  claim_text: string;
  evidence_refs: string[];
}

/**
 * use decision 的输入。
 *
 * 关键不变量 (§8.11-7):use 必须绑定 *当前* context snapshot。
 * prior_decision 可选,用于检测"上次 use 是在另一个 context 做的"这类漂移。
 *
 * verifier_* 字段由调用方(M-046 verifier)提供;本函数不做 verifier 本身的实现。
 */
export interface MemoryUseInput {
  memory_use_protocol_version: string;
  /** 已持久化的 memory 引用(M-045 产物)。 */
  stored_memory_ref: string;
  /** 对应的 admission decision —— use 引用 admission,但不修改它 (INV-D6)。 */
  admission_decision_id: string;
  /** 当前 context snapshot —— use 必须绑定它 (§8.11-7)。 */
  current_context_snapshot_id: string;
  project_version_ref: string | null;
  /** 候选 claim 集合(用于审计/traceability,不参与判定逻辑)。 */
  candidate_claims: ReadonlyArray<MemoryUseCandidateClaim>;
  /** verifier 在当前 context 验证通过的 claim refs。 */
  verified_claim_refs: string[];
  /** 过期但未冲突的 claim refs(保留供 refresh 参考)。 */
  stale_claim_refs: string[];
  /** 与当前 context 冲突的 evidence refs(§8.12 → do_not_use 并保留)。 */
  conflicting_evidence_refs: string[];
  /** verifier 当前是否可用 (§8.12)。 */
  verifier_available: boolean;
  /** 是否存在刷新路径(verifier 不可用但可刷新 → needs_refresh)。 */
  refresh_available: boolean;
  /** 上次 use decision(可选);用于检测 context 漂移 (§8.10)。 */
  prior_decision?: {
    memory_use_decision_id: string;
    current_context_snapshot_id: string;
  };
}

/**
 * use decision。一旦生成就不可变 (INV-D6)。
 *
 * 与 MemoryAdmissionDecision 是分离契约:
 *   - 独立 protocol version / decision id (§8.11-8)。
 *   - 引用 admission_decision_id,但不改写 admission。
 *   - 携带 verified/stale/conflicting refs 供下游 traceability。
 */
export interface MemoryUseDecision {
  memory_use_protocol_version: string;
  memory_use_decision_id: string;
  stored_memory_ref: string;
  admission_decision_id: string;
  current_context_snapshot_id: string;
  project_version_ref: string | null;
  status: MemoryUseStatus;
  verified_claim_refs: string[];
  stale_claim_refs: string[];
  conflicting_evidence_refs: string[];
  reason_codes: string[];
}

/**
 * 计算 use decision 的内容寻址 id。
 * 前缀 `use:` 固定(use decision 命名空间),后随 status 与 canonical hash。
 * canonical 覆盖 stored_memory_ref + admission_decision_id + 当前 snapshot + status ——
 * 相同 stored memory 在相同 admission/snapshot 下产生相同 decision,可去重;
 * snapshot 变化 → id 变化(强制重新 use verification,§8.11-7)。
 */
function computeUseDecisionId(
  status: MemoryUseStatus,
  fields: {
    stored_memory_ref: string;
    admission_decision_id: string;
    current_context_snapshot_id: string;
  },
): string {
  const canonical = JSON.stringify({
    status,
    stored_memory_ref: fields.stored_memory_ref,
    admission_decision_id: fields.admission_decision_id,
    current_context_snapshot_id: fields.current_context_snapshot_id,
  });
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `use:${status}:${hash.slice(0, 16)}`;
}

function buildUseDecision(
  status: MemoryUseStatus,
  input: MemoryUseInput,
  reason_codes: string[],
): MemoryUseDecision {
  const decision: MemoryUseDecision = {
    memory_use_protocol_version: input.memory_use_protocol_version,
    memory_use_decision_id: computeUseDecisionId(status, {
      stored_memory_ref: input.stored_memory_ref,
      admission_decision_id: input.admission_decision_id,
      current_context_snapshot_id: input.current_context_snapshot_id,
    }),
    stored_memory_ref: input.stored_memory_ref,
    admission_decision_id: input.admission_decision_id,
    current_context_snapshot_id: input.current_context_snapshot_id,
    project_version_ref: input.project_version_ref,
    status,
    verified_claim_refs: [...input.verified_claim_refs],
    stale_claim_refs: [...input.stale_claim_refs],
    conflicting_evidence_refs: [...input.conflicting_evidence_refs],
    reason_codes,
  };
  return freezeSnapshot(decision) as MemoryUseDecision;
}

/**
 * 判定一份 stored memory 在 *当前* context snapshot 下是否可以使用,
 * 以及哪些 claim 可用。
 *
 * 纯函数:不读写 MemoryManager、不触发持久化、不修改 input、不改写 admission。
 *
 * 判定顺序(规格 §8.10 / §8.12):
 *   1. identity 守门。
 *   2. prior decision context 漂移 → do_not_use (§8.10)。
 *   3. verifier 不可用 → needs_refresh(可刷新) / do_not_use(无刷新) (§8.12)。
 *   4. conflicting evidence → do_not_use 并保留 evidence (§8.12)。
 *   5. verified claims 为空 → do_not_use。
 *   6. 否则 use。
 *
 * 注:needs_refresh 是独立状态,**不能**当作低置信 use (§8.10)。
 */
export function decideMemoryUse(input: MemoryUseInput): MemoryUseDecision {
  // ─── identity 守门 (§8.12) ───────────────────────────────────────
  requireIdentity(input.memory_use_protocol_version, 'memory_use_protocol_version');
  requireIdentity(input.stored_memory_ref, 'stored_memory_ref');
  requireIdentity(input.admission_decision_id, 'admission_decision_id');
  requireIdentity(input.current_context_snapshot_id, 'current_context_snapshot_id');

  // ─── prior decision context 漂移 (§8.10 / §8.11-7) ───────────────
  // 上次 use 绑定的 snapshot 与当前不同 → 当前 context 下不可直接复用。
  if (
    input.prior_decision !== undefined &&
    input.prior_decision.current_context_snapshot_id !== input.current_context_snapshot_id
  ) {
    return buildUseDecision('do_not_use', input, ['memory.context_snapshot_mismatch']);
  }

  // ─── verifier 可用性 (§8.12) ─────────────────────────────────────
  // 使用前验证器不可用:不乐观 use。
  if (!input.verifier_available) {
    if (input.refresh_available) {
      // 可刷新 → needs_refresh(独立状态,不是低置信 use)。
      return buildUseDecision('needs_refresh', input, []);
    }
    return buildUseDecision('do_not_use', input, ['memory.verifier_unavailable']);
  }

  // ─── conflicting evidence (§8.12) ────────────────────────────────
  // 当前 context 与 stored claim 冲突:do_not_use,并保留 evidence。
  if (input.conflicting_evidence_refs.length > 0) {
    return buildUseDecision('do_not_use', input, ['memory.conflicting_evidence']);
  }

  // ─── verified claims (§8.10) ─────────────────────────────────────
  // 没有 verified claim → 不可 use。
  if (input.verified_claim_refs.length === 0) {
    return buildUseDecision('do_not_use', input, ['memory.no_verified_claims']);
  }

  // ─── use (§8.10) ─────────────────────────────────────────────────
  // 所有 claim 已在当前 context 验证通过 → 可以使用。
  // 注意:verified 的子集(部分 stale 但无冲突)也算 use,stale 仅作 traceability。
  return buildUseDecision('use', input, []);
}
