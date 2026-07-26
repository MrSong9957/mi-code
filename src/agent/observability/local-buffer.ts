// M-052 Sanitized Bounded Local Buffer (Wave E / ERC-3 / T9)
//
// 物理本质:"有界、非阻塞、只接受已清洗事件的本地诊断 buffer"。
// 把 DRC-4 已清洗、允许进入本地 debug plane 的事件写入有界、非阻塞内存队列,
// 由 Wave E Task 10 的 flush/rotation/retention 模块按受信 policy 输出到本地诊断文件。
//
// 关键不变量(spec §9 / ERC-3 / Task 9):
// 1. 只有 CRC-6/DRC-4 已清洗事件(redaction_result_ref 非空)可以入队。
// 2. raw/dropped payload 不得进入内存队列 / 临时文件 / retry sidecar。
//    buffer 永不持有原始 ComponentTelemetryEvent 引用 —— 入队时只拷贝出 ref / metadata。
// 3. overflow 固定 drop_newest,只增加最小 drop counter;
//    不保留 dropped payload 的 hash / slice / temporary copy / retry closure。
// 4. enqueue 只操作内存队列,不执行磁盘 I/O,不阻塞 streaming loop。
// 5. policy disabled / sink location 不可信 / capacity 非法 → state='disabled'。
// 6. enqueue 内部异常 / sink 未提供时,立即返回 drop 结果,不抛到 streaming loop。
// 7. queue order 按 (enqueued_at, event_id) 确定顺序。
// 8. duplicate source event_id 不重复写入。
// 9. 不实现 full dump / raw sidecar / 远程 sink / Wave F import。
//    Flush / rotation / retention / shutdown 在 Task 10 实现 —— 本文件不涉及。

import type { ComponentTelemetryEvent } from './telemetry.js';

// ============================================================================
// 公共类型(规格 §9.2 / §9.3 / §9.4,Task 9 接口)
// ============================================================================

/** 受信本地 logging policy(来自受信配置;用户内容/Prompt/模型不得修改)。 */
export interface LocalDiagnosticBufferPolicy {
  policy_id: string;
  policy_version: string;
  enabled: boolean;
  /** 受信 local log root(由 T10 flush 时验证 sink identity / symlink / path escape)。 */
  sink_location_ref: string;
  max_queued_events: number;
  max_queued_bytes: number;
}

/** Buffer 可观测状态。flushing/closed 由 Task 10 引入;本文件只用 active/disabled/degraded。 */
export type BufferState = 'active' | 'disabled' | 'degraded';

/**
 * 入队后的 buffered event。仅保留 ref / correlation / level / byte count / enqueue time。
 * **永不**保存 ComponentTelemetryEvent 原引用,也不保存任何 payload body。
 */
export interface BufferedDiagnosticEvent {
  event_id: string; // 来自 ComponentTelemetryEvent
  sanitized_payload_ref: string;
  redaction_result_ref: string;
  request_snapshot_id: string;
  component_id: string;
  level: 'info' | 'warn' | 'error';
  byte_count: number;
  /** ISO 8601 timestamp。队列按 (enqueued_at, event_id) 排序依据之一。 */
  enqueued_at: string;
}

/** enqueue 返回结果。streaming-loop-safe —— 永远同步返回,不抛出。 */
export interface EnqueueResult {
  status: 'enqueued' | 'dropped_full' | 'dropped_disabled' | 'dropped_invalid';
  queued_event_id: string | null;
  reason_codes: string[];
}

/** buffer 外部可观测快照。不暴露任何 payload。 */
export interface BufferSnapshot {
  state: BufferState;
  queued_event_count: number;
  queued_event_ids: string[];
  queued_byte_count: number;
  dropped_count: number;
}

/** 仅供测试检视(不导出 payload)。 */
export interface LocalBufferInspection {
  event_ids: string[];
  /** 永远是 false —— 因为 buffer 永不存储 raw payload。 */
  has_raw_payload: boolean;
}

/** buffer 对象。所有方法同步、非阻塞、不抛到 streaming loop。 */
export interface LocalDiagnosticBuffer {
  enqueue(event: ComponentTelemetryEvent): EnqueueResult;
  snapshot(): BufferSnapshot;
  /** 仅供测试检视(不导出 payload)。生产代码不应依赖此方法。 */
  inspectForTest(): LocalBufferInspection;
  /**
   * 取出当前 queued events 的只读拷贝,供 flush 协调器传给 sink adapter。
   * **不**移除事件;移除由 `acknowledgeCommittedEventIds` 完成。
   * 仅供 flush/shutdown 协调器使用 —— 不是 public streaming-loop API。
   */
  peekQueuedEventsForFlush(): readonly BufferedDiagnosticEvent[];
  /**
   * 移除已被 sink durably acknowledged 的 event_id,并返回实际被移除的 id 集合
   * (用于区分"ack 了不存在的 id"与"真正移除的")。
   * 只移除仍在 queue 中的 id —— 安全、幂等、不抛出。
   */
  acknowledgeCommittedEventIds(
    committedEventIds: ReadonlyArray<string>,
  ): string[];
}

// ============================================================================
// Flush / Shutdown 类型(Task 10)
// ============================================================================

/**
 * 受信 sink adapter:接收已清洗 event,返回 durably committed acknowledgement。
 *
 * **职责边界**:本模块不实现完整 realpath / symlink / path escape 验证。
 * 那是 sink adapter 的职责 —— adapter 可以是 mock(测试)或真实 pino/fs adapter
 * (生产,内部完成 sink_location_ref 的受信解析与写入 + flush + sync)。
 * 本模块只做协调:取 events、调 commit、按 ack 移除事件。
 */
export interface DiagnosticSinkAdapter {
  /**
   * 接收一批已清洗 buffered event,执行 durably committed 写入,
   * 返回 committed / failed event ids + reason codes。
   *
   * 实现方抛出异常时,flush 协调器视为 degraded(全部事件保留,不丢到 raw 文件)。
   */
  commit(
    events: ReadonlyArray<BufferedDiagnosticEvent>,
  ): Promise<DiagnosticSinkCommitResult>;
}

/** sink commit 返回结果。 */
export interface DiagnosticSinkCommitResult {
  committed_event_ids: string[];
  failed_event_ids: string[];
  reason_codes: string[];
}

/** flush / shutdown 返回结果。 */
export interface DiagnosticFlushResult {
  /**
   * - 'complete':所有 queued events 都 durably committed
   * - 'partial':部分 committed(未 ack 的保留在 queue)
   * - 'failed':全部 failed(全部保留在 queue)
   * - 'degraded':sink 异常或 shutdown 超时(全部保留在 queue)
   */
  status: 'complete' | 'partial' | 'failed' | 'degraded';
  /** 本次 flush 被 sink durably acknowledged 的 event_id(已从 queue 移除)。 */
  committed_event_ids: string[];
  /** 仍在 queue 中(未 ack / failed / sink 异常 / shutdown 超时)的 event_id。 */
  remaining_queued_event_ids: string[];
  /** 诊断 reason codes(无 payload)。 */
  reason_codes: string[];
}

// ============================================================================
// 内部实现
// ============================================================================

/** Buffered event 使用的内部协议版本(外部可断言)。 */
const BUFFERED_EVENT_PROTOCOL_VERSION = '1';

/**
 * 构造一个 local diagnostic buffer。
 *
 * state 判定(spec §9.5 rule 1 / §9.9):
 * - policy.enabled === false → disabled
 * - sink_location_ref 空 / 仅空白 → disabled(sink 不可信)
 * - max_queued_events 或 max_queued_bytes <= 0 → disabled(capacity 非法)
 * - 否则 active
 */
export function createLocalDiagnosticBuffer(
  policy: LocalDiagnosticBufferPolicy,
): LocalDiagnosticBuffer {
  const state = computeInitialState(policy);

  // 队列:按入队顺序保存(等效 (enqueued_at, event_id),因为后者是单调递增的)。
  // **永不**保存 ComponentTelemetryEvent 原引用 —— 入队时只拷贝 ref/metadata。
  const queue: BufferedDiagnosticEvent[] = [];
  let queuedByteCount = 0;
  let droppedCount = 0;
  // 已入队的 event_id 集合 —— O(1) dedup 检查。
  const enqueuedEventIds = new Set<string>();

  function isCapacityAvailable(eventByteCount: number): boolean {
    if (queue.length >= policy.max_queued_events) return false;
    if (queuedByteCount + eventByteCount > policy.max_queued_bytes) return false;
    return true;
  }

  function enqueueImpl(event: ComponentTelemetryEvent): EnqueueResult {
    // Rule 1: state !== 'active' → 拒绝(spec §9.5 rule 1 / §9.9)。
    const currentState = state;
    if (currentState !== 'active') {
      return {
        status: 'dropped_disabled',
        queued_event_id: null,
        reason_codes: ['buffer.not_active'],
      };
    }

    // 防御性:拒绝带 content_body 字段的事件(防御未来协议误带 body)。
    // 使用 Object.prototype.hasOwnProperty 而非 in / 访问字段,避免 Proxy 异常。
    if (hasRawBodyField(event)) {
      return {
        status: 'dropped_invalid',
        queued_event_id: null,
        reason_codes: ['buffer.raw_body_present'],
      };
    }

    // 提取事件字段(防御性 —— 全程用 safeString/safeNumber,不抛)。
    const eventId = safeString(event?.event_id);
    const redactionResultRef = safeString(event?.redaction_result_ref);

    // Rule 2: 必须 sanitized —— redaction_result_ref 非空。
    if (redactionResultRef.length === 0) {
      return {
        status: 'dropped_invalid',
        queued_event_id: null,
        reason_codes: ['buffer.unsanitized_event'],
      };
    }

    // Rule 8: duplicate event_id 去重(spec §9.5 rule 8)。
    if (eventId.length > 0 && enqueuedEventIds.has(eventId)) {
      return {
        status: 'dropped_invalid',
        queued_event_id: null,
        reason_codes: ['buffer.duplicate_event_id'],
      };
    }

    // 必要身份字段缺失 → invalid(防御性:measureTelemetryComponent 已保证,
    // 但 buffer 是独立 gate,不能假设上游永远合法)。
    if (eventId.length === 0) {
      return {
        status: 'dropped_invalid',
        queued_event_id: null,
        reason_codes: ['buffer.missing_event_id'],
      };
    }

    const byteCount = safeNonNegInt(event?.byte_count);
    if (byteCount === null) {
      return {
        status: 'dropped_invalid',
        queued_event_id: null,
        reason_codes: ['buffer.invalid_byte_count'],
      };
    }

    // Rule 4: 容量检查(固定 drop_newest)。
    if (!isCapacityAvailable(byteCount)) {
      droppedCount += 1;
      // **不**保存 dropped payload 的 hash / slice / temporary copy / retry closure。
      return {
        status: 'dropped_full',
        queued_event_id: null,
        reason_codes: ['buffer.queue_full'],
      };
    }

    // Rule 9: 入队 —— 只拷贝 ref/metadata,不持有原 event 引用,不持有 payload。
    // 推导 level:ComponentTelemetryEvent 无 level 字段 —— 这里用 'info' 作为默认
    // (spec §9.5 rule 3 的 minimum_level 过滤由 Task 10 flush 时按 logging policy 做,
    //  本 buffer 的 policy 只控制 queue 容量,不感知 minimum_level)。
    const buffered: BufferedDiagnosticEvent = {
      event_id: eventId,
      sanitized_payload_ref: '', // DRC-4 event 无 sanitized_payload_ref 字段;留空表示
      //   "sanitized payload 即 event 自身的 metadata-only 字段集,
      //    通过 redaction_result_ref 证明已清洗"。
      redaction_result_ref: redactionResultRef,
      request_snapshot_id: safeString(event?.request_snapshot_id),
      component_id: safeString(event?.component_ref?.component_id),
      level: deriveLevel(event),
      byte_count: byteCount,
      enqueued_at: new Date().toISOString(),
    };

    queue.push(buffered);
    queuedByteCount += byteCount;
    enqueuedEventIds.add(eventId);

    return {
      status: 'enqueued',
      queued_event_id: eventId,
      reason_codes: [],
    };
  }

  function enqueue(event: ComponentTelemetryEvent): EnqueueResult {
    // Rule 10: enqueue failure 不阻塞 streaming loop(spec §9.5 rule 10 / §9.9)。
    // 任何内部异常被吞掉,返回 degraded drop 结果;state 可能转为 degraded。
    try {
      return enqueueImpl(event);
    } catch {
      // 内部异常 → minimal 计数,不递归记录完整异常 payload(§9.9)。
      droppedCount += 1;
      // 不改变 state 到 'closed'/'flushing'(那是 Task 10 职责);
      // 保持原 state 以便 streaming loop 继续。
      return {
        status: 'dropped_invalid',
        queued_event_id: null,
        reason_codes: ['buffer.internal_error'],
      };
    }
  }

  function snapshot(): BufferSnapshot {
    return {
      state,
      queued_event_count: queue.length,
      queued_event_ids: queue.map((e) => e.event_id),
      queued_byte_count: queuedByteCount,
      dropped_count: droppedCount,
    };
  }

  function inspectForTest(): LocalBufferInspection {
    return {
      event_ids: queue.map((e) => e.event_id),
      // 永远 false —— buffer 永不存储 raw payload。
      has_raw_payload: false,
    };
  }

  function peekQueuedEventsForFlush(): readonly BufferedDiagnosticEvent[] {
    // 返回浅拷贝 —— flush 协调器拿到的是不可变快照,不会因后续 enqueue 改变迭代。
    // **只**拷贝 ref/metadata(BufferedDiagnosticEvent 本就不含 payload)。
    return queue.slice();
  }

  function acknowledgeCommittedEventIds(
    committedEventIds: ReadonlyArray<string>,
  ): string[] {
    if (committedEventIds.length === 0) return [];
    const committedSet = new Set(committedEventIds);
    const removed: string[] = [];
    // 单次遍历过滤 —— O(n),保留未 ack 事件、累加移除事件的 byte_count 扣减。
    let removedBytes = 0;
    const remaining: BufferedDiagnosticEvent[] = [];
    for (const ev of queue) {
      if (committedSet.has(ev.event_id)) {
        removed.push(ev.event_id);
        removedBytes += ev.byte_count;
        enqueuedEventIds.delete(ev.event_id);
      } else {
        remaining.push(ev);
      }
    }
    if (removed.length > 0) {
      // 原地替换队列内容(保持引用语义 —— queue 是闭包内的可变数组)。
      queue.length = 0;
      for (const ev of remaining) queue.push(ev);
      queuedByteCount -= removedBytes;
      if (queuedByteCount < 0) queuedByteCount = 0;
    }
    return removed;
  }

  return {
    enqueue,
    snapshot,
    inspectForTest,
    peekQueuedEventsForFlush,
    acknowledgeCommittedEventIds,
  };
}

/**
 * 顶层 enqueue 函数式 API(规格 Task 9 产出之一)。
 *
 * 等效于 `buffer.enqueue(event)`。提供函数式调用形式便于不依赖对象引用的调用方。
 * 语义、不变量、错误处理与 `LocalDiagnosticBuffer.enqueue` 完全一致。
 */
export function enqueueDiagnosticEvent(
  buffer: LocalDiagnosticBuffer,
  event: ComponentTelemetryEvent,
): EnqueueResult {
  return buffer.enqueue(event);
}

// ============================================================================
// Flush / Shutdown 协调器(Task 10)
// ============================================================================
//
// 物理本质:"把 queued 已清洗事件交给受信 sink adapter,按 durable acknowledgement
// 移除已 committed 事件;shutdown 有界、不改变 TurnOutcome"。
//
// 关键不变量(spec §9 / ERC-3 / Task 10):
// 1. flush 只移除 sink.commit 返回的 committed_event_ids;未 ack 事件保留在 queue。
// 2. flush 状态:
//    - 全部 committed → 'complete'
//    - 部分 committed → 'partial'
//    - 全部 failed → 'failed'
//    - sink 异常 → 'degraded'
// 3. shutdown 是有界异步 flush;超时后记录 remaining sanitized drop count,不无限等待。
// 4. shutdown 不改变 TurnOutcome —— 只产出 DiagnosticFlushResult(诊断 plane 元数据)。
// 5. flush / shutdown 任何路径都不写 raw payload 临时文件 —— buffer 只持有 ref/metadata,
//    sink adapter 由调用方提供并负责自身的受信写入(本模块不持有 fs / path 引用)。
// 6. local log 只能证明 enqueue/flush metadata,不能被描述为完整请求复现或业务成功证据。
// 7. sink adapter 是受信边界;realpath / symlink / path escape 验证是 sink adapter 的职责。

/**
 * 把 queued 已清洗事件交给受信 sink adapter,按 durable acknowledgement 移除已 committed 事件。
 *
 * 算法:
 * 1. peek 取出当前 queued events(浅拷贝,只 ref/metadata)
 * 2. 调用 sink.commit(events)
 *    - commit 抛异常 → 'degraded',全部事件保留
 * 3. 按 ack.committed_event_ids 调 buffer.acknowledgeCommittedEventIds 移除
 * 4. status:
 *    - 空队列(无可 flush) → 'complete'
 *    - 全部 committed → 'complete'
 *    - 部分 committed → 'partial'
 *    - 全部 failed(0 committed 且 sink 正常返回) → 'failed'
 *    - sink 异常 → 'degraded'
 *
 * flush 不写 raw payload 临时文件 —— buffer 本身不含 payload,sink adapter 由调用方提供。
 */
export async function flushDiagnosticBuffer(
  buffer: LocalDiagnosticBuffer,
  sink: DiagnosticSinkAdapter,
): Promise<DiagnosticFlushResult> {
  const queued = buffer.peekQueuedEventsForFlush();
  const queuedIds = queued.map((e) => e.event_id);

  // 空队列 —— 立即 complete,不调用 sink(避免无谓 commit)。
  if (queued.length === 0) {
    return {
      status: 'complete',
      committed_event_ids: [],
      remaining_queued_event_ids: [],
      reason_codes: [],
    };
  }

  let commitResult: DiagnosticSinkCommitResult;
  try {
    commitResult = await sink.commit(queued);
  } catch {
    // sink 异常 → degraded。事件全部保留,不丢到 raw 文件,等下次 flush。
    return {
      status: 'degraded',
      committed_event_ids: [],
      remaining_queued_event_ids: buffer.snapshot().queued_event_ids,
      reason_codes: ['sink.commit_threw', 'buffer.degraded'],
    };
  }

  // 防御性:ack 字段缺失时归一为空数组(不信任 sink 返回 shape)。
  const committedIds = Array.isArray(commitResult?.committed_event_ids)
    ? commitResult.committed_event_ids
    : [];
  const failedIds = Array.isArray(commitResult?.failed_event_ids)
    ? commitResult.failed_event_ids
    : [];
  const sinkReasons = Array.isArray(commitResult?.reason_codes)
    ? commitResult.reason_codes
    : [];

  // 只移除 sink ack 的、且仍在 queue 中的 id(安全幂等)。
  const actuallyRemoved = buffer.acknowledgeCommittedEventIds(committedIds);

  const remainingIds = buffer.snapshot().queued_event_ids;

  // status 判定。
  let status: DiagnosticFlushResult['status'];
  const reasonCodes: string[] = [];
  if (actuallyRemoved.length === queuedIds.length) {
    // 全部 committed。
    status = 'complete';
  } else if (actuallyRemoved.length > 0) {
    // 部分 committed。
    status = 'partial';
  } else {
    // 0 committed —— 区分 sink 正常 nack(failed)与异常已在上面早返回(degraded)。
    status = 'failed';
  }

  if (failedIds.length > 0) {
    reasonCodes.push('sink.partial_nack');
  }
  for (const r of sinkReasons) {
    if (reasonCodes.length < 8 && !reasonCodes.includes(r)) {
      reasonCodes.push(r);
    }
  }
  if (reasonCodes.length === 0 && status !== 'complete') {
    reasonCodes.push('buffer.flush_no_ack');
  }

  return {
    status,
    committed_event_ids: actuallyRemoved,
    remaining_queued_event_ids: remainingIds,
    reason_codes: reasonCodes,
  };
}

/**
 * 有界 shutdown:发起异步 flush,超时后记录 remaining sanitized drop count 并结束。
 *
 * 关键不变量:
 * - 不无限等待:timeoutMs 后立即返回 degraded,无论 sink 是否完成。
 * - 不改变 TurnOutcome:返回 DiagnosticFlushResult(诊断 plane 元数据),
 *   没有 turn_outcome / decision / authority 字段。
 * - 超时后 remaining 事件以 event_id 列表形式记录在 remaining_queued_event_ids
 *   ( sanitized drop count 的 metadata 形式 —— 不重建 payload)。
 * - 不写 raw payload 临时文件。
 */
export async function shutdownDiagnosticBuffer(
  buffer: LocalDiagnosticBuffer,
  sink: DiagnosticSinkAdapter,
  timeoutMs: number,
): Promise<DiagnosticFlushResult> {
  // 防御性:timeoutMs 非正 → 视作立即超时(degraded),不阻塞调用方。
  const boundedTimeout =
    typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 0;

  const flushPromise = flushDiagnosticBuffer(buffer, sink);

  // 立即返回 Promise —— 不阻塞 streaming loop(测试断言 instanceof Promise)。
  // 这里用 await 等 flush 或 timeout;调用方拿到的是已 settled 的 result。
  let timeoutFired = false;
  let result: DiagnosticFlushResult;

  if (boundedTimeout === 0) {
    // 立即超时 —— 不等 sink,记录 remaining,返回 degraded。
    timeoutFired = true;
    result = {
      status: 'degraded',
      committed_event_ids: [],
      remaining_queued_event_ids: buffer.snapshot().queued_event_ids,
      reason_codes: ['sink.shutdown_timeout', 'buffer.degraded'],
    };
  } else {
    // 用 Promise.race 实现 bounded 等待;不依赖 AbortSignal 以保持简单可靠。
    const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
      setTimeout(() => resolve({ timedOut: true }), boundedTimeout);
    });

    const raced = await Promise.race([
      flushPromise.then((r) => ({ result: r, timedOut: false as const })),
      timeoutPromise,
    ]);

    if ('result' in raced && raced.timedOut === false) {
      result = raced.result;
    } else {
      timeoutFired = true;
      result = {
        status: 'degraded',
        committed_event_ids: [],
        remaining_queued_event_ids: buffer.snapshot().queued_event_ids,
        reason_codes: ['sink.shutdown_timeout', 'buffer.degraded'],
      };
    }
  }

  // 超时路径:确保 reason_codes 包含 timeout 标识(测试断言)。
  if (timeoutFired && !result.reason_codes.some((r) => r.includes('timeout'))) {
    result = {
      ...result,
      reason_codes: [...result.reason_codes, 'sink.shutdown_timeout'],
    };
  }

  return result;
}

// ============================================================================
// 内部辅助
// ============================================================================

/** 判定 buffer 初始状态(spec §9.5 rule 1 / §9.9)。 */
function computeInitialState(policy: LocalDiagnosticBufferPolicy): BufferState {
  if (!policy?.enabled) return 'disabled';
  if (!isNonEmptyString(policy.sink_location_ref)) return 'disabled';
  if (!isPositiveInt(policy.max_queued_events)) return 'disabled';
  if (!isPositiveInt(policy.max_queued_bytes)) return 'disabled';
  return 'active';
}

/**
 * 防御性 raw body 检测 —— 检查事件自身(非原型链)是否带 content_body / body /
 * payload 字段。
 *
 * 用 Object.prototype.hasOwnProperty.call 而非 `in` 或字段访问,以避免:
 * 1. Proxy 事件的 get trap 抛错。
 * 2. 原型链上同名属性误判。
 */
function hasRawBodyField(event: unknown): boolean {
  if (event === null || typeof event !== 'object') return false;
  const obj = event as Record<string, unknown>;
  return (
    Object.prototype.hasOwnProperty.call(obj, 'content_body') ||
    Object.prototype.hasOwnProperty.call(obj, 'body') ||
    Object.prototype.hasOwnProperty.call(obj, 'payload')
  );
}

/** 推导 level。DRC-4 event 无 level 字段 —— 默认 'info'。 */
function deriveLevel(event: ComponentTelemetryEvent): 'info' | 'warn' | 'error' {
  const explicit = (event as unknown as { level?: unknown }).level;
  if (explicit === 'warn') return 'warn';
  if (explicit === 'error') return 'error';
  return 'info';
}

/** 安全读取字符串字段 —— Proxy 异常 / 非 string 都返回空串。 */
function safeString(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
  } catch {
    // Proxy 抛错 → 视作不可用。
  }
  return '';
}

/** 安全读取有限非负整数 —— 失败返回 null。 */
function safeNonNegInt(value: unknown): number | null {
  try {
    if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      Number.isInteger(value) &&
      value >= 0
    ) {
      return value;
    }
  } catch {
    // Proxy 抛错 → 视作不可用。
  }
  return null;
}

/** 非空字符串(trim 后非空)。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 正整数(capacity 必须 > 0)。 */
function isPositiveInt(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  );
}

/** 协议版本常量导出(外部可断言、未来 flush 模块复用)。 */
export { BUFFERED_EVENT_PROTOCOL_VERSION };
