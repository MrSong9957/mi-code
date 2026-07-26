// Wave D Task 11 / DRC-4: Component Telemetry Batch Integration
//
// 物理本质:验证"telemetry 批次构建器" —— 把多个已通过 CRC-6 gate 的
// ComponentTelemetryEvent 装进一个 batch,要么 status='ready'(可进入 production plane),
// 要么 status='dropped'(任一 event 未过 CRC-6 gate / 缺身份 / snapshot 不一致)。
//
// 关键不变量(INV-D13 / spec §10.5 / §10.6 rule 4 / §10.8):
// 1. 先最小化(每个 event 已是 metadata-only),再清洗(redaction_result_ref 证明已过 CRC-6)。
// 2. production batch 只含通过 CRC-6 gate 的 event。
// 3. dropped event 原文不可由 bus/retry/error handler 重新读取 —— 本函数返回的 batch
//    不携带任何原始 prompt body / tool description / user content。
// 4. provider_usage_ref 只保留 Provider 实际返回的 request/response scope,
//    不按 component 重新分配(§10.6 rule 4,§10.8 "Provider total 被伪分配到 component: batch invalid")。
// 5. sink failure 不改变 Prompt/Memory/SecurityDecision/Outcome —— 本函数是纯函数,
//    不写 sink、不缓存原值。
// 6. full dump 仍禁用 —— 本函数与 full_request_dump 无关。
// 7. 不实现 Wave E local buffer/flush/rotation/retention。
//
// 纯函数:不读全局、不写 sink、不修改传入 input。

import { describe, expect, it } from 'vitest';
import {
  buildComponentTelemetryBatch,
  measureTelemetryComponent,
  COMPONENT_TELEMETRY_PROTOCOL_VERSION,
  type ComponentTelemetryEventInput,
  type ComponentTelemetryBatchInput,
  type ComponentTelemetryEvent,
} from '../../agent/observability/telemetry.js';

// ---------- 测试辅助 ----------

const baseComponentRef = {
  component_kind: 'prompt_section' as const,
  component_id: 'sys-memory-1',
  component_version: '2',
  source_snapshot_id: 'snap-src-1',
};

/** 构造一个合法 baseline ComponentTelemetryEvent(已通过 measureTelemetryComponent)。 */
const componentEvent = (
  overrides: Partial<ComponentTelemetryEventInput> = {},
): ComponentTelemetryEvent => {
  const input: ComponentTelemetryEventInput = {
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
    token_measurements: [],
    field_policy_ref: 'fp-1:1',
    redaction_result_ref: 'red:abc123',
    ...overrides,
  };
  const event = measureTelemetryComponent(input);
  if ('dropped' in event) {
    throw new Error('test fixture should produce a valid event');
  }
  return event;
};

/** 构造合法 baseline batch input。 */
const batchInput = (
  overrides: Partial<ComponentTelemetryBatchInput> = {},
): ComponentTelemetryBatchInput => ({
  component_telemetry_protocol_version: COMPONENT_TELEMETRY_PROTOCOL_VERSION,
  request_snapshot_id: 'snap-req-1',
  compiled_prompt_snapshot_id: 'snap-compiled-1',
  final_tool_view_snapshot_id: 'snap-toolview-1',
  profile_selection_id: 'sel-1:1',
  events: [componentEvent()],
  provider_usage_ref: 'provider-usage-ref-1',
  ...overrides,
});

// ---------- happy path: ready batch ----------

describe('DRC-4 telemetry batch — happy path (ready)', () => {
  it('builds a ready batch when all events pass CRC-6 gate', () => {
    const batch = buildComponentTelemetryBatch(batchInput());
    expect(batch.status).toBe('ready');
    expect(batch.reason_codes).toEqual([]);
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0].event_id).toMatch(/^ct:[0-9a-f]{16}$/);
  });

  it('propagates all snapshot/protocol/profile/provider fields into the batch', () => {
    const batch = buildComponentTelemetryBatch(batchInput());
    expect(batch.component_telemetry_protocol_version).toBe(
      COMPONENT_TELEMETRY_PROTOCOL_VERSION,
    );
    expect(batch.request_snapshot_id).toBe('snap-req-1');
    expect(batch.compiled_prompt_snapshot_id).toBe('snap-compiled-1');
    expect(batch.final_tool_view_snapshot_id).toBe('snap-toolview-1');
    expect(batch.profile_selection_id).toBe('sel-1:1');
    expect(batch.provider_usage_ref).toBe('provider-usage-ref-1');
  });

  it('produces deterministic batch_id of form batch:<16 hex> for identical input', () => {
    const a = buildComponentTelemetryBatch(batchInput());
    const b = buildComponentTelemetryBatch(batchInput());
    expect(a.batch_id).toBe(b.batch_id);
    expect(a.batch_id).toMatch(/^batch:[0-9a-f]{16}$/);
  });

  it('changes batch_id when event set changes', () => {
    const a = buildComponentTelemetryBatch(
      batchInput({ events: [componentEvent()] }),
    );
    const b = buildComponentTelemetryBatch({
      ...batchInput(),
      events: [
        componentEvent({
          component_ref: { ...baseComponentRef, component_id: 'sys-memory-2' },
        }),
      ],
    });
    expect(a.batch_id).not.toBe(b.batch_id);
  });

  it('preserves event order and event identity from input', () => {
    const e1 = componentEvent();
    const e2 = componentEvent({
      component_ref: { ...baseComponentRef, component_id: 'sys-memory-2' },
    });
    const batch = buildComponentTelemetryBatch(batchInput({ events: [e1, e2] }));
    expect(batch.status).toBe('ready');
    expect(batch.events.map((e) => e.event_id)).toEqual([e1.event_id, e2.event_id]);
  });

  it('allows null profile_selection_id and null provider_usage_ref without dropping', () => {
    const batch = buildComponentTelemetryBatch(
      batchInput({ profile_selection_id: null, provider_usage_ref: null }),
    );
    expect(batch.status).toBe('ready');
    expect(batch.profile_selection_id).toBeNull();
    expect(batch.provider_usage_ref).toBeNull();
  });

  it('builds ready batch with empty events array', () => {
    const batch = buildComponentTelemetryBatch(batchInput({ events: [] }));
    expect(batch.status).toBe('ready');
    expect(batch.events).toEqual([]);
    expect(batch.reason_codes).toEqual([]);
  });
});

// ---------- CRC-6 gate: redaction_result_ref ----------

describe('DRC-4 telemetry batch — CRC-6 gate (redaction_result_ref, spec §10.5/§10.8)', () => {
  it('drops the batch when an event lacks an accepted redaction result', () => {
    // 通过 measureTelemetryComponent 不能直接产出"缺 redaction_result_ref 但合法"的 event,
    // 因为 measure 在 Step 4 就 drop 了。这里手动构造一个"绕过 measure 的伪 event"
    // 来模拟"上游声称过 CRC-6 但 ref 实际丢失"的情况(batch 必须自己重新校验)。
    const fakeEvent: ComponentTelemetryEvent = {
      ...componentEvent(),
      redaction_result_ref: '',
    };
    const batch = buildComponentTelemetryBatch({
      ...batchInput(),
      events: [fakeEvent],
    });
    expect(batch.status).toBe('dropped');
    expect(batch.reason_codes).toContain('telemetry.redaction_result_missing');
    // INV-D13: dropped batch 不携带未清洗 event 原文
    expect(batch.events).toEqual([]);
  });

  it('drops batch if any one of many events fails the redaction gate', () => {
    const ok = componentEvent();
    const bad: ComponentTelemetryEvent = {
      ...componentEvent({
        component_ref: { ...baseComponentRef, component_id: 'sys-memory-2' },
      }),
      redaction_result_ref: '   ',
    };
    const batch = buildComponentTelemetryBatch({
      ...batchInput(),
      events: [ok, bad],
    });
    expect(batch.status).toBe('dropped');
    expect(batch.reason_codes).toContain('telemetry.redaction_result_missing');
    expect(batch.events).toEqual([]);
  });
});

// ---------- event identity validation ----------

describe('DRC-4 telemetry batch — event identity validation (spec §10.8)', () => {
  it('drops batch on missing event_id', () => {
    const bad: ComponentTelemetryEvent = { ...componentEvent(), event_id: '' };
    const batch = buildComponentTelemetryBatch({ ...batchInput(), events: [bad] });
    expect(batch.status).toBe('dropped');
    expect(batch.reason_codes).toContain('telemetry.event_invalid');
    expect(batch.events).toEqual([]);
  });

  it('drops batch on missing content_hash', () => {
    const bad: ComponentTelemetryEvent = { ...componentEvent(), content_hash: '' };
    const batch = buildComponentTelemetryBatch({ ...batchInput(), events: [bad] });
    expect(batch.status).toBe('dropped');
    expect(batch.reason_codes).toContain('telemetry.event_invalid');
  });

  it('drops batch on missing field_policy_ref', () => {
    const bad: ComponentTelemetryEvent = { ...componentEvent(), field_policy_ref: '' };
    const batch = buildComponentTelemetryBatch({ ...batchInput(), events: [bad] });
    expect(batch.status).toBe('dropped');
    expect(batch.reason_codes).toContain('telemetry.event_invalid');
  });
});

// ---------- snapshot consistency ----------

describe('DRC-4 telemetry batch — snapshot consistency (spec §10.5)', () => {
  it('drops batch on snapshot mismatch (event.request_snapshot_id != batch.request_snapshot_id)', () => {
    const otherSnap = componentEvent({
      request_snapshot_id: 'snap-req-OTHER',
    });
    const batch = buildComponentTelemetryBatch({
      ...batchInput(),
      request_snapshot_id: 'snap-req-1',
      events: [otherSnap],
    });
    expect(batch.status).toBe('dropped');
    expect(batch.reason_codes).toContain('telemetry.snapshot_mismatch');
    expect(batch.events).toEqual([]);
  });

  it('drops batch when input.request_snapshot_id itself is empty (identity gate)', () => {
    const batch = buildComponentTelemetryBatch({
      ...batchInput(),
      request_snapshot_id: '',
    });
    expect(batch.status).toBe('dropped');
    expect(batch.reason_codes).toContain('telemetry.snapshot_identity_missing');
  });

  it('drops batch when compiled_prompt_snapshot_id is empty (identity gate)', () => {
    const batch = buildComponentTelemetryBatch({
      ...batchInput(),
      compiled_prompt_snapshot_id: '  ',
    });
    expect(batch.status).toBe('dropped');
    expect(batch.reason_codes).toContain('telemetry.snapshot_identity_missing');
  });

  it('drops batch when final_tool_view_snapshot_id is empty (identity gate)', () => {
    const batch = buildComponentTelemetryBatch({
      ...batchInput(),
      final_tool_view_snapshot_id: '',
    });
    expect(batch.status).toBe('dropped');
    expect(batch.reason_codes).toContain('telemetry.snapshot_identity_missing');
  });
});

// ---------- attribution: provider_usage_ref not redistributed ----------

describe('DRC-4 telemetry batch — attribution rules (spec §10.6 rule 4)', () => {
  it('does not redistribute provider usage to components (single batch-level ref)', () => {
    const e1 = componentEvent();
    const e2 = componentEvent({
      component_ref: { ...baseComponentRef, component_id: 'sys-memory-2' },
    });
    const batch = buildComponentTelemetryBatch({
      ...batchInput(),
      events: [e1, e2],
      provider_usage_ref: 'provider-usage-agg-1',
    });
    expect(batch.status).toBe('ready');
    // provider_usage_ref 只挂在 batch 级别,不渗到 event 级别
    expect(batch.provider_usage_ref).toBe('provider-usage-agg-1');
    // 每个 event 都没有自己的 provider_usage_ref 字段(metadata-only)
    for (const e of batch.events) {
      expect(Object.keys(e)).not.toContain('provider_usage_ref');
    }
  });

  it('keeps provider_usage_ref=null when not provided (no fabricated attribution)', () => {
    const batch = buildComponentTelemetryBatch(
      batchInput({ provider_usage_ref: null }),
    );
    expect(batch.status).toBe('ready');
    expect(batch.provider_usage_ref).toBeNull();
  });
});

// ---------- envelope invariants ----------

describe('DRC-4 telemetry batch — envelope invariants (INV-D13)', () => {
  it('is frozen (no downstream mutation of batch or nested events)', () => {
    const batch = buildComponentTelemetryBatch(batchInput());
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.events)).toBe(true);
    expect(Object.isFrozen(batch.reason_codes)).toBe(true);
    expect(Object.isFrozen(batch.events[0])).toBe(true);
  });

  it('does not mutate the input (purity)', () => {
    const input = batchInput();
    const inputSnapshot = JSON.parse(JSON.stringify(input));
    buildComponentTelemetryBatch(input);
    expect(input).toEqual(inputSnapshot);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.events)).toBe(false);
  });

  it('sink failure independence — batch is pure, has no side effects', () => {
    // 通过"调用两次产生相同 batch_id 且不抛错"体现纯函数性:
    // 函数既不写 sink 也不缓存原值,sink 故障不会回退到 batch 的构造。
    const a = buildComponentTelemetryBatch(batchInput());
    const b = buildComponentTelemetryBatch(batchInput());
    expect(a.batch_id).toBe(b.batch_id);
    expect(a.status).toBe(b.status);
    // 不存在可观察的全局副作用(返回值是全部输出)
    expect(a).toBeDefined();
  });

  it('does not carry prompt body / tool description / user content / credential fields', () => {
    const batch = buildComponentTelemetryBatch(batchInput());
    const batchKeys = Object.keys(batch);
    for (const forbidden of [
      'prompt_body',
      'tool_description',
      'user_content',
      'source_code',
      'filesystem_path',
      'credential',
      'body',
      'content',
    ]) {
      expect(batchKeys).not.toContain(forbidden);
    }
  });

  it('exposes the closed field set defined by spec §10.5', () => {
    const batch = buildComponentTelemetryBatch(batchInput());
    expect([...Object.keys(batch)].sort()).toEqual(
      [
        'batch_id',
        'compiled_prompt_snapshot_id',
        'component_telemetry_protocol_version',
        'events',
        'final_tool_view_snapshot_id',
        'profile_selection_id',
        'provider_usage_ref',
        'reason_codes',
        'request_snapshot_id',
        'status',
      ].sort(),
    );
  });
});

// ---------- multi-reason aggregation ----------

describe('DRC-4 telemetry batch — multi-reason aggregation', () => {
  it('aggregates multiple distinct reason codes when several gates fail', () => {
    const bad1: ComponentTelemetryEvent = { ...componentEvent(), event_id: '' };
    const bad2: ComponentTelemetryEvent = {
      ...componentEvent({
        component_ref: { ...baseComponentRef, component_id: 'sys-memory-2' },
      }),
      redaction_result_ref: '',
    };
    const batch = buildComponentTelemetryBatch({
      ...batchInput(),
      events: [bad1, bad2],
    });
    expect(batch.status).toBe('dropped');
    expect(batch.reason_codes).toContain('telemetry.event_invalid');
    expect(batch.reason_codes).toContain('telemetry.redaction_result_missing');
    // dedup: 同一 reason 不重复
    const uniq = new Set(batch.reason_codes);
    expect(uniq.size).toBe(batch.reason_codes.length);
  });

  it('dedupes identical reason codes across events', () => {
    const bad1: ComponentTelemetryEvent = { ...componentEvent(), event_id: '' };
    const bad2: ComponentTelemetryEvent = {
      ...componentEvent({
        component_ref: { ...baseComponentRef, component_id: 'sys-memory-2' },
      }),
      event_id: '',
    };
    const batch = buildComponentTelemetryBatch({
      ...batchInput(),
      events: [bad1, bad2],
    });
    expect(batch.status).toBe('dropped');
    const invalidCount = batch.reason_codes.filter(
      (r) => r === 'telemetry.event_invalid',
    ).length;
    expect(invalidCount).toBe(1);
  });
});
