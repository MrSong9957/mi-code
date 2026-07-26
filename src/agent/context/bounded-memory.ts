// FRC-1 Bounded Memory Entrypoint — Wave F (Tasks 1–3)
//
// 物理本质:把 ERC-2 governed Memory 输出(catalog snapshot + selection + retrieved
// detail + MemoryUseDecision)投影为一个**有界**请求入口。所有内容寻址 identity
// 必须在 build 开始时一次性捕获(INV-F1);build 过程中到达的新 snapshot 不能混入。
//
// 这个文件覆盖 Wave F Task 1–3:
//   - Task 1: captureMemoryEntrypointBuild — 输入捕获 + 一致性校验 + 冻结。
//   - Task 2: projectMemoryNavigation — 9 字段 metadata-only 导航投影。
//   - Task 3: projectVerifiedMemoryClaims — 9 门验证后的 verified claim 投影。
//
// 这个文件 *不* 做的事 (规格 §3 / §8 / Wave F INV):
//   - 不读 .memory/MEMORY.md 或调用 MemoryManager.inject / selectByKeywords。
//   - 不把 selected 当作 Truth / Trust / Authority / use (INV-F3)。
//   - 不产生新的 Memory / confidence / instruction (INV-F13)。
//   - 不在 failure 时回退为"加载全部 Memory" (INV-F10)。
//   - 不修改 catalog / selection / use decision(它们是只读消费者)。
//   - 不实现预算 / render / entrypoint core / cache(那是 Task 4–7 的范围)。
//
// 规格来源:docs/superpowers/specs/2026-07-26-agent-bounded-memory-entrypoint-wave-f-design.md
//   §6 共同词汇与身份 / §7.1–§7.10 / §8 Wave F 不变量

import { createHash } from 'node:crypto';
import { freezeSnapshot } from '../contracts/identities.js';
import type { AutoMemoryType } from '../../memory/candidates.js';
import type {
  MemoryCatalogEntry,
  MemoryCatalogSnapshot,
} from '../../memory/catalog.js';
import type {
  MemorySelectionResult,
} from '../../memory/selection.js';
import type { MemoryUseDecision } from '../../memory/admission.js';

// Task 6 接线:从 T4/T5 引入 budget / render 实现与 working types。
// 这两个文件**不**反向 import 本文件(无循环依赖)。
import {
  applyMemoryEntrypointBudgets,
  type ApplyMemoryEntrypointBudgetsInput,
  type BudgetNavigationItem,
  type BudgetVerifiedClaim,
  type BudgetedMemoryEntrypoint,
  type BudgetedNavigationItem,
  type BudgetedVerifiedClaim,
  type BudgetOverflowBehavior,
  type MemoryBudgetFragmentRenderer,
  type MemoryEntrypointOmissionReason,
  type NavigationBudgetPolicy,
  type OmittedClaimRef,
  type OmittedNavigationRecord,
  type TotalSectionBudgetPolicy,
  type TokenEstimator,
  type VerifiedDetailBudgetPolicy,
} from './bounded-memory-budget.js';
import {
  renderMemoryEntrypoint,
  createRendererAdaptor,
  toMemoryPromptSection,
  type RenderMemoryEntrypointInput,
  type RenderNavigationItem,
  type RenderOverflowMarker,
  type RenderProfileAsset,
  type RenderVerifiedClaim,
  type RenderedMemorySection,
  type MemoryPromptHandoffResult,
  type MemoryPromptHandoffError,
  RENDER_PROTOCOL_VERSION,
} from './bounded-memory-render.js';
import type { PromptSectionInput } from '../prompt/compiler.js';
import {
  getOrBuildMemoryEntrypoint,
  type MemoryEntrypointCache,
  type MemoryEntrypointCacheInput,
  type CacheableEntrypointPayload,
} from './bounded-memory-cache.js';

// ===========================================================================
// §1 Protocol versions (INV-F14: 各 protocol_version 独立版本化)
// ===========================================================================

/**
 * entrypoint build 协议版本。captureMemoryEntrypointBuild 的输入 schema 标记。
 */
export const ENTRYPOINT_PROTOCOL_VERSION = '1';

/**
 * entrypoint policy 协议版本。MemoryEntrypointPolicy 的 schema 标记。
 */
export const ENTRYPOINT_POLICY_PROTOCOL_VERSION = '1';

/**
 * navigation item 协议版本。
 */
export const NAVIGATION_ITEM_PROTOCOL_VERSION = '1';

/**
 * verified claim projection 协议版本。
 */
export const VERIFIED_CLAIM_PROJECTION_PROTOCOL_VERSION = '1';

/**
 * entrypoint item 协议版本(Task 6 范围,此处仅声明常量)。
 */
export const ENTRYPOINT_ITEM_PROTOCOL_VERSION = '1';

/**
 * overflow manifest 协议版本(Task 4 范围,此处仅声明常量)。
 */
export const OVERFLOW_MANIFEST_PROTOCOL_VERSION = '1';

// ===========================================================================
// §2 类型定义(共享给 Task 1/2/3 与后续 Task 4–7)
// ===========================================================================

/**
 * FRC-1 引用一个 frozen integrated contract(policy / budget / render 等)。
 *
 * 注:本字段 protocol_version 字段名是 `contract_version`,与规格 §6.1 对齐。
 */
export interface WaveFContractRef {
  /** 受信 runtime/configuration 中冻结的 contract id。 */
  contract_id: string;
  /** contract 自身的 schema 版本(独立于 entrypoint build 版本)。 */
  contract_version: string;
}

/**
 * entrypoint snapshot 状态(规格 §6.2)。
 *
 * Task 1 只能输出 'prepared' | 'empty' | 'rejected'。
 * 'ready' / 'partial' 由后续 Task 4(budget)与 Task 5(render)决定。
 */
export type MemoryEntrypointState =
  | 'prepared'
  | 'ready'
  | 'empty'
  | 'partial'
  | 'rejected';

/**
 * overflow behavior(规格 §7.2)。
 * - 'entry_boundary_omit':超限时在完整 item 边界省略,state='partial'。
 * - 'reject':任何超限直接 reject 整个 build。
 */
export type MemoryEntrypointOverflowBehavior =
  | 'entry_boundary_omit'
  | 'reject';

/**
 * entrypoint policy(规格 §7.2)。
 *
 * 关键不变量:
 *   - policy 必须来自受信 runtime/configuration;
 *     Prompt / Memory / catalog entry / Tool Result / Agent 不能修改 policy。
 *   - 所有数量和预算字段必须是有限非负值。
 *   - enabled=false 产生有效 empty snapshot,不读取 detail。
 *   - empty_behavior 当前只允许 'omit_section'。
 *   - policy 不授予 use 资格,不改变 Authority/Trust/Freshness/Retention。
 */
export interface MemoryEntrypointPolicy {
  entrypoint_policy_protocol_version: string;
  policy_id: string;
  policy_version: string;
  enabled: boolean;
  allowed_memory_types: ReadonlyArray<AutoMemoryType>;
  allowed_scope_refs: ReadonlyArray<string>;
  navigation_budget_policy_ref: string;
  verified_detail_budget_policy_ref: string;
  total_section_budget_policy_ref: string;
  max_navigation_entries: number;
  max_verified_detail_items: number;
  max_verified_claims_per_item: number;
  overflow_behavior: MemoryEntrypointOverflowBehavior;
  empty_behavior: 'omit_section';
  render_profile_ref: string;
}

/**
 * retrieved detail(规格 §7.4)。
 *
 * Wave F 自定义版本(因为 ERC-2 的 MemoryRetrievalResult 没有按 record 拆分的
 * detail projection export)。本结构与 selection / catalog / use decisions 一起
 * 在 build 开始时一次性捕获(INV-F1)。
 *
 * detail_content_hash 必须是 'sha256:<64hex>' 格式。
 */
export interface RetrievedMemoryDetail {
  retrieval_protocol_version: string;
  retrieval_id: string;
  memory_record_id: string;
  record_version: number;
  /** 必须等于 build input 的 catalog_snapshot.catalog_snapshot_id。 */
  catalog_snapshot_id: string;
  /** 必须等于 build input 的 selection_result.selection_id。 */
  selection_id: string;
  detail_content_ref: string;
  /** 'sha256:<64hex>' 格式 —— 由 retrieval 层计算并绑定。 */
  detail_content_hash: string;
  retrieved_claim_refs: ReadonlyArray<string>;
  provenance_refs: ReadonlyArray<string>;
  freshness_ref: string;
}

/**
 * entrypoint build input(规格 §7.3)。
 *
 * 输入必须在 build 开始时一次性捕获;build 过程中到达的新 catalog / selection /
 * detail / use decision 不能混入当前 build (INV-F1)。
 *
 * policy 同时以对象形式(policy)与 contract ref 形式(policy_ref)传入 ——
 * capture 验证 policy 字段并冻结 policy 对象,policy_ref 作为 identity 写入 snapshot。
 */
export interface MemoryEntrypointBuildInput {
  entrypoint_build_protocol_version: string;
  build_id: string;
  task_snapshot_id: string;
  current_context_snapshot_id: string;
  project_version_ref: string | null;
  catalog_snapshot: MemoryCatalogSnapshot;
  selection_result: MemorySelectionResult;
  retrieved_details: ReadonlyArray<RetrievedMemoryDetail>;
  memory_use_decisions: ReadonlyArray<MemoryUseDecision>;
  /** policy 对象本身(同时作为内容与校验源)。 */
  policy: MemoryEntrypointPolicy;
  /** policy 在受信 runtime 中的 contract 引用,作为 identity 写入 snapshot。 */
  policy_ref: WaveFContractRef;
  request_budget_snapshot_id: string;
  render_profile_ref: string;
}

/**
 * captureMemoryEntrypointBuild 的输出。
 *
 * state ∈ { 'prepared', 'empty', 'rejected' };'ready' / 'partial' 由后续 task 决定。
 * 所有字段在 capture 完成后不可变(freezeSnapshot)。
 */
export interface PreparedMemoryEntrypointBuild {
  prepared_protocol_version: string;
  build_id: string;
  state: MemoryEntrypointState;
  task_snapshot_id: string;
  current_context_snapshot_id: string;
  project_version_ref: string | null;
  catalog_snapshot: Readonly<MemoryCatalogSnapshot>;
  selection_result: Readonly<MemorySelectionResult>;
  retrieved_details: ReadonlyArray<Readonly<RetrievedMemoryDetail>>;
  memory_use_decisions: ReadonlyArray<Readonly<MemoryUseDecision>>;
  policy: Readonly<MemoryEntrypointPolicy>;
  policy_ref: Readonly<WaveFContractRef>;
  request_budget_snapshot_id: string;
  render_profile_ref: string;
  reason_codes: ReadonlyArray<string>;
  /** ISO 8601 时间戳;capture 完成时刻。 */
  captured_at: string;
}

// ===========================================================================
// §3 helpers
// ===========================================================================

const HEX16_RE = /^[0-9a-f]{16}$/u;
const HEX64_RE = /^[0-9a-f]{64}$/u;
const CATALOG_PREFIX = 'catalog:';
const SHA256_HEX_RE = /^sha256:[0-9a-f]{64}$/u;

/**
 * 校验 catalog_snapshot_id 是 'catalog:<16-hex>' 格式 + catalog_hash 是 64-hex。
 *
 * 注意:Wave F 不重新计算 catalog_hash —— 那是 ERC-2 catalog.ts 自身的责任
 * (规格 §7.4 规则 2 / §7.18)。这里只做格式 + 长度校验,避免重复造轮子且与上游
 * 产生细微偏差。
 */
function validateCatalogSnapshotIdentity(
  snapshot: MemoryCatalogSnapshot,
): boolean {
  const id = snapshot.catalog_snapshot_id;
  const hash = snapshot.catalog_hash;
  if (typeof id !== 'string' || !id.startsWith(CATALOG_PREFIX)) {
    return false;
  }
  const suffix = id.slice(CATALOG_PREFIX.length);
  if (!HEX16_RE.test(suffix)) {
    return false;
  }
  if (typeof hash !== 'string' || !HEX64_RE.test(hash)) {
    return false;
  }
  return true;
}

/**
 * 校验数量字段是有限非负整数(允许 0;规格 §7.2 规则 3 + §7.17 "合法预算为零")。
 */
function isFiniteNonNegativeNumber(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0
  );
}

// ===========================================================================
// §4 Task 1: captureMemoryEntrypointBuild
// ===========================================================================

/**
 * 把 build input 一次性捕获为不可变 prepared build,执行 identity / policy / catalog /
 * selection / retrieved_details / use_decisions 一致性校验。
 *
 * 校验顺序(规格 §7.1 / §7.18 / §7.19):
 *   1. build input identity(build_id / task_snapshot_id / current_context_snapshot_id /
 *      request_budget_snapshot_id / render_profile_ref)。
 *   2. policy identity + 字段合法性。
 *   3. policy.enabled=false → state='empty',**跳过** detail/use 一致性校验。
 *   4. policy budget / empty_behavior 校验。
 *   5. catalog snapshot identity(catalog:<16hex> + 64hex hash)。
 *   6. selection ↔ catalog cross-check(每条 selected entry 都在 catalog 中找到
 *      匹配的 record + record_version)。
 *   7. retrieved_details 绑定(catalog_snapshot_id / selection_id 一致)。
 *   8. memory_use_decisions 绑定(current_context_snapshot_id / stored_memory_ref in catalog)。
 *   9. policy_ref 非空。
 *
 * 任何一步失败 → state='rejected',reason_codes 含失败原因。
 * reason_codes 是可枚举的 programmatic code,数值上下文不在 code 中。
 *
 * 输出 state ∈ { 'prepared', 'empty', 'rejected' }。
 *
 * 这个函数 *不* 做的事:
 *   - 不读 detail body(只读 catalog metadata + 已传入的 retrieved_details)。
 *   - 不调用 MemoryManager / selectByKeywords / inject。
 *   - 不修改 catalog / selection / use decision(它们是只读消费者)。
 *   - 不实现 navigation / verified claim projection(那是 Task 2/3)。
 *   - 不实现 budget / render / cache(那是 Task 4–7)。
 */
export function captureMemoryEntrypointBuild(
  input: MemoryEntrypointBuildInput,
): PreparedMemoryEntrypointBuild {
  const reasonCodes: string[] = [];

  // ─── 1. build input identity 守门 ─────────────────────────────────
  const inputIdentityFields: ReadonlyArray<string> = [
    'build_id',
    'task_snapshot_id',
    'current_context_snapshot_id',
    'request_budget_snapshot_id',
    'render_profile_ref',
  ];
  let inputIdentityOk = true;
  for (const field of inputIdentityFields) {
    const value = (input as unknown as Record<string, unknown>)[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      inputIdentityOk = false;
      break;
    }
  }
  if (!inputIdentityOk) {
    reasonCodes.push('build.invalid_identity');
    return makeRejectedBuild(input, reasonCodes);
  }

  // ─── 2. policy identity + 基本字段 ────────────────────────────────
  const policy = input.policy;
  const policyRef = input.policy_ref;

  const policyIdentityOk =
    typeof policy.entrypoint_policy_protocol_version === 'string' &&
    policy.entrypoint_policy_protocol_version.trim().length > 0 &&
    typeof policy.policy_id === 'string' &&
    policy.policy_id.trim().length > 0 &&
    typeof policy.policy_version === 'string' &&
    policy.policy_version.trim().length > 0 &&
    typeof policy.navigation_budget_policy_ref === 'string' &&
    policy.navigation_budget_policy_ref.trim().length > 0 &&
    typeof policy.verified_detail_budget_policy_ref === 'string' &&
    policy.verified_detail_budget_policy_ref.trim().length > 0 &&
    typeof policy.total_section_budget_policy_ref === 'string' &&
    policy.total_section_budget_policy_ref.trim().length > 0 &&
    typeof policy.render_profile_ref === 'string' &&
    policy.render_profile_ref.trim().length > 0 &&
    typeof policyRef.contract_id === 'string' &&
    policyRef.contract_id.trim().length > 0 &&
    typeof policyRef.contract_version === 'string' &&
    policyRef.contract_version.trim().length > 0;

  if (!policyIdentityOk) {
    reasonCodes.push('policy.missing_identity');
    return makeRejectedBuild(input, reasonCodes);
  }

  // ─── 3. policy.enabled=false → state='empty'(规格 §7.2 规则 4 / §7.17) ──
  // enabled=false 时**不**读取 detail / use decision 一致性(INV-F12:不造内容)。
  if (policy.enabled === false) {
    return makeEmptyBuild(input, ['policy.disabled']);
  }

  // ─── 4. policy budget / empty_behavior 校验(规格 §7.2 规则 3/5) ───
  const budgetOk =
    isFiniteNonNegativeNumber(policy.max_navigation_entries) &&
    isFiniteNonNegativeNumber(policy.max_verified_detail_items) &&
    isFiniteNonNegativeNumber(policy.max_verified_claims_per_item);
  if (!budgetOk) {
    reasonCodes.push('policy.invalid_budget');
    return makeRejectedBuild(input, reasonCodes);
  }
  if (policy.empty_behavior !== 'omit_section') {
    reasonCodes.push('policy.invalid_empty_behavior');
    return makeRejectedBuild(input, reasonCodes);
  }

  // ─── 5. catalog snapshot identity(规格 §7.4 规则 2 / §7.18) ──────
  if (!validateCatalogSnapshotIdentity(input.catalog_snapshot)) {
    reasonCodes.push('catalog_snapshot_mismatch');
    return makeRejectedBuild(input, reasonCodes);
  }

  // ─── 6. selection ↔ catalog cross-check(规格 §7.4 规则 1 / §7.18) ──
  // 每条 selected_entry 必须在 catalog.entries 中找到匹配的 record + record_version。
  const catalogIndex = new Map<string, MemoryCatalogEntry>();
  for (const entry of input.catalog_snapshot.entries) {
    catalogIndex.set(entry.memory_record_id, entry);
  }
  for (const sel of input.selection_result.selected_entries) {
    const cat = catalogIndex.get(sel.memory_record_id);
    if (cat === undefined || cat.record_version !== sel.record_version) {
      reasonCodes.push('selection_catalog_record_missing');
      return makeRejectedBuild(input, reasonCodes);
    }
  }

  // ─── 7. retrieved_details 绑定(规格 §7.4 规则 1) ─────────────────
  // detail.catalog_snapshot_id 必须 === build input 的 catalog_snapshot_id。
  // detail.selection_id 必须 === build input 的 selection_id。
  for (const detail of input.retrieved_details) {
    if (detail.catalog_snapshot_id !== input.catalog_snapshot.catalog_snapshot_id) {
      reasonCodes.push('catalog_snapshot_mismatch');
      return makeRejectedBuild(input, reasonCodes);
    }
    if (detail.selection_id !== input.selection_result.selection_id) {
      reasonCodes.push('selection_catalog_mismatch');
      return makeRejectedBuild(input, reasonCodes);
    }
  }

  // ─── 8. memory_use_decisions 绑定(规格 §7.6 + §7.18) ──────────────
  // decision.current_context_snapshot_id 必须 === build input 的 current_context_snapshot_id。
  // decision.stored_memory_ref 必须 === catalog 中某条 record。
  for (const decision of input.memory_use_decisions) {
    if (
      decision.current_context_snapshot_id !== input.current_context_snapshot_id
    ) {
      reasonCodes.push('use_decision_context_mismatch');
      return makeRejectedBuild(input, reasonCodes);
    }
    if (!catalogIndex.has(decision.stored_memory_ref)) {
      reasonCodes.push('use_decision_record_missing');
      return makeRejectedBuild(input, reasonCodes);
    }
  }

  // ─── 全部通过 → state='prepared' ──────────────────────────────────
  // 注:这里不区分 catalog 空 / selection 空等"empty 触发条件" ——
  // 那是 §7.17 列出的 6 种 empty 触发之一,但 capture 阶段保留 state='prepared',
  // 由 Task 4(budget)/ Task 5(render)根据 navigation/verified claim projection 结果
  // 决定是否升级为 'empty'。本任务只负责一致性 + 冻结。
  const prepared: PreparedMemoryEntrypointBuild = {
    prepared_protocol_version: ENTRYPOINT_PROTOCOL_VERSION,
    build_id: input.build_id,
    state: 'prepared',
    task_snapshot_id: input.task_snapshot_id,
    current_context_snapshot_id: input.current_context_snapshot_id,
    project_version_ref: input.project_version_ref,
    catalog_snapshot: input.catalog_snapshot,
    selection_result: input.selection_result,
    retrieved_details: input.retrieved_details,
    memory_use_decisions: input.memory_use_decisions,
    policy: input.policy,
    policy_ref: input.policy_ref,
    request_budget_snapshot_id: input.request_budget_snapshot_id,
    render_profile_ref: input.render_profile_ref,
    reason_codes: reasonCodes,
    captured_at: new Date().toISOString(),
  };
  return freezeSnapshot(prepared) as PreparedMemoryEntrypointBuild;
}

/**
 * 构造一个 rejected build(保留所有 input 引用以便调用方诊断)。
 */
function makeRejectedBuild(
  input: MemoryEntrypointBuildInput,
  reasonCodes: string[],
): PreparedMemoryEntrypointBuild {
  const prepared: PreparedMemoryEntrypointBuild = {
    prepared_protocol_version: ENTRYPOINT_PROTOCOL_VERSION,
    build_id: input.build_id,
    state: 'rejected',
    task_snapshot_id: input.task_snapshot_id,
    current_context_snapshot_id: input.current_context_snapshot_id,
    project_version_ref: input.project_version_ref,
    catalog_snapshot: input.catalog_snapshot,
    selection_result: input.selection_result,
    retrieved_details: input.retrieved_details,
    memory_use_decisions: input.memory_use_decisions,
    policy: input.policy,
    policy_ref: input.policy_ref,
    request_budget_snapshot_id: input.request_budget_snapshot_id,
    render_profile_ref: input.render_profile_ref,
    reason_codes: reasonCodes,
    captured_at: new Date().toISOString(),
  };
  return freezeSnapshot(prepared) as PreparedMemoryEntrypointBuild;
}

/**
 * 构造一个 empty build(spec §7.17:enabled=false 是合法的 empty 触发条件)。
 *
 * empty build 不读取 detail(已通过 capture 早期分支跳过 detail 校验)。
 */
function makeEmptyBuild(
  input: MemoryEntrypointBuildInput,
  reasonCodes: string[],
): PreparedMemoryEntrypointBuild {
  const prepared: PreparedMemoryEntrypointBuild = {
    prepared_protocol_version: ENTRYPOINT_PROTOCOL_VERSION,
    build_id: input.build_id,
    state: 'empty',
    task_snapshot_id: input.task_snapshot_id,
    current_context_snapshot_id: input.current_context_snapshot_id,
    project_version_ref: input.project_version_ref,
    catalog_snapshot: input.catalog_snapshot,
    selection_result: input.selection_result,
    retrieved_details: input.retrieved_details,
    memory_use_decisions: input.memory_use_decisions,
    policy: input.policy,
    policy_ref: input.policy_ref,
    request_budget_snapshot_id: input.request_budget_snapshot_id,
    render_profile_ref: input.render_profile_ref,
    reason_codes: reasonCodes,
    captured_at: new Date().toISOString(),
  };
  return freezeSnapshot(prepared) as PreparedMemoryEntrypointBuild;
}

// ===========================================================================
// §5 Task 2: projectMemoryNavigation
//
// 物理本质:把 prepared build 中的 selection_result.selected_entries(已通过
// capture 校验的 catalog 子集)投影为**有界** navigation metadata。
//
// 这个段只做四件事(规格 §7.5 / §7.7 / §7.10):
//   1. 对每条 selected entry 应用 eligibility 交集:
//        scope ∈ policy.allowed_scope_refs
//        AND type ∈ policy.allowed_memory_types
//        AND durability_evidence_ref_for(entry) 非 null
//   2. 投影为 9 字段 metadata-only navigation item(无 body/claim/credential)。
//   3. 失败的 entry 进入 omissions(保留 record identity + reason);
//      未 selected 的 entry 只聚合为 not_selected_count(不暴露 identity)。
//   4. 确定性排序:selection_rank → catalog entry_order → memory_record_id ASC。
//
// 这个段 *不* 做的事 (规格 §7.5 / §8):
//   - 不读 detail body / claim content / credential / evidence body /
//     conversation / project instruction / 模型摘要(INV-F2)。
//   - 不携带 use decision 字段(use 是 Task 3 范围,INV-F4)。
//   - 不修改 selection / catalog(它们是只读消费者)。
//   - 不实现 budget / render / cache(那是 Task 4–7)。
// ===========================================================================

/**
 * 单个 navigation item(规格 §7.5)。
 *
 * 关键不变量(INV-F2 / INV-F4):
 *   - 只含 9 个 metadata 字段(实际 12 含 protocol_version / memory_record_id /
 *     record_version):无 body / claim / credential / evidence body /
 *     conversation / project instruction / 模型摘要。
 *   - 不携带 use decision 字段(use 是 verified claim projection 的兄弟 projection)。
 */
export interface MemoryNavigationItem {
  navigation_item_protocol_version: string;
  memory_record_id: string;
  record_version: number;
  /** 来自 selection.selected_entries 的索引(0-based)。 */
  selection_rank: number;
  memory_type: AutoMemoryType;
  scope_ref: string;
  topic_key_refs: ReadonlyArray<string>;
  keyword_key_refs: ReadonlyArray<string>;
  observed_at: string;
  expires_at: string | null;
  detail_content_hash: string;
  provenance_refs: ReadonlyArray<string>;
  durability_evidence_ref: string;
}

/**
 * navigation omission 的 reason(规格 §7.5 / §7.10)。
 *
 * - 'not_selected':entry 在 catalog 中但未被 selection 选中(只聚合为 not_selected_count)。
 * - 'scope_excluded':scope 不在 policy.allowed_scope_refs。
 * - 'type_excluded':type 不在 policy.allowed_memory_types。
 * - 'durability_unverified':durability_evidence_ref_for 返回 null。
 */
export type NavigationOmissionReason =
  | 'not_selected'
  | 'scope_excluded'
  | 'type_excluded'
  | 'durability_unverified';

/**
 * 单条 omission 记录。
 *
 * 'not_selected' 时 memory_record_id 可为 null(因为该 reason 只聚合为 count,
 * 不强制暴露每条 identity;但若选择列出,则填 record id)。
 */
export interface NavigationOmission {
  memory_record_id: string | null;
  reason: NavigationOmissionReason;
}

/**
 * navigation projection 结果。
 *
 * items / omissions 都是 frozen 不可变数组;
 * not_selected_count 是聚合指标(不暴露具体 identity)。
 */
export interface NavigationProjectionResult {
  items: ReadonlyArray<MemoryNavigationItem>;
  omissions: ReadonlyArray<NavigationOmission>;
  /** catalog 中存在但未被 selection.selected_entries 包含的 entry 数。 */
  not_selected_count: number;
  projection_protocol_version: string;
  /** 内容寻址 id,前缀 'nav:'。 */
  projection_id: string;
}

/**
 * projectMemoryNavigation 的输入。
 *
 * - prepared:captureMemoryEntrypointBuild 的输出(state 必须为 'prepared' 才有意义投影)。
 * - durability_evidence_ref_for:对每条 catalog entry 返回 durability 证据引用
 *   (如 'durable:ok' / 'durable:missing');null 表示该 entry 没有 durability 证据,
 *   应被 omission('durability_unverified')。
 */
export interface NavigationProjectionInput {
  prepared: PreparedMemoryEntrypointBuild;
  durability_evidence_ref_for: (
    catalog_entry: MemoryCatalogEntry,
  ) => string | null;
}

/**
 * 把 prepared selection 投影为 navigation metadata。
 *
 * 算法(规格 §7.5 + §7.7):
 *   1. 若 prepared.state !== 'prepared' → 返回空 items + 空 omissions + 0 not_selected_count
 *      (empty / rejected build 不允许 navigation;由调用方据 state 处理)。
 *   2. 对 selection.selected_entries 中的每条 entry,按 catalog entry_order(数组位置)
 *      取其位置;应用 eligibility 交集:
 *        a. scope 不在 allowed_scope_refs → omissions += 'scope_excluded'
 *        b. type 不在 allowed_memory_types → omissions += 'type_excluded'
 *        c. durability_evidence_ref_for(entry) === null → omissions += 'durability_unverified'
 *        d. 全部通过 → items += navigation_item
 *   3. not_selected_count = catalog.entries.length - selection.selected_entries.length
 *      (catalog 中存在但未被 selection 选中的 entry 数,只聚合,不暴露 identity)。
 *   4. items 已经按 selection_rank(== selected_entries 索引)有序;
 *      若需要 stable tie-break,以 memory_record_id ASC 为最后手段。
 *
 * 这个函数 *不* 做的事:
 *   - 不读 detail body / claim content。
 *   - 不修改 prepared.selection_result(只读消费)。
 *   - 不应用 budget(budget 是 Task 4 范围)。
 *   - 不输出 verified claim projection(那是 Task 3)。
 */
export function projectMemoryNavigation(
  input: NavigationProjectionInput,
): NavigationProjectionResult {
  const prepared = input.prepared;
  const emptyResult: NavigationProjectionResult = {
    items: [],
    omissions: [],
    not_selected_count: 0,
    projection_protocol_version: NAVIGATION_ITEM_PROTOCOL_VERSION,
    projection_id: computeNavigationProjectionId({
      state: prepared.state,
      selectedItemIds: [],
      omissionRecordIds: [],
      notSelectedCount: 0,
    }),
  };

  // prepared.state 必须为 'prepared' 才有意义投影 navigation。
  if (prepared.state !== 'prepared') {
    return freezeSnapshot(emptyResult) as NavigationProjectionResult;
  }

  const policy = prepared.policy;
  const selectedEntries = prepared.selection_result.selected_entries;
  const catalogEntries = prepared.catalog_snapshot.entries;

  // 构建 catalog entry_order 索引(memory_record_id → 在 catalog.entries 中的位置)。
  // 用于排序 tie-break(规格 §7.7 第 2 项)。
  const catalogOrder = new Map<string, number>();
  catalogEntries.forEach((entry, idx) => {
    catalogOrder.set(entry.memory_record_id, idx);
  });
  void catalogOrder; // 当前实现以 selection_rank 为主键,entry_order 仅作 traceability。

  const allowedScopeSet = new Set(policy.allowed_scope_refs);
  const allowedTypeSet = new Set<string>(policy.allowed_memory_types);

  const items: MemoryNavigationItem[] = [];
  const omissions: NavigationOmission[] = [];

  // 遍历 selected_entries(其顺序 == selection_rank)。
  for (let rank = 0; rank < selectedEntries.length; rank++) {
    const entry = selectedEntries[rank]!;

    // a. scope 检查(优先;先 scope 后 type,与 selector 的过滤顺序一致)。
    if (!allowedScopeSet.has(entry.scope_ref)) {
      omissions.push({
        memory_record_id: entry.memory_record_id,
        reason: 'scope_excluded',
      });
      continue;
    }
    // b. type 检查(catalog.type 是 string,policy.allowed_memory_types 是 AutoMemoryType[];
    //    严格字符串相等比较)。
    if (!allowedTypeSet.has(entry.type)) {
      omissions.push({
        memory_record_id: entry.memory_record_id,
        reason: 'type_excluded',
      });
      continue;
    }
    // c. durability 检查。
    const durabilityRef = input.durability_evidence_ref_for(entry);
    if (durabilityRef === null) {
      omissions.push({
        memory_record_id: entry.memory_record_id,
        reason: 'durability_unverified',
      });
      continue;
    }

    // d. 全部通过 → 投影为 navigation item。
    items.push({
      navigation_item_protocol_version: NAVIGATION_ITEM_PROTOCOL_VERSION,
      memory_record_id: entry.memory_record_id,
      record_version: entry.record_version,
      selection_rank: rank,
      memory_type: entry.type as AutoMemoryType,
      scope_ref: entry.scope_ref,
      topic_key_refs: [...entry.topic_terms],
      keyword_key_refs: [...entry.keyword_terms],
      observed_at: entry.observed_at,
      expires_at: null, // catalog entry 没有 expires_at 字段;此处保留 null 占位
      detail_content_hash: entry.content_hash,
      provenance_refs: [...entry.provenance_refs],
      durability_evidence_ref: durabilityRef,
    });
  }

  // not_selected_count:catalog 中存在但未被 selection.selected_entries 包含的 entry 数。
  const selectedIds = new Set(selectedEntries.map((e) => e.memory_record_id));
  let notSelectedCount = 0;
  for (const entry of catalogEntries) {
    if (!selectedIds.has(entry.memory_record_id)) {
      notSelectedCount++;
    }
  }

  // items 已经按 selection_rank(== selected_entries 遍历顺序)有序;
  // selection_rank 唯一(每条 selected entry 只出现一次),不需要二次排序。

  const result: NavigationProjectionResult = {
    items,
    omissions,
    not_selected_count: notSelectedCount,
    projection_protocol_version: NAVIGATION_ITEM_PROTOCOL_VERSION,
    projection_id: computeNavigationProjectionId({
      state: prepared.state,
      selectedItemIds: items.map((i) => i.memory_record_id),
      omissionRecordIds: omissions.map((o) => o.memory_record_id ?? '<null>'),
      notSelectedCount,
    }),
  };
  return freezeSnapshot(result) as NavigationProjectionResult;
}

/**
 * 计算 navigation projection 的内容寻址 id。
 *
 * canonical 覆盖:protocol version + prepared.state + selected item id 序列 +
 *   omission record id 序列 + not_selected_count。
 *
 * 注意:这里**不**把 prepared.selection_id / catalog_snapshot_id 直接放入 canonical ——
 * 它们已通过 capture 阶段绑定到 prepared build;projection_id 只对投影结果负责。
 */
function computeNavigationProjectionId(fields: {
  state: MemoryEntrypointState;
  selectedItemIds: string[];
  omissionRecordIds: string[];
  notSelectedCount: number;
}): string {
  const canonical = JSON.stringify({
    v: NAVIGATION_ITEM_PROTOCOL_VERSION,
    state: fields.state,
    selected: fields.selectedItemIds,
    omissions: fields.omissionRecordIds,
    not_selected_count: fields.notSelectedCount,
  });
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `nav:${hash.slice(0, 16)}`;
}

// ===========================================================================
// §6 Task 3: projectVerifiedMemoryClaims
//
// 物理本质:对 navigation items 中每条 record 对应的 retrieved detail +
// MemoryUseDecision 执行九门验证,只让同时通过九门的 verified_claim_ref 进入
// 正文 claim projection。
//
// 这个段只做四件事(规格 §7.6 / §7.8):
//   1. 对每条 navigation item 的每条 retrieved_detail 的每条 verified_claim_ref
//      执行九门验证(selected / retrieved / detail hash valid / use status=use /
//      claim in verified_refs / claim not stale / no conflicting evidence /
//      current context matches / project version compatible)。
//   2. 通过九门 → 调用 claim_lookup 取确定性 content_ref + content_hash,
//      生成 VerifiedMemoryClaimProjection。
//   3. 失败的 claim → omitted_claims(保留 record id + claim_ref + reason)。
//   4. 确定性排序:先按 navigation_items 顺序,同一 record 内按 verified_claim_refs
//      稳定顺序;同一 record+claim 去重;相同 identity 不同 hash → rejected_build=true。
//
// 这个段 *不* 做的事 (规格 §7.6 / §8):
//   - 不读取 detail body 之外的内容(claim_lookup 是确定性注入)。
//   - 不修改 Memory / catalog / selection / use decision(只读消费者)。
//   - 不产生新的 Memory / confidence / instruction (INV-F13)。
//   - 不把 needs_refresh 当低置信 use(规格 §7.6:needs_refresh 不进入正文)。
//   - 不实现 budget / render / cache(那是 Task 4–7)。
// ===========================================================================

/**
 * 单个 verified claim projection(规格 §7.6)。
 *
 * 关键不变量(INV-F3 / INV-F13):
 *   - 只含已通过九门验证的 claim 的确定性内容引用;
 *   - 不含模型改写 / 补写 / 摘要 / 推断;
 *   - 不携带 confidence 字段(verified != 高置信)。
 */
export interface VerifiedMemoryClaimProjection {
  claim_projection_protocol_version: string;
  /** 内容寻址 id,前缀 'vclaim:'。 */
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
}

/**
 * verified claim omission 的 reason(规格 §7.6 / §7.18)。
 */
export type VerifiedClaimOmissionReason =
  | 'do_not_use'
  | 'refresh_required'
  | 'stale'
  | 'conflicting_evidence'
  | 'detail_missing'
  | 'detail_hash_mismatch'
  | 'not_in_verified_refs'
  | 'context_mismatch'
  | 'project_version_incompatible'
  | 'duplicate_identity';

/**
 * 单条 verified claim omission 记录。
 */
export interface VerifiedClaimOmission {
  memory_record_id: string;
  claim_ref: string | null;
  reason: VerifiedClaimOmissionReason;
}

/**
 * verified claim projection 的结果。
 *
 * - projections:通过九门的 verified claim,确定性排序后去重。
 * - omitted_claims:失败 claim 的诊断(保留 record+claim+reason)。
 * - rejected_build:相同 identity 不同 hash 时为 true,
 *   表示本次 build 应被整体 rejected。
 */
export interface VerifiedClaimProjectionResult {
  projections: ReadonlyArray<VerifiedMemoryClaimProjection>;
  omitted_claims: ReadonlyArray<VerifiedClaimOmission>;
  projection_protocol_version: string;
  /** 内容寻址 id,前缀 'vclaim:'。 */
  projection_id: string;
  rejected_build: boolean;
  reject_reason_codes: ReadonlyArray<string>;
}

/**
 * 确定性 content lookup(由 Task 3 注入)。
 *
 * 给定 (memory_record_id, verified_claim_ref, detail_content_ref),
 * 返回该 claim 的确定性 (content_ref, content_hash)。null 表示 lookup 失败
 * (例如 detail body 实际缺失,或 claim 不在 detail 中)。
 *
 * 该 lookup 必须是确定性的:相同输入必返回相同输出。
 */
export interface VerifiedClaimContentLookup {
  lookup_protocol_version: string;
  lookup_id: string;
  lookup(ref: {
    memory_record_id: string;
    verified_claim_ref: string;
    detail_content_ref: string;
  }): { content_ref: string; content_hash: string } | null;
}

/**
 * projectVerifiedMemoryClaims 的输入。
 */
export interface VerifiedClaimProjectionInput {
  prepared: PreparedMemoryEntrypointBuild;
  /** 来自 projectMemoryNavigation 的输出 items(只读消费)。 */
  navigation_items: ReadonlyArray<MemoryNavigationItem>;
  /** 确定性 content lookup。 */
  claim_lookup: VerifiedClaimContentLookup;
}

/**
 * 把 prepared build + navigation items 投影为 verified claim projections。
 *
 * 算法(规格 §7.6 + §7.8):
 *   1. 若 prepared.state !== 'prepared' → 返回空 projections + 空 omitted_claims。
 *   2. 对每条 navigation item(按其顺序):
 *      a. 找到 record_id 匹配的 retrieved_detail。
 *      b. 找到 stored_memory_ref === record_id 的 MemoryUseDecision。
 *      c. 执行九门验证;记录第一个失败的 reason(omitted_claims)。
 *      d. 通过 → 对 decision.verified_claim_refs 中每个 ref 执行 claim_lookup;
 *         lookup null → 'detail_missing';lookup hash 与 detail.detail_content_hash
 *         不一致 → 'detail_hash_mismatch'。
 *   3. 同一 record+claim_ref 去重(保留首次)。
 *   4. 相同 identity 出现不同 hash → rejected_build=true,
 *      reason_codes 含 'verified_claim_hash_conflict'。
 *
 * 九门验证顺序(规格 §7.6 + §7.18 reason mapping):
 *   gate 1: claim 所在 record 在 navigation_items 中(由 step 2 遍历保证)。
 *   gate 2: retrieved_detail 存在(detail 非 null)。
 *   gate 3: detail.detail_content_hash 格式 'sha256:<hex>' 且 record_version 匹配 catalog。
 *   gate 4: decision.status === 'use'。
 *   gate 5: claim ∈ decision.verified_claim_refs。
 *   gate 6: claim ∉ decision.stale_claim_refs。
 *   gate 7: decision.conflicting_evidence_refs 为空 OR 此 claim 不冲突。
 *   gate 8: decision.current_context_snapshot_id === prepared.current_context_snapshot_id。
 *   gate 9: decision.project_version_ref === prepared.project_version_ref(null===null 兼容)。
 *
 * reason mapping(规格 §7.18):
 *   - do_not_use decision → 'do_not_use'(covers conflicting evidence)
 *   - needs_refresh → 'refresh_required'
 *   - claim in stale → 'stale'
 *   - claim not in verified → 'not_in_verified_refs'
 *   - detail missing → 'detail_missing'
 *   - detail hash mismatch → 'detail_hash_mismatch'
 *   - context mismatch → 'context_mismatch'
 *   - project version mismatch → 'project_version_incompatible'
 */
export function projectVerifiedMemoryClaims(
  input: VerifiedClaimProjectionInput,
): VerifiedClaimProjectionResult {
  const prepared = input.prepared;

  // prepared.state !== 'prepared' → 空 projection
  if (prepared.state !== 'prepared') {
    const emptyResult: VerifiedClaimProjectionResult = {
      projections: [],
      omitted_claims: [],
      projection_protocol_version: VERIFIED_CLAIM_PROJECTION_PROTOCOL_VERSION,
      projection_id: computeVerifiedClaimProjectionId({
        state: prepared.state,
        projectionIds: [],
        omissionKeys: [],
        rejected: false,
      }),
      rejected_build: false,
      reject_reason_codes: [],
    };
    return freezeSnapshot(emptyResult) as VerifiedClaimProjectionResult;
  }

  // 索引:retrieved_details / memory_use_decisions 按 memory_record_id 查。
  const detailByRecord = new Map<string, RetrievedMemoryDetail>();
  for (const detail of prepared.retrieved_details) {
    detailByRecord.set(detail.memory_record_id, detail);
  }
  const decisionByRecord = new Map<string, MemoryUseDecision>();
  for (const decision of prepared.memory_use_decisions) {
    decisionByRecord.set(decision.stored_memory_ref, decision);
  }

  // catalog 索引:校验 detail.record_version 与 catalog entry 一致(gate 3)。
  const catalogEntryByRecord = new Map<string, MemoryCatalogEntry>();
  for (const entry of prepared.catalog_snapshot.entries) {
    catalogEntryByRecord.set(entry.memory_record_id, entry);
  }

  // 导航顺序确定 projection 顺序。
  const projections: VerifiedMemoryClaimProjection[] = [];
  const omissions: VerifiedClaimOmission[] = [];
  const rejectReasonCodes = new Set<string>();

  // 已投影的 identity(record_id + claim_ref)→ content_hash,用于检测 duplicate + 冲突。
  const projectedIdentityHash = new Map<string, string>();
  // 已 emit omission 的 identity,避免重复 omission
  const omittedIdentity = new Set<string>();

  for (const navItem of input.navigation_items) {
    const recordId = navItem.memory_record_id;
    const detail = detailByRecord.get(recordId) ?? null;
    const decision = decisionByRecord.get(recordId) ?? null;
    const catalogEntry = catalogEntryByRecord.get(recordId) ?? null;

    // expected claims 来源(规格 §7.6 gate 2:detail 必须先 retrieved):
    //   projection 只对 retrieved_claim_refs 中的 claim 执行九门验证。
    //   verified_claim_refs 中存在但 retrieved_claim_refs 中不存在的 claim
    //   视为"未 retrieved",不进入 projection(也不 emit omission,因为没有
    //   retrieved body 可对照)。
    //
    //   通过的 projection 在本 nav-item 内按 decision.verified_claim_refs 的
    //   稳定顺序排列(规格 §7.8 第 2 项)。
    const retrievedClaims = detail ? [...detail.retrieved_claim_refs] : [];
    const verifiedClaimsList = decision ? [...decision.verified_claim_refs] : [];
    const expectedClaims = retrievedClaims;

    // 本 nav-item 通过的 projections 缓冲,稍后按 verified_claim_refs 顺序排序后追加。
    const passedThisItem: VerifiedMemoryClaimProjection[] = [];

    // gate 2/3: detail / catalog version 校验(record-level)
    const detailHashValid =
      detail !== null &&
      SHA256_HEX_RE.test(detail.detail_content_hash) &&
      catalogEntry !== null &&
      detail.record_version === catalogEntry.record_version;

    // gate 4: decision.status
    const decisionStatus: MemoryUseDecision['status'] | null = decision?.status ?? null;

    // gate 8 / 9: context / project version
    const contextMismatch =
      decision !== null &&
      decision.current_context_snapshot_id !== prepared.current_context_snapshot_id;
    const projectVersionMismatch =
      decision !== null &&
      decision.project_version_ref !== prepared.project_version_ref;

    // stale / verified sets
    const verifiedSet = new Set<string>(decision?.verified_claim_refs ?? []);
    const staleSet = new Set<string>(decision?.stale_claim_refs ?? []);
    const hasConflicting =
      (decision?.conflicting_evidence_refs.length ?? 0) > 0;

    for (const claimRef of expectedClaims) {
      const identity = `${recordId}|${claimRef}`;

      // gate 4: status — 优先级最高(若 decision 不存在或 status 不是 use,直接走 omission)
      if (decision === null || decisionStatus === null) {
        pushOmission(omissions, omittedIdentity, identity, {
          memory_record_id: recordId,
          claim_ref: claimRef,
          reason: 'detail_missing',
        });
        continue;
      }
      if (decisionStatus === 'needs_refresh') {
        pushOmission(omissions, omittedIdentity, identity, {
          memory_record_id: recordId,
          claim_ref: claimRef,
          reason: 'refresh_required',
        });
        continue;
      }
      if (decisionStatus === 'do_not_use') {
        // do_not_use 可能由 conflicting evidence 触发 —— 反映为 'do_not_use'
        // (规格 §7.18 reason mapping:conflicting evidence → do_not_use decision)
        pushOmission(omissions, omittedIdentity, identity, {
          memory_record_id: recordId,
          claim_ref: claimRef,
          reason: 'do_not_use',
        });
        continue;
      }

      // gate 8: context
      if (contextMismatch) {
        pushOmission(omissions, omittedIdentity, identity, {
          memory_record_id: recordId,
          claim_ref: claimRef,
          reason: 'context_mismatch',
        });
        continue;
      }
      // gate 9: project version
      if (projectVersionMismatch) {
        pushOmission(omissions, omittedIdentity, identity, {
          memory_record_id: recordId,
          claim_ref: claimRef,
          reason: 'project_version_incompatible',
        });
        continue;
      }
      // gate 5: claim ∈ verified_claim_refs
      if (!verifiedSet.has(claimRef)) {
        pushOmission(omissions, omittedIdentity, identity, {
          memory_record_id: recordId,
          claim_ref: claimRef,
          reason: 'not_in_verified_refs',
        });
        continue;
      }
      // gate 6: claim ∉ stale_claim_refs
      if (staleSet.has(claimRef)) {
        pushOmission(omissions, omittedIdentity, identity, {
          memory_record_id: recordId,
          claim_ref: claimRef,
          reason: 'stale',
        });
        continue;
      }
      // gate 7: no unresolved conflicting evidence
      if (hasConflicting) {
        // decision.status === 'use' 时 conflicting 通常已被 use gate 拦为 do_not_use;
        // 但防御性:这里也检查。
        pushOmission(omissions, omittedIdentity, identity, {
          memory_record_id: recordId,
          claim_ref: claimRef,
          reason: 'conflicting_evidence',
        });
        continue;
      }
      // gate 2/3: detail hash + version
      if (detail === null) {
        pushOmission(omissions, omittedIdentity, identity, {
          memory_record_id: recordId,
          claim_ref: claimRef,
          reason: 'detail_missing',
        });
        continue;
      }
      if (!detailHashValid) {
        pushOmission(omissions, omittedIdentity, identity, {
          memory_record_id: recordId,
          claim_ref: claimRef,
          reason: 'detail_hash_mismatch',
        });
        continue;
      }

      // 九门通过 → lookup
      const lookupResult = input.claim_lookup.lookup({
        memory_record_id: recordId,
        verified_claim_ref: claimRef,
        detail_content_ref: detail.detail_content_ref,
      });
      if (lookupResult === null) {
        pushOmission(omissions, omittedIdentity, identity, {
          memory_record_id: recordId,
          claim_ref: claimRef,
          reason: 'detail_missing',
        });
        continue;
      }
      // detail.detail_content_hash 与 lookup 返回 content_hash 必须一致
      if (lookupResult.content_hash !== detail.detail_content_hash) {
        pushOmission(omissions, omittedIdentity, identity, {
          memory_record_id: recordId,
          claim_ref: claimRef,
          reason: 'detail_hash_mismatch',
        });
        continue;
      }

      // 去重(规格 §7.8 第 3 项)
      const prevHash = projectedIdentityHash.get(identity);
      if (prevHash !== undefined) {
        if (prevHash !== lookupResult.content_hash) {
          // 相同 identity 不同 hash → rejected_build=true
          rejectReasonCodes.add('verified_claim_hash_conflict');
        }
        // 已投影 → 跳过(去重)
        continue;
      }
      projectedIdentityHash.set(identity, lookupResult.content_hash);

      // 通过 → 生成 projection(暂存到 passedThisItem,稍后按 verified 顺序排序)
      passedThisItem.push({
        claim_projection_protocol_version:
          VERIFIED_CLAIM_PROJECTION_PROTOCOL_VERSION,
        claim_projection_id: computeClaimProjectionId({
          recordId,
          claimRef,
          contentHash: lookupResult.content_hash,
          retrievalId: detail.retrieval_id,
          decisionId: decision.memory_use_decision_id,
        }),
        memory_record_id: recordId,
        record_version: detail.record_version,
        retrieval_id: detail.retrieval_id,
        memory_use_decision_id: decision.memory_use_decision_id,
        current_context_snapshot_id: prepared.current_context_snapshot_id,
        project_version_ref: prepared.project_version_ref,
        verified_claim_ref: claimRef,
        content_ref: lookupResult.content_ref,
        content_hash: lookupResult.content_hash,
        provenance_refs: [...detail.provenance_refs],
        freshness_ref: detail.freshness_ref,
      });
    }

    // 按 decision.verified_claim_refs 的稳定顺序追加本 nav-item 的 projections。
    // (规格 §7.8 第 2 项:同一 record 内按 verified_claim_refs 稳定顺序;
    //  第 3 项:同一 claim 不重复投影)
    if (passedThisItem.length > 0) {
      const passedByClaim = new Map<string, VerifiedMemoryClaimProjection>();
      for (const p of passedThisItem) {
        passedByClaim.set(p.verified_claim_ref, p);
      }
      const emittedThisItem = new Set<string>();
      for (const verifiedRef of verifiedClaimsList) {
        if (emittedThisItem.has(verifiedRef)) continue;
        emittedThisItem.add(verifiedRef);
        const p = passedByClaim.get(verifiedRef);
        if (p !== undefined) {
          projections.push(p);
        }
      }
    }
  }

  const rejectedBuild = rejectReasonCodes.size > 0;
  const result: VerifiedClaimProjectionResult = {
    projections,
    omitted_claims: omissions,
    projection_protocol_version: VERIFIED_CLAIM_PROJECTION_PROTOCOL_VERSION,
    projection_id: computeVerifiedClaimProjectionId({
      state: prepared.state,
      projectionIds: projections.map((p) => p.claim_projection_id),
      omissionKeys: omissions.map(
        (o) => `${o.memory_record_id}|${o.claim_ref ?? '<null>'}|${o.reason}`,
      ),
      rejected: rejectedBuild,
    }),
    rejected_build: rejectedBuild,
    reject_reason_codes: [...rejectReasonCodes].sort(),
  };
  return freezeSnapshot(result) as VerifiedClaimProjectionResult;
}

/**
 * 安全 push 一条 omission,跳过重复 identity。
 */
function pushOmission(
  omissions: VerifiedClaimOmission[],
  omittedIdentity: Set<string>,
  identity: string,
  omission: VerifiedClaimOmission,
): void {
  if (omittedIdentity.has(identity)) return;
  omittedIdentity.add(identity);
  omissions.push(omission);
}

/**
 * 计算单条 claim projection 的内容寻址 id。
 */
function computeClaimProjectionId(fields: {
  recordId: string;
  claimRef: string;
  contentHash: string;
  retrievalId: string;
  decisionId: string;
}): string {
  const canonical = JSON.stringify({
    v: VERIFIED_CLAIM_PROJECTION_PROTOCOL_VERSION,
    record_id: fields.recordId,
    claim_ref: fields.claimRef,
    content_hash: fields.contentHash,
    retrieval_id: fields.retrievalId,
    decision_id: fields.decisionId,
  });
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `vclaim:${hash.slice(0, 16)}`;
}

/**
 * 计算 verified claim projection 整体的内容寻址 id。
 */
function computeVerifiedClaimProjectionId(fields: {
  state: MemoryEntrypointState;
  projectionIds: string[];
  omissionKeys: string[];
  rejected: boolean;
}): string {
  const canonical = JSON.stringify({
    v: VERIFIED_CLAIM_PROJECTION_PROTOCOL_VERSION,
    state: fields.state,
    projections: fields.projectionIds,
    omissions: fields.omissionKeys,
    rejected: fields.rejected,
  });
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `vclaim:${hash.slice(0, 16)}`;
}

// ===========================================================================
// §7 Task 6: buildBoundedMemoryEntrypoint (Core Anchor)
//
// 物理本质:把 T1-T5 串成固定 pipeline,组装 BoundedMemoryEntrypointSnapshot。
//
// 固定 pipeline(规格 Task 6 Step 3):
//   1. capture        — T1 captureMemoryEntrypointBuild
//   2. navigation     — T2 projectMemoryNavigation(用注入的 durability lookup)
//   3. verified claim — T3 projectVerifiedMemoryClaims(用注入的 claim lookup)
//   4. budget         — T4 applyMemoryEntrypointBudgets(三层 budget policy)
//   5. render         — T5 renderMemoryEntrypoint(approved render profile)
//   6. snapshot       — 组装 BoundedMemoryEntrypointSnapshot(深冻结)
//
// 关键不变量(规格 §7.11 / §7.12 / Task 6):
//   - 不反向修改 ERC-2:T6 只读 catalog/selection input,不读 MemoryManager。
//   - 不生成 project instruction / current-user content。
//   - pipeline 中不重新读取 catalog/selection/MemoryManager。
//   - State 映射严格遵守规格 §6.2 / §7.12 表格。
//   - entrypoint_snapshot_id 不含 created_at(时间戳只用于审计)。
//   - 输出整体经 freezeSnapshot 深冻结。
//
// State 决策表(规格 §6.2 / §7.12、Task 6 Step 4):
//   | 来源                       | 最终 state  | rendered_section_ref |
//   |T1 rejected                 | rejected    | null                 |
//   |T1 empty                    | empty       | null                 |
//   |T3 rejected_build=true      | rejected    | null                 |
//   |T4 state=rejected           | rejected    | null                 |
//   |T4 retained=[]              | empty       | null                 |
//   |T4 ready + 无 upstream omit | ready       | 非 null              |
//   |T4 partial 或 ready+omit   | partial     | 非 null              |
//   |T5 render 抛错              | rejected    | null (render.failed) |
// ===========================================================================

/**
 * 单个 entrypoint item(规格 §7.11):一个 navigation item + 其名下 retained claims
 * 一起组成一个不可分割的 entrypoint 单元。
 *
 * INV-F8:authority 永远是 'memory'(封闭值)。
 */
export interface BoundedMemoryEntrypointItem {
  entrypoint_item_protocol_version: string;
  /** 内容寻址 id:'ep-item:' + sha256(...).slice(0, 16)。 */
  entrypoint_item_id: string;
  memory_record_id: string;
  record_version: number;
  /** 对应 navigation_item_id(T2 派生:T6 用 'nav:' 前缀)。 */
  navigation_ref: string;
  /** 该 record 名下所有 retained claim 的 projection id。 */
  verified_claim_projection_refs: ReadonlyArray<string>;
  /** INV-F8 封闭值。 */
  authority: 'memory';
  trust_ref: string;
  freshness_ref: string;
  provenance_refs: ReadonlyArray<string>;
  /** 渲染后的 fragment 引用(由 T5/T4 render 产生)。 */
  item_content_ref: string;
  /** sha256(item_content) —— 64-hex(T6 派生,确定性)。 */
  item_content_hash: string;
  bytes_included: number;
  lines_included: number;
  estimated_tokens: number | null;
  token_estimator_ref: string | null;
}

/**
 * 最终的 entrypoint snapshot(规格 §7.12):把整条 pipeline 的输出汇总为一个
 * 内容寻址、深冻结、不可变的输出。
 *
 * - rendered_section_ref:ready/partial 非 null;empty/rejected 为 null。
 * - entrypoint_snapshot_id:基于 canonical payload(不含 created_at)的 sha256。
 */
export interface BoundedMemoryEntrypointSnapshot {
  entrypoint_protocol_version: string;
  /** 内容寻址 id:'ep-snap:' + sha256(canonical).slice(0, 16)。 */
  entrypoint_snapshot_id: string;
  /** 来自 build input 的 build_id。 */
  build_id: string;
  state: MemoryEntrypointState;
  task_snapshot_id: string;
  current_context_snapshot_id: string;
  project_version_ref: string | null;
  catalog_snapshot_id: string;
  selection_id: string;
  policy_ref: WaveFContractRef;
  request_budget_snapshot_id: string;
  render_profile_ref: string;
  navigation_item_refs: ReadonlyArray<string>;
  verified_claim_projection_refs: ReadonlyArray<string>;
  item_refs: ReadonlyArray<string>;
  /** 透传的 use decision id 序列(用于下游 traceability)。 */
  memory_use_decision_refs: ReadonlyArray<string>;
  overflow_manifest_ref: string;
  provenance_manifest_ref: string;
  /** ready/partial 非 null;empty/rejected null。 */
  rendered_section_ref: string | null;
  rendered_section_hash: string | null;
  bytes_included: number;
  lines_included: number;
  estimated_tokens: number | null;
  token_estimator_ref: string | null;
  /** ISO timestamp;仅用于审计,不进入 entrypoint_snapshot_id。 */
  created_at: string;
  reason_codes: ReadonlyArray<string>;
}

/**
 * 三层 budget policy wrapper(T1 的 MemoryEntrypointPolicy 只携带 ref,
 * T6 需要把实际 policy 对象传给 T4)。
 */
export interface BoundedMemoryEntrypointBudgetPolicies {
  navigation_budget_policy: NavigationBudgetPolicy;
  verified_detail_budget_policy: VerifiedDetailBudgetPolicy;
  total_section_budget_policy: TotalSectionBudgetPolicy;
}

/**
 * Core Anchor 依赖注入(规格 §7.11)。
 *
 * 关键:T6 不持有 MemoryManager 引用 —— 这是结构保证(INV-F10)。
 * T6 只通过 durability_evidence_ref_for 和 claim_lookup 这两个注入的纯函数
 * 与外部 Memory 系统交互。这两个函数的实际实现由调用方(T9 Activation Gate)
 * 提供,T6 不知道它们背后是否读 Memory。
 */
export interface BoundedMemoryEntrypointDependencies {
  /** T2 用:对每条 catalog entry 返回 durability 证据引用;null 表示该 entry 无证据。 */
  durability_evidence_ref_for: (
    catalog_entry: MemoryCatalogEntry,
  ) => string | null;
  /** T3 用:确定性 claim content lookup。 */
  claim_lookup: VerifiedClaimContentLookup;
  /** T4 用:三层 budget policies + overflow behavior。 */
  budget_policies: BoundedMemoryEntrypointBudgetPolicies;
  overflow_behavior: BudgetOverflowBehavior;
  /** T5 用:approved render profile。 */
  render_profile: RenderProfileAsset;
  /** T4 可选:token estimator。 */
  estimator: TokenEstimator | null;
  /** 可选:trust_ref 来源(默认派生为 'trust:memory:<record_id>')。 */
  trust_ref_for?: (memory_record_id: string) => string;
  /** 可选:freshness_ref 来源(默认派生自 detail.freshness_ref)。 */
  freshness_ref_for?: (memory_record_id: string) => string;
}

// ---------------------------------------------------------------------------
// Internal helpers — adapter / canonical / state mapping
// ---------------------------------------------------------------------------

/** 共用 sha256 hex helper(本地)。 */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * 把 T2 MemoryNavigationItem 适配为 T4 BudgetNavigationItem。
 *
 * 类型层面:MemoryNavigationItem 是 BudgetNavigationItem 的结构子集
 * (BudgetNavigationItem 有 [key: string]: unknown 索引签名)。
 * 因此 TS 结构化类型允许直接传递。本函数只做最小拷贝,保留所有字段。
 */
function adaptNavigationItemForBudget(
  item: MemoryNavigationItem,
): BudgetNavigationItem {
  return {
    memory_record_id: item.memory_record_id,
    record_version: item.record_version,
    selection_rank: item.selection_rank,
    memory_type: item.memory_type,
    scope_ref: item.scope_ref,
    topic_key_refs: item.topic_key_refs,
    keyword_key_refs: item.keyword_key_refs,
    observed_at: item.observed_at,
    expires_at: item.expires_at,
    detail_content_hash: item.detail_content_hash,
    provenance_refs: item.provenance_refs,
    durability_evidence_ref: item.durability_evidence_ref,
  };
}

/**
 * 把 T3 VerifiedMemoryClaimProjection 适配为 T4 BudgetVerifiedClaim。
 *
 * 结构兼容:VerifiedMemoryClaimProjection 含有 BudgetVerifiedClaim 所有必需字段。
 */
function adaptClaimForBudget(
  claim: VerifiedMemoryClaimProjection,
): BudgetVerifiedClaim {
  return {
    claim_projection_id: claim.claim_projection_id,
    memory_record_id: claim.memory_record_id,
    record_version: claim.record_version,
    retrieval_id: claim.retrieval_id,
    memory_use_decision_id: claim.memory_use_decision_id,
    current_context_snapshot_id: claim.current_context_snapshot_id,
    project_version_ref: claim.project_version_ref,
    verified_claim_ref: claim.verified_claim_ref,
    content_ref: claim.content_ref,
    content_hash: claim.content_hash,
    provenance_refs: claim.provenance_refs,
    freshness_ref: claim.freshness_ref,
  };
}

/**
 * 把 T4 BudgetedNavigationItem 适配为 T5 RenderNavigationItem。
 *
 * T5 RenderNavigationItem 不含 rendered_fragment / measurement / [key: string]。
 * 本函数提取 T5 所需的字段子集。
 */
function adaptBudgetedNavForRender(
  item: BudgetedNavigationItem,
): RenderNavigationItem {
  return {
    memory_record_id: item.memory_record_id,
    record_version: item.record_version,
    selection_rank: item.selection_rank,
    memory_type: item.memory_type,
    scope_ref: item.scope_ref,
    topic_key_refs: item.topic_key_refs,
    keyword_key_refs: item.keyword_key_refs,
    observed_at: item.observed_at,
    expires_at: item.expires_at,
    detail_content_hash: item.detail_content_hash,
    provenance_refs: item.provenance_refs,
    durability_evidence_ref: item.durability_evidence_ref,
  };
}

/**
 * 把 T4 BudgetedVerifiedClaim 适配为 T5 RenderVerifiedClaim。
 */
function adaptBudgetedClaimForRender(
  claim: BudgetedVerifiedClaim,
): RenderVerifiedClaim {
  return {
    claim_projection_id: claim.claim_projection_id,
    memory_record_id: claim.memory_record_id,
    record_version: claim.record_version,
    retrieval_id: claim.retrieval_id,
    memory_use_decision_id: claim.memory_use_decision_id,
    current_context_snapshot_id: claim.current_context_snapshot_id,
    project_version_ref: claim.project_version_ref,
    verified_claim_ref: claim.verified_claim_ref,
    content_ref: claim.content_ref,
    content_hash: claim.content_hash,
    provenance_refs: claim.provenance_refs,
    freshness_ref: claim.freshness_ref,
  };
}

/**
 * 把 T2 navigation omission 转成 T4 OmittedNavigationRecord。
 *
 * T2 reason 是 NavigationOmissionReason,T4 需要 MemoryEntrypointOmissionReason。
 * 名字一致(scope_excluded / type_excluded / durability_unverified / not_selected)。
 */
function adaptNavOmissionForBudget(
  omission: NavigationOmission,
): OmittedNavigationRecord | null {
  if (omission.memory_record_id === null) return null;
  return {
    memory_record_id: omission.memory_record_id,
    reason_codes: [omission.reason],
  };
}

/**
 * 把 T3 claim omission 转成 T4 OmittedClaimRef。
 *
 * T3 的 VerifiedClaimOmissionReason 与 T4 的 MemoryEntrypointOmissionReason
 * 不是同一枚举,但有重叠。映射规则(规格 §7.18 reason mapping):
 *   - detail_missing / detail_hash_mismatch / refresh_required / stale /
 *     conflicting_evidence — 同名直传。
 *   - do_not_use → use_denied(T4 中"使用被拒绝"的统一 reason)。
 *   - not_in_verified_refs / context_mismatch / project_version_incompatible /
 *     duplicate_identity — T4 无对应枚举,统一映射到 use_denied(它们都表示
 *     "此 claim 不能在当前 context 使用")。
 */
function adaptClaimOmissionForBudget(
  omission: VerifiedClaimOmission,
): OmittedClaimRef | null {
  if (omission.claim_ref === null) return null;
  const mappedReason: MemoryEntrypointOmissionReason =
    mapVerifiedClaimOmissionReason(omission.reason);
  return {
    memory_record_id: omission.memory_record_id,
    claim_ref: omission.claim_ref,
    reason_codes: [mappedReason],
  };
}

/**
 * VerifiedClaimOmissionReason → MemoryEntrypointOmissionReason 映射。
 * 见 adaptClaimOmissionForBudget 的注释。
 */
function mapVerifiedClaimOmissionReason(
  reason: VerifiedClaimOmissionReason,
): MemoryEntrypointOmissionReason {
  switch (reason) {
    case 'detail_missing':
    case 'detail_hash_mismatch':
    case 'refresh_required':
    case 'stale':
    case 'conflicting_evidence':
      // 同名直传(两个枚举都包含这些值)
      return reason;
    case 'do_not_use':
    case 'not_in_verified_refs':
    case 'context_mismatch':
    case 'project_version_incompatible':
    case 'duplicate_identity':
      // T4 无对应枚举,统一映射到 use_denied(都表示此 claim 当前不可使用)
      return 'use_denied';
  }
}

/**
 * 计算 entrypoint_item_id(规格 Task 6 Step 5)。
 * canonical 覆盖:protocol + record_id + record_version + nav_ref + claim refs。
 */
function computeEntrypointItemId(fields: {
  memory_record_id: string;
  record_version: number;
  navigation_ref: string;
  verified_claim_projection_refs: ReadonlyArray<string>;
}): string {
  const canonical = JSON.stringify({
    v: ENTRYPOINT_ITEM_PROTOCOL_VERSION,
    memory_record_id: fields.memory_record_id,
    record_version: fields.record_version,
    navigation_ref: fields.navigation_ref,
    verified_claim_projection_refs: fields.verified_claim_projection_refs,
  });
  const hash = sha256Hex(canonical);
  return `ep-item:${hash.slice(0, 16)}`;
}

/**
 * 计算 entrypoint_snapshot_id(规格 Task 6 Step 5)。
 *
 * canonical 覆盖:protocol + 所有上游 identity ref + 有序 item refs +
 * overflow_manifest_ref + provenance_manifest_ref + rendered_section content_hash
 * (ready/partial 时)。
 *
 * 不含 created_at(时间戳,只用于审计)。
 */
function computeEntrypointSnapshotId(fields: {
  build_id: string;
  task_snapshot_id: string;
  current_context_snapshot_id: string;
  project_version_ref: string | null;
  catalog_snapshot_id: string;
  selection_id: string;
  policy_ref: WaveFContractRef;
  request_budget_snapshot_id: string;
  render_profile_ref: string;
  navigation_item_refs: ReadonlyArray<string>;
  verified_claim_projection_refs: ReadonlyArray<string>;
  item_refs: ReadonlyArray<string>;
  memory_use_decision_refs: ReadonlyArray<string>;
  overflow_manifest_ref: string;
  provenance_manifest_ref: string;
  state: MemoryEntrypointState;
  rendered_section_hash: string | null;
}): string {
  const canonical = JSON.stringify({
    v: ENTRYPOINT_PROTOCOL_VERSION,
    state: fields.state,
    build_id: fields.build_id,
    task_snapshot_id: fields.task_snapshot_id,
    current_context_snapshot_id: fields.current_context_snapshot_id,
    project_version_ref: fields.project_version_ref,
    catalog_snapshot_id: fields.catalog_snapshot_id,
    selection_id: fields.selection_id,
    policy_ref: fields.policy_ref,
    request_budget_snapshot_id: fields.request_budget_snapshot_id,
    render_profile_ref: fields.render_profile_ref,
    navigation_item_refs: fields.navigation_item_refs,
    verified_claim_projection_refs: fields.verified_claim_projection_refs,
    item_refs: fields.item_refs,
    memory_use_decision_refs: fields.memory_use_decision_refs,
    overflow_manifest_ref: fields.overflow_manifest_ref,
    provenance_manifest_ref: fields.provenance_manifest_ref,
    rendered_section_hash: fields.rendered_section_hash,
  });
  const hash = sha256Hex(canonical);
  return `ep-snap:${hash.slice(0, 16)}`;
}

/**
 * 计算 provenance_manifest_ref:把所有 retained items 的 provenance_refs 汇总,
 * 加上 task/context/project identity,sha256 后以 'provenance:' 为前缀。
 *
 * 这是 T6 自有的 provenance manifest(T5 已有 section-level provenance,
 * T6 在 snapshot 层再加一层覆盖所有 items 的 manifest ref,便于审计)。
 */
function computeProvenanceManifestRef(fields: {
  build_id: string;
  task_snapshot_id: string;
  current_context_snapshot_id: string;
  project_version_ref: string | null;
  items: ReadonlyArray<{
    memory_record_id: string;
    provenance_refs: ReadonlyArray<string>;
  }>;
}): string {
  const lines: string[] = [
    `build:${fields.build_id}`,
    `task:${fields.task_snapshot_id}`,
    `ctx:${fields.current_context_snapshot_id}`,
    `project:${fields.project_version_ref ?? ''}`,
  ];
  for (const item of fields.items) {
    for (const ref of item.provenance_refs) {
      lines.push(`item:${item.memory_record_id}:${ref}`);
    }
  }
  const canonical = lines.join('\n');
  const hash = sha256Hex(canonical);
  return `provenance:${hash}`;
}

/**
 * 构造一个 terminal-state(rejected/empty)snapshot。
 * 这两个 state 都不进入 T5 render,所以 rendered_section_ref=null。
 */
function buildTerminalSnapshot(
  input: MemoryEntrypointBuildInput,
  state: 'rejected' | 'empty',
  reasonCodes: ReadonlyArray<string>,
  prepared: PreparedMemoryEntrypointBuild,
): BoundedMemoryEntrypointSnapshot {
  // 即使 terminal state,也要计算 overflow_manifest_ref / provenance_manifest_ref。
  // 这里用 empty manifest(无 omissions)+ 空 items manifest。
  // 注意:T6 跳过 T4/T5 时,没有 manifest 对象;我们用确定性派生 ref。
  const emptyOverflowManifestRef = `overflow:${sha256Hex(`empty:${state}:${prepared.build_id}`)}`;
  const emptyProvenanceManifestRef = computeProvenanceManifestRef({
    build_id: prepared.build_id,
    task_snapshot_id: prepared.task_snapshot_id,
    current_context_snapshot_id: prepared.current_context_snapshot_id,
    project_version_ref: prepared.project_version_ref,
    items: [],
  });

  const snapshot: BoundedMemoryEntrypointSnapshot = {
    entrypoint_protocol_version: ENTRYPOINT_PROTOCOL_VERSION,
    entrypoint_snapshot_id: '', // 占位;下面计算
    build_id: prepared.build_id,
    state,
    task_snapshot_id: prepared.task_snapshot_id,
    current_context_snapshot_id: prepared.current_context_snapshot_id,
    project_version_ref: prepared.project_version_ref,
    catalog_snapshot_id: input.catalog_snapshot.catalog_snapshot_id,
    selection_id: input.selection_result.selection_id,
    policy_ref: input.policy_ref,
    request_budget_snapshot_id: input.request_budget_snapshot_id,
    render_profile_ref: input.render_profile_ref,
    navigation_item_refs: [],
    verified_claim_projection_refs: [],
    item_refs: [],
    memory_use_decision_refs: input.memory_use_decisions.map(
      (d) => d.memory_use_decision_id,
    ),
    overflow_manifest_ref: emptyOverflowManifestRef,
    provenance_manifest_ref: emptyProvenanceManifestRef,
    rendered_section_ref: null,
    rendered_section_hash: null,
    bytes_included: 0,
    lines_included: 0,
    estimated_tokens: null,
    token_estimator_ref: null,
    created_at: new Date().toISOString(),
    reason_codes: reasonCodes,
  };

  snapshot.entrypoint_snapshot_id = computeEntrypointSnapshotId({
    build_id: snapshot.build_id,
    task_snapshot_id: snapshot.task_snapshot_id,
    current_context_snapshot_id: snapshot.current_context_snapshot_id,
    project_version_ref: snapshot.project_version_ref,
    catalog_snapshot_id: snapshot.catalog_snapshot_id,
    selection_id: snapshot.selection_id,
    policy_ref: snapshot.policy_ref,
    request_budget_snapshot_id: snapshot.request_budget_snapshot_id,
    render_profile_ref: snapshot.render_profile_ref,
    navigation_item_refs: snapshot.navigation_item_refs,
    verified_claim_projection_refs: snapshot.verified_claim_projection_refs,
    item_refs: snapshot.item_refs,
    memory_use_decision_refs: snapshot.memory_use_decision_refs,
    overflow_manifest_ref: snapshot.overflow_manifest_ref,
    provenance_manifest_ref: snapshot.provenance_manifest_ref,
    state: snapshot.state,
    rendered_section_hash: snapshot.rendered_section_hash,
  });

  return freezeSnapshot(snapshot) as BoundedMemoryEntrypointSnapshot;
}

// ---------------------------------------------------------------------------
// Public API — buildBoundedMemoryEntrypoint
// ---------------------------------------------------------------------------

/**
 * FRC-1 Task 6 Core Anchor:把 T1-T5 串成固定 pipeline,组装最终的
 * BoundedMemoryEntrypointSnapshot。
 *
 * 固定 pipeline(规格 Task 6 Step 3):
 *   1. capture        — T1 captureMemoryEntrypointBuild
 *   2. (rejected/empty 早返)
 *   3. navigation     — T2 projectMemoryNavigation(用注入的 durability lookup)
 *   4. verified claim — T3 projectVerifiedMemoryClaims(用注入的 claim lookup)
 *   5. (rejected_build 早返)
 *   6. budget         — T4 applyMemoryEntrypointBudgets(三层 budget policy)
 *   7. (rejected/empty after budget 早返)
 *   8. render         — T5 renderMemoryEntrypoint(approved render profile)
 *      (render 抛错 → rejected)
 *   9. snapshot       — 组装 BoundedMemoryEntrypointSnapshot(深冻结)
 *
 * 这个函数 *不* 做的事(规格 §7.11 / §8 / Task 6):
 *   - 不调用 MemoryManager / selectByKeywords / inject / write / read。
 *   - 不重新读取 catalog / selection / use decision(pipeline 中一次性捕获)。
 *   - 不修改 catalog / selection / use decision(只读消费)。
 *   - 不在 failure 时回退为"加载全部 Memory"(INV-F10)。
 *   - 不生成 project instruction / current-user content。
 *   - 不实现 cache(那是 Task 7 范围)。
 *
 * @param build_input    T1 的 input(catalog/selection/details/decisions/policy)
 * @param dependencies   T2/T3/T4/T5 所需的注入(durability/claim_lookup/budget_policies/
 *                       overflow_behavior/render_profile/estimator)
 */
export function buildBoundedMemoryEntrypoint(
  build_input: MemoryEntrypointBuildInput,
  dependencies: BoundedMemoryEntrypointDependencies,
): BoundedMemoryEntrypointSnapshot {
  // ─── Step 1: T1 capture ───────────────────────────────────────────
  // capture 阶段做 identity / policy / catalog / selection / details / decisions
  // 的一致性校验,并冻结 prepared build。
  const prepared = captureMemoryEntrypointBuild(build_input);

  // ─── Step 2: T1 早返分支 ──────────────────────────────────────────
  if (prepared.state === 'rejected') {
    return buildTerminalSnapshot(
      build_input,
      'rejected',
      prepared.reason_codes,
      prepared,
    );
  }
  if (prepared.state === 'empty') {
    return buildTerminalSnapshot(
      build_input,
      'empty',
      prepared.reason_codes,
      prepared,
    );
  }
  // 此时 prepared.state === 'prepared'

  // ─── Step 3: T2 navigation projection ─────────────────────────────
  const navResult = projectMemoryNavigation({
    prepared,
    durability_evidence_ref_for: dependencies.durability_evidence_ref_for,
  });

  // ─── Step 4: T3 verified claim projection ─────────────────────────
  const claimResult = projectVerifiedMemoryClaims({
    prepared,
    navigation_items: navResult.items,
    claim_lookup: dependencies.claim_lookup,
  });

  // T3 rejected_build=true → 整体 rejected
  if (claimResult.rejected_build) {
    return buildTerminalSnapshot(
      build_input,
      'rejected',
      claimResult.reject_reason_codes,
      prepared,
    );
  }

  // ─── Step 5: 准备 T4 输入(适配类型) ──────────────────────────────
  // eligible_navigation / eligible_claims:T2/T3 输出 → T4 working type
  const eligibleNavigation: BudgetNavigationItem[] = navResult.items.map(
    adaptNavigationItemForBudget,
  );
  const eligibleClaims: BudgetVerifiedClaim[] = claimResult.projections.map(
    adaptClaimForBudget,
  );

  // upstream omissions:T2 nav omissions + T3 claim omissions → T4 透传
  const upstreamNavigationOmissions: OmittedNavigationRecord[] = [];
  for (const om of navResult.omissions) {
    const adapted = adaptNavOmissionForBudget(om);
    if (adapted !== null) {
      upstreamNavigationOmissions.push(adapted);
    }
  }
  const upstreamClaimOmissions: OmittedClaimRef[] = [];
  for (const om of claimResult.omitted_claims) {
    const adapted = adaptClaimOmissionForBudget(om);
    if (adapted !== null) {
      upstreamClaimOmissions.push(adapted);
    }
  }

  // renderer:T6 用 T5 的 createRendererAdaptor 把 render_profile 闭包进去,
  // 保证 T4 的 fragment 计量与最终 T5 render 字节级一致。
  const renderer: MemoryBudgetFragmentRenderer = createRendererAdaptor(
    dependencies.render_profile,
  );

  // ─── Step 6: T4 budget ────────────────────────────────────────────
  const t4Input: ApplyMemoryEntrypointBudgetsInput = {
    eligible_navigation: eligibleNavigation,
    eligible_claims: eligibleClaims,
    upstream_navigation_omissions: upstreamNavigationOmissions,
    upstream_claim_omissions: upstreamClaimOmissions,
    navigation_budget_policy:
      dependencies.budget_policies.navigation_budget_policy,
    verified_detail_budget_policy:
      dependencies.budget_policies.verified_detail_budget_policy,
    total_section_budget_policy:
      dependencies.budget_policies.total_section_budget_policy,
    overflow_behavior: dependencies.overflow_behavior,
    renderer,
    estimator: dependencies.estimator,
  };

  const budgeted: BudgetedMemoryEntrypoint =
    applyMemoryEntrypointBudgets(t4Input);

  // ─── Step 7: T4 早返分支 ──────────────────────────────────────────
  // 状态映射(规格 §6.2 / §7.12 + Task 6 Step 4):
  //   1. T4 state='rejected' 时,区分两种情况:
  //      a. 真 rejected(budget reject 模式触发,overflow_behavior='reject' +
  //         任意 budget 超限)→ 最终 'rejected'。
  //      b. "无内容" rejected(T4 把 retained=[] 也标 rejected,但所有 omissions
  //         都是上游透传,无任何 budget_*_limit)→ 最终 'empty'。
  //         这是规格 §7.17 的合法 empty trigger:"所有候选记录均被排除
  //         (scope/type/durability)"。规格 Task 6 Step 4 明确:
  //         "T4 retained_navigation=[] 且 retained_claims=[] → empty"。
  //   2. T4 state='ready'/'partial' 但 retained=[] → 'empty'(同上)。
  //
  // 实现细节:用 overflow_manifest 的 navigation_overflowed /
  // verified_detail_overflowed / total_budget_overflowed 标志位 + overflow_behavior
  // 区分真 rejected 与"无内容" rejected。
  const isRealBudgetReject =
    budgeted.state === 'rejected' &&
    dependencies.overflow_behavior === 'reject' &&
    (budgeted.overflow_manifest.navigation_overflowed ||
      budgeted.overflow_manifest.verified_detail_overflowed ||
      budgeted.overflow_manifest.total_budget_overflowed);

  if (isRealBudgetReject) {
    return buildTerminalSnapshot(
      build_input,
      'rejected',
      budgeted.reason_codes,
      prepared,
    );
  }
  if (
    budgeted.retained_navigation.length === 0 &&
    budgeted.retained_claims.length === 0
  ) {
    // T4 retained=[] 且不是真 budget reject → empty(规格 §7.17 + Task 6 Step 4)
    return buildTerminalSnapshot(
      build_input,
      'empty',
      budgeted.reason_codes.length > 0
        ? budgeted.reason_codes
        : ['budget.empty_retained'],
      prepared,
    );
  }

  // ─── Step 8: T5 render(可能抛错) ─────────────────────────────────
  // 把 T4 输出适配成 T5 输入类型
  const renderNavigationItems: RenderNavigationItem[] =
    budgeted.retained_navigation.map(adaptBudgetedNavForRender);
  const renderVerifiedClaims: RenderVerifiedClaim[] =
    budgeted.retained_claims.map(adaptBudgetedClaimForRender);

  // overflow_marker:基于 T4 overflow_manifest
  const overflowManifest = budgeted.overflow_manifest;
  const overflowMarker: RenderOverflowMarker = {
    truncated: overflowManifest.truncated,
    overflow_manifest_ref: overflowManifest.truncated
      ? overflowManifest.overflow_manifest_id
      : null,
    omitted_navigation_count: overflowManifest.omitted_records.length,
    omitted_claim_count: overflowManifest.omitted_claim_refs.length,
  };

  const t5Input: RenderMemoryEntrypointInput = {
    render_protocol_version: RENDER_PROTOCOL_VERSION,
    render_id: `render:${build_input.build_id}`,
    render_profile: dependencies.render_profile,
    navigation_items: renderNavigationItems,
    verified_claims: renderVerifiedClaims,
    overflow_marker: overflowMarker,
    task_snapshot_id: prepared.task_snapshot_id,
    current_context_snapshot_id: prepared.current_context_snapshot_id,
    project_version_ref: prepared.project_version_ref,
  };

  let rendered: RenderedMemorySection;
  try {
    rendered = renderMemoryEntrypoint(t5Input);
  } catch {
    // render 抛错(不应发生,但防御)→ rejected with render.failed reason
    // 不回退 full-load(INV-F10)。
    return buildTerminalSnapshot(
      build_input,
      'rejected',
      ['render.failed'],
      prepared,
    );
  }

  // ─── Step 9: 决定最终 state(规格 §6.2 / §7.12) ────────────────────
  // - T4 ready + 无 upstream omission → ready
  // - T4 partial OR (ready + 有 upstream/budget omission) → partial
  const hasUpstreamOmission =
    upstreamNavigationOmissions.length > 0 ||
    upstreamClaimOmissions.length > 0;
  const hasBudgetOmission =
    budgeted.overflow_manifest.omitted_records.length > 0 ||
    budgeted.overflow_manifest.omitted_claim_refs.length > 0;

  let finalState: 'ready' | 'partial';
  if (budgeted.state === 'partial') {
    finalState = 'partial';
  } else if (hasUpstreamOmission || hasBudgetOmission) {
    finalState = 'partial';
  } else {
    finalState = 'ready';
  }

  // ─── Step 10: 组装 BoundedMemoryEntrypointItem 列表 ────────────────
  // 一个 item = 一个 navigation record + 其名下 retained claims。
  // 把 retained_claims 按 memory_record_id 分组。
  const claimsByRecord = new Map<string, BudgetedVerifiedClaim[]>();
  for (const c of budgeted.retained_claims) {
    const arr = claimsByRecord.get(c.memory_record_id);
    if (arr === undefined) {
      claimsByRecord.set(c.memory_record_id, [c]);
    } else {
      arr.push(c);
    }
  }

  // 收集所有 retained claim 的 projection id(整体顺序 = T4 retained_claims 顺序)
  const verifiedClaimProjectionRefs: string[] = budgeted.retained_claims.map(
    (c) => c.claim_projection_id,
  );

  // 为每个 retained nav 组装 item
  const navigationItemRefs: string[] = [];
  const itemRefs: string[] = [];

  // 累计 bytes/lines/tokens
  let totalBytes = 0;
  let totalLines = 0;
  let totalTokens: number | null = dependencies.estimator !== null ? 0 : null;

  // 收集所有 item 的 provenance_refs(用于 provenance manifest)
  const itemProvenanceAggregator: Array<{
    memory_record_id: string;
    provenance_refs: ReadonlyArray<string>;
  }> = [];

  for (const navItem of budgeted.retained_navigation) {
    const recordId = navItem.memory_record_id;
    const recordClaims = claimsByRecord.get(recordId) ?? [];
    const claimProjectionIds = recordClaims.map((c) => c.claim_projection_id);

    // navigation_ref:从 navItem 派生确定性 'nav:' 前缀 id
    const navigationRef = `nav:${sha256Hex(`${recordId}:${navItem.record_version}`).slice(0, 16)}`;

    // 累加计量(nav fragment + 本 record 名下所有 claim fragment)
    const itemBytes =
      navItem.measurement.bytes +
      recordClaims.reduce((sum, c) => sum + c.measurement.bytes, 0);
    const itemLines =
      navItem.measurement.lines +
      recordClaims.reduce((sum, c) => sum + c.measurement.lines, 0);
    const itemTokens =
      dependencies.estimator !== null
        ? (navItem.measurement.estimated_tokens ?? 0) +
          recordClaims.reduce(
            (sum, c) => sum + (c.measurement.estimated_tokens ?? 0),
            0,
          )
        : null;

    totalBytes += itemBytes;
    totalLines += itemLines;
    if (totalTokens !== null && itemTokens !== null) {
      totalTokens += itemTokens;
    }

    const itemId = computeEntrypointItemId({
      memory_record_id: recordId,
      record_version: navItem.record_version,
      navigation_ref: navigationRef,
      verified_claim_projection_refs: claimProjectionIds,
    });

    // 收集本 item 的所有 provenance_refs(nav + claims)
    const itemProvenanceRefs: string[] = [
      ...navItem.provenance_refs,
      ...recordClaims.flatMap((c) => c.provenance_refs),
    ];
    itemProvenanceAggregator.push({
      memory_record_id: recordId,
      provenance_refs: itemProvenanceRefs,
    });

    // 注:完整 BoundedMemoryEntrypointItem 对象的构造(nav_ref/claim_refs/
    // trust_ref/freshness_ref/item_content_ref/item_content_hash 等)在需要
    // traceability 时启用。当前 snapshot 只携带 item_refs(规格 §7.12),
    // 因此这里只收集 id + 累加计量。
    itemRefs.push(itemId);
    navigationItemRefs.push(navigationRef);
  }

  // ─── Step 11: 计算 manifest refs ──────────────────────────────────
  const overflowManifestRef = overflowManifest.overflow_manifest_id;
  const provenanceManifestRef = computeProvenanceManifestRef({
    build_id: prepared.build_id,
    task_snapshot_id: prepared.task_snapshot_id,
    current_context_snapshot_id: prepared.current_context_snapshot_id,
    project_version_ref: prepared.project_version_ref,
    items: itemProvenanceAggregator,
  });

  // rendered_section_ref:基于 content_hash(T5 已计算)
  const renderedSectionRef = `render:${rendered.content_hash.slice(0, 16)}`;
  const renderedSectionHash = rendered.content_hash;

  // reason_codes:合并 T4 budget reasons(已含上游透传 reason)
  const reasonSet = new Set<string>();
  for (const rc of budgeted.reason_codes) reasonSet.add(rc);
  const reasonCodes = Array.from(reasonSet).sort();

  // use_decision_refs:透传 input 的 use decision id
  const useDecisionRefs = build_input.memory_use_decisions.map(
    (d) => d.memory_use_decision_id,
  );

  // ─── Step 12: 组装 + 计算 entrypoint_snapshot_id ──────────────────
  const estimatorRef = dependencies.estimator
    ? `${dependencies.estimator.estimator_id}:${dependencies.estimator.estimator_version}`
    : null;

  const snapshot: BoundedMemoryEntrypointSnapshot = {
    entrypoint_protocol_version: ENTRYPOINT_PROTOCOL_VERSION,
    entrypoint_snapshot_id: '', // 占位;下面计算
    build_id: prepared.build_id,
    state: finalState,
    task_snapshot_id: prepared.task_snapshot_id,
    current_context_snapshot_id: prepared.current_context_snapshot_id,
    project_version_ref: prepared.project_version_ref,
    catalog_snapshot_id: build_input.catalog_snapshot.catalog_snapshot_id,
    selection_id: build_input.selection_result.selection_id,
    policy_ref: build_input.policy_ref,
    request_budget_snapshot_id: build_input.request_budget_snapshot_id,
    render_profile_ref: build_input.render_profile_ref,
    navigation_item_refs: navigationItemRefs,
    verified_claim_projection_refs: verifiedClaimProjectionRefs,
    item_refs: itemRefs,
    memory_use_decision_refs: useDecisionRefs,
    overflow_manifest_ref: overflowManifestRef,
    provenance_manifest_ref: provenanceManifestRef,
    rendered_section_ref: renderedSectionRef,
    rendered_section_hash: renderedSectionHash,
    bytes_included: totalBytes,
    lines_included: totalLines,
    estimated_tokens: totalTokens,
    token_estimator_ref: estimatorRef,
    created_at: new Date().toISOString(),
    reason_codes: reasonCodes,
  };

  // 计算 entrypoint_snapshot_id(不含 created_at)
  snapshot.entrypoint_snapshot_id = computeEntrypointSnapshotId({
    build_id: snapshot.build_id,
    task_snapshot_id: snapshot.task_snapshot_id,
    current_context_snapshot_id: snapshot.current_context_snapshot_id,
    project_version_ref: snapshot.project_version_ref,
    catalog_snapshot_id: snapshot.catalog_snapshot_id,
    selection_id: snapshot.selection_id,
    policy_ref: snapshot.policy_ref,
    request_budget_snapshot_id: snapshot.request_budget_snapshot_id,
    render_profile_ref: snapshot.render_profile_ref,
    navigation_item_refs: snapshot.navigation_item_refs,
    verified_claim_projection_refs: snapshot.verified_claim_projection_refs,
    item_refs: snapshot.item_refs,
    memory_use_decision_refs: snapshot.memory_use_decision_refs,
    overflow_manifest_ref: snapshot.overflow_manifest_ref,
    provenance_manifest_ref: snapshot.provenance_manifest_ref,
    state: snapshot.state,
    rendered_section_hash: snapshot.rendered_section_hash,
  });

  return freezeSnapshot(snapshot) as BoundedMemoryEntrypointSnapshot;
}

// ===========================================================================
// §8 Task 9: Activation Gate(规格 §7.19 十二门 AND gate)
//
// 物理本质:在任何调用方把 Memory section 编入 prompt 之前,必须确认本次 request 的
// 全链路(从 catalog snapshot 到 compiler section metadata)满足规格 §7.19 的 12 项
// ".activation evidence"。任一缺失 → active=false,不允许编入。
//
// 这个 gate 是**纯证据验证**:它不调用 build/cache/render,只读取调用方提供的 12 项
// 布尔证据。证据本身的获取由调用方负责(通常来自上游 runtime/config 的 introspection)。
//
// 关键不变量(规格 §7.19 + §8):
//   - 12 门 AND gate,任一缺失即 inactive(不允许"近似 active")
//   - reason_codes 必须可程序化枚举:`memory_entrypoint.gate_missing.<field>`
//   - 数值上下文不入 code,只入 diagnostic metadata
//   - activation 函数本身 side-effect free(不调用 build/cache)
// ===========================================================================

/**
 * Activation 协议版本号(规格 §7.19)。
 * 独立于 entrypoint_protocol_version / handoff_protocol_version,允许 activation
 * schema 演进而无需重建 snapshot。
 */
export const MEMORY_ACTIVATION_PROTOCOL_VERSION = 'mi.memory.activation/1';

/**
 * 12 门证据(规格 §7.19.1–§7.19.12)。
 *
 * 调用方按 §7.19 的 12 项要求逐项检查并填充。
 * 任一为 false → active=false。
 *
 * 注:本字段集合按 §7.19 的"12 项要求"归并(每项要求可能对应多个物理校验)。
 * 例如 §7.19.1 "immutable, hash-valid catalog" 合并为单一字段
 * `catalog_immutable_and_hash_valid`(同时覆盖 immutable + hash valid)。
 */
export interface BoundedMemoryActivationEvidence {
  // 12 门(§7.19.1–§7.19.12)
  /** §7.19.1: catalog snapshot immutable 且 hash valid */
  catalog_immutable_and_hash_valid: boolean;
  /** §7.19.2: governed catalog 只含 durability evidence entry */
  catalog_durability_evidence_only: boolean;
  /** §7.19.3: deterministic bounded selection(含 budget overflow 显式标注) */
  selection_deterministic_with_overflow: boolean;
  /** §7.19.4: version/hash-bound retrieval(detail 绑定 catalog+selection) */
  retrieval_version_hash_bound: boolean;
  /** §7.19.5: use decisions 绑定到 current context */
  use_decisions_bind_current_context: boolean;
  /** §7.19.6: 只使用 verified claim(正文不含未验证 claim) */
  only_use_claims_in_body: boolean;
  /** §7.19.7: source budgets 可用且 overflow metadata 可用 */
  source_budgets_with_overflow: boolean;
  /** §7.19.8: compiler 支持 stable section metadata(placement/authority 等) */
  compiler_stable_section_metadata: boolean;
  /** §7.19.9: Authority / Trust / Placement 三者分离 */
  authority_trust_placement_separated: boolean;
  /** §7.19.10: empty 状态省略 section(不造内容) */
  empty_omits_section: boolean;
  /** §7.19.11: 无 full-load fallback(失败不回退加载全部 Memory) */
  no_full_load_fallback: boolean;
  /** §7.19.12: deterministic test evidence(本 build 可在测试中复现) */
  deterministic_test_evidence: boolean;
}

/**
 * Activation gate 结果。
 *
 * active=true 时 reason_codes 为空;active=false 时含
 * `memory_entrypoint.gate_missing.<field>` 形式的 reason code。
 */
export interface BoundedMemoryActivationResult {
  activation_protocol_version: string;
  active: boolean;
  reason_codes: ReadonlyArray<string>;
  /** ISO 8601 时间戳;检查完成时刻(只用于审计) */
  checked_at: string;
}

/**
 * 12 门字段名(按定义序),用于 reason_codes 排序。
 */
const ACTIVATION_GATE_FIELDS = [
  'catalog_immutable_and_hash_valid',
  'catalog_durability_evidence_only',
  'selection_deterministic_with_overflow',
  'retrieval_version_hash_bound',
  'use_decisions_bind_current_context',
  'only_use_claims_in_body',
  'source_budgets_with_overflow',
  'compiler_stable_section_metadata',
  'authority_trust_placement_separated',
  'empty_omits_section',
  'no_full_load_fallback',
  'deterministic_test_evidence',
] as const satisfies ReadonlyArray<keyof BoundedMemoryActivationEvidence>;

/**
 * 12 门 AND gate:所有门为 true → active=true;任一为 false → active=false。
 *
 * 失败门的 reason_code 格式:`memory_entrypoint.gate_missing.<field>`,
 * 顺序按 ACTIVATION_GATE_FIELDS 定义序(规格 §7.19 + Task 9 Step 1)。
 *
 * 这个函数 *不* 做的事:
 *   - 不调用 build/cache/render(纯证据验证)
 *   - 不读取外部状态(side-effect free)
 *   - 不在 reason_codes 中包含数值上下文
 *
 * 注:非布尔字段值(如 undefined / null)按 falsy 处理,视为该门为 false。
 * 这是为了防御性处理调用方传入的 dirty evidence(类型断言可能绕过 TS 校验)。
 */
export function canActivateBoundedMemoryEntrypoint(
  evidence: BoundedMemoryActivationEvidence,
): BoundedMemoryActivationResult {
  const reasonCodes: string[] = [];
  for (const field of ACTIVATION_GATE_FIELDS) {
    const value = evidence[field];
    if (value !== true) {
      reasonCodes.push(`memory_entrypoint.gate_missing.${field}`);
    }
  }

  const result: BoundedMemoryActivationResult = {
    activation_protocol_version: MEMORY_ACTIVATION_PROTOCOL_VERSION,
    active: reasonCodes.length === 0,
    reason_codes: reasonCodes,
    checked_at: new Date().toISOString(),
  };
  return freezeSnapshot(result) as BoundedMemoryActivationResult;
}

// ===========================================================================
// §9 Task 9: Request Integration(规格 Task 9 Step 2-6)
//
// 物理本质:在 streamingQuery 调用前,把 T6(build)+ T7(cache)+ T8(handoff)
// 串成编排器,产出一个可选的 prompt section(可能为 null)。调用方
// (streamingQuery 或外部)决定如何把 section 附加到 systemPrompt。
//
// 这个编排器只做四件事:
//   1. 用 T6 buildBoundedMemoryEntrypoint 构建 snapshot(经 T7 cache 如有)
//   2. 根据 snapshot.state 决定是否调 T8 toMemoryPromptSection
//   3. 调用方提供的 rendered_content_provider 取正文(T8 要求)
//   4. 返回 BoundedMemoryRequestIntegrationResult(prompt_section 可能为 null)
//
// 关键不变量(规格 §7.18 + §7.19 + INV-F10/F12):
//   - INV-F12 empty → section=null(不造内容)
//   - INV-F10 失败不回退 full-load:任何 build/render/handoff 失败 → section=null + diagnostic
//   - 失败静默 不抛错 不改变 TurnOutcome(规格 §7.18)
//   - integration 不修改 systemPrompt(那是 streamingQuery 调用方的工作)
// ===========================================================================

/**
 * Integration 协议版本号(规格 Task 9 Step 4)。
 * 独立于 activation / handoff 协议,允许 integration schema 演进。
 */
export const MEMORY_INTEGRATION_PROTOCOL_VERSION = 'mi.memory.integration/1';

/**
 * rendered_content 提供者(规格 §7.15:调用方负责 rendered_content)。
 *
 * T6 snapshot 不携带正文(INV:identity 干净),所以 integration 需要从外部
 * 取正文。提供者接收 snapshot,返回正文 string(其 sha256 应等于
 * snapshot.rendered_section_hash)。提供者抛错时 integration 静默失败
 * (section=null + diagnostic reason_code)。
 *
 * 注意:cache hit 路径不需要调用 provider(content 来自 payload.rendered_section)。
 */
export interface RenderedContentProvider {
  (snapshot: BoundedMemoryEntrypointSnapshot): string;
}

/**
 * Request integration 输入。
 *
 * - build_input:    T1/T6 build input(catalog/selection/details/decisions/policy)
 * - dependencies:   T2/T3/T4/T5 注入(无 MemoryManager,结构保证 INV-F10)
 * - cache:          T7 可选 cache(null 表示不用 cache)
 * - render_profile: T8 handoff 必需的 approved render profile
 * - ordinal/trust/retention/provenance_refs: T8 section 字段
 * - rendered_content_provider: 调用方提供正文(规格 §7.15)
 */
export interface BoundedMemoryRequestIntegrationInput {
  build_input: MemoryEntrypointBuildInput;
  dependencies: BoundedMemoryEntrypointDependencies;
  cache: MemoryEntrypointCache | null;
  render_profile: RenderProfileAsset;
  ordinal: number;
  trust: string;
  retention: string;
  provenance_refs: ReadonlyArray<string>;
  rendered_content_provider: RenderedContentProvider;
}

/**
 * Request integration 结果。
 *
 * - prompt_section: null 表示省略 section(empty 或 rejected 或 handoff 失败)
 * - snapshot_state/snapshot_id: diagnostic metadata(用于 metadata-only diagnostic,
 *   不影响 TurnOutcome)
 * - reason_codes: integration 观察到的程序化 code(失败原因 / handoff state)
 */
export interface BoundedMemoryRequestIntegrationResult {
  integration_protocol_version: string;
  prompt_section: PromptSectionInput | null;
  snapshot_state: MemoryEntrypointState;
  snapshot_id: string | null;
  overflow_manifest_ref: string | null;
  reason_codes: ReadonlyArray<string>;
}

/**
 * 把 T6 snapshot 适配成 T7 cache 的 CacheableEntrypointPayload。
 *
 * T6 snapshot 不携带 rendered_section 正文,所以这个适配需要调用方提供正文。
 * 此处接受 renderedContent 参数(由 integration 内部从 provider 拿到后传入)。
 *
 * 注:CacheableEntrypointSnapshot 与 BoundedMemoryEntrypointSnapshot 形状兼容
 * (前者的 [key: string]: unknown 索引签名允许 T6 扩展字段)。
 */
function snapshotToCachePayload(
  snapshot: BoundedMemoryEntrypointSnapshot,
  renderedContent: string,
  renderProfile: RenderProfileAsset,
): CacheableEntrypointPayload {
  // snapshot state ∈ empty/rejected 时 rendered_section 为 null
  const section =
    snapshot.state === 'empty' || snapshot.state === 'rejected'
      ? null
      : {
          section_id: 'memory.bounded_entrypoint' as const,
          authority: 'memory' as const,
          placement: 'system_dynamic' as const,
          asset_ref: {
            asset_id: renderProfile.asset_id,
            asset_version: renderProfile.asset_version,
          },
          content: renderedContent,
          content_hash: snapshot.rendered_section_hash ?? '',
          bytes: snapshot.bytes_included,
          lines: snapshot.lines_included,
          overflow_manifest_ref:
            snapshot.state === 'partial'
              ? snapshot.overflow_manifest_ref
              : null,
          provenance_manifest_ref: snapshot.provenance_manifest_ref,
        };

  return {
    snapshot: snapshot as unknown as CacheableEntrypointPayload['snapshot'],
    rendered_section: section,
    // overflow/provenance manifest:T6 snapshot 只携带 ref,这里用 ref 构造最小 manifest
    overflow_manifest: {
      overflow_protocol_version: OVERFLOW_MANIFEST_PROTOCOL_VERSION,
      overflow_manifest_id: snapshot.overflow_manifest_ref,
      truncated: snapshot.state === 'partial',
      navigation_overflowed: snapshot.state === 'partial',
      verified_detail_overflowed: false,
      total_budget_overflowed: false,
      omitted_records: [],
      omitted_claim_refs: [],
      budget_policy_refs: [],
    },
    provenance_manifest: {
      provenance_protocol_version: '1',
      provenance_manifest_id: snapshot.provenance_manifest_ref,
      provenance_refs: [],
      freshness_refs: [],
    },
  };
}

/**
 * 把 T7 cache input 从 T6 build_input 派生。
 *
 * 注意:final_section_hash 必须由 snapshot 提供,但 cache lookup 在 build 之前。
 * 解决:cache 用两次 lookup —— 第一次用 final_section_hash=null(可能 miss),
 * 由调用方决定是否接受。本实现采用更简单的策略:cache miss 时直接调 builder,
 * builder 内部决定 final_section_hash;第二次相同 input 时 final_section_hash
 * 已知,可命中。
 *
 * 为保持 T7 接口语义,我们用 build_input 已知的 identity 字段构造 cache input,
 * final_section_hash 设为 null(意味着首次必 miss,但首次后能命中)。
 *
 * 实际上更精细的策略需要"先 build 探测 final hash,再 cache" —— 但这违背了
 * cache 的意义(就是为了避免 build)。因此本实现采用:
 *   - cache key = (semantic_input, null) — "any section hash for this input"
 *   - cache value = payload(snapshot + rendered_section)
 *   - hit 时直接复用 payload.rendered_section.content
 *
 * 这意味着:相同 input 总是命中(不论 final_section_hash 如何)。
 * 如果 build 是确定性的(spec 保证),相同 input → 相同 final_section_hash,
 * 因此这个简化是安全的。
 */
function buildCacheInput(
  input: MemoryEntrypointBuildInput,
): MemoryEntrypointCacheInput {
  return {
    entrypoint_protocol_version: ENTRYPOINT_PROTOCOL_VERSION,
    entrypoint_policy_version: input.policy.entrypoint_policy_protocol_version,
    task_snapshot_id: input.task_snapshot_id,
    current_context_snapshot_id: input.current_context_snapshot_id,
    project_version_ref: input.project_version_ref,
    catalog_snapshot_id: input.catalog_snapshot.catalog_snapshot_id,
    catalog_hash: input.catalog_snapshot.catalog_hash,
    selection_id: input.selection_result.selection_id,
    memory_use_decision_ids: input.memory_use_decisions.map(
      (d) => d.memory_use_decision_id,
    ),
    render_profile_ref: input.render_profile_ref,
    navigation_budget_policy_ref: input.policy.navigation_budget_policy_ref,
    verified_detail_budget_policy_ref:
      input.policy.verified_detail_budget_policy_ref,
    total_section_budget_policy_ref:
      input.policy.total_section_budget_policy_ref,
    final_section_hash: null,
  };
}

/**
 * Request integration 编排器。
 *
 * 调用顺序(规格 Task 9 Step 4):
 *   1. 经 T7 cache(如有)调用 T6 buildBoundedMemoryEntrypoint → snapshot
 *      (cache miss → 调 builder 并写入;cache hit → 直接复用 payload)
 *   2. 决定 rendered_content 来源:
 *      - cache hit: 用 payload.rendered_section.content
 *      - cache miss / no cache: 用 rendered_content_provider(snapshot)
 *   3. 根据 snapshot.state:
 *      - ready/partial: 调 T8 toMemoryPromptSection 组装 PromptSectionInput
 *      - empty: section=null,reason_codes += handoff.empty_omitted
 *      - rejected: section=null,reason_codes += integration.snapshot_rejected
 *   4. 任何失败(provider throws / hash mismatch / handoff throws)
 *      → 静默 section=null + reason_codes(规格 §7.18:不抛错,不改变 TurnOutcome)
 *
 * 这个函数 *不* 做的事:
 *   - 不修改 systemPrompt(那是 streamingQuery 调用方的工作)
 *   - 不调用 MemoryManager / selectByKeywords / inject / read-all
 *   - 不在 failure 时回退 full-load(INV-F10)
 *   - 不实现 activation gate(那是 canActivateBoundedMemoryEntrypoint 的职责)
 */
export async function integrateBoundedMemoryIntoRequest(
  input: BoundedMemoryRequestIntegrationInput,
): Promise<BoundedMemoryRequestIntegrationResult> {
  const reasonCodes: string[] = [];
  let snapshot: BoundedMemoryEntrypointSnapshot | null = null;
  let renderedContent: string | null = null;
  let cacheHit = false;

  // ─── Step 1: T6 build(经 T7 cache 如有) ──────────────────────────
  try {
    if (input.cache !== null) {
      const cacheInput = buildCacheInput(input.build_input);
      const builder = () => {
        const snap = buildBoundedMemoryEntrypoint(
          input.build_input,
          input.dependencies,
        );
        // builder 内部必须提供 renderedContent 以写入 cache payload
        // 但 renderedContent 需要 provider —— 此时 provider 尚未调用(snapshot 刚构建)
        // 解决:builder 先用 placeholder '' 写入,实际 content 在 hit 时由 provider 覆盖
        // 但 T8 hash 校验要求 content 与 snapshot.rendered_section_hash 一致
        // 因此 builder 阶段必须立即调 provider 拿真实 content
        let content = '';
        if (snap.state !== 'empty' && snap.state !== 'rejected') {
          content = input.rendered_content_provider(snap);
        }
        return snapshotToCachePayload(snap, content, input.render_profile);
      };
      const cacheResult = await getOrBuildMemoryEntrypoint(
        cacheInput,
        input.cache,
        builder,
      );
      cacheHit = cacheResult.hit;
      const payload = cacheResult.payload;
      snapshot = payload.snapshot as unknown as BoundedMemoryEntrypointSnapshot;
      if (
        payload.rendered_section !== null &&
        payload.rendered_section.content.length > 0
      ) {
        renderedContent = payload.rendered_section.content;
      }
    } else {
      snapshot = buildBoundedMemoryEntrypoint(
        input.build_input,
        input.dependencies,
      );
    }
  } catch {
    // build / cache failure:静默,返回 diagnostic
    reasonCodes.push('integration.build_failed');
    return makeIntegrationFailureResult(reasonCodes);
  }

  // snapshot 必须存在(若 build 成功)
  if (snapshot === null) {
    reasonCodes.push('integration.no_snapshot');
    return makeIntegrationFailureResult(reasonCodes);
  }

  // ─── Step 2: 取 renderedContent(若未从 cache 拿到) ──────────────
  if (renderedContent === null && !cacheHit) {
    try {
      renderedContent = input.rendered_content_provider(snapshot);
    } catch {
      // provider 失败:静默
      reasonCodes.push('integration.rendered_content_unavailable');
      return makeIntegrationResult(snapshot, null, reasonCodes);
    }
  }

  // ─── Step 3: empty / rejected 早返 ────────────────────────────────
  if (snapshot.state === 'empty') {
    // empty 仍尝试 handoff 以获取 reason_codes(如 handoff.empty_omitted)
    try {
      const handoff = toMemoryPromptSection({
        snapshot,
        render_profile: input.render_profile,
        rendered_content: '',
        ordinal: input.ordinal,
        trust: input.trust,
        retention: input.retention,
        provenance_refs: input.provenance_refs,
      });
      reasonCodes.push(...handoff.reason_codes);
    } catch {
      // empty 通常不会 throw,但防御性处理
      reasonCodes.push('integration.handoff_failed');
    }
    return makeIntegrationResult(snapshot, null, reasonCodes);
  }

  if (snapshot.state === 'rejected') {
    reasonCodes.push('integration.snapshot_rejected');
    // 透传 snapshot.reason_codes(诊断用)
    for (const rc of snapshot.reason_codes) {
      if (!reasonCodes.includes(rc)) reasonCodes.push(rc);
    }
    return makeIntegrationResult(snapshot, null, reasonCodes);
  }

  // ─── Step 4: ready / partial → T8 handoff ────────────────────────
  // 此时 renderedContent 必须非空(ready/partial 状态)
  if (renderedContent === null) {
    renderedContent = '';
  }

  try {
    const handoff: MemoryPromptHandoffResult = toMemoryPromptSection({
      snapshot,
      render_profile: input.render_profile,
      rendered_content: renderedContent,
      ordinal: input.ordinal,
      trust: input.trust,
      retention: input.retention,
      provenance_refs: input.provenance_refs,
    });
    // handoff.reason_codes 加入 result(handoff.ready/partial/empty_omitted 等)
    for (const rc of handoff.reason_codes) {
      if (!reasonCodes.includes(rc)) reasonCodes.push(rc);
    }
    return makeIntegrationResult(snapshot, handoff.section, reasonCodes);
  } catch (err) {
    // T8 throws MemoryPromptHandoffError:hash mismatch / not_ready / rejected 等
    // 静默,返回 diagnostic
    const handoffErr = err as MemoryPromptHandoffError;
    if (handoffErr && handoffErr.reason_code) {
      reasonCodes.push(handoffErr.reason_code);
    } else {
      reasonCodes.push('integration.handoff_failed');
    }
    return makeIntegrationResult(snapshot, null, reasonCodes);
  }
}

/**
 * 构造一个成功的 integration result。
 */
function makeIntegrationResult(
  snapshot: BoundedMemoryEntrypointSnapshot,
  section: PromptSectionInput | null,
  reasonCodes: string[],
): BoundedMemoryRequestIntegrationResult {
  const result: BoundedMemoryRequestIntegrationResult = {
    integration_protocol_version: MEMORY_INTEGRATION_PROTOCOL_VERSION,
    prompt_section: section,
    snapshot_state: snapshot.state,
    snapshot_id: snapshot.entrypoint_snapshot_id,
    overflow_manifest_ref:
      snapshot.overflow_manifest_ref.length > 0
        ? snapshot.overflow_manifest_ref
        : null,
    reason_codes: reasonCodes,
  };
  return freezeSnapshot(result) as BoundedMemoryRequestIntegrationResult;
}

/**
 * 构造一个失败的 integration result(snapshot 不可用)。
 */
function makeIntegrationFailureResult(
  reasonCodes: string[],
): BoundedMemoryRequestIntegrationResult {
  const result: BoundedMemoryRequestIntegrationResult = {
    integration_protocol_version: MEMORY_INTEGRATION_PROTOCOL_VERSION,
    prompt_section: null,
    snapshot_state: 'rejected',
    snapshot_id: null,
    overflow_manifest_ref: null,
    reason_codes: reasonCodes,
  };
  return freezeSnapshot(result) as BoundedMemoryRequestIntegrationResult;
}

// ===========================================================================
// §10 Task 9: Wave G Rebuild Handoff(规格 Task 9 Step 7)
//
// 物理本质:为 Wave G(context reconstruction)提供一个"可请求重建"的 identity
// 容器。它只携带 identity refs,不携带 snapshot 本身(避免污染 Wave G 的输入)。
//
// 这个 handoff 只表示"可请求重建",不表示"已重建"(规格 Task 9 Step 7)。
// Wave G 收到这个 input 后,可以选择重建或不重建(那是 Wave G 的职责)。
// ===========================================================================

/**
 * Rebuild handoff 协议版本(规格 Task 9 Step 7)。
 */
export const MEMORY_REBUILD_PROTOCOL_VERSION = 'mi.memory.rebuild/1';

/**
 * Wave G rebuild input — 携带 identity refs 的纯数据结构。
 *
 * - target_context_snapshot_id: 新 context 的 snapshot id(Wave G 在此 context 重建)
 * - old_*_id: 旧 snapshot 的 identity refs(用于 Wave G 决定是否需要重建)
 * - policy_ref / request_budget_snapshot_id / render_profile_ref:
 *   这些是 Wave G 重建时需要 reference 的 contract identity
 */
export interface MemoryEntrypointRebuildInput {
  entrypoint_protocol_version: string;
  rebuild_protocol_version: string;
  task_snapshot_id: string;
  target_context_snapshot_id: string;
  project_version_ref: string | null;
  old_entrypoint_snapshot_id: string | null;
  old_catalog_snapshot_id: string | null;
  old_selection_id: string | null;
  policy_ref: WaveFContractRef;
  request_budget_snapshot_id: string;
  render_profile_ref: string;
}

/**
 * 构造一个 Wave G rebuild input。
 *
 * @param snapshot      当前 request 的 T6 snapshot(可能为 null,如本次未构建)
 * @param targetContext Wave G 重建目标 context 的 identity
 * @param policyRef     policy contract ref
 * @param requestBudgetSnapshotId request budget snapshot id
 * @param renderProfileRef render profile ref
 */
export function createMemoryEntrypointRebuildInput(
  snapshot: BoundedMemoryEntrypointSnapshot | null,
  targetContext: {
    task_snapshot_id: string;
    current_context_snapshot_id: string;
    project_version_ref: string | null;
  },
  policyRef: WaveFContractRef,
  requestBudgetSnapshotId: string,
  renderProfileRef: string,
): MemoryEntrypointRebuildInput {
  const rebuild: MemoryEntrypointRebuildInput = {
    entrypoint_protocol_version: ENTRYPOINT_PROTOCOL_VERSION,
    rebuild_protocol_version: MEMORY_REBUILD_PROTOCOL_VERSION,
    task_snapshot_id: targetContext.task_snapshot_id,
    target_context_snapshot_id: targetContext.current_context_snapshot_id,
    project_version_ref: targetContext.project_version_ref,
    old_entrypoint_snapshot_id: snapshot?.entrypoint_snapshot_id ?? null,
    old_catalog_snapshot_id: snapshot?.catalog_snapshot_id ?? null,
    old_selection_id: snapshot?.selection_id ?? null,
    policy_ref: policyRef,
    request_budget_snapshot_id: requestBudgetSnapshotId,
    render_profile_ref: renderProfileRef,
  };
  return freezeSnapshot(rebuild) as MemoryEntrypointRebuildInput;
}
