// Memory Catalog — Snapshot + Commit + Recovery (ERC-2 / M-045 T5 + M-046 T6)
//
// 物理本质:已 admitted memory 的不可变导航索引快照 + 两阶段事务的第二阶段
// (catalog / index commit)。
//
// 这个文件做以下事:
//   1. 定义 MemoryCatalogEntry / MemoryCatalogSnapshot 的 schema(原 T6 范围)。
//   2. buildMemoryCatalogSnapshot builder:把 entries 冻结成不可变 snapshot,
//      并按 entries 内容算出内容寻址 catalog_snapshot_id / catalog_hash。
//   3. 校验 entry 的 identity 字段非空。
//   4. commitMemoryCatalog:T5 范围。把一份 detail_committed transaction 的
//      record 转成 catalog entry,经 budget 校验后原子写入 governed catalog,
//      使该 memory 正式可见。失败时 state='recovery_required' 且 detail 保持不可发现。
//   5. GovernedCatalogStore 接口:由 MemoryManager 实现。
//
// 这个文件 *不* 做的事 (规格 §8.5 / §8.10 / §8.11 / INV-E7 / INV-E8):
//   - 不读 detail body —— selector 只消费 metadata (INV-E8: index 不是正文)。
//   - 不实现 detail commit 那是 persistence.ts (T4)。
//   - 不修改 admission / record / confidence —— snapshot 是只读快照。
//   - 不在 commit 失败时把 state 升级为 completed (INV-E18)。
//   - 不在 budget 超限时截断既有 entry(必须 update_rejected)。
//   - catalog entry 不含正文 / credential / evidence body / conversation / project instruction (§8.5)。
//
// 规格来源:docs/superpowers/specs/2026-07-26-agent-lifecycle-selection-wave-e-design.md
//   §8.5 Index entry / §8.6 Catalog snapshot / §8.4-4 (detail 在 catalog commit 前不可发现)
//   §8.11 Sibling contract boundary / INV-E7 / INV-E8 / INV-E18

import { createHash } from 'node:crypto';
import { freezeSnapshot, requireIdentity } from '../agent/contracts/identities.js';
import type {
  MemoryPersistenceTransaction,
} from './persistence.js';

/**
 * catalog 协议版本。结构变化时递增。
 * 独立于 record / persistence / selection 的 protocol version (INV-E19)。
 *
 * 注:本版本是 T6 最小 schema,T5 在同一文件追加 commit/recovery 逻辑时,
 * 只要不破坏本协议字段定义,可不递增;若破坏兼容,递增此版本。
 */
export const MEMORY_CATALOG_PROTOCOL_VERSION = '1';

/**
 * catalog 中一条 entry —— 一个已 admitted memory 的导航 metadata。
 *
 * INV-E8:index 只包含导航/过滤/完整性校验所需 metadata。
 * 禁止包含完整 claim/body、credential、evidence body、conversation transcript、
 * project instruction 正文 (§8.5)。
 *
 * 本 T6 schema 的字段刻意与规格 §8.5 对齐,但只保留 selector 用得到的字段:
 *   - topic_terms / keyword_terms 已是 normalized(T5 在 commit 时归一化)。
 *   - metadata_bytes 是 selector 预算计算用的字节度量(由 T5 commit 填入,
 *     T6 selector 只读取,不重新计算)。
 */
export interface MemoryCatalogEntry {
  /** 已 admitted memory 的稳定 record identity。selector 用作确定性 tie-break。 */
  memory_record_id: string;
  /** record 版本。lost-update 防御由 T5 commit 处理;T6 selector 只透传。 */
  record_version: number;
  /** 对应的 admission decision。admit ≠ selected (INV-E6)。 */
  admission_decision_id: string;
  /** AutoMemoryType。selector 按 query.type_filter 过滤。 */
  type: string;
  /** 生效 scope。selector 按 query.scope_ref 过滤。 */
  scope_ref: string;
  /** 已 normalized 的 topic keys。selector 做精确 normalized-key 匹配。 */
  topic_terms: string[];
  /** 已 normalized 的 keyword keys。selector 做精确 normalized-key 匹配。 */
  keyword_terms: string[];
  /** observation 时间戳(ISO 8601)。selector 不做 freshness 判定(那是 use decision)。 */
  observed_at: string;
  /** provenance 引用(只透传)。 */
  provenance_refs: string[];
  /** detail commit 引用 —— 只用于 traceability,selector 不读取 detail。 */
  detail_commit_ref: string;
  /** detail content hash —— 用于完整性 traceability (INV-E7)。 */
  content_hash: string;
  /** 该 entry 的 metadata 字节度量,用于 selector 预算计算。由 T5 commit 填入。 */
  metadata_bytes: number;
  /**
   * 可选:来源标签。新协议 entry 不携带此字段(或 'governed_persistence');
   * legacy adapter 注入 'existing_memory_manager'。
   * selector(M-046)**不读**此字段 —— source_kind 不携带 Trust / 选择特权 (§8.6-2)。
   */
  source_kind?: 'existing_memory_manager' | 'governed_persistence';
  /**
   * 可选:durability evidence 标签。
   * - 'two_step_transaction_ack':来自新协议两阶段事务(detail commit + catalog commit)。
   * - 'existing_store':来自旧 MemoryManager(legacy adapter),**不是** two_step_transaction_ack。
   * selector 不读;只用于审计与 traceability。
   */
  durability_evidence_kind?: 'two_step_transaction_ack' | 'existing_store';
}

/**
 * catalog snapshot —— 不可变。
 *
 * §8.6:Catalog snapshot 创建后不可变。selector 不根据 source_kind 改变 Trust。
 * §8.10-1:selector 只读取 catalog metadata,不全量读取 detail 后再筛选。
 *
 * 本 T6 schema 简化自规格 §8.6(去除 source_kind/budget_policy_ref/overflow_state,
 * 这些属于 T5 commit 范围);T6 selector 只需 entries + hash + id。
 */
export interface MemoryCatalogSnapshot {
  catalog_protocol_version: string;
  /** 内容寻址 id:覆盖 protocol version + entry 内容 → 相同 entries 产生相同 id。 */
  catalog_snapshot_id: string;
  /** 已 frozen 的 entries。selector 保持其顺序作为导航 rank。 */
  entries: ReadonlyArray<MemoryCatalogEntry>;
  /** entries canonical 内容的 sha256 —— 用于 staleness 与 round-trip 校验。 */
  catalog_hash: string;
}

/**
 * 校验单条 entry 的 identity 字段非空,避免空字符串混入 canonical hash。
 * 不做 type/scope 枚举校验(selector 已按 normalized key 比较,类型自由)。
 */
function validateEntry(entry: MemoryCatalogEntry, index: number): void {
  const at = `catalog.entries[${index}]`;
  requireIdentity(entry.memory_record_id, `${at}.memory_record_id`);
  requireIdentity(entry.admission_decision_id, `${at}.admission_decision_id`);
  requireIdentity(entry.type, `${at}.type`);
  requireIdentity(entry.scope_ref, `${at}.scope_ref`);
  requireIdentity(entry.observed_at, `${at}.observed_at`);
  requireIdentity(entry.detail_commit_ref, `${at}.detail_commit_ref`);
  requireIdentity(entry.content_hash, `${at}.content_hash`);
  if (
    typeof entry.metadata_bytes !== 'number' ||
    !Number.isFinite(entry.metadata_bytes) ||
    entry.metadata_bytes < 0
  ) {
    throw new Error(`${at}.metadata_bytes must be a non-negative finite number`);
  }
  if (!Array.isArray(entry.topic_terms) || !Array.isArray(entry.keyword_terms)) {
    throw new Error(`${at}.topic_terms and keyword_terms must be arrays`);
  }
}

/**
 * 计算 catalog snapshot 的内容寻址 id 与 hash。
 *
 * canonical 覆盖 protocol version + 每条 entry 的完整内容(按数组顺序)——
 * 相同 entries 顺序产生相同 id/hash(可去重、可 staleness 校验)。
 * record_version 序列化成 number(类型稳定)。
 */
function computeCatalogDigest(entries: ReadonlyArray<MemoryCatalogEntry>): {
  catalog_snapshot_id: string;
  catalog_hash: string;
} {
  const canonical = JSON.stringify(
    entries.map((e) => ({
      memory_record_id: e.memory_record_id,
      record_version: e.record_version,
      admission_decision_id: e.admission_decision_id,
      type: e.type,
      scope_ref: e.scope_ref,
      topic_terms: e.topic_terms,
      keyword_terms: e.keyword_terms,
      observed_at: e.observed_at,
      provenance_refs: e.provenance_refs,
      detail_commit_ref: e.detail_commit_ref,
      content_hash: e.content_hash,
      metadata_bytes: e.metadata_bytes,
      // 扩展字段加入 canonical,确保 source_kind / durability 不同的 entry 产生不同 id。
      source_kind: e.source_kind ?? null,
      durability_evidence_kind: e.durability_evidence_kind ?? null,
    })),
  );
  const hash = createHash('sha256').update(canonical).digest('hex');
  return {
    catalog_snapshot_id: `catalog:${hash.slice(0, 16)}`,
    catalog_hash: hash,
  };
}

/**
 * 从 entries 构造一个不可变 catalog snapshot。
 *
 * - 校验每条 entry 的 identity 字段。
 * - 按内容计算 catalog_snapshot_id / catalog_hash。
 * - 深冻结整个 snapshot(包括 entries / 子数组)。
 *
 * T5 commit / legacy adapter 路径都调用本 builder 产出最终 snapshot。
 */
export function buildMemoryCatalogSnapshot(
  entries: ReadonlyArray<MemoryCatalogEntry>,
): MemoryCatalogSnapshot {
  // 先校验,再计算 digest —— 校验失败时不会产生部分 snapshot。
  entries.forEach((entry, index) => validateEntry(entry, index));
  const { catalog_snapshot_id, catalog_hash } = computeCatalogDigest(entries);
  const snapshot: MemoryCatalogSnapshot = {
    catalog_protocol_version: MEMORY_CATALOG_PROTOCOL_VERSION,
    catalog_snapshot_id,
    // 复制一份新数组,避免调用方继续 mutate 原数组影响冻结后的 entries 视图。
    entries: entries.map((entry) => ({
      ...entry,
      topic_terms: [...entry.topic_terms],
      keyword_terms: [...entry.keyword_terms],
      provenance_refs: [...entry.provenance_refs],
    })),
    catalog_hash,
  };
  return freezeSnapshot(snapshot) as MemoryCatalogSnapshot;
}

// ===========================================================================
// T5: Catalog Commit
//
// 物理本质:两阶段事务的第二阶段。detail 已写(detail_committed)但不可见;
// commit 成功后该 memory 才出现在 governed catalog,被 selector 看见。
//
// 算法:
//   1. transaction.state !== 'detail_committed' → recovery_required
//   2. 加载既有 snapshot,构造新 entry(从 record 提取 metadata,不含正文)。
//   3. budget 检查:超 max_entries / max_index_metadata_bytes → update_rejected,
//      不写、不截断既有 entry。
//   4. 原子写入(temp + rename 由 store.commitSnapshot 实现):新 snapshot。
//   5. 成功 → state='completed',detail/index identity/version/hash 一致。
//   6. 失败 → state='recovery_required',detail 保持不可发现(INV-E7)。
//
// 不变量:
//   - INV-E7   catalog commit 前后,detail 的可发现性只通过 governed catalog 决定。
//   - INV-E18  commit 失败不升级 state。
//   - §8.5     entry 只含导航 metadata,不含正文/credential/conversation。
//   - §8.4-4   失败时 detail 不可发现。
// ===========================================================================

/**
 * catalog budget policy —— commit 时的容量上限。
 * 超限 → update_rejected,不截断既有 entry(规格 §8.6 / Task 5 Step 4)。
 */
export interface CatalogBudgetPolicy {
  /** snapshot 内 entry 总数上限。 */
  max_entries: number;
  /** snapshot 内 entry metadata_bytes 累加上限。 */
  max_index_metadata_bytes: number;
}

/**
 * catalog commit 的输入。
 */
export interface CatalogCommitInput {
  /** 必须 state='detail_committed'。 */
  transaction: MemoryPersistenceTransaction;
  catalog_budget_policy: CatalogBudgetPolicy;
}

/**
 * catalog commit 的结果。
 *
 * - 'completed':snapshot 已原子写入;detail 现在可由 governed catalog 发现。
 * - 'update_rejected':budget 超限;既有 snapshot 未被修改;detail 仍不可发现。
 * - 'recovery_required':commit 失败或 transaction 状态非法;
 *   调用方需进入 recovery(recoverMemoryPersistence)。
 */
export interface CatalogCommitResult {
  state: 'completed' | 'update_rejected' | 'recovery_required';
  catalog_snapshot: MemoryCatalogSnapshot | null;
  memory_record_id: string;
  reason_codes: string[];
}

/**
 * governed catalog 存储接口 —— 由 MemoryManager 实现。
 *
 * 实现要点(MemoryManager.writeGovernedCatalog):
 *   - 目标路径 `<workDir>/.memory/.catalog/snapshot.json`
 *   - temp + same-directory rename(原子性)
 *   - find() 是基于最新 snapshot 的只读查询
 *
 * find() / loadSnapshot() / commitSnapshot() 三者必须共享同一份持久化视图。
 */
export interface GovernedCatalogStore {
  /** 查询某 memory_record_id 是否已在 governed catalog 中。 */
  find(memory_record_id: string): Promise<MemoryCatalogEntry | null>;
  /** 原子写入新 snapshot(覆盖既有)。失败时抛错,既有 snapshot 不变。 */
  commitSnapshot(snapshot: MemoryCatalogSnapshot): Promise<void>;
  /** 加载当前 governed catalog snapshot;无则 null。 */
  loadSnapshot(): Promise<MemoryCatalogSnapshot | null>;
}

/**
 * 计算单条 catalog entry 的 metadata_bytes(用于预算)。
 * 不计算正文,只计算 entry JSON 序列化后的字节长度(UTF-8)。
 */
function computeEntryMetadataBytes(
  entry: Omit<MemoryCatalogEntry, 'metadata_bytes'>,
): number {
  const json = JSON.stringify(entry);
  // UTF-8 字节长度,而非字符长度。
  return Buffer.byteLength(json, 'utf8');
}

/**
 * 从一份 detail_committed transaction 构造 catalog entry(不含正文)。
 *
 * §8.5:entry 只复制导航 metadata —— memory_record_id / version / admission /
 *       type / scope / topic / keyword / observed_at / provenance /
 *       detail_commit_ref / content_hash。**不**复制 claim / evidence_refs /
 *       context_refs / invalidation / sensitivity。
 *
 * topic_terms / keyword_terms:T5 不实现 NLP 抽取,从 record 中无可提取的 normalized
 * terms(claim 正文不在 entry 中)。这里返回空数组 ——
 * 上层(legacy adapter 或 candidate pipeline)若需注入 terms,应在传入前填好。
 * selector 对空 terms 的 entry 仍可按 scope/type 选择。
 */
function buildEntryFromTransaction(
  tx: MemoryPersistenceTransaction,
): MemoryCatalogEntry {
  const baseEntry = {
    memory_record_id: tx.record.memory_record_id,
    record_version: tx.record.record_version,
    admission_decision_id: tx.record.admission_decision_id,
    type: tx.record.type,
    scope_ref: tx.record.scope_ref,
    topic_terms: [] as string[],
    keyword_terms: [] as string[],
    observed_at: tx.record.observed_at,
    provenance_refs: [...tx.record.provenance_refs],
    detail_commit_ref: tx.detail_commit_ref ?? '',
    content_hash: tx.record.content_hash,
    source_kind: 'governed_persistence' as const,
    durability_evidence_kind: 'two_step_transaction_ack' as const,
  };
  requireIdentity(baseEntry.detail_commit_ref, 'detail_commit_ref');
  const metadata_bytes = computeEntryMetadataBytes(baseEntry);
  return { ...baseEntry, metadata_bytes };
}

/**
 * 校验 budget policy 是正整数(防止运行时非法 policy 触发 NaN 比较)。
 */
function requireValidBudget(policy: CatalogBudgetPolicy): void {
  if (
    typeof policy.max_entries !== 'number' ||
    !Number.isInteger(policy.max_entries) ||
    policy.max_entries <= 0
  ) {
    throw new Error('catalog.invalid_budget.max_entries must be a positive integer');
  }
  if (
    typeof policy.max_index_metadata_bytes !== 'number' ||
    !Number.isInteger(policy.max_index_metadata_bytes) ||
    policy.max_index_metadata_bytes <= 0
  ) {
    throw new Error(
      'catalog.invalid_budget.max_index_metadata_bytes must be a positive integer',
    );
  }
}

/**
 * 把一份 detail_committed transaction 提交到 governed catalog。
 *
 * 成功路径:
 *   - transaction.state === 'detail_committed' 且 detail_commit_ref 非空
 *   - 加载既有 snapshot,append/replace entry(memory_record_id 为键)
 *   - 通过 budget 检查后,调用 store.commitSnapshot 原子写入
 *   - 返回 state='completed' + 新 snapshot
 *
 * 失败路径:
 *   - transaction.state ≠ 'detail_committed' → 'recovery_required'
 *     (reason: catalog.transaction_not_detail_committed)
 *   - budget 超限 → 'update_rejected'(reason: catalog.budget_exceeded.entries
 *     或 catalog.budget_exceeded.bytes),既有 snapshot 未变
 *   - store.commitSnapshot 抛错 → 'recovery_required'
 *     (reason: catalog.commit_failed),detail 保持不可发现
 *
 * 幂等:同一 transaction 再次 commit 会产生相同 entry(内容寻址),
 *       store.commitSnapshot 用相同 snapshot 覆盖,等价无副作用。
 */
export async function commitMemoryCatalog(
  input: CatalogCommitInput,
  store: GovernedCatalogStore,
): Promise<CatalogCommitResult> {
  requireValidBudget(input.catalog_budget_policy);

  const tx = input.transaction;
  const memoryRecordId = tx.memory_record_id;

  // ─── 1. state gate (§8.4-4:detail 在 catalog commit 前不可发现) ───
  if (tx.state !== 'detail_committed' || tx.detail_commit_ref === null) {
    return freezeSnapshot({
      state: 'recovery_required',
      catalog_snapshot: null,
      memory_record_id: memoryRecordId,
      reason_codes: ['catalog.transaction_not_detail_committed'],
    }) as CatalogCommitResult;
  }

  // ─── 2. 构造新 entry(只含 metadata,不含正文) ─────────────────────
  const newEntry = buildEntryFromTransaction(tx);

  // ─── 3. 加载既有 snapshot,合并 entry(memory_record_id 为键) ────────
  const existing = await store.loadSnapshot();
  const existingEntries: MemoryCatalogEntry[] = existing
    ? existing.entries.filter((e) => e.memory_record_id !== memoryRecordId)
    : [];
  const merged = [...existingEntries, newEntry];

  // ─── 4. budget 检查(超限 → update_rejected,不截断既有) ─────────────
  if (merged.length > input.catalog_budget_policy.max_entries) {
    return freezeSnapshot({
      state: 'update_rejected',
      catalog_snapshot: existing,
      memory_record_id: memoryRecordId,
      reason_codes: ['catalog.budget_exceeded.entries'],
    }) as CatalogCommitResult;
  }
  const totalBytes = merged.reduce((s, e) => s + e.metadata_bytes, 0);
  if (totalBytes > input.catalog_budget_policy.max_index_metadata_bytes) {
    return freezeSnapshot({
      state: 'update_rejected',
      catalog_snapshot: existing,
      memory_record_id: memoryRecordId,
      reason_codes: ['catalog.budget_exceeded.bytes'],
    }) as CatalogCommitResult;
  }

  // ─── 5. 原子写入新 snapshot(temp + rename 由 store 实现) ──────────
  const snapshot = buildMemoryCatalogSnapshot(merged);
  try {
    await store.commitSnapshot(snapshot);
  } catch {
    // INV-E18:commit 失败不升级 state。detail 保持不可发现。
    return freezeSnapshot({
      state: 'recovery_required',
      catalog_snapshot: null,
      memory_record_id: memoryRecordId,
      reason_codes: ['catalog.commit_failed'],
    }) as CatalogCommitResult;
  }

  // ─── 6. completed:detail/index identity/version/hash 全部一致 ──────
  return freezeSnapshot({
    state: 'completed',
    catalog_snapshot: snapshot,
    memory_record_id: memoryRecordId,
    reason_codes: [],
  }) as CatalogCommitResult;
}
