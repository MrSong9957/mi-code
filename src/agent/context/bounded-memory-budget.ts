// src/agent/context/bounded-memory-budget.ts
// FRC-1 Task 4 — Hard Budgets 与 Overflow Manifest.
//
// 物理本质:把 eligible navigation items + eligible verified claims 按
// 三层预算(navigation / verified-detail / total-section)切分,产生
// retained 集合 + overflow manifest。任何切分边界都只能是"整项 omit",
// 绝不能切 string / Buffer / frontmatter / link / provenance label。
//
// 边界(对应 spec §7.9 / §7.10、Task 4):
//   - T4 只做"切分":接收已经过 T1 选片 + T2/T3 verify 的 eligible 集合,
//     按 budget policy 决定哪些保留、哪些 omit。
//   - T4 不做选片(T1)、不做 verify(T2/T3)、不做最终 render(T5)。
//   - 渲染产物由调用方注入的 renderer 产生;T4 用其输出做 bytes/lines 计量,
//     保证 fragment 计量与最终 render 字节级一致(没有"估算 renderer"和
//     "最终 renderer"两套实现)。
//   - 确定性:相同 input + renderer + estimator → 相同 retained 集合、相同
//     ordering、相同 overflow_manifest(包括 overflow_manifest_id)。
//
// 关键不变量(对应 spec §7.9 / §7.10):
//   1. applied_steps 严格固定六步顺序,即使没有 omission 也必须全部出现:
//        navigation_count → navigation_budget → per_item_claim_count
//        → verified_detail_count → verified_detail_budget → total_section_budget
//   2. semantic-boundary omission:单项超 navigation_budget /
//      verified_detail_budget 时整项 omit,绝不切 string/Buffer/label。
//   3. count cap 从尾部逆序移除(头部优先级最高)。
//   4. total_section 二阶段:先按 claim 逆序移除;仍超限再按 navigation 逆序移除,
//      且移除 navigation 时其名下 claim 一并移除。
//   5. overflow_behavior='reject':任一层超限 → state='rejected',
//      retained_navigation=[], retained_claims=[], truncated=true。
//   6. truncated=true 当且仅当有任何 omission(包括 budget 和上游透传)。
//   7. multibyte 计量用 Buffer.byteLength(rendered, 'utf8'),不用字符串长度。
//   8. 输出整体经 freezeSnapshot 深冻结。
//   9. overflow_manifest_id = sha256(deterministic payload)。

import { createHash } from 'node:crypto';

import { freezeSnapshot, requireIdentity } from '../contracts/identities.js';

// ---------------------------------------------------------------------------
// Public types (本地 working type;与 T1/T5 导出形状兼容,T6 接线时统一适配)
// ---------------------------------------------------------------------------

/**
 * 与 bounded-memory.ts MemoryNavigationItem 形状兼容。
 * `[key: string]: unknown` 允许 T1 扩展更多字段,本模块只读取 identity 相关字段。
 */
export interface BudgetNavigationItem {
  memory_record_id: string;
  record_version: number;
  selection_rank: number;
  memory_type: string;
  scope_ref: string;
  topic_key_refs: ReadonlyArray<string>;
  keyword_key_refs: ReadonlyArray<string>;
  observed_at: string;
  expires_at: string | null;
  detail_content_hash: string;
  provenance_refs: ReadonlyArray<string>;
  durability_evidence_ref: string;
  [key: string]: unknown;
}

/**
 * 与 bounded-memory.ts VerifiedMemoryClaimProjection 形状兼容。
 * `[key: string]: unknown` 允许 T1 扩展更多字段。
 */
export interface BudgetVerifiedClaim {
  claim_projection_id: string;
  memory_record_id: string;
  record_version: number;
  retrieval_id: string;
  memory_use_decision_id: string;
  current_context_snapshot_id: string;
  project_version_ref: string | null;
  verified_claim_ref: string;
  content_ref: string;
  content_hash: string;
  provenance_refs: ReadonlyArray<string>;
  freshness_ref: string;
  [key: string]: unknown;
}

/**
 * Renderer 接口(T5 已提供生产实现 createRendererAdaptor)。
 * T4 注入此接口,用其输出做 fragment 计量,与最终 render 字节级一致。
 */
export interface MemoryBudgetFragmentRenderer {
  renderNavigation(item: BudgetNavigationItem): string;
  renderVerifiedClaim(claim: BudgetVerifiedClaim): string;
}

/**
 * Token estimator(可选)。注入时填充 estimated_tokens;为 null 时
 * measurement.estimated_tokens 全部为 null。
 */
export interface TokenEstimator {
  estimator_id: string;
  estimator_version: string;
  model_scope: string | null;
  method: string;
  measure(rendered: string): number;
}

/** 单条 entrypoint 被 omit 的原因(封闭枚举,对应 spec §7.10)。 */
export type MemoryEntrypointOmissionReason =
  | 'navigation_count_limit'
  | 'navigation_budget_limit'
  | 'verified_detail_count_limit'
  | 'verified_detail_budget_limit'
  | 'total_section_budget_limit'
  | 'not_selected'
  | 'detail_missing'
  | 'detail_hash_mismatch'
  | 'use_denied'
  | 'refresh_required'
  | 'stale'
  | 'conflicting_evidence'
  | 'scope_excluded'
  | 'type_excluded'
  | 'durability_unverified';

/** Navigation 段预算策略(spec §7.9 step 1-2)。 */
export interface NavigationBudgetPolicy {
  source_class: 'memory_navigation';
  max_bytes: number;
  max_lines: number | null;
  max_entries: number;
  policy_id: string;
  policy_version: string;
}

/** Verified detail 段预算策略(spec §7.9 step 3-5)。 */
export interface VerifiedDetailBudgetPolicy {
  source_class: 'memory_verified_detail';
  max_bytes: number;
  max_lines: number | null;
  max_items: number;
  max_claims_per_item: number;
  policy_id: string;
  policy_version: string;
}

/** Total section 预算策略(spec §7.9 step 6)。 */
export interface TotalSectionBudgetPolicy {
  source_class: 'memory_section_total';
  max_bytes: number;
  max_lines: number | null;
  policy_id: string;
  policy_version: string;
}

/** 超限行为:整项 omit(默认)或 reject 整个 entrypoint。 */
export type BudgetOverflowBehavior = 'entry_boundary_omit' | 'reject';

/** Fragment 计量结果。bytes 始终非 null;estimated_tokens 受 estimator 控制。 */
export interface FragmentMeasurement {
  bytes: number;
  lines: number;
  estimated_tokens: number | null;
}

/** applied_steps 中的步骤标识(封闭六步)。 */
export type BudgetAppliedStep =
  | 'navigation_count'
  | 'navigation_budget'
  | 'per_item_claim_count'
  | 'verified_detail_count'
  | 'verified_detail_budget'
  | 'total_section_budget';

/** 上游(T1/T2/T3)已经 omit 的 navigation record 透传。 */
export interface OmittedNavigationRecord {
  memory_record_id: string;
  reason_codes: ReadonlyArray<MemoryEntrypointOmissionReason>;
}

/** 上游(T1/T2/T3)已经 omit 的 claim 透传。 */
export interface OmittedClaimRef {
  memory_record_id: string;
  claim_ref: string;
  reason_codes: ReadonlyArray<MemoryEntrypointOmissionReason>;
}

/** Overflow manifest(spec §7.10)。合并 budget omission 与上游 omission。 */
export interface MemoryEntrypointOverflowManifest {
  overflow_protocol_version: string;
  overflow_manifest_id: string;
  truncated: boolean;
  navigation_overflowed: boolean;
  verified_detail_overflowed: boolean;
  total_budget_overflowed: boolean;
  omitted_records: ReadonlyArray<OmittedNavigationRecord>;
  omitted_claim_refs: ReadonlyArray<OmittedClaimRef>;
  budget_policy_refs: ReadonlyArray<string>;
}

/** Navigation item 在 budget 切分后的产物:原 item + 渲染片段 + 计量。 */
export interface BudgetedNavigationItem extends BudgetNavigationItem {
  rendered_fragment: string;
  measurement: FragmentMeasurement;
}

/** Verified claim 在 budget 切分后的产物:原 claim + 渲染片段 + 计量。 */
export interface BudgetedVerifiedClaim extends BudgetVerifiedClaim {
  rendered_fragment: string;
  measurement: FragmentMeasurement;
}

/** Budget 切分后的整体状态。 */
export type BudgetedState = 'ready' | 'partial' | 'rejected';

/** applyMemoryEntrypointBudgets 的完整输出。 */
export interface BudgetedMemoryEntrypoint {
  budget_protocol_version: string;
  state: BudgetedState;
  applied_steps: ReadonlyArray<BudgetAppliedStep>;
  retained_navigation: ReadonlyArray<BudgetedNavigationItem>;
  retained_claims: ReadonlyArray<BudgetedVerifiedClaim>;
  upstream_navigation_omissions: ReadonlyArray<OmittedNavigationRecord>;
  upstream_claim_omissions: ReadonlyArray<OmittedClaimRef>;
  overflow_manifest: Readonly<MemoryEntrypointOverflowManifest>;
  total_measurement: FragmentMeasurement;
  estimator_ref: string | null;
  reason_codes: ReadonlyArray<string>;
}

/** applyMemoryEntrypointBudgets 的完整输入。 */
export interface ApplyMemoryEntrypointBudgetsInput {
  eligible_navigation: ReadonlyArray<BudgetNavigationItem>;
  eligible_claims: ReadonlyArray<BudgetVerifiedClaim>;
  upstream_navigation_omissions: ReadonlyArray<OmittedNavigationRecord>;
  upstream_claim_omissions: ReadonlyArray<OmittedClaimRef>;
  navigation_budget_policy: NavigationBudgetPolicy;
  verified_detail_budget_policy: VerifiedDetailBudgetPolicy;
  total_section_budget_policy: TotalSectionBudgetPolicy;
  overflow_behavior: BudgetOverflowBehavior;
  renderer: MemoryBudgetFragmentRenderer;
  estimator: TokenEstimator | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BUDGET_PROTOCOL_VERSION = '1';
export const OVERFLOW_MANIFEST_PROTOCOL_VERSION = '1';

/**
 * applied_steps 严格固定六步顺序(spec §7.9)。
 * 即使某步未触发任何 omission,也必须出现在 applied_steps 中。
 * 这是审计/可观测性的要求:让调用方知道 budget pipeline 完整跑过哪几步。
 */
const APPLIED_STEPS: ReadonlyArray<BudgetAppliedStep> = [
  'navigation_count',
  'navigation_budget',
  'per_item_claim_count',
  'verified_detail_count',
  'verified_detail_budget',
  'total_section_budget',
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * 计量一段渲染产物(spec §7.9 measure 方法)。
 *
 * - bytes: UTF-8 字节长(Buffer.byteLength),multibyte 安全。
 * - lines: 空串=0,否则 split('\n').length(末尾无换行则=N 行数,有换行则=N+1)。
 * - estimated_tokens: 注入 estimator 时填充,否则 null。
 *
 * 关键:绝不用源字段大小近似最终 render —— 必须对 renderer 输出做计量。
 */
function measure(
  rendered: string,
  estimator: TokenEstimator | null,
): FragmentMeasurement {
  const bytes = Buffer.byteLength(rendered, 'utf8');
  const lines = rendered.length === 0 ? 0 : rendered.split('\n').length;
  const estimated_tokens = estimator ? estimator.measure(rendered) : null;
  return { bytes, lines, estimated_tokens };
}

/**
 * 校验 policy 数字字段是有限非负数(spec §7.9 review checkpoint:
 * "没有隐含 unlimited budget(max_* 必须有限非负)")。
 */
function requireFiniteNonNeg(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number, got ${value}`);
  }
}

/** 校验 navigation budget policy 的关键字段。 */
function validateNavigationPolicy(policy: NavigationBudgetPolicy): void {
  requireIdentity(policy.policy_id, 'navigation_budget_policy.policy_id');
  requireIdentity(policy.policy_version, 'navigation_budget_policy.policy_version');
  requireFiniteNonNeg(policy.max_bytes, 'navigation_budget_policy.max_bytes');
  requireFiniteNonNeg(policy.max_entries, 'navigation_budget_policy.max_entries');
  if (policy.max_lines !== null) {
    requireFiniteNonNeg(policy.max_lines, 'navigation_budget_policy.max_lines');
  }
}

/** 校验 verified detail budget policy 的关键字段。 */
function validateVerifiedDetailPolicy(policy: VerifiedDetailBudgetPolicy): void {
  requireIdentity(policy.policy_id, 'verified_detail_budget_policy.policy_id');
  requireIdentity(
    policy.policy_version,
    'verified_detail_budget_policy.policy_version',
  );
  requireFiniteNonNeg(policy.max_bytes, 'verified_detail_budget_policy.max_bytes');
  requireFiniteNonNeg(policy.max_items, 'verified_detail_budget_policy.max_items');
  requireFiniteNonNeg(
    policy.max_claims_per_item,
    'verified_detail_budget_policy.max_claims_per_item',
  );
  if (policy.max_lines !== null) {
    requireFiniteNonNeg(
      policy.max_lines,
      'verified_detail_budget_policy.max_lines',
    );
  }
}

/** 校验 total section budget policy 的关键字段。 */
function validateTotalPolicy(policy: TotalSectionBudgetPolicy): void {
  requireIdentity(policy.policy_id, 'total_section_budget_policy.policy_id');
  requireIdentity(policy.policy_version, 'total_section_budget_policy.policy_version');
  requireFiniteNonNeg(policy.max_bytes, 'total_section_budget_policy.max_bytes');
  if (policy.max_lines !== null) {
    requireFiniteNonNeg(policy.max_lines, 'total_section_budget_policy.max_lines');
  }
}

/**
 * 校验上游 omissions 的关键字段非空(memory_record_id / claim_ref)。
 * reason_codes 允许为空数组(防御性,实际不应为空)。
 */
function normalizeUpstream(
  upstreamNavs: ReadonlyArray<OmittedNavigationRecord>,
  upstreamClaims: ReadonlyArray<OmittedClaimRef>,
): {
  navs: ReadonlyArray<OmittedNavigationRecord>;
  claims: ReadonlyArray<OmittedClaimRef>;
} {
  const navs: OmittedNavigationRecord[] = [];
  for (const rec of upstreamNavs) {
    requireIdentity(rec.memory_record_id, 'upstream_navigation_omissions.memory_record_id');
    navs.push({
      memory_record_id: rec.memory_record_id,
      reason_codes: Array.from(rec.reason_codes),
    });
  }
  const claims: OmittedClaimRef[] = [];
  for (const ref of upstreamClaims) {
    requireIdentity(ref.memory_record_id, 'upstream_claim_omissions.memory_record_id');
    requireIdentity(ref.claim_ref, 'upstream_claim_omissions.claim_ref');
    claims.push({
      memory_record_id: ref.memory_record_id,
      claim_ref: ref.claim_ref,
      reason_codes: Array.from(ref.reason_codes),
    });
  }
  return { navs, claims };
}

/**
 * 计算确定性 overflow_manifest_id。
 *
 * payload 必须对相同输入产生相同字符串 → 相同 sha256。包含:
 *   - protocol version
 *   - truncated / 各层 overflow 标志
 *   - budget_policy_refs(固定顺序)
 *   - 所有 omitted records / claim refs(reason_codes 排序后拼接,整体再排序)
 *
 * 注意:不包含 retained 集合 —— retained 由 omitted 集合 + eligible 集合
 * 隐含决定,而 eligible 不进入 manifest;manifest 只描述"哪些被 omit"。
 */
function computeOverflowManifestId(
  truncated: boolean,
  navigationOverflowed: boolean,
  verifiedDetailOverflowed: boolean,
  totalBudgetOverflowed: boolean,
  budgetPolicyRefs: ReadonlyArray<string>,
  omittedRecords: ReadonlyArray<OmittedNavigationRecord>,
  omittedClaims: ReadonlyArray<OmittedClaimRef>,
): string {
  const navLines = omittedRecords
    .map(
      (r) =>
        `nav:${r.memory_record_id}:[${Array.from(r.reason_codes)
          .slice()
          .sort()
          .join(',')}]`,
    )
    .sort();
  const claimLines = omittedClaims
    .map(
      (r) =>
        `claim:${r.memory_record_id}:${r.claim_ref}:[${Array.from(r.reason_codes)
          .slice()
          .sort()
          .join(',')}]`,
    )
    .sort();
  const payload = [
    OVERFLOW_MANIFEST_PROTOCOL_VERSION,
    `truncated:${truncated ? 'true' : 'false'}`,
    `navigation_overflowed:${navigationOverflowed ? 'true' : 'false'}`,
    `verified_detail_overflowed:${verifiedDetailOverflowed ? 'true' : 'false'}`,
    `total_budget_overflowed:${totalBudgetOverflowed ? 'true' : 'false'}`,
    `policies:${Array.from(budgetPolicyRefs).join('|')}`,
    ...navLines,
    ...claimLines,
  ].join('\n');
  return sha256Hex(payload);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 对 eligible navigation + eligible claims 做三层预算切分(spec §7.9 / §7.10)。
 *
 * 六步顺序严格固定:
 *   1. navigation_count    — max_entries cap,从尾部逆序移除
 *   2. navigation_budget   — 单项 max_bytes / max_lines,整项 omit
 *   3. per_item_claim_count — 每 record 的 claims,保留前 N(reason=count_limit)
 *   4. verified_detail_count — max_items cap,从尾部逆序移除
 *   5. verified_detail_budget — 单项 max_bytes / max_lines,整项 omit
 *   6. total_section_budget — 最终总预算,二阶段(先 claim 逆序,后 nav 逆序)
 *
 * 任何层超限 + overflow_behavior='reject' → state='rejected',retained 全空。
 * 全部 eligible 被 omit → state='rejected'(无内容)。
 * 有 retained 且有任何 omission → 'partial'。
 * 有 retained 且无任何 omission → 'ready'。
 *
 * 输出深冻结,确定性:相同 input + renderer + estimator → 相同结果。
 */
export function applyMemoryEntrypointBudgets(
  input: ApplyMemoryEntrypointBudgetsInput,
): BudgetedMemoryEntrypoint {
  // 1) 校验 policy / estimator 的关键字段
  validateNavigationPolicy(input.navigation_budget_policy);
  validateVerifiedDetailPolicy(input.verified_detail_budget_policy);
  validateTotalPolicy(input.total_section_budget_policy);
  if (input.estimator !== null) {
    requireIdentity(input.estimator.estimator_id, 'estimator.estimator_id');
    requireIdentity(input.estimator.estimator_version, 'estimator.estimator_version');
  }
  const upstream = normalizeUpstream(
    input.upstream_navigation_omissions,
    input.upstream_claim_omissions,
  );

  const renderer = input.renderer;
  const estimator = input.estimator;
  const navPolicy = input.navigation_budget_policy;
  const detailPolicy = input.verified_detail_budget_policy;
  const totalPolicy = input.total_section_budget_policy;

  // 2) Omission 累加器(budget 侧;upstream 在最后合并)
  let navigationOverflowed = false;
  let verifiedDetailOverflowed = false;
  let totalBudgetOverflowed = false;
  const budgetOmittedNavs: OmittedNavigationRecord[] = [];
  const budgetOmittedClaims: OmittedClaimRef[] = [];

  // Working copies of eligible sets(可变,从输入拷贝以保证不污染输入)
  let navs: BudgetNavigationItem[] = input.eligible_navigation.slice();
  let claims: BudgetVerifiedClaim[] = input.eligible_claims.slice();

  // --- Step 1: navigation_count -----------------------------------------
  // max_entries cap,从尾部逆序移除(头部 selection_rank 最低 = 优先级最高)
  if (navs.length > navPolicy.max_entries) {
    const keepCount = Math.max(0, navPolicy.max_entries);
    const dropped = navs.slice(keepCount);
    navs = navs.slice(0, keepCount);
    for (const item of dropped) {
      budgetOmittedNavs.push({
        memory_record_id: item.memory_record_id,
        reason_codes: ['navigation_count_limit'],
      });
    }
    if (dropped.length > 0) navigationOverflowed = true;
  }

  // --- Step 2: navigation_budget ----------------------------------------
  // 单项渲染产物超过 max_bytes / max_lines → 整项 omit
  // 关键:对 renderer 输出做计量,绝不用源字段大小近似;绝不切 string。
  {
    const kept: BudgetNavigationItem[] = [];
    for (const item of navs) {
      const rendered = renderer.renderNavigation(item);
      const m = measure(rendered, estimator);
      const exceedsBytes = m.bytes > navPolicy.max_bytes;
      const exceedsLines =
        navPolicy.max_lines !== null && m.lines > navPolicy.max_lines;
      if (exceedsBytes || exceedsLines) {
        budgetOmittedNavs.push({
          memory_record_id: item.memory_record_id,
          reason_codes: ['navigation_budget_limit'],
        });
        navigationOverflowed = true;
      } else {
        kept.push(item);
      }
    }
    navs = kept;
  }

  // --- Step 3: per_item_claim_count -------------------------------------
  // 对每个 record 的 claims,按输入顺序保留前 max_claims_per_item 个,其余 omit。
  // 规格中 per_item 与 verified_detail_count 共享同一 reason 类别
  // ('verified_detail_count_limit'),因为没有 per_item 单独的 reason 枚举值。
  {
    // 按 record 分组(保留首次出现顺序),每组记录其成员列表
    const byRecord = new Map<string, BudgetVerifiedClaim[]>();
    for (const c of claims) {
      const arr = byRecord.get(c.memory_record_id);
      if (arr === undefined) {
        byRecord.set(c.memory_record_id, [c]);
      } else {
        arr.push(c);
      }
    }
    const maxPerItem = detailPolicy.max_claims_per_item;
    const kept: BudgetVerifiedClaim[] = [];
    for (const c of claims) {
      const arr = byRecord.get(c.memory_record_id);
      if (arr === undefined) {
        // 不应发生(刚刚塞进去)
        kept.push(c);
        continue;
      }
      // 该 claim 在其 record 分组中的位置(基于引用相等)
      const idx = arr.indexOf(c);
      if (idx >= 0 && idx < maxPerItem) {
        kept.push(c);
      } else {
        budgetOmittedClaims.push({
          memory_record_id: c.memory_record_id,
          claim_ref: c.verified_claim_ref,
          reason_codes: ['verified_detail_count_limit'],
        });
        verifiedDetailOverflowed = true;
      }
    }
    claims = kept;
  }

  // --- Step 4: verified_detail_count -----------------------------------
  // max_items cap,从尾部逆序移除
  if (claims.length > detailPolicy.max_items) {
    const keepCount = Math.max(0, detailPolicy.max_items);
    const dropped = claims.slice(keepCount);
    claims = claims.slice(0, keepCount);
    for (const c of dropped) {
      budgetOmittedClaims.push({
        memory_record_id: c.memory_record_id,
        claim_ref: c.verified_claim_ref,
        reason_codes: ['verified_detail_count_limit'],
      });
    }
    if (dropped.length > 0) verifiedDetailOverflowed = true;
  }

  // --- Step 5: verified_detail_budget ----------------------------------
  // 单项渲染产物超过 max_bytes / max_lines → 整项 omit
  {
    const kept: BudgetVerifiedClaim[] = [];
    for (const c of claims) {
      const rendered = renderer.renderVerifiedClaim(c);
      const m = measure(rendered, estimator);
      const exceedsBytes = m.bytes > detailPolicy.max_bytes;
      const exceedsLines =
        detailPolicy.max_lines !== null && m.lines > detailPolicy.max_lines;
      if (exceedsBytes || exceedsLines) {
        budgetOmittedClaims.push({
          memory_record_id: c.memory_record_id,
          claim_ref: c.verified_claim_ref,
          reason_codes: ['verified_detail_budget_limit'],
        });
        verifiedDetailOverflowed = true;
      } else {
        kept.push(c);
      }
    }
    claims = kept;
  }

  // 3) 为所有 retained 计算 rendered_fragment + measurement(step 6 需要)
  let retainedNavs: BudgetedNavigationItem[] = navs.map((item) => {
    const rendered = renderer.renderNavigation(item);
    return {
      ...item,
      rendered_fragment: rendered,
      measurement: measure(rendered, estimator),
    };
  });
  let retainedClaims: BudgetedVerifiedClaim[] = claims.map((c) => {
    const rendered = renderer.renderVerifiedClaim(c);
    return {
      ...c,
      rendered_fragment: rendered,
      measurement: measure(rendered, estimator),
    };
  });

  // --- Step 6: total_section_budget ------------------------------------
  // 二阶段:先按 claim 逆序移除最低优先级;仍超限再按 navigation 逆序移除,
  // 且移除 navigation 时其名下所有 retained claim 一并移除。
  const computeTotalBytesLines = (): { bytes: number; lines: number } => {
    let bytes = 0;
    let lines = 0;
    for (const n of retainedNavs) {
      bytes += n.measurement.bytes;
      lines += n.measurement.lines;
    }
    for (const c of retainedClaims) {
      bytes += c.measurement.bytes;
      lines += c.measurement.lines;
    }
    return { bytes, lines };
  };
  const totalExceeded = (t: { bytes: number; lines: number }): boolean =>
    t.bytes > totalPolicy.max_bytes ||
    (totalPolicy.max_lines !== null && t.lines > totalPolicy.max_lines);

  let currentTotal = computeTotalBytesLines();
  if (totalExceeded(currentTotal)) {
    totalBudgetOverflowed = true;
    // Phase 1: 按 claim 逆序移除最低优先级(尾部优先)
    while (retainedClaims.length > 0 && totalExceeded(currentTotal)) {
      const dropped = retainedClaims[retainedClaims.length - 1]!;
      retainedClaims = retainedClaims.slice(0, -1);
      budgetOmittedClaims.push({
        memory_record_id: dropped.memory_record_id,
        claim_ref: dropped.verified_claim_ref,
        reason_codes: ['total_section_budget_limit'],
      });
      currentTotal = computeTotalBytesLines();
    }
    // Phase 2: 按 navigation 逆序移除最低优先级;移除时其名下 claim 一并移除
    while (retainedNavs.length > 0 && totalExceeded(currentTotal)) {
      const dropped = retainedNavs[retainedNavs.length - 1]!;
      retainedNavs = retainedNavs.slice(0, -1);
      budgetOmittedNavs.push({
        memory_record_id: dropped.memory_record_id,
        reason_codes: ['total_section_budget_limit'],
      });
      // 同步移除该 record 下的 retained claim
      const stillRetained: BudgetedVerifiedClaim[] = [];
      for (const c of retainedClaims) {
        if (c.memory_record_id === dropped.memory_record_id) {
          budgetOmittedClaims.push({
            memory_record_id: c.memory_record_id,
            claim_ref: c.verified_claim_ref,
            reason_codes: ['total_section_budget_limit'],
          });
        } else {
          stillRetained.push(c);
        }
      }
      retainedClaims = stillRetained;
      currentTotal = computeTotalBytesLines();
    }
  }

  // 4) 决定最终 state 与 retained 集合
  const anyBudgetOverflow =
    navigationOverflowed || verifiedDetailOverflowed || totalBudgetOverflowed;

  let state: BudgetedState;
  let finalRetainedNavs: BudgetedNavigationItem[] = retainedNavs;
  let finalRetainedClaims: BudgetedVerifiedClaim[] = retainedClaims;

  if (input.overflow_behavior === 'reject' && anyBudgetOverflow) {
    // reject 模式:任一层超限 → 整个 entrypoint 被拒绝
    state = 'rejected';
    finalRetainedNavs = [];
    finalRetainedClaims = [];
  } else if (retainedNavs.length === 0 && retainedClaims.length === 0) {
    // 所有 eligible 都被 omit 后无 retained → rejected(无内容)
    state = 'rejected';
  } else {
    const hasAnyOmission =
      budgetOmittedNavs.length > 0 ||
      budgetOmittedClaims.length > 0 ||
      upstream.navs.length > 0 ||
      upstream.claims.length > 0;
    state = hasAnyOmission ? 'partial' : 'ready';
  }

  // 5) 构建 overflow manifest —— 合并 budget omission 与上游 omission
  const allOmittedRecords: OmittedNavigationRecord[] = [
    ...budgetOmittedNavs,
    ...upstream.navs,
  ];
  const allOmittedClaims: OmittedClaimRef[] = [
    ...budgetOmittedClaims,
    ...upstream.claims,
  ];
  // truncated=true 当且仅当有任何 omission(包括 budget 和上游透传)
  const truncated = allOmittedRecords.length > 0 || allOmittedClaims.length > 0;

  const budgetPolicyRefs: string[] = [
    `${navPolicy.policy_id}:${navPolicy.policy_version}`,
    `${detailPolicy.policy_id}:${detailPolicy.policy_version}`,
    `${totalPolicy.policy_id}:${totalPolicy.policy_version}`,
  ];

  const overflow_manifest_id = computeOverflowManifestId(
    truncated,
    navigationOverflowed,
    verifiedDetailOverflowed,
    totalBudgetOverflowed,
    budgetPolicyRefs,
    allOmittedRecords,
    allOmittedClaims,
  );

  const overflow_manifest: MemoryEntrypointOverflowManifest = {
    overflow_protocol_version: OVERFLOW_MANIFEST_PROTOCOL_VERSION,
    overflow_manifest_id,
    truncated,
    navigation_overflowed: navigationOverflowed,
    verified_detail_overflowed: verifiedDetailOverflowed,
    total_budget_overflowed: totalBudgetOverflowed,
    omitted_records: allOmittedRecords,
    omitted_claim_refs: allOmittedClaims,
    budget_policy_refs: budgetPolicyRefs,
  };

  // 6) 计算 total_measurement(基于最终 retained 集合)
  let totalBytes = 0;
  let totalLines = 0;
  let totalTokens: number | null = estimator !== null ? 0 : null;
  for (const n of finalRetainedNavs) {
    totalBytes += n.measurement.bytes;
    totalLines += n.measurement.lines;
    if (totalTokens !== null && n.measurement.estimated_tokens !== null) {
      totalTokens += n.measurement.estimated_tokens;
    }
  }
  for (const c of finalRetainedClaims) {
    totalBytes += c.measurement.bytes;
    totalLines += c.measurement.lines;
    if (totalTokens !== null && c.measurement.estimated_tokens !== null) {
      totalTokens += c.measurement.estimated_tokens;
    }
  }
  const total_measurement: FragmentMeasurement = {
    bytes: totalBytes,
    lines: totalLines,
    estimated_tokens: totalTokens,
  };

  const estimator_ref = estimator
    ? `${estimator.estimator_id}:${estimator.estimator_version}`
    : null;

  // 7) 顶层 reason_codes:聚合所有 omissions 的原因(去重 + 排序,确定性)
  const reasonSet = new Set<string>();
  for (const r of allOmittedRecords) {
    for (const rc of r.reason_codes) reasonSet.add(rc);
  }
  for (const r of allOmittedClaims) {
    for (const rc of r.reason_codes) reasonSet.add(rc);
  }
  const reason_codes = Array.from(reasonSet).sort();

  // 8) 组装 + 深冻结
  const result: BudgetedMemoryEntrypoint = {
    budget_protocol_version: BUDGET_PROTOCOL_VERSION,
    state,
    applied_steps: APPLIED_STEPS,
    retained_navigation: finalRetainedNavs,
    retained_claims: finalRetainedClaims,
    upstream_navigation_omissions: upstream.navs,
    upstream_claim_omissions: upstream.claims,
    overflow_manifest,
    total_measurement,
    estimator_ref,
    reason_codes,
  };

  return freezeSnapshot(result);
}
