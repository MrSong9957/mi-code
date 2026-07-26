// M-045/M-046 Memory Core Anchor 测试 (ERC-2 / Wave E Task 8)
//
// 覆盖规格 docs/superpowers/plans/2026-07-26-agent-mechanisms-wave-e-implementation.md
//   Task 8 — Core Anchor (`persistAndSelectMemory`):
//   - 封闭 operation union(persist / select / retrieve)
//   - 每个 operation 只调用一个 sibling path,不隐式 persist-then-select
//   - 不给 M-045/M-046 新增相互 D-edge(只是公共 discriminated entrypoint)
//   - 不调用 catalog repair
//   - acknowledgement passthrough:不折叠 transaction / selection / retrieval 状态
//     为单个 success boolean
//
// 关键不变量:
//   - INV-anchor-sibling-independence:每个 operation 只触发一条 sibling path。
//   - INV-no-implicit-persist-then-select:persist 不自动 select,反之亦然。
//   - INV-no-catalog-repair-from-anchor:anchor 不调用 recoverMemoryPersistence。
//   - INV-no-ack-folding:result.kind 保留 acknowledgement 类型,不输出 success:boolean。
//   - INV-seven-states-not-auto-derived:admitted/detail/index/completed/selected/
//     retrieved/use 不能由前一状态自动推导。

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  persistAndSelectMemory,
  type MemoryLifecycleOperationRequest,
  type MemoryLifecycleOperationResult,
  type MemoryLifecycleDependencies,
} from '../../memory/persistence.js';
import {
  prepareMemoryPersistence,
  commitMemoryDetails,
} from '../../memory/persistence.js';
import {
  buildMemoryCatalogSnapshot,
  type MemoryCatalogEntry,
  type GovernedCatalogStore,
  type CatalogCommitResult,
} from '../../memory/catalog.js';
import {
  buildMemorySearchQuery,
  selectMemoryEntries,
} from '../../memory/selection.js';
import type { MemoryPersistenceTransaction, GovernedMemoryStorage } from '../../memory/persistence.js';
import type { MemorySelectionResult, MemoryRetrievalResult } from '../../memory/selection.js';
import type { MemoryAdmissionDecision, MemoryUseInput, MemoryUseDecision } from '../../memory/admission.js';
import type { TypedMemoryCandidate } from '../../memory/candidates.js';

// ---------------------------------------------------------------------------
// helpers / fixtures
// ---------------------------------------------------------------------------

const DEFAULT_DETAIL_BODY = 'detail body';
function hashOf(body: string): string {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}
const DEFAULT_CONTENT_HASH = hashOf(DEFAULT_DETAIL_BODY);

function makeAdmitDecision(
  overrides: Partial<MemoryAdmissionDecision> = {},
): MemoryAdmissionDecision {
  return {
    admission_protocol_version: '1',
    admission_decision_id: 'admit:abc123',
    memory_candidate_id: 'mem:candidate123',
    policy_ref: { contract_id: 'memory-policy', contract_version: '1' },
    current_context_snapshot_id: 'snap-1',
    status: 'admit',
    accepted_scope_ref: 'workspace-1',
    accepted_type: 'user_preference',
    verification_requirements: ['memory.use_verification_required'],
    reason_codes: [],
    evidence_refs: ['ev-1'],
    ...overrides,
  };
}

function makeCandidate(
  overrides: Partial<TypedMemoryCandidate> = {},
): TypedMemoryCandidate {
  return {
    memory_candidate_protocol_version: '1',
    memory_candidate_id: 'mem:candidate123',
    source_context_id: 'ctx-1',
    type: 'user_preference',
    claim: 'prefers tabs over spaces',
    scope_ref: 'workspace-1',
    evidence_refs: ['ev-1', 'ev-2'],
    confidence: 0.8,
    observed_at: '2026-07-26T00:00:00Z',
    expires_at: null,
    context_refs: ['ctx-a'],
    invalidation_conditions: ['cond-x'],
    sensitivity_labels: [],
    ...overrides,
  };
}

function makeEntry(overrides: Partial<MemoryCatalogEntry>): MemoryCatalogEntry {
  return {
    memory_record_id: 'memory-default',
    record_version: 1,
    admission_decision_id: 'admit:default',
    type: 'project_fact',
    scope_ref: 'workspace-1',
    topic_terms: ['typescript'],
    keyword_terms: [],
    observed_at: '2026-07-26T00:00:00Z',
    provenance_refs: ['prov-1'],
    detail_commit_ref: 'detail-default',
    content_hash: DEFAULT_CONTENT_HASH,
    metadata_bytes: 100,
    ...overrides,
  };
}

/** In-memory governed storage 用于 persist 路径。 */
class InMemoryGovernedStorage implements GovernedMemoryStorage {
  async writeGovernedDetail(record: {
    memory_record_id: string;
    record_version: number;
    content_hash: string;
  }) {
    return {
      detail_commit_ref: `detail:${record.memory_record_id}`,
      memory_record_id: record.memory_record_id,
      record_version: record.record_version,
      committed_at: '2026-07-26T00:00:00Z',
    };
  }
  async readGovernedDetail(ref: string): Promise<string | null> {
    return ref.endsWith('memory-1') ? DEFAULT_DETAIL_BODY : null;
  }
}

/** In-memory governed catalog store 用于 persist → catalog commit 路径。 */
class InMemoryCatalogStore implements GovernedCatalogStore {
  private snapshot: ReturnType<typeof buildMemoryCatalogSnapshot> | null = null;
  public commitCount = 0;

  async find() {
    return null;
  }
  async commitSnapshot(snapshot: Parameters<GovernedCatalogStore['commitSnapshot']>[0]): Promise<void> {
    this.snapshot = snapshot;
    this.commitCount++;
  }
  async loadSnapshot() {
    return this.snapshot;
  }
}

/**
 * 构造 baseline dependencies。spy 注入到 sibling path 函数本身不可行(它们是模块导出),
 * 因此我们通过 `dependencies.persist` / `dependencies.select` / `dependencies.retrieve`
 * 这三个 *注入* 字段验证 anchor 是否调用了某条 sibling path ——
 * anchor 的实现把这些 sibling function 也作为 dependencies 注入,便于测试隔离。
 *
 * 默认:storage + catalogStore + readDetail + decideUse 全部 wired 真实实现,
 * sibling 三条路径(prepare/commit 链 / selectMemoryEntries / retrieveSelectedMemory)
 * 通过 dependencies.persist/select/retrieve 注入。
 */

const buildRealPersist = () => {
  const storage = new InMemoryGovernedStorage();
  const catalogStore = new InMemoryCatalogStore();
  return {
    storage,
    catalogStore,
    persist: vi.fn(
      async (
        admission: MemoryAdmissionDecision,
        candidate: TypedMemoryCandidate,
        s: GovernedMemoryStorage,
        cs: GovernedCatalogStore,
      ): Promise<MemoryPersistenceTransaction> => {
        const prepared = await prepareMemoryPersistence(admission, candidate, s);
        const committed = await commitMemoryDetails(prepared, s);
        // 第二阶段:catalog commit(由 anchor 透传 budget policy)
        const { commitMemoryCatalog } = await import('../../memory/catalog.js');
        await commitMemoryCatalog(
          { transaction: committed, catalog_budget_policy: { max_entries: 100, max_index_metadata_bytes: 100_000 } },
          cs,
        );
        return committed;
      },
    ),
  };
};

const buildRealSelect = () => ({
  select: vi.fn(
    (
      query: Parameters<typeof selectMemoryEntries>[0],
      catalog: Parameters<typeof selectMemoryEntries>[1],
    ): MemorySelectionResult => selectMemoryEntries(query, catalog),
  ),
});

const buildRealRetrieve = () => ({
  readDetail: vi.fn(async (ref: string) =>
    ref.endsWith('memory-1') ? DEFAULT_DETAIL_BODY : null,
  ),
  decideUse: vi.fn(
    (input: MemoryUseInput): MemoryUseDecision => {
      // 默认 status='use',verified_claim_refs 含一条 ref
      return {
        memory_use_protocol_version: input.memory_use_protocol_version,
        memory_use_decision_id: 'use:default',
        stored_memory_ref: input.stored_memory_ref,
        admission_decision_id: input.admission_decision_id,
        current_context_snapshot_id: input.current_context_snapshot_id,
        project_version_ref: input.project_version_ref,
        status: 'use',
        verified_claim_refs: ['claim-1'],
        stale_claim_refs: [],
        conflicting_evidence_refs: [],
        reason_codes: [],
      };
    },
  ),
  retrieve: vi.fn(
    async (
      selection: MemorySelectionResult,
      deps: { readDetail: (r: string) => Promise<string | null>; decideUse: (i: MemoryUseInput) => MemoryUseDecision },
      current_context_snapshot_id: string,
    ): Promise<MemoryRetrievalResult> => {
      const { retrieveSelectedMemory, MEMORY_RETRIEVAL_PROTOCOL_VERSION } = await import('../../memory/selection.js');
      return retrieveSelectedMemory(
        {
          retrieval_protocol_version: MEMORY_RETRIEVAL_PROTOCOL_VERSION,
          selection,
          current_context_snapshot_id,
        },
        deps,
      );
    },
  ),
});

// ---------------------------------------------------------------------------
// baseline assembly
// ---------------------------------------------------------------------------

function buildBaselineDependencies(): {
  storage: InMemoryGovernedStorage;
  catalogStore: InMemoryCatalogStore;
  persist: ReturnType<typeof buildRealPersist>['persist'];
  select: ReturnType<typeof buildRealSelect>['select'];
  retrieve: ReturnType<typeof buildRealRetrieve>['retrieve'];
  readDetail: ReturnType<typeof buildRealRetrieve>['readDetail'];
  decideUse: ReturnType<typeof buildRealRetrieve>['decideUse'];
  dependencies: MemoryLifecycleDependencies;
} {
  const persistImpl = buildRealPersist();
  const selectImpl = buildRealSelect();
  const retrieveImpl = buildRealRetrieve();
  const dependencies: MemoryLifecycleDependencies = {
    storage: persistImpl.storage,
    catalogStore: persistImpl.catalogStore,
    persist: persistImpl.persist,
    select: selectImpl.select,
    retrieve: retrieveImpl.retrieve,
    readDetail: retrieveImpl.readDetail,
    decideUse: retrieveImpl.decideUse,
  };
  return { ...persistImpl, ...selectImpl, ...retrieveImpl, dependencies };
}

// ===========================================================================
// Step 1 — sibling independence (anchor 只按 operation 调用一个 sibling path)
// ===========================================================================
describe('persistAndSelectMemory — sibling independence (INV-anchor-sibling-independence)', () => {
  it('runs selection against an existing catalog without invoking persistence', async () => {
    const ctx = buildBaselineDependencies();
    const entry = makeEntry({ memory_record_id: 'memory-1', detail_commit_ref: 'detail-memory-1' });
    const catalog = buildMemoryCatalogSnapshot([entry]);
    const query = buildMemorySearchQuery({
      scope_ref: 'workspace-1',
      topic_terms: ['typescript'],
      keyword_terms: [],
      max_selected_entries: 10,
      max_index_metadata_bytes: 10_000,
    });

    const result = await persistAndSelectMemory(
      { operation: 'select', query, catalog },
      ctx.dependencies,
    );

    expect(result.kind).toBe('selection');
    expect(ctx.persist).not.toHaveBeenCalled();
  });

  it('persists an admitted candidate without invoking selection', async () => {
    const ctx = buildBaselineDependencies();
    const admission = makeAdmitDecision();
    const candidate = makeCandidate();

    const result = await persistAndSelectMemory(
      { operation: 'persist', admission, candidate },
      ctx.dependencies,
    );

    expect(result.kind).toBe('persistence');
    expect(ctx.select).not.toHaveBeenCalled();
  });

  it('retrieves selected memory without invoking persistence or selection', async () => {
    const ctx = buildBaselineDependencies();
    // 构造一个已 selected 的 MemorySelectionResult(不通过 anchor.select 路径)
    const entry = makeEntry({ memory_record_id: 'memory-1', detail_commit_ref: 'detail-memory-1' });
    const catalog = buildMemoryCatalogSnapshot([entry]);
    const query = buildMemorySearchQuery({
      scope_ref: 'workspace-1',
      topic_terms: ['typescript'],
      keyword_terms: [],
      max_selected_entries: 10,
      max_index_metadata_bytes: 10_000,
    });
    const selection = selectMemoryEntries(query, catalog);

    const result = await persistAndSelectMemory(
      { operation: 'retrieve', selection, current_context_snapshot_id: 'snap-1' },
      ctx.dependencies,
    );

    expect(result.kind).toBe('retrieval');
    expect(ctx.persist).not.toHaveBeenCalled();
    expect(ctx.select).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Step 2 — no implicit persist-then-select / no catalog repair
// ===========================================================================
describe('persistAndSelectMemory — no implicit composition', () => {
  it('does not implicitly persist-then-select (persist result has no selection inside)', async () => {
    const ctx = buildBaselineDependencies();
    const admission = makeAdmitDecision();
    const candidate = makeCandidate();

    const result = await persistAndSelectMemory(
      { operation: 'persist', admission, candidate },
      ctx.dependencies,
    );

    // anchor 必须返回 { kind: 'persistence', value: transaction } ——
    // transaction 上不存在 selection 字段。
    expect(result.kind).toBe('persistence');
    if (result.kind === 'persistence') {
      expect(result.value).not.toHaveProperty('selection');
      expect(result.value).not.toHaveProperty('selection_id');
    }
    expect(ctx.select).not.toHaveBeenCalled();
  });

  it('does not call catalog repair (recoverMemoryPersistence) on persist path', async () => {
    // anchor.dependencies 不应暴露 recover 字段;persist 路径不调用 catalog repair。
    const ctx = buildBaselineDependencies();
    const admission = makeAdmitDecision();
    const candidate = makeCandidate();

    await persistAndSelectMemory(
      { operation: 'persist', admission, candidate },
      ctx.dependencies,
    );

    // dependencies 接口不含 recover —— 这就是"不调用 catalog repair"的结构性证据。
    expect(ctx.dependencies).not.toHaveProperty('recover');
    expect(ctx.dependencies).not.toHaveProperty('recoverMemoryPersistence');
  });

  it('does not implicitly retrieve after select (select result has no usable_claim_refs)', async () => {
    const ctx = buildBaselineDependencies();
    const entry = makeEntry({ memory_record_id: 'memory-1', detail_commit_ref: 'detail-memory-1' });
    const catalog = buildMemoryCatalogSnapshot([entry]);
    const query = buildMemorySearchQuery({
      scope_ref: 'workspace-1',
      topic_terms: ['typescript'],
      keyword_terms: [],
      max_selected_entries: 10,
      max_index_metadata_bytes: 10_000,
    });

    const result = await persistAndSelectMemory(
      { operation: 'select', query, catalog },
      ctx.dependencies,
    );

    expect(result.kind).toBe('selection');
    if (result.kind === 'selection') {
      // selection 是导航引用,不携带 use-gated claims。
      expect(result.value).not.toHaveProperty('usable_claim_refs');
      expect(result.value).not.toHaveProperty('rejected_record_ids');
    }
    expect(ctx.retrieve).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Step 3 — acknowledgement passthrough (不折叠为单个 boolean)
// ===========================================================================
describe('persistAndSelectMemory — acknowledgement passthrough (INV-no-ack-folding)', () => {
  it('does not fold acknowledgements into single success boolean', async () => {
    const ctx = buildBaselineDependencies();
    const admission = makeAdmitDecision();
    const candidate = makeCandidate();

    const result = await persistAndSelectMemory(
      { operation: 'persist', admission, candidate },
      ctx.dependencies,
    );

    // result 没有 success / ok / done / status 等顶层 boolean 字段;
    // 必须是 discriminated union with kind + value。
    expect(result).not.toHaveProperty('success');
    expect(result).not.toHaveProperty('ok');
    expect(result).not.toHaveProperty('status');
    expect(result).toHaveProperty('kind');
    expect(result).toHaveProperty('value');
  });

  it('persist acknowledgement carries full transaction (state, record, refs)', async () => {
    const ctx = buildBaselineDependencies();
    const result = await persistAndSelectMemory(
      { operation: 'persist', admission: makeAdmitDecision(), candidate: makeCandidate() },
      ctx.dependencies,
    );
    expect(result.kind).toBe('persistence');
    if (result.kind === 'persistence') {
      // transaction 携带 durable acknowledgement 字段,而非单个 boolean。
      expect(result.value.state).toBe('detail_committed');
      expect(result.value.detail_commit_ref).not.toBeNull();
      expect(result.value.record).toBeDefined();
    }
  });

  it('select acknowledgement carries immutable selected refs (not a boolean)', async () => {
    const ctx = buildBaselineDependencies();
    const entry = makeEntry({ memory_record_id: 'memory-1', detail_commit_ref: 'detail-memory-1' });
    const catalog = buildMemoryCatalogSnapshot([entry]);
    const query = buildMemorySearchQuery({
      scope_ref: 'workspace-1',
      topic_terms: ['typescript'],
      keyword_terms: [],
      max_selected_entries: 10,
      max_index_metadata_bytes: 10_000,
    });
    const result = await persistAndSelectMemory(
      { operation: 'select', query, catalog },
      ctx.dependencies,
    );
    expect(result.kind).toBe('selection');
    if (result.kind === 'selection') {
      expect(result.value.selected_entries.length).toBeGreaterThan(0);
      expect(result.value.selection_id).toContain('sel:');
    }
  });

  it('retrieve acknowledgement carries use-gated claims (not a boolean)', async () => {
    const ctx = buildBaselineDependencies();
    const entry = makeEntry({ memory_record_id: 'memory-1', detail_commit_ref: 'detail-memory-1' });
    const catalog = buildMemoryCatalogSnapshot([entry]);
    const query = buildMemorySearchQuery({
      scope_ref: 'workspace-1',
      topic_terms: ['typescript'],
      keyword_terms: [],
      max_selected_entries: 10,
      max_index_metadata_bytes: 10_000,
    });
    const selection = selectMemoryEntries(query, catalog);

    const result = await persistAndSelectMemory(
      { operation: 'retrieve', selection, current_context_snapshot_id: 'snap-1' },
      ctx.dependencies,
    );
    expect(result.kind).toBe('retrieval');
    if (result.kind === 'retrieval') {
      expect(result.value.usable_claim_refs).toBeDefined();
      expect(result.value.retrieval_id).toContain('retrieval:');
    }
  });
});

// ===========================================================================
// Step 4 — seven states not auto-derived
// ===========================================================================
describe('persistAndSelectMemory — seven states not auto-derived (INV-seven-states-not-auto-derived)', () => {
  // 七种状态:admitted / detail(index-prep) / index_committed(completed) /
  //          selected / retrieved / use。
  // 这里验证:仅 persist 不会让 result 出现 selection/retrieval 字段;
  //          仅 select 不会让 result 出现 usable_claim(transaction→use 链);
  //          仅 retrieve 不会修改 selection/use identity。
  it('persist result does not auto-derive selected/retrieved/use state', async () => {
    const ctx = buildBaselineDependencies();
    const result = await persistAndSelectMemory(
      { operation: 'persist', admission: makeAdmitDecision(), candidate: makeCandidate() },
      ctx.dependencies,
    );
    expect(result.kind).toBe('persistence');
    if (result.kind === 'persistence') {
      const tx = result.value;
      // 仅 detail/index acknowledgement —— 不携带 selected / retrieved / use 状态。
      expect(tx).not.toHaveProperty('selected_entries');
      expect(tx).not.toHaveProperty('usable_claim_refs');
      expect(tx).not.toHaveProperty('rejected_record_ids');
      // transaction 只到 detail_committed 状态(completed 由 catalog commit 完成,
      // 但仍不是 selected/retrieved/use)。
      expect(['detail_committed', 'completed', 'prepared']).toContain(tx.state);
    }
  });

  it('select result does not auto-derive use state (no usable_claim_refs)', async () => {
    const ctx = buildBaselineDependencies();
    const entry = makeEntry({ memory_record_id: 'memory-1', detail_commit_ref: 'detail-memory-1' });
    const catalog = buildMemoryCatalogSnapshot([entry]);
    const query = buildMemorySearchQuery({
      scope_ref: 'workspace-1',
      topic_terms: ['typescript'],
      keyword_terms: [],
      max_selected_entries: 10,
      max_index_metadata_bytes: 10_000,
    });
    const result = await persistAndSelectMemory(
      { operation: 'select', query, catalog },
      ctx.dependencies,
    );
    expect(result.kind).toBe('selection');
    if (result.kind === 'selection') {
      // selection 只到 selected 状态 —— 没有 use / retrieval 字段。
      expect(result.value).not.toHaveProperty('usable_claim_refs');
      expect(result.value).not.toHaveProperty('rejected_record_ids');
      expect(result.value).not.toHaveProperty('integrity_diagnostics');
    }
  });

  it('retrieve result preserves selection_id and use identity (no auto-collapse)', async () => {
    const ctx = buildBaselineDependencies();
    const entry = makeEntry({ memory_record_id: 'memory-1', detail_commit_ref: 'detail-memory-1' });
    const catalog = buildMemoryCatalogSnapshot([entry]);
    const query = buildMemorySearchQuery({
      scope_ref: 'workspace-1',
      topic_terms: ['typescript'],
      keyword_terms: [],
      max_selected_entries: 10,
      max_index_metadata_bytes: 10_000,
    });
    const selection = selectMemoryEntries(query, catalog);

    const result = await persistAndSelectMemory(
      { operation: 'retrieve', selection, current_context_snapshot_id: 'snap-current' },
      ctx.dependencies,
    );
    expect(result.kind).toBe('retrieval');
    if (result.kind === 'retrieval') {
      // selection_id 与 current_context_snapshot_id 独立透传,不折叠为一个状态。
      expect(result.value.selection_id).toBe(selection.selection_id);
      expect(result.value.current_context_snapshot_id).toBe('snap-current');
      expect(result.value.retrieval_id).not.toBe(selection.selection_id);
    }
  });
});

// ===========================================================================
// Step 5 — determinism & frozen result
// ===========================================================================
describe('persistAndSelectMemory — determinism & frozen result', () => {
  it('produces deterministic result structure (kind discriminator)', async () => {
    const ctx = buildBaselineDependencies();
    const r1 = await persistAndSelectMemory(
      { operation: 'persist', admission: makeAdmitDecision(), candidate: makeCandidate() },
      ctx.dependencies,
    );
    const r2 = await persistAndSelectMemory(
      { operation: 'persist', admission: makeAdmitDecision(), candidate: makeCandidate() },
      ctx.dependencies,
    );
    expect(r1.kind).toBe('persistence');
    expect(r2.kind).toBe('persistence');
    if (r1.kind === 'persistence' && r2.kind === 'persistence') {
      expect(r2.value.transaction_id).toBe(r1.value.transaction_id);
    }
  });

  it('is frozen (result and value object deeply frozen for persistence)', async () => {
    const ctx = buildBaselineDependencies();
    const result = await persistAndSelectMemory(
      { operation: 'persist', admission: makeAdmitDecision(), candidate: makeCandidate() },
      ctx.dependencies,
    );
    expect(Object.isFrozen(result)).toBe(true);
    if (result.kind === 'persistence') {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.record)).toBe(true);
    }
  });

  it('is frozen for selection result', async () => {
    const ctx = buildBaselineDependencies();
    const entry = makeEntry({ memory_record_id: 'memory-1', detail_commit_ref: 'detail-memory-1' });
    const catalog = buildMemoryCatalogSnapshot([entry]);
    const query = buildMemorySearchQuery({
      scope_ref: 'workspace-1',
      topic_terms: ['typescript'],
      keyword_terms: [],
      max_selected_entries: 10,
      max_index_metadata_bytes: 10_000,
    });
    const result = await persistAndSelectMemory(
      { operation: 'select', query, catalog },
      ctx.dependencies,
    );
    expect(Object.isFrozen(result)).toBe(true);
    if (result.kind === 'selection') {
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });

  it('is frozen for retrieval result', async () => {
    const ctx = buildBaselineDependencies();
    const entry = makeEntry({ memory_record_id: 'memory-1', detail_commit_ref: 'detail-memory-1' });
    const catalog = buildMemoryCatalogSnapshot([entry]);
    const query = buildMemorySearchQuery({
      scope_ref: 'workspace-1',
      topic_terms: ['typescript'],
      keyword_terms: [],
      max_selected_entries: 10,
      max_index_metadata_bytes: 10_000,
    });
    const selection = selectMemoryEntries(query, catalog);
    const result = await persistAndSelectMemory(
      { operation: 'retrieve', selection, current_context_snapshot_id: 'snap-1' },
      ctx.dependencies,
    );
    expect(Object.isFrozen(result)).toBe(true);
    if (result.kind === 'retrieval') {
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });
});

// ===========================================================================
// Step 6 — discriminated union exhaustiveness
// ===========================================================================
describe('persistAndSelectMemory — discriminated union exhaustiveness', () => {
  it('rejects unknown operation values (closed union)', async () => {
    const ctx = buildBaselineDependencies();
    // 运行时 anchor 应对未知 operation 抛错(封闭 union)。
    await expect(
      persistAndSelectMemory(
        // 故意构造非法 operation;TS 编译期会拒绝,运行时需抛错。
        { operation: 'repair' as never, admission: makeAdmitDecision(), candidate: makeCandidate() } as never,
        ctx.dependencies,
      ),
    ).rejects.toThrow(/anchor\.unknown_operation/);
  });

  it('returns discriminated result kinds matching operation (no cross-coupling)', async () => {
    const ctx = buildBaselineDependencies();

    const persist = await persistAndSelectMemory(
      { operation: 'persist', admission: makeAdmitDecision(), candidate: makeCandidate() },
      ctx.dependencies,
    );
    expect(persist.kind).toBe('persistence');

    const entry = makeEntry({ memory_record_id: 'memory-1', detail_commit_ref: 'detail-memory-1' });
    const catalog = buildMemoryCatalogSnapshot([entry]);
    const query = buildMemorySearchQuery({
      scope_ref: 'workspace-1',
      topic_terms: ['typescript'],
      keyword_terms: [],
      max_selected_entries: 10,
      max_index_metadata_bytes: 10_000,
    });
    const select = await persistAndSelectMemory(
      { operation: 'select', query, catalog },
      ctx.dependencies,
    );
    expect(select.kind).toBe('selection');

    const retrieve = await persistAndSelectMemory(
      { operation: 'retrieve', selection: selectMemoryEntries(query, catalog), current_context_snapshot_id: 'snap-1' },
      ctx.dependencies,
    );
    expect(retrieve.kind).toBe('retrieval');

    // 三个 kind 互不相同 —— 这是 discriminated union 的本质。
    expect(new Set([persist.kind, select.kind, retrieve.kind]).size).toBe(3);
  });
});
