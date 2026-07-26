// M-054 DecisionTraceEvent (Wave C / CRC-6)
//
// 物理本质:"确定性 subsystem 的可诊断脚手架"。
// 它记录一次 decision/policy 评估的输入 snapshot refs、结构化 result、独立 error,
// 以及最小 metadata(duration),用于事后诊断 —— 不记录完整输入,也不记录模型隐藏思维。
//
// 关键不变量(spec §12.2):
// 1. trace 记录 input snapshot refs 和结构化 result,不默认复制完整 input(rule 1)。
// 2. 只覆盖已冻结的 6 个确定性 subsystem;不预建未使用 classifier(rule 2)。
// 3. 不记录 chain-of-thought / reasoning(rule 3)。
// 4. decision_id 必须引用实际 SecurityDecision/policy result(rule 4 / §12.6)。
// 5. error_code 与 result_code 必须独立字段(rule 5)。
// 6. metadata 不能包含用户正文(rule 6)——本函数不解析内容,只透传字符串。
//
// 这是纯函数:不读全局、不写 sink、不缓存原值。sink 失败与本函数无关。

import { createHash } from 'node:crypto';
import { requireIdentity, freezeSnapshot } from '../contracts/identities.js';

/** 已冻结的 6 个确定性 decision subsystem(不预建未使用 classifier)。 */
export type DecisionSubsystem =
  | 'permission'
  | 'command_policy'
  | 'path_policy'
  | 'environment_policy'
  | 'delegation_policy'
  | 'source_router';

/**
 * Policy 引用字符串。约定与 source-budget / prompt-metadata 一致:`${id}:${version}`。
 * 这里只是别名,不做权威性推断 —— 调用方负责构造合法引用。
 */
export type PolicyRef = string;

/** 已冻结 subsystem 集合(防止 `as any` 走私未注册子系统)。 */
const FROZEN_SUBSYSTEMS: ReadonlySet<DecisionSubsystem> = new Set<DecisionSubsystem>([
  'permission',
  'command_policy',
  'path_policy',
  'environment_policy',
  'delegation_policy',
  'source_router',
]);

/** trace 协议版本(外部可断言)。 */
export const DECISION_TRACE_PROTOCOL_VERSION = '1';

/** createDecisionTraceEvent 的输入。 */
export interface DecisionTraceEventInput {
  /** 必须引用实际 SecurityDecision/policy result(spec §12.2 rule 4)。 */
  decision_id: string;
  subsystem: DecisionSubsystem;
  policy_ref: PolicyRef;
  /** 输入 snapshot 的引用数组 —— 只存引用,不复制完整输入(spec §12.2 rule 1)。 */
  input_snapshot_refs: string[];
  /** 结构化 result snapshot 的引用。 */
  result_ref: string;
  /** 结构化结果码(allow/deny/ask/...)。 */
  result_code: string;
  /** 系统异常码(null 表示无异常)—— 与 result_code 独立(spec §12.2 rule 5)。 */
  error_code: string | null;
  /** 评估耗时(metadata,不应包含用户正文)。 */
  duration_ms: number;
  /** 关联的 telemetry field policy(进入 production plane 时必须通过它,见 redaction.ts)。 */
  field_policy_ref: string;
  /**
   * 可选:验证 decision_id 是否真实存在(指向 registry / decision store)。
   * 返回 false 时拒绝 trace(spec §12.6 "decision trace 引用未知 decision ID:拒绝 trace")。
   */
  registry_lookup?: (decision_id: string) => boolean;
}

/** 构建出的 DecisionTraceEvent(深冻结)。 */
export interface DecisionTraceEvent {
  decision_trace_protocol_version: string;
  event_id: string;
  decision_id: string;
  subsystem: DecisionSubsystem;
  policy_ref: PolicyRef;
  input_snapshot_refs: ReadonlyArray<string>;
  result_ref: string;
  result_code: string;
  error_code: string | null;
  duration_ms: number;
  field_policy_ref: string;
}

/**
 * 构建一个 decision trace event。
 *
 * 步骤:
 * 1. requireIdentity(decision_id)—— 身份校验,空值抛错(spec §12.2 rule 4)。
 * 2. 校验 subsystem 是否在 6 个已冻结值中 —— 否则抛错(不预建 classifier,rule 2)。
 * 3. 如果提供 registry_lookup 且返回 false,抛 'trace.unknown_decision_id'(§12.6)。
 * 4. 计算 event_id:`trace:${sha256(canonical).slice(0,16)}`。
 * 5. 构造 event(只装 refs / 结构化字段;无 raw_input,无 reasoning)。
 * 6. 深冻结并返回。
 *
 * 这是纯函数 —— 不会调用 sink,不会缓存原值,失败仅以异常表达。
 */
export function createDecisionTraceEvent(
  input: DecisionTraceEventInput,
): DecisionTraceEvent {
  // Step 1: decision_id 身份校验。
  requireIdentity(input.decision_id, 'decision_id');

  // Step 2: subsystem 白名单 —— 防 `as any` 走私未冻结子系统。
  if (!FROZEN_SUBSYSTEMS.has(input.subsystem)) {
    throw new Error(`trace.unknown_subsystem:${String(input.subsystem)}`);
  }

  // Step 3: registry lookup —— 决策 ID 必须引用实际 SecurityDecision(§12.6)。
  if (input.registry_lookup !== undefined) {
    let known: boolean;
    try {
      known = input.registry_lookup(input.decision_id) === true;
    } catch {
      known = false;
    }
    if (!known) {
      throw new Error(`trace.unknown_decision_id:${input.decision_id}`);
    }
  }

  // Step 4: 计算 event_id —— 基于稳定字段的 sha256。
  // 注意:registry_lookup 是函数,不能进入哈希(不稳定且非数据)。
  const event_id = computeEventId(input);

  // Step 5: 构造 event。无 raw_input 字段,无 reasoning 字段(由接口类型保证)。
  const event: DecisionTraceEvent = {
    decision_trace_protocol_version: DECISION_TRACE_PROTOCOL_VERSION,
    event_id,
    decision_id: input.decision_id,
    subsystem: input.subsystem,
    policy_ref: input.policy_ref,
    input_snapshot_refs: input.input_snapshot_refs,
    result_ref: input.result_ref,
    result_code: input.result_code,
    error_code: input.error_code,
    duration_ms: input.duration_ms,
    field_policy_ref: input.field_policy_ref,
  };

  // Step 6: 深冻结。
  return freezeSnapshot(event);
}

/**
 * 基于稳定字段计算 event_id。
 *
 * canonical 包含所有"数据字段"(不含 registry_lookup 函数),保证:
 * - 相同输入 → 相同 event_id(可断言、可去重)
 * - decision_id 不同 → event_id 不同
 */
function computeEventId(input: DecisionTraceEventInput): string {
  const canonical = JSON.stringify([
    input.decision_id,
    input.subsystem,
    input.policy_ref,
    input.input_snapshot_refs,
    input.result_ref,
    input.result_code,
    input.error_code,
    input.duration_ms,
    input.field_policy_ref,
  ]);
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `trace:${digest.slice(0, 16)}`;
}
