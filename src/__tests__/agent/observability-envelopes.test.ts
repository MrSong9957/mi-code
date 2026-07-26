// Wave B Task 14 / M-051: Observability Plane Envelopes
//
// 物理本质:验证"信封分拣台"——所有可观测事件必须先装进信封(Envelope),
// 由分拣台根据 plane(投递通道)和 policies(通道开关)决定是"投递(emitted)"
// 还是"丢弃(dropped)"。Wave B 阶段 production_telemetry / full_request_dump
// 两个通道被硬编码关闭,无论 policy 怎么说都不投递。
//
// 关键不变量:
// 1. 信封只携带 payload_ref(引用),不携带 payload 内容本身——分拣台不读信。
// 2. decision_trace 通道在 Wave B 没有 schema,payload_ref 强制为 null。
// 3. 投递出的信封被深冻结(不可篡改)。
// 4. 身份字段(event_id 等)为空时直接抛错——这是身份校验,不是准入决定。
// 5. StreamEventBus 只是"邮筒",不会自己造信,也不会从其它通道自动抄送。

import { describe, expect, it } from 'vitest';
import {
  createObservabilityEnvelope,
  canEnterPlane,
  type ObservabilityPlanePolicies,
} from '../../agent/observability/envelopes.js';
import { StreamEventBus } from '../../agent/stream-event-bus.js';

const baseEvent = {
  observability_protocol_version: '1',
  event_id: 'evt-1',
  event_type: 'tool.pair_validated',
  plane: 'local_debug' as const,
  occurred_at: '2026-07-26T00:00:00.000Z',
  session_ref: 'sess-1',
  request_snapshot_ref: 'req-1',
  component_ref: 'streaming-query',
  payload_schema_id: 'schema:none',
  sensitivity: 'low' as const,
  redaction_state: 'not_required' as const,
  payload_ref: null,
};

const disabledPolicies: ObservabilityPlanePolicies = {
  local_debug: { enabled: false },
  full_request_dump: { enabled: false },
  decision_trace: { enabled: false },
  production_telemetry: { enabled: false },
};

const enabledPolicies: ObservabilityPlanePolicies = {
  local_debug: { enabled: true },
  full_request_dump: { enabled: true },
  decision_trace: { enabled: true },
  production_telemetry: { enabled: true },
};

describe('M-051 observability envelopes — admission rules', () => {
  it.each([
    ['production_telemetry', 'pending'],
    ['production_telemetry', 'dropped'],
    ['full_request_dump', 'not_required'],
  ] as const)(
    'does not create a sendable %s event with %s redaction',
    (plane, redaction) => {
      const result = createObservabilityEnvelope(
        { ...baseEvent, plane, redaction_state: redaction },
        disabledPolicies,
      );
      expect(result.status).toBe('dropped');
      expect(result.envelope).toBeNull();
    },
  );

  it('emits local_debug when enabled with low sensitivity and not_required redaction', () => {
    const result = createObservabilityEnvelope(
      { ...baseEvent, plane: 'local_debug' },
      enabledPolicies,
    );
    expect(result.status).toBe('emitted');
    expect(result.envelope).not.toBeNull();
    expect(result.envelope!.plane).toBe('local_debug');
    expect(result.drop_reason_code).toBeNull();
  });

  it('drops local_debug when policy disabled with plane.disabled', () => {
    const result = createObservabilityEnvelope(
      { ...baseEvent, plane: 'local_debug' },
      disabledPolicies,
    );
    expect(result.status).toBe('dropped');
    expect(result.envelope).toBeNull();
    expect(result.drop_reason_code).toBe('plane.disabled');
  });

  it('drops production_telemetry with wave_b_production even if policy says enabled', () => {
    const result = createObservabilityEnvelope(
      { ...baseEvent, plane: 'production_telemetry' },
      enabledPolicies,
    );
    expect(result.status).toBe('dropped');
    expect(result.envelope).toBeNull();
    expect(result.drop_reason_code).toBe('plane.disabled.wave_b_production');
  });

  it('drops full_request_dump with wave_b_full_dump even if policy says enabled', () => {
    const result = createObservabilityEnvelope(
      { ...baseEvent, plane: 'full_request_dump' },
      enabledPolicies,
    );
    expect(result.status).toBe('dropped');
    expect(result.envelope).toBeNull();
    expect(result.drop_reason_code).toBe('plane.disabled.wave_b_full_dump');
  });

  it('emits decision_trace when enabled but forces payload_ref to null (no schema)', () => {
    const result = createObservabilityEnvelope(
      { ...baseEvent, plane: 'decision_trace', payload_ref: 'something' },
      enabledPolicies,
    );
    expect(result.status).toBe('emitted');
    expect(result.envelope).not.toBeNull();
    expect(result.envelope!.plane).toBe('decision_trace');
    expect(result.envelope!.payload_ref).toBeNull();
  });

  it('drops decision_trace when policy disabled', () => {
    const result = createObservabilityEnvelope(
      { ...baseEvent, plane: 'decision_trace' },
      disabledPolicies,
    );
    expect(result.status).toBe('dropped');
    expect(result.envelope).toBeNull();
    expect(result.drop_reason_code).toBe('plane.disabled');
  });

  it('drops unknown plane smuggled via as any with plane.unknown', () => {
    const result = createObservabilityEnvelope(
      { ...baseEvent, plane: 'secret_plane' as any },
      enabledPolicies,
    );
    expect(result.status).toBe('dropped');
    expect(result.envelope).toBeNull();
    expect(result.drop_reason_code).toBe('plane.unknown');
  });

  it('drops otherwise-emittable local_debug when redaction_state is pending', () => {
    const result = createObservabilityEnvelope(
      { ...baseEvent, plane: 'local_debug', redaction_state: 'pending' },
      enabledPolicies,
    );
    expect(result.status).toBe('dropped');
    expect(result.drop_reason_code).toBe('redaction.pending');
  });

  it('drops otherwise-emittable local_debug when redaction_state is dropped', () => {
    const result = createObservabilityEnvelope(
      { ...baseEvent, plane: 'local_debug', redaction_state: 'dropped' },
      enabledPolicies,
    );
    expect(result.status).toBe('dropped');
    expect(result.drop_reason_code).toBe('redaction.dropped');
  });

  it('emits local_debug when redaction_state is redacted', () => {
    const result = createObservabilityEnvelope(
      { ...baseEvent, plane: 'local_debug', redaction_state: 'redacted' },
      enabledPolicies,
    );
    expect(result.status).toBe('emitted');
    expect(result.envelope).not.toBeNull();
  });

  it.each([
    ['event_id'],
    ['event_type'],
    ['component_ref'],
    ['occurred_at'],
    ['payload_schema_id'],
  ] as const)('throws when identity field %s is empty (requireIdentity)', (field) => {
    expect(() =>
      createObservabilityEnvelope(
        { ...baseEvent, [field]: '' } as typeof baseEvent,
        enabledPolicies,
      ),
    ).toThrow();
  });

  it('freezes the emitted envelope', () => {
    const result = createObservabilityEnvelope(
      { ...baseEvent, plane: 'local_debug' },
      enabledPolicies,
    );
    expect(result.status).toBe('emitted');
    expect(result.envelope).not.toBeNull();
    expect(Object.isFrozen(result.envelope)).toBe(true);
  });
});

describe('M-051 observability envelopes — canEnterPlane', () => {
  it('returns true for local_debug + low + not_required under enabled policy', () => {
    expect(canEnterPlane('local_debug', 'low', 'not_required', enabledPolicies)).toBe(true);
  });

  it('returns false for local_debug under disabled policy', () => {
    expect(canEnterPlane('local_debug', 'low', 'not_required', disabledPolicies)).toBe(false);
  });

  it('returns false for production_telemetry in Wave B regardless of policy', () => {
    expect(canEnterPlane('production_telemetry', 'low', 'not_required', enabledPolicies)).toBe(false);
  });

  it('returns false for full_request_dump in Wave B regardless of policy', () => {
    expect(canEnterPlane('full_request_dump', 'low', 'not_required', enabledPolicies)).toBe(false);
  });

  it('returns true for decision_trace under enabled policy', () => {
    expect(canEnterPlane('decision_trace', 'low', 'not_required', enabledPolicies)).toBe(true);
  });

  it('returns false for pending redaction', () => {
    expect(canEnterPlane('local_debug', 'low', 'pending', enabledPolicies)).toBe(false);
  });

  it('returns false for dropped redaction', () => {
    expect(canEnterPlane('local_debug', 'low', 'dropped', enabledPolicies)).toBe(false);
  });
});

describe('M-051 observability envelopes — StreamEventBus integration', () => {
  it('delivers an envelope emitted via emitObservabilityEvent to onObservabilityEvent handler', () => {
    const bus = new StreamEventBus();
    const received: unknown[] = [];
    const handler = (env: unknown) => {
      received.push(env);
    };
    bus.onObservabilityEvent(handler);

    const envelope = {
      observability_protocol_version: '1',
      event_id: 'evt-bus-1',
      event_type: 'tool.pair_validated',
      plane: 'local_debug',
      occurred_at: '2026-07-26T00:00:00.000Z',
      session_ref: 'sess-1',
      request_snapshot_ref: 'req-1',
      component_ref: 'streaming-query',
      payload_schema_id: 'schema:none',
      sensitivity: 'low',
      redaction_state: 'not_required',
      payload_ref: null,
    } as const;
    bus.emitObservabilityEvent(envelope);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(envelope);
  });

  it('stops delivering after offObservabilityEvent', () => {
    const bus = new StreamEventBus();
    const received: unknown[] = [];
    const handler = (env: unknown) => {
      received.push(env);
    };
    bus.onObservabilityEvent(handler);
    bus.offObservabilityEvent(handler);

    bus.emitObservabilityEvent({
      observability_protocol_version: '1',
      event_id: 'evt-bus-2',
      event_type: 'tool.pair_validated',
      plane: 'local_debug',
      occurred_at: '2026-07-26T00:00:00.000Z',
      session_ref: null,
      request_snapshot_ref: null,
      component_ref: 'streaming-query',
      payload_schema_id: 'schema:none',
      sensitivity: 'low',
      redaction_state: 'not_required',
      payload_ref: null,
    });
    expect(received).toHaveLength(0);
  });

  it('still allows existing emitToolCall to fire without throwing', () => {
    const bus = new StreamEventBus();
    expect(() =>
      bus.emitToolCall({
        toolUseId: 'tu-1',
        name: 'bash',
        input: {},
        startTime: 0,
      }),
    ).not.toThrow();
  });

  it('does NOT auto-capture: emitToolCall does not trigger observability handler', () => {
    const bus = new StreamEventBus();
    const received: unknown[] = [];
    bus.onObservabilityEvent((env) => {
      received.push(env);
    });

    bus.emitToolCall({
      toolUseId: 'tu-1',
      name: 'bash',
      input: {},
      startTime: 0,
    });
    bus.emitAssistantMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
    } as any);

    expect(received).toHaveLength(0);
  });
});
