// Memory Selection (ERC-2 / M-046)
//
// 物理本质:对 immutable catalog snapshot 应用 deterministic query,
// 返回 **导航候选引用** 的纯函数。selector 只读 catalog metadata,不读 detail body。
//
// 这个文件只做四件事:
//   1. buildMemorySearchQuery:把任务的结构化语义 + 受控关键词归一化为
//      MemorySearchQuery(NFKC + trim + locale-independent lowercase + 分词 + 去空 + 去重)。
//   2. selectMemoryEntries:对 catalog 逐 entry 过滤(scope → type → normalized term match),
//      按 catalog entry order + memory_record_id tie-break 排序,再施加 budget。
//   3. 生成 deterministic selection_id(内容寻址)。
//   4. 输出不可变的 MemorySelectionResult。
//
// 这个文件 *不* 做的事 (规格 §8.10 / §8.11):
//   - 不读 detail body (§8.10-1)。函数签名根本不接受 detail reader。
//   - 不实现模糊 / 同义词 / embedding / reranker(当前只支持精确 normalized-key 匹配)。
//   - 不修改 catalog / record / confidence / admission (§8.10-8, selector 是只读消费者)。
//   - 不调用 persistence 修复 missing detail/index (§8.11-5)。
//   - 不把 selection rank 当作 confidence / Truth / Trust / Authority / use (INV-E9)。
//   - 不在 search failure 时回退为"加载全部 Memory" (§8.10-12, INV-E18)。
//   - 不判定 freshness / expiry —— expired entry 仍可选为 refresh candidate (§8.10-6),
//     freshness 判定属于 use decision (M-046 use gate),不在 selection 范围。
//
// 规格来源:docs/superpowers/specs/2026-07-26-agent-lifecycle-selection-wave-e-design.md
//   §8.8 Search query / §8.9 Selection result / §8.10 Selection rules /
//   §8.11 Sibling contract boundary / §8.13 错误语义

import { createHash } from 'node:crypto';
import { freezeSnapshot, requireIdentity } from '../agent/contracts/identities.js';
import type { MemoryCatalogEntry, MemoryCatalogSnapshot } from './catalog.js';
import type {
  MemoryUseDecision,
  MemoryUseInput,
} from './admission.js';

/**
 * selection 协议版本。结构变化时递增。
 * 独立于 catalog / record / persistence 的 protocol version (INV-E19)。
 */
export const MEMORY_SELECTION_PROTOCOL_VERSION = '1';

// ===========================================================================
// §1 MemorySearchQuery
// ===========================================================================

/**
 * selector 的查询输入。归一化后不可变。
 *
 * §8.8:Query 由任务的结构化语义和受控关键词构造;
 * 不把整个 user conversation 复制进 index search。
 *
 * scope_ref / type_filter 为 null 表示"不限"(不过滤该项)。
 * topic_terms / keyword_terms 已归一化:只做精确 normalized-key 匹配。
 */
export interface MemorySearchQuery {
  query_protocol_version: string;
  /** 内容寻址 query id:覆盖归一化后的全部字段。 */
  query_id: string;
  /** null = 不限 scope;非空 = entry.scope_ref 必须精确匹配。 */
  scope_ref: string | null;
  /** null = 不限 type;非空 = entry.type 必须精确匹配。 */
  type_filter: string | null;
  /** 已归一化的 topic keys。 */
  topic_terms: string[];
  /** 已归一化的 keyword keys。 */
  keyword_terms: string[];
  /** 最多选中的 entry 数量(正整数)。达到即停,overflowed=true。 */
  max_selected_entries: number;
  /** 选中 entry 的 metadata_bytes 累加上限(正整数)。达到即停,overflowed=true。 */
  max_index_metadata_bytes: number;
}

/**
 * buildMemorySearchQuery 的输入。所有 terms 都会在内部归一化。
 */
export interface BuildMemorySearchQueryInput {
  /** 可选 scope。省略 = null = 不限。 */
  scope_ref?: string;
  /** 可选 type filter。省略 = null = 不限。 */
  type_filter?: string;
  /** 待归一化的 topic terms。 */
  topic_terms: string[];
  /** 待归一化的 keyword terms。 */
  keyword_terms: string[];
  /** 正整数。 */
  max_selected_entries: number;
  /** 正整数。 */
  max_index_metadata_bytes: number;
}

/**
 * 把单个 raw term 归一化为 normalized key 数组。
 *
 * 步骤(规格 §8.8 / 计划 Step 3):
 *   1. Unicode NFKC(全角→半角等兼容性等价)。
 *   2. trim。
 *   3. locale-independent lowercase(String.prototype.toLowerCase 不带 locale,
 *      避免土耳其语 I/i 等语言相关映射)。
 *   4. 按空白/常见标点分词(同一 raw term 内可能含多个 token)。
 *   5. 去空 token。
 *
 * 去重由调用方在合并所有 raw terms 后统一做(保持稳定顺序)。
 *
 * 不实现:模糊匹配、同义词扩展、embedding、reranker。
 */
function normalizeTermToTokens(raw: string): string[] {
  if (typeof raw !== 'string') {
    return [];
  }
  // NFKC + trim + locale-independent lowercase。
  const folded = raw.normalize('NFKC').trim().toLowerCase();
  if (folded.length === 0) {
    return [];
  }
  // 按空白与常见标点切分。用统一分隔符避免正则零宽问题。
  // 这里只关心用于 normalized-key 匹配的 token;不做语义切词。
  const tokens = folded.split(/[\s.,;:!?/\\|(){}[\]<>"'`~@#$%^&*+=\-—–]+/u);
  return tokens.filter((t) => t.length > 0);
}

/**
 * 合并多个 raw terms,归一化并去重(保持首次出现顺序)。
 */
function normalizeTerms(rawTerms: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rawTerms) {
    for (const token of normalizeTermToTokens(raw)) {
      if (!seen.has(token)) {
        seen.add(token);
        out.push(token);
      }
    }
  }
  return out;
}

/**
 * 校验正整数预算(规格 §8.13:query budget 非法 → selection invalid)。
 */
function requirePositiveIntegerBudget(value: unknown, field: string): void {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new Error(`${field} must be a positive integer`);
  }
}

/**
 * 构造 MemorySearchQuery。
 *
 * 纯函数:不读 catalog、不触发选择、不修改入参。
 * 归一化所有 terms 并算出内容寻址 query_id。
 */
export function buildMemorySearchQuery(
  input: BuildMemorySearchQueryInput,
): MemorySearchQuery {
  requirePositiveIntegerBudget(
    input.max_selected_entries,
    'max_selected_entries',
  );
  requirePositiveIntegerBudget(
    input.max_index_metadata_bytes,
    'max_index_metadata_bytes',
  );

  const topic_terms = normalizeTerms(input.topic_terms);
  const keyword_terms = normalizeTerms(input.keyword_terms);

  // scope/type 也需归一化(精确匹配要求双方都按相同规则归一)。
  // 但 scope_ref / type_filter 若为空字符串视为"不限"(等同省略)。
  const scope_ref =
    typeof input.scope_ref === 'string' && input.scope_ref.trim().length > 0
      ? input.scope_ref.normalize('NFKC').trim()
      : null;
  const type_filter =
    typeof input.type_filter === 'string' && input.type_filter.trim().length > 0
      ? input.type_filter.normalize('NFKC').trim().toLowerCase()
      : null;

  const query: MemorySearchQuery = {
    query_protocol_version: MEMORY_SELECTION_PROTOCOL_VERSION,
    query_id: computeQueryId({
      scope_ref,
      type_filter,
      topic_terms,
      keyword_terms,
      max_selected_entries: input.max_selected_entries,
      max_index_metadata_bytes: input.max_index_metadata_bytes,
    }),
    scope_ref,
    type_filter,
    topic_terms,
    keyword_terms,
    max_selected_entries: input.max_selected_entries,
    max_index_metadata_bytes: input.max_index_metadata_bytes,
  };
  return freezeSnapshot(query) as MemorySearchQuery;
}

function computeQueryId(fields: {
  scope_ref: string | null;
  type_filter: string | null;
  topic_terms: string[];
  keyword_terms: string[];
  max_selected_entries: number;
  max_index_metadata_bytes: number;
}): string {
  const canonical = JSON.stringify({
    v: MEMORY_SELECTION_PROTOCOL_VERSION,
    scope_ref: fields.scope_ref,
    type_filter: fields.type_filter,
    topic_terms: fields.topic_terms,
    keyword_terms: fields.keyword_terms,
    max_selected_entries: fields.max_selected_entries,
    max_index_metadata_bytes: fields.max_index_metadata_bytes,
  });
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `query:${hash.slice(0, 16)}`;
}

// ===========================================================================
// §2 MemorySelectionResult
// ===========================================================================

/**
 * 单个被排除 entry 的诊断。
 */
export interface MemoryExcludedEntry {
  memory_record_id: string;
  /** selection.* 三种之一(scope_mismatch / type_mismatch / no_term_match)。 */
  reason_code: string;
}

/**
 * selector 的输出。一旦生成就不可变。
 *
 * §8.9 / INV-E9:selected_entries 只是导航候选引用;**不是** Truth/Trust/use。
 * retrieve detail 后仍必须调用 DRC-2 MemoryUseDecision gate (§8.10-10)。
 */
export interface MemorySelectionResult {
  selection_protocol_version: string;
  /** 内容寻址 id:相同 query+catalog 必产生相同 selection_id (§8.10-3)。 */
  selection_id: string;
  /** 触发本次选择的 query(归一化、frozen)。 */
  query: MemorySearchQuery;
  /** 选中的 entry 引用(按 catalog order + tie-break 排列)。 */
  selected_entries: ReadonlyArray<MemoryCatalogEntry>;
  /** 被过滤掉的 entry 诊断。 */
  excluded_entries: ReadonlyArray<MemoryExcludedEntry>;
  /** true = 因 budget 截断了部分匹配 entry;不声称结果完整 (§8.10-5)。 */
  overflowed: boolean;
  /** 选中 entry 的 metadata_bytes 累加值。 */
  total_index_metadata_bytes: number;
  /** 顶层 reason_codes 汇总(便于下游 programmatic 消费)。 */
  reason_codes: string[];
}

/**
 * 规格中 selection reason_code 常量(可枚举)。
 */
const REASON_SCOPE_MISMATCH = 'selection.scope_mismatch';
const REASON_TYPE_MISMATCH = 'selection.type_mismatch';
const REASON_NO_TERM_MATCH = 'selection.no_term_match';
const REASON_BUDGET_OVERFLOW = 'selection.budget_overflow';

/**
 * 判断 entry 是否与 query 有 normalized term 交集。
 * topic 与 keyword 任一命中即视为匹配 (§8.10-2:topic/keyword 后匹配)。
 */
function entryMatchesTerms(
  entry: MemoryCatalogEntry,
  query: MemorySearchQuery,
): boolean {
  if (query.topic_terms.length === 0 && query.keyword_terms.length === 0) {
    // query 没有任何 term → 视为"通配",全部通过 term 阶段。
    // (这与 §8.10-12 不冲突:那是指 search failure 不能回退加载全部,
    //  这里是 query 显式不带 term,等价于"在该 scope/type 下全部导航候选"。)
    return true;
  }
  const entryTopic = new Set(entry.topic_terms);
  const entryKeyword = new Set(entry.keyword_terms);
  for (const t of query.topic_terms) {
    if (entryTopic.has(t)) {
      return true;
    }
  }
  for (const k of query.keyword_terms) {
    if (entryKeyword.has(k)) {
      return true;
    }
  }
  return false;
}

/**
 * 计算 selection_id(内容寻址)。
 *
 * canonical 覆盖:protocol version + query_id + catalog_snapshot_id +
 *   selected memory_record_id 序列 + overflowed。
 * 相同 query+catalog 必产生相同 selection_id (§8.10-3)。
 */
function computeSelectionId(fields: {
  query_id: string;
  catalog_snapshot_id: string;
  selected_ids: string[];
  overflowed: boolean;
}): string {
  const canonical = JSON.stringify({
    v: MEMORY_SELECTION_PROTOCOL_VERSION,
    query_id: fields.query_id,
    catalog_snapshot_id: fields.catalog_snapshot_id,
    selected_ids: fields.selected_ids,
    overflowed: fields.overflowed,
  });
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `sel:${hash.slice(0, 16)}`;
}

/**
 * 在 immutable catalog snapshot 上执行 deterministic selection。
 *
 * 纯函数:不读 detail、不修改 catalog/record/admission、不调用 persistence。
 *
 * 算法(规格 §8.10):
 *   1. filter(逐 entry,顺序固定):
 *      a. scope filter:query.scope_ref 非空时,entry.scope_ref 必须匹配
 *         → 不匹配 excluded 'selection.scope_mismatch'
 *      b. type filter:query.type_filter 非空时,entry.type 必须匹配
 *         → 不匹配 excluded 'selection.type_mismatch'
 *      c. normalized match:entry 的 topic/keyword 与 query 任一交集
 *         → 无交集 excluded 'selection.no_term_match'
 *   2. rank(顺序固定):catalog entry order → memory_record_id tie-break
 *   3. budget:累加 selected entry 的 metadata_bytes,达到
 *      max_selected_entries 或 max_index_metadata_bytes 即停,
 *      必须停在完整 entry 边界(不拆 entry),overflowed=true
 *
 * rank 只表示导航顺序,不表达 confidence/Truth/Trust/Authority/use (INV-E9)。
 */
export function selectMemoryEntries(
  query: MemorySearchQuery,
  catalog: MemoryCatalogSnapshot,
): MemorySelectionResult {
  requireIdentity(query.query_protocol_version, 'query.query_protocol_version');
  requireIdentity(query.query_id, 'query.query_id');
  requireIdentity(
    catalog.catalog_protocol_version,
    'catalog.catalog_protocol_version',
  );
  requireIdentity(
    catalog.catalog_snapshot_id,
    'catalog.catalog_snapshot_id',
  );

  const excluded: MemoryExcludedEntry[] = [];
  // 阶段 1 + 2:filter。遍历 catalog.entries(已是 catalog order),
  // 命中的放入 matched,未命中的记入 excluded。
  // tie-break:在排序阶段处理(此处先按 catalog order 收集)。
  const matched: MemoryCatalogEntry[] = [];
  for (const entry of catalog.entries) {
    // a. scope filter
    if (query.scope_ref !== null && entry.scope_ref !== query.scope_ref) {
      excluded.push({
        memory_record_id: entry.memory_record_id,
        reason_code: REASON_SCOPE_MISMATCH,
      });
      continue;
    }
    // b. type filter
    if (query.type_filter !== null && entry.type !== query.type_filter) {
      excluded.push({
        memory_record_id: entry.memory_record_id,
        reason_code: REASON_TYPE_MISMATCH,
      });
      continue;
    }
    // c. normalized term match
    if (!entryMatchesTerms(entry, query)) {
      excluded.push({
        memory_record_id: entry.memory_record_id,
        reason_code: REASON_NO_TERM_MATCH,
      });
      continue;
    }
    matched.push(entry);
  }

  // rank:catalog entry order 是主键(snapshot 内数组位置天然唯一);
  // memory_record_id 仅作为理论上的次序 tie-break —— 由于 entries 来自同一
  // 不可变 snapshot 且每个 entry 在数组中位置唯一,tie 在实践中不会发生,
  // 这里保持 catalog order 不变即可确定 (§8.10-3/4)。
  // (matched 已按 catalog.entries 遍历顺序累积,无需重排。)

  // 阶段 3:budget。逐条累加;若加入下一条会让 selected 超出
  //   max_selected_entries 或 max_index_metadata_bytes,则停止(完整 entry 边界)。
  const selected: MemoryCatalogEntry[] = [];
  let totalBytes = 0;
  let overflowed = false;
  for (const entry of matched) {
    if (selected.length >= query.max_selected_entries) {
      overflowed = true;
      break;
    }
    if (totalBytes + entry.metadata_bytes > query.max_index_metadata_bytes) {
      // 加该 entry 会超字节预算 → 停在完整 entry 边界。
      overflowed = true;
      break;
    }
    selected.push(entry);
    totalBytes += entry.metadata_bytes;
  }

  const reason_codes: string[] = overflowed ? [REASON_BUDGET_OVERFLOW] : [];

  const selected_ids = selected.map((e) => e.memory_record_id);
  const selection_id = computeSelectionId({
    query_id: query.query_id,
    catalog_snapshot_id: catalog.catalog_snapshot_id,
    selected_ids,
    overflowed,
  });

  const result: MemorySelectionResult = {
    selection_protocol_version: MEMORY_SELECTION_PROTOCOL_VERSION,
    selection_id,
    query,
    selected_entries: selected,
    excluded_entries: excluded,
    overflowed,
    total_index_metadata_bytes: totalBytes,
    reason_codes,
  };
  return freezeSnapshot(result) as MemorySelectionResult;
}

// ===========================================================================
// §3 Memory Retrieval + Use Gate (ERC-2 / M-046 T7)
//
// 物理本质:把 selector 产出的 MemorySelectionResult(导航候选引用)交给
// governed detail reader 取回正文,做完整性校验,再对每条逐条调用
// DRC-2 decideMemoryUse —— 只让 status='use' 的 verified claim 进入 prompt。
//
// 这个段只做四件事:
//   1. 逐 selected entry 调用 governed readDetail,取得 detail body(或 null)。
//   2. detail integrity 校验:detail_missing(返回 null)/
//      detail_integrity_mismatch(body sha256 ≠ entry.content_hash)→ 只产诊断,
//      不进入 use gate。
//   3. integrity 通过的 entry → 构造 MemoryUseInput,调用注入的 decideUse。
//      status='use' → verified_claim_refs 累入 usable_claim_refs;
//      status='do_not_use' / 'needs_refresh' → memory_record_id 入 rejected。
//   4. 输出不可变 MemoryRetrievalResult(含 deterministic retrieval_id)。
//
// 这个段 *不* 做的事 (规格 Step 5 / Global Constraints):
//   - 不读写 MemoryManager —— dependencies 接口只有 readDetail / decideUse,
//     根本没有 inject / loadAllMemory 字段(failure 不触发 inject,结构性保证)。
//   - 不在 detail/use/search failure 时回退为"加载全部 Memory"(INV-E18)。
//   - 不直接生成 FRC-1 section(retrieval 只输出 claim refs,
//     FRC-1 section 组装属于更上层)。
//   - 不改变 selection(use gate 是 selection 的只读消费者,selection_id 透传)。
//   - 不把 needs_refresh 当低置信 use(它进 rejected,不进 usable)。
// ===========================================================================

/**
 * retrieval 协议版本。独立于 selection / catalog / record / use 的 protocol version。
 * 结构变化时递增。
 */
export const MEMORY_RETRIEVAL_PROTOCOL_VERSION = '1';

/**
 * retrieval integrity reason_code 常量(可枚举)。
 */
const REASON_DETAIL_MISSING = 'retrieval.detail_missing';
const REASON_DETAIL_INTEGRITY_MISMATCH = 'retrieval.detail_integrity_mismatch';

/**
 * retrieval 输入。
 *
 * selection 来自 E-1 T6 selectMemoryEntries(use gate 是 selection 的只读消费者);
 * current_context_snapshot_id 是当前 context snapshot —— use decision 必须绑定它。
 */
export interface MemoryRetrievalInput {
  retrieval_protocol_version: string;
  selection: MemorySelectionResult;
  current_context_snapshot_id: string;
}

/**
 * retrieval 依赖(注入,便于测试与 sibling 隔离)。
 *
 * 关键不变量:接口 **不含** inject / loadAllMemory / searchAll 字段 ——
 * 这是 "failure 不触发 inject 或加载全部" 的结构性保证 (INV-no-inject-on-failure)。
 * retrieveSelectedMemory 物理上无法调用 MemoryManager.inject。
 *
 * - readDetail: governed detail reader。输入 detail_commit_ref,
 *   返回 detail body 字符串或 null(缺失)。retrieveSelectedMemory 内部对返回值
 *   计算 sha256 与 entry.content_hash 比对。
 * - decideUse: DRC-2 decideMemoryUse(或符合签名的纯函数)。
 *   retrieveSelectedMemory 构造 MemoryUseInput 后调用之。
 */
export interface MemoryRetrievalDependencies {
  readDetail: (detail_commit_ref: string) => Promise<string | null>;
  decideUse: (input: MemoryUseInput) => MemoryUseDecision;
}

/**
 * 单条 entry 的 integrity 诊断。
 */
export interface MemoryRetrievalIntegrityDiagnostic {
  memory_record_id: string;
  /** retrieval.detail_missing / retrieval.detail_integrity_mismatch。 */
  reason_code: string;
}

/**
 * retrieval 输出。一旦生成就不可变。
 *
 * 关键语义:
 *   - usable_claim_refs 只含 status='use' 的 verified_claim_refs(selected ≠ use)。
 *   - rejected_record_ids 含所有 do_not_use / needs_refresh 的 entry。
 *   - integrity 失败的 entry **不**进入 use gate(不出现在 rejected 中,
 *     只在 integrity_diagnostics 中)。
 *   - selection_id / current_context_snapshot_id 保持独立(use gate 不改写 selection)。
 *   - 不含 frc_section / prompt_section / injected_content(retrieval 不直接组装 prompt)。
 */
export interface MemoryRetrievalResult {
  retrieval_protocol_version: string;
  /** 内容寻址 id:相同 input+deps 结果产生相同 retrieval_id。 */
  retrieval_id: string;
  /** 透传自 input.selection(use gate 不改写 selection)。 */
  selection_id: string;
  /** 透传自 input。 */
  current_context_snapshot_id: string;
  /** 通过 use gate 的 verified claim refs(仅 status='use')。 */
  usable_claim_refs: string[];
  /** use gate 拒绝(do_not_use / needs_refresh)的 entry record ids。 */
  rejected_record_ids: string[];
  /** integrity 失败的 entry 诊断(detail missing / mismatch)。 */
  integrity_diagnostics: ReadonlyArray<MemoryRetrievalIntegrityDiagnostic>;
  /** 顶层 reason_codes 汇总(便于下游 programmatic 消费)。 */
  reason_codes: string[];
}

/**
 * 计算 retrieval_id(内容寻址)。
 *
 * canonical 覆盖:protocol version + selection_id + current_context_snapshot_id +
 *   usable_claim_refs 序列 + rejected_record_ids 序列(已排序)+
 *   integrity_diagnostics 序列(已排序)。
 * 相同 input+deps 必产生相同 retrieval_id。
 */
function computeRetrievalId(fields: {
  selection_id: string;
  current_context_snapshot_id: string;
  usable_claim_refs: string[];
  rejected_record_ids: string[];
  integrity_diagnostics: ReadonlyArray<MemoryRetrievalIntegrityDiagnostic>;
}): string {
  // 对集合类字段先排序再入 canonical,保证不同顺序产生相同 id。
  const canonical = JSON.stringify({
    v: MEMORY_RETRIEVAL_PROTOCOL_VERSION,
    selection_id: fields.selection_id,
    current_context_snapshot_id: fields.current_context_snapshot_id,
    usable_claim_refs: [...fields.usable_claim_refs].sort(),
    rejected_record_ids: [...fields.rejected_record_ids].sort(),
    integrity_diagnostics: [...fields.integrity_diagnostics].sort((a, b) => {
      const keyA = `${a.memory_record_id}|${a.reason_code}`;
      const keyB = `${b.memory_record_id}|${b.reason_code}`;
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    }),
  });
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `retrieval:${hash.slice(0, 16)}`;
}

/**
 * 对 selected entries 执行 governed detail retrieval + current-context use gate。
 *
 * 算法(规格 Task 7):
 *   for each entry in selection.selected_entries (catalog order):
 *     1. body = await readDetail(entry.detail_commit_ref)
 *     2. body === null → integrity_diagnostics += { entry.memory_record_id, 'retrieval.detail_missing' }
 *        (不进入 use gate)
 *     3. else 验证 `sha256:${sha256(body)}` === entry.content_hash
 *        mismatch → integrity_diagnostics += { entry.memory_record_id, 'retrieval.detail_integrity_mismatch' }
 *        (不进入 use gate)
 *     4. else 构造 MemoryUseInput,调用 decideUse:
 *        - status='use' → usable_claim_refs += decision.verified_claim_refs
 *        - status='do_not_use' / 'needs_refresh' → rejected_record_ids += entry.memory_record_id
 *
 * 关键不变量(Global Constraints):
 *   - selected ≠ use:selection 通过不等于 use 通过。
 *   - failure(detail missing/mismatch / use reject / search 已在 selector 处理)
 *     均不触发 inject 或加载全部 —— dependencies 接口不含 inject/loadAll。
 *   - 不直接生成 FRC-1 section。
 *   - selection/use identity 保持独立(selection_id 透传,use decision 自有 id)。
 */
export async function retrieveSelectedMemory(
  input: MemoryRetrievalInput,
  dependencies: MemoryRetrievalDependencies,
): Promise<MemoryRetrievalResult> {
  // identity 守门。
  requireIdentity(
    input.retrieval_protocol_version,
    'retrieval_protocol_version',
  );
  requireIdentity(
    input.current_context_snapshot_id,
    'current_context_snapshot_id',
  );
  // selection identity 由 selectMemoryEntries 已守门;这里只透传 selection_id。
  requireIdentity(
    input.selection.selection_id,
    'selection.selection_id',
  );
  if (
    input.retrieval_protocol_version !== MEMORY_RETRIEVAL_PROTOCOL_VERSION
  ) {
    throw new Error(
      `retrieval_protocol_version mismatch: expected ${MEMORY_RETRIEVAL_PROTOCOL_VERSION}`,
    );
  }

  const usable_claim_refs: string[] = [];
  const rejected_record_ids: string[] = [];
  const integrity_diagnostics: MemoryRetrievalIntegrityDiagnostic[] = [];
  const reasonSet = new Set<string>();

  for (const entry of input.selection.selected_entries) {
    // 1. governed detail read。
    const body = await dependencies.readDetail(entry.detail_commit_ref);

    // 2. detail missing → integrity 诊断,不进入 use gate。
    if (body === null) {
      integrity_diagnostics.push({
        memory_record_id: entry.memory_record_id,
        reason_code: REASON_DETAIL_MISSING,
      });
      reasonSet.add(REASON_DETAIL_MISSING);
      continue;
    }

    // 3. detail integrity:对 body 计算 sha256,与 entry.content_hash 比较。
    //    规格 Step 3:"内容 hash 由调用方保证" —— 这里把"保证"实现为内部校验,
    //    catalog entry 的 content_hash 是 T5 commit 时填入的 body sha256。
    const bodyHash = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    if (bodyHash !== entry.content_hash) {
      integrity_diagnostics.push({
        memory_record_id: entry.memory_record_id,
        reason_code: REASON_DETAIL_INTEGRITY_MISMATCH,
      });
      reasonSet.add(REASON_DETAIL_INTEGRITY_MISMATCH);
      continue;
    }

    // 4. integrity 通过 → 进入 use gate。
    //    构造 MemoryUseInput:identity 字段来自 entry / input;claim-level
    //    verified/stale/conflicting 由调用方包装的 decideUse 决定(retrieval 层
    //    不读 claim body,因此 candidate_claims 传空数组,只用作 traceability 占位)。
    const useInput: MemoryUseInput = {
      memory_use_protocol_version:
        // 复用 retrieval 协议版本作为 use 协议版本占位 —— 真实 use 协议版本
        // 由调用方在包装 decideUse 时决定;这里只是构造 input 让注入的 decideUse
        // 拿到 identity。下游用 decideMemoryUse 时会再校验。
        MEMORY_RETRIEVAL_PROTOCOL_VERSION,
      stored_memory_ref: entry.memory_record_id,
      admission_decision_id: entry.admission_decision_id,
      current_context_snapshot_id: input.current_context_snapshot_id,
      project_version_ref: null,
      candidate_claims: [],
      verified_claim_refs: [],
      stale_claim_refs: [],
      conflicting_evidence_refs: [],
      verifier_available: true,
      refresh_available: false,
    };
    const decision = dependencies.decideUse(useInput);

    if (decision.status === 'use') {
      // 仅 status='use' 的 verified_claim_refs 进入 usable。
      for (const ref of decision.verified_claim_refs) {
        usable_claim_refs.push(ref);
      }
    } else {
      // do_not_use / needs_refresh 都进入 rejected。
      // needs_refresh 是独立状态,既不算 use,也不进入 prompt/behavior 依据。
      rejected_record_ids.push(entry.memory_record_id);
    }
  }

  const reason_codes = [...reasonSet].sort();
  const result: MemoryRetrievalResult = {
    retrieval_protocol_version: MEMORY_RETRIEVAL_PROTOCOL_VERSION,
    retrieval_id: computeRetrievalId({
      selection_id: input.selection.selection_id,
      current_context_snapshot_id: input.current_context_snapshot_id,
      usable_claim_refs,
      rejected_record_ids,
      integrity_diagnostics,
    }),
    selection_id: input.selection.selection_id,
    current_context_snapshot_id: input.current_context_snapshot_id,
    usable_claim_refs,
    rejected_record_ids,
    integrity_diagnostics,
    reason_codes,
  };
  return freezeSnapshot(result) as MemoryRetrievalResult;
}
