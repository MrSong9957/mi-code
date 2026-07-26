// FRC-1 Bounded Memory Entrypoint — Wave F Task 9: Activation Gate 测试
//
// 物理本质:验证 §7.19 的"十二门 AND gate"。所有 12 项证据同时为 true 时
// activation active=true;任一为 false 时 active=false,并在 reason_codes 中
// 列出 `memory_entrypoint.gate_missing.<field>` 对应的失败门。
//
// 覆盖规格 docs/superpowers/specs/2026-07-26-agent-bounded-memory-entrypoint-wave-f-design.md
//   §7.19 Activation gate / Task 9 Step 1
//
// 关键不变量:
//   - 12 门 AND gate,任一缺失即 inactive(不允许"近似 active")
//   - reason_codes 必须可程序化枚举,数值上下文不入 code
//   - activation 函数本身不调用 build/cache(纯证据验证)

import { describe, it, expect } from 'vitest';

import {
  canActivateBoundedMemoryEntrypoint,
  type BoundedMemoryActivationEvidence,
} from '../../agent/context/bounded-memory.js';

// ─── 公共 fixture ────────────────────────────────────────────────────

/** 构造全部门为 true 的 evidence(默认 happy path)。 */
function buildPassingEvidence(
  overrides: Partial<BoundedMemoryActivationEvidence> = {},
): BoundedMemoryActivationEvidence {
  return {
    // 12 门(§7.19.1–§7.19.12)
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
    ...overrides,
  };
}

// 12 门字段名,用于 it.each 驱动测试。
const TWELVE_GATES = [
  'catalog_immutable_and_hash_valid',
  'catalog_durability_evidence_only',
  'selection_deterministic_with_overflow',
  'retrieval_version_hash_bound',
  'use_decisions_bind_current_context',
  'only_use_claims_in_body',
  'source_budgets_with_overflow',
  'compiler_stable_section_metadata',
  'authority_trust_placement_separated',
  'empty_omits_section',
  'no_full_load_fallback',
  'deterministic_test_evidence',
] as const satisfies ReadonlyArray<keyof BoundedMemoryActivationEvidence>;

// ===========================================================================
// §1 十二门 AND gate — 单门失败 → inactive
// ===========================================================================

describe('canActivateBoundedMemoryEntrypoint — 十二门 AND gate', () => {
  it.each(TWELVE_GATES)(
    '门 %s 为 false(其他全 true)→ active=false 且 reason_codes 含对应 gate_missing',
    (gate) => {
      const evidence = buildPassingEvidence({ [gate]: false });
      const result = canActivateBoundedMemoryEntrypoint(evidence);

      expect(result.active).toBe(false);
      expect(result.reason_codes).toContain(
        `memory_entrypoint.gate_missing.${gate}`,
      );
      // 失败时也应该恰好只有这一个 reason_code(其他门都过)
      expect(result.reason_codes).toHaveLength(1);
    },
  );

  it('全部门为 true → active=true 且 reason_codes 为空', () => {
    const evidence = buildPassingEvidence();
    const result = canActivateBoundedMemoryEntrypoint(evidence);

    expect(result.active).toBe(true);
    expect(result.reason_codes).toEqual([]);
  });

  it('多门为 false → reason_codes 含多个 gate_missing code(顺序按字段定义序)', () => {
    const evidence = buildPassingEvidence({
      catalog_immutable_and_hash_valid: false,
      retrieval_version_hash_bound: false,
      no_full_load_fallback: false,
    });
    const result = canActivateBoundedMemoryEntrypoint(evidence);

    expect(result.active).toBe(false);
    expect(result.reason_codes).toHaveLength(3);
    // 每个失败门都在 reason_codes 中
    expect(result.reason_codes).toContain(
      'memory_entrypoint.gate_missing.catalog_immutable_and_hash_valid',
    );
    expect(result.reason_codes).toContain(
      'memory_entrypoint.gate_missing.retrieval_version_hash_bound',
    );
    expect(result.reason_codes).toContain(
      'memory_entrypoint.gate_missing.no_full_load_fallback',
    );
    // 顺序按字段定义序(与 12 门枚举顺序一致)
    expect(result.reason_codes).toEqual([
      'memory_entrypoint.gate_missing.catalog_immutable_and_hash_valid',
      'memory_entrypoint.gate_missing.retrieval_version_hash_bound',
      'memory_entrypoint.gate_missing.no_full_load_fallback',
    ]);
  });

  it('全部门为 false → 12 个 gate_missing code,active=false', () => {
    const evidence: BoundedMemoryActivationEvidence = {
      catalog_immutable_and_hash_valid: false,
      catalog_durability_evidence_only: false,
      selection_deterministic_with_overflow: false,
      retrieval_version_hash_bound: false,
      use_decisions_bind_current_context: false,
      only_use_claims_in_body: false,
      source_budgets_with_overflow: false,
      compiler_stable_section_metadata: false,
      authority_trust_placement_separated: false,
      empty_omits_section: false,
      no_full_load_fallback: false,
      deterministic_test_evidence: false,
    };
    const result = canActivateBoundedMemoryEntrypoint(evidence);

    expect(result.active).toBe(false);
    expect(result.reason_codes).toHaveLength(12);
    // 每个 gate_missing code 都在结果中
    for (const gate of TWELVE_GATES) {
      expect(result.reason_codes).toContain(
        `memory_entrypoint.gate_missing.${gate}`,
      );
    }
  });
});

// ===========================================================================
// §2 协议版本 + checked_at 字段
// ===========================================================================

describe('canActivateBoundedMemoryEntrypoint — 协议元数据', () => {
  it('result 携带 activation_protocol_version="mi.memory.activation/1"', () => {
    const result = canActivateBoundedMemoryEntrypoint(buildPassingEvidence());
    expect(result.activation_protocol_version).toBe('mi.memory.activation/1');
  });

  it('result 携带 ISO 8601 checked_at 时间戳', () => {
    const before = new Date().toISOString();
    const result = canActivateBoundedMemoryEntrypoint(buildPassingEvidence());
    const after = new Date().toISOString();

    expect(result.checked_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u,
    );
    // checked_at 应在 [before, after] 区间
    expect(result.checked_at >= before).toBe(true);
    expect(result.checked_at <= after).toBe(true);
  });

  it('active=true 时 reason_codes 为空数组(非 undefined)', () => {
    const result = canActivateBoundedMemoryEntrypoint(buildPassingEvidence());
    expect(Array.isArray(result.reason_codes)).toBe(true);
    expect(result.reason_codes).toEqual([]);
  });
});

// ===========================================================================
// §3 纯证据验证 — activation 不调用任何 build/cache(side-effect free)
// ===========================================================================

describe('canActivateBoundedMemoryEntrypoint — 纯证据验证', () => {
  it('activation 不依赖外部状态(相同 evidence → 相同 active 结论)', () => {
    const evidence = buildPassingEvidence();
    const r1 = canActivateBoundedMemoryEntrypoint(evidence);
    const r2 = canActivateBoundedMemoryEntrypoint(evidence);

    expect(r1.active).toBe(r2.active);
    expect(r1.reason_codes).toEqual(r2.reason_codes);
  });

  it('evidence 字段是布尔型 — 非布尔值(如 undefined)按 false 处理', () => {
    // 构造一个部分字段缺失的 evidence(cast 通过,模拟外部 dirty input)
    const partialEvidence = {
      catalog_immutable_and_hash_valid: true,
      // 其余字段未提供 → undefined → falsy → 视为 false
    } as unknown as BoundedMemoryActivationEvidence;

    const result = canActivateBoundedMemoryEntrypoint(partialEvidence);
    expect(result.active).toBe(false);
    // 缺失的 11 个门都应进 reason_codes
    expect(result.reason_codes).toHaveLength(11);
  });
});
