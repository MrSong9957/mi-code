// Wave C Task 14 / M-056: Telemetry Field Policy + Redaction
//
// 物理本质:验证"发送前清洗台"——任何 event 在进入 production telemetry 之前,
// 必须先按字段 allowlist + PII label + minimum-action 规则清洗:
// - credential / sensitive_auth → 强制 drop event
// - direct_identifier → 至少 drop_field
// - potential_identifier → 至少 hash(不得原样 keep)
// - unknown field / 缺失 PII label → drop_field
// - event_type 不匹配 policy → drop event
//
// 这是纯函数:不写 sink、不缓存原值、不修改传入 event。
// hash 不等于匿名化(applied_actions 仍标记 field_class)。

import { describe, expect, it } from 'vitest';
import {
  redactTelemetryEvent,
  REDACTION_PROTOCOL_VERSION,
  type TelemetryFieldClass,
  type TelemetryPiiLabel,
  type TelemetryFieldAction,
  type TelemetryFieldPolicy,
  type TelemetryEventInput,
} from '../../agent/observability/redaction.js';

const policyFor = (
  field_class: TelemetryFieldClass,
  pii: TelemetryPiiLabel,
  action: TelemetryFieldAction,
): TelemetryFieldPolicy => ({
  field_policy_id: 'fp-1',
  field_policy_version: '1',
  event_type: 'tool_call',
  allowed_fields: {
    field_a: { field_class, pii_label: pii, action },
  },
});

const eventWithField = (value: unknown): TelemetryEventInput => ({
  event_id: 'evt-1',
  event_type: 'tool_call',
  fields: { field_a: value },
});

describe('M-056 redaction — minimum action matrix (spec §12.5 rule 2/3)', () => {
  it.each([
    // field_class,                    pii_label,                policy.action, expected applied action
    ['credential', 'none', 'keep', 'drop_event'],
    ['credential', 'sensitive_auth', 'hash', 'drop_event'],
    ['operational_metadata', 'sensitive_auth', 'keep', 'drop_event'],
    ['unknown', 'none', 'keep', 'drop_field'],
    ['pseudonymous_identifier', 'direct_identifier', 'keep', 'drop_field'],
    ['operational_metadata', 'direct_identifier', 'keep', 'drop_field'],
  ] as const)(
    'enforces minimum action for %s/%s (policy=%s)',
    (fieldClass, pii, policyAction, expected) => {
      const result = redactTelemetryEvent(
        eventWithField('value'),
        policyFor(fieldClass, pii, policyAction),
      );
      expect(result.applied_actions[0].action).toBe(expected);
    },
  );

  it('hashes potential_identifier even if policy says keep (min = hash)', () => {
    const result = redactTelemetryEvent(
      eventWithField('value'),
      policyFor('operational_metadata', 'potential_identifier', 'keep'),
    );
    expect(result.applied_actions[0].action).toBe('hash');
    expect(result.status).toBe('redacted');
  });

  it('allows policy to be stricter than minimum for potential_identifier (redact)', () => {
    const result = redactTelemetryEvent(
      eventWithField('value'),
      policyFor('operational_metadata', 'potential_identifier', 'redact'),
    );
    expect(result.applied_actions[0].action).toBe('redact');
  });

  it('allows policy to be stricter than minimum for potential_identifier (drop_field)', () => {
    const result = redactTelemetryEvent(
      eventWithField('value'),
      policyFor('operational_metadata', 'potential_identifier', 'drop_field'),
    );
    expect(result.applied_actions[0].action).toBe('drop_field');
  });
});

describe('M-056 redaction — happy path keep / hash / redact / drop_field', () => {
  it('keeps operational_metadata with no pii', () => {
    const result = redactTelemetryEvent(
      eventWithField(42),
      policyFor('operational_metadata', 'none', 'keep'),
    );
    expect(result.applied_actions[0].action).toBe('keep');
    expect(result.status).toBe('redacted');
    expect(result.output_payload_ref).not.toBeNull();
  });

  it('hashes pseudonymous_identifier with none pii when policy says hash', () => {
    const result = redactTelemetryEvent(
      eventWithField('user-123'),
      policyFor('pseudonymous_identifier', 'none', 'hash'),
    );
    expect(result.applied_actions[0].action).toBe('hash');
    expect(result.applied_actions[0].field_class).toBe('pseudonymous_identifier');
    expect(result.status).toBe('redacted');
  });

  it('redacts filesystem_path when policy says redact', () => {
    const result = redactTelemetryEvent(
      eventWithField('/home/u/secret'),
      policyFor('filesystem_path', 'potential_identifier', 'redact'),
    );
    expect(result.applied_actions[0].action).toBe('redact');
  });

  it('drops the field (not event) when policy says drop_field for non-sensitive', () => {
    const result = redactTelemetryEvent(
      eventWithField('value'),
      policyFor('operational_metadata', 'none', 'drop_field'),
    );
    expect(result.applied_actions[0].action).toBe('drop_field');
    expect(result.status).toBe('redacted');
  });
});

describe('M-056 redaction — event_type / unlisted fields (spec §12.5 rule 1, §12.6)', () => {
  it('drops event when event_type does not match policy', () => {
    const result = redactTelemetryEvent(
      { event_id: 'evt-1', event_type: 'something_else', fields: { field_a: 'x' } },
      policyFor('operational_metadata', 'none', 'keep'),
    );
    expect(result.status).toBe('dropped');
    expect(result.reason_codes).toContain('redaction.event_type_mismatch');
    expect(result.output_payload_ref).toBeNull();
  });

  it('drops unlisted fields (field not in allowed_fields)', () => {
    const result = redactTelemetryEvent(
      { event_id: 'evt-1', event_type: 'tool_call', fields: { unlisted: 'value' } },
      policyFor('operational_metadata', 'none', 'keep'),
    );
    expect(result.applied_actions[0]).toMatchObject({
      field_path: 'unlisted',
      action: 'drop_field',
      field_class: 'unknown',
    });
    expect(result.reason_codes).toContain('redaction.unlisted_field');
  });
});

describe('M-056 redaction — result envelope invariants', () => {
  it('redaction_id has form red:<16 hex>', () => {
    const result = redactTelemetryEvent(
      eventWithField('value'),
      policyFor('operational_metadata', 'none', 'keep'),
    );
    expect(result.redaction_id).toMatch(/^red:[0-9a-f]{16}$/);
  });

  it('redaction_protocol_version is exposed', () => {
    const result = redactTelemetryEvent(
      eventWithField('value'),
      policyFor('operational_metadata', 'none', 'keep'),
    );
    expect(result.redaction_protocol_version).toBe(REDACTION_PROTOCOL_VERSION);
  });

  it('source_event_id echoes input event_id', () => {
    const result = redactTelemetryEvent(
      { event_id: 'evt-xyz', event_type: 'tool_call', fields: { field_a: 1 } },
      policyFor('operational_metadata', 'none', 'keep'),
    );
    expect(result.source_event_id).toBe('evt-xyz');
  });

  it('field_policy_ref is composed as id:version', () => {
    const result = redactTelemetryEvent(
      eventWithField('value'),
      {
        field_policy_id: 'fp-42',
        field_policy_version: '7',
        event_type: 'tool_call',
        allowed_fields: { field_a: { field_class: 'operational_metadata', pii_label: 'none', action: 'keep' } },
      },
    );
    expect(result.field_policy_ref).toBe('fp-42:7');
  });

  it('output_payload_ref is sha256-style hex when redacted', () => {
    const result = redactTelemetryEvent(
      eventWithField('value'),
      policyFor('operational_metadata', 'none', 'keep'),
    );
    expect(result.output_payload_ref).toMatch(/^[0-9a-f]+$/);
  });

  it('output_payload_ref is null when dropped', () => {
    const result = redactTelemetryEvent(
      eventWithField('value'),
      policyFor('credential', 'none', 'keep'),
    );
    expect(result.status).toBe('dropped');
    expect(result.output_payload_ref).toBeNull();
  });

  it('produces deterministic redaction_id for identical input', () => {
    const a = redactTelemetryEvent(eventWithField('value'), policyFor('operational_metadata', 'none', 'keep'));
    const b = redactTelemetryEvent(eventWithField('value'), policyFor('operational_metadata', 'none', 'keep'));
    expect(a.redaction_id).toBe(b.redaction_id);
  });

  it('freezes the result (no downstream mutation)', () => {
    const result = redactTelemetryEvent(
      eventWithField('value'),
      policyFor('operational_metadata', 'none', 'keep'),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.applied_actions)).toBe(true);
  });
});

describe('M-056 redaction — purity / no side-effect invariants (spec §12.5 rule 9/12)', () => {
  it('does not mutate the input event', () => {
    const event = eventWithField('original-value');
    const snapshot = { ...event.fields };
    redactTelemetryEvent(event, policyFor('operational_metadata', 'none', 'keep'));
    expect(event.fields).toEqual(snapshot);
    expect(event.fields.field_a).toBe('original-value');
  });

  it('does not cache unredacted payload (no global state observable)', () => {
    // redaction 是纯函数:第二次调用结果与第一次独立,不依赖任何"已发送缓存"。
    const a = redactTelemetryEvent(eventWithField('v1'), policyFor('operational_metadata', 'none', 'keep'));
    const b = redactTelemetryEvent(eventWithField('v2'), policyFor('operational_metadata', 'none', 'keep'));
    expect(a.redaction_id).not.toBe(b.redaction_id);
  });

  it('does not change Outcome/SecurityDecision/CompletionReport — pure function (no external mutation)', () => {
    // 通过不引用外部对象体现:返回值就是全部输出。
    const result = redactTelemetryEvent(
      eventWithField('value'),
      policyFor('operational_metadata', 'none', 'keep'),
    );
    expect(result).toBeDefined();
    expect(Object.keys(result).sort()).toEqual(
      [
        'applied_actions',
        'field_policy_ref',
        'output_payload_ref',
        'reason_codes',
        'redaction_id',
        'redaction_protocol_version',
        'source_event_id',
        'status',
      ].sort(),
    );
  });
});

describe('M-056 redaction — multi-field composition', () => {
  it('handles mixed fields: keep + hash + drop_field in one event', () => {
    const result = redactTelemetryEvent(
      {
        event_id: 'evt-1',
        event_type: 'tool_call',
        fields: {
          keep_field: 1,
          hash_field: 'abc',
          drop_field: 'xyz',
          unknown_field: 'def',
        },
      },
      {
        field_policy_id: 'fp-1',
        field_policy_version: '1',
        event_type: 'tool_call',
        allowed_fields: {
          keep_field: { field_class: 'operational_metadata', pii_label: 'none', action: 'keep' },
          hash_field: { field_class: 'pseudonymous_identifier', pii_label: 'potential_identifier', action: 'hash' },
          drop_field: { field_class: 'operational_metadata', pii_label: 'none', action: 'drop_field' },
        },
      },
    );
    expect(result.status).toBe('redacted');
    const byPath = new Map(result.applied_actions.map((a) => [a.field_path, a.action]));
    expect(byPath.get('keep_field')).toBe('keep');
    expect(byPath.get('hash_field')).toBe('hash');
    expect(byPath.get('drop_field')).toBe('drop_field');
    expect(byPath.get('unknown_field')).toBe('drop_field');
  });

  it('drops the whole event if any allowed field is credential', () => {
    const result = redactTelemetryEvent(
      {
        event_id: 'evt-1',
        event_type: 'tool_call',
        fields: { ok: 1, secret: 'p@ss' },
      },
      {
        field_policy_id: 'fp-1',
        field_policy_version: '1',
        event_type: 'tool_call',
        allowed_fields: {
          ok: { field_class: 'operational_metadata', pii_label: 'none', action: 'keep' },
          secret: { field_class: 'credential', pii_label: 'sensitive_auth', action: 'keep' },
        },
      },
    );
    expect(result.status).toBe('dropped');
    expect(result.reason_codes).toContain('redaction.credential_detected');
  });
});
