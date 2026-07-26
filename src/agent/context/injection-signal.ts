// M-069 InjectionSuspicionSignal (spec §11.1 / §11.5 / §11.6 / §11.7 / CRC-5).
//
// 物理本质：观察员对某个 context source 的可疑度记录单 —— 只是观察，不是判决。
//
// 关键不变量（INV-C11 / spec §11.6）：
//   1. signal 是 SOFT signal —— 它不携带 `behavior`，不能放行/拦截任何东西。
//   2. signal 不能修改 source 的 trust / authority / placement / retention。
//   3. signal 不携带 `security_decision_ref` —— model signal 不能 mint SecurityDecision。
//   4. trusted source 不接受 signal（与“可信”自相矛盾）。
//   5. model signal 允许无 evidence（低置信软提示），但 deterministic_detector
//      必须至少一条 evidence（确定性扫描器没有 finding 不能喊可疑）。
//   6. `user_report_recommended` 由确定性 policy 派生，不是 model 的自由布尔值。
//   7. signal_id 是确定性派生（sha256 截断）—— 同输入同 id。
//   8. 输出 frozen 深拷贝；输入对象不被就地修改（不同于 freezeSnapshot，这里要复制）。
//
// 错误语义（spec §11.7）：schema 无效 → 丢弃 signal，不改变原 SecurityDecision。
// 这里通过“创建处 throw”实现 —— 调用方 try/catch 即丢弃。

import { createHash } from 'node:crypto';
import { requireIdentity } from '../contracts/identities.js';

/** Wave C signal 协议版本（硬编码 '1'） */
export const SIGNAL_PROTOCOL_VERSION = '1';

/** signal 只能附在不可信/未知的 source 上（spec §11.5） */
export type SignalSourceTrust = 'untrusted' | 'unknown';

/** 谁发现的可疑 —— model 主观判断 / 确定性扫描器 */
export type SignalSource = 'model' | 'deterministic_detector';

/** 任务影响程度（仅用于 user_report_recommended policy 输入） */
export type SignalTaskImpact = 'low' | 'medium' | 'high';

/**
 * 创建 InjectionSuspicionSignal 的输入。
 *
 * `risk_score` / `task_impact` 只用于派生 `user_report_recommended`，本身
 * 不会被写入输出的 signal —— 输出 signal 只保留稳定字段。
 */
export interface InjectionSuspicionSignalInput {
  context_source_id: string;
  /** trusted 源不接受 signal（见上） */
  source_trust: SignalSourceTrust;
  /** 关联的确定性 ingress 检查结果引用（即便结果是 pass，也要记录关联） */
  deterministic_ingress_result_ref: string;
  signal_source: SignalSource;
  /** 可疑类别，如 'prompt_injection' / 'jailbreak_attempt' / 'role_confusion' */
  suspicion_kinds: string[];
  /** 证据引用：model signal 可为空，deterministic_detector 至少一条 */
  evidence_refs: string[];
  /** 0~1，缺省 0 */
  risk_score?: number;
  /** 缺省 'low' */
  task_impact?: SignalTaskImpact;
  created_at: string;
}

/**
 * 已发出的 InjectionSuspicionSignal（spec §11.5）。
 *
 * 注意：此结构故意只有“观察 + 派生建议”两类字段，没有任何权限字段。
 */
export interface InjectionSuspicionSignal {
  signal_protocol_version: string;
  signal_id: string;
  context_source_id: string;
  source_trust: SignalSourceTrust;
  deterministic_ingress_result_ref: string;
  signal_source: SignalSource;
  suspicion_kinds: string[];
  evidence_refs: string[];
  user_report_recommended: boolean;
  created_at: string;
}

const ALLOWED_SOURCE_TRUST: readonly SignalSourceTrust[] = ['untrusted', 'unknown'];
const ALLOWED_SIGNAL_SOURCE: readonly SignalSource[] = ['model', 'deterministic_detector'];
const ALLOWED_TASK_IMPACT: readonly SignalTaskImpact[] = ['low', 'medium', 'high'];

/** user_report_recommended 的阈值（spec §11.6 rule 5：独立 policy 决定） */
const REPORT_RISK_THRESHOLD = 0.7;

/**
 * 计算 `user_report_recommended` —— 纯函数，便于复测。
 *
 * 规则（最小确定性 policy）：
 *   risk_score >= 0.7  → true
 *   task_impact === 'high' → true
 *   其他 → false
 *
 * risk_score 缺省按 0 处理；task_impact 缺省按 'low' 处理。
 */
export function shouldRecommendUserReport(input: {
  risk_score?: number;
  task_impact?: SignalTaskImpact;
}): boolean {
  const risk = typeof input.risk_score === 'number' ? input.risk_score : 0;
  const impact: SignalTaskImpact =
    input.task_impact !== undefined && (ALLOWED_TASK_IMPACT as readonly string[]).includes(input.task_impact)
      ? input.task_impact
      : 'low';
  return risk >= REPORT_RISK_THRESHOLD || impact === 'high';
}

/**
 * 创建一个 InjectionSuspicionSignal。
 *
 * 校验顺序：
 *   1. 身份字段非空（context_source_id / deterministic_ingress_result_ref / created_at）；
 *   2. source_trust ∈ {untrusted, unknown}（trusted 不接受 signal）；
 *   3. signal_source ∈ {model, deterministic_detector}；
 *   4. suspicion_kinds 非空且全为字符串；
 *   5. evidence_refs 全为字符串；
 *   6. signal_source === 'deterministic_detector' 时 evidence_refs 至少一条。
 *
 * 派生：
 *   - user_report_recommended = shouldRecommendUserReport(input)；
 *   - signal_id = 'sig:' + sha256(canonical).slice(0,16)。
 *
 * 输出：NEW frozen 对象；input 不会被修改（也不依赖 input 是否冻结）。
 */
export function createInjectionSuspicionSignal(
  input: InjectionSuspicionSignalInput,
): InjectionSuspicionSignal {
  // 1. 身份校验
  requireIdentity(input.context_source_id, 'context_source_id');
  requireIdentity(input.deterministic_ingress_result_ref, 'deterministic_ingress_result_ref');
  requireIdentity(input.created_at, 'created_at');

  // 2. source_trust 必须是 untrusted/unknown（trusted 矛盾，throw）
  if (!(ALLOWED_SOURCE_TRUST as readonly string[]).includes(input.source_trust)) {
    throw new Error(
      `signal.trusted_source_not_suspicious: source_trust must be 'untrusted' or 'unknown', got: ${String(input.source_trust)}`,
    );
  }

  // 3. signal_source 闭集校验
  if (!(ALLOWED_SIGNAL_SOURCE as readonly string[]).includes(input.signal_source)) {
    throw new Error(
      `signal_source must be 'model' or 'deterministic_detector', got: ${String(input.signal_source)}`,
    );
  }

  // 4. suspicion_kinds: 数组、非空、全字符串
  if (!Array.isArray(input.suspicion_kinds) || input.suspicion_kinds.length === 0) {
    throw new Error('suspicion_kinds must be a non-empty array');
  }
  for (const kind of input.suspicion_kinds) {
    if (typeof kind !== 'string' || kind.trim().length === 0) {
      throw new Error('suspicion_kinds must contain only non-empty strings');
    }
  }

  // 5. evidence_refs: 数组、全字符串（可以为空）
  if (!Array.isArray(input.evidence_refs)) {
    throw new Error('evidence_refs must be an array of strings');
  }
  for (const ref of input.evidence_refs) {
    if (typeof ref !== 'string') {
      throw new Error('evidence_refs must contain only strings');
    }
  }

  // 6. deterministic_detector 必须有 evidence
  if (input.signal_source === 'deterministic_detector' && input.evidence_refs.length === 0) {
    throw new Error(
      'signal.deterministic_requires_evidence: deterministic_detector signal must carry at least one evidence_ref',
    );
  }

  // 派生 user_report_recommended（独立 policy，不是 model 自由布尔值）
  const userReportRecommended = shouldRecommendUserReport({
    risk_score: input.risk_score,
    task_impact: input.task_impact,
  });

  // 防御性拷贝数组（input 可能被调用方继续 mutate，也可能已冻结 —— 都不能影响输出）
  const suspicionKinds = [...input.suspicion_kinds];
  const evidenceRefs = [...input.evidence_refs];

  // 构造 signal —— 故意只含稳定字段，无 behavior / authority / placement / retention /
  // security_decision_ref / risk_score / task_impact。
  const signal: InjectionSuspicionSignal = {
    signal_protocol_version: SIGNAL_PROTOCOL_VERSION,
    signal_id: deriveSignalId({
      context_source_id: input.context_source_id,
      source_trust: input.source_trust,
      deterministic_ingress_result_ref: input.deterministic_ingress_result_ref,
      signal_source: input.signal_source,
      suspicion_kinds: suspicionKinds,
      evidence_refs: evidenceRefs,
      created_at: input.created_at,
    }),
    context_source_id: input.context_source_id,
    source_trust: input.source_trust,
    deterministic_ingress_result_ref: input.deterministic_ingress_result_ref,
    signal_source: input.signal_source,
    suspicion_kinds: suspicionKinds,
    evidence_refs: evidenceRefs,
    user_report_recommended: userReportRecommended,
    created_at: input.created_at,
  };

  // 冻结输出（递归冻结数组元素）。注意：input 没被修改。
  return deepFreezeSignal(signal);
}

/**
 * 派生 signal_id = 'sig:' + sha256(canonical_json).slice(0,16)。
 *
 * canonical_json 仅由稳定字段构成（不含 risk_score / task_impact —— 它们是
 * policy 输入，不应让 signal_id 随风险评分抖动；同观察不同风险评分应得同 id）。
 */
function deriveSignalId(stable: {
  context_source_id: string;
  source_trust: SignalSourceTrust;
  deterministic_ingress_result_ref: string;
  signal_source: SignalSource;
  suspicion_kinds: string[];
  evidence_refs: string[];
  created_at: string;
}): string {
  const canonical = JSON.stringify({
    context_source_id: stable.context_source_id,
    source_trust: stable.source_trust,
    deterministic_ingress_result_ref: stable.deterministic_ingress_result_ref,
    signal_source: stable.signal_source,
    suspicion_kinds: stable.suspicion_kinds,
    evidence_refs: stable.evidence_refs,
    created_at: stable.created_at,
  });
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `sig:${hash.slice(0, 16)}`;
}

/**
 * 递归冻结 signal（数组字段也要冻结到元素级）。
 * 不用 contracts/identities.js 的 freezeSnapshot 是为了避免“就地冻结”语义
 * 引起误解 —— 这里显式 new 一个对象后冻结。
 */
function deepFreezeSignal(signal: InjectionSuspicionSignal): InjectionSuspicionSignal {
  Object.freeze(signal.suspicion_kinds);
  Object.freeze(signal.evidence_refs);
  return Object.freeze(signal) as InjectionSuspicionSignal;
}
