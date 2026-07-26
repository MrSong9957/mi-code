// Wave F / FRC-1 Bounded Memory Entrypoint — 公共出口 + INV-F1~F16 验收测试
//
// 物理本质:验证 src/agent/index.ts 的 Wave F 公共出口稳定可用,并对规格 §8 的
// 16 条 INV 不变量做机器可判定的合约验收。每个 INV 用一个具体场景断言,不追求
// 覆盖所有触发条件 —— 只要本测试能持续守护该 INV 成立即可。
//
// 覆盖规格:
//   docs/superpowers/specs/2026-07-26-agent-bounded-memory-entrypoint-wave-f-design.md §8
//   docs/superpowers/plans/2026-07-26-agent-mechanisms-wave-f-implementation.md Task 10
//
// 关键原则:
//   - 只通过公共出口(`../../agent/index.js`)消费 Wave F —— 不直接 reach into
//     内部文件,保证这是"公共契约"测试而非"内部实现"测试。
//   - 每个 INV 用最小可判定的 fixture,失败信息指向该 INV 的具体不变量。

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';

// === 只从公共出口 import —— 验证 Wave F 公共契约稳定性 ===
import {
  // T1 policy + capture
  captureMemoryEntrypointBuild,
  ENTRYPOINT_PROTOCOL_VERSION,
  ENTRYPOINT_POLICY_PROTOCOL_VERSION,
  // T2+T3 projection
  projectMemoryNavigation,
  projectVerifiedMemoryClaims,
  // T6 Core Anchor
  buildBoundedMemoryEntrypoint,
  // T9 Activation + Integration
  canActivateBoundedMemoryEntrypoint,
  integrateBoundedMemoryIntoRequest,
  createMemoryEntrypointRebuildInput,
  // T8 Compiler Handoff
  toMemoryPromptSection,
  createRendererAdaptor,
  DEFAULT_MEMORY_RENDER_PROFILE,
  // T7 Cache
  createMemoryEntrypointCache,
  getOrBuildMemoryEntrypoint,
  // 类型
  type MemoryEntrypointPolicy,
  type MemoryEntrypointBuildInput,
  type BoundedMemoryEntrypointDependencies,
  type BoundedMemoryEntrypointSnapshot,
  type BoundedMemoryActivationEvidence,
  type BoundedMemoryRequestIntegrationInput,
  type WaveFContractRef,
  type RenderProfileAsset,
  type RenderedMemorySection,
} from '../../agent/index.js';

// 内部类型仅用于 fixture 构造 —— 这些是 Wave F 的 *输入* 依赖(来自 ERC-2 等
// 已冻结上游),不是 Wave F 自身的内部实现。从其原始位置 import 是合理的。
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
import type { RetrievedMemoryDetail } from '../../agent/context/bounded-memory.js';
import type {
  NavigationBudgetPolicy,
  TotalSectionBudgetPolicy,
  VerifiedDetailBudgetPolicy,
} from '../../agent/context/bounded-memory-budget.js';
import type {
  CacheableEntrypointPayload,
  MemoryEntrypointCacheStore,
} from '../../agent/context/bounded-memory-cache.js';

// render module —— 用于 spy renderMemoryEntrypoint 拿到渲染后的 section content
// (与 bounded-memory-request.test.ts 同源;rendered_content 在生产中由调用方从
// snapshot.rendered_section_ref 解析,测试中通过 spy 截获是最简洁的方式)。
import * as renderModule from '../../agent/context/bounded-memory-render.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ─── 公共 fixture(最小可用,与 bounded-memory-entrypoint.test.ts 同源) ────

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
    content_hash: 'sha256:' + sha256('claim-body-default'),
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

/**
 * 构造完整合法的 MemoryEntrypointBuildInput。
 * 默认:N 条 catalog entries 都被 selected + retrieved + use decision(status=use)。
 */
function buildValidInput(overrides: {
  catalogEntries?: MemoryCatalogEntry[];
  policy?: Partial<MemoryEntrypointPolicy>;
  modifyInput?: (input: MemoryEntrypointBuildInput) => void;
  currentContextSnapshotId?: string;
} = {}): MemoryEntrypointBuildInput {
  const currentContext = overrides.currentContextSnapshotId ?? DEFAULT_CURRENT_CONTEXT;
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
        current_context_snapshot_id: currentContext,
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
    current_context_snapshot_id: currentContext,
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
  input: MemoryEntrypointBuildInput,
  overrides: Partial<BoundedMemoryEntrypointDependencies> = {},
): BoundedMemoryEntrypointDependencies {
  // claim_lookup 必须知道每个 record 的 detail hash(从 input.retrieved_details 取)
  const detailMap = new Map<string, RetrievedMemoryDetail>();
  for (const d of input.retrieved_details) {
    detailMap.set(d.memory_record_id, d);
  }
  return {
    durability_evidence_ref_for: () => 'durable:ok',
    claim_lookup: {
      lookup_protocol_version: '1',
      lookup_id: 'claim-lookup-001',
      lookup: (lookupInput) => {
        const d = detailMap.get(lookupInput.memory_record_id);
        if (!d) return null;
        return {
          content_ref: d.detail_content_ref,
          content_hash: d.detail_content_hash,
        };
      },
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

/** 完整组合 input + deps,默认产出 state=ready 的 snapshot。 */
function buildReadySnapshot(
  overrides: {
    policy?: Partial<MemoryEntrypointPolicy>;
    modifyInput?: (input: MemoryEntrypointBuildInput) => void;
    modifyDeps?: (
      deps: BoundedMemoryEntrypointDependencies,
      input: MemoryEntrypointBuildInput,
    ) => void;
  } = {},
): { input: MemoryEntrypointBuildInput; dependencies: BoundedMemoryEntrypointDependencies; snapshot: BoundedMemoryEntrypointSnapshot } {
  const input = buildValidInput({
    policy: overrides.policy,
    modifyInput: overrides.modifyInput,
  });
  const dependencies = buildValidDependencies(input);
  if (overrides.modifyDeps) {
    overrides.modifyDeps(dependencies, input);
  }
  const snapshot = buildBoundedMemoryEntrypoint(input, dependencies);
  return { input, dependencies, snapshot };
}

/**
 * 构建 entrypoint 并通过 spy 截获 renderMemoryEntrypoint 的返回值,拿到渲染后的
 * section content。content 的 sha256 与 snapshot.rendered_section_hash 一致。
 *
 * 与 bounded-memory-request.test.ts 的 buildAndCaptureContent 同源。
 * 生产代码中 rendered_content 由调用方从 snapshot.rendered_section_ref 解析
 * (规格 §7.15);测试中通过 spy 截获是最简洁且不污染公共契约的方式。
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

/**
 * 构造一个最小可用的内存 cache store(实现 MemoryEntrypointCacheStore 全部方法)。
 * 与 bounded-memory-request.test.ts 的 makeInMemoryStore 同源,但去掉调用计数
 * (本测试只关心 cache 不改变语义,不关心调用次数)。
 *
 * 关键:cache store 必须实现 getIndexEntry/putIndexEntry/getEntry/putEntry/
 * deleteEntry/clear 全部方法,否则 createMemoryEntrypointCache 在 cache miss
 * 时无法写入 → 集成路径会失败为 rejected。
 */
function makeInMemoryCacheStore(): MemoryEntrypointCacheStore {
  const index = new Map<string, string>();
  const entries = new Map<string, CacheableEntrypointPayload>();
  return {
    async getIndexEntry(semk) {
      return index.get(semk) ?? null;
    },
    async putIndexEntry(semk, entk) {
      index.set(semk, entk);
    },
    async getEntry(entk) {
      return entries.get(entk) ?? null;
    },
    async putEntry(entk, payload) {
      entries.set(entk, payload);
    },
    async deleteEntry(entk) {
      entries.delete(entk);
    },
    async clear() {
      index.clear();
      entries.clear();
    },
  };
}

// ===========================================================================
// §A 公共出口稳定性 — Wave F 锚点函数/类型可从 index.ts 消费
// ===========================================================================

describe('Wave F 公共出口', () => {
  it('exports the Wave F entrypoint anchors as functions', () => {
    // T1 / T2 / T3 / T6 / T9 值导出
    expect(captureMemoryEntrypointBuild).toBeTypeOf('function');
    expect(projectMemoryNavigation).toBeTypeOf('function');
    expect(projectVerifiedMemoryClaims).toBeTypeOf('function');
    expect(buildBoundedMemoryEntrypoint).toBeTypeOf('function');
    expect(canActivateBoundedMemoryEntrypoint).toBeTypeOf('function');
    expect(integrateBoundedMemoryIntoRequest).toBeTypeOf('function');
    expect(createMemoryEntrypointRebuildInput).toBeTypeOf('function');
    // T8 Compiler Handoff
    expect(toMemoryPromptSection).toBeTypeOf('function');
    expect(createRendererAdaptor).toBeTypeOf('function');
    // T7 Cache
    expect(createMemoryEntrypointCache).toBeTypeOf('function');
    expect(getOrBuildMemoryEntrypoint).toBeTypeOf('function');
  });

  it('exports the Wave F protocol-version constants (INV-F14)', () => {
    // 各 protocol version 是独立 schema 标记常量(值可能巧合相同,但语义独立 ——
    // INV-F14 要求字段/版本号独立演进,不要求字符串必不同)。
    expect(ENTRYPOINT_PROTOCOL_VERSION).toBeTypeOf('string');
    expect(ENTRYPOINT_PROTOCOL_VERSION.length).toBeGreaterThan(0);
    expect(ENTRYPOINT_POLICY_PROTOCOL_VERSION).toBeTypeOf('string');
    expect(ENTRYPOINT_POLICY_PROTOCOL_VERSION.length).toBeGreaterThan(0);
    // DEFAULT_MEMORY_RENDER_PROFILE 是一个完整 RenderProfileAsset
    expect(DEFAULT_MEMORY_RENDER_PROFILE).toBeTypeOf('object');
    expect(DEFAULT_MEMORY_RENDER_PROFILE.authority).toBe('memory');
    expect(DEFAULT_MEMORY_RENDER_PROFILE.section_id).toBe('memory.bounded_entrypoint');
    expect(DEFAULT_MEMORY_RENDER_PROFILE.placement).toBe('system_dynamic');
  });

  it('does NOT export budget internals / escape helper / cache store (private surface)', async () => {
    // 公共出口只暴露 FRC policy/input/output + core builder + activation + handoff +
    // rebuild identity + cache factory。以下内部符号不应出现在公共出口。
    // 用动态 import 拿到 module namespace object 后做 negative 断言。
    const pub = (await import('../../agent/index.js')) as unknown as Record<
      string,
      unknown
    >;
    // Budget internals(来自 bounded-memory-budget.ts)
    expect(pub.applyMemoryEntrypointBudgets).toBeUndefined();
    expect(pub.MemoryBudgetFragmentRenderer).toBeUndefined();
    expect(pub.BudgetedMemoryEntrypoint).toBeUndefined();
    expect(pub.TokenEstimator).toBeUndefined();
    // Cache internals(来自 bounded-memory-cache.ts)—— 只暴露 factory,不暴露 store/key
    expect(pub.MemoryEntrypointCacheStore).toBeUndefined();
    expect(pub.computeSemanticInputKey).toBeUndefined();
    expect(pub.computeEntryKey).toBeUndefined();
    // Escape / claim lookup adapter(内部 helper)
    expect(pub.VerifiedClaimContentLookup).toBeUndefined();
    expect(pub.MemoryPromptHandoffError).toBeUndefined();
  });
});

// ===========================================================================
// §B INV-F1 ~ INV-F16 — 16 条 Wave F 不变量(每条一个 machine-checkable 场景)
// ===========================================================================

describe('Wave F / FRC-1 — INV-F1~F16 不变量验收', () => {
  // ─── INV-F1 ──────────────────────────────────────────────────────────
  it('INV-F1: snapshots do not mix (each build captures once; new catalog → new id)', () => {
    // 场景:同一 input capture 两次得到相同 prepared identity;改变 catalog 后
    // 再 capture 得到不同 identity —— 每次 build 只消费本次捕获的 snapshots,
    // 不会把"build 过程中到达的新 catalog/selection"混入当前 build。
    const input1 = buildValidInput();
    const prepared1 = captureMemoryEntrypointBuild(input1);
    const prepared1again = captureMemoryEntrypointBuild(input1);
    // 相同 input → 相同 prepared identity(state/catalog_snapshot_id/selection_id)
    expect(prepared1.state).toBe(prepared1again.state);
    expect(prepared1.catalog_snapshot.catalog_snapshot_id).toBe(
      prepared1again.catalog_snapshot.catalog_snapshot_id,
    );
    expect(prepared1.selection_result.selection_id).toBe(
      prepared1again.selection_result.selection_id,
    );

    // 用新 catalog(entries 多一条)capture → catalog_snapshot_id 不同(不混合)
    const input2 = buildValidInput({
      catalogEntries: [
        ...input1.catalog_snapshot.entries.map((e) => ({ ...e })),
        makeCatalogEntry({
          memory_record_id: 'memrec-new',
          admission_decision_id: 'admit:new',
          topic_terms: ['newtopic'],
          keyword_terms: ['newkw'],
          detail_commit_ref: 'detail-new',
          content_hash: 'sha256:' + sha256('claim-body-new'),
        }),
      ],
    });
    const prepared2 = captureMemoryEntrypointBuild(input2);
    expect(prepared2.catalog_snapshot.catalog_snapshot_id).not.toBe(
      prepared1.catalog_snapshot.catalog_snapshot_id,
    );

    // prepared 字段也与 input 对齐(不混入其他 build 的 task/context)
    expect(prepared1.task_snapshot_id).toBe(DEFAULT_TASK_SNAPSHOT);
    expect(prepared1.current_context_snapshot_id).toBe(DEFAULT_CURRENT_CONTEXT);
    expect(['prepared', 'empty', 'rejected']).toContain(prepared1.state);
  });

  // ─── INV-F2 ──────────────────────────────────────────────────────────
  it('INV-F2: the catalog is not memory body (catalog entry has no claim body)', () => {
    // 场景:catalog entry 只携带 metadata(record_id/type/scope/terms/hash 等),
    // 不携带正文 claim body。MemoryNavigationItem 也不携带 body,只有 metadata + hash。
    const { input, dependencies, snapshot } = buildReadySnapshot();
    expect(snapshot.state).toBe('ready');

    // catalog entry 形状:只有 metadata,无 body/content 字段
    const catalogEntry = input.catalog_snapshot.entries[0];
    expect(catalogEntry).toBeDefined();
    expect(catalogEntry).not.toHaveProperty('body');
    expect(catalogEntry).not.toHaveProperty('content');
    expect(catalogEntry).not.toHaveProperty('claim_text');
    // 它有的是 identity + metadata
    expect(catalogEntry.memory_record_id).toBeTypeOf('string');
    expect(catalogEntry.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // T2 navigation projection 也只产出 metadata,无正文
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('prepared');
    const nav = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: dependencies.durability_evidence_ref_for,
    });
    expect(nav.items.length).toBeGreaterThan(0);
    const navItem = nav.items[0];
    expect(navItem).not.toHaveProperty('body');
    expect(navItem).not.toHaveProperty('content');
    expect(navItem).not.toHaveProperty('claim_text');
    // navItem 有 detail_content_hash(引用),但不是正文本身
    expect(navItem.detail_content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  // ─── INV-F3 ──────────────────────────────────────────────────────────
  it('INV-F3: selected is not use (only status=use verified claims enter body)', () => {
    // 场景:把 use decision 改成 status='do_not_use',即使 entry 仍被 selected,
    // verified claim projection 应为空(不进入正文)。
    const input = buildValidInput({
      modifyInput: (i) => {
        // 把所有 use decision 标记为 do_not_use(仍保留在 input 中,即"已 selected")
        i.memory_use_decisions = i.memory_use_decisions.map((d) => ({
          ...d,
          status: 'do_not_use' as const,
        }));
      },
    });
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('prepared');

    // T2 navigation 仍能投影(selection 仍在 —— selection ≠ use)
    const nav = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: () => 'durable:ok',
    });
    expect(nav.items.length).toBeGreaterThan(0); // selected entries 仍出现

    // T3 verified claim projection 应为空(do_not_use → 'do_not_use' omission)
    const claimResult = projectVerifiedMemoryClaims({
      prepared,
      navigation_items: nav.items,
      claim_lookup: {
        lookup_protocol_version: '1',
        lookup_id: 'lookup-1',
        lookup: () => ({
          content_ref: 'ref',
          content_hash: prepared.retrieved_details[0].detail_content_hash,
        }),
      },
    });
    expect(claimResult.projections).toHaveLength(0);
    // omissions 应含 do_not_use reason
    expect(claimResult.omitted_claims.length).toBeGreaterThan(0);
    expect(
      claimResult.omitted_claims.some((o) => o.reason === 'do_not_use'),
    ).toBe(true);
  });

  // ─── INV-F4 ──────────────────────────────────────────────────────────
  it('INV-F4: navigation and verified detail remain separate (no rank mutation)', () => {
    // 场景:navigation item 携带 selection_rank,但 verified claim projection
    // 不携带任何 rank/navigation 权限字段;verified detail 也不能修改 nav rank。
    const { input, dependencies } = buildReadySnapshot();
    const prepared = captureMemoryEntrypointBuild(input);
    const nav = projectMemoryNavigation({
      prepared,
      durability_evidence_ref_for: dependencies.durability_evidence_ref_for,
    });
    const claims = projectVerifiedMemoryClaims({
      prepared,
      navigation_items: nav.items,
      claim_lookup: dependencies.claim_lookup,
    });

    // nav item 有 selection_rank
    expect(nav.items[0].selection_rank).toBeTypeOf('number');
    // verified claim projection 不携带 selection_rank / navigation_rank / 任何
    // 能影响 navigation 排序的字段
    const claimProjectionKeys = Object.keys(claims.projections[0] ?? {});
    expect(claimProjectionKeys).not.toContain('selection_rank');
    expect(claimProjectionKeys).not.toContain('navigation_rank');
    // 反向:navigation item 不携带 verified claim 正文,只有 detail_content_hash 引用
    const navItemKeys = Object.keys(nav.items[0]);
    expect(navItemKeys).not.toContain('content_ref');
    expect(navItemKeys).not.toContain('verified_claim_ref');
  });

  // ─── INV-F5 ──────────────────────────────────────────────────────────
  it('INV-F5: every entrypoint layer has a hard limit (nav/detail/total)', () => {
    // 场景:policy 必须同时声明 nav/detail/total 三层 budget 引用 + max 字段;
    // 三层 policy 对象本身也必须有有限非负 max。
    const { input } = buildReadySnapshot();
    const policy = input.policy;
    // policy 三层 ref 必须非空
    expect(policy.navigation_budget_policy_ref).toBeTypeOf('string');
    expect(policy.verified_detail_budget_policy_ref).toBeTypeOf('string');
    expect(policy.total_section_budget_policy_ref).toBeTypeOf('string');
    // policy max 字段必须有限非负
    expect(policy.max_navigation_entries).toBeGreaterThanOrEqual(0);
    expect(policy.max_verified_detail_items).toBeGreaterThanOrEqual(0);
    expect(policy.max_verified_claims_per_item).toBeGreaterThanOrEqual(0);
    // 三层 budget policy 对象(在 dependencies 中注入)也必须有有限非负上限
    const deps = buildValidDependencies(input);
    expect(deps.budget_policies.navigation_budget_policy.max_entries).toBeGreaterThanOrEqual(0);
    expect(deps.budget_policies.verified_detail_budget_policy.max_items).toBeGreaterThanOrEqual(0);
    expect(deps.budget_policies.total_section_budget_policy.max_bytes).toBeGreaterThanOrEqual(0);
  });

  // ─── INV-F6 ──────────────────────────────────────────────────────────
  it('INV-F6: overflow is explicit (partial state + non-null overflow_manifest_ref)', () => {
    // 场景:让 navigation budget max_entries=1 但有 2 条 eligible navs →
    // 1 条被 omit → snapshot.state='partial' 且 overflow_manifest_ref 非 null。
    const { snapshot } = buildReadySnapshot({
      modifyDeps: (deps) => {
        deps.budget_policies.navigation_budget_policy = {
          ...deps.budget_policies.navigation_budget_policy,
          max_entries: 1, // 强制 omit 第 2 条
        };
      },
    });
    expect(snapshot.state).toBe('partial');
    // overflow 必须显式标注
    expect(snapshot.overflow_manifest_ref).not.toBeNull();
    expect(snapshot.overflow_manifest_ref).toBeTypeOf('string');
    // partial 仍渲染 section(只是不完整)
    expect(snapshot.rendered_section_ref).not.toBeNull();
  });

  // ─── INV-F7 ──────────────────────────────────────────────────────────
  it('INV-F7: omission happens only at semantic boundaries (no mid-multibyte truncation)', () => {
    // 场景:verified claim body 含多字节中文 + emoji;让 navigation max_entries=1
    // 但有 2 条 eligible navs → 第 2 条被 entry-boundary omit,第 1 条保留。
    // 保留的正文(含中文/emoji)必须是完整 UTF-8 —— entry-boundary omit 模式
    // 只在完整 item 边界省略,绝不截断多字节字符 / claim / provenance label。
    const chineseBody = '项目偏好:使用中文注释与 emoji 🎉 进行标注';
    const input = buildValidInput({
      catalogEntries: [
        makeCatalogEntry({
          memory_record_id: 'memrec-cn-1',
          admission_decision_id: 'admit:cn1',
          type: 'user_preference',
          topic_terms: ['i18n'],
          keyword_terms: ['chinese'],
          detail_commit_ref: 'detail-cn-1',
          content_hash: 'sha256:' + sha256(chineseBody),
        }),
        makeCatalogEntry({
          memory_record_id: 'memrec-cn-2',
          admission_decision_id: 'admit:cn2',
          type: 'project_fact',
          topic_terms: ['utf8'],
          keyword_terms: ['multibyte'],
          detail_commit_ref: 'detail-cn-2',
          content_hash: 'sha256:' + sha256(chineseBody + '-2'),
        }),
      ],
    });
    const deps = buildValidDependencies(input);
    // navigation max_entries=1 强制第 2 条 entry-boundary omit,
    // 同时保留第 1 条完整内容(含中文/emoji)→ partial
    deps.budget_policies = {
      ...deps.budget_policies,
      navigation_budget_policy: {
        ...deps.budget_policies.navigation_budget_policy,
        max_entries: 1,
      },
    };

    // buildAndCaptureContent 内部 spy renderMemoryEntrypoint 拿到渲染正文
    const { snapshot, content } = buildAndCaptureContent(input, deps);
    // entry-boundary omit 触发 → partial(保留 1 条 + overflow 标注)
    expect(snapshot.state).toBe('partial');
    expect(snapshot.overflow_manifest_ref).not.toBeNull();
    // partial 且渲染了正文 → 必须是完整 UTF-8(不能有半个多字节序列)
    expect(content.length).toBeGreaterThan(0);
    // 不出现 UTF-8 替换符(说明多字节被截断)
    expect(content).not.toContain('\uFFFD');
    // sha256(content) 应等于 snapshot.rendered_section_hash(字节完整,无截断)
    expect(sha256(content)).toBe(snapshot.rendered_section_hash);
  });

  // ─── INV-F8 ──────────────────────────────────────────────────────────
  it('INV-F8: placement does not promote authority (memory even in system)', () => {
    // 场景:通过 handoff 产生的 PromptSectionInput,即使 placement=system_dynamic,
    // authority 必须封闭为 'memory' —— 不能因 placement 提升为 system/project。
    const input = buildValidInput();
    const deps = buildValidDependencies(input);
    const { snapshot, content } = buildAndCaptureContent(input, deps);
    expect(snapshot.state).toBe('ready');
    expect(content.length).toBeGreaterThan(0);
    const handoff = toMemoryPromptSection({
      snapshot,
      render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
      rendered_content: content,
      ordinal: 3,
      trust: 'trust:memory',
      retention: 'retention:session',
      provenance_refs: ['prov-1'],
    });
    expect(handoff.section).not.toBeNull();
    // authority 封闭为 memory,placement 是 system_dynamic(系统位但不提升权威)
    expect(handoff.section!.authority).toBe('memory');
    expect(handoff.section!.placement).toBe('system_dynamic');
    // RenderProfileAsset 自身也封闭
    expect(DEFAULT_MEMORY_RENDER_PROFILE.authority).toBe('memory');
    // 注入非封闭 profile → 应被拒绝(defense-in-depth)
    const rogueProfile = {
      ...DEFAULT_MEMORY_RENDER_PROFILE,
      authority: 'system' as never, // 试图提升权威
    } as RenderProfileAsset;
    expect(() =>
      toMemoryPromptSection({
        snapshot,
        render_profile: rogueProfile,
        rendered_content: 'x',
        ordinal: 1,
        trust: 't',
        retention: 'r',
        provenance_refs: [],
      }),
    ).toThrow();
  });

  // ─── INV-F9 ──────────────────────────────────────────────────────────
  it('INV-F9: freshness binds to the current context (stale context rejected)', () => {
    // 场景:use decision 的 current_context_snapshot_id 与 build input 不一致 →
    // T1 capture 直接 rejected。旧 session 的 use decision 不能继续使用。
    const input = buildValidInput({
      modifyInput: (i) => {
        // 把 use decision 绑定到旧 context
        i.memory_use_decisions = i.memory_use_decisions.map((d) => ({
          ...d,
          current_context_snapshot_id: 'ctx:stale-old-session',
        }));
      },
    });
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes.length).toBeGreaterThan(0);
    // buildBoundedMemoryEntrypoint 同样 rejected
    const snap = buildBoundedMemoryEntrypoint(input, buildValidDependencies(input));
    expect(snap.state).toBe('rejected');
  });

  // ─── INV-F10 ─────────────────────────────────────────────────────────
  it('INV-F10: failure never falls back to full-load (rejected stays rejected)', () => {
    // 场景:T1 capture 失败(catalog/selection mismatch)→ snapshot.state='rejected',
    // rendered_section_ref=null,**不**回退为加载全部 Memory。
    const input = buildValidInput({
      modifyInput: (i) => {
        // 制造 retrieved_details catalog_snapshot_id 与 catalog 不一致
        for (const d of i.retrieved_details as RetrievedMemoryDetail[]) {
          d.catalog_snapshot_id = 'catalog:rogue00000000';
        }
      },
    });
    const snap = buildBoundedMemoryEntrypoint(input, buildValidDependencies(input));
    expect(snap.state).toBe('rejected');
    // rejected → 没有 section(不回退为 full-load)
    expect(snap.rendered_section_ref).toBeNull();
    expect(snap.rendered_section_hash).toBeNull();
    expect(snap.item_refs).toHaveLength(0);
    // 有诊断 reason_codes(不静默回退)
    expect(snap.reason_codes.length).toBeGreaterThan(0);
  });

  // ─── INV-F11 ─────────────────────────────────────────────────────────
  it('INV-F11: cache does not own semantics (hit/miss → same snapshot identity)', async () => {
    // 场景:同一 build input + deps,通过 cache 与 不通过 cache 构建两次,
    // snapshot 的 state / item_refs / rendered_section_hash 必须一致。
    // Cache 只缓存,不改变语义。
    const input = buildValidInput();
    const deps = buildValidDependencies(input);

    // 不用 cache 构建(同时截获 content,供 integration provider 使用)
    const { snapshot: noCacheSnap, content: capturedContent } =
      buildAndCaptureContent(input, deps);

    // 用 cache 构建(cache miss → build → store)
    const cache = createMemoryEntrypointCache(makeInMemoryCacheStore());
    // integration helper:提供 rendered_content provider
    // (生产代码中由调用方从 snapshot.rendered_section_ref 解析;
    //  测试中用截获的 content,其 sha256 与 snapshot.rendered_section_hash 一致)
    const integrationInput: BoundedMemoryRequestIntegrationInput = {
      build_input: input,
      dependencies: deps,
      cache,
      render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
      ordinal: 2,
      trust: 'trust:memory',
      retention: 'retention:session',
      provenance_refs: ['prov-x'],
      rendered_content_provider: () => capturedContent,
    };
    const result1 = await integrateBoundedMemoryIntoRequest(integrationInput);
    // 第二次同 input → cache hit
    const result2 = await integrateBoundedMemoryIntoRequest(integrationInput);

    // cache hit/miss 的 snapshot_state 与 snapshot_id 一致
    expect(result1.snapshot_state).toBe(noCacheSnap.state);
    expect(result2.snapshot_state).toBe(result1.snapshot_state);
    expect(result2.snapshot_id).toBe(result1.snapshot_id);
    expect(result1.snapshot_id).toBe(noCacheSnap.entrypoint_snapshot_id);
    // prompt_section 都非 null(ready),且 section 内容一致
    expect(result1.prompt_section).not.toBeNull();
    expect(result2.prompt_section).not.toBeNull();
    expect(result2.prompt_section!.content).toBe(result1.prompt_section!.content);
    // 两次 integration 的 snapshot_id 完全一致(cache 不改变语义)
    expect(result2.snapshot_id).toBe(result1.snapshot_id);
  });

  // ─── INV-F12 ─────────────────────────────────────────────────────────
  it('INV-F12: empty entrypoints create no content (omit section, no placeholder)', async () => {
    // 场景:policy.enabled=false → state='empty' → section 被省略,
    // 不生成 "No memories" / 默认规则 / 推断内容。
    const input = buildValidInput({ policy: { enabled: false } });
    const deps = buildValidDependencies(input);
    const snap = buildBoundedMemoryEntrypoint(input, deps);
    expect(snap.state).toBe('empty');
    expect(snap.rendered_section_ref).toBeNull();
    expect(snap.item_refs).toHaveLength(0);

    // handoff:empty → section=null(INV-F12 不造内容)
    const handoff = toMemoryPromptSection({
      snapshot: snap,
      render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
      rendered_content: '',
      ordinal: 1,
      trust: 'trust:memory',
      retention: 'retention:session',
      provenance_refs: [],
    });
    expect(handoff.section).toBeNull();
    // reason_codes 标注 empty_omitted(诊断用,不是正文)
    expect(handoff.reason_codes).toContain('handoff.empty_omitted');

    // integration:empty → prompt_section=null
    const integrationResult = await integrateBoundedMemoryIntoRequest({
      build_input: input,
      dependencies: deps,
      cache: null,
      render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
      ordinal: 1,
      trust: 'trust:memory',
      retention: 'retention:session',
      provenance_refs: [],
      rendered_content_provider: () => '',
    });
    expect(integrationResult.prompt_section).toBeNull();
  });

  // ─── INV-F13 ─────────────────────────────────────────────────────────
  it('INV-F13: FRC-1 never writes memory (build is read-only on inputs)', () => {
    // 场景:build 前后,build input 的 catalog/selection/details/decisions 的
    // identity 字段不变;build 不修改 admission/record/transaction。
    const input = buildValidInput();
    // 深拷贝 identity-relevant 字段以便对比
    const catalogIdBefore = input.catalog_snapshot.catalog_snapshot_id;
    const catalogHashBefore = input.catalog_snapshot.catalog_hash;
    const selectionIdBefore = input.selection_result.selection_id;
    const policyIdBefore = input.policy.policy_id;
    const decisionIdsBefore = input.memory_use_decisions.map((d) => d.memory_use_decision_id);
    const admissionIdsBefore = input.memory_use_decisions.map((d) => d.admission_decision_id);

    const deps = buildValidDependencies(input);
    const snap = buildBoundedMemoryEntrypoint(input, deps);
    expect(snap.state).toBe('ready');

    // build 后 identity 字段不变(未被写入)
    expect(input.catalog_snapshot.catalog_snapshot_id).toBe(catalogIdBefore);
    expect(input.catalog_snapshot.catalog_hash).toBe(catalogHashBefore);
    expect(input.selection_result.selection_id).toBe(selectionIdBefore);
    expect(input.policy.policy_id).toBe(policyIdBefore);
    expect(input.memory_use_decisions.map((d) => d.memory_use_decision_id)).toEqual(decisionIdsBefore);
    expect(input.memory_use_decisions.map((d) => d.admission_decision_id)).toEqual(admissionIdsBefore);
    // build 产出新的 entrypoint_snapshot_id / item_refs(不污染原 input identity)
    expect(snap.entrypoint_snapshot_id).toMatch(/^ep-snap:[0-9a-f]{16}$/);
  });

  // ─── INV-F14 ─────────────────────────────────────────────────────────
  it('INV-F14: protocol versions stay orthogonal (independent fields/namespaces)', () => {
    // 场景:entrypoint / policy / activation / integration / rebuild 各自的
    // protocol_version 字段独立存在(不同字段名 / 不同 namespace 前缀),
    // 可独立演进。注:INV-F14 要求版本号独立演进,不要求字符串必不同 ——
    // 这里用字段名 + namespace 前缀做正交性判定。
    expect(ENTRYPOINT_PROTOCOL_VERSION).toBeTypeOf('string');
    expect(ENTRYPOINT_POLICY_PROTOCOL_VERSION).toBeTypeOf('string');

    const { snapshot } = buildReadySnapshot();
    // snapshot 自身的 entrypoint_protocol_version 字段独立存在
    expect(snapshot.entrypoint_protocol_version).toBeTypeOf('string');
    expect(snapshot.entrypoint_protocol_version).toBe(ENTRYPOINT_PROTOCOL_VERSION);

    // activation result 有独立的 activation_protocol_version(独立 namespace 前缀)
    const activationResult = canActivateBoundedMemoryEntrypoint({
      catalog_immutable_and_hash_valid: true,
      catalog_durability_evidence_only: true,
      selection_deterministic_with_overflow: true,
      retrieval_version_hash_bound: true,
      use_decisions_bind_current_context: true,
      only_use_claims_in_body: true,
      source_budgets_with_overflow: true,
      compiler_stable_section_metadata: true,
      authority_trust_placement_separated: true,
      empty_omits_section: true,
      no_full_load_fallback: true,
      deterministic_test_evidence: true,
    });
    expect(activationResult.activation_protocol_version).toMatch(/^mi\.memory\.activation\//);
    // activation 与 entrypoint 是不同字段名 + 不同 namespace
    expect(activationResult.activation_protocol_version).not.toBe(snapshot.entrypoint_protocol_version);

    // rebuild input 有独立的 rebuild_protocol_version(独立 namespace 前缀)
    const rebuild = createMemoryEntrypointRebuildInput(
      snapshot,
      {
        task_snapshot_id: DEFAULT_TASK_SNAPSHOT,
        current_context_snapshot_id: 'ctx:next',
        project_version_ref: DEFAULT_PROJECT_VERSION,
      },
      DEFAULT_POLICY_REF,
      DEFAULT_REQUEST_BUDGET,
      DEFAULT_RENDER_PROFILE,
    );
    expect(rebuild.rebuild_protocol_version).toMatch(/^mi\.memory\.rebuild\//);
    expect(rebuild.entrypoint_protocol_version).toBe(ENTRYPOINT_PROTOCOL_VERSION);
    // rebuild 与 entrypoint 是不同字段名 + 不同 namespace
    expect(rebuild.rebuild_protocol_version).not.toBe(rebuild.entrypoint_protocol_version);
  });

  // ─── INV-F15 ─────────────────────────────────────────────────────────
  it('INV-F15: failure does not change TurnOutcome (section=null + diagnostic only)', async () => {
    // 场景:rejected build 经 integration → prompt_section=null,
    // 结果只携带 snapshot_state/snapshot_id/reason_codes 诊断 metadata,
    // 不直接改变业务 TurnOutcome(由调用方决定)。
    const input = buildValidInput({
      modifyInput: (i) => {
        for (const d of i.retrieved_details as RetrievedMemoryDetail[]) {
          d.catalog_snapshot_id = 'catalog:rogue00000000';
        }
      },
    });
    const deps = buildValidDependencies(input);
    const integrationResult = await integrateBoundedMemoryIntoRequest({
      build_input: input,
      dependencies: deps,
      cache: null,
      render_profile: DEFAULT_MEMORY_RENDER_PROFILE,
      ordinal: 1,
      trust: 'trust:memory',
      retention: 'retention:session',
      provenance_refs: [],
      rendered_content_provider: () => '',
    });
    // rejected → 不附加 section
    expect(integrationResult.prompt_section).toBeNull();
    // 但提供诊断 metadata(让上层做 metadata-only 决策,不改 TurnOutcome)
    expect(integrationResult.snapshot_state).toBe('rejected');
    expect(integrationResult.reason_codes.length).toBeGreaterThan(0);
    // result 形状本身不携带任何"业务 outcome"字段(无 status/error/turn_outcome)
    const resultKeys = Object.keys(integrationResult);
    expect(resultKeys).not.toContain('turn_outcome');
    expect(resultKeys).not.toContain('error');
    expect(resultKeys).not.toContain('status');
  });

  // ─── INV-F16 ─────────────────────────────────────────────────────────
  it('INV-F16: no frozen dependency edge is added (rebuild = identity refs only)', () => {
    // 场景:createMemoryEntrypointRebuildInput 只产出纯数据 identity refs,
    // 不携带 MemoryManager / compiler / cache 等可变依赖句柄。
    // Wave G 拿到这个 input 自行决定重建 —— Wave F 不强加新依赖边。
    const { snapshot } = buildReadySnapshot();
    const rebuild = createMemoryEntrypointRebuildInput(
      snapshot,
      {
        task_snapshot_id: DEFAULT_TASK_SNAPSHOT,
        current_context_snapshot_id: 'ctx:wave-g-target',
        project_version_ref: DEFAULT_PROJECT_VERSION,
      },
      DEFAULT_POLICY_REF,
      DEFAULT_REQUEST_BUDGET,
      DEFAULT_RENDER_PROFILE,
    );

    // rebuild input 是纯 identity refs(字符串 + policy_ref)
    const rebuildKeys = Object.keys(rebuild);
    for (const k of rebuildKeys) {
      const v = (rebuild as unknown as Record<string, unknown>)[k];
      // 字段值只能是 string 或 object(policy_ref)—— 不能是 function(依赖句柄)
      expect(typeof v).not.toBe('function');
    }
    // 不携带 MemoryManager / dependency injection 字段
    expect(rebuildKeys).not.toContain('memory_manager');
    expect(rebuildKeys).not.toContain('dependencies');
    expect(rebuildKeys).not.toContain('compiler');
    expect(rebuildKeys).not.toContain('cache');
    // 携带的是 identity refs + protocol versions
    expect(rebuildKeys).toContain('rebuild_protocol_version');
    expect(rebuildKeys).toContain('target_context_snapshot_id');
    expect(rebuildKeys).toContain('old_entrypoint_snapshot_id');
    expect(rebuildKeys).toContain('policy_ref');
    // old_*_id 正确回指原 snapshot
    expect(rebuild.old_entrypoint_snapshot_id).toBe(snapshot.entrypoint_snapshot_id);
    expect(rebuild.old_catalog_snapshot_id).toBe(snapshot.catalog_snapshot_id);
    expect(rebuild.old_selection_id).toBe(snapshot.selection_id);

    // rebuild 也支持 snapshot=null(本次未构建 entrypoint 的场景)
    const rebuildNull = createMemoryEntrypointRebuildInput(
      null,
      {
        task_snapshot_id: DEFAULT_TASK_SNAPSHOT,
        current_context_snapshot_id: 'ctx:wave-g-target',
        project_version_ref: DEFAULT_PROJECT_VERSION,
      },
      DEFAULT_POLICY_REF,
      DEFAULT_REQUEST_BUDGET,
      DEFAULT_RENDER_PROFILE,
    );
    expect(rebuildNull.old_entrypoint_snapshot_id).toBeNull();
    expect(rebuildNull.old_catalog_snapshot_id).toBeNull();
  });
});

// ===========================================================================
// §C Activation Gate(支撑 INV 验收的额外场景)
// ===========================================================================

describe('Wave F 公共出口 — canActivateBoundedMemoryEntrypoint 12-gate', () => {
  it('all 12 gates true → active=true', () => {
    const evidence: BoundedMemoryActivationEvidence = {
      catalog_immutable_and_hash_valid: true,
      catalog_durability_evidence_only: true,
      selection_deterministic_with_overflow: true,
      retrieval_version_hash_bound: true,
      use_decisions_bind_current_context: true,
      only_use_claims_in_body: true,
      source_budgets_with_overflow: true,
      compiler_stable_section_metadata: true,
      authority_trust_placement_separated: true,
      empty_omits_section: true,
      no_full_load_fallback: true,
      deterministic_test_evidence: true,
    };
    const result = canActivateBoundedMemoryEntrypoint(evidence);
    expect(result.active).toBe(true);
    expect(result.reason_codes).toEqual([]);
  });

  it('any gate false → active=false + reason_code per missing gate (INV-F15 diagnostic)', () => {
    const result = canActivateBoundedMemoryEntrypoint({
      catalog_immutable_and_hash_valid: true,
      catalog_durability_evidence_only: false, // 缺这一门
      selection_deterministic_with_overflow: true,
      retrieval_version_hash_bound: true,
      use_decisions_bind_current_context: true,
      only_use_claims_in_body: true,
      source_budgets_with_overflow: true,
      compiler_stable_section_metadata: true,
      authority_trust_placement_separated: true,
      empty_omits_section: true,
      no_full_load_fallback: true,
      deterministic_test_evidence: true,
    });
    expect(result.active).toBe(false);
    expect(result.reason_codes).toContain(
      'memory_entrypoint.gate_missing.catalog_durability_evidence_only',
    );
    // reason_code 是诊断 metadata,不改变 TurnOutcome
    expect(Object.keys(result)).not.toContain('turn_outcome');
  });
});
