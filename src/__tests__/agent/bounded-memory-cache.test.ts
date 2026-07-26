import { describe, expect, it, vi } from 'vitest';
import {
  CACHE_PROTOCOL_VERSION,
  computeEntryKey,
  computeSemanticInputKey,
  createMemoryEntrypointCache,
  getOrBuildMemoryEntrypoint,
  type CacheableEntrypointPayload,
  type CacheableEntrypointSnapshot,
  type CacheableOverflowManifest,
  type CacheableProvenanceManifest,
  type CacheableRenderedSection,
  type MemoryEntrypointCacheBuilder,
  type MemoryEntrypointCacheInput,
  type MemoryEntrypointCacheStore,
} from '../../agent/context/bounded-memory-cache.js';

// ---------------------------------------------------------------------------
// FRC-1 Task 7: Optional Snapshot Cache (spec §7.16).
//
// 两级 content-addressed cache identity:
//   - 一级 semantic_input_key:由 build input 的 identity 字段决定,任一变化 → 新 key → miss
//   - 二级 entry_key:semantic_key + final_section_hash 决定
//
// Hit 路径必须重新验证 identity;corruption → 删除 entry + rebuild;
// payload 严格不含 raw_detail / bypass_source 字段。
// ---------------------------------------------------------------------------

// ---- 工具:构造合法的 input / payload ----

function makeBaseInput(overrides: Partial<MemoryEntrypointCacheInput> = {}): MemoryEntrypointCacheInput {
  return {
    entrypoint_protocol_version: '1',
    entrypoint_policy_version: '1',
    task_snapshot_id: 'task-snap-1',
    current_context_snapshot_id: 'ctx-snap-1',
    project_version_ref: 'proj:1',
    catalog_snapshot_id: 'catalog-1',
    catalog_hash: 'hash-catalog-1',
    selection_id: 'sel-1',
    memory_use_decision_ids: ['dec-1', 'dec-2'],
    render_profile_ref: 'render-profile:1',
    navigation_budget_policy_ref: 'budget:nav:1',
    verified_detail_budget_policy_ref: 'budget:detail:1',
    total_section_budget_policy_ref: 'budget:total:1',
    final_section_hash: 'hash-section-final',
    ...overrides,
  };
}

function makeOverflowManifest(overrides: Partial<CacheableOverflowManifest> = {}): CacheableOverflowManifest {
  return {
    overflow_protocol_version: '1',
    overflow_manifest_id: 'overflow-1',
    truncated: false,
    navigation_overflowed: false,
    verified_detail_overflowed: false,
    total_budget_overflowed: false,
    omitted_records: [],
    omitted_claim_refs: [],
    budget_policy_refs: ['budget:nav:1'],
    ...overrides,
  };
}

function makeProvenanceManifest(
  overrides: Partial<CacheableProvenanceManifest> = {},
): CacheableProvenanceManifest {
  return {
    provenance_protocol_version: '1',
    provenance_manifest_id: 'prov-1',
    provenance_refs: ['prov:src:1'],
    freshness_refs: ['fresh:1'],
    ...overrides,
  };
}

function makeRenderedSection(
  overrides: Partial<CacheableRenderedSection> = {},
): CacheableRenderedSection {
  return {
    section_id: 'memory.bounded_entrypoint',
    authority: 'memory',
    placement: 'system_dynamic',
    asset_ref: { asset_id: 'memory.bounded_entrypoint', asset_version: '1' },
    content: '## Memory\n- item 1',
    content_hash: 'hash-section-final',
    bytes: 20,
    lines: 2,
    overflow_manifest_ref: 'overflow-1',
    provenance_manifest_ref: 'prov-1',
    ...overrides,
  };
}

function makeSnapshot(
  overrides: Partial<CacheableEntrypointSnapshot> = {},
): CacheableEntrypointSnapshot {
  return {
    entrypoint_protocol_version: '1',
    entrypoint_snapshot_id: 'esnap-1',
    build_id: 'build-1',
    state: 'ready',
    task_snapshot_id: 'task-snap-1',
    current_context_snapshot_id: 'ctx-snap-1',
    project_version_ref: 'proj:1',
    catalog_snapshot_id: 'catalog-1',
    selection_id: 'sel-1',
    policy_ref: { contract_id: 'memory.entrypoint', contract_version: '1' },
    request_budget_snapshot_id: 'budget-snap-1',
    render_profile_ref: 'render-profile:1',
    navigation_item_refs: ['nav:1'],
    verified_claim_projection_refs: ['claim:1'],
    item_refs: ['item:1'],
    memory_use_decision_refs: ['dec-1', 'dec-2'],
    overflow_manifest_ref: 'overflow-1',
    provenance_manifest_ref: 'prov-1',
    rendered_section_ref: 'rendered:1',
    rendered_section_hash: 'hash-section-final',
    bytes_included: 100,
    lines_included: 5,
    estimated_tokens: 50,
    token_estimator_ref: 'est:1',
    created_at: '2026-07-26T00:00:00.000Z',
    reason_codes: [],
    ...overrides,
  };
}

function makePayload(overrides: Partial<CacheableEntrypointPayload> = {}): CacheableEntrypointPayload {
  return {
    snapshot: makeSnapshot(),
    rendered_section: makeRenderedSection(),
    overflow_manifest: makeOverflowManifest(),
    provenance_manifest: makeProvenanceManifest(),
    ...overrides,
  };
}

// ---- 测试用 in-memory store,可注入各种故障 ----

interface InMemoryStore extends MemoryEntrypointCacheStore {
  index: Map<string, string>;
  entries: Map<string, CacheableEntrypointPayload>;
  // 用于测试观察
  getIndexEntryCalls: number;
  putIndexEntryCalls: number;
  getEntryCalls: number;
  putEntryCalls: number;
  deleteEntryCalls: number;
  clearCalls: number;
}

function createStore(): InMemoryStore {
  return {
    index: new Map(),
    entries: new Map(),
    getIndexEntryCalls: 0,
    putIndexEntryCalls: 0,
    getEntryCalls: 0,
    putEntryCalls: 0,
    deleteEntryCalls: 0,
    clearCalls: 0,
    getIndexEntry(semk: string) {
      this.getIndexEntryCalls++;
      return this.index.get(semk) ?? null;
    },
    putIndexEntry(semk: string, entk: string) {
      this.putIndexEntryCalls++;
      this.index.set(semk, entk);
    },
    getEntry(entk: string) {
      this.getEntryCalls++;
      return this.entries.get(entk) ?? null;
    },
    putEntry(entk: string, payload: CacheableEntrypointPayload) {
      this.putEntryCalls++;
      this.entries.set(entk, payload);
    },
    deleteEntry(entk: string) {
      this.deleteEntryCalls++;
      this.entries.delete(entk);
    },
    clear() {
      this.clearCalls++;
      this.index.clear();
      this.entries.clear();
    },
  };
}

// ===========================================================================
describe('FRC-1 T7: Optional Snapshot Cache', () => {
  // -------------------------------------------------------------------------
  // 公共常量与导出
  // -------------------------------------------------------------------------

  it('exports CACHE_PROTOCOL_VERSION = "1"', () => {
    expect(CACHE_PROTOCOL_VERSION).toBe('1');
  });

  it('exports computeSemanticInputKey and computeEntryKey as functions', () => {
    expect(computeSemanticInputKey).toBeTypeOf('function');
    expect(computeEntryKey).toBeTypeOf('function');
  });

  it('createMemoryEntrypointCache returns a cache object', () => {
    const cache = createMemoryEntrypointCache(createStore());
    expect(cache).toBeTypeOf('object');
    expect(cache.cache_protocol_version).toBe('1');
    expect(typeof cache.cache_id).toBe('string');
    expect(cache.cache_id.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 1. hit/rebuild 深相等
  // -------------------------------------------------------------------------

  it('produces toEqual-equal payloads on cache hit and rebuild for the same input', async () => {
    const store = createStore();
    const cache = createMemoryEntrypointCache(store);
    const payload = makePayload();
    const builder = vi.fn(async () => payload);

    // 第一次:miss → 重建
    const r1 = await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);
    expect(r1.hit).toBe(false);
    expect(r1.rebuilt).toBe(true);
    expect(r1.payload).toEqual(payload);

    // 第二次:相同 input → hit
    builder.mockClear();
    const r2 = await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);
    expect(r2.hit).toBe(true);
    expect(r2.rebuilt).toBe(false);
    expect(builder).not.toHaveBeenCalled();
    // 深相等
    expect(r2.payload).toEqual(r1.payload);
  });

  // -------------------------------------------------------------------------
  // 2. miss → put → hit:第一次 miss + builder 调用,第二次 hit + builder 不调用
  // -------------------------------------------------------------------------

  it('first call misses and invokes builder; second call hits without invoking builder', async () => {
    const store = createStore();
    const cache = createMemoryEntrypointCache(store);
    const payload = makePayload();
    const builder = vi.fn(async () => payload);

    const r1 = await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);
    expect(r1.hit).toBe(false);
    expect(builder).toHaveBeenCalledTimes(1);

    builder.mockClear();
    const r2 = await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);
    expect(r2.hit).toBe(true);
    expect(builder).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3 ~ 6: identity 字段变化 → miss
  // -------------------------------------------------------------------------

  it('misses when current_context_snapshot_id changes', async () => {
    const store = createStore();
    const cache = createMemoryEntrypointCache(store);
    const builder = vi.fn(async () => makePayload());

    await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);
    builder.mockClear();

    const r2 = await getOrBuildMemoryEntrypoint(
      makeBaseInput({ current_context_snapshot_id: 'ctx-snap-2' }),
      cache,
      builder,
    );
    expect(r2.hit).toBe(false);
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it('misses when project_version_ref changes', async () => {
    const store = createStore();
    const cache = createMemoryEntrypointCache(store);
    const builder = vi.fn(async () => makePayload());

    await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);
    builder.mockClear();

    const r2 = await getOrBuildMemoryEntrypoint(
      makeBaseInput({ project_version_ref: 'proj:2' }),
      cache,
      builder,
    );
    expect(r2.hit).toBe(false);
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it('misses when catalog_snapshot_id changes', async () => {
    const store = createStore();
    const cache = createMemoryEntrypointCache(store);
    const builder = vi.fn(async () => makePayload());

    await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);
    builder.mockClear();

    const r2 = await getOrBuildMemoryEntrypoint(
      makeBaseInput({ catalog_snapshot_id: 'catalog-2' }),
      cache,
      builder,
    );
    expect(r2.hit).toBe(false);
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it('misses when selection_id changes', async () => {
    const store = createStore();
    const cache = createMemoryEntrypointCache(store);
    const builder = vi.fn(async () => makePayload());

    await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);
    builder.mockClear();

    const r2 = await getOrBuildMemoryEntrypoint(
      makeBaseInput({ selection_id: 'sel-2' }),
      cache,
      builder,
    );
    expect(r2.hit).toBe(false);
    expect(builder).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 7 & 8: memory_use_decision_ids 排序比较
  // -------------------------------------------------------------------------

  it('misses when memory_use_decision_ids content changes', async () => {
    const store = createStore();
    const cache = createMemoryEntrypointCache(store);
    const builder = vi.fn(async () => makePayload());

    await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);
    builder.mockClear();

    const r2 = await getOrBuildMemoryEntrypoint(
      makeBaseInput({ memory_use_decision_ids: ['dec-1', 'dec-3'] }),
      cache,
      builder,
    );
    expect(r2.hit).toBe(false);
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it('hits when memory_use_decision_ids order differs but content is identical', async () => {
    const store = createStore();
    const cache = createMemoryEntrypointCache(store);
    const builder = vi.fn(async () => makePayload());

    // 原始顺序 ['dec-1', 'dec-2']
    await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);
    builder.mockClear();

    // 反序 ['dec-2', 'dec-1'] —— 应当 hit
    const r2 = await getOrBuildMemoryEntrypoint(
      makeBaseInput({ memory_use_decision_ids: ['dec-2', 'dec-1'] }),
      cache,
      builder,
    );
    expect(r2.hit).toBe(true);
    expect(builder).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 9. corruption - index entry 存在但 entry 不存在 → rebuild
  // -------------------------------------------------------------------------

  it('rebuilds and reports cache.corruption.entry_missing when index entry exists but payload is gone', async () => {
    const store = createStore();
    const cache = createMemoryEntrypointCache(store);
    const builder = vi.fn(async () => makePayload());

    // 先正常填充 cache
    await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);

    // 手动破坏:删除 entry payload,但保留 index entry
    expect(store.index.size).toBe(1);
    const semk = [...store.index.keys()][0]!;
    const entk = store.index.get(semk)!;
    store.entries.delete(entk);
    expect(store.index.get(semk)).toBe(entk); // index entry 仍存在
    expect(store.entries.has(entk)).toBe(false); // entry 已删

    builder.mockClear();
    const r = await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);
    expect(r.hit).toBe(false);
    expect(r.rebuilt).toBe(true);
    expect(r.reason_codes).toContain('cache.corruption.entry_missing');
    expect(builder).toHaveBeenCalledTimes(1);
    // 重建后 index 与 entry 应已恢复一致
    expect(store.entries.has(store.index.get(semk)!)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 10. corruption - entry identity mismatch → rebuild + delete corrupted
  // -------------------------------------------------------------------------

  it('rebuilds and deletes corrupted entry when stored payload identity mismatches', async () => {
    const store = createStore();
    const cache = createMemoryEntrypointCache(store);
    const builder = vi.fn(async () => makePayload());

    // 先正常填充 cache
    await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);

    const semk = [...store.index.keys()][0]!;
    const entk = store.index.get(semk)!;
    const original = store.entries.get(entk)!;

    // 篡改 payload 的 rendered_section_hash,使 recomputed entry_key 与存储的 entk 不一致
    const tampered: CacheableEntrypointPayload = {
      ...original,
      snapshot: { ...original.snapshot, rendered_section_hash: 'hash-tampered' },
    };
    store.entries.set(entk, tampered);

    builder.mockClear();
    const r = await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);
    expect(r.hit).toBe(false);
    expect(r.rebuilt).toBe(true);
    expect(r.reason_codes).toContain('cache.corruption.identity_mismatch');
    expect(builder).toHaveBeenCalledTimes(1);

    // 损坏的(tampered)entry 必须不再保留:重建后存储的 payload 不应是 tampered 版本。
    // 注意:重建会以 input.final_section_hash 为准重新计算 entk;
    // 因为 input 未变(仍是 'hash-section-final'),新 entk 与原 entk 相同。
    // 因此正确断言是:store 中此 entk 现在持有的是 builder 产出的非篡改 payload。
    const stored = store.entries.get(entk);
    expect(stored).toBeDefined();
    expect(stored).not.toBe(tampered);
    expect(stored!.snapshot.rendered_section_hash).toBe('hash-section-final');
  });

  it('rebuilds and reports identity_mismatch when rendered_section.content_hash diverges from snapshot.rendered_section_hash', async () => {
    // 另一种 corruption 路径:section hash 校验失败(verifyRenderedContentHash 返回 false)
    const store = createStore();
    const cache = createMemoryEntrypointCache(store);
    const builder = vi.fn(async () => makePayload());

    await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);

    const semk = [...store.index.keys()][0]!;
    const entk = store.index.get(semk)!;
    const original = store.entries.get(entk)!;

    // 篡改 rendered_section 的 content_hash(但保留 snapshot.rendered_section_hash)
    // → verifyRenderedContentHash 失败
    const tampered: CacheableEntrypointPayload = {
      ...original,
      rendered_section: {
        ...(original.rendered_section as CacheableRenderedSection),
        content_hash: 'hash-divergent',
      },
    };
    store.entries.set(entk, tampered);

    builder.mockClear();
    const r = await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);
    expect(r.hit).toBe(false);
    expect(r.rebuilt).toBe(true);
    expect(r.reason_codes).toContain('cache.corruption.identity_mismatch');
    expect(builder).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 11. cache.clear() 后 → rebuild
  // -------------------------------------------------------------------------

  it('rebuilds after cache.clear()', async () => {
    const store = createStore();
    const cache = createMemoryEntrypointCache(store);
    const builder = vi.fn(async () => makePayload());

    await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);
    expect(store.clearCalls).toBe(0);

    await cache.clear();
    expect(store.clearCalls).toBe(1);
    expect(store.index.size).toBe(0);
    expect(store.entries.size).toBe(0);

    builder.mockClear();
    const r = await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);
    expect(r.hit).toBe(false);
    expect(r.rebuilt).toBe(true);
    expect(builder).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 12. snapshot 字段(rendered_section_hash)变化 → 产生新 entry_key
  // -------------------------------------------------------------------------

  it('produces different entry keys for different rendered_section_hash values', () => {
    const semk = computeSemanticInputKey(makeBaseInput());
    const entkA = computeEntryKey(semk, 'hash-A');
    const entkB = computeEntryKey(semk, 'hash-B');
    expect(entkA).not.toBe(entkB);
    expect(entkA.startsWith('entk:')).toBe(true);
    expect(entkB.startsWith('entk:')).toBe(true);
  });

  it('re-hits when rebuilt payload has the same rendered_section_hash', async () => {
    // 辅助:验证 entry key 由 final_section_hash 二级决定
    const store = createStore();
    const cache = createMemoryEntrypointCache(store);

    // builder 产出固定 hash-A
    const currentHash = 'hash-A';
    const builder = vi.fn(async () =>
      makePayload({
        snapshot: makeSnapshot({ rendered_section_hash: currentHash }),
        rendered_section: makeRenderedSection({ content_hash: currentHash }),
      }),
    );

    const r1 = await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);
    expect(r1.hit).toBe(false);

    // 同 input + 同 hash → hit
    builder.mockClear();
    const r2 = await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);
    expect(r2.hit).toBe(true);
    expect(builder).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 13. final_section_hash=null(empty snapshot)→ 用 'empty' 占位,仍可 hit
  // -------------------------------------------------------------------------

  it('uses "empty" placeholder when final_section_hash is null and still hits on second call', async () => {
    const store = createStore();
    const cache = createMemoryEntrypointCache(store);
    const emptyPayload = makePayload({
      snapshot: makeSnapshot({ state: 'empty', rendered_section_hash: null, rendered_section_ref: null }),
      rendered_section: null,
    });
    const builder = vi.fn(async () => emptyPayload);

    const input = makeBaseInput({ final_section_hash: null });

    const r1 = await getOrBuildMemoryEntrypoint(input, cache, builder);
    expect(r1.hit).toBe(false);
    expect(r1.payload.snapshot.rendered_section_hash).toBeNull();

    builder.mockClear();
    const r2 = await getOrBuildMemoryEntrypoint(input, cache, builder);
    expect(r2.hit).toBe(true);
    expect(builder).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 14. 不保存 bypass source:payload 类型约束
  // -------------------------------------------------------------------------

  it('CacheableEntrypointPayload type does not accept raw_detail field (compile-time constraint)', () => {
    // 这是类型层面的约束 —— 我们构造一个合法 payload,然后断言它能正常 round-trip。
    // raw_detail / bypass_source 不在类型定义中;若添加,TypeScript 会报错(由 typecheck 保证)。
    const payload: CacheableEntrypointPayload = makePayload();
    // 检查类型中"未声明" raw_detail(运行时确认构造器未注入此字段)
    expect('raw_detail' in payload).toBe(false);
    expect('bypass_source' in payload).toBe(false);
    expect('raw_detail' in payload.snapshot).toBe(false);
    expect('bypass_source' in payload.snapshot).toBe(false);

    // payload 应当只包含 spec §7.16 step 5 允许的顶层字段
    const allowedTopLevel = new Set([
      'snapshot',
      'rendered_section',
      'overflow_manifest',
      'provenance_manifest',
    ]);
    for (const key of Object.keys(payload)) {
      expect(allowedTopLevel.has(key)).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // 补充:协议版本变化也应当 miss
  // -------------------------------------------------------------------------

  it('misses when entrypoint_protocol_version changes', async () => {
    const store = createStore();
    const cache = createMemoryEntrypointCache(store);
    const builder = vi.fn(async () => makePayload());

    await getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder);
    builder.mockClear();

    const r2 = await getOrBuildMemoryEntrypoint(
      makeBaseInput({ entrypoint_protocol_version: '2' }),
      cache,
      builder,
    );
    expect(r2.hit).toBe(false);
    expect(builder).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 补充:store 抛错时上抛(不静默重建)
  // -------------------------------------------------------------------------

  it('propagates store errors instead of silently rebuilding', async () => {
    const failingStore: MemoryEntrypointCacheStore = {
      getIndexEntry: () => {
        throw new Error('store io error');
      },
      putIndexEntry: () => {},
      getEntry: () => null,
      putEntry: () => {},
      deleteEntry: () => {},
      clear: () => {},
    };
    const cache = createMemoryEntrypointCache(failingStore);
    const builder = vi.fn(async () => makePayload());

    await expect(getOrBuildMemoryEntrypoint(makeBaseInput(), cache, builder)).rejects.toThrow(
      'store io error',
    );
    expect(builder).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 补充:cache identity 字符串格式
  // -------------------------------------------------------------------------

  it('produces semantic keys with "semk:" prefix and entry keys with "entk:" prefix', () => {
    const semk = computeSemanticInputKey(makeBaseInput());
    expect(semk.startsWith('semk:')).toBe(true);
    // 32-hex 后缀
    expect(semk.slice('semk:'.length)).toMatch(/^[0-9a-f]{32}$/);

    const entk = computeEntryKey(semk, 'hash-A');
    expect(entk.startsWith('entk:')).toBe(true);
    expect(entk.slice('entk:'.length)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('produces identical semantic keys for identical inputs', () => {
    const a = computeSemanticInputKey(makeBaseInput());
    const b = computeSemanticInputKey(makeBaseInput());
    expect(a).toBe(b);
  });

  // -------------------------------------------------------------------------
  // 补充:cache 可整体关闭(builder 直接调用)
  // -------------------------------------------------------------------------

  it('caller can skip cache entirely by invoking builder directly (cache is optional)', async () => {
    // T6/T9 可以不传 cache,直接调用 builder。这里验证 builder 单独工作。
    const payload = makePayload();
    const builder: MemoryEntrypointCacheBuilder = vi.fn(async () => payload);

    const result = await builder(makeBaseInput());
    expect(result).toEqual(payload);
    expect(builder).toHaveBeenCalledTimes(1);
  });
});
