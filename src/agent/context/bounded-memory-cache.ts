/**
 * FRC-1 Task 7: Optional Snapshot Cache (规格 §7.16)。
 *
 * 这是 BoundedMemoryEntrypoint(T6)的 **可选** 两级 content-addressed cache。
 *
 * 设计要点:
 *   - 一级 semantic_input_key:由 build input 的 identity 字段决定。
 *     context/project/freshness/use decision/catalog/selection/render/budget 任一
 *     变化都会产生新的 semantic_input_key,因此自动 miss,无需显式 invalidation。
 *   - 二级 entry_key:由 semantic_key + final_section_hash 决定。
 *     empty snapshot 时 final_section_hash=null,用 'empty' 占位。
 *   - Hit 路径必须重新验证 identity:corruption(index entry 存在但 entry 不存在,
 *     或 entry identity mismatch)→ 删除损坏的 entry + rebuild。
 *   - Store 接口 sync/async 兼容:`Promise<T> | T`,统一用 await 解开。
 *   - Store 抛错 → 上抛(不静默重建)。
 *   - Cache 可整体关闭:T6/T9 可选择不传 cache,直接调用 builder。
 *
 * Cache payload 限制(规格 §7.16 step 5):
 *   只保存 immutable snapshot、rendered section、overflow/provenance manifests。
 *   严禁保存 raw_detail / bypass_source —— 类型层面由 CacheableEntrypointPayload
 *   不含这些字段来保证。
 *
 * 与 T6 的耦合:本文件定义本地 working types(Cacheable*),与 T6 的
 * BoundedMemoryEntrypointSnapshot 形状兼容。T6 接线时统一适配。
 */

import { createHash } from 'node:crypto';
import { freezeSnapshot, requireIdentity } from '../contracts/identities.js';

// ---------------------------------------------------------------------------
// 公共常量
// ---------------------------------------------------------------------------

/** Cache 协议版本号。版本变化 → semantic_input_key 变化 → 全部 miss。 */
export const CACHE_PROTOCOL_VERSION = '1';

// ---------------------------------------------------------------------------
// Working types:与 T6 输出形状兼容(本地定义,T6 接线时适配)
// ---------------------------------------------------------------------------

/**
 * 与 T6 的 BoundedMemoryEntrypointSnapshot 形状兼容。
 * `[key: string]: unknown` 允许 T6 扩展字段,但本 cache 只读取 identity 相关字段。
 */
export interface CacheableEntrypointSnapshot {
  entrypoint_protocol_version: string;
  entrypoint_snapshot_id: string;
  build_id: string;
  state: 'prepared' | 'ready' | 'empty' | 'partial' | 'rejected';
  task_snapshot_id: string;
  current_context_snapshot_id: string;
  project_version_ref: string | null;
  catalog_snapshot_id: string;
  selection_id: string;
  policy_ref: { contract_id: string; contract_version: string };
  request_budget_snapshot_id: string;
  render_profile_ref: string;
  navigation_item_refs: ReadonlyArray<string>;
  verified_claim_projection_refs: ReadonlyArray<string>;
  item_refs: ReadonlyArray<string>;
  memory_use_decision_refs: ReadonlyArray<string>;
  overflow_manifest_ref: string;
  provenance_manifest_ref: string;
  rendered_section_ref: string | null;
  rendered_section_hash: string | null;
  bytes_included: number;
  lines_included: number;
  estimated_tokens: number | null;
  token_estimator_ref: string | null;
  created_at: string;
  reason_codes: ReadonlyArray<string>;
  [key: string]: unknown;
}

export interface CacheableRenderedSection {
  section_id: 'memory.bounded_entrypoint';
  authority: 'memory';
  placement: 'system_dynamic';
  asset_ref: { asset_id: string; asset_version: string };
  content: string;
  content_hash: string;
  bytes: number;
  lines: number;
  overflow_manifest_ref: string | null;
  provenance_manifest_ref: string;
}

export interface CacheableOverflowManifest {
  overflow_protocol_version: string;
  overflow_manifest_id: string;
  truncated: boolean;
  navigation_overflowed: boolean;
  verified_detail_overflowed: boolean;
  total_budget_overflowed: boolean;
  omitted_records: ReadonlyArray<unknown>;
  omitted_claim_refs: ReadonlyArray<unknown>;
  budget_policy_refs: ReadonlyArray<string>;
  [key: string]: unknown;
}

export interface CacheableProvenanceManifest {
  provenance_protocol_version: string;
  provenance_manifest_id: string;
  provenance_refs: ReadonlyArray<string>;
  freshness_refs: ReadonlyArray<string>;
  [key: string]: unknown;
}

/**
 * Cache payload —— 严格不含 raw_detail / bypass_source。
 * 顶层只有 4 个字段:snapshot / rendered_section / overflow_manifest / provenance_manifest。
 */
export interface CacheableEntrypointPayload {
  snapshot: CacheableEntrypointSnapshot;
  rendered_section: CacheableRenderedSection | null;
  overflow_manifest: CacheableOverflowManifest;
  provenance_manifest: CacheableProvenanceManifest;
}

// ---------------------------------------------------------------------------
// Cache identity input
// ---------------------------------------------------------------------------

/**
 * 一级 cache identity 输入。等价于 build input 的 identity 字段,由 T6 调用方构造。
 * 任一字段变化 → 新的 semantic_input_key → 自动 miss。
 */
export interface MemoryEntrypointCacheInput {
  entrypoint_protocol_version: string;
  entrypoint_policy_version: string;
  task_snapshot_id: string;
  current_context_snapshot_id: string;
  project_version_ref: string | null;
  catalog_snapshot_id: string;
  catalog_hash: string;
  selection_id: string;
  /** 排序后参与 key(顺序无关) */
  memory_use_decision_ids: ReadonlyArray<string>;
  render_profile_ref: string;
  navigation_budget_policy_ref: string;
  verified_detail_budget_policy_ref: string;
  total_section_budget_policy_ref: string;
  /** 不可变部分:最终 section hash(二级 key 用)。null 表示 empty snapshot。 */
  final_section_hash: string | null;
}

/**
 * Cache 句柄。实现细节(一级 index / 二级 entry)私有,通过 get/put/clear 暴露。
 */
export interface MemoryEntrypointCache {
  cache_protocol_version: string;
  cache_id: string;
  /**
   * 暴露 store 给 cache 实现内部使用。`internal` 前缀表示外部不应依赖,
   * 调用方应只使用 getOrBuildMemoryEntrypoint / clear。
   */
  readonly internal: {
    store: MemoryEntrypointCacheStore;
    cache_id: string;
  };
  /** 清空整个 cache(index + entries)。 */
  clear(): Promise<void>;
}

/**
 * Cache 后端存储。每个方法返回 `Promise<T> | T`,实现 sync/async 兼容。
 * 调用方用 await 解开即可。
 */
export interface MemoryEntrypointCacheStore {
  getIndexEntry(semantic_input_key: string): Promise<string | null> | string | null;
  putIndexEntry(semantic_input_key: string, entry_key: string): Promise<void> | void;
  getEntry(entry_key: string): Promise<CacheableEntrypointPayload | null> | CacheableEntrypointPayload | null;
  putEntry(entry_key: string, payload: CacheableEntrypointPayload): Promise<void> | void;
  deleteEntry(entry_key: string): Promise<void> | void;
  clear(): Promise<void> | void;
}

export type MemoryEntrypointCacheBuilder = (
  input: MemoryEntrypointCacheInput,
) => Promise<CacheableEntrypointPayload> | CacheableEntrypointPayload;

export interface GetOrBuildResult {
  hit: boolean;
  /** hit 时来自 store;miss 时来自 builder。语义上深相等(由 cache contract 保证)。 */
  payload: CacheableEntrypointPayload;
  /** corruption 导致重建时 true */
  rebuilt: boolean;
  reason_codes: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// 内部工具:SHA-256 哈希
// ---------------------------------------------------------------------------

/** 计算 SHA-256 十六进制摘要(小写)。 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// 一级 / 二级 cache identity 计算(规格 §7.16 step 3)
// ---------------------------------------------------------------------------

/**
 * 一级 semantic_input_key。
 *
 * 由所有 identity 字段拼成规范串后取 SHA-256 前 32 位 hex。
 * 32 位(128 bit)足以在实践中保证唯一性。
 *
 * 注意 memory_use_decision_ids 先排序再 join,因此顺序无关。
 */
export function computeSemanticInputKey(input: MemoryEntrypointCacheInput): string {
  // identity 字段必须非空(允许为 null 的字段除外:project_version_ref)
  requireIdentity(input.entrypoint_protocol_version, 'entrypoint_protocol_version');
  requireIdentity(input.entrypoint_policy_version, 'entrypoint_policy_version');
  requireIdentity(input.task_snapshot_id, 'task_snapshot_id');
  requireIdentity(input.current_context_snapshot_id, 'current_context_snapshot_id');
  // project_version_ref 允许 null
  requireIdentity(input.catalog_snapshot_id, 'catalog_snapshot_id');
  requireIdentity(input.catalog_hash, 'catalog_hash');
  requireIdentity(input.selection_id, 'selection_id');
  requireIdentity(input.render_profile_ref, 'render_profile_ref');
  requireIdentity(input.navigation_budget_policy_ref, 'navigation_budget_policy_ref');
  requireIdentity(input.verified_detail_budget_policy_ref, 'verified_detail_budget_policy_ref');
  requireIdentity(input.total_section_budget_policy_ref, 'total_section_budget_policy_ref');

  // 排序后的 use decision IDs(顺序无关)
  const sortedDecisionIds = [...input.memory_use_decision_ids].sort().join(',');

  const parts: ReadonlyArray<string> = [
    input.entrypoint_protocol_version,
    input.entrypoint_policy_version,
    input.task_snapshot_id,
    input.current_context_snapshot_id,
    input.project_version_ref ?? 'null',
    input.catalog_snapshot_id,
    input.catalog_hash,
    input.selection_id,
    sortedDecisionIds,
    input.render_profile_ref,
    input.navigation_budget_policy_ref,
    input.verified_detail_budget_policy_ref,
    input.total_section_budget_policy_ref,
  ];
  const canonical = parts.join('|');
  return 'semk:' + sha256(canonical).slice(0, 32);
}

/**
 * 二级 entry_key。
 *
 * 由 semantic_key + final_section_hash 决定。final_section_hash 为 null 时
 * 用 'empty' 占位,确保 empty snapshot 仍可命中。
 */
export function computeEntryKey(semantic_key: string, final_section_hash: string | null): string {
  const final_hash = final_section_hash ?? 'empty';
  return 'entk:' + sha256(semantic_key + ':' + final_hash).slice(0, 32);
}

// ---------------------------------------------------------------------------
// Cache 创建
// ---------------------------------------------------------------------------

/**
 * 冻结一个 payload(深冻结),用于写入 store 前保护不可变性。
 *
 * 这确保存入 cache 的 snapshot 即使被外部引用也无法被篡改,
 * 从而 cache hit 路径的 identity 校验才有意义。
 */
function freezePayload(payload: CacheableEntrypointPayload): CacheableEntrypointPayload {
  return freezeSnapshot(payload) as CacheableEntrypointPayload;
}

/**
 * 创建一个 cache 句柄。store 由调用方注入(可以是 in-memory / disk / remote)。
 * cache_id 由协议版本 + 随机熵构成,用于日志/诊断。
 */
export function createMemoryEntrypointCache(store: MemoryEntrypointCacheStore): MemoryEntrypointCache {
  // cache_id:协议版本 + 时间戳 + 随机熵,保证唯一性
  const cache_id = `cache:${CACHE_PROTOCOL_VERSION}:${Date.now().toString(36)}:${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  const cache: MemoryEntrypointCache = {
    cache_protocol_version: CACHE_PROTOCOL_VERSION,
    cache_id,
    internal: { store, cache_id },
    async clear() {
      await store.clear();
    },
  };
  // 注意:不使用 freezeSnapshot(cache) —— 那会递归冻结注入的 store,
  // 而 store 属于调用方,可能带有可变内部状态(LRU 顺序、计数器等)。
  // cache 句柄本身只是 store + cache_id 的轻量包装,语义上不可变。
  return cache;
}

// ---------------------------------------------------------------------------
// Hit 路径:重新验证 rendered section hash
// ---------------------------------------------------------------------------

/**
 * 校验 payload 内部一致性:如果 rendered_section 非 null,
 * snapshot.rendered_section_hash 应当与 rendered_section.content_hash 一致。
 *
 * 这道校验捕捉"rendered_section 被篡改但 snapshot 字段未同步"的损坏。
 * 当 rendered_section 为 null 时,要求 snapshot.rendered_section_hash 也为 null。
 */
function verifyRenderedContentHash(payload: CacheableEntrypointPayload): boolean {
  const snapHash = payload.snapshot.rendered_section_hash;
  const section = payload.rendered_section;
  if (section === null) {
    // empty snapshot:hash 应为 null
    return snapHash === null;
  }
  // 非 empty:hash 应与 rendered section 的 content_hash 一致
  return typeof snapHash === 'string' && snapHash === section.content_hash;
}

// ---------------------------------------------------------------------------
// 核心:getOrBuild(规格 §7.16 step 3)
// ---------------------------------------------------------------------------

/**
 * 查询 cache;命中则返回(并重新验证 identity),未命中则调用 builder 重建并写入。
 *
 * Corruption 处理(规格 §7.16 step 7):
 *   - index entry 存在但 entry 不存在 → 删除 index entry,rebuild,
 *     reason_codes 记 'cache.corruption.entry_missing'。
 *   - entry 存在但 identity mismatch(entry_key 或 protocol_version 不一致,
 *     或 rendered section hash 校验失败)→ 删除 entry,rebuild,
 *     reason_codes 记 'cache.corruption.identity_mismatch'。
 *   - store 抛错 → 直接上抛(不静默重建)。
 *
 * 注意:命中路径不返回 reason_codes(空数组);corruption 路径返回 reason_codes
 * 描述损坏类型。普通 miss(rebuilt 由 input 变化导致)的 reason_codes 也为空,
 * 以保持"reason_codes 只描述本 cache 实例观察到的异常"的语义。
 */
export async function getOrBuildMemoryEntrypoint(
  input: MemoryEntrypointCacheInput,
  cache: MemoryEntrypointCache,
  builder: MemoryEntrypointCacheBuilder,
): Promise<GetOrBuildResult> {
  const store = cache.internal.store;
  const semk = computeSemanticInputKey(input);

  // 查 index
  const entk_from_index = await store.getIndexEntry(semk);

  if (entk_from_index !== null) {
    const payload = await store.getEntry(entk_from_index);
    if (payload !== null) {
      // 重新验证 identity(规格 §7.16 step 3 最后一段)
      const recomputed_entk = computeEntryKey(semk, payload.snapshot.rendered_section_hash);
      if (
        recomputed_entk === entk_from_index &&
        payload.snapshot.entrypoint_protocol_version === input.entrypoint_protocol_version &&
        verifyRenderedContentHash(payload)
      ) {
        // Cache hit,语义完整
        return { hit: true, payload, rebuilt: false, reason_codes: [] };
      }
      // corruption:identity mismatch → 删除损坏 entry,rebuild
      await store.deleteEntry(entk_from_index);
      const rebuilt_payload = freezePayload(await builder(input));
      const entk = computeEntryKey(semk, rebuilt_payload.snapshot.rendered_section_hash);
      // index 指向新的 entry_key,覆盖旧的损坏引用
      await store.putIndexEntry(semk, entk);
      await store.putEntry(entk, rebuilt_payload);
      return {
        hit: false,
        payload: rebuilt_payload,
        rebuilt: true,
        reason_codes: ['cache.corruption.identity_mismatch'],
      };
    }
    // corruption:index entry 存在但 entry 不存在 → rebuild
    // (无需单独清理 index entry;下方 putIndexEntry 会用新的 entry_key 覆盖。)
    const rebuilt_payload = freezePayload(await builder(input));
    const entk = computeEntryKey(semk, rebuilt_payload.snapshot.rendered_section_hash);
    await store.putIndexEntry(semk, entk);
    await store.putEntry(entk, rebuilt_payload);
    return {
      hit: false,
      payload: rebuilt_payload,
      rebuilt: true,
      reason_codes: ['cache.corruption.entry_missing'],
    };
  }

  // 普通 miss:rebuild 并写入
  const payload = freezePayload(await builder(input));
  const entk = computeEntryKey(semk, payload.snapshot.rendered_section_hash);
  await store.putIndexEntry(semk, entk);
  await store.putEntry(entk, payload);
  return { hit: false, payload, rebuilt: true, reason_codes: [] };
}
