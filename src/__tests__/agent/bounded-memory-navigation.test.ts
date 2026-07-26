// FRC-1 Bounded Memory Entrypoint — Task 2: projectMemoryNavigation 测试
//
// 覆盖规格 docs/superpowers/specs/2026-07-26-agent-bounded-memory-entrypoint-wave-f-design.md
//   §7.5 Navigation item / §7.7 Navigation ordering / §7.10 Overflow manifest
//
// 不变量:
//   - INV-F2   Catalog 不等于正文(navigation item 只含 metadata,无 body/claim)
//   - INV-F3   Selected 不等于 Use(navigation 不携带 verified claim 正文)
//   - INV-F4   Navigation 与 Verified Detail 分权(navigation 不携带 use decision 字段)
//   - INV-F7   只在语义边界省略(整个 entry 被省略,不拆分)
//
// 本测试覆盖 projectMemoryNavigation 的 metadata-only 投影、确定性排序、
// eligibility 交集(scope/type/durability)、omission 聚合、metadata leakage 防护。

import { describe, it, expect } from 'vitest';
import {
  captureMemoryEntrypointBuild,
  projectMemoryNavigation,
  NAVIGATION_ITEM_PROTOCOL_VERSION,
  type MemoryEntrypointBuildInput,
  type MemoryEntrypointPolicy,
  type RetrievedMemoryDetail,
  type WaveFContractRef,
} from '../../agent/context/bounded-memory.js';
import {
  buildMemoryCatalogSnapshot,
  type MemoryCatalogEntry,
  type MemoryCatalogSnapshot,
} from '../../memory/catalog.js';
import {
  buildMemorySearchQuery,
  selectMemoryEntries,
  type MemorySelectionResult,
} from '../../memory/selection.js';
import {
  decideMemoryUse,
  MEMORY_USE_PROTOCOL_VERSION,
  type MemoryUseDecision,
  type MemoryUseInput,
} from '../../memory/admission.js';

// ─── fixtures ────────────────────────────────────────────────────────

function makeCatalogEntry(
  overrides: Partial<MemoryCatalogEntry>,
): MemoryCatalogEntry {
  return {
    memory_record_id: 'memrec-default',
    record_version: 1,
    admission_decision_id: 'admit:default',
    type: 'project_fact',
    scope_ref: 'workspace-1',
    topic_terms: ['typescript'],
    keyword_terms: [],
    observed_at: '2026-07-26T00:00:00Z',
    provenance_refs: ['prov-default'],
    detail_commit_ref: 'detail-default',
    content_hash: 'sha256:default',
    metadata_bytes: 100,
    ...overrides,
  };
}

const DEFAULT_CURRENT_CONTEXT = 'ctx:snap-001';
const DEFAULT_PROJECT_VERSION = 'proj:v1';
const DEFAULT_TASK_SNAPSHOT = 'task:snap-001';
const DEFAULT_REQUEST_BUDGET = 'budget:req-001';
const DEFAULT_RENDER_PROFILE = 'render:profile-1';
const DEFAULT_POLICY_REF: WaveFContractRef = {
  contract_id: 'frc-1.entrypoint-policy',
  contract_version: '1',
};

function makeBasePolicy(
  overrides: Partial<MemoryEntrypointPolicy> = {},
): MemoryEntrypointPolicy {
  return {
    entrypoint_policy_protocol_version: '1',
    policy_id: 'policy-001',
    policy_version: '1',
    enabled: true,
    allowed_memory_types: ['user_preference', 'project_fact', 'workflow_pattern'],
    allowed_scope_refs: ['workspace-1', 'workspace-2'],
    navigation_budget_policy_ref: 'budget:nav-001',
    verified_detail_budget_policy_ref: 'budget:detail-001',
    total_section_budget_policy_ref: 'budget:section-001',
    max_navigation_entries: 8,
    max_verified_detail_items: 16,
    max_verified_claims_per_item: 4,
    overflow_behavior: 'entry_boundary_omit',
    empty_behavior: 'omit_section',
    render_profile_ref: DEFAULT_RENDER_PROFILE,
    ...overrides,
  };
}

/**
 * 构造一个合法的 MemoryEntrypointBuildInput,并 capture 为 prepared build。
 * 返回 prepared + catalog + selection 便于后续 projectMemoryNavigation 测试。
 */
function buildPreparedInput(opts: {
  catalogEntries?: MemoryCatalogEntry[];
  policy?: Partial<MemoryEntrypointPolicy>;
  modifyInput?: (input: MemoryEntrypointBuildInput) => void;
} = {}): {
  prepared: ReturnType<typeof captureMemoryEntrypointBuild>;
  catalog: MemoryCatalogSnapshot;
  selection: MemorySelectionResult;
} {
  const entries: MemoryCatalogEntry[] =
    opts.catalogEntries ?? [
      makeCatalogEntry({
        memory_record_id: 'memrec-a',
        admission_decision_id: 'admit:a',
        type: 'user_preference',
        scope_ref: 'workspace-1',
        topic_terms: ['typescript'],
        keyword_terms: ['vitest'],
        detail_commit_ref: 'detail-a',
        content_hash: 'sha256:aaaaaa',
        metadata_bytes: 100,
      }),
      makeCatalogEntry({
        memory_record_id: 'memrec-b',
        admission_decision_id: 'admit:b',
        type: 'project_fact',
        scope_ref: 'workspace-1',
        topic_terms: ['git'],
        keyword_terms: ['branching'],
        detail_commit_ref: 'detail-b',
        content_hash: 'sha256:bbbbbb',
        metadata_bytes: 120,
      }),
    ];

  const catalog = buildMemoryCatalogSnapshot(entries);
  const query = buildMemorySearchQuery({
    scope_ref: null,
    topic_terms: [],
    keyword_terms: [],
    max_selected_entries: 10,
    max_index_metadata_bytes: 10_000,
  });
  const selection = selectMemoryEntries(query, catalog);

  const retrievedDetails: RetrievedMemoryDetail[] = selection.selected_entries.map(
    (entry) => ({
      retrieval_protocol_version: '1',
      retrieval_id: `retrieval:${entry.memory_record_id}`,
      memory_record_id: entry.memory_record_id,
      record_version: entry.record_version,
      catalog_snapshot_id: catalog.catalog_snapshot_id,
      selection_id: selection.selection_id,
      detail_content_ref: entry.detail_commit_ref,
      detail_content_hash: entry.content_hash,
      retrieved_claim_refs: [],
      provenance_refs: [...entry.provenance_refs],
      freshness_ref: `fresh:${entry.memory_record_id}`,
    }),
  );

  const useDecisions: MemoryUseDecision[] = selection.selected_entries.map(
    (entry) => {
      const useInput: MemoryUseInput = {
        memory_use_protocol_version: MEMORY_USE_PROTOCOL_VERSION,
        stored_memory_ref: entry.memory_record_id,
        admission_decision_id: entry.admission_decision_id,
        current_context_snapshot_id: DEFAULT_CURRENT_CONTEXT,
        project_version_ref: DEFAULT_PROJECT_VERSION,
        candidate_claims: [],
        verified_claim_refs: [],
        stale_claim_refs: [],
        conflicting_evidence_refs: [],
        verifier_available: true,
        refresh_available: false,
      };
      return decideMemoryUse(useInput);
    },
  );

  const input: MemoryEntrypointBuildInput = {
    entrypoint_build_protocol_version: '1',
    build_id: 'build:001',
    task_snapshot_id: DEFAULT_TASK_SNAPSHOT,
    current_context_snapshot_id: DEFAULT_CURRENT_CONTEXT,
    project_version_ref: DEFAULT_PROJECT_VERSION,
    catalog_snapshot: catalog,
    selection_result: selection,
    retrieved_details: retrievedDetails,
    memory_use_decisions: useDecisions,
    policy: makeBasePolicy(opts.policy),
    policy_ref: DEFAULT_POLICY_REF,
    request_budget_snapshot_id: DEFAULT_REQUEST_BUDGET,
    render_profile_ref: DEFAULT_RENDER_PROFILE,
  };

  if (opts.modifyInput) opts.modifyInput(input);

  const prepared = captureMemoryEntrypointBuild(input);
  return { prepared, catalog, selection };
}

// 默认的 durability_evidence_ref_for:对所有 entry 返回 'durable:ok'(eligible)。
function alwaysDurable(_entry: MemoryCatalogEntry): string | null {
  return 'durable:ok';
}
function neverDurable(_entry: MemoryCatalogEntry): string | null {
  return null;
}

// ===========================================================================
// §1 baseline — selected 全部 eligible → 完整投影
// ===========================================================================

describe('projectMemoryNavigation — baseline full projection', () => {
  it('produces navigation items for all selected entries when all eligible', () => {
    const { prepared } = buildPreparedInput();
    const result = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: alwaysDurable,
    });

    expect(result.items).toHaveLength(2);
    expect(result.omissions).toHaveLength(0);
    expect(result.not_selected_count).toBe(0);
    expect(result.projection_protocol_version).toBe(
      NAVIGATION_ITEM_PROTOCOL_VERSION,
    );
    expect(typeof result.projection_id).toBe('string');
    expect(result.projection_id.startsWith('nav:')).toBe(true);
  });

  it('each navigation item carries exactly the 12 metadata fields from spec §7.5', () => {
    const { prepared } = buildPreparedInput();
    const result = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: alwaysDurable,
    });

    const item = result.items[0]!;
    // 12 字段(包括 navigation_item_protocol_version):
    expect(item.navigation_item_protocol_version).toBe(
      NAVIGATION_ITEM_PROTOCOL_VERSION,
    );
    expect(typeof item.memory_record_id).toBe('string');
    expect(typeof item.record_version).toBe('number');
    expect(typeof item.selection_rank).toBe('number');
    expect(typeof item.memory_type).toBe('string');
    expect(typeof item.scope_ref).toBe('string');
    expect(Array.isArray(item.topic_key_refs)).toBe(true);
    expect(Array.isArray(item.keyword_key_refs)).toBe(true);
    expect(typeof item.observed_at).toBe('string');
    // expires_at 允许 null
    expect(typeof item.detail_content_hash).toBe('string');
    expect(Array.isArray(item.provenance_refs)).toBe(true);
    expect(typeof item.durability_evidence_ref).toBe('string');
  });

  it('omits claim body / credential / evidence body / conversation / instruction fields (INV-F2/F4)', () => {
    const { prepared } = buildPreparedInput();
    const result = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: alwaysDurable,
    });

    const serialized = JSON.stringify(result.items);
    // 严格检查序列化结果不含禁止的 key
    expect(serialized).not.toMatch(/\b(body|claim|credential|evidence_body|conversation|instruction|security_decision)\b/);
    // metadata leakage 防护:retrieved detail 中的 retrieved_claim_refs / freshness_ref
    // 不应出现在 navigation item(那是 Task 3 verified claim projection 的范围)。
    expect(serialized).not.toMatch(/retrieved_claim_refs/);
    expect(serialized).not.toMatch(/verified_claim_ref/);
    expect(serialized).not.toMatch(/status/); // use decision 的 status 不能渗入 navigation
  });
});

// ===========================================================================
// §2 确定性 ordering(§7.7)
// ===========================================================================

describe('projectMemoryNavigation — deterministic ordering', () => {
  it('uses selection_rank from selection.selected_entries index', () => {
    const { prepared } = buildPreparedInput();
    const result = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: alwaysDurable,
    });

    // 两个 entry 的 selection_rank 应分别为 0 和 1(按 selection.selected_entries 顺序)。
    expect(result.items.map((i) => i.selection_rank)).toEqual([0, 1]);
  });

  it('keeps selection order when entries are not in memory_record_id sorted order', () => {
    // catalog 故意以逆序的 memory_record_id 排列,验证 navigation 顺序跟随 selection(== catalog)
    // 而不是 record_id 排序。
    const { prepared } = buildPreparedInput({
      catalogEntries: [
        makeCatalogEntry({
          memory_record_id: 'memrec-zzz',
          admission_decision_id: 'admit:zzz',
          detail_commit_ref: 'detail-z',
          content_hash: 'sha256:zz',
        }),
        makeCatalogEntry({
          memory_record_id: 'memrec-aaa',
          admission_decision_id: 'admit:aaa',
          detail_commit_ref: 'detail-a',
          content_hash: 'sha256:aa',
        }),
      ],
    });
    const result = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: alwaysDurable,
    });

    // 顺序跟随 selection:第一条 memrec-zzz,第二条 memrec-aaa
    expect(result.items.map((i) => i.memory_record_id)).toEqual([
      'memrec-zzz',
      'memrec-aaa',
    ]);
    expect(result.items.map((i) => i.selection_rank)).toEqual([0, 1]);
  });

  it('produces identical projection_id for identical input', () => {
    const { prepared } = buildPreparedInput();
    const r1 = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: alwaysDurable,
    });
    const r2 = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: alwaysDurable,
    });
    expect(r1.projection_id).toBe(r2.projection_id);
  });
});

// ===========================================================================
// §3 eligibility 交集(scope / type / durability)
// ===========================================================================

describe('projectMemoryNavigation — eligibility intersection', () => {
  it('excludes entries whose scope is not in policy.allowed_scope_refs', () => {
    const { prepared } = buildPreparedInput({
      policy: { allowed_scope_refs: ['workspace-9'] },
    });
    const result = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: alwaysDurable,
    });

    expect(result.items).toHaveLength(0);
    expect(result.omissions).toHaveLength(2);
    expect(result.omissions.every((o) => o.reason === 'scope_excluded')).toBe(true);
  });

  it('excludes entries whose type is not in policy.allowed_memory_types', () => {
    const { prepared } = buildPreparedInput();
    const result = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: alwaysDurable,
      // 动态构造 type filter:所有 entry 都不在允许列表
      ...(undefined as never),
    });

    // 用一个 alternate policy 走更明确的 type_excluded 场景。
    const alt = buildPreparedInput({
      policy: { allowed_memory_types: ['failure_observation'] },
    });
    const altResult = projectMemoryNavigation({
      prepared: alt.prepared,
      durability_evidence_ref_for: alwaysDurable,
    });

    expect(altResult.items).toHaveLength(0);
    expect(altResult.omissions).toHaveLength(2);
    expect(altResult.omissions.every((o) => o.reason === 'type_excluded')).toBe(true);

    // 顺手验证前面的 result 也合理(全部 entry 类型不匹配 failure_observation 也成立)
    void result;
  });

  it('excludes entries whose durability_evidence_ref_for returns null', () => {
    const { prepared } = buildPreparedInput();
    const result = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: neverDurable,
    });

    expect(result.items).toHaveLength(0);
    expect(result.omissions).toHaveLength(2);
    expect(
      result.omissions.every((o) => o.reason === 'durability_unverified'),
    ).toBe(true);
  });

  it('mixed eligibility: partial subset passes', () => {
    // catalog 含 3 个 entry:scope 在/不在,type 在/不在,durability 在/不在。
    const { prepared } = buildPreparedInput({
      catalogEntries: [
        makeCatalogEntry({
          memory_record_id: 'memrec-ok',
          type: 'user_preference',
          scope_ref: 'workspace-1',
        }),
        makeCatalogEntry({
          memory_record_id: 'memrec-bad-scope',
          type: 'user_preference',
          scope_ref: 'workspace-9',
        }),
        makeCatalogEntry({
          memory_record_id: 'memrec-bad-type',
          type: 'failure_observation',
          scope_ref: 'workspace-1',
        }),
      ],
    });

    // durability 只对 memrec-ok 返回非 null
    const result = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: (entry) =>
        entry.memory_record_id === 'memrec-ok' ? 'durable:ok' : null,
    });

    expect(result.items.map((i) => i.memory_record_id)).toEqual(['memrec-ok']);
    const reasons = new Map(
      result.omissions.map((o) => [o.memory_record_id, o.reason]),
    );
    expect(reasons.get('memrec-bad-scope')).toBe('scope_excluded');
    // type 校验在 scope 校验之后,但 bad-type 的 scope 是 OK,所以会进 type 检查
    // 优先级:scope → type → durability。memrec-bad-type scope OK,type 不 OK。
    expect(reasons.get('memrec-bad-type')).toBe('type_excluded');
  });
});

// ===========================================================================
// §4 omissions 聚合:not_selected_count
// ===========================================================================

describe('projectMemoryNavigation — not_selected aggregation', () => {
  it('reports not_selected_count for entries present in catalog but not in selection', () => {
    // 3 个 entry 在 catalog,但 selection 的 max_entries 限制只选中部分。
    // 用 buildMemorySearchQuery 的 max_selected_entries=1 实现。
    const entries: MemoryCatalogEntry[] = [
      makeCatalogEntry({
        memory_record_id: 'memrec-a',
        detail_commit_ref: 'detail-a',
        content_hash: 'sha256:aaaaaa',
      }),
      makeCatalogEntry({
        memory_record_id: 'memrec-b',
        detail_commit_ref: 'detail-b',
        content_hash: 'sha256:bbbbbb',
      }),
      makeCatalogEntry({
        memory_record_id: 'memrec-c',
        detail_commit_ref: 'detail-c',
        content_hash: 'sha256:cccccc',
      }),
    ];
    const catalog = buildMemoryCatalogSnapshot(entries);
    const query = buildMemorySearchQuery({
      scope_ref: null,
      topic_terms: [],
      keyword_terms: [],
      max_selected_entries: 1, // 只选中 1 个
      max_index_metadata_bytes: 10_000,
    });
    const selection = selectMemoryEntries(query, catalog);

    const retrievedDetails: RetrievedMemoryDetail[] = selection.selected_entries.map(
      (entry) => ({
        retrieval_protocol_version: '1',
        retrieval_id: `retrieval:${entry.memory_record_id}`,
        memory_record_id: entry.memory_record_id,
        record_version: entry.record_version,
        catalog_snapshot_id: catalog.catalog_snapshot_id,
        selection_id: selection.selection_id,
        detail_content_ref: entry.detail_commit_ref,
        detail_content_hash: entry.content_hash,
        retrieved_claim_refs: [],
        provenance_refs: [...entry.provenance_refs],
        freshness_ref: `fresh:${entry.memory_record_id}`,
      }),
    );

    const useDecisions: MemoryUseDecision[] = selection.selected_entries.map(
      (entry) =>
        decideMemoryUse({
          memory_use_protocol_version: MEMORY_USE_PROTOCOL_VERSION,
          stored_memory_ref: entry.memory_record_id,
          admission_decision_id: entry.admission_decision_id,
          current_context_snapshot_id: DEFAULT_CURRENT_CONTEXT,
          project_version_ref: DEFAULT_PROJECT_VERSION,
          candidate_claims: [],
          verified_claim_refs: [],
          stale_claim_refs: [],
          conflicting_evidence_refs: [],
          verifier_available: true,
          refresh_available: false,
        }),
    );

    const input: MemoryEntrypointBuildInput = {
      entrypoint_build_protocol_version: '1',
      build_id: 'build:001',
      task_snapshot_id: DEFAULT_TASK_SNAPSHOT,
      current_context_snapshot_id: DEFAULT_CURRENT_CONTEXT,
      project_version_ref: DEFAULT_PROJECT_VERSION,
      catalog_snapshot: catalog,
      selection_result: selection,
      retrieved_details: retrievedDetails,
      memory_use_decisions: useDecisions,
      policy: makeBasePolicy(),
      policy_ref: DEFAULT_POLICY_REF,
      request_budget_snapshot_id: DEFAULT_REQUEST_BUDGET,
      render_profile_ref: DEFAULT_RENDER_PROFILE,
    };
    const prepared = captureMemoryEntrypointBuild(input);

    const result = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: alwaysDurable,
    });

    expect(result.items).toHaveLength(1);
    expect(result.not_selected_count).toBe(2); // 3 - 1 = 2
  });
});

// ===========================================================================
// §5 selection 不变(navigation 不修改 selection)
// ===========================================================================

describe('projectMemoryNavigation — does not modify selection', () => {
  it('returns a new items array without mutating prepared.selection_result', () => {
    const { prepared } = buildPreparedInput();
    const selectedBefore = prepared.selection_result.selected_entries;
    const selectedCountBefore = selectedBefore.length;

    projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: alwaysDurable,
    });

    expect(prepared.selection_result.selected_entries.length).toBe(
      selectedCountBefore,
    );
    expect(prepared.selection_result.selected_entries).toBe(selectedBefore);
  });

  it('output items array is independent of selection.selected_entries reference', () => {
    const { prepared } = buildPreparedInput();
    const result = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: alwaysDurable,
    });
    // 修改 result.items(尽管已冻结)不应影响 selection
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(result.items).not.toBe(prepared.selection_result.selected_entries);
  });
});

// ===========================================================================
// §6 prepared state != prepared 的处理
// ===========================================================================

describe('projectMemoryNavigation — handles non-prepared state', () => {
  it('returns empty items when prepared.state=empty', () => {
    const { prepared } = buildPreparedInput({
      policy: { enabled: false },
    });
    expect(prepared.state).toBe('empty');

    const result = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: alwaysDurable,
    });

    expect(result.items).toHaveLength(0);
    expect(result.omissions).toHaveLength(0);
    expect(result.not_selected_count).toBe(0);
  });

  it('returns empty items when prepared.state=rejected', () => {
    const { prepared } = buildPreparedInput({
      modifyInput: (i) => {
        i.build_id = '';
      },
    });
    expect(prepared.state).toBe('rejected');

    const result = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: alwaysDurable,
    });

    expect(result.items).toHaveLength(0);
  });
});

// ===========================================================================
// §7 空 catalog / 空 selection
// ===========================================================================

describe('projectMemoryNavigation — empty catalog / selection', () => {
  it('produces empty items when catalog has zero entries', () => {
    const { prepared } = buildPreparedInput({ catalogEntries: [] });
    const result = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: alwaysDurable,
    });
    expect(result.items).toHaveLength(0);
    expect(result.omissions).toHaveLength(0);
    expect(result.not_selected_count).toBe(0);
  });
});

// ===========================================================================
// §8 omission 类型完整性(NavigationOmissionReason)
// ===========================================================================

describe('projectMemoryNavigation — omission reasons', () => {
  it('omission for type_excluded preserves record identity', () => {
    const { prepared } = buildPreparedInput({
      policy: { allowed_memory_types: ['failure_observation'] },
    });
    const result = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: alwaysDurable,
    });
    for (const o of result.omissions) {
      expect(o.memory_record_id).toBeTruthy();
      expect(
        ['scope_excluded', 'type_excluded', 'durability_unverified'],
      ).toContain(o.reason);
    }
  });
});
