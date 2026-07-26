// M-056 Telemetry Field Policy + Redaction (Wave C / CRC-6)
//
// 物理本质:"发送前清洗台"。
// 任何 event 在进入 production telemetry 之前,必须先经过字段 allowlist、PII label、
// minimum-action 规则的清洗 —— 输出要么是 redacted payload 的引用,要么是 dropped。
//
// 关键不变量(spec §12.3 / §12.5 / §12.6):
// 1. event type 必须有字段 allowlist;未列字段默认 drop_field(§12.5 rule 1)。
// 2. credential → 强制 drop_event,不能 hash 后发送(§12.5 rule 2)。
// 3. sensitive_auth → 强制 drop_event;direct_identifier 至少 drop_field;
//    potential_identifier 不得原样 keep,至少 hash/redact/drop_field(§12.5 rule 3)。
// 4. unknown field class 或缺失 PII label → drop_field(§12.5 rule 6)。
// 5. hash 不等于匿名化(applied_actions 仍标记 field_class)(§12.5 rule 5)。
// 6. event_type 不匹配 policy → drop event(§12.6)。
// 7. redaction failure → dropped(§12.5 rule 8)。
// 8. output payload 不得携带原始值的旁路副本(§12.5 rule 9)。
// 9. sink failure 不改变业务 Outcome / SecurityDecision / CompletionReport(§12.5 rule 12)。
//
// 这是纯函数:不写 sink、不缓存原值、不修改传入 event。

import { createHash } from 'node:crypto';
import { freezeSnapshot } from '../contracts/identities.js';

/** 字段敏感度分类(spec §12.3)。 */
export type TelemetryFieldClass =
  | 'operational_metadata'
  | 'pseudonymous_identifier'
  | 'filesystem_path'
  | 'user_content'
  | 'source_code'
  | 'credential'
  | 'unknown';

/** 字段处置动作(spec §12.3)。 */
export type TelemetryFieldAction =
  | 'keep'
  | 'hash'
  | 'redact'
  | 'drop_field'
  | 'drop_event';

/** 字段 PII 标签(spec §12.3)。 */
export type TelemetryPiiLabel =
  | 'none'
  | 'potential_identifier'
  | 'direct_identifier'
  | 'sensitive_auth';

/** 单个允许字段的策略。 */
export interface TelemetryFieldSpec {
  field_class: TelemetryFieldClass;
  pii_label: TelemetryPiiLabel;
  action: TelemetryFieldAction;
}

/** 一个 event type 的字段策略集合(字段 allowlist)。 */
export interface TelemetryFieldPolicy {
  field_policy_id: string;
  field_policy_version: string;
  event_type: string;
  allowed_fields: Readonly<Record<string, TelemetryFieldSpec>>;
}

/** 待清洗的 event 输入。 */
export interface TelemetryEventInput {
  event_id: string;
  event_type: string;
  /** 实际 payload —— 不会被修改,只读以决定清洗结果。 */
  fields: Record<string, unknown>;
}

/** 单字段的处置记录(applied_actions 元素)。 */
export interface TelemetryAppliedAction {
  field_path: string;
  field_class: TelemetryFieldClass;
  pii_label: TelemetryPiiLabel;
  action: TelemetryFieldAction;
}

/** redaction 结果。 */
export interface TelemetryRedactionResult {
  redaction_protocol_version: string;
  redaction_id: string;
  source_event_id: string;
  field_policy_ref: string;
  status: 'redacted' | 'dropped';
  output_payload_ref: string | null;
  applied_actions: ReadonlyArray<TelemetryAppliedAction>;
  reason_codes: string[];
}

/** redaction 协议版本(外部可断言)。 */
export const REDACTION_PROTOCOL_VERSION = '1';

/**
 * redact 一个 event。
 *
 * 步骤:
 * 1. event_type 不匹配 policy → 立即 dropped(§12.6)。
 * 2. 逐字段计算 effective action(minimum floor + policy action 取更严)。
 * 3. 任一字段被强制 drop_event → 整个 event dropped(§12.5 rule 2/3)。
 * 4. 否则:status=redacted,output_payload_ref = sha256(redacted payload 序列化)。
 * 5. 计算 redaction_id = `red:${sha256(canonical).slice(0,16)}`。
 *
 * 纯函数:不修改 event,不写 sink,不缓存。
 */
export function redactTelemetryEvent(
  event: TelemetryEventInput,
  policy: TelemetryFieldPolicy,
): TelemetryRedactionResult {
  const field_policy_ref = `${policy.field_policy_id}:${policy.field_policy_version}`;

  // Step 1: event_type 校验。
  if (event.event_type !== policy.event_type) {
    return finishDropped(event, field_policy_ref, [], ['redaction.event_type_mismatch']);
  }

  // Step 2: 逐字段决定 effective action。
  const applied: TelemetryAppliedAction[] = [];
  let forcedDropReason: string | null = null;

  for (const fieldPath of Object.keys(event.fields)) {
    const spec = policy.allowed_fields[fieldPath];
    if (spec === undefined) {
      // 未列字段 → unknown class, drop_field(§12.5 rule 1 / rule 6)。
      applied.push({
        field_path: fieldPath,
        field_class: 'unknown',
        pii_label: 'none',
        action: 'drop_field',
      });
      continue;
    }

    const effective = computeEffectiveAction(spec);
    applied.push({
      field_path: fieldPath,
      field_class: spec.field_class,
      pii_label: spec.pii_label,
      action: effective,
    });

    if (effective === 'drop_event') {
      // credential / sensitive_auth → 强制整事件 drop。
      forcedDropReason =
        spec.field_class === 'credential'
          ? 'redaction.credential_detected'
          : 'redaction.sensitive_auth_detected';
    }
  }

  // Step 3: 强制 drop event 优先。
  if (forcedDropReason !== null) {
    return finishDropped(event, field_policy_ref, applied, [forcedDropReason]);
  }

  // Step 4: status=redacted。计算 redacted payload 的 ref。
  const redactedPayload = buildRedactedPayload(event, policy, applied);
  const output_payload_ref = createHash('sha256')
    .update(stableStringify(redactedPayload))
    .digest('hex');

  // Step 5: 计算 redaction_id。
  const reason_codes = collectReasonCodes(applied);
  const redaction_id = computeRedactionId(event, field_policy_ref, applied, output_payload_ref);

  const result: TelemetryRedactionResult = {
    redaction_protocol_version: REDACTION_PROTOCOL_VERSION,
    redaction_id,
    source_event_id: event.event_id,
    field_policy_ref,
    status: 'redacted',
    output_payload_ref,
    applied_actions: applied,
    reason_codes,
  };

  return freezeSnapshot(result);
}

/**
 * 决定一个 allowed 字段的 effective action。
 *
 * 在 policy.action 的基础上,叠加 minimum-action floor(spec §12.5 rule 2/3/6):
 * - credential → 永远 drop_event(无论 policy.action)。
 * - sensitive_auth → 永远 drop_event。
 * - direct_identifier + policy.action='keep' → drop_field(至少)。
 * - potential_identifier + policy.action='keep' → hash(至少 hash/redact/drop)。
 * - field_class='unknown' 或 pii_label 缺失 → drop_field。
 *
 * policy.action 更严时(policy='drop_field' 等)遵从 policy。
 */
function computeEffectiveAction(spec: TelemetryFieldSpec): TelemetryFieldAction {
  // 强制 drop_event(rule 2/3):credential 或 sensitive_auth,无论 policy 怎么说。
  if (spec.field_class === 'credential') {
    return 'drop_event';
  }
  if (spec.pii_label === 'sensitive_auth') {
    return 'drop_event';
  }

  // rule 6:unknown field class 或缺失 PII label → drop_field。
  if (spec.field_class === 'unknown' || spec.pii_label === undefined) {
    return 'drop_field';
  }

  // rule 3:direct_identifier 至少 drop_field。
  if (spec.pii_label === 'direct_identifier') {
    return stricterOf('drop_field', spec.action);
  }

  // rule 3:potential_identifier 至少 hash。
  if (spec.pii_label === 'potential_identifier') {
    return stricterOf('hash', spec.action);
  }

  // 否则:遵从 policy.action。
  return spec.action;
}

/**
 * 在 minimum floor 与 policy.action 之间取"更严格"的那个。
 *
 * 严格度排序(从松到严):
 *   keep < hash < redact < drop_field < drop_event
 *
 * 注意:hash 与 redact 都比 keep 严,但 redact 比 hash 更严(完全擦除 vs 单向摘要)。
 */
function stricterOf(
  floor: TelemetryFieldAction,
  policyAction: TelemetryFieldAction,
): TelemetryFieldAction {
  const rank: Record<TelemetryFieldAction, number> = {
    keep: 0,
    hash: 1,
    redact: 2,
    drop_field: 3,
    drop_event: 4,
  };
  return rank[policyAction] >= rank[floor] ? policyAction : floor;
}

/**
 * 根据应用后的 actions 构造 redacted payload(只装实际保留的字段值)。
 *
 * - keep:原值
 * - hash:`sha256(stringify(value))` 的 hex
 * - redact:`[REDACTED]`
 * - drop_field:不写入 payload
 * - drop_event:不应到达此处(已在 Step 3 提前返回)
 */
function buildRedactedPayload(
  event: TelemetryEventInput,
  policy: TelemetryFieldPolicy,
  applied: TelemetryAppliedAction[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const actionByPath = new Map(applied.map((a) => [a.field_path, a.action]));
  for (const [fieldPath, rawValue] of Object.entries(event.fields)) {
    const action = actionByPath.get(fieldPath) ?? 'drop_field';
    if (action === 'drop_field' || action === 'drop_event') {
      continue;
    }
    if (action === 'keep') {
      payload[fieldPath] = rawValue;
    } else if (action === 'hash') {
      payload[fieldPath] = createHash('sha256')
        .update(stableStringify(rawValue))
        .digest('hex');
    } else if (action === 'redact') {
      payload[fieldPath] = '[REDACTED]';
    }
    // 其他 action 不会出现(computeEffectiveAction 只产 5 个值)。
  }
  // policy.event_type 仅用于 lookup,不进入 payload —— payload 是清洗后的事件字段集合。
  void policy;
  return payload;
}

/** 收集非默认 reason_codes(unlisted_field 等)。 */
function collectReasonCodes(applied: TelemetryAppliedAction[]): string[] {
  const codes: string[] = [];
  for (const a of applied) {
    if (a.field_class === 'unknown') {
      codes.push('redaction.unlisted_field');
    }
  }
  return codes;
}

/** 构造 dropped 结果。 */
function finishDropped(
  event: TelemetryEventInput,
  field_policy_ref: string,
  applied: TelemetryAppliedAction[],
  reasons: string[],
): TelemetryRedactionResult {
  const redaction_id = computeRedactionId(event, field_policy_ref, applied, null);
  const result: TelemetryRedactionResult = {
    redaction_protocol_version: REDACTION_PROTOCOL_VERSION,
    redaction_id,
    source_event_id: event.event_id,
    field_policy_ref,
    status: 'dropped',
    output_payload_ref: null,
    applied_actions: applied,
    reason_codes: reasons,
  };
  return freezeSnapshot(result);
}

/** 基于 source event + policy + actions 计算 redaction_id。 */
function computeRedactionId(
  event: TelemetryEventInput,
  field_policy_ref: string,
  applied: TelemetryAppliedAction[],
  output_payload_ref: string | null,
): string {
  const canonical = JSON.stringify([
    event.event_id,
    event.event_type,
    field_policy_ref,
    applied.map((a) => [a.field_path, a.action]),
    output_payload_ref,
  ]);
  return `red:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

/**
 * 稳定序列化:对象 key 排序,避免不同插入顺序导致 hash 不稳定。
 * 仅用于"在函数内决定 hash",不影响对外 API 形态。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}
