// FRC-1 Bounded Memory Entrypoint — Task 1: captureMemoryEntrypointBuild 测试
//
// 覆盖规格 docs/superpowers/specs/2026-07-26-agent-bounded-memory-entrypoint-wave-f-design.md
//   §7.1 目标 / §7.2 Entrypoint policy / §7.3 Build input / §7.4 Retrieved detail /
//   §6.3 Identity binding / §7.18 Error semantics / §7.19 Activation gate
//
// 不变量:
//   - INV-F1   Snapshot 不混合(一次性捕获)
//   - INV-F5   EntryPoint 有硬上限(policy 必须有有限预算)
//   - INV-F12  空入口不造内容
//   - INV-F14   Version 正交(各 protocol_version 独立校验存在性,不交叉约束)
//
// 本测试覆盖 captureMemoryEntrypointBuild 的输入捕获、policy 校验、catalog/selection/
// retrieved_details / use_decisions 的一致性校验,以及冻结 / 时间戳行为。

import { describe, it, expect } from 'vitest';
import {
  captureMemoryEntrypointBuild,
  ENTRYPOINT_PROTOCOL_VERSION,
  ENTRYPOINT_POLICY_PROTOCOL_VERSION,
  type MemoryEntrypointBuildInput,
  type MemoryEntrypointPolicy,
  type RetrievedMemoryDetail,
  type WaveFContractRef,
  type PreparedMemoryEntrypointBuild,
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

/**
 * 构造一个完整、合法的 MemoryEntrypointBuildInput。
 * 默认场景:catalog 有 2 个 entry,都被 select,都有 retrieved detail + use decision(status=use)。
 * 通过 overrides 可以替换任一字段。
 */
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

  const catalog: MemoryCatalogSnapshot = buildMemoryCatalogSnapshot(entries);

  const query = buildMemorySearchQuery({
    scope_ref: 'workspace-1',
    topic_terms: [],
    keyword_terms: [],
    max_selected_entries: 10,
    max_index_metadata_bytes: 10_000,
  });
  const selection: MemorySelectionResult = selectMemoryEntries(query, catalog);

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
      retrieved_claim_refs: [`claim:${entry.memory_record_id}`],
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

// ===========================================================================
// §1 baseline — 合法 input → state='prepared'
// ===========================================================================

describe('captureMemoryEntrypointBuild — baseline valid input', () => {
  it('produces state=prepared with all identity fields captured verbatim', () => {
    const input = buildValidInput();
    const prepared = captureMemoryEntrypointBuild(input);

    expect(prepared.state).toBe('prepared');
    expect(prepared.build_id).toBe('build:001');
    expect(prepared.task_snapshot_id).toBe(DEFAULT_TASK_SNAPSHOT);
    expect(prepared.current_context_snapshot_id).toBe(DEFAULT_CURRENT_CONTEXT);
    expect(prepared.project_version_ref).toBe(DEFAULT_PROJECT_VERSION);
    expect(prepared.request_budget_snapshot_id).toBe(DEFAULT_REQUEST_BUDGET);
    expect(prepared.render_profile_ref).toBe(DEFAULT_RENDER_PROFILE);
    expect(prepared.policy_ref).toEqual(DEFAULT_POLICY_REF);
    expect(prepared.reason_codes).toEqual([]);
  });

  it('captures catalog snapshot, selection_result, retrieved_details, use decisions', () => {
    const input = buildValidInput();
    const prepared = captureMemoryEntrypointBuild(input);

    expect(prepared.catalog_snapshot).toBe(input.catalog_snapshot);
    expect(prepared.selection_result).toBe(input.selection_result);
    expect(prepared.retrieved_details).toHaveLength(2);
    expect(prepared.memory_use_decisions).toHaveLength(2);
    expect(prepared.policy).toBe(input.policy);
  });

  it('freezes the captured snapshot deeply', () => {
    const input = buildValidInput();
    const prepared = captureMemoryEntrypointBuild(input);

    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.catalog_snapshot)).toBe(true);
    expect(Object.isFrozen(prepared.selection_result)).toBe(true);
    expect(Object.isFrozen(prepared.policy)).toBe(true);
    expect(Object.isFrozen(prepared.policy_ref)).toBe(true);
    expect(Object.isFrozen(prepared.retrieved_details)).toBe(true);
    expect(Object.isFrozen(prepared.memory_use_decisions)).toBe(true);
  });

  it('sets captured_at to an ISO timestamp near "now"', () => {
    const before = Date.now();
    const input = buildValidInput();
    const prepared = captureMemoryEntrypointBuild(input);
    const after = Date.now();

    expect(typeof prepared.captured_at).toBe('string');
    const ts = Date.parse(prepared.captured_at);
    expect(Number.isFinite(ts)).toBe(true);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('keeps version fields independent (version orthogonality, INV-F14)', () => {
    // 不同 protocol_version 字段独立校验存在性,不要求它们彼此相等。
    const input = buildValidInput({
      modifyInput: (i) => {
        // catalog protocol 与 selection protocol 都是 '1'(实际值),但与 build 协议也独立。
        // 我们只验证只要存在性 OK 就不会因交叉约束而 rejected。
        i.entrypoint_build_protocol_version = ENTRYPOINT_PROTOCOL_VERSION;
      },
    });
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('prepared');
  });
});

// ===========================================================================
// §2 policy.enabled=false → state='empty'
// ===========================================================================

describe('captureMemoryEntrypointBuild — policy disabled', () => {
  it('produces state=empty and skips detail validation', () => {
    const input = buildValidInput({
      policy: { enabled: false },
      modifyInput: (i) => {
        // 故意把 retrieved_details 的 catalog_snapshot_id 改成不一致 ——
        // enabled=false 时不应触发该一致性校验。
        (i.retrieved_details as RetrievedMemoryDetail[]).push({
          retrieval_protocol_version: '1',
          retrieval_id: 'retrieval:rogue',
          memory_record_id: 'memrec-a',
          record_version: 1,
          catalog_snapshot_id: 'catalog:rogue',
          selection_id: i.selection_result.selection_id,
          detail_content_ref: 'detail-a',
          detail_content_hash: 'sha256:aaaaaa',
          retrieved_claim_refs: [],
          provenance_refs: [],
          freshness_ref: 'fresh:a',
        });
      },
    });
    const prepared = captureMemoryEntrypointBuild(input);

    expect(prepared.state).toBe('empty');
    // reason_codes 含 policy.disabled 标记
    expect(prepared.reason_codes).toContain('policy.disabled');
    // 仍然冻结了所有字段
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.retrieved_details)).toBe(true);
  });
});

// ===========================================================================
// §3 policy 校验 — budget / empty_behavior / identity
// ===========================================================================

describe('captureMemoryEntrypointBuild — policy validation', () => {
  it('rejects negative max_navigation_entries', () => {
    const input = buildValidInput({
      policy: { max_navigation_entries: -1 },
    });
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes).toContain('policy.invalid_budget');
  });

  it('rejects NaN budget field', () => {
    const input = buildValidInput({
      policy: { max_verified_detail_items: Number.NaN },
    });
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes).toContain('policy.invalid_budget');
  });

  it('rejects Infinity budget field (must be finite)', () => {
    const input = buildValidInput({
      policy: { max_verified_claims_per_item: Number.POSITIVE_INFINITY },
    });
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes).toContain('policy.invalid_budget');
  });

  it('rejects wrong empty_behavior', () => {
    const input = buildValidInput({
      // 故意绕过 TS 类型用 as 触发非 'omit_section' 路径
      policy: { empty_behavior: 'inject_placeholder' as 'omit_section' },
    });
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes).toContain('policy.invalid_empty_behavior');
  });

  it('rejects missing budget policy_ref (empty string)', () => {
    const input = buildValidInput({
      policy: { navigation_budget_policy_ref: '' },
    });
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes).toContain('policy.missing_identity');
  });

  it('rejects missing policy_id', () => {
    const input = buildValidInput({
      policy: { policy_id: '' },
    });
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes).toContain('policy.missing_identity');
  });

  it('rejects missing policy_ref (empty contract_id)', () => {
    const input = buildValidInput();
    input.policy_ref = { contract_id: '', contract_version: '1' };
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes).toContain('policy.missing_identity');
  });
});

// ===========================================================================
// §4 catalog snapshot identity
// ===========================================================================

describe('captureMemoryEntrypointBuild — catalog snapshot identity', () => {
  it('rejects catalog_snapshot_id without "catalog:" prefix', () => {
    const input = buildValidInput();
    // 直接 mutate catalog_snapshot 的 id —— 它是 frozen,所以解构重建。
    const mutatedCatalog: MemoryCatalogSnapshot = {
      ...input.catalog_snapshot,
      catalog_snapshot_id: 'wrongprefix:abcdef0123456789',
    };
    input.catalog_snapshot = mutatedCatalog;
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes).toContain('catalog_snapshot_mismatch');
  });

  it('rejects catalog_hash that is not 64 hex chars', () => {
    const input = buildValidInput();
    input.catalog_snapshot = {
      ...input.catalog_snapshot,
      catalog_hash: 'short',
    };
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes).toContain('catalog_snapshot_mismatch');
  });

  it('rejects catalog_snapshot_id with non-hex suffix', () => {
    const input = buildValidInput();
    input.catalog_snapshot = {
      ...input.catalog_snapshot,
      catalog_snapshot_id: 'catalog:zzzzzzzzzzzzzzzz',
    };
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes).toContain('catalog_snapshot_mismatch');
  });
});

// ===========================================================================
// §5 selection ↔ catalog 一致性
// ===========================================================================

describe('captureMemoryEntrypointBuild — selection/catalog cross-check', () => {
  it('rejects when selection references a record not present in catalog', () => {
    const input = buildValidInput();
    // 把 selection_result 替换为引用不存在 record 的版本。
    // 重建一个 selection,然后篡改其中一条 selected_entry 的 memory_record_id。
    const tamperedSelection: MemorySelectionResult = {
      ...input.selection_result,
      selected_entries: input.selection_result.selected_entries.map((e, i) =>
        i === 0 ? { ...e, memory_record_id: 'memrec-not-in-catalog' } : e,
      ),
    };
    input.selection_result = tamperedSelection;
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes).toContain('selection_catalog_record_missing');
  });
});

// ===========================================================================
// §6 retrieved_details 一致性
// ===========================================================================

describe('captureMemoryEntrypointBuild — retrieved_details binding', () => {
  it('rejects retrieved_detail with catalog_snapshot_id mismatch', () => {
    const input = buildValidInput();
    input.retrieved_details = input.retrieved_details.map((d, i) =>
      i === 0
        ? { ...d, catalog_snapshot_id: 'catalog:another' }
        : d,
    );
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes).toContain('catalog_snapshot_mismatch');
  });

  it('rejects retrieved_detail with selection_id mismatch', () => {
    const input = buildValidInput();
    input.retrieved_details = input.retrieved_details.map((d, i) =>
      i === 0 ? { ...d, selection_id: 'sel:different' } : d,
    );
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes).toContain('selection_catalog_mismatch');
  });
});

// ===========================================================================
// §7 memory_use_decisions 一致性
// ===========================================================================

describe('captureMemoryEntrypointBuild — use_decisions binding', () => {
  it('rejects use decision with current_context_snapshot_id mismatch', () => {
    const input = buildValidInput();
    input.memory_use_decisions = input.memory_use_decisions.map((d, i) =>
      i === 0 ? { ...d, current_context_snapshot_id: 'ctx:other' } : d,
    );
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes).toContain('use_decision_context_mismatch');
  });

  it('rejects use decision whose stored_memory_ref is not in catalog', () => {
    const input = buildValidInput();
    input.memory_use_decisions = input.memory_use_decisions.map((d, i) =>
      i === 0 ? { ...d, stored_memory_ref: 'memrec-not-in-catalog' } : d,
    );
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes).toContain('use_decision_record_missing');
  });
});

// ===========================================================================
// §8 入口基本 identity 守门
// ===========================================================================

describe('captureMemoryEntrypointBuild — input identity guards', () => {
  it('rejects missing build_id', () => {
    const input = buildValidInput();
    input.build_id = '';
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes).toContain('build.invalid_identity');
  });

  it('rejects missing task_snapshot_id', () => {
    const input = buildValidInput();
    input.task_snapshot_id = '';
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes).toContain('build.invalid_identity');
  });

  it('rejects missing current_context_snapshot_id', () => {
    const input = buildValidInput();
    input.current_context_snapshot_id = '';
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes).toContain('build.invalid_identity');
  });

  it('rejects missing request_budget_snapshot_id', () => {
    const input = buildValidInput();
    input.request_budget_snapshot_id = '';
    const prepared = captureMemoryEntrypointBuild(input);
    expect(prepared.state).toBe('rejected');
    expect(prepared.reason_codes).toContain('build.invalid_identity');
  });
});

// ===========================================================================
// §9 prepared build 输出结构不变量
// ===========================================================================

describe('captureMemoryEntrypointBuild — output structure invariants', () => {
  it('returns a prepared build with ENTRYPOINT_PROTOCOL_VERSION on the prepared_protocol_version field', () => {
    const input = buildValidInput();
    const prepared: PreparedMemoryEntrypointBuild =
      captureMemoryEntrypointBuild(input);
    expect(prepared.prepared_protocol_version).toBe(ENTRYPOINT_PROTOCOL_VERSION);
  });

  it('does not mutate the original input objects (output references captured arrays)', () => {
    const input = buildValidInput();
    const originalDetailCount = input.retrieved_details.length;
    captureMemoryEntrypointBuild(input);
    expect(input.retrieved_details.length).toBe(originalDetailCount);
  });
});
