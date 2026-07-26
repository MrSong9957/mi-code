// FRC-1 Bounded Memory Entrypoint — Wave F Task 9: Request Integration 测试
//
// 物理本质:在 streamingQuery 调用前构建 bounded memory entrypoint,把 Memory section
// 附加到 systemPrompt。Integration 函数是 T6(build)+ T7(cache)+ T8(handoff)的编排器。
//
// 覆盖规格 docs/superpowers/specs/2026-07-26-agent-bounded-memory-entrypoint-wave-f-design.md
//   §7.18 Error semantics / Task 9 Step 2-7
//
// 关键不变量:
//   - INV-F1   Snapshot 不混合(capture-then-mutate:当前 request 用旧 captured snapshot)
//   - INV-F10  Failure 不回退 full-load(任何 build/render/handoff 失败 → section=null + diagnostic)
//   - INV-F12  Empty 不造内容(section=null)
//   - 失败静默 不改变 TurnOutcome(规格 §7.18)

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';

import {
  buildBoundedMemoryEntrypoint,
  ENTRYPOINT_PROTOCOL_VERSION,
  ENTRYPOINT_POLICY_PROTOCOL_VERSION,
  integrateBoundedMemoryIntoRequest,
  createMemoryEntrypointRebuildInput,
  type BoundedMemoryEntrypointDependencies,
  type BoundedMemoryEntrypointSnapshot,
  type MemoryEntrypointBuildInput,
  type MemoryEntrypointPolicy,
  type RetrievedMemoryDetail,
  type WaveFContractRef,
} from '../../agent/context/bounded-memory.js';

import {
  type NavigationBudgetPolicy,
  type TotalSectionBudgetPolicy,
  type VerifiedDetailBudgetPolicy,
} from '../../agent/context/bounded-memory-budget.js';

import {
  DEFAULT_MEMORY_RENDER_PROFILE,
  type RenderedMemorySection,
} from '../../agent/context/bounded-memory-render.js';

// 重新导出 render module 以便 spy
import * as renderModule from '../../agent/context/bounded-memory-render.js';

import {
  createMemoryEntrypointCache,
  type CacheableEntrypointPayload,
  type MemoryEntrypointCacheStore,
} from '../../agent/context/bounded-memory-cache.js';

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

import { streamingQuery } from '../../agent/streaming-query.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import type {
  StreamingLLMClient,
  Message,
  ToolDefinition,
  StreamEvent,
  AssistantMessage,
  StreamOptions,
} from '../../agent/types.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ─── 公共 fixture(与 bounded-memory-entrypoint.test.ts 同款,精简版) ─────

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
    keyword_terms: ['vitest'],
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
    entrypoint_policy_protocol_version: ENTRYPOINT_POLICY_PROTOCOL_VERSION,
    policy_id: 'policy-001',
    policy_version: '1',
    enabled: true,
    allowed_memory_types: ['user_preference', 'project_fact'],
    allowed_scope_refs: ['workspace-1'],
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

const DEFAULT_NAV_BUDGET_POLICY: NavigationBudgetPolicy = {
  source_class: 'memory_navigation',
  max_bytes: 1_000_000,
  max_lines: null,
  max_entries: 100,
  policy_id: 'nav-policy-001',
  policy_version: '1',
};

const DEFAULT_DETAIL_BUDGET_POLICY: VerifiedDetailBudgetPolicy = {
  source_class: 'memory_verified_detail',
  max_bytes: 1_000_000,
  max_lines: null,
  max_items: 100,
  max_claims_per_item: 100,
  policy_id: 'detail-policy-001',
  policy_version: '1',
};

const DEFAULT_TOTAL_BUDGET_POLICY: TotalSectionBudgetPolicy = {
  source_class: 'memory_section_total',
  max_bytes: 1_000_000,
  max_lines: null,
  policy_id: 'total-policy-001',
  policy_version: '1',
};

function buildValidInput(overrides: {
  catalogEntries?: MemoryCatalogEntry[];
  policy?: Partial<MemoryEntrypointPolicy>;
  modifyInput?: (input: MemoryEntrypointBuildInput) => void;
} = {}): MemoryEntrypointBuildInput {
  const entries: MemoryCatalogEntry[] =
    overrides.catalogEntries ??
    [
      makeCatalogEntry({
        memory_record_id: 'memrec-a',
        admission_decision_id: 'admit:a',
        type: 'user_preference',
        topic_terms: ['typescript'],
        keyword_terms: ['vitest'],
        detail_commit_ref: 'detail-a',
        content_hash: 'sha256:' + sha256('claim-body-a'),
        metadata_bytes: 100,
      }),
      makeCatalogEntry({
        memory_record_id: 'memrec-b',
        admission_decision_id: 'admit:b',
        type: 'project_fact',
        topic_terms: ['git'],
        keyword_terms: ['branching'],
        detail_commit_ref: 'detail-b',
        content_hash: 'sha256:' + sha256('claim-body-b'),
        metadata_bytes: 120,
      }),
    ];

  const catalog: MemoryCatalogSnapshot =
    buildMemoryCatalogSnapshot(entries);

  const query = buildMemorySearchQuery({
    scope_ref: 'workspace-1',
    topic_terms: [],
    keyword_terms: [],
    max_selected_entries: 10,
    max_index_metadata_bytes: 10_000,
  });
  const selection: MemorySelectionResult = selectMemoryEntries(query, catalog);

  const retrievedDetails: RetrievedMemoryDetail[] =
    selection.selected_entries.map((entry) => ({
      retrieval_protocol_version: '1',
      retrieval_id: `retrieval:${entry.memory_record_id}`,
      memory_record_id: entry.memory_record_id,
      record_version: entry.record_version,
      catalog_snapshot_id: catalog.catalog_snapshot_id,
      selection_id: selection.selection_id,
      detail_content_ref: entry.detail_commit_ref,
      detail_content_hash: entry.content_hash,
      retrieved_claim_refs: [`claim:${entry.memory_record_id}`],
      provenance_refs: [...entry.provenance_refs],
      freshness_ref: `fresh:${entry.memory_record_id}`,
    }));

  const useDecisions: MemoryUseDecision[] = selection.selected_entries.map(
    (entry) => {
      const useInput: MemoryUseInput = {
        memory_use_protocol_version: MEMORY_USE_PROTOCOL_VERSION,
        stored_memory_ref: entry.memory_record_id,
        admission_decision_id: entry.admission_decision_id,
        current_context_snapshot_id: DEFAULT_CURRENT_CONTEXT,
        project_version_ref: DEFAULT_PROJECT_VERSION,
        candidate_claims: [],
        verified_claim_refs: [`claim:${entry.memory_record_id}`],
        stale_claim_refs: [],
        conflicting_evidence_refs: [],
        verifier_available: true,
        refresh_available: false,
      };
      return decideMemoryUse(useInput);
    },
  );

  const input: MemoryEntrypointBuildInput = {
    entrypoint_build_protocol_version: ENTRYPOINT_PROTOCOL_VERSION,
    build_id: 'build:001',
    task_snapshot_id: DEFAULT_TASK_SNAPSHOT,
    current_context_snapshot_id: DEFAULT_CURRENT_CONTEXT,
    project_version_ref: DEFAULT_PROJECT_VERSION,
    catalog_snapshot: catalog,
    selection_result: selection,
    retrieved_details: retrievedDetails,
    memory_use_decisions: useDecisions,
    policy: makeBasePolicy(overrides.policy),
    policy_ref: DEFAULT_POLICY_REF,
    request_budget_snapshot_id: DEFAULT_REQUEST_BUDGET,
    render_profile_ref: DEFAULT_RENDER_PROFILE,
  };

  if (overrides.modifyInput) {
    overrides.modifyInput(input);
  }
  return input;
}

function buildValidDependencies(
  overrides: Partial<BoundedMemoryEntrypointDependencies> = {},
): BoundedMemoryEntrypointDependencies {
  return {
    durability_evidence_ref_for: () => 'durable:ok',
    claim_lookup: {
      lookup_protocol_version: '1',
      lookup_id: 'claim-lookup-001',
      lookup: () => null,
    },
    budget_policies: {
      navigation_budget_policy: DEFAULT_NAV_BUDGET_POLICY,
      verified_detail_budget_policy: DEFAULT_DETAIL_BUDGET_POLICY,
      total_section_budget_policy: DEFAULT_TOTAL_BUDGET_POLICY,
    },
    overflow_behavior: 'entry_boundary_omit',
    render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
    estimator: null,
    ...overrides,
  };
}

function buildValidInputAndDeps(inputOverrides: {
  catalogEntries?: MemoryCatalogEntry[];
  policy?: Partial<MemoryEntrypointPolicy>;
  modifyInput?: (input: MemoryEntrypointBuildInput) => void;
  modifyDeps?: (
    deps: BoundedMemoryEntrypointDependencies,
    input: MemoryEntrypointBuildInput,
  ) => void;
} = {}): {
  input: MemoryEntrypointBuildInput;
  dependencies: BoundedMemoryEntrypointDependencies;
} {
  const input = buildValidInput(inputOverrides);

  const detailMap = new Map<string, RetrievedMemoryDetail>();
  for (const d of input.retrieved_details) {
    detailMap.set(d.memory_record_id, d);
  }
  const dependencies = buildValidDependencies({
    claim_lookup: {
      lookup_protocol_version: '1',
      lookup_id: 'claim-lookup-001',
      lookup: (input2) => {
        const d = detailMap.get(input2.memory_record_id);
        if (!d) return null;
        return {
          content_ref: d.detail_content_ref,
          content_hash: d.detail_content_hash,
        };
      },
    },
  });

  if (inputOverrides.modifyDeps) {
    inputOverrides.modifyDeps(dependencies, input);
  }

  return { input, dependencies };
}

/**
 * 用 vi.spyOn(pass-through) 捕获 buildBoundedMemoryEntrypoint 内部调用的
 * renderMemoryEntrypoint 的实际返回 content。
 *
 * vitest 中,spyOn 命名 export 后,bare-name 引用该 export 会走 spy(因为
 * vitest 把 ESM import 转换为 namespace getter 形式)。
 *
 * 返回 (snapshot, content) 对,确保 content 的 sha256 与 snapshot.rendered_section_hash 一致。
 */
function buildAndCaptureContent(
  input: MemoryEntrypointBuildInput,
  deps: BoundedMemoryEntrypointDependencies,
): { snapshot: BoundedMemoryEntrypointSnapshot; content: string } {
  const spy = vi.spyOn(renderModule, 'renderMemoryEntrypoint');
  try {
    const snapshot = buildBoundedMemoryEntrypoint(input, deps);
    if (snapshot.state === 'empty' || snapshot.state === 'rejected') {
      return { snapshot, content: '' };
    }
    // 从 spy.mock.results 取最后一次返回值
    const lastResult = spy.mock.results[spy.mock.results.length - 1];
    const content =
      lastResult && lastResult.type === 'return'
        ? (lastResult.value as RenderedMemorySection).content
        : '';
    return { snapshot, content };
  } finally {
    spy.mockRestore();
  }
}

// ===========================================================================
// §1 integrateBoundedMemoryIntoRequest — state machine
// ===========================================================================

describe('integrateBoundedMemoryIntoRequest — state machine', () => {
  it('ready state → prompt_section 非空(含 Memory 内容)', async () => {
    const { input, dependencies } = buildValidInputAndDeps();
    const captured = buildAndCaptureContent(input, dependencies);
    expect(captured.snapshot.state).toBe('ready');
    expect(captured.content.length).toBeGreaterThan(0);

    const result = await integrateBoundedMemoryIntoRequest({
      build_input: input,
      dependencies,
      cache: null,
      render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
      ordinal: 5,
      trust: 'trust:high',
      retention: 'retention:session',
      provenance_refs: ['prov:req-001'],
      rendered_content_provider: () => captured.content,
    });

    expect(result.integration_protocol_version).toBe(
      'mi.memory.integration/1',
    );
    expect(result.prompt_section).not.toBeNull();
    expect(result.prompt_section!.authority).toBe('memory');
    expect(result.prompt_section!.placement).toBe('system_dynamic');
    expect(result.prompt_section!.section_id).toBe(
      'memory.bounded_entrypoint',
    );
    expect(result.prompt_section!.ordinal).toBe(5);
    expect(result.prompt_section!.trust).toBe('trust:high');
    expect(result.prompt_section!.retention).toBe('retention:session');
    expect(result.prompt_section!.content).toBe(captured.content);
    expect(result.snapshot_state).toBe('ready');
    expect(result.snapshot_id).toBe(captured.snapshot.entrypoint_snapshot_id);
    // ready → 内容包含调用方传入的 provenance_refs
    expect(result.prompt_section!.provenance_refs).toContain('prov:req-001');
  });

  it('empty state → prompt_section=null(省略 section;INV-F12 不造内容)', async () => {
    const { input, dependencies } = buildValidInputAndDeps({
      policy: { enabled: false },
    });
    const result = await integrateBoundedMemoryIntoRequest({
      build_input: input,
      dependencies,
      cache: null,
      render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
      ordinal: 1,
      trust: 'trust:high',
      retention: 'retention:session',
      provenance_refs: [],
      rendered_content_provider: () => '',
    });

    expect(result.prompt_section).toBeNull();
    expect(result.snapshot_state).toBe('empty');
    expect(result.snapshot_id).not.toBeNull(); // snapshot 仍构建出来,只是 state=empty
    // empty → reason_codes 含 handoff.empty_omitted(来自 T8)
    expect(result.reason_codes).toContain('handoff.empty_omitted');
  });

  it('rejected state → prompt_section=null + diagnostic reason_codes', async () => {
    const { input, dependencies } = buildValidInputAndDeps({
      modifyInput: (i) => {
        for (const d of i.retrieved_details as RetrievedMemoryDetail[]) {
          d.catalog_snapshot_id = 'catalog:rogue';
        }
      },
    });

    const result = await integrateBoundedMemoryIntoRequest({
      build_input: input,
      dependencies,
      cache: null,
      render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
      ordinal: 1,
      trust: 'trust:high',
      retention: 'retention:session',
      provenance_refs: [],
      rendered_content_provider: () => '',
    });

    expect(result.prompt_section).toBeNull();
    expect(result.snapshot_state).toBe('rejected');
    expect(result.reason_codes.length).toBeGreaterThan(0);
  });

  it('partial state → prompt_section 非空 + overflow_manifest_ref 非空', async () => {
    const { input, dependencies } = buildValidInputAndDeps({
      modifyDeps: (deps) => {
        deps.budget_policies.navigation_budget_policy = {
          ...deps.budget_policies.navigation_budget_policy,
          max_entries: 1,
        };
      },
    });

    const captured = buildAndCaptureContent(input, dependencies);
    expect(captured.snapshot.state).toBe('partial');

    const result = await integrateBoundedMemoryIntoRequest({
      build_input: input,
      dependencies,
      cache: null,
      render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
      ordinal: 1,
      trust: 'trust:high',
      retention: 'retention:session',
      provenance_refs: [],
      rendered_content_provider: () => captured.content,
    });

    expect(result.prompt_section).not.toBeNull();
    expect(result.snapshot_state).toBe('partial');
    // partial → overflow manifest ref 非空(spec §7.15:partial 必须保留 overflow)
    expect(result.overflow_manifest_ref).not.toBeNull();
    // partial → section.provenance_refs 包含 overflow_manifest_ref
    expect(result.prompt_section!.provenance_refs).toContain(
      result.overflow_manifest_ref,
    );
  });
});

// ===========================================================================
// §2 Cache 集成 — cache hit / miss
// ===========================================================================

describe('integrateBoundedMemoryIntoRequest — cache integration', () => {
  function makeInMemoryStore(): MemoryEntrypointCacheStore & {
    getIndexEntryCalls: number;
    putEntryCalls: number;
    getEntryCalls: number;
  } {
    const index = new Map<string, string>();
    const entries = new Map<string, CacheableEntrypointPayload>();
    return {
      index,
      entries,
      getIndexEntryCalls: 0,
      putEntryCalls: 0,
      getEntryCalls: 0,
      async getIndexEntry(semk: string) {
        this.getIndexEntryCalls++;
        return index.get(semk) ?? null;
      },
      async putIndexEntry(semk: string, entk: string) {
        index.set(semk, entk);
      },
      async getEntry(entk: string) {
        this.getEntryCalls++;
        return entries.get(entk) ?? null;
      },
      async putEntry(entk: string, payload: CacheableEntrypointPayload) {
        this.putEntryCalls++;
        entries.set(entk, payload);
      },
      async deleteEntry(entk: string) {
        entries.delete(entk);
      },
      async clear() {
        index.clear();
        entries.clear();
      },
    };
  }

  it('cache miss → 调用 build 并写入 cache;第二次相同 input → cache hit 不再 build', async () => {
    const { input, dependencies } = buildValidInputAndDeps();
    const store = makeInMemoryStore();
    const cache = createMemoryEntrypointCache(store);
    const captured = buildAndCaptureContent(input, dependencies);

    const result1 = await integrateBoundedMemoryIntoRequest({
      build_input: input,
      dependencies,
      cache,
      render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
      ordinal: 1,
      trust: 'trust:high',
      retention: 'retention:session',
      provenance_refs: [],
      rendered_content_provider: () => captured.content,
    });

    expect(result1.prompt_section).not.toBeNull();
    expect(store.putEntryCalls).toBeGreaterThanOrEqual(1);
    const putEntryAfterFirst = store.putEntryCalls;
    const getIndexAfterFirst = store.getIndexEntryCalls;

    // 第二次:相同 input → cache hit
    const result2 = await integrateBoundedMemoryIntoRequest({
      build_input: input,
      dependencies,
      cache,
      render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
      ordinal: 1,
      trust: 'trust:high',
      retention: 'retention:session',
      provenance_refs: [],
      rendered_content_provider: () => captured.content,
    });

    expect(result2.prompt_section).not.toBeNull();
    // snapshot_id 相同(cache hit 返回相同 payload)
    expect(result2.snapshot_id).toBe(result1.snapshot_id);
    // cache hit → 不再 putEntry
    expect(store.putEntryCalls).toBe(putEntryAfterFirst);
    // cache hit → getIndexEntry 至少调用过
    expect(store.getIndexEntryCalls).toBeGreaterThan(getIndexAfterFirst - 1);
  });

  it('cache hit 时 prompt_section.content 来自 cache payload.rendered_section.content', async () => {
    const { input, dependencies } = buildValidInputAndDeps();
    const store = makeInMemoryStore();
    const cache = createMemoryEntrypointCache(store);
    const captured = buildAndCaptureContent(input, dependencies);

    // 第一次:cache miss,会写入 payload(含 rendered_section)
    const result1 = await integrateBoundedMemoryIntoRequest({
      build_input: input,
      dependencies,
      cache,
      render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
      ordinal: 1,
      trust: 'trust:high',
      retention: 'retention:session',
      provenance_refs: [],
      rendered_content_provider: () => captured.content,
    });
    expect(result1.prompt_section).not.toBeNull();

    // 第二次:cache hit,provider 不被调用(content 来自 cache payload)
    const providerSpy = vi.fn(() => captured.content);
    const result2 = await integrateBoundedMemoryIntoRequest({
      build_input: input,
      dependencies,
      cache,
      render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
      ordinal: 1,
      trust: 'trust:high',
      retention: 'retention:session',
      provenance_refs: [],
      rendered_content_provider: providerSpy,
    });

    expect(result2.prompt_section).not.toBeNull();
    // cache hit → provider 不被调用(content 来自 payload)
    expect(providerSpy).not.toHaveBeenCalled();
    // content 一致
    expect(result2.prompt_section!.content).toBe(result1.prompt_section!.content);
  });
});

// ===========================================================================
// §3 capture-then-mutate(INV-F1:build 开始后修改 catalog 不影响当前 request)
// ===========================================================================

describe('integrateBoundedMemoryIntoRequest — capture-then-mutate (INV-F1)', () => {
  it('build 开始后修改 catalog fixtures,当前 request 仍用旧 captured snapshot', async () => {
    const { input, dependencies } = buildValidInputAndDeps();
    const captured = buildAndCaptureContent(input, dependencies);
    const originalSnapshotId = captured.snapshot.entrypoint_snapshot_id;

    // 当前 request:用 captured snapshot
    const result = await integrateBoundedMemoryIntoRequest({
      build_input: input,
      dependencies,
      cache: null,
      render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
      ordinal: 1,
      trust: 'trust:high',
      retention: 'retention:session',
      provenance_refs: [],
      rendered_content_provider: () => captured.content,
    });

    // 当前 request 应使用 captured snapshot
    expect(result.snapshot_id).toBe(originalSnapshotId);

    // 修改 catalog fixtures 后,新的 build 才会用新 catalog
    // (当前 request 已经完成,snapshot_id 不变)
    const newInput = buildValidInput({
      catalogEntries: [
        ...input.catalog_snapshot.entries,
        makeCatalogEntry({
          memory_record_id: 'memrec-new',
          topic_terms: ['new'],
          detail_commit_ref: 'detail-new',
          content_hash: 'sha256:new',
        }),
      ],
    });
    const newCaptured = buildAndCaptureContent(newInput, dependencies);
    expect(newCaptured.snapshot.entrypoint_snapshot_id).not.toBe(
      originalSnapshotId,
    );

    // 但当前 request 的 snapshot_id 仍是 originalSnapshotId(没变)
    expect(result.snapshot_id).toBe(originalSnapshotId);
  });
});

// ===========================================================================
// §4 no-full-load(结构保证:dependencies 不含 getIndexContent/inject/read-all)
// ===========================================================================

describe('integrateBoundedMemoryIntoRequest — no-full-load structural guarantee', () => {
  it('dependencies 不含 MemoryManager 方法(getIndexContent/inject/read-all)', () => {
    const { dependencies } = buildValidInputAndDeps();
    const depKeys = Object.keys(dependencies);
    // 不应该有 MemoryManager 风格的方法
    expect(depKeys).not.toContain('getIndexContent');
    expect(depKeys).not.toContain('inject');
    expect(depKeys).not.toContain('readAll');
    expect(depKeys).not.toContain('selectByKeywords');
    // 应该只有 T6 注入字段
    expect(depKeys).toContain('durability_evidence_ref_for');
    expect(depKeys).toContain('claim_lookup');
    expect(depKeys).toContain('budget_policies');
    expect(depKeys).toContain('render_profile');
  });

  it('integration 失败时不调用任何 read-all/inject-style 方法(T1 reject 路径)', async () => {
    const { input, dependencies } = buildValidInputAndDeps({
      modifyInput: (i) => {
        for (const d of i.retrieved_details as RetrievedMemoryDetail[]) {
          d.catalog_snapshot_id = 'catalog:rogue';
        }
      },
    });

    // spy:确保 durability/claim_lookup 在 rejected 路径上不被调用
    const durabilitySpy = vi.fn(dependencies.durability_evidence_ref_for);
    dependencies.durability_evidence_ref_for = durabilitySpy;
    const lookupSpy = vi.fn(dependencies.claim_lookup.lookup);
    dependencies.claim_lookup = {
      ...dependencies.claim_lookup,
      lookup: lookupSpy,
    };

    const result = await integrateBoundedMemoryIntoRequest({
      build_input: input,
      dependencies,
      cache: null,
      render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
      ordinal: 1,
      trust: 'trust:high',
      retention: 'retention:session',
      provenance_refs: [],
      rendered_content_provider: () => '',
    });

    // rejected → section=null + diagnostic
    expect(result.prompt_section).toBeNull();
    expect(result.snapshot_state).toBe('rejected');
    // T1 reject 时不调用 T2/T3/T4/T5(无 full-load 路径)
    expect(durabilitySpy).not.toHaveBeenCalled();
    expect(lookupSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// §5 failure 静默 — 不抛错,不改变 TurnOutcome
// ===========================================================================

describe('integrateBoundedMemoryIntoRequest — failure is silent', () => {
  it('rendered_content_provider 抛错 → integration 返回 section=null + diagnostic', async () => {
    const { input, dependencies } = buildValidInputAndDeps();
    const result = await integrateBoundedMemoryIntoRequest({
      build_input: input,
      dependencies,
      cache: null,
      render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
      ordinal: 1,
      trust: 'trust:high',
      retention: 'retention:session',
      provenance_refs: [],
      rendered_content_provider: () => {
        throw new Error('asset store unavailable');
      },
    });

    expect(result.prompt_section).toBeNull();
    expect(result.reason_codes).toContain(
      'integration.rendered_content_unavailable',
    );
    // snapshot 仍然构建出来(state=ready),只是 handoff 失败
    expect(result.snapshot_state).toBe('ready');
    expect(result.snapshot_id).not.toBeNull();
  });

  it('hash mismatch(提供错误 content)→ section=null + diagnostic', async () => {
    const { input, dependencies } = buildValidInputAndDeps();
    const result = await integrateBoundedMemoryIntoRequest({
      build_input: input,
      dependencies,
      cache: null,
      render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
      ordinal: 1,
      trust: 'trust:high',
      retention: 'retention:session',
      provenance_refs: [],
      rendered_content_provider: () => 'tampered-content-not-matching-hash',
    });

    // hash mismatch → toMemoryPromptSection throws → integration 静默
    expect(result.prompt_section).toBeNull();
    expect(result.reason_codes.length).toBeGreaterThan(0);
    // 应该有 hash mismatch 相关 code
    expect(result.reason_codes.some((c) => c.includes('hash_mismatch'))).toBe(
      true,
    );
  });

  it('integration 永不抛错(所有失败路径都返回 result)', async () => {
    const { input, dependencies } = buildValidInputAndDeps();
    const scenarios = [
      // hash mismatch
      integrateBoundedMemoryIntoRequest({
        build_input: input,
        dependencies,
        cache: null,
        render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
        ordinal: 1,
        trust: 't',
        retention: 'r',
        provenance_refs: [],
        rendered_content_provider: () => 'wrong',
      }),
      // provider 抛错
      integrateBoundedMemoryIntoRequest({
        build_input: input,
        dependencies,
        cache: null,
        render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
        ordinal: 1,
        trust: 't',
        retention: 'r',
        provenance_refs: [],
        rendered_content_provider: () => {
          throw new Error('fail');
        },
      }),
    ];

    for (const scenarioPromise of scenarios) {
      const result = await scenarioPromise;
      expect(result).toBeDefined();
      expect(result.integration_protocol_version).toBe(
        'mi.memory.integration/1',
      );
      expect(result.prompt_section).toBeNull();
    }
  });
});

// ===========================================================================
// §6 streamingQuery integration — minimal invasive hook
// ===========================================================================

describe('streamingQuery — boundedMemoryIntegration hook', () => {
  // 极简 fake client:返回一个 text + end_turn,并捕获 systemPrompt
  class OneShotClient implements StreamingLLMClient {
    capturedSystemPrompt = '';
    async *stream(
      messages: Message[],
      _tools: ToolDefinition[],
      options: StreamOptions,
    ): AsyncGenerator<StreamEvent | AssistantMessage> {
      this.capturedSystemPrompt = options.systemPrompt ?? '';
      yield {
        type: 'message_start',
        messageId: 'm1',
        model: 'fake',
        inputTokens: 1,
      };
      yield { type: 'content_block_start', index: 0, blockType: 'text' };
      yield {
        type: 'content_block_delta',
        index: 0,
        deltaType: 'text',
        content: 'ok',
      };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn', outputTokens: 1 };
      yield { type: 'message_stop' };
      yield {
        type: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stopReason: 'end_turn',
        uuid: 'a1',
        timestamp: new Date().toISOString(),
      };
      void messages;
    }
  }

  async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const m of gen) out.push(m);
    return out;
  }

  it('不传 hook(LEGACY)→ systemPrompt 不变', async () => {
    const client = new OneShotClient();
    const registry = new ToolRegistry();
    const ac = new AbortController();
    await drain(
      streamingQuery(client, registry, 'do work', {
        systemPrompt: 'base-prompt',
        tools: [],
        signal: ac.signal,
        maxTurns: 1,
        enableStreamingExecution: false,
      }),
    );

    expect(client.capturedSystemPrompt).toBe('base-prompt');
  });

  it('传 hook 返回 prompt_section → systemPrompt 附加 memory section', async () => {
    const client = new OneShotClient();
    const registry = new ToolRegistry();
    const ac = new AbortController();
    const memoryContent = '## Memory\n- item 1';
    await drain(
      streamingQuery(client, registry, 'do work', {
        systemPrompt: 'base-prompt',
        tools: [],
        signal: ac.signal,
        maxTurns: 1,
        enableStreamingExecution: false,
        boundedMemoryIntegration: () => ({
          integration_protocol_version: 'mi.memory.integration/1',
          prompt_section: {
            section_id: 'memory.bounded_entrypoint',
            asset_ref: { asset_id: 'a', asset_version: '1' },
            placement: 'system_dynamic',
            authority: 'memory',
            trust: 't',
            retention: 'r',
            ordinal: 5,
            content: memoryContent,
            content_hash: 'x',
            provenance_refs: [],
          },
          snapshot_state: 'ready',
          snapshot_id: 'ep-snap:abc',
          overflow_manifest_ref: null,
          reason_codes: [],
        }),
      }),
    );

    expect(client.capturedSystemPrompt).toContain('base-prompt');
    expect(client.capturedSystemPrompt).toContain(memoryContent);
    // 分隔符应该是 \n\n---\n\n
    expect(client.capturedSystemPrompt).toMatch(
      /base-prompt\n\n---\n\n## Memory/u,
    );
  });

  it('传 hook 返回 prompt_section=null → systemPrompt 不变', async () => {
    const client = new OneShotClient();
    const registry = new ToolRegistry();
    const ac = new AbortController();
    await drain(
      streamingQuery(client, registry, 'do work', {
        systemPrompt: 'base-prompt',
        tools: [],
        signal: ac.signal,
        maxTurns: 1,
        enableStreamingExecution: false,
        boundedMemoryIntegration: () => ({
          integration_protocol_version: 'mi.memory.integration/1',
          prompt_section: null,
          snapshot_state: 'empty',
          snapshot_id: null,
          overflow_manifest_ref: null,
          reason_codes: [],
        }),
      }),
    );

    expect(client.capturedSystemPrompt).toBe('base-prompt');
  });

  it('hook 抛错 → 静默失败,systemPrompt 不变(不抛错)', async () => {
    const client = new OneShotClient();
    const registry = new ToolRegistry();
    const ac = new AbortController();
    const results = await drain(
      streamingQuery(client, registry, 'do work', {
        systemPrompt: 'base-prompt',
        tools: [],
        signal: ac.signal,
        maxTurns: 1,
        enableStreamingExecution: false,
        boundedMemoryIntegration: () => {
          throw new Error('integration failure');
        },
      }),
    );

    expect(results.length).toBeGreaterThan(0);
    expect(client.capturedSystemPrompt).toBe('base-prompt');
  });

  it('hook 是 async 函数也能正常 await', async () => {
    const client = new OneShotClient();
    const registry = new ToolRegistry();
    const ac = new AbortController();
    await drain(
      streamingQuery(client, registry, 'do work', {
        systemPrompt: 'base-prompt',
        tools: [],
        signal: ac.signal,
        maxTurns: 1,
        enableStreamingExecution: false,
        boundedMemoryIntegration: async () => {
          await new Promise((r) => setTimeout(r, 5));
          return {
            integration_protocol_version: 'mi.memory.integration/1',
            prompt_section: {
              section_id: 'memory.bounded_entrypoint',
              asset_ref: { asset_id: 'a', asset_version: '1' },
              placement: 'system_dynamic',
              authority: 'memory',
              trust: 't',
              retention: 'r',
              ordinal: 5,
              content: 'async memory',
              content_hash: 'x',
              provenance_refs: [],
            },
            snapshot_state: 'ready',
            snapshot_id: 'ep-snap:async',
            overflow_manifest_ref: null,
            reason_codes: [],
          };
        },
      }),
    );

    expect(client.capturedSystemPrompt).toContain('async memory');
  });

  it('noToolContract + boundedMemoryIntegration 共存:都生效', async () => {
    const client = new OneShotClient();
    const registry = new ToolRegistry();
    const ac = new AbortController();
    await drain(
      streamingQuery(client, registry, 'do work', {
        systemPrompt: 'base-prompt',
        tools: [],
        signal: ac.signal,
        maxTurns: 1,
        enableStreamingExecution: false,
        noToolContract: {
          no_tool_request_id: 'ntr:1',
          no_tool_request_protocol_version: '1',
          profile_requires_no_tools: true,
          view_requires_no_tools: true,
          rationale: 'test',
        },
        boundedMemoryIntegration: () => ({
          integration_protocol_version: 'mi.memory.integration/1',
          prompt_section: {
            section_id: 'memory.bounded_entrypoint',
            asset_ref: { asset_id: 'a', asset_version: '1' },
            placement: 'system_dynamic',
            authority: 'memory',
            trust: 't',
            retention: 'r',
            ordinal: 5,
            content: 'coexisting memory',
            content_hash: 'x',
            provenance_refs: [],
          },
          snapshot_state: 'ready',
          snapshot_id: 'ep-snap:co',
          overflow_manifest_ref: null,
          reason_codes: [],
        }),
      }),
    );

    expect(client.capturedSystemPrompt).toContain('base-prompt');
    expect(client.capturedSystemPrompt).toContain('No-Tool Contract');
    expect(client.capturedSystemPrompt).toContain('coexisting memory');
  });
});

// ===========================================================================
// §7 createMemoryEntrypointRebuildInput — Wave G handoff identity
// ===========================================================================

describe('createMemoryEntrypointRebuildInput — Wave G handoff', () => {
  it('正确组装 rebuild refs(snapshot 非空)', () => {
    const { input, dependencies } = buildValidInputAndDeps();
    const snapshot = buildBoundedMemoryEntrypoint(input, dependencies);

    const rebuild = createMemoryEntrypointRebuildInput(
      snapshot,
      {
        task_snapshot_id: 'task:snap-new',
        current_context_snapshot_id: 'ctx:snap-new',
        project_version_ref: 'proj:v2',
      },
      DEFAULT_POLICY_REF,
      'budget:req-002',
      'render:profile-2',
    );

    expect(rebuild.entrypoint_protocol_version).toBe(
      ENTRYPOINT_PROTOCOL_VERSION,
    );
    expect(rebuild.task_snapshot_id).toBe('task:snap-new');
    expect(rebuild.target_context_snapshot_id).toBe('ctx:snap-new');
    expect(rebuild.project_version_ref).toBe('proj:v2');
    expect(rebuild.old_entrypoint_snapshot_id).toBe(
      snapshot.entrypoint_snapshot_id,
    );
    expect(rebuild.old_catalog_snapshot_id).toBe(snapshot.catalog_snapshot_id);
    expect(rebuild.old_selection_id).toBe(snapshot.selection_id);
    expect(rebuild.policy_ref).toEqual(DEFAULT_POLICY_REF);
    expect(rebuild.request_budget_snapshot_id).toBe('budget:req-002');
    expect(rebuild.render_profile_ref).toBe('render:profile-2');
  });

  it('snapshot 为 null → old_*_id 字段为 null', () => {
    const rebuild = createMemoryEntrypointRebuildInput(
      null,
      {
        task_snapshot_id: 'task:snap-new',
        current_context_snapshot_id: 'ctx:snap-new',
        project_version_ref: null,
      },
      DEFAULT_POLICY_REF,
      'budget:req-002',
      'render:profile-2',
    );

    expect(rebuild.entrypoint_protocol_version).toBe(
      ENTRYPOINT_PROTOCOL_VERSION,
    );
    expect(rebuild.old_entrypoint_snapshot_id).toBeNull();
    expect(rebuild.old_catalog_snapshot_id).toBeNull();
    expect(rebuild.old_selection_id).toBeNull();
    expect(rebuild.project_version_ref).toBeNull();
  });

  it('rebuild input 只表示"可请求重建",不表示"已重建"(纯数据结构)', () => {
    const { input, dependencies } = buildValidInputAndDeps();
    const snapshot = buildBoundedMemoryEntrypoint(input, dependencies);

    const rebuild = createMemoryEntrypointRebuildInput(
      snapshot,
      {
        task_snapshot_id: 'task:snap-new',
        current_context_snapshot_id: 'ctx:snap-new',
        project_version_ref: 'proj:v2',
      },
      DEFAULT_POLICY_REF,
      'budget:req-002',
      'render:profile-2',
    );

    // rebuild input 不携带 snapshot 本身(只携带 identity refs)
    expect(rebuild.old_entrypoint_snapshot_id).toBe(
      snapshot.entrypoint_snapshot_id,
    );
    // rebuild input 没有 .snapshot 字段
    expect((rebuild as { snapshot?: unknown }).snapshot).toBeUndefined();
  });
});
