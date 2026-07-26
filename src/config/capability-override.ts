// src/config/capability-override.ts
// M-059 (Wave C Task 4) Trusted Capability Override (CRC-2).
//
// 物理本质:把"受信配置对 BRC-2 adapter-default capability snapshot 的显式、可审计修正"
// 压成一张不可变的 effective 快照。
//
// 这层只负责 capability 表达的修正,不负责:
//   - tool permission / Security allow / Authority(INV-C5:supported ≠ permission allow)
//   - Agent/Prompt/Tool Result 写入口(本任务不实现,规格 §8.4 rule 3 禁止)
//   - Wave D 的任何机制(CRC-2 不为 Wave D 建立直接 D-edge,规格 §8.6 + CRC-2 #6)
//
// 关键不变量(spec §8.3 / §8.4 / §8.5):
//   - 四重 gate(trusted_source && schema_valid && deterministic_loader && exact_scope_match)
//     全部 true 才生效;任一 false → applied_override_ref=null, capabilities=base.capabilities。
//   - 每个 capability key 必须在 evidence.registered_capability_keys 内,
//     否则拒绝整条 override(不部分应用,规格 §8.5)。
//   - scope 精确匹配由 caller 通过 exact_scope_match 表达;caller 在置 true 前必须确认
//     provider_id / endpoint_scope / model_scope / base_capability_snapshot_id 四项与 base
//     精确相等。
//   - 无效 override 不修改 base snapshot。
//   - 输出 effective snapshot 深冻结 + 深拷贝。
//   - effective_capability_snapshot_id 确定性(sha256 of canonical JSON),无随机 UUID。

import { createHash } from 'node:crypto';
import { freezeSnapshot, requireIdentity } from '../agent/contracts/identities.js';
import type { CapabilitySupport, ModelCapabilitySnapshot } from '../agent/tools/capability-snapshot.js';

/** Override record 的变更项:capability name → 支持状态。 */
export type CapabilityChanges = Readonly<Record<string, CapabilitySupport>>;

/**
 * 受信配置层对 adapter 默认能力快照的单条修正记录(规格 §8.2)。
 *
 * - override_id / override_version:身份字段,需非空。
 * - source_config_ref / source_trust_proof_ref:可审计溯源引用,需非空。
 * - provider_id / endpoint_scope / model_scope / base_capability_snapshot_id:
 *   scope 字段,需与目标 base snapshot 精确匹配(exact_scope_match 语义)。
 * - changes:要覆盖的 capability 表达。
 * - justification:人类可读理由,需非空。
 */
export interface CapabilityOverrideRecord {
  readonly override_id: string;
  readonly override_version: string;
  readonly source_config_ref: string;
  readonly source_trust_proof_ref: string;
  readonly provider_id: string;
  readonly endpoint_scope: string;
  readonly model_scope: string;
  readonly base_capability_snapshot_id: string;
  readonly changes: CapabilityChanges;
  readonly justification: string;
}

/**
 * Trust gate 判据集合(规格 §8.3)。caller 必须独立给出每一项:
 *   - trusted_source:配置来源在 frozen trusted-config policy 内。
 *   - schema_valid:已通过 schema validation。
 *   - deterministic_loader:由确定性受信 loader 加载。
 *   - exact_scope_match:provider/endpoint/model/base snapshot 四项与 base 精确相等。
 *   - registered_capability_keys:capability schema 注册表(用于校验 changes 的 key)。
 */
export interface CapabilityOverrideTrustEvidence {
  readonly trusted_source: boolean;
  readonly schema_valid: boolean;
  readonly deterministic_loader: boolean;
  readonly exact_scope_match: boolean;
  readonly registered_capability_keys: ReadonlySet<string>;
}

/**
 * 应用 override 后的 effective 能力快照(规格 §8.2)。
 * 一旦创建即不可变(深冻结)。
 */
export interface EffectiveCapabilitySnapshot {
  readonly capability_protocol_version: string;
  readonly effective_capability_snapshot_id: string;
  readonly base_capability_snapshot_id: string;
  readonly applied_override_ref: string | null;
  readonly provider_id: string;
  readonly endpoint_scope: string;
  readonly model_scope: string;
  readonly capabilities: Readonly<Record<string, CapabilitySupport>>;
  readonly diagnostics: readonly string[];
}

/** 合法的 capability value 字面量集合(精确匹配)。 */
const ALLOWED_SUPPORT_VALUES: ReadonlySet<string> = new Set([
  'supported',
  'unsupported',
  'unknown',
]);

/**
 * 把一份 base snapshot 与一条 override 在给定 evidence 下合成 effective snapshot。
 *
 * 算法:
 *   1. 四重 gate 全开才考虑应用。任一 false → applied_override_ref=null,
 *      capabilities=base.capabilities,diagnostics 标注被哪个 gate 拦。
 *   2. changes 的每个 key 必须在 evidence.registered_capability_keys 内,且每个 value
 *      必须是合法字面量。任何非法 → 拒绝整条 override(不部分应用)。
 *   3. 应用:capabilities = base.capabilities ⊕ override.changes(深拷贝隔离)。
 *   4. effective_capability_snapshot_id = sha256(canonical JSON of payload)。
 *   5. 输出递归冻结。
 *
 * 本函数不读 base.capabilities 之外的 scope 字段(base 没有 endpoint_scope / model_scope),
 * scope 一致性由 evidence.exact_scope_match 表达,caller 负责。
 */
export function applyCapabilityOverride(
  base: ModelCapabilitySnapshot,
  override: CapabilityOverrideRecord,
  evidence: CapabilityOverrideTrustEvidence,
): EffectiveCapabilitySnapshot {
  const protocol = base.capability_protocol_version;
  const baseSnapshotId = base.capability_snapshot_id;

  // Gate 1:四重 trust gate(spec §8.3)。
  // 任一 false → 不应用,diagnostics 标注被哪个 gate 拦。
  const gateFailures: string[] = [];
  if (!evidence.trusted_source) {
    gateFailures.push('trust gate blocked override: trusted_source=false');
  }
  if (!evidence.schema_valid) {
    gateFailures.push('trust gate blocked override: schema_valid=false');
  }
  if (!evidence.deterministic_loader) {
    gateFailures.push('trust gate blocked override: deterministic_loader=false');
  }
  if (!evidence.exact_scope_match) {
    gateFailures.push('trust gate blocked override: exact_scope_match=false (scope mismatch)');
  }

  if (gateFailures.length > 0) {
    // 失败也产出 effective snapshot(不抛错),但 applied_override_ref=null,base 原样回退。
    // spec §8.4 rule 5 / §8.5 错误语义。
    return buildEffectiveSnapshot({
      capability_protocol_version: protocol,
      base_capability_snapshot_id: baseSnapshotId,
      applied_override_ref: null,
      provider_id: base.provider_id,
      endpoint_scope: override.endpoint_scope,
      model_scope: override.model_scope,
      capabilities: copyCapabilities(base.capabilities),
      diagnostics: [...gateFailures],
    });
  }

  // Gate 2:capability key 注册检查 + value 合法性检查(spec §8.3 #6 / §8.5)。
  // 任何非法 → 拒绝整条 override,不部分应用。
  const keyErrors: string[] = [];
  const changesEntries = Object.entries(override.changes);
  for (const [key, rawValue] of changesEntries) {
    if (!evidence.registered_capability_keys.has(key)) {
      keyErrors.push(
        `unknown capability key "${key}" rejected (not in registered_capability_keys)`,
      );
      continue;
    }
    if (typeof rawValue !== 'string' || !ALLOWED_SUPPORT_VALUES.has(rawValue)) {
      keyErrors.push(
        `invalid capability support value for "${key}": ${JSON.stringify(rawValue)}`,
      );
    }
  }
  if (keyErrors.length > 0) {
    return buildEffectiveSnapshot({
      capability_protocol_version: protocol,
      base_capability_snapshot_id: baseSnapshotId,
      applied_override_ref: null,
      provider_id: base.provider_id,
      endpoint_scope: override.endpoint_scope,
      model_scope: override.model_scope,
      capabilities: copyCapabilities(base.capabilities),
      diagnostics: [
        'override rejected: one or more capability keys are unknown or values invalid (entire override rejected, no partial application)',
        ...keyErrors,
      ],
    });
  }

  // 成功路径:capabilities = base ⊕ changes(深拷贝,不污染 base)。
  const merged: Record<string, CapabilitySupport> = copyCapabilities(base.capabilities);
  for (const [key, value] of changesEntries) {
    merged[key] = value as CapabilitySupport;
  }

  return buildEffectiveSnapshot({
    capability_protocol_version: protocol,
    base_capability_snapshot_id: baseSnapshotId,
    applied_override_ref: requireIdentity(override.override_id, 'override_id'),
    provider_id: base.provider_id,
    endpoint_scope: override.endpoint_scope,
    model_scope: override.model_scope,
    capabilities: merged,
    diagnostics: [
      `override applied: ${override.override_id} (version ${override.override_version})`,
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────────────────────

interface EffectiveSnapshotInput {
  capability_protocol_version: string;
  base_capability_snapshot_id: string;
  applied_override_ref: string | null;
  provider_id: string;
  endpoint_scope: string;
  model_scope: string;
  capabilities: Record<string, CapabilitySupport>;
  diagnostics: string[];
}

/**
 * 构造 effective snapshot 并冻结。effective_capability_snapshot_id 由
 * sha256(canonical JSON of payload) 确定性计算。
 */
function buildEffectiveSnapshot(input: EffectiveSnapshotInput): EffectiveCapabilitySnapshot {
  const effectiveId = computeEffectiveId({
    capability_protocol_version: input.capability_protocol_version,
    base_capability_snapshot_id: input.base_capability_snapshot_id,
    applied_override_ref: input.applied_override_ref,
    capabilities: input.capabilities,
  });

  const snapshot: EffectiveCapabilitySnapshot = {
    capability_protocol_version: input.capability_protocol_version,
    effective_capability_snapshot_id: effectiveId,
    base_capability_snapshot_id: input.base_capability_snapshot_id,
    applied_override_ref: input.applied_override_ref,
    provider_id: input.provider_id,
    endpoint_scope: input.endpoint_scope,
    model_scope: input.model_scope,
    capabilities: input.capabilities,
    diagnostics: input.diagnostics,
  };

  return freezeSnapshot(snapshot) as EffectiveCapabilitySnapshot;
}

/**
 * 确定性 effective snapshot id。
 *
 * payload = canonical JSON of {protocol, base_snapshot_id, override_ref_or_null, capabilities_after}
 * id = 'sha256:' + sha256(payload).hex
 *
 * canonical JSON:键按字典序排列,无空格,UTF-8。同输入永远产出同输出。
 */
function computeEffectiveId(payload: {
  capability_protocol_version: string;
  base_capability_snapshot_id: string;
  applied_override_ref: string | null;
  capabilities: Record<string, CapabilitySupport>;
}): string {
  const canonical = canonicalStringify({
    protocol: payload.capability_protocol_version,
    base_snapshot_id: payload.base_capability_snapshot_id,
    override_ref: payload.applied_override_ref,
    capabilities_after: payload.capabilities,
  });
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256:${hash}`;
}

/**
 * 简单 canonical JSON:stringify 后键按字典序排列。
 * 用 JSON.stringify + replacer 收集键并排序的实现,保证确定性。
 */
function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** 深拷贝 capabilities map,隔离 base 与 effective,避免后续 mutate 互相污染。 */
function copyCapabilities(
  src: Readonly<Record<string, CapabilitySupport>>,
): Record<string, CapabilitySupport> {
  const out: Record<string, CapabilitySupport> = {};
  for (const [key, value] of Object.entries(src)) {
    out[key] = value;
  }
  return out;
}
