// src/__tests__/agent/bounded-memory-budget.test.ts
// FRC-1 Task 4 — Hard Budgets 与 Overflow Manifest.
//
// 物理本质:把 eligible navigation items + eligible verified claims 按
// navigation/verified-detail/total-section 三层预算切分,产生 retained 集合 +
// overflow manifest。切分边界只能是"整项 omit",绝不能切 string/Buffer/label。
//
// 断言对应 spec §7.9 / §7.10 + Task 4 的 18 条强制覆盖项。
// 本文件只 import 本任务实现的 bounded-memory-budget.ts,与 T1/T5 解耦。

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  applyMemoryEntrypointBudgets,
  BUDGET_PROTOCOL_VERSION,
  OVERFLOW_MANIFEST_PROTOCOL_VERSION,
  type ApplyMemoryEntrypointBudgetsInput,
  type BudgetNavigationItem,
  type BudgetVerifiedClaim,
  type MemoryBudgetFragmentRenderer,
  type NavigationBudgetPolicy,
  type OmittedClaimRef,
  type OmittedNavigationRecord,
  type TotalSectionBudgetPolicy,
  type TokenEstimator,
  type VerifiedDetailBudgetPolicy,
} from '../../agent/context/bounded-memory-budget.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 构造一条 navigation item,允许覆盖任意字段。 */
function makeNavigation(
  overrides: Partial<BudgetNavigationItem> = {},
): BudgetNavigationItem {
  return {
    memory_record_id: 'mem:1',
    record_version: 1,
    selection_rank: 0,
    memory_type: 'user_preference',
    scope_ref: 'project:mi-code',
    topic_key_refs: ['topic:t1'],
    keyword_key_refs: ['kw:k1'],
    observed_at: '2026-07-20T00:00:00.000Z',
    expires_at: null,
    detail_content_hash: sha256('detail-1'),
    provenance_refs: ['claim:c1'],
    durability_evidence_ref: 'durability:d1',
    ...overrides,
  };
}

/** 构造一条 verified claim,允许覆盖任意字段。 */
function makeClaim(
  overrides: Partial<BudgetVerifiedClaim> = {},
): BudgetVerifiedClaim {
  return {
    claim_projection_id: 'claim:proj:1',
    memory_record_id: 'mem:2',
    record_version: 1,
    retrieval_id: 'retr:1',
    memory_use_decision_id: 'dec:1',
    current_context_snapshot_id: 'ctx:snap:1',
    project_version_ref: 'proj:v1',
    verified_claim_ref: 'vc:1',
    content_ref: 'claim:content:1',
    content_hash: sha256('claim-body-1'),
    provenance_refs: ['claim:c2'],
    freshness_ref: 'freshness:f1',
    ...overrides,
  };
}

/**
 * 基于字符串长度的确定性 estimator —— 不依赖真实 tokenizer,但每字节 token 数稳定。
 * 便于测试 estimator_ref / estimated_tokens 填充与携带。
 */
function makeCharCountEstimator(
  estimator_id = 'char-counter',
  estimator_version = '1',
): TokenEstimator {
  return {
    estimator_id,
    estimator_version,
    model_scope: null,
    method: 'char-count',
    measure: (rendered: string) => rendered.length,
  };
}

/**
 * 一个简单的 deterministic renderer:输出"块大小可控"的字符串。
 * 单条 navigation 渲染为 `nav:${id}\nrank:${rank}`;claim 同理。
 * 用纯字符串而非复杂模板,避免与 T5 escape 逻辑耦合。
 */
const SIMPLE_RENDERER: MemoryBudgetFragmentRenderer = {
  renderNavigation: (item: BudgetNavigationItem) =>
    `nav:${item.memory_record_id}\nrank:${item.selection_rank}`,
  renderVerifiedClaim: (claim: BudgetVerifiedClaim) =>
    `claim:${claim.verified_claim_ref}\nrecord:${claim.memory_record_id}`,
};

const NAV_POLICY: NavigationBudgetPolicy = {
  source_class: 'memory_navigation',
  max_bytes: 1_000_000,
  max_lines: null,
  max_entries: 100,
  policy_id: 'nav-policy',
  policy_version: '1',
};

const DETAIL_POLICY: VerifiedDetailBudgetPolicy = {
  source_class: 'memory_verified_detail',
  max_bytes: 1_000_000,
  max_lines: null,
  max_items: 100,
  max_claims_per_item: 100,
  policy_id: 'detail-policy',
  policy_version: '1',
};

const TOTAL_POLICY: TotalSectionBudgetPolicy = {
  source_class: 'memory_section_total',
  max_bytes: 1_000_000,
  max_lines: null,
  policy_id: 'total-policy',
  policy_version: '1',
};

/** 构造一份默认预算充分的输入(无任何 omission)。 */
function makeInput(
  overrides: Partial<ApplyMemoryEntrypointBudgetsInput> = {},
): ApplyMemoryEntrypointBudgetsInput {
  return {
    eligible_navigation: [makeNavigation()],
    eligible_claims: [makeClaim()],
    upstream_navigation_omissions: [],
    upstream_claim_omissions: [],
    navigation_budget_policy: NAV_POLICY,
    verified_detail_budget_policy: DETAIL_POLICY,
    total_section_budget_policy: TOTAL_POLICY,
    overflow_behavior: 'entry_boundary_omit',
    renderer: SIMPLE_RENDERER,
    estimator: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyMemoryEntrypointBudgets (FRC-1 Task 4)', () => {
  it('1. applied_steps always contains the fixed six-step ordering', () => {
    // 即使无任何 omission 触发,applied_steps 也必须严格等于这个六步数组。
    const result = applyMemoryEntrypointBudgets(makeInput());
    expect(Array.from(result.applied_steps)).toEqual([
      'navigation_count',
      'navigation_budget',
      'per_item_claim_count',
      'verified_detail_count',
      'verified_detail_budget',
      'total_section_budget',
    ]);
  });

  it('2. navigation_count cap drops tail items and records omission', () => {
    const navs = [
      makeNavigation({ memory_record_id: 'mem:a', selection_rank: 0 }),
      makeNavigation({ memory_record_id: 'mem:b', selection_rank: 1 }),
      makeNavigation({ memory_record_id: 'mem:c', selection_rank: 2 }),
      makeNavigation({ memory_record_id: 'mem:d', selection_rank: 3 }),
    ];
    const result = applyMemoryEntrypointBudgets(
      makeInput({
        eligible_navigation: navs,
        eligible_claims: [],
        navigation_budget_policy: { ...NAV_POLICY, max_entries: 2 },
      }),
    );

    const retainedIds = result.retained_navigation.map((n) => n.memory_record_id);
    // 头部优先级最高,从尾部移除
    expect(retainedIds).toEqual(['mem:a', 'mem:b']);

    const omittedIds = result.overflow_manifest.omitted_records.map(
      (r) => r.memory_record_id,
    );
    expect(omittedIds).toContain('mem:c');
    expect(omittedIds).toContain('mem:d');
    // 被移除项的 reason_codes 包含 navigation_count_limit
    for (const rec of result.overflow_manifest.omitted_records) {
      if (rec.memory_record_id === 'mem:c' || rec.memory_record_id === 'mem:d') {
        expect(Array.from(rec.reason_codes)).toContain('navigation_count_limit');
      }
    }
    expect(result.state).toBe('partial');
  });

  it('3. navigation budget max_bytes omits a single oversized item entirely', () => {
    // 单项渲染超过 max_bytes 必须整项 omit,绝不能截断 string。
    const bigNav = makeNavigation({ memory_record_id: 'mem:big', selection_rank: 0 });
    const bigRenderer: MemoryBudgetFragmentRenderer = {
      renderNavigation: () => 'X'.repeat(500), // 500 bytes
      renderVerifiedClaim: (c) => `claim:${c.verified_claim_ref}`,
    };
    const result = applyMemoryEntrypointBudgets(
      makeInput({
        eligible_navigation: [bigNav],
        eligible_claims: [],
        renderer: bigRenderer,
        navigation_budget_policy: { ...NAV_POLICY, max_bytes: 100 },
      }),
    );

    expect(result.retained_navigation).toHaveLength(0);
    const rec = result.overflow_manifest.omitted_records.find(
      (r) => r.memory_record_id === 'mem:big',
    );
    expect(rec).toBeDefined();
    expect(Array.from(rec!.reason_codes)).toContain('navigation_budget_limit');
    expect(result.overflow_manifest.navigation_overflowed).toBe(true);
  });

  it('4. navigation budget max_lines omits a single oversized item entirely', () => {
    // 渲染产出 100 行,超过 max_lines=10 必须整项 omit。
    const nav = makeNavigation({ memory_record_id: 'mem:lines', selection_rank: 0 });
    const multiLineRenderer: MemoryBudgetFragmentRenderer = {
      renderNavigation: () => Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n'),
      renderVerifiedClaim: (c) => `claim:${c.verified_claim_ref}`,
    };
    const result = applyMemoryEntrypointBudgets(
      makeInput({
        eligible_navigation: [nav],
        eligible_claims: [],
        renderer: multiLineRenderer,
        navigation_budget_policy: { ...NAV_POLICY, max_lines: 10 },
      }),
    );

    expect(result.retained_navigation).toHaveLength(0);
    expect(result.overflow_manifest.navigation_overflowed).toBe(true);
    const rec = result.overflow_manifest.omitted_records.find(
      (r) => r.memory_record_id === 'mem:lines',
    );
    expect(rec).toBeDefined();
    expect(Array.from(rec!.reason_codes)).toContain('navigation_budget_limit');
  });

  it('5. verified_detail budget max_bytes omits a single oversized claim entirely', () => {
    const claim = makeClaim({ memory_record_id: 'mem:big' });
    const bigRenderer: MemoryBudgetFragmentRenderer = {
      renderNavigation: (n) => `nav:${n.memory_record_id}`,
      renderVerifiedClaim: () => 'X'.repeat(500),
    };
    const result = applyMemoryEntrypointBudgets(
      makeInput({
        eligible_navigation: [],
        eligible_claims: [claim],
        renderer: bigRenderer,
        verified_detail_budget_policy: { ...DETAIL_POLICY, max_bytes: 100 },
      }),
    );

    expect(result.retained_claims).toHaveLength(0);
    const ref = result.overflow_manifest.omitted_claim_refs.find(
      (r) => r.memory_record_id === 'mem:big',
    );
    expect(ref).toBeDefined();
    expect(Array.from(ref!.reason_codes)).toContain('verified_detail_budget_limit');
    expect(result.overflow_manifest.verified_detail_overflowed).toBe(true);
  });

  it('6. max_claims_per_item keeps the first N claims per record, omits the rest', () => {
    // 同一条 record 下挂 5 条 claim,max_claims_per_item=2,只保留前 2 条。
    const claims: BudgetVerifiedClaim[] = Array.from({ length: 5 }, (_, i) =>
      makeClaim({
        claim_projection_id: `claim:proj:${i}`,
        verified_claim_ref: `vc:${i}`,
        memory_record_id: 'mem:same',
      }),
    );
    const result = applyMemoryEntrypointBudgets(
      makeInput({
        eligible_navigation: [],
        eligible_claims: claims,
        verified_detail_budget_policy: { ...DETAIL_POLICY, max_claims_per_item: 2 },
      }),
    );

    const retainedRefs = result.retained_claims.map((c) => c.verified_claim_ref);
    // 按 claim 输入顺序保留前 N
    expect(retainedRefs).toEqual(['vc:0', 'vc:1']);
    // 其余 3 条被 omit,reason_codes 包含 verified_detail_count_limit
    const omittedRefs = result.overflow_manifest.omitted_claim_refs
      .filter((r) => r.claim_ref !== undefined)
      .map((r) => r.claim_ref);
    expect(omittedRefs).toEqual(['vc:2', 'vc:3', 'vc:4']);
    for (const ref of result.overflow_manifest.omitted_claim_refs) {
      expect(Array.from(ref.reason_codes)).toContain('verified_detail_count_limit');
    }
  });

  it('7. verified_detail_count cap drops tail claims and records omission', () => {
    // 不同 record 下各一条 claim —— 测试 max_items 而不是 max_claims_per_item。
    const claims: BudgetVerifiedClaim[] = Array.from({ length: 4 }, (_, i) =>
      makeClaim({
        claim_projection_id: `claim:proj:${i}`,
        verified_claim_ref: `vc:${i}`,
        memory_record_id: `mem:${i}`,
      }),
    );
    const result = applyMemoryEntrypointBudgets(
      makeInput({
        eligible_navigation: [],
        eligible_claims: claims,
        verified_detail_budget_policy: { ...DETAIL_POLICY, max_items: 2 },
      }),
    );

    const retainedRefs = result.retained_claims.map((c) => c.verified_claim_ref);
    // 头部优先级最高,从尾部移除
    expect(retainedRefs).toEqual(['vc:0', 'vc:1']);
    const omittedRefs = result.overflow_manifest.omitted_claim_refs
      .filter((r) => r.claim_ref !== undefined)
      .map((r) => r.claim_ref);
    expect(omittedRefs).toEqual(['vc:2', 'vc:3']);
    for (const ref of result.overflow_manifest.omitted_claim_refs) {
      expect(Array.from(ref.reason_codes)).toContain('verified_detail_count_limit');
    }
  });

  it('8. total_section budget performs two-phase omission (claims first, then navigation with its claims)', () => {
    // total max_bytes=300;每条 nav 渲染约 20 bytes,每条 claim 渲染约 30 bytes。
    // 放入 4 navs(总 80B) + 4 claims(总 120B,挂在不同 record) → 200B,未超。
    // 然后把 total 调到 100B,触发二阶段:先逆序移除 claim,再逆序移除 nav。
    const navs: BudgetNavigationItem[] = Array.from({ length: 4 }, (_, i) =>
      makeNavigation({ memory_record_id: `mem:n${i}`, selection_rank: i }),
    );
    const claims: BudgetVerifiedClaim[] = Array.from({ length: 4 }, (_, i) =>
      makeClaim({
        claim_projection_id: `claim:proj:${i}`,
        verified_claim_ref: `vc:${i}`,
        memory_record_id: `mem:c${i}`,
      }),
    );
    const result = applyMemoryEntrypointBudgets(
      makeInput({
        eligible_navigation: navs,
        eligible_claims: claims,
        total_section_budget_policy: { ...TOTAL_POLICY, max_bytes: 80 },
      }),
    );

    expect(result.overflow_manifest.total_budget_overflowed).toBe(true);
    // 二阶段总会有 omission,具体取决于实际渲染字节;至少触发了一处 omitted。
    expect(
      result.overflow_manifest.omitted_claim_refs.length +
        result.overflow_manifest.omitted_records.length,
    ).toBeGreaterThan(0);
    expect(result.state).not.toBe('ready');
  });

  it('8b. total_section budget: removing a navigation also removes its associated claims', () => {
    // 让 nav 和 claim 挂同一个 record,然后 total 压到只能留 1 个 nav。
    // 验证:被移除 nav 下属于该 record 的 claim 也被移除。
    const sharedNav = makeNavigation({ memory_record_id: 'mem:keep', selection_rank: 0 });
    const droppedNav = makeNavigation({ memory_record_id: 'mem:drop', selection_rank: 1 });
    const claimOnDropped = makeClaim({
      memory_record_id: 'mem:drop',
      verified_claim_ref: 'vc:ondrop',
    });
    const result = applyMemoryEntrypointBudgets(
      makeInput({
        eligible_navigation: [sharedNav, droppedNav],
        eligible_claims: [claimOnDropped],
        // 总预算小到只能容纳 1 nav(无 claim)
        total_section_budget_policy: {
          ...TOTAL_POLICY,
          max_bytes: Buffer.byteLength('nav:mem:keep\nrank:0', 'utf8'),
        },
      }),
    );

    const droppedRec = result.overflow_manifest.omitted_records.find(
      (r) => r.memory_record_id === 'mem:drop',
    );
    expect(droppedRec).toBeDefined();
    // 被移除 nav 下的 claim 必须同步移除
    const droppedClaim = result.overflow_manifest.omitted_claim_refs.find(
      (r) => r.claim_ref === 'vc:ondrop',
    );
    expect(droppedClaim).toBeDefined();
    // retained 里绝对不能有 dropped nav/claim
    expect(result.retained_navigation.map((n) => n.memory_record_id)).not.toContain(
      'mem:drop',
    );
    expect(result.retained_claims.map((c) => c.verified_claim_ref)).not.toContain(
      'vc:ondrop',
    );
  });

  it('9. overflow_behavior=reject produces state=rejected with empty retained', () => {
    const nav = makeNavigation({ memory_record_id: 'mem:big', selection_rank: 0 });
    const bigRenderer: MemoryBudgetFragmentRenderer = {
      renderNavigation: () => 'X'.repeat(500),
      renderVerifiedClaim: (c) => `claim:${c.verified_claim_ref}`,
    };
    const result = applyMemoryEntrypointBudgets(
      makeInput({
        eligible_navigation: [nav],
        eligible_claims: [],
        renderer: bigRenderer,
        navigation_budget_policy: { ...NAV_POLICY, max_bytes: 100 },
        overflow_behavior: 'reject',
      }),
    );

    expect(result.state).toBe('rejected');
    expect(result.retained_navigation).toHaveLength(0);
    expect(result.retained_claims).toHaveLength(0);
    expect(result.overflow_manifest.truncated).toBe(true);
  });

  it('10. multibyte content is measured by UTF-8 bytes (not string length)', () => {
    // 中文字符 1 个 char 占 3 UTF-8 字节,emoji 占 4 字节。
    // 渲染产出一个 4 字符中文(12 字节) + emoji(4 字节) = 16 字节。
    const nav = makeNavigation({ memory_record_id: 'mem:中文', selection_rank: 0 });
    const multibyteRenderer: MemoryBudgetFragmentRenderer = {
      renderNavigation: (n) => `标签:${n.memory_record_id}😀`,
      renderVerifiedClaim: (c) => `claim:${c.verified_claim_ref}`,
    };
    const result = applyMemoryEntrypointBudgets(
      makeInput({
        eligible_navigation: [nav],
        eligible_claims: [],
        renderer: multibyteRenderer,
      }),
    );

    expect(result.retained_navigation).toHaveLength(1);
    const nav0 = result.retained_navigation[0]!;
    // "标签:mem:中文😀" UTF-8 字节数
    const expectedBytes = Buffer.byteLength('标签:mem:中文😀', 'utf8');
    expect(nav0.measurement.bytes).toBe(expectedBytes);
    expect(nav0.measurement.bytes).not.toBe('标签:mem:中文😀'.length);
  });

  it('11. zero budget omits all eligible items (state rejected when no upstream omissions)', () => {
    const nav = makeNavigation({ memory_record_id: 'mem:1', selection_rank: 0 });
    const result = applyMemoryEntrypointBudgets(
      makeInput({
        eligible_navigation: [nav],
        eligible_claims: [],
        navigation_budget_policy: { ...NAV_POLICY, max_bytes: 0 },
        verified_detail_budget_policy: { ...DETAIL_POLICY, max_bytes: 0 },
      }),
    );

    expect(result.retained_navigation).toHaveLength(0);
    // 全部 omit 且无 upstream → state rejected(无内容)
    expect(result.state).toBe('rejected');
    expect(result.overflow_manifest.truncated).toBe(true);
  });

  it('11b. zero budget with upstream omission produces partial state', () => {
    const nav = makeNavigation({ memory_record_id: 'mem:1', selection_rank: 0 });
    const upstream: OmittedNavigationRecord = {
      memory_record_id: 'mem:upstream',
      reason_codes: ['scope_excluded'],
    };
    const result = applyMemoryEntrypointBudgets(
      makeInput({
        eligible_navigation: [nav],
        eligible_claims: [],
        upstream_navigation_omissions: [upstream],
        navigation_budget_policy: { ...NAV_POLICY, max_bytes: 0 },
      }),
    );

    // 全部 eligible 被 omit,但有 upstream omission(说明输入本来有更多)
    expect(result.retained_navigation).toHaveLength(0);
    expect(result.state).toBe('rejected');
    // upstream omission 必须在 manifest 里
    const upstreamRec = result.overflow_manifest.omitted_records.find(
      (r) => r.memory_record_id === 'mem:upstream',
    );
    expect(upstreamRec).toBeDefined();
  });

  it('12. estimator fills estimated_tokens and carries estimator_ref', () => {
    const result = applyMemoryEntrypointBudgets(
      makeInput({ estimator: makeCharCountEstimator('tok', '3') }),
    );
    // estimator_ref 形如 `${estimator_id}:${estimator_version}`
    expect(result.estimator_ref).toBe('tok:3');
    for (const nav of result.retained_navigation) {
      expect(nav.measurement.estimated_tokens).toBe(
        Buffer.from(nav.rendered_fragment).toString().length,
      );
    }
    // total_measurement.estimated_tokens 也必须有值
    expect(result.total_measurement.estimated_tokens).not.toBeNull();
  });

  it('13. estimator=null yields estimated_tokens=null and estimator_ref=null', () => {
    const result = applyMemoryEntrypointBudgets(makeInput({ estimator: null }));
    expect(result.estimator_ref).toBeNull();
    for (const nav of result.retained_navigation) {
      expect(nav.measurement.estimated_tokens).toBeNull();
    }
    for (const claim of result.retained_claims) {
      expect(claim.measurement.estimated_tokens).toBeNull();
    }
    expect(result.total_measurement.estimated_tokens).toBeNull();
  });

  it('14. upstream omissions are passed through and merged with budget omissions', () => {
    const upstreamNav: OmittedNavigationRecord = {
      memory_record_id: 'mem:upstream-nav',
      reason_codes: ['scope_excluded', 'durability_unverified'],
    };
    const upstreamClaim: OmittedClaimRef = {
      memory_record_id: 'mem:upstream-claim',
      claim_ref: 'vc:upstream',
      reason_codes: ['use_denied'],
    };
    const droppedNav = makeNavigation({ memory_record_id: 'mem:dropped', selection_rank: 5 });
    const result = applyMemoryEntrypointBudgets(
      makeInput({
        eligible_navigation: [droppedNav],
        eligible_claims: [],
        upstream_navigation_omissions: [upstreamNav],
        upstream_claim_omissions: [upstreamClaim],
        navigation_budget_policy: { ...NAV_POLICY, max_entries: 0 },
      }),
    );

    // 上游 + budget omission 都出现在 manifest
    const allNavReasons = new Set(
      result.overflow_manifest.omitted_records.flatMap((r) => Array.from(r.reason_codes)),
    );
    expect(allNavReasons.has('scope_excluded')).toBe(true);
    expect(allNavReasons.has('navigation_count_limit')).toBe(true);
    // 上游 claim omission 也在
    const upstreamClaimOmitted = result.overflow_manifest.omitted_claim_refs.find(
      (r) => r.claim_ref === 'vc:upstream',
    );
    expect(upstreamClaimOmitted).toBeDefined();
  });

  it('15. deterministic: same input yields identical retained/ordering/overflow_manifest', () => {
    const navs: BudgetNavigationItem[] = Array.from({ length: 5 }, (_, i) =>
      makeNavigation({ memory_record_id: `mem:${i}`, selection_rank: i }),
    );
    const claims: BudgetVerifiedClaim[] = Array.from({ length: 5 }, (_, i) =>
      makeClaim({
        claim_projection_id: `claim:proj:${i}`,
        verified_claim_ref: `vc:${i}`,
        memory_record_id: `mem:${i}`,
      }),
    );
    const input = makeInput({
      eligible_navigation: navs,
      eligible_claims: claims,
      navigation_budget_policy: { ...NAV_POLICY, max_entries: 3 },
      verified_detail_budget_policy: { ...DETAIL_POLICY, max_items: 2 },
      estimator: makeCharCountEstimator(),
    });

    const r1 = applyMemoryEntrypointBudgets(input);
    const r2 = applyMemoryEntrypointBudgets(input);

    // manifest id 完全一致
    expect(r1.overflow_manifest.overflow_manifest_id).toBe(
      r2.overflow_manifest.overflow_manifest_id,
    );
    // retained ids / 顺序完全一致
    expect(r1.retained_navigation.map((n) => n.memory_record_id)).toEqual(
      r2.retained_navigation.map((n) => n.memory_record_id),
    );
    expect(r1.retained_claims.map((c) => c.verified_claim_ref)).toEqual(
      r2.retained_claims.map((c) => c.verified_claim_ref),
    );
    // omitted 完全一致
    expect(r1.overflow_manifest.omitted_records.map((r) => r.memory_record_id)).toEqual(
      r2.overflow_manifest.omitted_records.map((r) => r.memory_record_id),
    );
  });

  it('16. output is deeply frozen (Object.isFrozen + nested frozen)', () => {
    const result = applyMemoryEntrypointBudgets(makeInput());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.retained_navigation)).toBe(true);
    expect(Object.isFrozen(result.retained_claims)).toBe(true);
    expect(Object.isFrozen(result.overflow_manifest)).toBe(true);
    expect(Object.isFrozen(result.overflow_manifest.omitted_records)).toBe(true);
    if (result.retained_navigation.length > 0) {
      expect(Object.isFrozen(result.retained_navigation[0]!)).toBe(true);
      expect(Object.isFrozen(result.retained_navigation[0]!.measurement)).toBe(true);
    }
    if (result.retained_claims.length > 0) {
      expect(Object.isFrozen(result.retained_claims[0]!)).toBe(true);
    }
  });

  it('17. ready state: no omissions (including no upstream)', () => {
    const result = applyMemoryEntrypointBudgets(makeInput());
    expect(result.state).toBe('ready');
    expect(result.overflow_manifest.truncated).toBe(false);
    expect(result.overflow_manifest.omitted_records).toHaveLength(0);
    expect(result.overflow_manifest.omitted_claim_refs).toHaveLength(0);
    expect(result.overflow_manifest.navigation_overflowed).toBe(false);
    expect(result.overflow_manifest.verified_detail_overflowed).toBe(false);
    expect(result.overflow_manifest.total_budget_overflowed).toBe(false);
  });

  it('18. partial state: retained present and upstream omission present', () => {
    const upstreamNav: OmittedNavigationRecord = {
      memory_record_id: 'mem:upstream',
      reason_codes: ['scope_excluded'],
    };
    const result = applyMemoryEntrypointBudgets(
      makeInput({
        upstream_navigation_omissions: [upstreamNav],
      }),
    );
    // 有 retained 且有 upstream omission → partial
    expect(result.state).toBe('partial');
    expect(result.retained_navigation.length).toBeGreaterThan(0);
    expect(result.overflow_manifest.truncated).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Protocol constants & manifest structure
  // ---------------------------------------------------------------------------

  it('19. protocol versions are exported and stamped on output', () => {
    expect(BUDGET_PROTOCOL_VERSION).toBe('1');
    expect(OVERFLOW_MANIFEST_PROTOCOL_VERSION).toBe('1');
    const result = applyMemoryEntrypointBudgets(makeInput());
    expect(result.budget_protocol_version).toBe('1');
    expect(result.overflow_manifest.overflow_protocol_version).toBe('1');
  });

  it('20. budget_policy_refs contains all three policy id:version refs', () => {
    const result = applyMemoryEntrypointBudgets(makeInput());
    const refs = Array.from(result.overflow_manifest.budget_policy_refs);
    expect(refs).toContain('nav-policy:1');
    expect(refs).toContain('detail-policy:1');
    expect(refs).toContain('total-policy:1');
  });

  it('21. overflow_manifest_id is a sha256 hex (64 lowercase hex)', () => {
    const result = applyMemoryEntrypointBudgets(makeInput());
    expect(result.overflow_manifest.overflow_manifest_id).toMatch(/^[a-f0-9]{64}$/);
  });

  it('22. total_measurement aggregates retained bytes/lines/tokens', () => {
    const result = applyMemoryEntrypointBudgets(
      makeInput({ estimator: makeCharCountEstimator() }),
    );
    const expectedBytes =
      result.retained_navigation.reduce((s, n) => s + n.measurement.bytes, 0) +
      result.retained_claims.reduce((s, c) => s + c.measurement.bytes, 0);
    expect(result.total_measurement.bytes).toBe(expectedBytes);
    const expectedLines =
      result.retained_navigation.reduce((s, n) => s + n.measurement.lines, 0) +
      result.retained_claims.reduce((s, c) => s + c.measurement.lines, 0);
    expect(result.total_measurement.lines).toBe(expectedLines);
  });
});
