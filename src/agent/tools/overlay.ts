// src/agent/tools/overlay.ts
// Wave B Task 3 (M-020/M-024): Request Tool View Overlay (BRC-2).
//
// 物理本质:给定一份 base 工具定义快照 + 一份能力快照 + 一份 tool-local prompt
// 元数据(按 tool_id 索引)+ 一份 role/mode/security overlay,派生出本次请求的
// 不可变工具视图 `RequestToolViewSnapshot`。
//
// BRC-2 核心约束:overlay 只能进一步收窄工具视图。它绝不能:
//   - 新增 base snapshot 中不存在的工具;
//   - 修改 tool_id、canonical order、parameters schema、executor 或 permission;
//   - 把 capability/security/approval 已排除的工具通过 requested_visibility:'include'
//     复活(spec §8.5 rule 3, rule 4)。
//
// 派生顺序(FIXED,spec §8.4 + plan Task 3 Step 4 —— 每步只能进一步收窄,
// 多重原因同时命中时,派生顺序中最先命中的步骤胜出):
//
//   1. base existence      —— 工具必须存在于 base snapshot,否则不在视图中
//                             (overlay 引用的未知 tool_id 静默忽略,见 §8.6)
//   2. capability          —— metadata.required_capabilities 中任一 cap 在能力
//                             快照里是 'unsupported'/'unknown' → excluded
//                             reason: 'capability.<support>.<cap>'
//   3. security            —— tool_id 在 security_excluded_tool_ids → excluded
//                             reason: 'security.excluded'
//   4. role/mode requested —— overlay.requested_visibility[tool_id] === 'exclude'
//                             → excluded,reason: 'overlay.requested_exclude'
//                             (requested_visibility:'include' 不能覆盖前面任何 exclusion)
//   5. approved description—— metadata.evaluation_status !== 'approved' 或
//                             (description_asset_ref 非 null 且 approvedAsset(...) === false)
//                             → excluded,reason: 'description.not_approved'
//   6. provider annotations—— 每条 entry 都带 provider_annotations 记录(可能为空);
//                             本实现遵循"只附加已知 annotation,绝不附加 require 能力
//                             已排除的工具的 annotation"—— 由于能力未通过的工具在
//                             步骤 2 已被标 excluded 且不出现在 Provider schema 中,
//                             因此其 provider_annotations 即使存在也不被 provider 消费。
//
// 顺序保持(spec §8.5 rule 7):输出 entries 数组按 base canonical_order 升序排列
// (included 与 excluded 都出现,保持 base 相对顺序)。
//
// 元数据缺失约定:tools 在 base 中但不在 metadata map 中 → 视为 approved 且
// required_capabilities 为空(可被其他规则排除,但默认 included)。
//
// tool_view_snapshot_id 派生公式(确定性,见 deriveToolViewSnapshotId):
//   id = 'view:' + sha256(
//     tool_view_protocol_version + '\n' +
//     base.registry_snapshot_id + '\n' +
//     capability.capability_snapshot_id + '\n' +
//     overlay.base_tool_snapshot_id + '\n' +
//     overlay.capability_snapshot_id + '\n' +
//     overlay.control_mode + '\n' +
//     (overlay.role_id ?? '\u0000') + '\n' +
//     overlay.security_policy_snapshot_id + '\n' +
//     requested_visibility 排序后的 'tool_id=include|exclude' 列表 + '\n' +
//     每条 entry 的 'tool_id|canonical_order|visibility|reason' 决策列表
//   )
// 这样任意一个 input 字段或决策翻转都会改变 snapshot_id,且不使用随机 UUID。

import { createHash } from 'node:crypto';
import { freezeSnapshot, requireIdentity } from '../contracts/identities.js';
import type {
  ModelCapabilitySnapshot,
  CapabilitySupport,
} from './capability-snapshot.js';
import type { ToolDefinitionSnapshot } from './descriptor-snapshot.js';
import type { ToolPromptMetadata, DescriptionAssetRef } from './prompt-metadata.js';

/** overlay 输入:由 role/mode/security 提供的 per-request 收窄参数。 */
export interface ToolViewOverlayInput {
  /** 对应 base ToolDefinitionSnapshot.registry_snapshot_id(身份一致性引用)。 */
  base_tool_snapshot_id: string;
  /** 对应 ModelCapabilitySnapshot.capability_snapshot_id(身份一致性引用)。 */
  capability_snapshot_id: string;
  /** 当前控制模式,例如 'build' / 'plan' / 'review'。 */
  control_mode: string;
  /** 当前角色 id,或 null(默认 role)。 */
  role_id: string | null;
  /** 对应 SecurityPolicySnapshot 的身份引用。 */
  security_policy_snapshot_id: string;
  /** role/mode 请求的 per-tool 可见性偏好。include 不能覆盖任何已施加的 exclusion。 */
  requested_visibility: Readonly<Record<string, 'include' | 'exclude'>>;
}

/** 单条工具视图 entry:base 身份 + 可见性决策 + 原因码 + description asset + provider 注解。 */
export interface RequestToolViewEntry {
  tool_id: string;
  canonical_order: number;
  visibility: 'included' | 'excluded';
  /** excluded 时的结构化原因码;included 时为 null。 */
  exclusion_reason_code: string | null;
  /** 该工具声明对齐的 description asset 引用(可能为 null)。 */
  description_asset_ref: Readonly<DescriptionAssetRef> | null;
  /** Provider 注解记录(只读,可能为空对象)。Provider 只消费 included entries 的注解。 */
  provider_annotations: Readonly<Record<string, string | number | boolean>>;
}

/** per-request 工具视图快照:不可变,按 canonical_order 排列。 */
export interface RequestToolViewSnapshot {
  tool_view_protocol_version: string;
  tool_view_snapshot_id: string;
  base_tool_snapshot_id: string;
  capability_snapshot_id: string;
  security_policy_snapshot_id: string;
  entries: ReadonlyArray<RequestToolViewEntry>;
}

/** deriveRequestToolView 的输入:base + capability + metadata + overlay + 两个回调。 */
export interface DeriveRequestToolViewInput {
  tool_view_protocol_version: string;
  /** 调用方提供的本次视图身份(非空)。会经 requireIdentity 校验,但不参与确定性 hash。 */
  tool_view_snapshot_id: string;
  base: ToolDefinitionSnapshot;
  capability: ModelCapabilitySnapshot;
  /** 按 tool_id 索引的 prompt 元数据。缺失的 tool_id 视为 approved + 空 required_capabilities。 */
  metadata: ReadonlyMap<string, ToolPromptMetadata>;
  overlay: ToolViewOverlayInput;
  /** security policy 决定排除的 tool_id 集合(来自 runtime policy,本模块不解释)。 */
  security_excluded_tool_ids: ReadonlySet<string>;
  /** description asset 是否已批准的回调。返回 false → 工具被 'description.not_approved' 排除。 */
  approvedAsset: (ref: DescriptionAssetRef) => boolean;
}

/**
 * 单工具的可见性决策结果。reason_code 为 null 表示 included。
 */
interface ToolDecision {
  visibility: 'included' | 'excluded';
  exclusion_reason_code: string | null;
}

/**
 * 推导单个工具的可见性决策。严格按派生顺序逐步检查,先命中先返回。
 *
 * 注意:`requested_visibility:'include'` 永远不会把一个已 excluded 的工具变回 included ——
 * 它只能阻止 'exclude' 请求生效。本函数在 step 4 只识别 'exclude',其他值(包括 'include')
 * 对前面的 exclusion 没有任何影响。
 */
function decideToolVisibility(
  tool_id: string,
  metadata: ToolPromptMetadata | undefined,
  capabilitySnapshot: ModelCapabilitySnapshot,
  securityExcluded: ReadonlySet<string>,
  requestedVisibility: Readonly<Record<string, 'include' | 'exclude'>>,
  approvedAsset: (ref: DescriptionAssetRef) => boolean,
): ToolDecision {
  // metadata 缺失约定:视为 approved + 空 required_capabilities。
  const requiredCapabilities: readonly string[] = metadata?.required_capabilities ?? [];
  const evaluationStatus = metadata?.evaluation_status ?? 'approved';
  const descriptionAssetRef = metadata?.description_asset_ref ?? null;

  // ── Step 2: capability requirement ──
  // 取第一个失败的 capability(metadata.required_capabilities 数组顺序),
  // reason 区分 'unsupported' / 'unknown'。
  const caps = capabilitySnapshot.capabilities;
  for (const cap of requiredCapabilities) {
    const support: CapabilitySupport | undefined = caps[cap];
    if (support === 'unsupported') {
      return {
        visibility: 'excluded',
        exclusion_reason_code: `capability.unsupported.${cap}`,
      };
    }
    if (support === 'unknown') {
      return {
        visibility: 'excluded',
        exclusion_reason_code: `capability.unknown.${cap}`,
      };
    }
    // 'supported' 或 undefined(cap 未在 snapshot 中声明 → 当作未约束,继续)
  }

  // ── Step 3: security exclusion ──
  if (securityExcluded.has(tool_id)) {
    return { visibility: 'excluded', exclusion_reason_code: 'security.excluded' };
  }

  // ── Step 4: role/mode requested exclusion ──
  // 只识别 'exclude'。'include' 不能覆盖前面任何 exclusion,因此不在此处理。
  if (requestedVisibility[tool_id] === 'exclude') {
    return { visibility: 'excluded', exclusion_reason_code: 'overlay.requested_exclude' };
  }

  // ── Step 5: approved description ──
  if (evaluationStatus !== 'approved') {
    return { visibility: 'excluded', exclusion_reason_code: 'description.not_approved' };
  }
  if (descriptionAssetRef !== null && !approvedAsset(descriptionAssetRef)) {
    return { visibility: 'excluded', exclusion_reason_code: 'description.not_approved' };
  }

  // ── 全部通过 → included ──
  return { visibility: 'included', exclusion_reason_code: null };
}

/**
 * 确定性派生 tool_view_snapshot_id。
 *
 * 公式(见模块头注释):对协议版本、所有 overlay 身份字段、
 * 排序后的 requested_visibility、以及每个 entry 的最终决策做 sha256,
 * 前缀 'view:'。任何一个字段或决策翻转都会改变 id。
 *
 * 注意:不把调用方传入的 `tool_view_snapshot_id` 纳入 hash —— 那是身份,
 * 不是内容。否则同一个内容会被两个不同的"名字"hash 成两个不同的 id。
 */
function deriveToolViewSnapshotId(
  tool_view_protocol_version: string,
  base: ToolDefinitionSnapshot,
  capability: ModelCapabilitySnapshot,
  overlayInput: ToolViewOverlayInput,
  entries: ReadonlyArray<RequestToolViewEntry>,
): string {
  const lines: string[] = [];
  lines.push(`protocol=${tool_view_protocol_version}`);
  lines.push(`base=${base.registry_snapshot_id}`);
  lines.push(`capability=${capability.capability_snapshot_id}`);
  lines.push(`overlay.base=${overlayInput.base_tool_snapshot_id}`);
  lines.push(`overlay.capability=${overlayInput.capability_snapshot_id}`);
  lines.push(`overlay.control_mode=${overlayInput.control_mode}`);
  lines.push(`overlay.role_id=${overlayInput.role_id ?? '\u0000'}`);
  lines.push(`overlay.security=${overlayInput.security_policy_snapshot_id}`);

  // requested_visibility 按 tool_id 字典序排序后写入,保证顺序无关。
  const rvEntries = Object.entries(overlayInput.requested_visibility).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const [tid, val] of rvEntries) {
    lines.push(`rv:${tid}=${val}`);
  }

  // 每条 entry 的最终决策(按 canonical_order 排序)。
  // 包含 tool_id、canonical_order、visibility、reason —— 任一翻转都会改变 hash。
  for (const e of entries) {
    lines.push(`entry:${e.tool_id}|${e.canonical_order}|${e.visibility}|${e.exclusion_reason_code ?? '\u0000'}`);
  }

  const hash = createHash('sha256').update(lines.join('\n')).digest('hex');
  return `view:${hash}`;
}

/**
 * 派生本次请求的工具视图快照。规则见模块头注释与 spec §8.4 / §8.5。
 *
 * @throws 当 tool_view_protocol_version 或 tool_view_snapshot_id 为空时。
 */
export function deriveRequestToolView(
  input: DeriveRequestToolViewInput,
): RequestToolViewSnapshot {
  // 身份字段非空校验(与其它 snapshot builder 一致)。
  const tool_view_protocol_version = requireIdentity(
    input.tool_view_protocol_version,
    'tool_view_protocol_version',
  );
  // 调用方提供的 tool_view_snapshot_id 必须非空(身份字段);但不参与内容 hash。
  requireIdentity(input.tool_view_snapshot_id, 'tool_view_snapshot_id');

  // ── Step 1: base existence —— 遍历 base snapshot 的所有 descriptors(已按 canonical_order 排列)。──
  // overlay 引用的未知 tool_id(不在 base 中)直接忽略,不产生 entry(spec §8.6)。
  const decisions: RequestToolViewEntry[] = [];

  for (const descriptor of input.base.descriptors) {
    const tool_id = descriptor.tool_id;
    const metadata = input.metadata.get(tool_id);

    const decision = decideToolVisibility(
      tool_id,
      metadata,
      input.capability,
      input.security_excluded_tool_ids,
      input.overlay.requested_visibility,
      input.approvedAsset,
    );

    // description_asset_ref 取自 metadata(缺失则为 null)。
    const descriptionAssetRef = metadata?.description_asset_ref ?? null;

    // ── Step 6: provider annotations —— 每个 entry 都带一个 provider_annotations 记录。
    //    capability 已 excluded 的工具不会进入 Provider schema(本模块输出 visibility
    //    供下游 provider adapter 判断),因此其 annotations 不会被消费。这里始终附加
    //    一个(可能为空的)冻结记录,保持 entry shape 一致。──
    //    本 Wave 不从外部注入 annotation 文本(M-059 第三方 override 属 Wave C),
    //    因此 annotations 记录默认为空对象。
    const providerAnnotations: Record<string, string | number | boolean> = {};

    const entry: RequestToolViewEntry = {
      tool_id,
      canonical_order: descriptor.canonical_order,
      visibility: decision.visibility,
      exclusion_reason_code: decision.exclusion_reason_code,
      description_asset_ref: descriptionAssetRef
        ? freezeSnapshot({ ...descriptionAssetRef })
        : null,
      provider_annotations: providerAnnotations,
    };

    decisions.push(entry);
  }

  // entries 已经按 canonical_order 升序(base.descriptors 即按此序),无需再排。
  // 冻结每个 entry + entries 数组 + 内部记录。
  for (const e of decisions) {
    freezeSnapshot(e.provider_annotations);
    freezeSnapshot(e);
  }
  freezeSnapshot(decisions);

  // 确定性 tool_view_snapshot_id(不读 input.tool_view_snapshot_id)。
  const tool_view_snapshot_id = deriveToolViewSnapshotId(
    tool_view_protocol_version,
    input.base,
    input.capability,
    input.overlay,
    decisions,
  );

  const snapshot: RequestToolViewSnapshot = {
    tool_view_protocol_version,
    tool_view_snapshot_id,
    base_tool_snapshot_id: input.overlay.base_tool_snapshot_id,
    capability_snapshot_id: input.overlay.capability_snapshot_id,
    security_policy_snapshot_id: input.overlay.security_policy_snapshot_id,
    entries: decisions,
  };
  return freezeSnapshot(snapshot);
}
