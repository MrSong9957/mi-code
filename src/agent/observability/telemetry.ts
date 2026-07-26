// M-055 Component Measurements (Wave D / DRC-4)
//
// 物理本质:"可归因、可比较、默认不含正文的组件级 telemetry event 构建器"。
// 一次 measure 调用产出:要么是 ComponentTelemetryEvent(可进入 production plane),
// 要么是 DroppedTelemetryEvent(携带 reason_codes,供下游 batch/audit 用)。
//
// 关键不变量(spec §10.6 / §10.8):
// 1. estimator 与 Provider usage 必须在分离的 kind/scope/method 中(INV-D12 / §10.6 rule 3、4)。
//    - estimator → kind=estimated_component_tokens, scope=component, provider_id 可空。
//    - Provider 输入 → kind=provider_reported_input_tokens,  scope=request,  provider_id 必填。
//    - Provider 输出 → kind=provider_reported_output_tokens, scope=response, provider_id 必填。
//    Provider 只报告 request aggregate 时,不得按字符比例伪造 section 级 Provider token(§10.3)。
// 2. 默认 metadata-only:不含 Prompt body / tool description body / user content / source code /
//    filesystem path / credential(§10.6 rule 10)。content_hash 仅用于漂移检测,不等于允许记录 content,
//    也不被描述为匿名化(§10.4)。
// 3. 非法 component identity / field_policy_ref / redaction_result_ref / 数值 / hash 缺失 → drop event。
// 4. 非法 measurement(method/version/value/scope 不一致/provider 缺失)→ drop measurement,event 仍可发出。
// 5. 这是纯函数:不读全局、不写 sink、不修改传入 input、不缓存原值。
//    sink failure 与本函数无关(§10.6 rule 13 / §10.8)。

import { createHash } from 'node:crypto';
import { freezeSnapshot } from '../contracts/identities.js';

/** 可观测组件的种类(spec §10.2)。 */
export type TelemetryComponentKind =
  | 'prompt_section'
  | 'tool_schema'
  | 'compiled_prompt'
  | 'tool_view'
  | 'semantic_request';

/** 组件引用 —— component_id 必须来自 RC/BRC/CRC 已冻结的 stable identity(§10.2)。 */
export interface TelemetryComponentRef {
  component_kind: TelemetryComponentKind;
  component_id: string;
  component_version: string;
  source_snapshot_id: string;
}

/** token 指标的种类(spec §10.3)。 */
export type TokenMeasurementKind =
  | 'estimated_component_tokens'
  | 'provider_reported_input_tokens'
  | 'provider_reported_output_tokens';

/** 一个 token 指标适用的范围(§10.3)。 */
export type TokenMeasurementScope =
  | 'component'
  | 'compiled_prompt'
  | 'tool_view'
  | 'request'
  | 'response';

/** 单个 token 指标(§10.3)。 */
export interface TokenMeasurement {
  measurement_kind: TokenMeasurementKind;
  value: number;
  scope: TokenMeasurementScope;
  method_id: string;
  method_version: string;
  provider_id: string | null;
  model_id: string | null;
}

/** measureTelemetryComponent 的输入。 */
export interface ComponentTelemetryEventInput {
  component_telemetry_protocol_version: string;
  request_snapshot_id: string;
  component_ref: TelemetryComponentRef;
  profile_ref: string | null;
  variant_ref: string | null;
  included: boolean;
  inclusion_reason_code: string;
  byte_count: number;
  character_count: number;
  content_hash: string;
  token_measurements: TokenMeasurement[];
  field_policy_ref: string;
  redaction_result_ref: string;
}

/** 构建出的 ComponentTelemetryEvent(深冻结)。 */
export interface ComponentTelemetryEvent extends ComponentTelemetryEventInput {
  event_id: string;
}

/** 被丢弃的事件信封(只有 reason_codes,不含任何 payload 字段)。 */
export interface DroppedTelemetryEvent {
  dropped: true;
  reason_codes: string[];
}

/** Telemetry 协议版本(外部可断言)。 */
export const COMPONENT_TELEMETRY_PROTOCOL_VERSION = '1';

/**
 * scope/kind 一致性矩阵(§10.6 rule 4 / §10.8)。
 *
 * 每种 measurement_kind 只允许唯一一个 scope。这强制把 estimator 与 Provider usage
 * 分到不同的 kind/scope/method 槽位,从而满足 INV-D12。
 * Provider 只报告 request aggregate 时,无法通过 §10.3 的字符比例伪装成 section 级 Provider token。
 */
const REQUIRED_SCOPE_FOR_KIND: Readonly<Record<TokenMeasurementKind, TokenMeasurementScope>> = {
  estimated_component_tokens: 'component',
  provider_reported_input_tokens: 'request',
  provider_reported_output_tokens: 'response',
};

/** 需要 provider_id 必填的 kind 集合(§10.6 rule 4)。 */
const PROVIDER_REQUIRED_KINDS: ReadonlySet<TokenMeasurementKind> = new Set<TokenMeasurementKind>([
  'provider_reported_input_tokens',
  'provider_reported_output_tokens',
]);

/**
 * 构建一个 component telemetry event。
 *
 * 步骤(规格 §10.6 / §10.8):
 * 1. component identity 守门 —— id/version/source 任何一个非空失败 → drop event。
 * 2. byte_count / character_count 必须有限、非负整数 → 否则 drop event。
 * 3. content_hash 非空 → 否则 drop event(hash 计算失败不允许空 hash 冒充成功,§10.8)。
 * 4. field_policy_ref / redaction_result_ref 非空 → 否则 drop event。
 * 5. 逐 measurement 清洗:
 *    - method_id / method_version 非空(§10.6 rule 3,§10.8)。
 *    - value 有限、非负整数(§10.6 rule 5)。
 *    - scope 必须等于该 kind 的法定 scope(§10.6 rule 4)。
 *    - provider_reported_* 必须有 provider_id(§10.6 rule 4)。
 *    非法的 measurement 被剔除,event 仍然可以发出。
 * 6. 计算 event_id = `ct:${sha256(canonical).slice(0,16)}`。
 * 7. 深冻结并返回。
 *
 * 纯函数 —— 不写 sink,不缓存原值,不修改 input。
 */
export function measureTelemetryComponent(
  input: ComponentTelemetryEventInput,
): ComponentTelemetryEvent | DroppedTelemetryEvent {
  // Step 1: component identity 守门。
  const ref = input.component_ref;
  if (
    !isNonEmptyString(ref?.component_id) ||
    !isNonEmptyString(ref?.component_version) ||
    !isNonEmptyString(ref?.source_snapshot_id)
  ) {
    return dropped(['telemetry.missing_component_identity']);
  }

  // Step 2: byte_count / character_count 数值守门(§10.6 rule 5)。
  if (!isFiniteNonNegInt(input.byte_count)) {
    return dropped(['telemetry.invalid_byte_count']);
  }
  if (!isFiniteNonNegInt(input.character_count)) {
    return dropped(['telemetry.invalid_character_count']);
  }

  // Step 3: content_hash 非空(§10.8:hash 失败 → drop,不允许空 hash 冒充)。
  if (!isNonEmptyString(input.content_hash)) {
    return dropped(['telemetry.missing_content_hash']);
  }

  // Step 4: field_policy_ref / redaction_result_ref 非空(§10.8)。
  if (!isNonEmptyString(input.field_policy_ref)) {
    return dropped(['telemetry.missing_field_policy_ref']);
  }
  if (!isNonEmptyString(input.redaction_result_ref)) {
    return dropped(['telemetry.missing_redaction_result_ref']);
  }

  // Step 5: 清洗 measurements(非法的剔除,event 不丢)。
  const cleanedMeasurements = cleanMeasurements(input.token_measurements ?? []);

  // Step 6: 计算 event_id。
  const event_id = computeEventId(input, cleanedMeasurements);

  // Step 7: 装配并冻结。
  // 字段集是 metadata-only 的闭集:不含 prompt body / tool description body /
  // user content / source code / filesystem path / credential(§10.6 rule 10)。
  const event: ComponentTelemetryEvent = {
    component_telemetry_protocol_version: input.component_telemetry_protocol_version,
    event_id,
    request_snapshot_id: input.request_snapshot_id,
    component_ref: input.component_ref,
    profile_ref: input.profile_ref,
    variant_ref: input.variant_ref,
    included: input.included,
    inclusion_reason_code: input.inclusion_reason_code,
    byte_count: input.byte_count,
    character_count: input.character_count,
    content_hash: input.content_hash,
    token_measurements: cleanedMeasurements,
    field_policy_ref: input.field_policy_ref,
    redaction_result_ref: input.redaction_result_ref,
  };

  return freezeSnapshot(event);
}

/**
 * 清洗 measurement 数组:剔除所有非法 measurement。
 *
 * 非法条件(任一即剔除):
 * - method_id / method_version 非空失败(§10.6 rule 3,§10.8)。
 * - value 非有限 / 负数 / 非整数(§10.6 rule 5)。
 * - scope 与 kind 不一致(§10.6 rule 4,见 REQUIRED_SCOPE_FOR_KIND)。
 * - provider_reported_* 缺失 provider_id(§10.6 rule 4)。
 */
function cleanMeasurements(measurements: TokenMeasurement[]): TokenMeasurement[] {
  const kept: TokenMeasurement[] = [];
  for (const m of measurements) {
    if (!isNonEmptyString(m?.method_id) || !isNonEmptyString(m?.method_version)) {
      continue;
    }
    if (!isFiniteNonNegInt(m?.value)) {
      continue;
    }
    const expectedScope = REQUIRED_SCOPE_FOR_KIND[m?.measurement_kind];
    if (expectedScope === undefined || m.scope !== expectedScope) {
      // 未知 kind 或 scope/kind 不匹配 → 剔除(INV-D12 隔离 + §10.6 rule 4)。
      continue;
    }
    if (PROVIDER_REQUIRED_KINDS.has(m.measurement_kind)) {
      if (!isNonEmptyString(m.provider_id)) {
        // Provider usage 必须有 provider_id;estimator 允许 null。
        continue;
      }
    }
    kept.push(m);
  }
  return kept;
}

/** 基于稳定字段计算 event_id(仅数据字段,不含函数)。 */
function computeEventId(
  input: ComponentTelemetryEventInput,
  measurements: TokenMeasurement[],
): string {
  const canonical = JSON.stringify([
    input.component_telemetry_protocol_version,
    input.request_snapshot_id,
    [
      input.component_ref.component_kind,
      input.component_ref.component_id,
      input.component_ref.component_version,
      input.component_ref.source_snapshot_id,
    ],
    input.profile_ref,
    input.variant_ref,
    input.included,
    input.inclusion_reason_code,
    input.byte_count,
    input.character_count,
    input.content_hash,
    measurements.map(measurementTuple),
    input.field_policy_ref,
    input.redaction_result_ref,
  ]);
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `ct:${digest.slice(0, 16)}`;
}

/** 把 measurement 折成稳定元组(确保 hash 不依赖对象 key 插入顺序)。 */
function measurementTuple(m: TokenMeasurement): unknown[] {
  return [
    m.measurement_kind,
    m.value,
    m.scope,
    m.method_id,
    m.method_version,
    m.provider_id,
    m.model_id,
  ];
}

/** 非空字符串判定(trim 后非空)。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 有限、非负、整数(用于 byte/character/token count,§10.6 rule 5)。 */
function isFiniteNonNegInt(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

/** 构造 dropped 信封(冻结)。 */
function dropped(reason_codes: string[]): DroppedTelemetryEvent {
  return freezeSnapshot({ dropped: true as const, reason_codes });
}

// ============================================================================
// M-064 Telemetry Batch (Wave D / DRC-4 / T11)
//
// 物理本质:"批次组装台"。
// 把多个已通过 CRC-6 gate 的 ComponentTelemetryEvent 装进一个 ComponentTelemetryBatch。
// batch 要么 status='ready'(可进入 production plane,由 Wave E 真实 sink 接收),
// 要么 status='dropped'(任一 event 未过 CRC-6 gate / 缺身份 / snapshot 不一致)。
//
// 关键不变量(INV-D13 / spec §10.5 / §10.6 rule 4 / §10.8):
// 1. 先最小化(每个 event 已是 metadata-only,由 measureTelemetryComponent 保证),
//    再清洗(redaction_result_ref 必须非空,证明已过 CRC-6 gate)。
// 2. production batch 只含通过 CRC-6 gate 的 event;一旦任一 event 不合规,
//    整个 batch dropped 且 events=[] (不携带未清洗 event 原文)。
// 3. provider_usage_ref 只保留 Provider 实际返回的 request/response scope,
//    只挂在 batch 级别,不按 component 重新分配(§10.6 rule 4,§10.8)。
// 4. 纯函数:不写 sink、不缓存原值、不修改传入 input。
//    sink failure 与本函数无关(INV-D11 / §10.6 rule 13 / §10.8)。
// 5. 不实现 Wave E local buffer/flush/rotation/retention。
// ============================================================================

/** buildComponentTelemetryBatch 的输入(身份字段必填,events 来自 D-1 T10)。 */
export interface ComponentTelemetryBatchInput {
  component_telemetry_protocol_version: string;
  request_snapshot_id: string;
  compiled_prompt_snapshot_id: string;
  final_tool_view_snapshot_id: string;
  profile_selection_id: string | null;
  /** 已由 measureTelemetryComponent 产出的 event 列表(理论上已过 CRC-6 gate)。 */
  events: ReadonlyArray<ComponentTelemetryEvent>;
  /**
   * Provider 实际返回的 request/response scope usage 引用(§10.6 rule 4)。
   * null 表示本次没有 Provider usage(纯 estimator 批次)。
   */
  provider_usage_ref: string | null;
}

/** 构建出的 ComponentTelemetryBatch(深冻结)。 */
export interface ComponentTelemetryBatch {
  component_telemetry_protocol_version: string;
  batch_id: string;
  request_snapshot_id: string;
  compiled_prompt_snapshot_id: string;
  final_tool_view_snapshot_id: string;
  profile_selection_id: string | null;
  events: ComponentTelemetryEvent[];
  provider_usage_ref: string | null;
  status: 'ready' | 'dropped';
  reason_codes: string[];
}

/**
 * 构建一个 component telemetry batch。
 *
 * 步骤(spec §10.5 / §10.8):
 * 1. snapshot identity 守门 —— request/compiled_prompt/final_tool_view 任何一个非空失败
 *    → dropped 'telemetry.snapshot_identity_missing'。
 * 2. 逐 event 校验:
 *    a. CRC-6 gate —— redaction_result_ref 非空(§10.8:field policy/redaction result 缺失 drop event)。
 *    b. event identity —— event_id / content_hash / field_policy_ref 非空(§10.8:component identity 缺失 drop event)。
 *    c. snapshot 一致性 —— event.request_snapshot_id === input.request_snapshot_id。
 *    任一失败 → 收集对应 reason code,该 event 不入 batch。
 * 3. 任一 event 失败 → status='dropped', events=[] (不携带未清洗 event 原文,INV-D13)。
 * 4. 全部通过 → status='ready', events 保留原顺序。
 * 5. 计算 batch_id = `batch:${sha256(canonical).slice(0,16)}`。
 * 6. 深冻结并返回。
 *
 * provider_usage_ref 不参与 event 分配,只作为 batch 级别的 Provider aggregate 引用(§10.6 rule 4)。
 *
 * 纯函数 —— 不写 sink,不缓存原值,不修改 input。
 */
export function buildComponentTelemetryBatch(
  input: ComponentTelemetryBatchInput,
): ComponentTelemetryBatch {
  const reason_codes: string[] = [];

  // Step 1: snapshot identity 守门。
  if (
    !isNonEmptyString(input.request_snapshot_id) ||
    !isNonEmptyString(input.compiled_prompt_snapshot_id) ||
    !isNonEmptyString(input.final_tool_view_snapshot_id)
  ) {
    reason_codes.push('telemetry.snapshot_identity_missing');
  }

  // Step 2: 逐 event 校验。任一失败即收集 reason,但只有全部通过才进入 ready 分支。
  let allEventsValid = reason_codes.length === 0;
  if (allEventsValid) {
    for (const event of input.events) {
      // CRC-6 gate(§10.8:field policy/redaction result 缺失 → drop event)。
      if (!isNonEmptyString(event?.redaction_result_ref)) {
        reason_codes.push('telemetry.redaction_result_missing');
        allEventsValid = false;
        continue;
      }
      // event identity:event_id / content_hash / field_policy_ref(§10.8)。
      if (
        !isNonEmptyString(event?.event_id) ||
        !isNonEmptyString(event?.content_hash) ||
        !isNonEmptyString(event?.field_policy_ref)
      ) {
        reason_codes.push('telemetry.event_invalid');
        allEventsValid = false;
        continue;
      }
      // snapshot 一致性(§10.5:同一 batch 必须共享 request snapshot)。
      if (event?.request_snapshot_id !== input.request_snapshot_id) {
        reason_codes.push('telemetry.snapshot_mismatch');
        allEventsValid = false;
        continue;
      }
    }
  }

  // Step 3 & 4: 根据 reason_codes 是否为空决定 status 与 events。
  const status: 'ready' | 'dropped' = reason_codes.length === 0 ? 'ready' : 'dropped';
  const events: ComponentTelemetryEvent[] =
    status === 'ready' ? [...input.events] : [];
  // 去重 reason_codes(保持首次出现顺序):同一 reason 跨多个 event 不重复。
  const dedupedReasons = dedupPreserveOrder(reason_codes);

  // Step 5: 计算 batch_id。
  // canonical 仅依赖"对外可见字段",与 status 无关 —— 这样同输入一定得同 batch_id,
  // 同时 dropped batch 的 batch_id 也可追溯(便于 audit reason_codes 的来源)。
  const batch_id = computeBatchId(input, events, status, dedupedReasons);

  // Step 6: 装配并冻结。
  const batch: ComponentTelemetryBatch = {
    component_telemetry_protocol_version: input.component_telemetry_protocol_version,
    batch_id,
    request_snapshot_id: input.request_snapshot_id,
    compiled_prompt_snapshot_id: input.compiled_prompt_snapshot_id,
    final_tool_view_snapshot_id: input.final_tool_view_snapshot_id,
    profile_selection_id: input.profile_selection_id,
    events,
    provider_usage_ref: input.provider_usage_ref,
    status,
    reason_codes: dedupedReasons,
  };

  return freezeSnapshot(batch);
}

/** 去重字符串数组,保持首次出现顺序(用于 reason_codes)。 */
function dedupPreserveOrder(codes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of codes) {
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/**
 * 基于稳定字段计算 batch_id。
 *
 * canonical 序列化包含:protocol_version / 三个 snapshot / profile_selection /
 * events 的 event_id 列表(顺序敏感)/ provider_usage_ref / status / reason_codes。
 *
 * 不包含 events 内部的 token_measurements / content_hash 等明细 ——
 * batch_id 表达的是"这批 event 的指纹聚合",而非每个 event 的完整快照。
 * 每个 event 自身有 event_id 作为指纹,二者解耦。
 */
function computeBatchId(
  input: ComponentTelemetryBatchInput,
  events: ComponentTelemetryEvent[],
  status: 'ready' | 'dropped',
  reason_codes: string[],
): string {
  const canonical = JSON.stringify([
    input.component_telemetry_protocol_version,
    input.request_snapshot_id,
    input.compiled_prompt_snapshot_id,
    input.final_tool_view_snapshot_id,
    input.profile_selection_id,
    events.map((e) => e.event_id),
    input.provider_usage_ref,
    status,
    reason_codes,
  ]);
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `batch:${digest.slice(0, 16)}`;
}
