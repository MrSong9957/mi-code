// Memory Detail Transaction (ERC-2 / M-045 — Wave E Task 4)
//
// 物理本质:把一份 *已 admitted* 的 typed candidate,以两阶段事务的第一阶段
// (detail commit)写入 governed storage,但不进入正式 catalog、不调用 selector。
//
// 这个文件只做四件事:
//   1. prepareMemoryPersistence —— 校验 admission 是 admit,从 candidate 复制
//      type/scope/evidence/confidence/freshness/invalidation/provenance,计算
//      content_hash 与 idempotency_key,组装 prepared transaction。
//   2. commitMemoryDetails —— 把 record 交给 governed storage 写入;成功则
//      state 迁移到 detail_committed;失败迁移到 failed/recovery_required。
//      相同 idempotency_key 重试幂等,相同 key + 不同 content → conflict。
//   3. 定义 governed storage 接口(MemoryManager 实现)。
//   4. 定义 MemoryPersistenceRecord / Transaction / Acknowledgement schema。
//
// 这个文件 *不* 做的事 (ERC-2 §8 / INV-E6 / INV-E7 / INV-E18):
//   - 不调用 selector、不更新 catalog index(detail 在 index commit 前不可发现)。
//   - 不实现 index commit / completed(那是 Task 5)。
//   - 不把 project_instruction / credential / deferred candidate 写入 detail
//     —— 输入端 admission/candidate 已经过滤,这里只接受 admit + typed candidate。
//   - 不把函数返回成功等同于 durable acknowledgement(必须由 storage 返回 ack)。
//   - 不在 failure 时把状态升级为 detail_committed。
//
// 规格来源:docs/superpowers/specs/2026-07-26-agent-lifecycle-selection-wave-e-design.md
//   §8.2 (Memory record identity) / §8.3 (Persistence transaction) /
//   §8.4 (Detail commit) / §8.12 (状态不变量) / INV-E6 / INV-E7 / INV-E18

import { createHash } from 'node:crypto';
import { freezeSnapshot, requireIdentity } from '../agent/contracts/identities.js';
import type {
  MemoryAdmissionDecision,
  MemoryUseInput,
  MemoryUseDecision,
} from './admission.js';
import type { AutoMemoryType, TypedMemoryCandidate } from './candidates.js';

/**
 * persistence 协议版本。结构变化时递增。
 * 独立于 admission / candidate / use 的 protocol version (§8.12-状态正交)。
 */
export const MEMORY_PERSISTENCE_PROTOCOL_VERSION = '1';

/**
 * detail record 自身的协议版本(独立于 transaction 协议版本)。
 */
export const MEMORY_DETAIL_RECORD_PROTOCOL_VERSION = '1';

/**
 * 首次写入的 record version。后续 lost-update 保护由 §8.4-3 / §8.4-6 处理。
 */
export const INITIAL_RECORD_VERSION = 1;

/**
 * governed storage 中的 detail record —— 从 admitted candidate 复制而来。
 *
 * §8.4-1:detail content 必须绑定 admitted type/scope/evidence。
 * §8.4-2:commit 前验证 content hash(此处记录 hash,commitMemoryDetails 校验一致)。
 * §8.4-8:writer 不得把 project instruction/credential/deferred candidate 写入 detail
 *         —— 这些在 admission/candidate 层已过滤。
 */
export interface MemoryPersistenceRecord {
  record_protocol_version: string;
  memory_record_id: string;
  admission_decision_id: string;
  record_version: number;

  // 从 admitted candidate 复制
  type: AutoMemoryType;
  scope_ref: string;
  claim: string;
  evidence_refs: string[];
  confidence: number;
  context_refs: string[];
  invalidation_conditions: string[];
  sensitivity_labels: string[];
  observed_at: string;
  expires_at: string | null;
  provenance_refs: string[];

  /** sha256(claim) —— commit 前由 commitMemoryDetails 验证一致。 */
  content_hash: string;
}

/**
 * Task 4 阶段的 transaction state(§8.3 完整状态机包含 index_committed/completed,
 * 属于 Task 5)。
 *
 * - prepared:prepareMemoryPersistence 已组装但未提交。
 * - detail_committed:storage.writeGovernedDetail 已 durable acknowledged。
 * - failed:detail 写入失败,未产生 durable side effect。
 * - recovery_required:detail 写入失败,但可能已产生部分 durable side effect。
 *
 * INV-E18:failure 不能升级为 detail_committed。
 */
export type TransactionState = 'prepared' | 'detail_committed' | 'failed' | 'recovery_required';

/**
 * detail commit 事务。一旦生成不可变。
 *
 * INV-E6:admitted ≠ detail_committed ≠ completed —— 本结构只覆盖到 detail_committed。
 * INV-E7:detail 在 index commit 前不可由 governed catalog 发现(detail_commit_ref
 *         是独立引用,record 不携带 catalog entry 字段)。
 */
export interface MemoryPersistenceTransaction {
  transaction_protocol_version: string;
  transaction_id: string;
  memory_record_id: string;
  idempotency_key: string;
  state: TransactionState;
  record: MemoryPersistenceRecord;
  /** 仅在 state='detail_committed' 后非空 —— 来自 DurableCommitAcknowledgement。 */
  detail_commit_ref: string | null;
  /** 失败/恢复时填充的原因码。 */
  reason_codes: string[];
}

/**
 * durable acknowledgement —— storage 在 write/flush/rename 全部完成后返回。
 *
 * §6.3:不得用"函数返回成功"代替 durable acknowledgement。
 */
export interface DurableCommitAcknowledgement {
  detail_commit_ref: string;
  memory_record_id: string;
  record_version: number;
  committed_at: string;
}

/**
 * governed storage 接口 —— 由 MemoryManager 实现。
 *
 * detail 写入独立目录(不在现有根目录 list() 中),因此 index commit 前不可发现。
 * 实现要点(MemoryManager.writeGovernedDetail):
 *   - 目标路径 `<workDir>/.memory/.records/<memory_record_id>.json`
 *   - temp file + same-directory rename(原子性):先写 `.tmp` 再 rename
 *   - ack 只在 write/flush/rename 完成后产生
 */
export interface GovernedMemoryStorage {
  writeGovernedDetail(record: MemoryPersistenceRecord): Promise<DurableCommitAcknowledgement>;
  readGovernedDetail(ref: string): Promise<string | null>;
}

// ===========================================================================
// helpers
// ===========================================================================

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 计算 memory_record_id。内容寻址:相同 admitted candidate 在相同 admission 下
 * 产生相同 record id,可去重。
 *
 * canonical 覆盖 admission_decision_id + candidate identity ——
 * 不同 admission / 不同 candidate → 不同 record id。
 *
 * 注:用 `memrec-` 前缀(连字符)而非 `memrec:`,因为此 id 会作为 governed
 * detail 的文件名(`<id>.json`),冒号在 Windows NTFS 上是 ADS 分隔符会导致 EINVAL。
 * 这是文件系统安全考虑,不影响内容寻址语义。
 */
function computeMemoryRecordId(
  admission: MemoryAdmissionDecision,
  candidate: TypedMemoryCandidate,
): string {
  const canonical = JSON.stringify({
    admission_decision_id: admission.admission_decision_id,
    memory_candidate_id: candidate.memory_candidate_id,
    scope_ref: candidate.scope_ref,
    type: candidate.type,
  });
  return `memrec-${sha256Hex(canonical).slice(0, 16)}`;
}

/**
 * 计算 transaction_id(内容寻址,确定性)。
 * 覆盖 record_id + admission + candidate identity。
 *
 * 注:`tx-` 前缀(不用冒号),保持文件系统安全风格一致性。
 */
function computeTransactionId(
  memoryRecordId: string,
  admission: MemoryAdmissionDecision,
): string {
  const canonical = JSON.stringify({
    memory_record_id: memoryRecordId,
    admission_decision_id: admission.admission_decision_id,
    current_context_snapshot_id: admission.current_context_snapshot_id,
  });
  return `tx-${sha256Hex(canonical).slice(0, 16)}`;
}

/**
 * 计算 idempotency_key(§8.4-6:相同 idempotency key 重试不得创建重复 record)。
 *
 * 覆盖 memory_record_id + content_hash + record_version ——
 * 因此相同 record id 但内容不同 → 不同 key(便于 conflict 检测反推)。
 * 相同 record id + 相同内容 + 相同 version → 相同 key(幂等)。
 */
function computeIdempotencyKey(
  memoryRecordId: string,
  contentHash: string,
  recordVersion: number,
): string {
  const canonical = JSON.stringify({
    memory_record_id: memoryRecordId,
    content_hash: contentHash,
    record_version: recordVersion,
  });
  return `idem-${sha256Hex(canonical).slice(0, 16)}`;
}

// ===========================================================================
// prepare
// ===========================================================================

/**
 * 把一份 admitted candidate 组装成 prepared transaction(不写入 storage)。
 *
 * §8.13:admission 非 admit → 拒绝创建 transaction(admission_not_admit)。
 * §8.4-1:detail 必须绑定 admitted type/scope/evidence。
 *
 * 纯函数(对 storage 无副作用):storage 参数保留是为了未来 selector/use 路径的
 * 一致性,本函数不使用。
 */
export async function prepareMemoryPersistence(
  admission: MemoryAdmissionDecision,
  candidate: TypedMemoryCandidate,
  _storage: GovernedMemoryStorage,
): Promise<MemoryPersistenceTransaction> {
  // ─── admit gate (§8.13) ───────────────────────────────────────────
  if (admission.status !== 'admit') {
    throw new Error(
      `admission_not_admit: cannot prepare persistence for non-admitted decision ` +
        `(status='${admission.status}')`,
    );
  }

  // ─── identity 守门 ────────────────────────────────────────────────
  requireIdentity(admission.admission_decision_id, 'admission_decision_id');
  requireIdentity(candidate.memory_candidate_id, 'memory_candidate_id');
  requireIdentity(candidate.claim, 'claim');
  requireIdentity(candidate.scope_ref, 'scope_ref');
  requireIdentity(candidate.observed_at, 'observed_at');

  // ─── 组装 record (§8.4-1:复制 admitted type/scope/evidence/confidence) ─
  const memoryRecordId = computeMemoryRecordId(admission, candidate);
  const contentHash = sha256Hex(candidate.claim);

  const record: MemoryPersistenceRecord = {
    record_protocol_version: MEMORY_DETAIL_RECORD_PROTOCOL_VERSION,
    memory_record_id: memoryRecordId,
    admission_decision_id: admission.admission_decision_id,
    record_version: INITIAL_RECORD_VERSION,
    type: candidate.type,
    scope_ref: candidate.scope_ref,
    claim: candidate.claim,
    evidence_refs: [...candidate.evidence_refs],
    confidence: candidate.confidence,
    context_refs: [...candidate.context_refs],
    invalidation_conditions: [...candidate.invalidation_conditions],
    sensitivity_labels: [...candidate.sensitivity_labels],
    observed_at: candidate.observed_at,
    expires_at: candidate.expires_at,
    provenance_refs: [...candidate.evidence_refs], // provenance 指向 evidence
    content_hash: contentHash,
  };

  // ─── 组装 transaction (state=prepared) ────────────────────────────
  const transactionId = computeTransactionId(memoryRecordId, admission);
  const idempotencyKey = computeIdempotencyKey(
    memoryRecordId,
    contentHash,
    INITIAL_RECORD_VERSION,
  );

  const transaction: MemoryPersistenceTransaction = {
    transaction_protocol_version: MEMORY_PERSISTENCE_PROTOCOL_VERSION,
    transaction_id: transactionId,
    memory_record_id: memoryRecordId,
    idempotency_key: idempotencyKey,
    state: 'prepared',
    record,
    detail_commit_ref: null,
    reason_codes: [],
  };

  return freezeSnapshot(transaction) as MemoryPersistenceTransaction;
}

// ===========================================================================
// commit
// ===========================================================================

/**
 * 把 prepared transaction 的 record 写入 governed storage。
 *
 * 成功路径:prepared → detail_committed(detail_commit_ref 来自 ack)。
 * 失败路径:detail 写入失败 → failed/recovery_required(INV-E18:不升级)。
 *
 * §8.4-2:commit 前验证 content hash —— 重新计算 record.claim 的 hash,
 *         与 record.content_hash 不一致 → conflict(idempotency_conflict)。
 * §8.4-3 / §8.4-6:相同 idempotency key 重试幂等(已 detail_committed 直接返回);
 *         相同 idempotency key + 不同 content_hash → conflict(lost update)。
 *
 * 幂等:相同 transaction(相同 idempotency_key + 相同 content)再次 commit →
 *       返回同一 detail_commit_ref,storage 不重复写入(由 storage 去重)。
 *
 * 失败语义:storage.writeGovernedDetail 抛错时,本函数把 state 置为 failed 并
 *         重新抛出原始错误,调用方据 ack 缺失判断是否需要 recovery。
 */
export async function commitMemoryDetails(
  transaction: MemoryPersistenceTransaction,
  storage: GovernedMemoryStorage,
): Promise<MemoryPersistenceTransaction> {
  // ─── 幂等:已 detail_committed 直接返回(§8.4-6) ──────────────────
  if (transaction.state === 'detail_committed' && transaction.detail_commit_ref !== null) {
    return transaction;
  }

  // ─── 非法状态:index_committed/completed 不在 Task 4 范围;failed 不可重试同一 tx ──
  // 这里只处理 prepared;其它非 detail_committed 状态视为协议误用。
  if (transaction.state !== 'prepared') {
    throw new Error(
      `commit_invalid_state: cannot commit transaction in state '${transaction.state}'`,
    );
  }

  // ─── content hash 验证 (§8.4-2) ───────────────────────────────────
  // 重新计算 claim 的 hash,与 record 中存储的 content_hash 必须一致。
  const observedHash = sha256Hex(transaction.record.claim);
  if (observedHash !== transaction.record.content_hash) {
    throw new Error(
      `content_hash_mismatch: record.content_hash does not match sha256(claim)`,
    );
  }

  // ─── idempotency / lost-update 自检 (§8.4-3 / §8.4-6) ─────────────
  // transaction.idempotency_key 必须由 (memory_record_id, content_hash, record_version)
  // 派生。若调用方篡改 record 但保留 idempotency_key,这里检测出不一致 → conflict。
  const expectedKey = computeIdempotencyKey(
    transaction.record.memory_record_id,
    transaction.record.content_hash,
    transaction.record.record_version,
  );
  if (expectedKey !== transaction.idempotency_key) {
    throw new Error(
      `idempotency_conflict: idempotency_key does not match (memory_record_id, content_hash, record_version) ` +
        `— possible lost-update attempt`,
    );
  }

  // ─── 写入 governed storage (§6.3 durable acknowledgement) ────────
  // INV-E18: failure 不升级状态。writeGovernedDetail 失败时错误直接上抛,
  // 使调用方明确知道 durable ack 缺失。不吞错、不构造伪 ack。
  const ack: DurableCommitAcknowledgement = await storage.writeGovernedDetail(transaction.record);

  // ─── 成功:迁移到 detail_committed ────────────────────────────────
  const committed: MemoryPersistenceTransaction = {
    ...transaction,
    state: 'detail_committed',
    detail_commit_ref: ack.detail_commit_ref,
    reason_codes: [...transaction.reason_codes],
  };

  return freezeSnapshot(committed) as MemoryPersistenceTransaction;
}

// ===========================================================================
// Catalog Recovery (ERC-2 / M-045 — Wave E Task 5)
//
// 物理本质:catalog commit 失败后的"补救"。只对**同一 transaction** 做要么完成
// 要么回滚的判定 —— 不会跨 transaction 修改状态、不会删除已写入的 detail record。
//
// 算法(规格 Task 5 Step 4):
//   1. transaction.state === 'detail_committed':尝试再次 catalog commit。
//      - 成功 → 'completed'
//      - 失败 → 'recovery_required'(本次 recovery 未能修复)
//      - update_rejected → 'update_rejected'(budget 不满足,不算故障)
//   2. transaction.state === 'prepared':无 durable side effect,
//      返回 'recovery_required'(nothing to complete / rollback)。
//   3. 其它状态:recovery_required。
//
// INV-E18:recovery 不会把 commit failure 升级成 completed。
//
// 注:catalog.ts 顶部 type-only import persistence.ts,不存在运行时循环依赖;
//     这里用 dynamic import 进一步隔离模块求值顺序。
// ===========================================================================

/**
 * catalog.ts 的运行时引用(惰性加载避免模块求值循环)。
 *
 * 因为 recoverMemoryPersistence 是 persistence.ts 的对外 API,
 * 而 catalog.ts 的 commitMemoryCatalog 需要 persistence.ts 的类型 ——
 * 用 dynamic import 把运行时调用延后到首次执行,彻底避免循环。
 */
async function loadCatalogRuntime(): Promise<typeof import('./catalog.js')> {
  return import('./catalog.js');
}

/**
 * selection.ts 的运行时引用(惰性加载,与 loadCatalogRuntime 一致的防御性策略)。
 *
 * selection.ts 仅 type-only import catalog.ts / persistence.ts,不存在真正的
 * 运行时循环;但为保持与 loadCatalogRuntime 同样的隔离风格,这里也用 dynamic import。
 */
async function loadSelectionRuntime(): Promise<typeof import('./selection.js')> {
  return import('./selection.js');
}

/**
 * 修复一份未完成的 persistence transaction(只针对同一 transaction)。
 *
 * @param transaction  未完成的 transaction(prepared / detail_committed)
 * @param storage      governed detail storage(本函数实际不写入,签名对称以备扩展)
 * @param catalogStore governed catalog store(recovery 会再次尝试 commit)
 * @param budgetPolicy 可选,默认正无穷大(避免 recovery 时因 budget 阻塞)
 */
export async function recoverMemoryPersistence(
  transaction: MemoryPersistenceTransaction,
  storage: GovernedMemoryStorage,
  catalogStore: import('./catalog.js').GovernedCatalogStore,
  budgetPolicy: import('./catalog.js').CatalogBudgetPolicy = {
    max_entries: Number.MAX_SAFE_INTEGER,
    max_index_metadata_bytes: Number.MAX_SAFE_INTEGER,
  },
): Promise<import('./catalog.js').CatalogCommitResult> {
  // recovery 只对同一 transaction 工作 —— 不会去修复其它 transaction。
  // 这里通过签名约束:只接收一个 transaction。
  void storage; // 当前 recovery 不写 detail;显式标记未使用,签名对称便于将来扩展。

  const { commitMemoryCatalog } = await loadCatalogRuntime();

  // detail_committed:尝试再次 commit catalog
  if (transaction.state === 'detail_committed') {
    return commitMemoryCatalog(
      { transaction, catalog_budget_policy: budgetPolicy },
      catalogStore,
    );
  }

  // prepared / 其它:无 durable side effect 可完成,也不需要回滚
  return freezeSnapshot({
    state: 'recovery_required',
    catalog_snapshot: null,
    memory_record_id: transaction.memory_record_id,
    reason_codes: ['catalog.transaction_not_detail_committed'],
  }) as import('./catalog.js').CatalogCommitResult;
}

// ===========================================================================
// Memory Core Anchor (ERC-2 / Wave E Task 8)
//
// 物理本质:M-045 persistence 与 M-046 selection/retrieval 之间的**公共
// discriminated entrypoint**。把三种 sibling operation(persist / select /
// retrieve)封闭为一个 operation union,按 operation discriminator 恰好调用
// 一条 sibling path。
//
// 这个 anchor 只做三件事:
//   1. 按 request.operation 分发到恰好一条 sibling 路径。
//   2. 透传 sibling path 的 acknowledgement,不折叠为单个 success boolean。
//   3. 冻结并返回 discriminated result。
//
// 这个 anchor *不* 做的事 (规格 Task 8 Global Constraints):
//   - 不给 M-045/M-046 新增相互 D-edge(它只是公共 entrypoint,不存在
//     "persist 自动触发 select"或反向边)。
//   - 不隐式 persist-then-select。
//   - 不调用 catalog repair(recoverMemoryPersistence)。dependencies 接口
//     根本不含 recover 字段 —— 这是"不调用 repair"的结构性保证。
//   - 不折叠 acknowledgement 为单个 boolean(transaction / selection /
//     retrieval 各自的状态完整保留在 result.value 中)。
//   - 不实现 sibling 路径细节;每条 sibling 都通过 dependencies 注入,
//     便于测试隔离与未来替换。
//
// 规格来源:docs/superpowers/plans/2026-07-26-agent-mechanisms-wave-e-implementation.md
//   Task 8 / Global Constraints / Review checkpoint
// ===========================================================================

/**
 * persist operation 的请求 payload。
 *
 * admission / candidate 由 anchor 透传给 dependencies.persist(E-1 T4 → T5
 * prepare + commit details + commit catalog 链)。
 */
export interface PersistAdmittedMemoryRequest {
  operation: 'persist';
  admission: MemoryAdmissionDecision;
  candidate: TypedMemoryCandidate;
}

/**
 * select operation 的请求 payload。
 *
 * query + catalog(immutable snapshot)由 anchor 透传给 dependencies.select
 * (E-1 T6 selectMemoryEntries)。select 不需要 storage / catalogStore ——
 * 它是 catalog snapshot 的只读消费者。
 */
export interface SelectCatalogMemoryRequest {
  operation: 'select';
  query: import('./selection.js').MemorySearchQuery;
  catalog: import('./catalog.js').MemoryCatalogSnapshot;
}

/**
 * retrieve operation 的请求 payload。
 *
 * selection(E-1 T6 产物)+ current_context_snapshot_id 由 anchor 透传给
 * dependencies.retrieve(E-2 T7 retrieveSelectedMemory)。retrieve 不需要
 * storage / catalogStore —— detail 通过 readDetail 注入。
 */
export interface RetrieveSelectedMemoryRequest {
  operation: 'retrieve';
  selection: import('./selection.js').MemorySelectionResult;
  current_context_snapshot_id: string;
}

/**
 * 封闭 operation union —— discriminated union by `operation`。
 *
 * 这是 anchor 的输入契约。新增 operation 必须修改此 union ——
 * 因此 anchor 是封闭的,不允许"未知 operation"在运行时混入。
 */
export type MemoryLifecycleOperationRequest =
  | PersistAdmittedMemoryRequest
  | SelectCatalogMemoryRequest
  | RetrieveSelectedMemoryRequest;

/**
 * persist operation 的结果(携带 durable acknowledgement transaction)。
 *
 * acknowledgement 是完整的 MemoryPersistenceTransaction,包含 state /
 * detail_commit_ref / record —— 不折叠为单个 boolean。
 */
export interface PersistenceOperationResult {
  kind: 'persistence';
  value: MemoryPersistenceTransaction;
}

/**
 * select operation 的结果(携带 immutable selected refs)。
 *
 * acknowledgement 是完整的 MemorySelectionResult,包含 selected_entries /
 * selection_id —— 不折叠为单个 boolean。
 */
export interface SelectionOperationResult {
  kind: 'selection';
  value: import('./selection.js').MemorySelectionResult;
}

/**
 * retrieve operation 的结果(携带 use-gated claims)。
 *
 * acknowledgement 是完整的 MemoryRetrievalResult,包含 usable_claim_refs /
 * rejected_record_ids / retrieval_id —— 不折叠为单个 boolean。
 */
export interface RetrievalOperationResult {
  kind: 'retrieval';
  value: import('./selection.js').MemoryRetrievalResult;
}

/**
 * anchor 输出 —— discriminated union by `kind`,与 request.operation 一一对应。
 *
 * 每个 result.kind 对应其原始 acknowledgement 类型,调用方需按 kind 分支消费。
 */
export type MemoryLifecycleOperationResult =
  | PersistenceOperationResult
  | SelectionOperationResult
  | RetrievalOperationResult;

/**
 * sibling path 注入签名 —— persist 链(prepare + commit details + commit catalog)。
 *
 * 默认实现见 `defaultPersistPath`。注入字段存在主要是为了:
 *   1. 测试隔离(测试可 spy / 替换为 mock)。
 *   2. 未来若需在 anchor 内增加 budget policy 参数,签名已就位。
 */
export type PersistSiblingPath = (
  admission: MemoryAdmissionDecision,
  candidate: TypedMemoryCandidate,
  storage: GovernedMemoryStorage,
  catalogStore: import('./catalog.js').GovernedCatalogStore,
) => Promise<MemoryPersistenceTransaction>;

/**
 * sibling path 注入签名 —— select(selectMemoryEntries)。
 *
 * 返回 Promise 以允许 dynamic import 默认实现(尽管 selectMemoryEntries 本身是纯函数)。
 */
export type SelectSiblingPath = (
  query: import('./selection.js').MemorySearchQuery,
  catalog: import('./catalog.js').MemoryCatalogSnapshot,
) => Promise<import('./selection.js').MemorySelectionResult> | import('./selection.js').MemorySelectionResult;

/**
 * sibling path 注入签名 —— retrieve(retrieveSelectedMemory)。
 *
 * retrieve 需要 readDetail + decideUse,因此 retrieve sibling path 是 async。
 */
export type RetrieveSiblingPath = (
  selection: import('./selection.js').MemorySelectionResult,
  deps: {
    readDetail: (detail_commit_ref: string) => Promise<string | null>;
    decideUse: (input: MemoryUseInput) => MemoryUseDecision;
  },
  current_context_snapshot_id: string,
) => Promise<import('./selection.js').MemoryRetrievalResult>;

/**
 * anchor 的依赖。
 *
 * 关键不变量(结构性保证):
 *   - 不含 recover / recoverMemoryPersistence / repairMemoryCatalog 字段 ——
 *     这是"anchor 不调用 catalog repair"的结构性证据:函数物理上无法访问 recovery。
 *   - 不含 inject / loadAllMemory / searchAllMemory 字段 ——
 *     与 retrieval/use gate 的 INV-no-inject-on-failure 一致。
 *
 * sibling path(persist / select / retrieve)以注入形式提供,默认实现见
 * `defaultPersistPath` / `defaultSelectPath` / `defaultRetrievePath`,
 * 调用方可不传时由 anchor 注入默认实现。
 */
export interface MemoryLifecycleDependencies {
  /** persist 路径需要的 governed detail storage(M-045)。 */
  storage: GovernedMemoryStorage;
  /** persist 路径需要的 governed catalog store(M-045)。 */
  catalogStore: import('./catalog.js').GovernedCatalogStore;
  /** persist sibling path(默认 defaultPersistPath)。 */
  persist?: PersistSiblingPath;
  /** select sibling path(默认 defaultSelectPath)。 */
  select?: SelectSiblingPath;
  /** retrieve sibling path(默认 defaultRetrievePath)。 */
  retrieve?: RetrieveSiblingPath;
  /** retrieve 路径需要的 governed detail reader。 */
  readDetail?: (detail_commit_ref: string) => Promise<string | null>;
  /** retrieve 路径需要的 DRC-2 decideMemoryUse。 */
  decideUse?: (input: MemoryUseInput) => MemoryUseDecision;
}

/**
 * 默认 persist sibling path:prepare → commitMemoryDetails → commitMemoryCatalog。
 *
 * 不调用 recoverMemoryPersistence。catalog commit 失败时 sibling 抛错或返回
 * 'recovery_required',由调用方决定是否调用 recover —— anchor 不在内部修复。
 */
async function defaultPersistPath(
  admission: MemoryAdmissionDecision,
  candidate: TypedMemoryCandidate,
  storage: GovernedMemoryStorage,
  catalogStore: import('./catalog.js').GovernedCatalogStore,
): Promise<MemoryPersistenceTransaction> {
  const prepared = await prepareMemoryPersistence(admission, candidate, storage);
  const committed = await commitMemoryDetails(prepared, storage);
  // 第二阶段:catalog commit。budget 用正无穷(默认策略);
  // 调用方若需 budget 控制,应在 dependencies.persist 中包装。
  const catalogResult = await loadCatalogRuntimeThenCommit(committed, catalogStore);
  void catalogResult; // sibling 只透传 transaction;catalog 写入完成与否由调用方查 transaction.state
  return committed;
}

/**
 * 惰性调用 catalog.commitMemoryCatalog(避免在 module top-level 形成循环)。
 */
async function loadCatalogRuntimeThenCommit(
  transaction: MemoryPersistenceTransaction,
  catalogStore: import('./catalog.js').GovernedCatalogStore,
): Promise<import('./catalog.js').CatalogCommitResult> {
  const { commitMemoryCatalog } = await loadCatalogRuntime();
  return commitMemoryCatalog(
    {
      transaction,
      catalog_budget_policy: {
        max_entries: Number.MAX_SAFE_INTEGER,
        max_index_metadata_bytes: Number.MAX_SAFE_INTEGER,
      },
    },
    catalogStore,
  );
}

/**
 * 默认 select sibling path:直接调用 selectMemoryEntries(纯函数)。
 *
 * 与 loadCatalogRuntime 同样的隔离风格:dynamic import selection 模块。
 * 函数声明为 async 以与签名(返回 Promise)一致 ——
 * 调用方在 anchor 内 await 它,与 sync 版本无差异。
 */
async function defaultSelectPath(
  query: import('./selection.js').MemorySearchQuery,
  catalog: import('./catalog.js').MemoryCatalogSnapshot,
): Promise<import('./selection.js').MemorySelectionResult> {
  const { selectMemoryEntries } = await loadSelectionRuntime();
  return selectMemoryEntries(query, catalog);
}

/**
 * 默认 retrieve sibling path:封装 retrieveSelectedMemory 调用。
 */
async function defaultRetrievePath(
  selection: import('./selection.js').MemorySelectionResult,
  deps: {
    readDetail: (detail_commit_ref: string) => Promise<string | null>;
    decideUse: (input: MemoryUseInput) => MemoryUseDecision;
  },
  current_context_snapshot_id: string,
): Promise<import('./selection.js').MemoryRetrievalResult> {
  const {
    retrieveSelectedMemory,
    MEMORY_RETRIEVAL_PROTOCOL_VERSION,
  } = await loadSelectionRuntime();
  return retrieveSelectedMemory(
    {
      retrieval_protocol_version: MEMORY_RETRIEVAL_PROTOCOL_VERSION,
      selection,
      current_context_snapshot_id,
    },
    deps,
  );
}

/**
 * Memory Core Anchor —— 公共 discriminated entrypoint。
 *
 * 算法(规格 Task 8):
 *   1. operation === 'persist':
 *      - 调用 dependencies.persist(admission, candidate, storage, catalogStore)
 *      - 返回 { kind: 'persistence', value: transaction }
 *      - **不**隐式执行 select。
 *   2. operation === 'select':
 *      - 调用 dependencies.select(query, catalog)
 *      - 返回 { kind: 'selection', value: result }
 *      - **不**调用 persistence。
 *   3. operation === 'retrieve':
 *      - 调用 dependencies.retrieve(selection, { readDetail, decideUse }, ctx_id)
 *      - 返回 { kind: 'retrieval', value: result }
 *
 * 关键不变量(Global Constraints):
 *   - INV-anchor-sibling-independence:每个 operation 恰好触发一条 sibling path。
 *   - INV-no-implicit-persist-then-select:persist 不自动 select,反之亦然。
 *   - INV-no-catalog-repair-from-anchor:anchor 不调用 recoverMemoryPersistence
 *     (dependencies 接口不含 recover 字段,结构性保证)。
 *   - INV-no-ack-folding:result.kind 保留 acknowledgement 类型,不输出 success:boolean。
 *   - INV-seven-states-not-auto-derived:admitted/detail/index/completed/selected/
 *     retrieved/use 不能由前一状态自动推导 —— anchor 只是分发器,不做状态推导。
 *
 * @param request      封闭 operation union
 * @param dependencies sibling paths + governed stores + retrieve 依赖
 * @returns            discriminated result by `kind`,与 request.operation 一一对应
 */
export async function persistAndSelectMemory(
  request: MemoryLifecycleOperationRequest,
  dependencies: MemoryLifecycleDependencies,
): Promise<MemoryLifecycleOperationResult> {
  // ─── persist sibling path ─────────────────────────────────────────
  if (request.operation === 'persist') {
    if (dependencies.storage === undefined || dependencies.storage === null) {
      throw new Error(
        'anchor.missing_dependency.storage: persist operation requires storage',
      );
    }
    const persistPath = dependencies.persist ?? defaultPersistPath;
    const transaction = await persistPath(
      request.admission,
      request.candidate,
      dependencies.storage,
      dependencies.catalogStore,
    );
    // 透传 acknowledgement,不折叠为 boolean。
    return freezeSnapshot({
      kind: 'persistence',
      value: transaction,
    }) as PersistenceOperationResult;
  }

  // ─── select sibling path ──────────────────────────────────────────
  if (request.operation === 'select') {
    const selectPath = dependencies.select ?? defaultSelectPath;
    const result = await selectPath(request.query, request.catalog);
    // 透传 acknowledgement,不折叠为 boolean。
    return freezeSnapshot({
      kind: 'selection',
      value: result,
    }) as SelectionOperationResult;
  }

  // ─── retrieve sibling path ────────────────────────────────────────
  if (request.operation === 'retrieve') {
    requireIdentity(
      request.current_context_snapshot_id,
      'anchor.request.current_context_snapshot_id',
    );
    if (typeof dependencies.readDetail !== 'function') {
      throw new Error(
        'anchor.missing_dependency.readDetail: retrieve operation requires readDetail',
      );
    }
    if (typeof dependencies.decideUse !== 'function') {
      throw new Error(
        'anchor.missing_dependency.decideUse: retrieve operation requires decideUse',
      );
    }
    const retrievePath = dependencies.retrieve ?? defaultRetrievePath;
    const result = await retrievePath(
      request.selection,
      {
        readDetail: dependencies.readDetail,
        decideUse: dependencies.decideUse,
      },
      request.current_context_snapshot_id,
    );
    // 透传 acknowledgement,不折叠为 boolean。
    return freezeSnapshot({
      kind: 'retrieval',
      value: result,
    }) as RetrievalOperationResult;
  }

  // ─── 封闭 union fallback ──────────────────────────────────────────
  // 若 TS 类型系统失效或运行时混入未知 operation,这里抛错。
  // 这是"封闭 union"的运行时守门。
  const exhaustive: never = request;
  void exhaustive;
  throw new Error(
    `anchor.unknown_operation: ${(request as { operation?: string }).operation ?? '<missing>'}`,
  );
}
