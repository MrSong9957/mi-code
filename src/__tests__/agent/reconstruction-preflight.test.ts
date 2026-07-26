/**
 * GRC-1 §7.4 — Post-Compact Reconstruction Preflight Gate (Wave G Task 3).
 *
 * Preflight 是压缩前的硬门:在调用任何 compactor 之前,对 capture(precompact)
 * + transcript validation + durable ack + policy + budget + idempotency key
 * 做一次性结构校验。任一条件失败立即短路返回 blocked/rejected,绝不调用
 * compactor。
 *
 * Non-negotiable invariants under test:
 *   - 10 项检查按顺序短路;任一失败立即返回。
 *   - accepted 时 reason_codes=[];blocked/rejected 时 reason_codes 非空。
 *   - preflight 不调用 compactor(测试中不注入任何 compactor)。
 *   - preflight_id 由 (precompact_snapshot_id + transcript_snapshot_id +
 *     validation_id + idempotency_key) 的 sha256 截短决定,带 'pre:' 前缀。
 *   - 相同 input 产生相同 preflight_id(deterministic)。
 */
import { describe, expect, it } from 'vitest';
import {
  capturePreCompactSnapshot,
  createReconstructionPolicy,
  runReconstructionPreflight,
  type PreflightInput,
} from '../../agent/context/reconstruction.js';
import type {
  ToolTranscriptValidation,
  ToolTranscriptSnapshot,
  ToolPairRecord,
  ToolPairState,
} from '../../agent/tools/transcript-validator.js';
import type { Message } from '../../agent/types.js';
import type { DurableAcknowledgement } from '../../session/store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function policyIdentity() {
  return {
    policy_id: 'mi.reconstruction.policy:default',
    policy_version: '1.0.0',
    request_budget_policy_ref: 'mi.budget/1:default',
  };
}

function captureInput() {
  return {
    session_id: 'sess:abc',
    turn_id: 'turn:1',
    task_snapshot_id: 'task:snap-1',
    current_context_snapshot_id: 'ctx:before-compact',
    project_version_ref: 'proj:sha-1',
    transcript_snapshot_id: 'tx:snap-1',
    current_user_message_ref: 'msg:user-1',
    current_user_message_hash: '0'.repeat(64),
    active_project_activation_refs: ['act:proj-a', 'act:proj-b'],
    active_meta_lifecycle_refs: ['life:meta-a'],
    memory_entrypoint_snapshot_ref: 'entry:mem-1',
    execution_state_refs: ['exec:state-1'],
    request_budget_snapshot_id: 'budget:snap-1',
    captured_at: '2026-07-26T00:00:00.000Z',
  };
}

function pairRecord(state: ToolPairState, tool_call_id = 'tc-1'): ToolPairRecord {
  return {
    session_id: 'sess:abc',
    turn_id: 'turn:1',
    tool_id: 'bash',
    tool_call_id,
    tool_use_message_ref: 'msg@1',
    tool_result_message_ref: state === 'paired' ? 'msg@2' : null,
    state,
    execution_state_ref: null,
  };
}

function transcriptSnapshot(): ToolTranscriptSnapshot {
  const messages: Message[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ];
  return {
    transcript_snapshot_id: 'tx:snap-1',
    session_id: 'sess:abc',
    turn_id: 'turn:1',
    messages,
  };
}

function validation(
  overrides: Partial<ToolTranscriptValidation> = {},
): ToolTranscriptValidation {
  return {
    validation_protocol_version: '1',
    validation_id: 'tv:preflight-1',
    transcript_snapshot_id: 'tx:snap-1',
    checkpoint: 'before_compaction',
    status: 'accepted',
    validator_policy_id: 'mi.transcript.policy:default',
    validator_policy_version: '1.0.0',
    pair_records: [],
    reason_codes: [],
    ...overrides,
  };
}

function durableAck(
  overrides: Partial<DurableAcknowledgement> = {},
): DurableAcknowledgement {
  return {
    ack_protocol_version: 'mi.durable/1',
    ack_id: 'durable:abc',
    record_id: 'precompact:xyz',
    session_id: 'sess:abc',
    committed_at: '2026-07-26T00:00:00.000Z',
    sidecar_ref: 'reconstruction.jsonl',
    ...overrides,
  };
}

const IDEMPOTENCY_KEY = 'recon-idem:deadbeef';

/**
 * 构造一份"全绿"的 preflight input。各项测试通过覆盖单项字段来触发失败。
 */
function acceptedInput(): PreflightInput {
  return {
    precompact: capturePreCompactSnapshot(captureInput()),
    transcript_snapshot: transcriptSnapshot(),
    validation: validation(),
    precompact_durable_ack: durableAck(),
    policy: createReconstructionPolicy(policyIdentity()),
    request_budget_snapshot_id: 'budget:snap-1',
    idempotency_key: IDEMPOTENCY_KEY,
  };
}

// ===========================================================================
// runReconstructionPreflight — accepted path
// ===========================================================================

describe('runReconstructionPreflight — accepted path (spec §7.4)', () => {
  it('returns accepted with empty reason_codes when all 10 checks pass', () => {
    const result = runReconstructionPreflight(acceptedInput());
    expect(result.status).toBe('accepted');
    expect(result.reason_codes).toEqual([]);
    expect(result.preflight_protocol_version).toBe('mi.preflight/1');
    expect(result.preflight_id).toMatch(/^pre:[0-9a-f]{16}$/);
    expect(result.precompact_snapshot_id).toBe(
      acceptedInput().precompact.precompact_snapshot_id,
    );
    expect(result.transcript_snapshot_id).toBe('tx:snap-1');
    expect(result.validation_id).toBe('tv:preflight-1');
    expect(result.idempotency_key).toBe(IDEMPOTENCY_KEY);
    expect(typeof result.checked_at).toBe('string');
    expect(result.checked_at.length).toBeGreaterThan(0);
  });

  it('does NOT call any compactor (no compactor is injected)', () => {
    // 此测试通过不注入任何 compactor deps 来验证 preflight 独立工作。
    // deps 参数为空,函数必须能完成所有判断。
    const result = runReconstructionPreflight(acceptedInput(), {});
    expect(result.status).toBe('accepted');
  });

  it('is deterministic: same input produces same preflight_id (modulo checked_at)', () => {
    const a = runReconstructionPreflight(acceptedInput());
    const b = runReconstructionPreflight(acceptedInput());
    expect(a.preflight_id).toBe(b.preflight_id);
    // checked_at 是运行时时间戳,允许不同,但其它字段必须确定性
    expect(a.status).toBe(b.status);
    expect(a.reason_codes).toEqual(b.reason_codes);
  });
});

// ===========================================================================
// Short-circuit checks (10 items, in order)
// ===========================================================================

describe('runReconstructionPreflight — short-circuit checks (spec §7.4)', () => {
  // 1. checkpoint 必须是 'before_compaction'
  it('1: rejects when validation.checkpoint != before_compaction', () => {
    const input = acceptedInput();
    input.validation = input.validation = validation({
      checkpoint: 'before_provider_send',
    });
    const result = runReconstructionPreflight(input);
    expect(result.status).toBe('rejected');
    expect(result.reason_codes).toContain('preflight.wrong_checkpoint');
  });

  // 2. validation.status 必须 accepted;否则转发状态
  it('2a: forwards blocked status when validation.status=blocked', () => {
    const input = acceptedInput();
    input.validation = validation({
      status: 'blocked',
      pair_records: [pairRecord('pending_execution')],
      reason_codes: ['pair.pending_execution:tc-1'],
    });
    const result = runReconstructionPreflight(input);
    expect(result.status).toBe('blocked');
    // reason_codes 转发(允许附加 preflight 自身 code)
    expect(result.reason_codes.length).toBeGreaterThan(0);
  });

  it('2b: forwards rejected status when validation.status=rejected', () => {
    const input = acceptedInput();
    input.validation = validation({
      status: 'rejected',
      pair_records: [pairRecord('missing_result')],
      reason_codes: ['pair.missing_result:tc-1'],
    });
    const result = runReconstructionPreflight(input);
    expect(result.status).toBe('rejected');
    expect(result.reason_codes.length).toBeGreaterThan(0);
  });

  // 3. transcript_snapshot_id 必须一致
  it('3: rejects when transcript_snapshot_id mismatch', () => {
    const input = acceptedInput();
    input.validation = validation({ transcript_snapshot_id: 'tx:different' });
    const result = runReconstructionPreflight(input);
    expect(result.status).toBe('rejected');
    expect(result.reason_codes).toContain('preflight.transcript_mismatch');
  });

  // 4. 不允许 pending_execution
  it('4: blocks when pair_records contains pending_execution', () => {
    const input = acceptedInput();
    input.validation = validation({
      pair_records: [pairRecord('pending_execution')],
    });
    const result = runReconstructionPreflight(input);
    expect(result.status).toBe('blocked');
    expect(result.reason_codes).toContain('preflight.pending_execution');
  });

  // 5. 不允许 missing/orphan/duplicate/identity_conflict
  it('5a: rejects when pair_records contains missing_result', () => {
    const input = acceptedInput();
    input.validation = validation({ pair_records: [pairRecord('missing_result')] });
    const result = runReconstructionPreflight(input);
    expect(result.status).toBe('rejected');
    expect(result.reason_codes).toContain('preflight.missing_result');
  });

  it('5b: rejects when pair_records contains orphan_result', () => {
    const input = acceptedInput();
    input.validation = validation({ pair_records: [pairRecord('orphan_result')] });
    const result = runReconstructionPreflight(input);
    expect(result.status).toBe('rejected');
    expect(result.reason_codes).toContain('preflight.orphan_result');
  });

  it('5c: rejects when pair_records contains duplicate_result', () => {
    const input = acceptedInput();
    input.validation = validation({ pair_records: [pairRecord('duplicate_result')] });
    const result = runReconstructionPreflight(input);
    expect(result.status).toBe('rejected');
    expect(result.reason_codes).toContain('preflight.duplicate_result');
  });

  it('5d: rejects when pair_records contains identity_conflict', () => {
    const input = acceptedInput();
    input.validation = validation({ pair_records: [pairRecord('identity_conflict')] });
    const result = runReconstructionPreflight(input);
    expect(result.status).toBe('rejected');
    expect(result.reason_codes).toContain('preflight.identity_conflict');
  });

  // 6. current_user_message_ref / current_user_message_hash 必须非空
  it('6: rejects when precompact.current_user_message_ref is empty', () => {
    // capturePreCompactSnapshot 会抛错拒绝空字段,因此手工构造一个 bypass
    // 的 precompact(模拟 capture 时合法、之后被破坏的情况)。
    const base = acceptedInput();
    // Object.assign 维持其它字段;故意把 current_user_message_ref 改空。
    const tamperedPrecompact = {
      ...base.precompact,
      current_user_message_ref: '',
    } as typeof base.precompact;
    const input: PreflightInput = { ...base, precompact: tamperedPrecompact };
    const result = runReconstructionPreflight(input);
    expect(result.status).toBe('rejected');
    expect(result.reason_codes).toContain('preflight.current_user_missing');
  });

  // 7. system prompt 不在 reconstruction 范围内 —— 等同通过,无需测试(规格说明)。

  // 8. policy + request_budget_snapshot_id 可用
  it('8a: rejects when policy is missing (null)', () => {
    const base = acceptedInput();
    // 通过 cast 绕过 TS,preflight 必须在运行时检测到 null
    const input = { ...base, policy: null as unknown as typeof base.policy };
    const result = runReconstructionPreflight(input);
    expect(result.status).toBe('rejected');
    expect(result.reason_codes).toContain('preflight.policy_or_budget_missing');
  });

  it('8b: rejects when request_budget_snapshot_id is empty', () => {
    const base = acceptedInput();
    const input: PreflightInput = { ...base, request_budget_snapshot_id: '' };
    const result = runReconstructionPreflight(input);
    expect(result.status).toBe('rejected');
    expect(result.reason_codes).toContain('preflight.policy_or_budget_missing');
  });

  // 9. idempotency_key 可建立
  it('9: rejects when idempotency_key is empty', () => {
    const base = acceptedInput();
    const input: PreflightInput = { ...base, idempotency_key: '' };
    const result = runReconstructionPreflight(input);
    expect(result.status).toBe('rejected');
    expect(result.reason_codes).toContain('preflight.idempotency_missing');
  });

  // 10. precompact_durable_ack 非空
  it('10: rejects when precompact_durable_ack is null', () => {
    const base = acceptedInput();
    const input = {
      ...base,
      precompact_durable_ack: null as unknown as typeof base.precompact_durable_ack,
    };
    const result = runReconstructionPreflight(input);
    expect(result.status).toBe('rejected');
    expect(result.reason_codes).toContain('preflight.durable_ack_missing');
  });
});

// ===========================================================================
// Determinism of preflight_id
// ===========================================================================

describe('runReconstructionPreflight — preflight_id derivation', () => {
  it('changes when precompact_snapshot_id changes', () => {
    const base = runReconstructionPreflight(acceptedInput());
    const other = acceptedInput();
    other.precompact = capturePreCompactSnapshot({
      ...captureInput(),
      // 改一个会影响 precompact_snapshot_id 的字段
      current_user_message_ref: 'msg:user-2',
    });
    const otherResult = runReconstructionPreflight(other);
    expect(otherResult.preflight_id).not.toBe(base.preflight_id);
  });

  it('changes when idempotency_key changes', () => {
    const base = runReconstructionPreflight(acceptedInput());
    const other = acceptedInput();
    other.idempotency_key = 'recon-idem:feedface';
    const otherResult = runReconstructionPreflight(other);
    expect(otherResult.preflight_id).not.toBe(base.preflight_id);
  });
});
