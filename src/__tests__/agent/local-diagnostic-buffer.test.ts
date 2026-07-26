// Wave E Task 9 / ERC-3 / M-052: Sanitized Bounded Local Diagnostic Buffer
//
// 物理本质:验证"有界、非阻塞、只接受已清洗事件的本地诊断 buffer"。
// ERC-3 不重建 dropped payload、不启用 full dump、不把日志当完整请求复现。
//
// 关键不变量(spec §9 / ERC-3 / Task 9):
// 1. 只有 CRC-6/DRC-4 已清洗 event(redaction_result_ref 非空)可以入队。
// 2. raw/dropped payload 不得进入内存队列 / 临时文件 / retry sidecar。
// 3. overflow 固定 drop_newest,只增加最小 drop counter,
//    不保留 dropped payload 的 hash / slice / temporary copy / retry closure。
// 4. enqueue 只操作内存,不执行磁盘 I/O,不阻塞 streaming loop。
// 5. policy disabled / sink location 不可信 / capacity 非法 → state='disabled'。
// 6. enqueue 内部异常 / sink 未提供时,立即返回 degraded/drop 结果,不抛到 streaming loop。
// 7. queue order 使用 (enqueued_at, event_id) 的确定顺序。
// 8. duplicate source event_id 不重复写入。
// 9. 不实现 full dump / raw sidecar / 远程 sink / Wave F import。

import { describe, expect, it } from 'vitest';
import {
  measureTelemetryComponent,
  COMPONENT_TELEMETRY_PROTOCOL_VERSION,
  type ComponentTelemetryEvent,
  type ComponentTelemetryEventInput,
} from '../../agent/observability/telemetry.js';
import {
  createLocalDiagnosticBuffer,
  type LocalDiagnosticBuffer,
  type LocalDiagnosticBufferPolicy,
  type EnqueueResult,
} from '../../agent/observability/local-buffer.js';

// ---------- 测试辅助 ----------

const baseComponentRef = {
  component_kind: 'prompt_section' as const,
  component_id: 'sys-memory-1',
  component_version: '2',
  source_snapshot_id: 'snap-src-1',
};

let eventCounter = 0;

/** 构造一个合法 baseline ComponentTelemetryEvent(已通过 measureTelemetryComponent)。 */
const componentEvent = (
  overrides: Partial<ComponentTelemetryEventInput> = {},
): ComponentTelemetryEvent => {
  eventCounter += 1;
  const input: ComponentTelemetryEventInput = {
    component_telemetry_protocol_version: COMPONENT_TELEMETRY_PROTOCOL_VERSION,
    request_snapshot_id: 'snap-req-1',
    component_ref: {
      ...baseComponentRef,
      component_id: `sys-memory-${eventCounter}`,
    },
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

/** 构造合法 baseline policy。 */
const validPolicy = (
  overrides: Partial<LocalDiagnosticBufferPolicy> = {},
): LocalDiagnosticBufferPolicy => ({
  policy_id: 'local-diag-policy-1',
  policy_version: '1',
  enabled: true,
  sink_location_ref: '/var/log/mi-code/diagnostics',
  max_queued_events: 16,
  max_queued_bytes: 16384,
  ...overrides,
});

/** 通过覆盖 measureTelemetryComponent 输出,构造一个 redaction_result_ref 为空的 event。 */
const unsanitizedEvent = (): ComponentTelemetryEvent => {
  // 直接构造一个 DRC-4 event shape,但 redaction_result_ref 为空 ——
  // 模拟"绕过 measureTelemetryComponent 的清洗 gate,直接喂给 buffer"的攻击。
  const valid = componentEvent();
  // Object.assign 会破坏冻结;改用 spread 后强制覆盖。
  return {
    ...valid,
    redaction_result_ref: '',
  } as ComponentTelemetryEvent;
};

// ---------- state:active vs disabled ----------

describe('ERC-3 / M-052 — buffer state on creation', () => {
  it('creates buffer in active state when policy is fully valid', () => {
    const buffer = createLocalDiagnosticBuffer(validPolicy());
    expect(buffer.snapshot().state).toBe('active');
    expect(buffer.snapshot().queued_event_count).toBe(0);
    expect(buffer.snapshot().queued_byte_count).toBe(0);
    expect(buffer.snapshot().dropped_count).toBe(0);
    expect(buffer.snapshot().queued_event_ids).toEqual([]);
  });

  it('creates buffer in disabled state when policy.enabled === false', () => {
    const buffer = createLocalDiagnosticBuffer(validPolicy({ enabled: false }));
    expect(buffer.snapshot().state).toBe('disabled');
  });

  it('creates buffer in disabled state when sink_location_ref is empty', () => {
    const buffer = createLocalDiagnosticBuffer(
      validPolicy({ sink_location_ref: '' }),
    );
    expect(buffer.snapshot().state).toBe('disabled');
  });

  it('creates buffer in disabled state when sink_location_ref is whitespace-only', () => {
    const buffer = createLocalDiagnosticBuffer(
      validPolicy({ sink_location_ref: '   ' }),
    );
    expect(buffer.snapshot().state).toBe('disabled');
  });

  it('creates buffer in disabled state when max_queued_events <= 0', () => {
    const zero = createLocalDiagnosticBuffer(
      validPolicy({ max_queued_events: 0 }),
    );
    const negative = createLocalDiagnosticBuffer(
      validPolicy({ max_queued_events: -1 }),
    );
    expect(zero.snapshot().state).toBe('disabled');
    expect(negative.snapshot().state).toBe('disabled');
  });

  it('creates buffer in disabled state when max_queued_bytes <= 0', () => {
    const zero = createLocalDiagnosticBuffer(
      validPolicy({ max_queued_bytes: 0 }),
    );
    const negative = createLocalDiagnosticBuffer(
      validPolicy({ max_queued_bytes: -8 }),
    );
    expect(zero.snapshot().state).toBe('disabled');
    expect(negative.snapshot().state).toBe('disabled');
  });
});

// ---------- enqueue:happy path ----------

describe('ERC-3 / M-052 — enqueue sanitized event', () => {
  it('enqueues a sanitized event with refs only and returns enqueued status', () => {
    const buffer = createLocalDiagnosticBuffer(validPolicy());
    const event = componentEvent();
    const result = buffer.enqueue(event);
    expect(result.status).toBe('enqueued');
    expect(result.queued_event_id).toBe(event.event_id);
    expect(result.reason_codes).toEqual([]);

    const snap = buffer.snapshot();
    expect(snap.queued_event_count).toBe(1);
    expect(snap.queued_event_ids).toEqual([event.event_id]);
    expect(snap.queued_byte_count).toBe(event.byte_count);
    expect(snap.dropped_count).toBe(0);
  });

  it('preserves insertion order across multiple enqueues', () => {
    const buffer = createLocalDiagnosticBuffer(validPolicy());
    const e1 = componentEvent();
    const e2 = componentEvent();
    const e3 = componentEvent();
    buffer.enqueue(e1);
    buffer.enqueue(e2);
    buffer.enqueue(e3);
    expect(buffer.snapshot().queued_event_ids).toEqual([
      e1.event_id,
      e2.event_id,
      e3.event_id,
    ]);
  });
});

// ---------- sanitize gate ----------

describe('ERC-3 / M-052 — sanitize-before-buffer gate', () => {
  it('never stores raw payload: rejects unsanitized event (empty redaction_result_ref)', () => {
    const buffer = createLocalDiagnosticBuffer(validPolicy());
    const raw = unsanitizedEvent();
    const result = buffer.enqueue(raw);

    expect(result.status).toBe('dropped_invalid');
    expect(result.reason_codes).toContain('buffer.unsanitized_event');
    expect(result.queued_event_id).toBeNull();
    expect(buffer.snapshot().queued_event_count).toBe(0);
    expect(buffer.inspectForTest().has_raw_payload).toBe(false);
  });

  it('never stores raw payload: rejected events do not appear in inspectForTest ids', () => {
    const buffer = createLocalDiagnosticBuffer(validPolicy());
    const raw = unsanitizedEvent();
    buffer.enqueue(raw);
    expect(buffer.inspectForTest().event_ids).not.toContain(raw.event_id);
  });

  it('does not keep raw payload copy of dropped events (overflow)', () => {
    // 容量 = 1,填满后再入队 → drop_newest;overflowed event 不得在 inspectForTest 出现。
    const buffer = createLocalDiagnosticBuffer(
      validPolicy({ max_queued_events: 1, max_queued_bytes: 4096 }),
    );
    const e1 = componentEvent();
    const e2 = componentEvent();
    buffer.enqueue(e1);
    const result = buffer.enqueue(e2);

    expect(result.status).toBe('dropped_full');
    expect(buffer.inspectForTest().event_ids).toEqual([e1.event_id]);
    expect(buffer.inspectForTest().event_ids).not.toContain(e2.event_id);
    expect(buffer.inspectForTest().has_raw_payload).toBe(false);
  });
});

// ---------- capacity / overflow (fixed drop_newest) ----------

describe('ERC-3 / M-052 — fixed drop_newest overflow', () => {
  it('drops with dropped_full when event count exceeds max_queued_events', () => {
    const buffer = createLocalDiagnosticBuffer(
      validPolicy({ max_queued_events: 2, max_queued_bytes: 1_000_000 }),
    );
    const e1 = componentEvent();
    const e2 = componentEvent();
    const e3 = componentEvent();
    expect(buffer.enqueue(e1).status).toBe('enqueued');
    expect(buffer.enqueue(e2).status).toBe('enqueued');
    const overflow = buffer.enqueue(e3);
    expect(overflow.status).toBe('dropped_full');
    expect(overflow.queued_event_id).toBeNull();
    expect(buffer.snapshot().queued_event_count).toBe(2);
    expect(buffer.snapshot().dropped_count).toBe(1);
  });

  it('drops with dropped_full when byte count would exceed max_queued_bytes', () => {
    // 每个 event byte_count = 128,2 个 = 256 bytes,第 3 个会超过 max=300。
    const buffer = createLocalDiagnosticBuffer(
      validPolicy({ max_queued_events: 16, max_queued_bytes: 300 }),
    );
    const e1 = componentEvent();
    const e2 = componentEvent();
    const e3 = componentEvent();
    expect(buffer.enqueue(e1).status).toBe('enqueued');
    expect(buffer.enqueue(e2).status).toBe('enqueued');
    const overflow = buffer.enqueue(e3);
    expect(overflow.status).toBe('dropped_full');
    expect(buffer.snapshot().queued_byte_count).toBe(256);
    expect(buffer.snapshot().dropped_count).toBe(1);
  });

  it('drop counter accumulates across multiple overflows without dropping oldest', () => {
    // drop_newest 语义:已入队事件不被踢出,只有新事件被拒绝。
    const buffer = createLocalDiagnosticBuffer(
      validPolicy({ max_queued_events: 1, max_queued_bytes: 1_000_000 }),
    );
    const e1 = componentEvent();
    buffer.enqueue(e1);
    buffer.enqueue(componentEvent());
    buffer.enqueue(componentEvent());
    buffer.enqueue(componentEvent());
    const snap = buffer.snapshot();
    expect(snap.queued_event_count).toBe(1);
    expect(snap.queued_event_ids).toEqual([e1.event_id]);
    expect(snap.dropped_count).toBe(3);
  });
});

// ---------- deduplication ----------

describe('ERC-3 / M-052 — duplicate event_id deduplication', () => {
  it('rejects duplicate event_id with dropped_invalid / buffer.duplicate_event_id', () => {
    const buffer = createLocalDiagnosticBuffer(validPolicy());
    const event = componentEvent();
    expect(buffer.enqueue(event).status).toBe('enqueued');
    const dup = buffer.enqueue(event);
    expect(dup.status).toBe('dropped_invalid');
    expect(dup.reason_codes).toContain('buffer.duplicate_event_id');
    expect(dup.queued_event_id).toBeNull();
    expect(buffer.snapshot().queued_event_count).toBe(1);
    // duplicate 不计入 dropped_count(它是 invalid,不是 overflow)。
    expect(buffer.snapshot().dropped_count).toBe(0);
  });
});

// ---------- disabled state rejects enqueue ----------

describe('ERC-3 / M-052 — disabled buffer rejects enqueue', () => {
  it('returns dropped_disabled when policy.enabled=false', () => {
    const buffer = createLocalDiagnosticBuffer(
      validPolicy({ enabled: false }),
    );
    const result = buffer.enqueue(componentEvent());
    expect(result.status).toBe('dropped_disabled');
    expect(result.queued_event_id).toBeNull();
    expect(buffer.snapshot().queued_event_count).toBe(0);
  });

  it('returns dropped_disabled when sink_location_ref empty', () => {
    const buffer = createLocalDiagnosticBuffer(
      validPolicy({ sink_location_ref: '' }),
    );
    expect(buffer.enqueue(componentEvent()).status).toBe('dropped_disabled');
  });
});

// ---------- non-blocking / no streaming-loop throw ----------

describe('ERC-3 / M-052 — non-blocking, never throws to streaming loop', () => {
  it('enqueue is synchronous and does not perform disk I/O (returns result immediately)', () => {
    const buffer = createLocalDiagnosticBuffer(validPolicy());
    // 10k 入队必须在有界时间内同步完成,证明非阻塞 / 无磁盘 I/O。
    const events: ComponentTelemetryEvent[] = [];
    for (let i = 0; i < 10_000; i++) {
      events.push(componentEvent());
    }
    const t0 = Date.now();
    for (const e of events) {
      const r = buffer.enqueue(e);
      // 每次调用都同步返回 EnqueueResult,不抛出、不返回 Promise。
      expect(typeof r).toBe('object');
      expect(r).not.toBeInstanceOf(Promise);
    }
    const elapsed = Date.now() - t0;
    // 10k 次入队(全部 enqueued 或 drop_full),elapsed 必须有界 ——
    // 如果每次都做磁盘 I/O,这里会远超 1 秒。
    expect(elapsed).toBeLessThan(1000);
  });

  it('enqueue never throws on internal error (returns drop result instead)', () => {
    const buffer = createLocalDiagnosticBuffer(validPolicy());
    // 构造一个访问任意属性就抛错的事件,模拟"内部异常"路径。
    const throwingEvent = new Proxy(
      {},
      {
        get(): never {
          throw new Error('simulated internal error');
        },
      },
    ) as unknown as ComponentTelemetryEvent;

    let result: EnqueueResult;
    expect(() => {
      result = buffer.enqueue(throwingEvent);
    }).not.toThrow();
    // 内部异常必须返回 drop 结果,而非抛到 streaming loop。
    expect(result!).toBeDefined();
    expect([
      'dropped_invalid',
      'dropped_disabled',
      'dropped_full',
    ]).toContain(result!.status);
    expect(result!.queued_event_id).toBeNull();
    // buffer 自身状态保持可观测,不崩。
    expect(['active', 'degraded', 'disabled']).toContain(
      buffer.snapshot().state,
    );
  });

  it('buffer remains usable after an internal-error event', () => {
    const buffer = createLocalDiagnosticBuffer(validPolicy());
    const throwingEvent = new Proxy(
      {},
      {
        get(): never {
          throw new Error('simulated internal error');
        },
      },
    ) as unknown as ComponentTelemetryEvent;
    buffer.enqueue(throwingEvent);

    // 后续合法 event 仍可入队(buffer 状态保持 active / 可恢复)。
    const good = componentEvent();
    const result = buffer.enqueue(good);
    // 在 internal error 之后,要么仍 active 接受 good,要么进入 degraded 拒绝;
    // 两种都是合法的 streaming-loop-safe 行为,关键是"不抛 + 状态确定"。
    expect([
      'enqueued',
      'dropped_invalid',
      'dropped_disabled',
    ]).toContain(result.status);
  });
});

// ---------- defensive: no body field ----------

describe('ERC-3 / M-052 — defensive raw-body guard', () => {
  it('rejects event that carries a content_body field (defensive guard)', () => {
    const buffer = createLocalDiagnosticBuffer(validPolicy());
    const valid = componentEvent();
    // 注入一个 content_body 字段(模拟未来协议误带 body 的防御性场景)。
    const withBody = {
      ...valid,
      content_body: 'SECRET-RAW-PAYLOAD',
    } as unknown as ComponentTelemetryEvent;
    const result = buffer.enqueue(withBody);
    expect([
      'dropped_invalid',
      'dropped_disabled',
    ]).toContain(result.status);
    expect(buffer.inspectForTest().has_raw_payload).toBe(false);
    // inspectForTest 不应包含 raw body 内容。
    expect(JSON.stringify(buffer.inspectForTest())).not.toContain(
      'SECRET-RAW-PAYLOAD',
    );
  });
});

// ---------- inspectForTest contract ----------

describe('ERC-3 / M-052 — inspectForTest contract', () => {
  it('inspectForTest exposes only event_ids and has_raw_payload, never payloads', () => {
    const buffer = createLocalDiagnosticBuffer(validPolicy());
    const event = componentEvent();
    buffer.enqueue(event);
    const inspection = buffer.inspectForTest();
    expect(inspection.event_ids).toEqual([event.event_id]);
    expect(inspection.has_raw_payload).toBe(false);
    // inspection 上不应该出现 payload-bearing 字段。
    expect(inspection).not.toHaveProperty('sanitized_payload_ref');
    expect(inspection).not.toHaveProperty('redaction_result_ref');
    expect(inspection).not.toHaveProperty('payload');
  });
});
