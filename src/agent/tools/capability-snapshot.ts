// src/agent/tools/capability-snapshot.ts
// M-058 (Wave B Task 2) Provider Capability Snapshot (BRC-2).
//
// 物理本质:把 "adapter 当前代码路径到底声明支持什么" 压成一张不可变快照。
// 这张快照只反映 adapter 自己的默认声明,不反映:
//   - model 名字里"看起来支持"的东西(不从 model_id 推断)
//   - 第三方 override(Wave C M-059 处理,本阶段不实现)
//   - 生命周期元数据(Deferred M-061,本阶段不实现)
//
// 关键不变量:
//   - `unknown` 就是 `unknown`:不能被偷偷转成 `supported`/`unsupported`。
//     未知能力会禁用依赖它的可选行为,决不允许"乐观升级"。
//   - 来源写死为 `'provider_adapter_default'`:不接受调用方走私其他来源。
//   - 输出深拷贝 + 深冻结:调用方之后 mutate 输入对象不能影响快照。
//   - 输出与 model_id 内容正交:model_id 只是身份字符串,不携带能力语义。
//
// 实现要点:
//   - 先对每个 capability value 做精确字符串校验(只接受那三个字面量),
//     再深拷贝,最后 freezeSnapshot 递归冻结。顺序很重要:校验失败不能
//     产生部分冻结对象。
//   - `source` 不读 input —— 直接 hardcode,从源头杜绝走私。

import { freezeSnapshot, requireIdentity } from '../contracts/identities.js';

/** 单项能力的支持状态。`unknown` 与 `supported`/`unsupported` 互斥,不可互转。 */
export type CapabilitySupport = 'supported' | 'unsupported' | 'unknown';

/**
 * 不可变的能力快照。一次曝光把 "adapter 默认声明支持哪些能力" 烧录成胶片。
 *
 * - capability_protocol_version:本快照遵循的协议版本(身份字段)。
 * - capability_snapshot_id:本次快照的确定性身份(由调用方传入,需非空)。
 * - provider_id / model_id / adapter_version:身份字段,只用于溯源。
 * - source:固定为 `'provider_adapter_default'`,标识能力的来源是 adapter
 *   自己的默认声明(不是 model 名字、不是第三方 override)。
 * - capabilities:能力名 → 支持状态的只读映射。
 * - diagnostics:可选的人类可读备注数组(默认空)。
 */
export interface ModelCapabilitySnapshot {
  readonly capability_protocol_version: string;
  readonly capability_snapshot_id: string;
  readonly provider_id: string;
  readonly model_id: string;
  readonly adapter_version: string;
  readonly source: 'provider_adapter_default';
  readonly capabilities: Readonly<Record<string, CapabilitySupport>>;
  readonly diagnostics: readonly string[];
}

/**
 * 构建能力快照的输入。注意:这里**不**包含 `source` 字段 —— source 由
 * `createModelCapabilitySnapshot` 写死,调用方无法影响。
 */
export interface CreateModelCapabilitySnapshotInput {
  capability_protocol_version: string;
  capability_snapshot_id: string;
  provider_id: string;
  model_id: string;
  adapter_version: string;
  capabilities: Record<string, CapabilitySupport>;
  diagnostics?: string[];
}

/** 合法的 capability value 字面量集合(精确匹配,不做子串/归一化)。 */
const ALLOWED_SUPPORT_VALUES: ReadonlySet<string> = new Set([
  'supported',
  'unsupported',
  'unknown',
]);

/**
 * 构建一份不可变的 ModelCapabilitySnapshot。
 *
 * 规则(spec §8.2):
 *   1. capability_protocol_version / capability_snapshot_id / provider_id /
 *      model_id / adapter_version 必须是非空字符串(经 requireIdentity 校验)。
 *   2. capabilities 中每个 value 必须恰好是 'supported'/'unsupported'/'unknown',
 *      其他字符串一律拒绝(抛错信息提及 capability 或 support)。
 *   3. source 写死为 'provider_adapter_default',忽略 input 里任何 source 字段。
 *   4. diagnostics 缺省时为空数组。
 *   5. 先深拷贝 capabilities 与 diagnostics,再递归冻结。
 *   6. 能力值不依赖 model_id 内容 —— model_id 仅作为身份记录。
 */
export function createModelCapabilitySnapshot(
  input: CreateModelCapabilitySnapshotInput,
): ModelCapabilitySnapshot {
  // 规则 1:身份字段非空校验
  const capability_protocol_version = requireIdentity(
    input.capability_protocol_version,
    'capability_protocol_version',
  );
  const capability_snapshot_id = requireIdentity(
    input.capability_snapshot_id,
    'capability_snapshot_id',
  );
  const provider_id = requireIdentity(input.provider_id, 'provider_id');
  const model_id = requireIdentity(input.model_id, 'model_id');
  const adapter_version = requireIdentity(input.adapter_version, 'adapter_version');

  // 规则 2:capability value 精确校验。必须在拷贝/冻结之前完成,
  // 这样校验失败时不会留下部分冻结的对象。
  if (input.capabilities === null || typeof input.capabilities !== 'object') {
    throw new Error('capabilities must be a Record<string, CapabilitySupport>');
  }
  for (const [key, rawValue] of Object.entries(input.capabilities)) {
    if (typeof rawValue !== 'string' || !ALLOWED_SUPPORT_VALUES.has(rawValue)) {
      throw new Error(
        `invalid capability support value for "${key}": ${JSON.stringify(rawValue)} ` +
          `(must be one of: supported, unsupported, unknown)`,
      );
    }
  }

  // 规则 4 + 5:深拷贝 capabilities 与 diagnostics(隔离后续 mutate),
  // diagnostics 缺省为 []。
  const capabilitiesCopy: Record<string, CapabilitySupport> = structuredClone(
    input.capabilities,
  );
  const diagnosticsCopy: string[] = Array.isArray(input.diagnostics)
    ? structuredClone(input.diagnostics)
    : [];

  // 规则 5:递归冻结(freezeSnapshot 会冻 capabilitiesCopy 内部 + 自身,
  // 以及 diagnosticsCopy 的字符串元素 + 数组本身)。
  const capabilities = freezeSnapshot(capabilitiesCopy);
  const diagnostics = freezeSnapshot(diagnosticsCopy);

  // 规则 3:source 写死,不读 input。
  const snapshot: ModelCapabilitySnapshot = {
    capability_protocol_version,
    capability_snapshot_id,
    provider_id,
    model_id,
    adapter_version,
    source: 'provider_adapter_default',
    capabilities,
    diagnostics,
  };

  return freezeSnapshot(snapshot);
}
