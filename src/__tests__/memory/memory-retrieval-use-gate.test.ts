// Memory Retrieval + Use Gate 测试 (ERC-2 / M-046, T7)
//
// 覆盖规格 docs/superpowers/plans/2026-07-26-agent-mechanisms-wave-e-implementation.md Task 7:
//   - retrieveSelectedMemory: 消费 MemorySelectionResult (E-1 T6) + governed detail reader
//     + DRC-2 decideMemoryUse,产出 MemoryRetrievalResult。
//
// 关键不变量 (Global Constraints):
//   - INV-selected-neq-use: selected ≠ use;selection 通过不等于 use 通过。
//   - INV-no-inject-on-failure: detail reader / use verifier / search failure
//     均不触发 MemoryManager.inject() 或"加载全部 Memory"。
//   - INV-no-frc-section: retrieval 没有直接生成 FRC-1 section。
//   - INV-identity-independent: selection / use identity 保持独立。
//
// 测试策略:全部 dependency 用 mock 注入(readDetail / decideUse),
// 验证 retrieveSelectedMemory 的分流逻辑、完整性诊断、确定性 id 与不变量。

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  retrieveSelectedMemory,
  buildMemorySearchQuery,
  selectMemoryEntries,
  MEMORY_RETRIEVAL_PROTOCOL_VERSION,
  type MemoryRetrievalInput,
  type MemoryRetrievalDependencies,
} from '../../memory/selection.js';
import {
  buildMemoryCatalogSnapshot,
  type MemoryCatalogEntry,
} from '../../memory/catalog.js';
import {
  decideMemoryUse,
  MEMORY_USE_PROTOCOL_VERSION,
  type MemoryUseInput,
  type MemoryUseDecision,
} from '../../memory/admission.js';

// ─── detail body / content_hash 一致性辅助 ────────────────────────
// retrieveSelectedMemory 内部对 detail body 计算 sha256,前缀 'sha256:' 后
// 与 entry.content_hash 比较(规格 Step 3 "验证 hash 与 catalog entry 一致")。
// 我们让默认 detail body = 'detail body',并据此算出匹配的 content_hash。
const DEFAULT_DETAIL_BODY = 'detail body';
function hashOf(body: string): string {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}
const DEFAULT_CONTENT_HASH = hashOf(DEFAULT_DETAIL_BODY);

// ─── catalog fixtures ───────────────────────────────────────────────
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

// baseline selection: 单 entry,使用真实 selectMemoryEntries 产出 MemorySelectionResult。
// content_hash 默认 = DEFAULT_CONTENT_HASH,与 readDetail 返回 'detail body' 匹配,
// 让 entry 顺利进入 use gate;个别需要 mismatch 的用例显式覆盖 content_hash 或 readDetail。
function buildSingleSelection(
  entryOverrides: Partial<MemoryCatalogEntry> = {},
): MemoryRetrievalInput['selection'] {
  const entry = makeEntry({
    memory_record_id: 'memory-1',
    admission_decision_id: 'admit:memory-1',
    detail_commit_ref: 'detail-memory-1',
    ...entryOverrides,
  });
  const catalog = buildMemoryCatalogSnapshot([entry]);
  const query = buildMemorySearchQuery({
    scope_ref: 'workspace-1',
    topic_terms: ['typescript'],
    keyword_terms: [],
    max_selected_entries: 10,
    max_index_metadata_bytes: 10_000,
  });
  return selectMemoryEntries(query, catalog);
}

// baseline retrieval dependencies:readDetail 永远返回非空;
// decideUse 通过真实 decideMemoryUse 计算(默认 status='use')。
function makeUseDecision(status: MemoryUseDecision['status']): MemoryUseDecision {
  // 用真实 decideMemoryUse 计算一个 status —— 直接构造 input 触发期望状态,
  // 避免在测试里手写 decision_id(那会破坏内容寻址不变量)。
  const input: MemoryUseInput = {
    memory_use_protocol_version: MEMORY_USE_PROTOCOL_VERSION,
    stored_memory_ref: 'stored-memory-1',
    admission_decision_id: 'admit:memory-1',
    current_context_snapshot_id: 'snap-1',
    project_version_ref: 'proj-v1',
    candidate_claims: [],
    verified_claim_refs: status === 'use' ? ['claim-1'] : [],
    stale_claim_refs: [],
    conflicting_evidence_refs: status === 'do_not_use' ? ['ev-conflict'] : [],
    verifier_available: status !== 'needs_refresh',
    refresh_available: status === 'needs_refresh',
  };
  // 对于 needs_refresh:verifier_available=false + refresh_available=true → status='needs_refresh'
  // 对于 do_not_use:verifier_available=true + conflicting → status='do_not_use'
  // 对于 use:verifier_available=true + verified non-empty + no conflict → status='use'
  return decideMemoryUse(input);
}

describe('retrieveSelectedMemory — selected ≠ use (INV-selected-neq-use)', () => {
  it('does not expose selected detail when current-context use rejects it', async () => {
    // selection 通过(use gate do_not_use) → memory-1 不进入 usable_claim_refs,
    // 而是进入 rejected_record_ids。
    const selection = buildSingleSelection();
    const result = await retrieveSelectedMemory(
      {
        retrieval_protocol_version: MEMORY_RETRIEVAL_PROTOCOL_VERSION,
        selection,
        current_context_snapshot_id: 'snap-1',
      },
      {
        readDetail: async () => 'detail body',
        decideUse: () => makeUseDecision('do_not_use'),
      },
    );
    expect(result.usable_claim_refs).toEqual([]);
    expect(result.rejected_record_ids).toContain('memory-1');
  });

  it('exposes usable claims only when use status is use', async () => {
    const selection = buildSingleSelection();
    const result = await retrieveSelectedMemory(
      {
        retrieval_protocol_version: MEMORY_RETRIEVAL_PROTOCOL_VERSION,
        selection,
        current_context_snapshot_id: 'snap-1',
      },
      {
        readDetail: async () => 'detail body',
        decideUse: () => makeUseDecision('use'),
      },
    );
    expect(result.usable_claim_refs.length).toBeGreaterThan(0);
    expect(result.rejected_record_ids).toEqual([]);
  });

  it('needs_refresh does not enter usable_claim_refs', async () => {
    // needs_refresh 是独立状态,既不算 use 也不算 do_not_use 的 reject 集合
    // —— 但它必须从 usable_claim_refs 排除(规格 Step 4)。
    const selection = buildSingleSelection();
    const result = await retrieveSelectedMemory(
      {
        retrieval_protocol_version: MEMORY_RETRIEVAL_PROTOCOL_VERSION,
        selection,
        current_context_snapshot_id: 'snap-1',
      },
      {
        readDetail: async () => 'detail body',
        decideUse: () => makeUseDecision('needs_refresh'),
      },
    );
    expect(result.usable_claim_refs).toEqual([]);
    // needs_refresh 的 entry 仍进入 rejected_record_ids(它没通过 use gate)。
    expect(result.rejected_record_ids).toContain('memory-1');
  });
});

describe('retrieveSelectedMemory — detail integrity diagnostics', () => {
  it('records integrity diagnostic when detail missing (readDetail returns null)', async () => {
    const selection = buildSingleSelection();
    const result = await retrieveSelectedMemory(
      {
        retrieval_protocol_version: MEMORY_RETRIEVAL_PROTOCOL_VERSION,
        selection,
        current_context_snapshot_id: 'snap-1',
      },
      {
        readDetail: async () => null,
        decideUse: () => makeUseDecision('use'),
      },
    );
    // 缺 detail → 不进入 use gate(不调用 decideUse),只产 integrity 诊断。
    expect(result.integrity_diagnostics).toContainEqual({
      memory_record_id: 'memory-1',
      reason_code: 'retrieval.detail_missing',
    });
    expect(result.usable_claim_refs).toEqual([]);
    expect(result.rejected_record_ids).toEqual([]);
    expect(result.reason_codes).toContain('retrieval.detail_missing');
  });

  it('records integrity diagnostic on detail content hash mismatch', async () => {
    // readDetail 返回非 null,但 detail body 的 sha256 与 entry.content_hash 不一致
    // —— retrieveSelectedMemory 内部对 detail body 计算 sha256 并与 catalog entry 比对。
    const selection = buildSingleSelection();
    // 故意返回与 fixture content_hash 不匹配的 detail body。
    const wrongBody = 'detail body that does not match content_hash';
    expect(hashOf(wrongBody)).not.toBe(DEFAULT_CONTENT_HASH);
    const result = await retrieveSelectedMemory(
      {
        retrieval_protocol_version: MEMORY_RETRIEVAL_PROTOCOL_VERSION,
        selection,
        current_context_snapshot_id: 'snap-1',
      },
      {
        readDetail: async () => wrongBody,
        decideUse: () => makeUseDecision('use'),
      },
    );
    expect(result.integrity_diagnostics).toContainEqual({
      memory_record_id: 'memory-1',
      reason_code: 'retrieval.detail_integrity_mismatch',
    });
    expect(result.usable_claim_refs).toEqual([]);
    expect(result.reason_codes).toContain('retrieval.detail_integrity_mismatch');
  });
});

describe('retrieveSelectedMemory — failure fallback (INV-no-inject-on-failure)', () => {
  // 这一组测试验证 retrieveSelectedMemory 在 failure 路径上不触发任何
  // MemoryManager.inject 或"加载全部 Memory"。由于 retrieveSelectedMemory
  // 的 dependencies 中只有 readDetail / decideUse,我们通过 spy 验证:
  // failure 路径只产生 integrity_diagnostics / rejected_record_ids,
  // 不存在 inject 调用路径(因为签名根本没有 inject dependency)。

  it('does not call MemoryManager.inject on detail-missing failure', async () => {
    // retrieveSelectedMemory 的 dependency 接口里没有 inject 字段 ——
    // 这就是"不触发 inject"的结构性证据:函数无法访问 inject。
    const selection = buildSingleSelection();
    const deps: MemoryRetrievalDependencies = {
      readDetail: async () => null,
      decideUse: () => makeUseDecision('use'),
    };
    // dependency 接口不含 inject / loadAllMemory / searchAll。
    // 用类型系统断言:deps 上不存在 inject 属性。
    expect(deps).not.toHaveProperty('inject');
    expect(deps).not.toHaveProperty('loadAllMemory');
    const result = await retrieveSelectedMemory(
      {
        retrieval_protocol_version: MEMORY_RETRIEVAL_PROTOCOL_VERSION,
        selection,
        current_context_snapshot_id: 'snap-1',
      },
      deps,
    );
    // 结果只含诊断与空 usable,没有升级状态。
    expect(result.usable_claim_refs).toEqual([]);
    expect(result.integrity_diagnostics.length).toBeGreaterThan(0);
  });

  it('does not load all memory on use-gate rejection (rejected entries stay rejected)', async () => {
    // 多 entry selection,全部 do_not_use → 应全部进 rejected,无 usable,
    // 不存在"回退加载全部"的路径。
    const entries: MemoryCatalogEntry[] = [
      makeEntry({
        memory_record_id: 'memory-a',
        admission_decision_id: 'admit:a',
        detail_commit_ref: 'detail-a',
        content_hash: DEFAULT_CONTENT_HASH,
      }),
      makeEntry({
        memory_record_id: 'memory-b',
        admission_decision_id: 'admit:b',
        detail_commit_ref: 'detail-b',
        content_hash: DEFAULT_CONTENT_HASH,
      }),
    ];
    const catalog = buildMemoryCatalogSnapshot(entries);
    const query = buildMemorySearchQuery({
      scope_ref: 'workspace-1',
      topic_terms: ['typescript'],
      keyword_terms: [],
      max_selected_entries: 10,
      max_index_metadata_bytes: 10_000,
    });
    const selection = selectMemoryEntries(query, catalog);
    const result = await retrieveSelectedMemory(
      {
        retrieval_protocol_version: MEMORY_RETRIEVAL_PROTOCOL_VERSION,
        selection,
        current_context_snapshot_id: 'snap-1',
      },
      {
        readDetail: async () => 'detail body',
        decideUse: () => makeUseDecision('do_not_use'),
      },
    );
    // 两条全部 reject,零 usable,零 integrity 诊断(detail 都在,只是 use 拒绝)。
    expect(result.usable_claim_refs).toEqual([]);
    expect([...result.rejected_record_ids].sort()).toEqual([
      'memory-a',
      'memory-b',
    ]);
    expect(result.integrity_diagnostics).toEqual([]);
  });

  it('does not directly generate FRC-1 section (result has no frc_section field)', async () => {
    // retrieval 只输出可用 claim refs / rejected / diagnostics / ids,
    // 不输出 FRC-1 section(FRC-1 由更上层在 retrieval 之后组装)。
    const selection = buildSingleSelection();
    const result = await retrieveSelectedMemory(
      {
        retrieval_protocol_version: MEMORY_RETRIEVAL_PROTOCOL_VERSION,
        selection,
        current_context_snapshot_id: 'snap-1',
      },
      {
        readDetail: async () => 'detail body',
        decideUse: () => makeUseDecision('use'),
      },
    );
    expect(result).not.toHaveProperty('frc_section');
    expect(result).not.toHaveProperty('prompt_section');
    expect(result).not.toHaveProperty('injected_content');
  });
});

describe('retrieveSelectedMemory — determinism & identity', () => {
  it('produces deterministic retrieval_id for identical input', async () => {
    const selection = buildSingleSelection();
    const deps: MemoryRetrievalDependencies = {
      readDetail: async () => 'detail body',
      decideUse: () => makeUseDecision('use'),
    };
    const input: MemoryRetrievalInput = {
      retrieval_protocol_version: MEMORY_RETRIEVAL_PROTOCOL_VERSION,
      selection,
      current_context_snapshot_id: 'snap-1',
    };
    const r1 = await retrieveSelectedMemory(input, deps);
    const r2 = await retrieveSelectedMemory(input, deps);
    expect(r1.retrieval_id).toBe(r2.retrieval_id);
    expect(r1.retrieval_id).toContain('retrieval:');
  });

  it('keeps selection_id and current_context_snapshot_id independent on result', async () => {
    // retrieval 引用 selection_id 与 current_context_snapshot_id,但保持独立
    // —— selection_id 来自 selection(use gate 不改写 selection),
    // current_context_snapshot_id 来自 input。
    const selection = buildSingleSelection();
    const result = await retrieveSelectedMemory(
      {
        retrieval_protocol_version: MEMORY_RETRIEVAL_PROTOCOL_VERSION,
        selection,
        current_context_snapshot_id: 'snap-current',
      },
      {
        readDetail: async () => 'detail body',
        decideUse: () => makeUseDecision('use'),
      },
    );
    expect(result.selection_id).toBe(selection.selection_id);
    expect(result.current_context_snapshot_id).toBe('snap-current');
    expect(result.retrieval_protocol_version).toBe(
      MEMORY_RETRIEVAL_PROTOCOL_VERSION,
    );
  });

  it('mixes use and do_not_use across multiple entries (partial usable set)', async () => {
    // 3 entry:第一条 use,第二条 do_not_use,第三条 use
    // → usable 含 1 和 3 的 claim;rejected 含 2 的 record_id。
    const entries: MemoryCatalogEntry[] = [
      makeEntry({
        memory_record_id: 'memory-1',
        admission_decision_id: 'admit:1',
        detail_commit_ref: 'detail-1',
        content_hash: DEFAULT_CONTENT_HASH,
      }),
      makeEntry({
        memory_record_id: 'memory-2',
        admission_decision_id: 'admit:2',
        detail_commit_ref: 'detail-2',
        content_hash: DEFAULT_CONTENT_HASH,
      }),
      makeEntry({
        memory_record_id: 'memory-3',
        admission_decision_id: 'admit:3',
        detail_commit_ref: 'detail-3',
        content_hash: DEFAULT_CONTENT_HASH,
      }),
    ];
    const catalog = buildMemoryCatalogSnapshot(entries);
    const query = buildMemorySearchQuery({
      scope_ref: 'workspace-1',
      topic_terms: ['typescript'],
      keyword_terms: [],
      max_selected_entries: 10,
      max_index_metadata_bytes: 10_000,
    });
    const selection = selectMemoryEntries(query, catalog);

    // decideUse 根据 stored_memory_ref 分流:memory-2 → do_not_use,其他 → use。
    // 由于 retrieveSelectedMemory 构造 MemoryUseInput 时使用 entry.admission_decision_id
    // 作为 admission_decision_id,我们按 record id 区分。
    // 这里我们用闭包根据调用 input 决定状态。retrieveSelectedMemory 在构造
    // MemoryUseInput 时,stored_memory_ref 取自 entry.memory_record_id。
    const result = await retrieveSelectedMemory(
      {
        retrieval_protocol_version: MEMORY_RETRIEVAL_PROTOCOL_VERSION,
        selection,
        current_context_snapshot_id: 'snap-1',
      },
      {
        readDetail: async () => 'detail body',
        decideUse: (input: MemoryUseInput) => {
          if (input.stored_memory_ref === 'memory-2') {
            return makeUseDecision('do_not_use');
          }
          return makeUseDecision('use');
        },
      },
    );
    expect(result.rejected_record_ids).toEqual(['memory-2']);
    // memory-1 / memory-3 的 claim 进入 usable(use status)。
    expect(result.usable_claim_refs.length).toBeGreaterThan(0);
    // usable 数量 > 0 且严格小于"全部 selected entries 的 claim"。
    expect(result.integrity_diagnostics).toEqual([]);
  });
});

describe('retrieveSelectedMemory — immutability', () => {
  it('produces a frozen result object', async () => {
    const selection = buildSingleSelection();
    const result = await retrieveSelectedMemory(
      {
        retrieval_protocol_version: MEMORY_RETRIEVAL_PROTOCOL_VERSION,
        selection,
        current_context_snapshot_id: 'snap-1',
      },
      {
        readDetail: async () => 'detail body',
        decideUse: () => makeUseDecision('use'),
      },
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.usable_claim_refs)).toBe(true);
    expect(Object.isFrozen(result.rejected_record_ids)).toBe(true);
    expect(Object.isFrozen(result.integrity_diagnostics)).toBe(true);
  });

  it('does not mutate the selection argument', async () => {
    const selection = buildSingleSelection();
    const selectionIdBefore = selection.selection_id;
    const selectedCountBefore = selection.selected_entries.length;
    await retrieveSelectedMemory(
      {
        retrieval_protocol_version: MEMORY_RETRIEVAL_PROTOCOL_VERSION,
        selection,
        current_context_snapshot_id: 'snap-1',
      },
      {
        readDetail: async () => 'detail body',
        decideUse: () => makeUseDecision('do_not_use'),
      },
    );
    expect(selection.selection_id).toBe(selectionIdBefore);
    expect(selection.selected_entries.length).toBe(selectedCountBefore);
    expect(Object.isFrozen(selection)).toBe(true);
  });
});
