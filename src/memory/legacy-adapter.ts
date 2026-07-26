// Memory Legacy Adapter (ERC-2 / M-045 — Wave E Task 5)
//
// 物理本质:把旧 MemoryManager 的 markdown-based 记忆,**单向** 转换成 governed
// catalog snapshot 的入口。这是迁移/兼容层,**不是** 新的写入路径 ——
// 新 memory 必须走两阶段事务(persistence + catalog commit)。
//
// 这个文件只做四件事:
//   1. 读取 MemoryManager 现有 metadata(list() 提供的 slug/name/type/description)。
//   2. 校验三组 evidence 同时齐备:schema compatibility + admission + durability。
//   3. 任一 evidence 缺失 → 整批旧数据进 unclassified_entry_ids(留在 snapshot 外,
//      供调用方审计);齐全 → 进入 governed snapshot。
//   4. 构造 MemoryCatalogEntry,**不含正文/credential/conversation/project instruction**,
//      并标记 source_kind='existing_memory_manager'、durability_evidence_kind='existing_store'。
//
// 这个文件 *不* 做的事 (规格 Task 5 Step 5/6):
//   - 不把 existing_store_durability 当作 two_step_transaction_ack(INV 关键不变量)。
//   - 不给 source_kind='existing_memory_manager' 赋予 Trust / selection 特权。
//   - 不修改 MemoryManager 既有数据(只读迁移)。
//   - 不实现 schema compatibility 判定逻辑本身 —— 调用方传入 evidence 三元组。
//   - 不读旧记忆的正文 body —— 只复制 frontmatter metadata。
//
// 规格来源:docs/superpowers/plans/2026-07-26-agent-mechanisms-wave-e-implementation.md
//   Task 5 Step 5/6;specs/2026-07-26-agent-lifecycle-selection-wave-e-design.md §8.5/§8.6

import { createHash } from 'node:crypto';
import { freezeSnapshot } from '../agent/contracts/identities.js';
import {
  buildMemoryCatalogSnapshot,
  type MemoryCatalogEntry,
  type MemoryCatalogSnapshot,
} from './catalog.js';
import type { MemoryManager } from './memory-manager.js';

/**
 * legacy schema 兼容版本号。
 *
 * 调用方在评估旧 MemoryManager 数据时,把当前 schema 标记与 LEGACY_SCHEMA_VERSION
 * 比较;一致 + 结构可解析 → schemaCompatibilityEvidence.compatible = true。
 */
export const LEGACY_SCHEMA_VERSION = 'legacy.memory_manager.frontmatter.v1';

/**
 * schema compatibility evidence —— 调用方对旧 schema 做静态/结构判定后注入。
 */
export interface SchemaCompatibilityEvidence {
  /** 旧 schema 版本字符串。与 LEGACY_SCHEMA_VERSION 比较。 */
  schema_version: string;
  /** 旧 schema 是否能映射到当前 catalog entry schema。 */
  compatible: boolean;
}

/**
 * admission evidence —— 调用方对旧数据是否具备等价 admission 决定的判定。
 *
 * legacy 数据本身没有显式 admission_decision_id;调用方必须显式给出"已评估过 admission"
 * 的证据(has_admission_decision=true),否则不进入 governed snapshot。
 */
export interface AdmissionEvidence {
  has_admission_decision: boolean;
}

/**
 * durability evidence —— 旧 store 的持久性特征。
 *
 * store_kind='existing_memory_manager':旧 markdown 文件持久存储。
 *   durable=true 时表示文件落盘可靠;但 **不等于** two_step_transaction_ack ——
 *   旧 store 没有 detail/index 两阶段事务。
 */
export interface DurabilityEvidence {
  store_kind: 'existing_memory_manager';
  durable: boolean;
}

/**
 * legacy adapter 的输入。
 */
export interface LegacyAdapterInput {
  manager: MemoryManager;
  schemaCompatibilityEvidence: SchemaCompatibilityEvidence;
  admissionEvidence: AdmissionEvidence;
  durabilityEvidence: DurabilityEvidence;
}

/**
 * legacy adapter 的输出。
 */
export interface LegacyCatalogSnapshot {
  /** governed catalog snapshot(只含 admitted 条目)。 */
  snapshot: MemoryCatalogSnapshot;
  /** 进入 governed snapshot 的条目 id(= 旧 slug)。 */
  admitted_entry_ids: string[];
  /**
   * 未分类条目 id(= 旧 slug)。留在外,调用方可审计后决定迁移或保留。
   * 当 schema/admission/durability 任一 evidence 不满足时,**全部** 旧数据进此列表。
   */
  unclassified_entry_ids: string[];
}

/**
 * 三组 evidence 是否同时齐备。
 */
function allEvidencePresent(input: LegacyAdapterInput): boolean {
  return (
    input.schemaCompatibilityEvidence.compatible &&
    input.admissionEvidence.has_admission_decision &&
    input.durabilityEvidence.durable
  );
}

/**
 * 计算单条 legacy entry 的 metadata_bytes(UTF-8 字节)。
 */
function computeLegacyMetadataBytes(entry: Omit<MemoryCatalogEntry, 'metadata_bytes'>): number {
  return Buffer.byteLength(JSON.stringify(entry), 'utf8');
}

/**
 * 把一条 MemoryManager 旧 entry(slug/name/type/description)转换成 governed catalog entry。
 *
 * §8.5:不复制 body / 不复制 description 中的正文 —— description 仅作为导航摘要,
 *       在 T5 阶段不混入 keyword_terms(避免把旧描述文本当作 normalized keyword,
 *       导致 selector 行为漂移)。topic/keyword 留空数组,等价于"按 scope/type 可选"。
 *
 * INV:source_kind='existing_memory_manager',**不携带 Trust / 不携带 selection 特权**。
 * INV:durability_evidence_kind='existing_store',**不是** two_step_transaction_ack。
 */
function buildLegacyEntry(
  slug: string,
  type: string,
  scopeRef: string,
  observedAt: string,
): MemoryCatalogEntry {
  // legacy record 没有 content_hash(没有 detail body hash);
  // 用 slug + scope + type 做内容寻址,产生稳定 hash。
  const canonical = JSON.stringify({ slug, type, scopeRef });
  const contentHash = `legacy:sha256:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
  const baseEntry = {
    // 内容寻址 id:用 slug + hash,稳定可去重。
    memory_record_id: slug,
    // legacy 数据没有 version 概念,固定 1。
    record_version: 1,
    // legacy 数据没有显式 admission_decision_id,用 scope_ref + slug 占位。
    admission_decision_id: `legacy:admission:${slug}`,
    type,
    scope_ref: scopeRef,
    topic_terms: [] as string[],
    keyword_terms: [] as string[],
    observed_at: observedAt,
    provenance_refs: [`legacy:existing_memory_manager:${slug}`],
    detail_commit_ref: 'legacy:existing_memory_manager',
    content_hash: contentHash,
    source_kind: 'existing_memory_manager' as const,
    durability_evidence_kind: 'existing_store' as const,
  };
  return { ...baseEntry, metadata_bytes: computeLegacyMetadataBytes(baseEntry) };
}

/**
 * 把旧 MemoryManager 数据转换为 governed catalog snapshot(单向迁移)。
 *
 * 算法:
 *   1. 读取 manager.list() —— 旧 markdown metadata 的 slug/name/type/description。
 *   2. 三组 evidence 全齐 → 所有 entry 进 governed snapshot,unclassified 为空。
 *   3. 任一 evidence 缺失 → snapshot 空,所有 slug 进 unclassified_entry_ids。
 *   4. snapshot 是 frozen 的;entry 不含正文/credential/conversation/project instruction。
 *
 * 输出包含 admitted / unclassified 两个 id 列表,供调用方审计与渐进迁移。
 */
export function buildLegacyCatalogSnapshot(input: LegacyAdapterInput): LegacyCatalogSnapshot {
  const listing = input.manager.list();
  const slugs = listing.map((e) => e.slug);

  if (!allEvidencePresent(input)) {
    // evidence 缺失:全部进 unclassified,snapshot 空。
    const emptySnapshot = buildMemoryCatalogSnapshot([]);
    return freezeSnapshot({
      snapshot: emptySnapshot,
      admitted_entry_ids: [],
      unclassified_entry_ids: [...slugs],
    }) as LegacyCatalogSnapshot;
  }

  const nowIso = '2026-07-26T00:00:00Z';
  const entries: MemoryCatalogEntry[] = listing.map((item) =>
    buildLegacyEntry(
      item.slug,
      // 旧 MemoryType 是 'user'|'feedback'|'project'|'reference';
      // catalog.type 是自由 string,直接透传。
      item.type,
      // legacy 数据没有 scope_ref 概念,用一个固定 default scope。
      'legacy:workspace',
      nowIso,
    ),
  );

  const snapshot = buildMemoryCatalogSnapshot(entries);
  return freezeSnapshot({
    snapshot,
    admitted_entry_ids: entries.map((e) => e.memory_record_id),
    unclassified_entry_ids: [],
  }) as LegacyCatalogSnapshot;
}
