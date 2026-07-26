// M-051 Observability Plane Envelopes (Wave B)
//
// 物理本质:"信封分拣台"。
// 所有可观测事件必须先被打包成信封(Envelope)—— 信封上只写元数据(plane, sensitivity,
// redaction_state, payload_ref ...),不写 payload 内容本身。
// 分拣台根据 plane(投递通道)和 policies(通道开关)决定:投递(emitted)还是丢弃(dropped)。
//
// Wave B 关键不变量(见 spec §13 / BRC-7):
// 1. production_telemetry 与 full_request_dump 两个通道被硬编码关闭——无论 policy 怎么说都丢弃。
// 2. 信封只携带 payload_ref(引用),不携带 payload 内容。envelope builder 不构造 payload。
// 3. decision_trace 通道在 Wave B 没有 payload schema,即便 caller 传入 payload_ref 也会被强制 null。
// 4. 投递出的信封被深冻结(不可篡改)。
// 5. 身份字段为空时直接抛错——这是身份校验,不是准入决定(不做静默丢弃)。
// 6. 分拣台失败绝不影响 SecurityDecision / CompletionReport / streaming Outcome——它只产出 result 对象。

import { requireIdentity, freezeSnapshot } from '../contracts/identities.js';

/** 可观测性投递通道(飞机的"航线")。 */
export type ObservabilityPlane =
  | 'local_debug'
  | 'full_request_dump'
  | 'decision_trace'
  | 'production_telemetry';

/** 数据敏感度分级。 */
export type ObservabilitySensitivity = 'low' | 'internal' | 'sensitive' | 'unknown';

/** 脱敏状态:只有 not_required / redacted 才允许投递。 */
export type ObservabilityRedactionState =
  | 'not_required'
  | 'pending'
  | 'redacted'
  | 'dropped';

/** 已包装好的可观测性事件信封(元数据 only,无 payload 内容)。 */
export interface ObservabilityEventEnvelope {
  observability_protocol_version: string;
  event_id: string;
  event_type: string;
  plane: ObservabilityPlane;
  occurred_at: string;
  session_ref: string | null;
  request_snapshot_ref: string | null;
  component_ref: string;
  payload_schema_id: string;
  sensitivity: ObservabilitySensitivity;
  redaction_state: ObservabilityRedactionState;
  payload_ref: string | null;
}

/** 构造信封的输入(字段一一对应,不做默认)。 */
export interface CreateObservabilityEnvelopeInput {
  observability_protocol_version: string;
  event_id: string;
  event_type: string;
  plane: ObservabilityPlane;
  occurred_at: string;
  session_ref: string | null;
  request_snapshot_ref: string | null;
  component_ref: string;
  payload_schema_id: string;
  sensitivity: ObservabilitySensitivity;
  redaction_state: ObservabilityRedactionState;
  payload_ref: string | null;
}

/** 单个 plane 的策略:该通道是否开启。 */
export interface ObservabilityPlanePolicy {
  // Whether the plane is currently enabled. Wave B: only local_debug may be enabled (configurable);
  // full_request_dump and production_telemetry are disabled.
  enabled: boolean;
}

/** 全部 plane 的策略集合(只读 Record)。 */
export type ObservabilityPlanePolicies = Readonly<
  Record<ObservabilityPlane, ObservabilityPlanePolicy>
>;

/** 构造结果:emitted 或 dropped。 */
export interface CreateObservabilityEnvelopeResult {
  status: 'emitted' | 'dropped';
  envelope: ObservabilityEventEnvelope | null;
  drop_reason_code: string | null;
}

/**
 * Wave B/C 硬编码开关(spec §13.3 / §18 BRC-7.2 / BRC-7.3 / CRC-6 §12.5):
 * - full_request_dump 在 Wave B 始终关闭(后续仍受 BRC-7 retention 独立管控,CRC-6 不自动启用)。
 * - production_telemetry 在 Wave C 仍禁用:即便 CRC-6 已落地 redaction gate(M-056),
 *   "通过 redaction" 只是 *必要条件* 而非充分条件 —— 真正的 production sink pipeline
 *   属于 Wave D(M-064/M-055)的交付范围。Wave C 不在本信封里接通 production sink。
 *
 * decision_trace 若要进入 production plane,必须先通过同一字段政策(spec §12.5 rule 10);
 * 本信封对 decision_trace 强制 payload_ref=null(见 createObservabilityEnvelope),
 * 因此即便 production plane 被开启,trace 的原始 payload 也不会从这里泄漏。
 *
 * 即便 caller 通过 policy 把它们设成 enabled,这两个常量也会让 createObservabilityEnvelope
 * 强制丢弃。这是 Wave B/C 的不可协商约束。
 *
 * Wave D T11 (DRC-4) 进度更新:
 * buildComponentTelemetryBatch 已在 telemetry.ts 落地,可产出通过 CRC-6 gate 的
 * ComponentTelemetryBatch。但本常量仍保持 true —— Wave D T11 不接通 production sink,
 * 因为:(1) 真实 sink pipeline 属 Wave E(M-052)交付;(2) 即便 batch 已 ready,
 *   仍需 Wave E 的 local buffer/flush/rotation/retention 才能安全投递;
 * (3) BRC-7 测试要求本常量翻转的 drop_reason_code 保持稳定。
 * 真正把此常量改为 false 是 Wave E 的工作,届时需同步更新 observability-envelopes.test.ts。
 */
const WAVE_B_FULL_DUMP_DISABLED = true;
const WAVE_B_PRODUCTION_TELEMETRY_DISABLED = true;

/** Wave B 已知 plane 集合(用于识别"被 as any 走私进来的未知 plane")。 */
const KNOWN_PLANES: ReadonlySet<ObservabilityPlane> = new Set<ObservabilityPlane>([
  'local_debug',
  'full_request_dump',
  'decision_trace',
  'production_telemetry',
]);

/**
 * 判断一个 (plane, sensitivity, redaction_state) 组合能否进入投递通道。
 *
 * 这是与 createObservabilityEnvelope 共享的同一份准入逻辑(spec §13.3 / §13.4 / §13.5),
 * caller 可以用它做"预检",避免构造一个注定会被丢弃的信封。
 *
 * 返回值仅 true / false,不返回 drop_reason_code(那是 result 对象的字段)。
 */
export function canEnterPlane(
  plane: ObservabilityPlane,
  sensitivity: ObservabilitySensitivity,
  redaction_state: ObservabilityRedactionState,
  policies: ObservabilityPlanePolicies,
): boolean {
  // 1. 未知 plane(被 as any 走私)→ 一律拒绝。
  if (!KNOWN_PLANES.has(plane)) {
    return false;
  }

  // 2. Wave B 硬编码通道:full_request_dump / production_telemetry 永远关闭。
  if (plane === 'full_request_dump' && WAVE_B_FULL_DUMP_DISABLED) {
    return false;
  }
  if (plane === 'production_telemetry' && WAVE_B_PRODUCTION_TELEMETRY_DISABLED) {
    return false;
  }

  // 3. redaction 必须 not_required 或 redacted;pending / dropped 一律拒绝。
  if (redaction_state === 'pending' || redaction_state === 'dropped') {
    return false;
  }

  // 4. sensitivity === 'unknown' 仅在 production_telemetry 上被显式禁止(spec §13.4 invariant)。
  //    Wave B 里 production_telemetry 在第 2 步已被拦截,这里保留为完整逻辑(为 Wave C 预留)。
  if (plane === 'production_telemetry' && sensitivity === 'unknown') {
    return false;
  }

  // 5. 该 plane 的 policy 必须开启。
  return policies[plane].enabled === true;
}

/**
 * 根据准入逻辑计算 drop_reason_code(仅在 canEnterPlane 返回 false 时有意义)。
 * 返回 null 表示"不应被丢弃"。
 *
 * 注意:这是 createObservabilityEnvelope 内部使用的"原因解释器",顺序与 canEnterPlane 保持一致。
 */
function explainDropReason(
  plane: ObservabilityPlane,
  redaction_state: ObservabilityRedactionState,
  sensitivity: ObservabilitySensitivity,
  policies: ObservabilityPlanePolicies,
): string | null {
  if (!KNOWN_PLANES.has(plane)) {
    return 'plane.unknown';
  }

  if (plane === 'full_request_dump' && WAVE_B_FULL_DUMP_DISABLED) {
    return 'plane.disabled.wave_b_full_dump';
  }
  if (plane === 'production_telemetry' && WAVE_B_PRODUCTION_TELEMETRY_DISABLED) {
    return 'plane.disabled.wave_b_production';
  }

  if (redaction_state === 'pending') {
    return 'redaction.pending';
  }
  if (redaction_state === 'dropped') {
    return 'redaction.dropped';
  }

  if (plane === 'production_telemetry' && sensitivity === 'unknown') {
    return 'sensitivity.unknown_for_production';
  }

  if (policies[plane].enabled !== true) {
    return 'plane.disabled';
  }

  return null;
}

/**
 * 构造一个可观测性信封,并根据 plane / policies 决定投递或丢弃。
 *
 * 步骤:
 * 1. 校验身份字段(event_id / event_type / component_ref / occurred_at / payload_schema_id)
 *    —— 空值直接抛错,这是身份校验,不是准入决定。
 * 2. 计算准入结果(canEnterPlane);若被拒,返回 dropped + 对应 drop_reason_code。
 * 3. 构造信封(decision_trace 强制 payload_ref = null)。
 * 4. 深冻结信封,返回 emitted。
 *
 * 注意:本函数永不抛出"准入失败"异常——所有失败都通过 result 对象表达,
 * 这样上层(sink 失败)绝不会影响 SecurityDecision / CompletionReport / streaming Outcome。
 */
export function createObservabilityEnvelope(
  input: CreateObservabilityEnvelopeInput,
  policies: ObservabilityPlanePolicies,
): CreateObservabilityEnvelopeResult {
  // Step 1: 身份校验(抛错,不做静默丢弃)。
  requireIdentity(input.event_id, 'event_id');
  requireIdentity(input.event_type, 'event_type');
  requireIdentity(input.component_ref, 'component_ref');
  requireIdentity(input.occurred_at, 'occurred_at');
  requireIdentity(input.payload_schema_id, 'payload_schema_id');

  // Step 2: 准入决策。先解释原因,再据 boolean 决定走向。
  const reason = explainDropReason(
    input.plane,
    input.redaction_state,
    input.sensitivity,
    policies,
  );
  if (reason !== null) {
    return {
      status: 'dropped',
      envelope: null,
      drop_reason_code: reason,
    };
  }

  // Step 3: 构造信封。decision_trace 强制 payload_ref = null(no schema in Wave B)。
  const envelope: ObservabilityEventEnvelope = {
    observability_protocol_version: input.observability_protocol_version,
    event_id: input.event_id,
    event_type: input.event_type,
    plane: input.plane,
    occurred_at: input.occurred_at,
    session_ref: input.session_ref,
    request_snapshot_ref: input.request_snapshot_ref,
    component_ref: input.component_ref,
    payload_schema_id: input.payload_schema_id,
    sensitivity: input.sensitivity,
    redaction_state: input.redaction_state,
    payload_ref: input.plane === 'decision_trace' ? null : input.payload_ref,
  };

  // Step 4: 深冻结,返回 emitted。
  const frozen = freezeSnapshot(envelope);
  return {
    status: 'emitted',
    envelope: frozen,
    drop_reason_code: null,
  };
}
