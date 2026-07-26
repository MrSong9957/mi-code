// src/agent/tools/policy-projection.ts
// Wave C Task 8 (M-026 / CRC-4): Tool Policy Projection.
//
// 物理本质:ToolPolicyProjection 只投影 runtime policy 已经决定的事实。
// 它把"当前 security policy 快照 + 当前 tool view 快照 + 受信 description asset +
// 受信约束渲染结果"压成一份稳定、确定、可追溯的 projection。runtime policy 是
// 工具可见/可调用/是否需要 ask 的事实来源(INV-C8);description 只是"已经存在的 policy"
// 的镜像,绝不产生新的 allow/ask/deny。
//
// 关键不变量(spec §10.3 + §17.4 CRC-4):
//   - projection NEVER 携带 behavior / allow / ask / deny 字段;
//   - projection 失败时 throw,让上层决定 fallback(excluded 或 verified base description);
//   - 同一 (protocol, tool_id, source snapshots, description asset, rendered hash) →
//     同一 projection_id(确定性,见 deriveProjectionId);
//   - secret/credential/api_key 等敏感关键词不进入 description(§10.3 rule 4)。
//
// 校验顺序(FIXED,spec §10.5 —— 先后顺序影响 error message,先命中先抛):
//   1. 身份字段非空(tool_id, snapshot ids, description asset);
//   2. policy snapshot 漂移  → throw 'security_policy_snapshot_id';
//   3. tool view 漂移         → throw 'tool_view_snapshot_id';
//   4. tool 未 included       → throw 'tool.not_included';
//   5. description asset 未批准 → throw 'description_asset.not_approved';
//   6. renderConstraints(...) → 敏感词扫描 → throw 'projection.contains_sensitive';
//   7. 派生 hashes 与 projection_id 并冻结返回。
//
// 安全关键:secret 检测只做简单关键词扫描(lower-case substring),不实现复杂脱敏。
// 这是有意为之 —— 真正的脱敏在 description asset 生产侧完成,这里只是最后防线。

import { createHash } from 'node:crypto';
import { freezeSnapshot, requireIdentity } from '../contracts/identities.js';

/** Tool policy projection 协议版本(硬编码 '1',spec §10.2)。 */
export const PROJECTION_PROTOCOL_VERSION = '1';

/**
 * 触发敏感内容检测的关键词集合(全小写)。
 *
 * 设计取舍:
 *   - 关键词只覆盖最常见的 secret 携带模式('secret' / 'credential' / 'api_key' /
 *     'password' / 'private_key' / 'access_token'),不试图覆盖全部 PII;
 *   - 子串匹配('api_key' 会同时命中 'API_KEY' / 'apikey' / 'X-Api-Key' 的
 *     小写形式),简单可靠,避免正则;
 *   - 这是"最后防线",不是脱敏引擎;真正的不变量由 description asset 生产侧保证。
 */
const SENSITIVE_KEYWORDS: readonly string[] = [
  'secret',
  'credential',
  'api_key',
  'apikey',
  'password',
  'private_key',
  'access_token',
  'auth_token',
];

/** description asset 引用:{ asset_id, asset_version }。 */
export interface DescriptionAssetRef {
  asset_id: string;
  asset_version: string;
}

/** projectToolPolicy 的输入:来自 runtime policy 的引用与 description asset。 */
export interface ToolPolicyProjectionInput {
  tool_id: string;
  tool_view_snapshot_id: string;
  security_policy_snapshot_id: string;
  /** 该 tool 此次投影来源的 SecurityDecision refs(只追溯,不解释)。 */
  policy_decision_refs: string[];
  description_asset_ref: DescriptionAssetRef;
  /** 受信 dynamic constraint 来源 refs(由调用方保证来自受信 policy snapshot)。 */
  dynamic_constraint_refs: string[];
}

/** projection 输出。注意:没有 behavior / allow / ask / deny 字段(INV-C8)。 */
export interface ToolPolicyProjection {
  projection_protocol_version: string;
  projection_id: string;
  tool_id: string;
  source_policy_snapshot_id: string;
  source_tool_view_snapshot_id: string;
  description_asset_ref: DescriptionAssetRef;
  rendered_constraint_ref: string;
  rendered_constraint_hash: string;
  /** 本次 projection 触发的诊断 reason codes(正常情况空数组)。 */
  reason_codes: string[];
}

/**
 * 依赖注入:调用方提供"当前 runtime 状态"的几个回调/快照 id。
 *
 * 这样把 projection 与具体 policy store / asset store / renderer 解耦,
 * 测试时只需传纯函数。本模块绝不在内部读取全局 policy。
 */
export interface ToolPolicyProjectionDeps {
  /** 当前生效的 security policy snapshot id(漂移即失败)。 */
  current_security_policy_snapshot_id: string;
  /** 当前生效的 tool view snapshot id(漂移即失败)。 */
  current_tool_view_snapshot_id: string;
  /** description asset 是否已批准。返回 false → projection 失败。 */
  approvedAsset: (ref: DescriptionAssetRef) => boolean;
  /** 把 input 渲染成最终的约束文本(受信 renderer,来源由调用方负责)。 */
  renderConstraints: (input: ToolPolicyProjectionInput) => string;
  /** tool_id 是否在当前 tool view 中 included(excluded tool 不产生 active projection)。 */
  isToolIncluded: (tool_id: string) => boolean;
}

/**
 * 检查渲染后的约束文本是否携带敏感关键词。
 *
 * 返回第一个命中的关键词(小写),或 null。lower-case 子串扫描 ——
 * 'API_KEY'、'ApiKey'、'api_key' 都会被 'api_key' 命中。
 */
function findSensitiveKeyword(rendered: string): string | null {
  const lower = rendered.toLowerCase();
  for (const kw of SENSITIVE_KEYWORDS) {
    if (lower.includes(kw)) {
      return kw;
    }
  }
  return null;
}

/**
 * 派生确定性 projection_id。
 *
 * canonical 输入(顺序固定,任一字段翻转都会改变 hash):
 *   - protocol 版本
 *   - tool_id
 *   - source policy / tool view snapshot id
 *   - description asset_id / asset_version
 *   - rendered_constraint_hash(已隐含 rendered 文本)
 *
 * 注意:不把 policy_decision_refs / dynamic_constraint_refs 纳入 hash ——
 * 它们是"引用",同一 projection 可能引用不同的 decision/constraint 实例,
 * 但呈现给 provider 的约束文本与策略身份一致即可。把 rendered hash 纳入已足够。
 */
function deriveProjectionId(
  projection_protocol_version: string,
  tool_id: string,
  source_policy_snapshot_id: string,
  source_tool_view_snapshot_id: string,
  description_asset_ref: DescriptionAssetRef,
  rendered_constraint_hash: string,
): string {
  const lines: string[] = [
    `protocol=${projection_protocol_version}`,
    `tool_id=${tool_id}`,
    `policy_snapshot=${source_policy_snapshot_id}`,
    `tool_view_snapshot=${source_tool_view_snapshot_id}`,
    `asset_id=${description_asset_ref.asset_id}`,
    `asset_version=${description_asset_ref.asset_version}`,
    `rendered_hash=${rendered_constraint_hash}`,
  ];
  const hash = createHash('sha256').update(lines.join('\n')).digest('hex');
  return `proj:${hash.slice(0, 16)}`;
}

/**
 * 构造一个 ToolPolicyProjection。失败时 throw(spec §10.5)。
 *
 * 校验顺序见模块头注释。任一步骤失败即抛出,绝不返回半成品。
 *
 * @throws Error('security_policy_snapshot_id must be ...') 当 policy snapshot 漂移
 * @throws Error('tool_view_snapshot_id must be ...') 当 tool view snapshot 漂移
 * @throws Error('tool.not_included: ...')  当 tool 不在当前 view 中
 * @throws Error('description_asset.not_approved: ...')  当 description asset 未批准
 * @throws Error('projection.contains_sensitive: ...')  当 rendered 含敏感关键词
 */
export function projectToolPolicy(
  input: ToolPolicyProjectionInput,
  deps: ToolPolicyProjectionDeps,
): ToolPolicyProjection {
  // ── Step 1: 身份字段非空校验 ──
  // requireIdentity 抛出带字段名的错误,调用方/测试可据此判断。
  const tool_id = requireIdentity(input.tool_id, 'tool_id');
  const input_policy_snapshot = requireIdentity(
    input.security_policy_snapshot_id,
    'security_policy_snapshot_id',
  );
  const input_tool_view_snapshot = requireIdentity(
    input.tool_view_snapshot_id,
    'tool_view_snapshot_id',
  );
  const current_policy_snapshot = requireIdentity(
    deps.current_security_policy_snapshot_id,
    'current_security_policy_snapshot_id',
  );
  const current_tool_view_snapshot = requireIdentity(
    deps.current_tool_view_snapshot_id,
    'current_tool_view_snapshot_id',
  );

  // description asset 身份校验(asset_id / asset_version 都必须非空)
  if (input.description_asset_ref === null || typeof input.description_asset_ref !== 'object') {
    throw new Error('description_asset_ref must be an object');
  }
  const asset_id = requireIdentity(
    input.description_asset_ref.asset_id,
    'description_asset_ref.asset_id',
  );
  const asset_version = requireIdentity(
    input.description_asset_ref.asset_version,
    'description_asset_ref.asset_version',
  );
  const descriptionAssetRef: DescriptionAssetRef = { asset_id, asset_version };

  // ── Step 2: policy snapshot 漂移检查(spec §10.5)──
  // 顺序靠前,所以 policy + view 同时漂移时,policy 错误先抛。
  if (input_policy_snapshot !== current_policy_snapshot) {
    throw new Error(
      `security_policy_snapshot_id drift: input='${input_policy_snapshot}' current='${current_policy_snapshot}'`,
    );
  }

  // ── Step 3: tool view snapshot 漂移检查 ──
  if (input_tool_view_snapshot !== current_tool_view_snapshot) {
    throw new Error(
      `tool_view_snapshot_id drift: input='${input_tool_view_snapshot}' current='${current_tool_view_snapshot}'`,
    );
  }

  // ── Step 4: tool 必须在当前 view 中 included ──
  // excluded tool 不生成 active projection(spec §10.3 rule 5:失败时 tool 应 excluded,
  // 这里由调用方在 view 派生阶段处理;若调用方仍尝试为 excluded tool 生成 projection,直接抛)。
  if (!deps.isToolIncluded(tool_id)) {
    throw new Error(`tool.not_included: '${tool_id}' is not in the current tool view`);
  }

  // ── Step 5: description asset 必须 approved(spec §10.3 rule 6)──
  if (!deps.approvedAsset(descriptionAssetRef)) {
    throw new Error(
      `description_asset.not_approved: asset_id='${asset_id}' asset_version='${asset_version}'`,
    );
  }

  // ── Step 6: render constraints ──
  const rendered = deps.renderConstraints(input);

  // ── Step 7: 敏感内容过滤(spec §10.3 rule 4)──
  // 关键词命中即抛,不脱敏 —— 脱敏是 description 生产侧的职责。
  const sensitive = findSensitiveKeyword(rendered);
  if (sensitive !== null) {
    throw new Error(
      `projection.contains_sensitive: rendered constraint contains sensitive keyword '${sensitive}'`,
    );
  }

  // ── Step 8: 派生 hashes 与 projection_id ──
  const rendered_constraint_hash = createHash('sha256').update(rendered).digest('hex');
  const rendered_constraint_ref = `constraint:${rendered_constraint_hash.slice(0, 16)}`;
  const projection_id = deriveProjectionId(
    PROJECTION_PROTOCOL_VERSION,
    tool_id,
    current_policy_snapshot,
    current_tool_view_snapshot,
    descriptionAssetRef,
    rendered_constraint_hash,
  );

  // 正常情况 reason_codes 为空。保留字段是为了未来诊断/审计扩展,
  // 当前没有非致命 reason 需要收集(所有失败都已 throw)。
  const reason_codes: string[] = [];

  const projection: ToolPolicyProjection = {
    projection_protocol_version: PROJECTION_PROTOCOL_VERSION,
    projection_id,
    tool_id,
    source_policy_snapshot_id: current_policy_snapshot,
    source_tool_view_snapshot_id: current_tool_view_snapshot,
    description_asset_ref: descriptionAssetRef,
    rendered_constraint_ref,
    rendered_constraint_hash,
    reason_codes,
  };

  // 冻结整个 projection(深递归)。description_asset_ref / reason_codes 也被冻结。
  return freezeSnapshot(projection) as ToolPolicyProjection;
}
