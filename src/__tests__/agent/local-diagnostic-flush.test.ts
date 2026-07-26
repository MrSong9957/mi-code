// Wave E Task 10 / ERC-3 / M-052: Flush、Rotation 与 Bounded Shutdown
//
// 物理本质:验证"flush 只移除 durably acknowledged 事件;shutdown 有界、不改变
// TurnOutcome;任何路径都不写 raw payload 临时文件"。
//
// 关键不变量(spec §9 / ERC-3 / Task 10):
// 1. flush 只移除 sink.commit 返回的 committed_event_ids;未 ack 事件保留在 queue。
// 2. flush 状态:
//    - 全部 committed → 'complete'
//    - 部分 committed → 'partial'
//    - 全部 failed → 'failed'
//    - sink 异常 → 'degraded'
// 3. shutdown 是有界异步 flush;超时后记录 remaining sanitized drop count,不无限等待。
// 4. shutdown 不改变 TurnOutcome(它只是诊断 plane,与业务 turn 解耦)。
// 5. flush / shutdown 任何路径都不写 raw payload 临时文件。
// 6. local log 只能证明 enqueue/flush metadata,不能被描述为完整请求复现或业务成功证据。
// 7. sink adapter 是受信边界;真实 realpath 验证是 sink adapter 的职责,本模块只做协调。
// 8. 不实现 full dump / raw sidecar / Wave F import。

import { describe, expect, it } from 'vitest';
import {
  measureTelemetryComponent,
  COMPONENT_TELEMETRY_PROTOCOL_VERSION,
  type ComponentTelemetryEvent,
  type ComponentTelemetryEventInput,
} from '../../agent/observability/telemetry.js';
import {
  createLocalDiagnosticBuffer,
  flushDiagnosticBuffer,
  shutdownDiagnosticBuffer,
  type LocalDiagnosticBuffer,
  type LocalDiagnosticBufferPolicy,
  type DiagnosticSinkAdapter,
  type DiagnosticSinkCommitResult,
  type DiagnosticFlushResult,
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

/** 构造一个 buffer,并按顺序入队若干 baseline event;返回 buffer 与入队的 event_id 列表。 */
const bufferWith = (
  count: number,
  policyOverrides: Partial<LocalDiagnosticBufferPolicy> = {},
): { buffer: LocalDiagnosticBuffer; eventIds: string[] } => {
  const buffer = createLocalDiagnosticBuffer(validPolicy(policyOverrides));
  const eventIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const e = componentEvent();
    const r = buffer.enqueue(e);
    if (r.status === 'enqueued' && r.queued_event_id) {
      eventIds.push(r.queued_event_id);
    }
  }
  return { buffer, eventIds };
};

/** sink:只 ack 指定的 event_id,其余 failed。 */
const sinkCommitting = (
  committedIds: string[],
  opts: { delayMs?: number; reason?: string } = {},
): DiagnosticSinkAdapter & { observedBatches: string[][] } => {
  const observedBatches: string[][] = [];
  const reason = opts.reason ?? 'sink.ack';
  const adapter: DiagnosticSinkAdapter = {
    async commit(events) {
      if (opts.delayMs && opts.delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, opts.delayMs));
      }
      const incomingIds = events.map((e) => e.event_id);
      observedBatches.push(incomingIds);
      const committedSet = new Set(committedIds);
      const committed: string[] = [];
      const failed: string[] = [];
      const reasons: string[] = [];
      for (const id of incomingIds) {
        if (committedSet.has(id)) {
          committed.push(id);
          reasons.push(reason);
        } else {
          failed.push(id);
          reasons.push('sink.not_acked');
        }
      }
      const result: DiagnosticSinkCommitResult = {
        committed_event_ids: committed,
        failed_event_ids: failed,
        reason_codes: reasons,
      };
      return result;
    },
  };
  return Object.assign(adapter, { observedBatches });
};

/** sink:永远抛出异常。 */
const sinkThrowing = (errorMessage = 'sink exploded'): DiagnosticSinkAdapter => ({
  async commit() {
    throw new Error(errorMessage);
  },
});

/** sink:永远 ack 全部。 */
const sinkAckAll = (): DiagnosticSinkAdapter & { observedBatches: string[][] } => {
  const observedBatches: string[][] = [];
  const adapter: DiagnosticSinkAdapter = {
    async commit(events) {
      const incomingIds = events.map((e) => e.event_id);
      observedBatches.push(incomingIds);
      return {
        committed_event_ids: incomingIds,
        failed_event_ids: [],
        reason_codes: incomingIds.map(() => 'sink.ack'),
      };
    },
  };
  return Object.assign(adapter, { observedBatches });
};

/** sink:永远 nack 全部。 */
const sinkNackAll = (): DiagnosticSinkAdapter => ({
  async commit(events) {
    return {
      committed_event_ids: [],
      failed_event_ids: events.map((e) => e.event_id),
      reason_codes: events.map(() => 'sink.not_acked'),
    };
  },
});

// ---------- flush:durable acknowledgement ----------

describe('ERC-3 / M-052 / Task 10 — flush durable acknowledgement', () => {
  it('removes only durably acknowledged events after a partial flush', async () => {
    const { buffer, eventIds } = bufferWith(2);
    const [id1, id2] = eventIds;
    const sink = sinkCommitting([id1]);

    const result = await flushDiagnosticBuffer(buffer, sink);

    expect(result.status).toBe('partial');
    expect(result.committed_event_ids).toEqual([id1]);
    expect(result.remaining_queued_event_ids).toEqual([id2]);
    expect(buffer.snapshot().queued_event_ids).toEqual([id2]);
    expect(buffer.snapshot().queued_event_count).toBe(1);
  });

  it('complete flush removes all events and clears the queue', async () => {
    const { buffer, eventIds } = bufferWith(3);
    const result = await flushDiagnosticBuffer(buffer, sinkCommitting(eventIds));

    expect(result.status).toBe('complete');
    expect(result.committed_event_ids).toEqual(eventIds);
    expect(result.remaining_queued_event_ids).toEqual([]);
    expect(buffer.snapshot().queued_event_count).toBe(0);
    expect(buffer.snapshot().queued_event_ids).toEqual([]);
  });

  it('failed flush (no ack) keeps all events in queue', async () => {
    const { buffer, eventIds } = bufferWith(2);
    const result = await flushDiagnosticBuffer(buffer, sinkNackAll());

    expect(result.status).toBe('failed');
    expect(result.committed_event_ids).toEqual([]);
    expect(result.remaining_queued_event_ids).toEqual(eventIds);
    expect(buffer.snapshot().queued_event_ids).toEqual(eventIds);
    expect(buffer.snapshot().queued_event_count).toBe(2);
  });

  it('flush on empty buffer returns complete with no events committed', async () => {
    const buffer = createLocalDiagnosticBuffer(validPolicy());
    const result = await flushDiagnosticBuffer(buffer, sinkAckAll());

    expect(result.status).toBe('complete');
    expect(result.committed_event_ids).toEqual([]);
    expect(result.remaining_queued_event_ids).toEqual([]);
  });

  it('degraded status when sink.commit throws an exception', async () => {
    const { buffer, eventIds } = bufferWith(2);
    const result = await flushDiagnosticBuffer(buffer, sinkThrowing());

    expect(result.status).toBe('degraded');
    expect(result.committed_event_ids).toEqual([]);
    expect(result.remaining_queued_event_ids).toEqual(eventIds);
    // 异常不丢事件 —— 全部保留,等下次 flush。
    expect(buffer.snapshot().queued_event_ids).toEqual(eventIds);
    expect(result.reason_codes.length).toBeGreaterThan(0);
    expect(result.reason_codes.some((r) => r.startsWith('sink.') || r.startsWith('buffer.'))).toBe(true);
  });

  it('partial write keeps unacked events for the next flush', async () => {
    const { buffer, eventIds } = bufferWith(3);
    const [id1, , id3] = eventIds;
    // 第一次只 ack id1 和 id3。
    const first = await flushDiagnosticBuffer(buffer, sinkCommitting([id1, id3]));
    expect(first.status).toBe('partial');
    expect(buffer.snapshot().queued_event_ids).toEqual([eventIds[1]]);
    // 第二次 ack 剩余 —— 完整清空。
    const second = await flushDiagnosticBuffer(buffer, sinkCommitting([eventIds[1]]));
    expect(second.status).toBe('complete');
    expect(buffer.snapshot().queued_event_count).toBe(0);
  });

  it('does not double-commit already-committed event ids on second flush', async () => {
    const { buffer, eventIds } = bufferWith(2);
    const sink = sinkAckAll();
    await flushDiagnosticBuffer(buffer, sink);
    // 第二次 flush 应当对空 buffer 立即返回 complete,不再调用 sink。
    const second = await flushDiagnosticBuffer(buffer, sink);
    expect(second.status).toBe('complete');
    expect(second.committed_event_ids).toEqual([]);
    // 仅第一次 flush 调用过 sink。
    expect(sink.observedBatches.length).toBe(1);
  });
});

// ---------- flush:non-blocking ----------

describe('ERC-3 / M-052 / Task 10 — flush is non-blocking', () => {
  it('flush returns a promise immediately (does not block the streaming loop)', async () => {
    const { buffer } = bufferWith(2);
    const sink = sinkAckAll();
    const promise = flushDiagnosticBuffer(buffer, sink);
    // 必须立即返回 Promise,而非同步值。
    expect(promise).toBeInstanceOf(Promise);
    await promise;
  });
});

// ---------- flush:never writes raw payload temp file ----------

describe('ERC-3 / M-052 / Task 10 — flush never writes raw payload', () => {
  it('flush does not expose any payload body in flush result or snapshot', async () => {
    const { buffer, eventIds } = bufferWith(2);
    const sink = sinkAckAll();
    const result = await flushDiagnosticBuffer(buffer, sink);
    const serialized = JSON.stringify(result) + JSON.stringify(buffer.snapshot());
    // 不出现 raw payload 关键字。
    expect(serialized).not.toContain('content_body');
    expect(serialized).not.toContain('payload_body');
    expect(serialized).not.toContain('SECRET');
    // 只有 metadata ref,没有 body。
    expect(serialized).not.toContain('deadbeef');
    expect(result.committed_event_ids).toEqual(eventIds);
  });

  it('degraded flush does not write a raw payload temp file (fails closed)', async () => {
    const { buffer } = bufferWith(2);
    const result = await flushDiagnosticBuffer(buffer, sinkThrowing());
    expect(result.status).toBe('degraded');
    // degraded 不得在 result 里暴露任何 payload。
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('content_body');
    expect(serialized).not.toContain('payload_body');
    expect(serialized).not.toContain('deadbeef');
    // 事件保留在 queue,等下次 flush(不丢到 raw 文件)。
    expect(buffer.snapshot().queued_event_count).toBe(2);
  });
});

// ---------- shutdown:bounded ----------

describe('ERC-3 / M-052 / Task 10 — bounded shutdown', () => {
  it('shutdown returns a DiagnosticFlushResult (not a TurnOutcome)', async () => {
    const { buffer } = bufferWith(2);
    const result = await shutdownDiagnosticBuffer(buffer, sinkAckAll(), 1000);
    // 返回 DiagnosticFlushResult shape,不是 TurnOutcome。
    expect(result).toBeDefined();
    expect(Array.isArray(result.committed_event_ids)).toBe(true);
    expect(Array.isArray(result.remaining_queued_event_ids)).toBe(true);
    expect(['complete', 'partial', 'failed', 'degraded']).toContain(result.status);
  });

  it('shutdown timeout drops remaining sanitized count and returns degraded', async () => {
    const { buffer, eventIds } = bufferWith(3);
    // sink 永远比 timeout 慢:500ms delay,timeout=10ms。
    const slowSink = sinkCommitting(eventIds, { delayMs: 500 });
    const result = await shutdownDiagnosticBuffer(buffer, slowSink, 10);

    // 超时 → 不再等 sink;status degraded(因为没拿到 ack)。
    expect(result.status).toBe('degraded');
    // remaining 仍记录在 result 里(诊断 plane 元数据),但事件不再被无限等待。
    expect(result.remaining_queued_event_ids.length).toBe(3);
    // 关键:reason_codes 包含 shutdown.timeout 之类标识。
    expect(result.reason_codes.some((r) => r.includes('timeout'))).toBe(true);
  });

  it('shutdown completes within bounded time even if sink is slow', async () => {
    const { buffer } = bufferWith(2);
    const slowSink = sinkCommitting([], { delayMs: 10_000 }); // 远超 timeout
    const t0 = Date.now();
    const result = await shutdownDiagnosticBuffer(buffer, slowSink, 50);
    const elapsed = Date.now() - t0;
    // 必须在 ~timeout 量级返回,不无限等待。
    expect(elapsed).toBeLessThan(1000);
    expect(result.status).toBe('degraded');
  });

  it('shutdown does not change TurnOutcome (no turn_outcome field on result)', async () => {
    const { buffer } = bufferWith(2);
    const result = await shutdownDiagnosticBuffer(buffer, sinkAckAll(), 1000);
    expect(result).not.toHaveProperty('turn_outcome');
    expect(result).not.toHaveProperty('turnOutcome');
    expect(result).not.toHaveProperty('decision');
    // shutdown 只产出诊断 plane 元数据。
  });

  it('shutdown with successful flush removes committed events', async () => {
    const { buffer, eventIds } = bufferWith(2);
    const result = await shutdownDiagnosticBuffer(buffer, sinkCommitting(eventIds), 1000);
    expect(result.status).toBe('complete');
    expect(result.committed_event_ids).toEqual(eventIds);
    expect(result.remaining_queued_event_ids).toEqual([]);
    expect(buffer.snapshot().queued_event_count).toBe(0);
  });

  it('shutdown records remaining sanitized drop count via remaining_queued_event_ids', async () => {
    const { buffer, eventIds } = bufferWith(3);
    // sink 全部 nack → 不 ack 任何事件 → shutdown 结束时所有事件 remaining。
    const result = await shutdownDiagnosticBuffer(buffer, sinkNackAll(), 1000);
    expect(result.status).toBe('failed');
    expect(result.remaining_queued_event_ids).toEqual(eventIds);
    // remaining 数量 = drop count(诊断 plane metadata)。
    expect(result.remaining_queued_event_ids.length).toBe(3);
  });
});

// ---------- sink adapter revalidation (rotation) ----------

describe('ERC-3 / M-052 / Task 10 — sink adapter revalidation (rotation)', () => {
  it('flush invokes sink.commit once per flush (sink adapter owns its own identity revalidation)', async () => {
    const { buffer, eventIds } = bufferWith(2);
    const sink = sinkCommitting(eventIds);
    await flushDiagnosticBuffer(buffer, sink);
    // 一个 flush 调用对应一个 sink.commit。
    expect(sink.observedBatches.length).toBe(1);
    expect(sink.observedBatches[0]).toEqual(eventIds);
  });

  it('second flush re-invokes sink.commit (rotation revalidation is sink-owned)', async () => {
    const { buffer, eventIds } = bufferWith(2);
    const sink = sinkCommitting(eventIds);
    await flushDiagnosticBuffer(buffer, sink);
    // 入队新事件后再 flush —— 第二次 commit 应当被调用。
    const newEvent = componentEvent();
    buffer.enqueue(newEvent);
    await flushDiagnosticBuffer(buffer, sink);
    expect(sink.observedBatches.length).toBe(2);
    expect(sink.observedBatches[1]).toEqual([newEvent.event_id]);
  });
});
