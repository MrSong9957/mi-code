// Wave D Task 10 / M-055: Component Measurements
//
// 物理本质:验证"可归因、可比较、默认不含正文的组件级 telemetry event 构建器"。
// - estimator 与 Provider usage 必须在分离的 kind/scope/method 中(INV-D12, §10.6 rule 3/4)
// - component identity 缺失 / field_policy_ref / redaction_result_ref 缺失 / 数值非法 / hash 缺失 → drop event
// - measurement method/version 缺失或 scope/kind 不一致 → drop measurement(不是 event)
// - 默认 metadata-only:不含 prompt body / tool description body / user content / source code / path / credential
// - hash 仅用于漂移检测,不等于匿名化
//
// 纯函数:不读全局、不写 sink、不修改传入 input。

import { describe, expect, it } from 'vitest';
import {
  measureTelemetryComponent,
  COMPONENT_TELEMETRY_PROTOCOL_VERSION,
  type ComponentTelemetryEventInput,
  type TokenMeasurement,
} from '../../agent/observability/telemetry.js';

// ---------- 测试辅助 ----------

const baseComponentRef = {
  component_kind: 'prompt_section' as const,
  component_id: 'sys-memory-1',
  component_version: '2',
  source_snapshot_id: 'snap-src-1',
};

const estimatorMeasurement = (value: number): TokenMeasurement => ({
  measurement_kind: 'estimated_component_tokens',
  value,
  scope: 'component',
  method_id: 'tok-bpe-v1',
  method_version: '1',
  provider_id: null,
  model_id: 'anthropic:claude-3.5',
});

const providerInputMeasurement = (value: number): TokenMeasurement => ({
  measurement_kind: 'provider_reported_input_tokens',
  value,
  scope: 'request',
  method_id: 'provider-usage',
  method_version: '1',
  provider_id: 'anthropic',
  model_id: 'claude-3.5',
});

const providerOutputMeasurement = (value: number): TokenMeasurement => ({
  measurement_kind: 'provider_reported_output_tokens',
  value,
  scope: 'response',
  method_id: 'provider-usage',
  method_version: '1',
  provider_id: 'anthropic',
  model_id: 'claude-3.5',
});

/** 构造合法 baseline input,允许局部覆盖。 */
const componentInput = (
  overrides: Partial<ComponentTelemetryEventInput> = {},
): ComponentTelemetryEventInput => ({
  component_telemetry_protocol_version: COMPONENT_TELEMETRY_PROTOCOL_VERSION,
  request_snapshot_id: 'snap-req-1',
  component_ref: { ...baseComponentRef },
  profile_ref: 'prof-1:1',
  variant_ref: 'var-1:1',
  included: true,
  inclusion_reason_code: 'in_scope',
  byte_count: 128,
  character_count: 96,
  content_hash: 'deadbeef'.repeat(8),
  token_measurements: [estimatorMeasurement(120)],
  field_policy_ref: 'fp-1:1',
  redaction_result_ref: 'red:abc123',
  ...overrides,
});

// ---------- happy path ----------

describe('M-055 component telemetry — happy path', () => {
  it('builds an event with all fields propagated and event_id of form ct:<16 hex>', () => {
    const event = measureTelemetryComponent(componentInput());
    if ('dropped' in event) throw new Error('should not drop');
    expect(event.component_telemetry_protocol_version).toBe(COMPONENT_TELEMETRY_PROTOCOL_VERSION);
    expect(event.request_snapshot_id).toBe('snap-req-1');
    expect(event.component_ref.component_id).toBe('sys-memory-1');
    expect(event.included).toBe(true);
    expect(event.inclusion_reason_code).toBe('in_scope');
    expect(event.byte_count).toBe(128);
    expect(event.character_count).toBe(96);
    expect(event.content_hash).toBe('deadbeef'.repeat(8));
    expect(event.field_policy_ref).toBe('fp-1:1');
    expect(event.redaction_result_ref).toBe('red:abc123');
    expect(event.event_id).toMatch(/^ct:[0-9a-f]{16}$/);
  });

  it('keeps estimator and provider usage in different kinds and scopes (INV-D12)', () => {
    const event = measureTelemetryComponent(
      componentInput({
        token_measurements: [
          estimatorMeasurement(120),
          providerInputMeasurement(900),
          providerOutputMeasurement(150),
        ],
      }),
    );
    if ('dropped' in event) throw new Error('should not drop');
    expect(event.token_measurements).toContainEqual(
      expect.objectContaining({
        measurement_kind: 'estimated_component_tokens',
        scope: 'component',
        provider_id: null,
      }),
    );
    expect(event.token_measurements).toContainEqual(
      expect.objectContaining({
        measurement_kind: 'provider_reported_input_tokens',
        scope: 'request',
        provider_id: 'anthropic',
      }),
    );
    expect(event.token_measurements).toContainEqual(
      expect.objectContaining({
        measurement_kind: 'provider_reported_output_tokens',
        scope: 'response',
      }),
    );
  });
});

// ---------- event-level drops ----------

describe('M-055 component telemetry — event-level drops (spec §10.8)', () => {
  it('drops event when component_id missing', () => {
    const event = measureTelemetryComponent(
      componentInput({
        component_ref: { ...baseComponentRef, component_id: '' },
      }),
    );
    expect(event.dropped).toBe(true);
    if (!('dropped' in event)) throw new Error('expected dropped');
    expect(event.reason_codes).toContain('telemetry.missing_component_identity');
  });

  it('drops event when component_version missing', () => {
    const event = measureTelemetryComponent(
      componentInput({
        component_ref: { ...baseComponentRef, component_version: '  ' },
      }),
    );
    expect(event.dropped).toBe(true);
    if (!('dropped' in event)) throw new Error('expected dropped');
    expect(event.reason_codes).toContain('telemetry.missing_component_identity');
  });

  it('drops event when source_snapshot_id missing', () => {
    const event = measureTelemetryComponent(
      componentInput({
        component_ref: { ...baseComponentRef, source_snapshot_id: '' },
      }),
    );
    expect(event.dropped).toBe(true);
    if (!('dropped' in event)) throw new Error('expected dropped');
    expect(event.reason_codes).toContain('telemetry.missing_component_identity');
  });

  it('drops event when byte_count is negative', () => {
    const event = measureTelemetryComponent(componentInput({ byte_count: -1 }));
    expect(event.dropped).toBe(true);
    if (!('dropped' in event)) throw new Error('expected dropped');
    expect(event.reason_codes).toContain('telemetry.invalid_byte_count');
  });

  it('drops event when byte_count is NaN', () => {
    const event = measureTelemetryComponent(componentInput({ byte_count: Number.NaN }));
    expect(event.dropped).toBe(true);
    if (!('dropped' in event)) throw new Error('expected dropped');
    expect(event.reason_codes).toContain('telemetry.invalid_byte_count');
  });

  it('drops event when character_count is non-integer', () => {
    const event = measureTelemetryComponent(componentInput({ character_count: 1.5 }));
    expect(event.dropped).toBe(true);
    if (!('dropped' in event)) throw new Error('expected dropped');
    expect(event.reason_codes).toContain('telemetry.invalid_character_count');
  });

  it('drops event when content_hash missing (no empty hash smuggle)', () => {
    const event = measureTelemetryComponent(componentInput({ content_hash: '' }));
    expect(event.dropped).toBe(true);
    if (!('dropped' in event)) throw new Error('expected dropped');
    expect(event.reason_codes).toContain('telemetry.missing_content_hash');
  });

  it('drops event when field_policy_ref missing', () => {
    const event = measureTelemetryComponent(componentInput({ field_policy_ref: '' }));
    expect(event.dropped).toBe(true);
    if (!('dropped' in event)) throw new Error('expected dropped');
    expect(event.reason_codes).toContain('telemetry.missing_field_policy_ref');
  });

  it('drops event when redaction_result_ref missing', () => {
    const event = measureTelemetryComponent(componentInput({ redaction_result_ref: '' }));
    expect(event.dropped).toBe(true);
    if (!('dropped' in event)) throw new Error('expected dropped');
    expect(event.reason_codes).toContain('telemetry.missing_redaction_result_ref');
  });
});

// ---------- measurement-level drops (event still survives) ----------

describe('M-055 component telemetry — measurement-level drops (§10.8)', () => {
  it('drops measurement when method_id missing', () => {
    const bad: TokenMeasurement = {
      ...estimatorMeasurement(100),
      method_id: '',
    };
    const event = measureTelemetryComponent(
      componentInput({ token_measurements: [bad, estimatorMeasurement(50)] }),
    );
    if ('dropped' in event) throw new Error('event should survive');
    expect(event.token_measurements).toHaveLength(1);
    expect(event.token_measurements[0].value).toBe(50);
  });

  it('drops measurement when value is negative', () => {
    const bad: TokenMeasurement = {
      ...estimatorMeasurement(-5),
    };
    const event = measureTelemetryComponent(
      componentInput({ token_measurements: [bad] }),
    );
    if ('dropped' in event) throw new Error('event should survive');
    expect(event.token_measurements).toHaveLength(0);
  });

  it('drops measurement when value is non-finite (Infinity)', () => {
    const bad: TokenMeasurement = {
      ...estimatorMeasurement(Number.POSITIVE_INFINITY),
    };
    const event = measureTelemetryComponent(
      componentInput({ token_measurements: [bad] }),
    );
    if ('dropped' in event) throw new Error('event should survive');
    expect(event.token_measurements).toHaveLength(0);
  });

  it('drops measurement when value is non-integer', () => {
    const bad: TokenMeasurement = {
      ...estimatorMeasurement(12.5),
    };
    const event = measureTelemetryComponent(
      componentInput({ token_measurements: [bad] }),
    );
    if ('dropped' in event) throw new Error('event should survive');
    expect(event.token_measurements).toHaveLength(0);
  });
});

// ---------- scope/kind consistency matrix (§10.6 rule 4, §10.8) ----------

describe('M-055 component telemetry — scope/kind consistency matrix', () => {
  it('drops measurement when estimator has scope != component', () => {
    const bad: TokenMeasurement = {
      ...estimatorMeasurement(100),
      scope: 'request', // 估算应该是 component 级
    };
    const event = measureTelemetryComponent(
      componentInput({ token_measurements: [bad] }),
    );
    if ('dropped' in event) throw new Error('event should survive');
    expect(event.token_measurements).toHaveLength(0);
  });

  it('drops measurement when provider_reported_input_tokens has scope != request', () => {
    const bad: TokenMeasurement = {
      ...providerInputMeasurement(900),
      scope: 'component',
    };
    const event = measureTelemetryComponent(
      componentInput({ token_measurements: [bad] }),
    );
    if ('dropped' in event) throw new Error('event should survive');
    expect(event.token_measurements).toHaveLength(0);
  });

  it('drops measurement when provider_reported_output_tokens has scope != response', () => {
    const bad: TokenMeasurement = {
      ...providerOutputMeasurement(150),
      scope: 'request',
    };
    const event = measureTelemetryComponent(
      componentInput({ token_measurements: [bad] }),
    );
    if ('dropped' in event) throw new Error('event should survive');
    expect(event.token_measurements).toHaveLength(0);
  });

  it('drops provider_reported measurement when provider_id is null', () => {
    const bad: TokenMeasurement = {
      ...providerInputMeasurement(900),
      provider_id: null,
    };
    const event = measureTelemetryComponent(
      componentInput({ token_measurements: [bad] }),
    );
    if ('dropped' in event) throw new Error('event should survive');
    expect(event.token_measurements).toHaveLength(0);
  });

  it('allows estimator with provider_id = null', () => {
    const event = measureTelemetryComponent(
      componentInput({ token_measurements: [estimatorMeasurement(120)] }),
    );
    if ('dropped' in event) throw new Error('should not drop');
    expect(event.token_measurements[0].provider_id).toBeNull();
  });
});

// ---------- metadata-only invariant (§10.6 rule 10) ----------

describe('M-055 component telemetry — metadata-only invariant (§10.6 rule 10)', () => {
  it('does not include prompt body / tool description body / user content fields in event', () => {
    const event = measureTelemetryComponent(componentInput());
    if ('dropped' in event) throw new Error('should not drop');
    const keys = Object.keys(event);
    // 显式禁止字段
    for (const forbidden of [
      'body',
      'prompt_body',
      'tool_description',
      'description',
      'user_content',
      'source_code',
      'filesystem_path',
      'content',
      'credential',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    // 显式允许字段的闭集(接口契约)
    expect([...keys].sort()).toEqual(
      [
        'byte_count',
        'character_count',
        'component_ref',
        'component_telemetry_protocol_version',
        'content_hash',
        'event_id',
        'field_policy_ref',
        'included',
        'inclusion_reason_code',
        'profile_ref',
        'redaction_result_ref',
        'request_snapshot_id',
        'token_measurements',
        'variant_ref',
      ].sort(),
    );
  });

  it('content_hash is for drift detection only — not described as anonymization (no anonymized_* field)', () => {
    const event = measureTelemetryComponent(componentInput());
    if ('dropped' in event) throw new Error('should not drop');
    expect(event.content_hash).toBeTruthy();
    // 显式不存在"已匿名化"标记(hash 不等于匿名化)
    expect(Object.keys(event)).not.toContain('anonymized');
    expect(Object.keys(event)).not.toContain('is_anonymized');
  });
});

// ---------- envelope invariants ----------

describe('M-055 component telemetry — envelope invariants', () => {
  it('produces deterministic event_id for identical input', () => {
    const a = measureTelemetryComponent(componentInput());
    const b = measureTelemetryComponent(componentInput());
    if ('dropped' in a || 'dropped' in b) throw new Error('should not drop');
    expect(a.event_id).toBe(b.event_id);
  });

  it('changes event_id when component_id changes', () => {
    const a = measureTelemetryComponent(componentInput());
    const b = measureTelemetryComponent(
      componentInput({
        component_ref: { ...baseComponentRef, component_id: 'sys-memory-2' },
      }),
    );
    if ('dropped' in a || 'dropped' in b) throw new Error('should not drop');
    expect(a.event_id).not.toBe(b.event_id);
  });

  it('is frozen (no downstream mutation of event or nested arrays/objects)', () => {
    const event = measureTelemetryComponent(componentInput());
    if ('dropped' in event) throw new Error('should not drop');
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.token_measurements)).toBe(true);
    expect(Object.isFrozen(event.component_ref)).toBe(true);
    expect(Object.isFrozen(event.token_measurements[0])).toBe(true);
  });

  it('does not mutate the input (purity)', () => {
    const input = componentInput();
    const inputSnapshot = JSON.parse(JSON.stringify(input));
    measureTelemetryComponent(input);
    expect(input).toEqual(inputSnapshot);
    // 引用未变(没被就地冻结)
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.token_measurements)).toBe(false);
  });

  it('preserves included=false / null profile_ref / null variant_ref without dropping', () => {
    const event = measureTelemetryComponent(
      componentInput({
        included: false,
        inclusion_reason_code: 'out_of_budget',
        profile_ref: null,
        variant_ref: null,
      }),
    );
    if ('dropped' in event) throw new Error('should not drop');
    expect(event.included).toBe(false);
    expect(event.inclusion_reason_code).toBe('out_of_budget');
    expect(event.profile_ref).toBeNull();
    expect(event.variant_ref).toBeNull();
  });
});
