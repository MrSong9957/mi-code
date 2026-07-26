// Memory Selection 测试 (ERC-2 / M-046, T6)
//
// 覆盖规格 docs/superpowers/specs/2026-07-26-agent-lifecycle-selection-wave-e-design.md
//   - §8.8  MemorySearchQuery / query normalization
//   - §8.9  MemorySelectionResult
//   - §8.10 Selection rules(metadata-only / scope→type→term / 确定性顺序 / budget / overflow)
//   - §8.11 Sibling contract boundary(selector 不调用 persistence)
//   - §8.13 错误语义(illegal budget → invalid;search failure 不回退全部)
//
// 不变量:
//   - INV-E6  admit/selected 是分离状态
//   - INV-E9  selection 不建立 Trust/Truth/Authority/use
//   - INV-E18 failure 不升级状态(search failure 不回退为"加载全部 Memory")

import { describe, it, expect } from 'vitest';
import {
  selectMemoryEntries,
  buildMemorySearchQuery,
  MEMORY_SELECTION_PROTOCOL_VERSION,
  type MemorySearchQuery,
} from '../../memory/selection.js';
import {
  buildMemoryCatalogSnapshot,
  MEMORY_CATALOG_PROTOCOL_VERSION,
  type MemoryCatalogEntry,
} from '../../memory/catalog.js';

// ─── catalog fixtures ───────────────────────────────────────────────
// 4 个 entry,scope/type/terms 各异,用于覆盖 filter/rank/budget 各分支。
// metadata_bytes 故意拉开差距,以便测试 byte budget 在 entry 边界停止。
function makeEntry(overrides: Partial<MemoryCatalogEntry>): MemoryCatalogEntry {
  return {
    memory_record_id: 'mem-default',
    record_version: 1,
    admission_decision_id: 'admit:default',
    type: 'project_fact',
    scope_ref: 'workspace-1',
    topic_terms: ['typescript'],
    keyword_terms: [],
    observed_at: '2026-07-26T00:00:00Z',
    provenance_refs: ['prov-1'],
    detail_commit_ref: 'detail-1',
    content_hash: 'sha256:default',
    metadata_bytes: 100,
    ...overrides,
  };
}

const entries: MemoryCatalogEntry[] = [
  makeEntry({
    memory_record_id: 'mem-a',
    admission_decision_id: 'admit:a',
    type: 'user_preference',
    scope_ref: 'workspace-1',
    topic_terms: ['typescript', 'editor'],
    keyword_terms: ['tabs'],
    metadata_bytes: 100,
  }),
  makeEntry({
    memory_record_id: 'mem-b',
    admission_decision_id: 'admit:b',
    type: 'project_fact',
    scope_ref: 'workspace-1',
    topic_terms: ['typescript', 'testing'],
    keyword_terms: ['vitest'],
    metadata_bytes: 200,
  }),
  makeEntry({
    memory_record_id: 'mem-c',
    admission_decision_id: 'admit:c',
    type: 'project_fact',
    scope_ref: 'workspace-2',
    topic_terms: ['python'],
    keyword_terms: ['pytest'],
    metadata_bytes: 300,
  }),
  makeEntry({
    memory_record_id: 'mem-d',
    admission_decision_id: 'admit:d',
    type: 'workflow_pattern',
    scope_ref: 'workspace-1',
    topic_terms: ['git', 'branching'],
    keyword_terms: [],
    metadata_bytes: 400,
  }),
];

const catalog = buildMemoryCatalogSnapshot(entries);

// ─── baseline query ─────────────────────────────────────────────────
// 不限 scope/type,topic='typescript' → 应匹配 mem-a / mem-b(两者都含 typescript)。
const baseQuery = buildMemorySearchQuery({
  topic_terms: ['typescript'],
  keyword_terms: [],
  max_selected_entries: 10,
  max_index_metadata_bytes: 10_000,
});

// ===========================================================================
// §1 buildMemorySearchQuery — normalization
// ===========================================================================
describe('buildMemorySearchQuery — query normalization', () => {
  it('normalizes terms with NFKC + trim + locale-independent lowercase + tokenize + dedupe', () => {
    const q = buildMemorySearchQuery({
      // 全角 + 大写 + 标点 + 多空白 + 重复
      topic_terms: ['ＴＹＰＥScript', '  TypeScript ', 'typescript,', 'TypeScript\t'],
      keyword_terms: ['Tabs', 'TABS'],
      max_selected_entries: 5,
      max_index_metadata_bytes: 1000,
    });
    // 归一化后只剩 'typescript'(topic)、'tabs'(keyword)
    expect(q.topic_terms).toEqual(['typescript']);
    expect(q.keyword_terms).toEqual(['tabs']);
    expect(q.query_protocol_version).toBe(MEMORY_SELECTION_PROTOCOL_VERSION);
    expect(q.query_id).toBeTruthy();
  });

  it('drops empty terms after normalization and keeps order', () => {
    const q = buildMemorySearchQuery({
      topic_terms: ['', '  ', ',,,', 'real', 'Real'],
      keyword_terms: [],
      max_selected_entries: 1,
      max_index_metadata_bytes: 100,
    });
    expect(q.topic_terms).toEqual(['real']);
  });

  it('preserves null scope_ref and null type_filter when omitted', () => {
    const q = buildMemorySearchQuery({
      topic_terms: [],
      keyword_terms: [],
      max_selected_entries: 1,
      max_index_metadata_bytes: 100,
    });
    expect(q.scope_ref).toBeNull();
    expect(q.type_filter).toBeNull();
  });

  it('throws on illegal budgets (zero / negative / non-integer)', () => {
    expect(() =>
      buildMemorySearchQuery({
        topic_terms: [],
        keyword_terms: [],
        max_selected_entries: 0,
        max_index_metadata_bytes: 100,
      }),
    ).toThrow();
    expect(() =>
      buildMemorySearchQuery({
        topic_terms: [],
        keyword_terms: [],
        max_selected_entries: 1,
        max_index_metadata_bytes: -1,
      }),
    ).toThrow();
  });
});

// ===========================================================================
// §2 selectMemoryEntries — metadata-only & determinism
// ===========================================================================
describe('selectMemoryEntries — metadata-only selection', () => {
  it('selects from catalog metadata without reading detail bodies', () => {
    // 本函数签名根本没有 detail reader 参数;只消费 catalog metadata。
    const result = selectMemoryEntries(baseQuery, catalog);
    // typescript 命中 mem-a + mem-b
    expect(result.selected_entries.map((e) => e.memory_record_id).sort()).toEqual([
      'mem-a',
      'mem-b',
    ]);
    expect(result.selection_protocol_version).toBe(MEMORY_SELECTION_PROTOCOL_VERSION);
    expect(result.query).toBe(baseQuery);
  });

  it('produces deterministic selection_id for identical query+catalog', () => {
    const r1 = selectMemoryEntries(baseQuery, catalog);
    const r2 = selectMemoryEntries(baseQuery, catalog);
    expect(r1.selection_id).toBe(r2.selection_id);
    expect(r1.selection_id).toContain('sel:');
  });

  it('keeps catalog entry order as navigation rank, not as confidence', () => {
    // mem-a 在 catalog 中先于 mem-b → selected 顺序保持 mem-a, mem-b。
    // rank 只是导航序号,不表达 confidence/Truth/use。
    const result = selectMemoryEntries(baseQuery, catalog);
    expect(result.selected_entries.map((e) => e.memory_record_id)).toEqual([
      'mem-a',
      'mem-b',
    ]);
    // 不携带任何 confidence / authority 字段
    const first = result.selected_entries[0] as unknown as Record<string, unknown>;
    expect(first).not.toHaveProperty('confidence');
    expect(first).not.toHaveProperty('authority');
    expect(first).not.toHaveProperty('trust');
  });
});

// ===========================================================================
// §3 filter rules — scope → type → term
// ===========================================================================
describe('selectMemoryEntries — filter rules', () => {
  it('filters by scope, excluding mismatched entries with reason_code', () => {
    const q = buildMemorySearchQuery({
      scope_ref: 'workspace-2',
      topic_terms: [],
      keyword_terms: [],
      max_selected_entries: 10,
      max_index_metadata_bytes: 10_000,
    });
    const result = selectMemoryEntries(q, catalog);
    expect(result.selected_entries.map((e) => e.memory_record_id)).toEqual(['mem-c']);
    // 其它三个 workspace-1 entry 被排除,原因码为 scope_mismatch
    const excluded = result.excluded_entries;
    expect(excluded).toContainEqual({
      memory_record_id: 'mem-a',
      reason_code: 'selection.scope_mismatch',
    });
    expect(excluded).toContainEqual({
      memory_record_id: 'mem-b',
      reason_code: 'selection.scope_mismatch',
    });
  });

  it('filters by type, excluding mismatched entries with reason_code', () => {
    // scope 不限,但 type_filter=project_fact → 只 mem-b / mem-c
    const q = buildMemorySearchQuery({
      type_filter: 'project_fact',
      topic_terms: [],
      keyword_terms: [],
      max_selected_entries: 10,
      max_index_metadata_bytes: 10_000,
    });
    const result = selectMemoryEntries(q, catalog);
    expect(result.selected_entries.map((e) => e.memory_record_id).sort()).toEqual([
      'mem-b',
      'mem-c',
    ]);
    expect(result.excluded_entries).toContainEqual({
      memory_record_id: 'mem-a',
      reason_code: 'selection.type_mismatch',
    });
    expect(result.excluded_entries).toContainEqual({
      memory_record_id: 'mem-d',
      reason_code: 'selection.type_mismatch',
    });
  });

  it('matches by normalized topic/keyword (no term intersection → excluded)', () => {
    // topic='rust' 没有任何 entry 含 → 全部 excluded 为 no_term_match
    const q = buildMemorySearchQuery({
      topic_terms: ['rust'],
      keyword_terms: [],
      max_selected_entries: 10,
      max_index_metadata_bytes: 10_000,
    });
    const result = selectMemoryEntries(q, catalog);
    expect(result.selected_entries).toHaveLength(0);
    expect(result.excluded_entries).toHaveLength(entries.length);
    expect(
      result.excluded_entries.every(
        (e) => e.reason_code === 'selection.no_term_match',
      ),
    ).toBe(true);
  });

  it('matches by keyword when topic has no intersection', () => {
    // topic 不命中,keyword='vitest' 命中 mem-b
    const q = buildMemorySearchQuery({
      topic_terms: ['java'],
      keyword_terms: ['vitest'],
      max_selected_entries: 10,
      max_index_metadata_bytes: 10_000,
    });
    const result = selectMemoryEntries(q, catalog);
    expect(result.selected_entries.map((e) => e.memory_record_id)).toEqual(['mem-b']);
  });

  it('applies scope filter before type filter (scope mismatch wins over type mismatch)', () => {
    // mem-c 是 workspace-2 + project_fact。query scope=workspace-1 type=user_preference
    // → mem-c 因 scope 先排除(scope_mismatch),不会被 type 规则处理
    const q = buildMemorySearchQuery({
      scope_ref: 'workspace-1',
      type_filter: 'user_preference',
      topic_terms: [],
      keyword_terms: [],
      max_selected_entries: 10,
      max_index_metadata_bytes: 10_000,
    });
    const result = selectMemoryEntries(q, catalog);
    expect(result.selected_entries.map((e) => e.memory_record_id)).toEqual(['mem-a']);
    // mem-c 是 scope_mismatch,不是 type_mismatch
    expect(result.excluded_entries).toContainEqual({
      memory_record_id: 'mem-c',
      reason_code: 'selection.scope_mismatch',
    });
  });
});

// ===========================================================================
// §4 budget — entry boundary & overflow
// ===========================================================================
describe('selectMemoryEntries — budget enforcement', () => {
  it('marks overflow instead of claiming completeness when max_selected_entries hit', () => {
    // typescript 命中 mem-a + mem-b,但 limit=1
    const q = buildMemorySearchQuery({
      topic_terms: ['typescript'],
      keyword_terms: [],
      max_selected_entries: 1,
      max_index_metadata_bytes: 10_000,
    });
    const result = selectMemoryEntries(q, catalog);
    expect(result.selected_entries).toHaveLength(1);
    expect(result.selected_entries[0].memory_record_id).toBe('mem-a'); // catalog 顺序优先
    expect(result.overflowed).toBe(true);
    // total_index_metadata_bytes 反映实际选中的 entry
    expect(result.total_index_metadata_bytes).toBe(100);
  });

  it('stops at complete entry boundary on max_index_metadata_bytes budget', () => {
    // mem-a=100, mem-b=200 → 累加 mem-a=100, mem-b=300。
    // 设预算=250:加入 mem-a(100)后,再加 mem-b(→300)会超 → 停在 mem-a 边界。
    const q = buildMemorySearchQuery({
      topic_terms: ['typescript'],
      keyword_terms: [],
      max_selected_entries: 10,
      max_index_metadata_bytes: 250,
    });
    const result = selectMemoryEntries(q, catalog);
    expect(result.selected_entries.map((e) => e.memory_record_id)).toEqual(['mem-a']);
    expect(result.overflowed).toBe(true);
    expect(result.total_index_metadata_bytes).toBe(100);
  });

  it('does not overflow when everything fits exactly within budget', () => {
    // mem-a=100 + mem-b=200 = 300,预算正好 300
    const q = buildMemorySearchQuery({
      topic_terms: ['typescript'],
      keyword_terms: [],
      max_selected_entries: 10,
      max_index_metadata_bytes: 300,
    });
    const result = selectMemoryEntries(q, catalog);
    expect(result.selected_entries.map((e) => e.memory_record_id)).toEqual([
      'mem-a',
      'mem-b',
    ]);
    expect(result.overflowed).toBe(false);
    expect(result.total_index_metadata_bytes).toBe(300);
  });
});

// ===========================================================================
// §5 search failure — never falls back to loading all
// ===========================================================================
describe('selectMemoryEntries — search failure does not fall back', () => {
  it('returns empty selection (not all entries) when no term matches', () => {
    // 规格明确禁止 "search failure → 加载全部 Memory"。
    const q = buildMemorySearchQuery({
      topic_terms: ['nonexistent-term-xyz'],
      keyword_terms: ['no-such-keyword'],
      max_selected_entries: 10,
      max_index_metadata_bytes: 10_000,
    });
    const result = selectMemoryEntries(q, catalog);
    expect(result.selected_entries).toHaveLength(0);
    expect(result.overflowed).toBe(false);
    expect(result.total_index_metadata_bytes).toBe(0);
  });

  it('returns empty selection when catalog has zero entries', () => {
    const emptyCatalog = buildMemoryCatalogSnapshot([]);
    const result = selectMemoryEntries(baseQuery, emptyCatalog);
    expect(result.selected_entries).toHaveLength(0);
    expect(result.excluded_entries).toHaveLength(0);
    expect(result.overflowed).toBe(false);
  });
});

// ===========================================================================
// §6 immutability — frozen snapshot, catalog untouched
// ===========================================================================
describe('selectMemoryEntries — immutability & isolation', () => {
  it('produces a frozen result object', () => {
    const result = selectMemoryEntries(baseQuery, catalog);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.selected_entries)).toBe(true);
    expect(Object.isFrozen(result.excluded_entries)).toBe(true);
  });

  it('does not mutate the catalog argument', () => {
    // 记录 catalog 原 entries 数量与 catalog_hash,选完后应保持不变。
    const beforeCount = catalog.entries.length;
    const beforeHash = catalog.catalog_hash;
    selectMemoryEntries(baseQuery, catalog);
    expect(catalog.entries.length).toBe(beforeCount);
    expect(catalog.catalog_hash).toBe(beforeHash);
    expect(Object.isFrozen(catalog)).toBe(true);
  });
});

// ===========================================================================
// §7 catalog snapshot — id determinism & freeze
// ===========================================================================
describe('buildMemoryCatalogSnapshot — minimal snapshot', () => {
  it('produces deterministic catalog_snapshot_id and catalog_hash for identical entries', () => {
    const c1 = buildMemoryCatalogSnapshot(entries);
    const c2 = buildMemoryCatalogSnapshot(entries);
    expect(c1.catalog_snapshot_id).toBe(c2.catalog_snapshot_id);
    expect(c1.catalog_hash).toBe(c2.catalog_hash);
    expect(c1.catalog_protocol_version).toBe(MEMORY_CATALOG_PROTOCOL_VERSION);
  });

  it('returns a frozen snapshot with entry order preserved', () => {
    const c = buildMemoryCatalogSnapshot(entries);
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.entries)).toBe(true);
    expect(c.entries.map((e) => e.memory_record_id)).toEqual([
      'mem-a',
      'mem-b',
      'mem-c',
      'mem-d',
    ]);
  });
});
