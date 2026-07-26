// Wave C Task 13 / M-054: DecisionTraceEvent
//
// 物理本质:验证"确定性 decision subsystem 的可诊断 trace"——
// trace 记录输入 snapshot refs 和结构化结果,不复制完整 input,不记录 reasoning。
// decision ID 必须引用实际 SecurityDecision/policy result。
// error_code 与 result_code 必须是独立字段。
//
// 关键不变量(spec §12.2):
// 1. input_snapshot_refs 存 refs,不存 raw_input
// 2. 不记录 chain-of-thought / reasoning 字段
// 3. 不预建未使用 classifier(只覆盖 6 个已冻结 subsystem)
// 4. decision ID 非空(requireIdentity)
// 5. error_code 与 result_code 独立
// 6. duration / result_code metadata 不能包含用户正文(由 caller 负责,trace 只装原值)

import { describe, expect, it } from 'vitest';
import {
  createDecisionTraceEvent,
  type DecisionTraceEventInput,
  DECISION_TRACE_PROTOCOL_VERSION,
} from '../../agent/observability/decision-trace.js';

const baseInput: DecisionTraceEventInput = {
  decision_id: 'dec-1',
  subsystem: 'permission',
  policy_ref: 'perm-policy:1',
  input_snapshot_refs: ['snap-input-1', 'snap-input-2'],
  result_ref: 'snap-result-1',
  result_code: 'allow',
  error_code: null,
  duration_ms: 12,
  field_policy_ref: 'fp-1:1',
};

describe('M-054 decision trace — happy path', () => {
  it('builds a decision trace event with refs only (no raw_input)', () => {
    const event = createDecisionTraceEvent(baseInput);
    expect(event.decision_trace_protocol_version).toBe(DECISION_TRACE_PROTOCOL_VERSION);
    expect(event.decision_id).toBe('dec-1');
    expect(event.subsystem).toBe('permission');
    expect(event.policy_ref).toBe('perm-policy:1');
    expect(event.input_snapshot_refs).toEqual(['snap-input-1', 'snap-input-2']);
    expect(event.result_ref).toBe('snap-result-1');
    expect(event.result_code).toBe('allow');
    expect(event.error_code).toBeNull();
    expect(event.duration_ms).toBe(12);
    expect(event.field_policy_ref).toBe('fp-1:1');
    // event_id 形如 trace:<16 hex>
    expect(event.event_id).toMatch(/^trace:[0-9a-f]{16}$/);
  });

  it('keeps error_code and result_code as independent fields', () => {
    const event = createDecisionTraceEvent({
      ...baseInput,
      result_code: 'deny',
      error_code: 'permission.rate_limited',
    });
    expect(event.result_code).toBe('deny');
    expect(event.error_code).toBe('permission.rate_limited');
  });

  it('produces a deterministic event_id for identical canonical input', () => {
    const a = createDecisionTraceEvent(baseInput);
    const b = createDecisionTraceEvent({ ...baseInput });
    expect(a.event_id).toBe(b.event_id);
  });

  it('produces different event_id when decision_id differs', () => {
    const a = createDecisionTraceEvent(baseInput);
    const b = createDecisionTraceEvent({ ...baseInput, decision_id: 'dec-2' });
    expect(a.event_id).not.toBe(b.event_id);
  });

  it('freezes the event object', () => {
    const event = createDecisionTraceEvent(baseInput);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.input_snapshot_refs)).toBe(true);
  });
});

describe('M-054 decision trace — input minimization invariants', () => {
  it('does NOT expose a raw_input field (spec §12.2 rule 1)', () => {
    const event = createDecisionTraceEvent(baseInput);
    expect(event).not.toHaveProperty('raw_input');
  });

  it('does NOT expose a reasoning field (spec §12.2 rule 3)', () => {
    const event = createDecisionTraceEvent(baseInput);
    expect(event).not.toHaveProperty('reasoning');
    expect(event).not.toHaveProperty('chain_of_thought');
  });

  it('only stores refs, never copies full input snapshots', () => {
    const event = createDecisionTraceEvent({
      ...baseInput,
      input_snapshot_refs: ['only-the-ref'],
    });
    expect(event.input_snapshot_refs).toEqual(['only-the-ref']);
    // 类型层面没有 raw_input;运行时也确认无多余键
    const keys = Object.keys(event);
    expect(keys).not.toContain('raw_input');
  });
});

describe('M-054 decision trace — subsystem allowlist (no unused classifier)', () => {
  it.each([
    'permission',
    'command_policy',
    'path_policy',
    'environment_policy',
    'delegation_policy',
    'source_router',
  ] as const)('accepts frozen subsystem %s', (subsystem) => {
    const event = createDecisionTraceEvent({ ...baseInput, subsystem });
    expect(event.subsystem).toBe(subsystem);
  });

  it.each(['intent_classifier', 'safety_reviewer', 'capabilities'])(
    'rejects unknown subsystem %s (no speculative classifier)',
    (bad) => {
      expect(() =>
        createDecisionTraceEvent({
          ...baseInput,
          subsystem: bad as DecisionTraceEventInput['subsystem'],
        }),
      ).toThrow();
    },
  );
});

describe('M-054 decision trace — decision_id identity', () => {
  it('throws on empty decision_id (requireIdentity)', () => {
    expect(() =>
      createDecisionTraceEvent({ ...baseInput, decision_id: '' }),
    ).toThrow();
  });

  it('throws on whitespace-only decision_id', () => {
    expect(() =>
      createDecisionTraceEvent({ ...baseInput, decision_id: '   ' }),
    ).toThrow();
  });
});

describe('M-054 decision trace — registry lookup (spec §12.6)', () => {
  it('accepts when registry_lookup returns true', () => {
    const event = createDecisionTraceEvent({
      ...baseInput,
      registry_lookup: () => true,
    });
    expect(event.decision_id).toBe('dec-1');
  });

  it('rejects trace when registry_lookup returns false (unknown decision ID)', () => {
    expect(() =>
      createDecisionTraceEvent({
        ...baseInput,
        registry_lookup: () => false,
      }),
    ).toThrow(/trace\.unknown_decision_id/);
  });

  it('does not call registry_lookup when not provided', () => {
    // 不提供 registry_lookup:仍然成功(纯函数,无副作用)
    const event = createDecisionTraceEvent(baseInput);
    expect(event.decision_id).toBe('dec-1');
  });
});
