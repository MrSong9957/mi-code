/**
 * GRC-1 §7.26 — Activation Gate(canActivatePostCompactReconstruction)测试。
 *
 * Wave G Task 10 (M-049):post-compact reconstruction 的激活闸门。
 * 16 门 AND gate:所有门为 true → active=true;任一为 false → active=false 并
 * 返回对应的 `reconstruction.gate_missing.<field>` reason_code。
 *
 * 不变量:
 *   - Activation 只看 evidence,不调用任何 build/publish/persistence(纯函数)。
 *   - reason_code 直接用 evidence 字段名(语义透明,不脱敏)。
 *   - protocol_version 固定为 'mi.reconstruction.activation/1'。
 *   - checked_at 是 ISO 8601 时间戳。
 *
 * 这一段测试覆盖(规格 Task 10 Step 1):
 *   - 16 门逐门 RED(每门一个测试,单独置 false)
 *   - 全 true → active=true,reason_codes=[]
 *   - 多门 false → reason_codes 包含多个 gate_missing
 *   - activation 不依赖任何 reconstruction build/publish 调用(无 spy 触发)
 */
import { describe, expect, it } from 'vitest';
import {
  canActivatePostCompactReconstruction,
  type PostCompactReconstructionActivationEvidence,
} from '../../agent/context/reconstruction.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 16 门字段名,按 spec §7.26 顺序。
 * 用于 it.each 参数化与 reason_code 构造。
 */
const GATE_FIELDS = [
  'precompact_transcript_immutable',
  'before_compaction_validation_available',
  'compactor_immutable_result_with_shape_validation',
  'current_user_exact_preservable',
  'project_instruction_lifecycle_correlatable',
  'preserve_reload_invalidate_enforced',
  'reload_via_trusted_pipeline',
  'frc1_target_context_rebuild_available',
  'system_prompt_outside_reconstruction',
  'working_set_plane_separated',
  'postflight_tool_validation_available',
  'duplicate_order_budget_validators_available',
  'atomic_publish_rollback_available',
  'transaction_idempotency_recovery_persistable',
  'completed_tool_no_reexecution',
  'deterministic_failure_recovery_evidence',
] as const satisfies ReadonlyArray<
  keyof PostCompactReconstructionActivationEvidence
>;

/**
 * 全部 16 门为 true 的 evidence(基线)。
 * 单门测试通过 spread + 单字段覆盖来构造 "其余 true, 一门 false"。
 */
function allTrueEvidence(): PostCompactReconstructionActivationEvidence {
  return {
    precompact_transcript_immutable: true,
    before_compaction_validation_available: true,
    compactor_immutable_result_with_shape_validation: true,
    current_user_exact_preservable: true,
    project_instruction_lifecycle_correlatable: true,
    preserve_reload_invalidate_enforced: true,
    reload_via_trusted_pipeline: true,
    frc1_target_context_rebuild_available: true,
    system_prompt_outside_reconstruction: true,
    working_set_plane_separated: true,
    postflight_tool_validation_available: true,
    duplicate_order_budget_validators_available: true,
    atomic_publish_rollback_available: true,
    transaction_idempotency_recovery_persistable: true,
    completed_tool_no_reexecution: true,
    deterministic_failure_recovery_evidence: true,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GRC-1 §7.26 canActivatePostCompactReconstruction — 16 门 AND gate', () => {
  describe('全门为 true', () => {
    it('active=true 且 reason_codes 为空', () => {
      const result = canActivatePostCompactReconstruction(allTrueEvidence());
      expect(result.active).toBe(true);
      expect(result.reason_codes).toEqual([]);
    });

    it('返回固定的 activation protocol version', () => {
      const result = canActivatePostCompactReconstruction(allTrueEvidence());
      expect(result.activation_protocol_version).toBe(
        'mi.reconstruction.activation/1',
      );
    });

    it('checked_at 是合法的 ISO 8601 时间戳', () => {
      const result = canActivatePostCompactReconstruction(allTrueEvidence());
      const parsed = new Date(result.checked_at);
      expect(parsed.toString()).not.toBe('Invalid Date');
      // ISO 8601 解析回字符串应能复现(允许毫秒精度差异)
      expect(parsed.toISOString()).toBe(result.checked_at);
    });
  });

  describe('16 门逐门 RED(单门 false 其余 true → active=false)', () => {
    // 参数化:对每个字段,构造一个 "只有该字段 false" 的 evidence,
    // 期望 active=false 且 reason_codes 恰好包含
    // `reconstruction.gate_missing.<field>`。
    it.each(GATE_FIELDS)(
      '门 %s 为 false 时 → active=false, reason_codes 含该门',
      (field) => {
        const evidence = { ...allTrueEvidence(), [field]: false };
        const result = canActivatePostCompactReconstruction(evidence);
        expect(result.active).toBe(false);
        expect(result.reason_codes).toContain(
          `reconstruction.gate_missing.${field}`,
        );
      },
    );

    it.each(GATE_FIELDS)(
      '门 %s 为 false 时 → reason_codes 只含这一个 gate_missing(单门场景)',
      (field) => {
        const evidence = { ...allTrueEvidence(), [field]: false };
        const result = canActivatePostCompactReconstruction(evidence);
        // 单门 false 时 reason_codes 应恰好是 1 个,内容为该门的 gate_missing
        expect(result.reason_codes).toHaveLength(1);
        expect(result.reason_codes[0]).toBe(
          `reconstruction.gate_missing.${field}`,
        );
      },
    );
  });

  describe('多门为 false', () => {
    it('两门 false → reason_codes 包含两个 gate_missing', () => {
      const evidence: PostCompactReconstructionActivationEvidence = {
        ...allTrueEvidence(),
        precompact_transcript_immutable: false,
        system_prompt_outside_reconstruction: false,
      };
      const result = canActivatePostCompactReconstruction(evidence);
      expect(result.active).toBe(false);
      expect(result.reason_codes).toEqual(
        expect.arrayContaining([
          'reconstruction.gate_missing.precompact_transcript_immutable',
          'reconstruction.gate_missing.system_prompt_outside_reconstruction',
        ]),
      );
      expect(result.reason_codes).toHaveLength(2);
    });

    it('全部门 false → reason_codes 含 16 个 gate_missing', () => {
      const evidence: PostCompactReconstructionActivationEvidence = Object.fromEntries(
        GATE_FIELDS.map((f) => [f, false]),
      ) as unknown as PostCompactReconstructionActivationEvidence;
      const result = canActivatePostCompactReconstruction(evidence);
      expect(result.active).toBe(false);
      expect(result.reason_codes).toHaveLength(16);
      for (const field of GATE_FIELDS) {
        expect(result.reason_codes).toContain(
          `reconstruction.gate_missing.${field}`,
        );
      }
    });
  });

  describe('纯函数性 — activation 不触发任何 build/publish', () => {
    it('即使 evidence 全 true,也不应抛错(纯计算,无 IO)', () => {
      expect(() =>
        canActivatePostCompactReconstruction(allTrueEvidence()),
      ).not.toThrow();
    });

    it('对相同 evidence 多次调用 → 相同 active/reason_codes(checked_at 除外)', () => {
      const evidence = allTrueEvidence();
      const r1 = canActivatePostCompactReconstruction(evidence);
      const r2 = canActivatePostCompactReconstruction(evidence);
      expect(r1.active).toBe(r2.active);
      expect(r1.reason_codes).toEqual(r2.reason_codes);
      expect(r1.activation_protocol_version).toBe(
        r2.activation_protocol_version,
      );
    });

    it('混合 false 时 reason_codes 顺序应按 evidence 字段定义顺序', () => {
      // 第 2 项与第 15 项 false(在 evidence 字段定义里 2 在 15 之前)
      const evidence: PostCompactReconstructionActivationEvidence = {
        ...allTrueEvidence(),
        completed_tool_no_reexecution: false, // 第 15 门
        before_compaction_validation_available: false, // 第 2 门
      };
      const result = canActivatePostCompactReconstruction(evidence);
      // 顺序:按 evidence 字段定义顺序迭代
      expect(result.reason_codes).toEqual([
        'reconstruction.gate_missing.before_compaction_validation_available',
        'reconstruction.gate_missing.completed_tool_no_reexecution',
      ]);
    });
  });

  describe('reason_codes 命名约定', () => {
    it('所有 reason_code 都以 reconstruction.gate_missing. 前缀开头', () => {
      const evidence: PostCompactReconstructionActivationEvidence = {
        ...allTrueEvidence(),
        atomic_publish_rollback_available: false,
      };
      const result = canActivatePostCompactReconstruction(evidence);
      for (const code of result.reason_codes) {
        expect(code.startsWith('reconstruction.gate_missing.')).toBe(true);
      }
    });
  });
});
