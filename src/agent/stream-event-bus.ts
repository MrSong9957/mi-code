// 流式事件总线：发布/订阅模式，连接生产者（查询循环）和消费者（渲染器、存储）
//
// 物理本质：广播电台。
// 查询循环是"播音员"，emit 发射信号。
// 渲染器、会话存储是"收音机"，on 监听信号。
// 多个收音机可以同时收听同一个频道，互不干扰。

import { EventEmitter } from 'events';
import type { StreamEvent, AssistantMessage } from './types.js';
import type { StructuredAskResult } from './ask-user-types.js';
import type { ObservabilityEventEnvelope } from './observability/envelopes.js';
// Wave D T11 (DRC-4): 仅引入类型用于 telemetry batch channel 签名。
// 使用 import type 避免运行时依赖(telemetry.ts 不反向依赖本模块,无循环)。
// 真实 listener(写入 local buffer / flush 到 sink)由 Wave E M-052 接入。
import type { ComponentTelemetryBatch } from './observability/telemetry.js';

/** 流式事件类型 */
export type StreamEventType =
  | 'stream_event'        // 原始流式事件（用于实时 token 渲染）
  | 'assistant_message'   // 助手消息完成（用于消息渲染）
  | 'tool_call'           // 工具调用开始（用于工具状态显示）
  | 'tool_result'         // 工具执行结果（用于工具结果显示）
  | 'error'               // 错误事件（用于错误显示）
  | 'loop_end'            // 循环结束（用于清理 UI 状态）
  | 'observability_event' // M-051: 可观测性信封（仅显式 emit,不自动抄送）
  // Wave D T11 (DRC-4): 已通过 CRC-6 gate 的 telemetry batch。
  // 本通道仅用于"显式投递"——caller 必须先用 buildComponentTelemetryBatch
  // 构造 batch,然后显式调用 emitTelemetryBatch。真实 sink listener 由 Wave E 接入。
  | 'telemetry_batch';

/** 工具调用事件数据 */
export interface ToolCallEvent {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  startTime: number;
}

/** 工具结果事件数据 */
export interface ToolResultEvent {
  toolUseId: string;
  name: string;
  output: string;
  duration: number;
  /**
   * AUTO-0025 Phase B (Task 10):结构化问卷结果(仅 ask_user_question 有,走 UI 通道)。
   * undefined 表示该工具无结构化 outcome(绝大多数工具),走通用 Bash 折叠展示。
   */
  structuredOutcome?: StructuredAskResult;
}

/** 错误事件数据 */
export interface ErrorEvent {
  errorType: string;
  message: string;
  recoverable: boolean;
}

/** 循环结束事件数据 */
export interface LoopEndEvent {
  reason: string;
}

/**
 * StreamEventBus
 *
 * 类型安全的事件总线，用于流式事件的发布/订阅。
 * 基于 Node.js EventEmitter 封装，提供类型安全的 emit/on/off 方法。
 */
/** 默认最大监听器数量 */
const DEFAULT_MAX_LISTENERS = 20;

export class StreamEventBus {
  private emitter = new EventEmitter();

  constructor(maxListeners: number = DEFAULT_MAX_LISTENERS) {
    this.emitter.setMaxListeners(maxListeners);
  }

  // ------ stream_event ------
  emitStreamEvent(event: StreamEvent): void {
    this.emitter.emit('stream_event', event);
  }
  onStreamEvent(handler: (event: StreamEvent) => void): void {
    this.emitter.on('stream_event', handler);
  }
  offStreamEvent(handler: (event: StreamEvent) => void): void {
    this.emitter.removeListener('stream_event', handler);
  }

  // ------ assistant_message ------
  emitAssistantMessage(message: AssistantMessage): void {
    this.emitter.emit('assistant_message', message);
  }
  onAssistantMessage(handler: (message: AssistantMessage) => void): void {
    this.emitter.on('assistant_message', handler);
  }
  offAssistantMessage(handler: (message: AssistantMessage) => void): void {
    this.emitter.removeListener('assistant_message', handler);
  }

  // ------ tool_call ------
  emitToolCall(data: ToolCallEvent): void {
    this.emitter.emit('tool_call', data);
  }
  onToolCall(handler: (data: ToolCallEvent) => void): void {
    this.emitter.on('tool_call', handler);
  }
  offToolCall(handler: (data: ToolCallEvent) => void): void {
    this.emitter.removeListener('tool_call', handler);
  }

  // ------ tool_result ------
  emitToolResult(data: ToolResultEvent): void {
    this.emitter.emit('tool_result', data);
  }
  onToolResult(handler: (data: ToolResultEvent) => void): void {
    this.emitter.on('tool_result', handler);
  }
  offToolResult(handler: (data: ToolResultEvent) => void): void {
    this.emitter.removeListener('tool_result', handler);
  }

  // ------ error ------
  emitError(data: ErrorEvent): void {
    this.emitter.emit('error', data);
  }
  onError(handler: (data: ErrorEvent) => void): void {
    this.emitter.on('error', handler);
  }
  offError(handler: (data: ErrorEvent) => void): void {
    this.emitter.removeListener('error', handler);
  }

  // ------ loop_end ------
  emitLoopEnd(data: LoopEndEvent): void {
    this.emitter.emit('loop_end', data);
  }
  onLoopEnd(handler: (data: LoopEndEvent) => void): void {
    this.emitter.on('loop_end', handler);
  }
  offLoopEnd(handler: (data: LoopEndEvent) => void): void {
    this.emitter.removeListener('loop_end', handler);
  }

  // ------ observability_event (M-051) ------
  // 注意:本通道仅用于"显式投递"——caller 必须先用 createObservabilityEnvelope
  // 构造信封,然后显式调用 emitObservabilityEvent。
  // 本总线不会从其它通道(stream_event / tool_call ...)自动抄送到这里,
  // 也不会构造任何 payload 内容。spec §13 BRC-7。
  emitObservabilityEvent(envelope: ObservabilityEventEnvelope): void {
    this.emitter.emit('observability_event', envelope);
  }
  onObservabilityEvent(handler: (envelope: ObservabilityEventEnvelope) => void): void {
    this.emitter.on('observability_event', handler);
  }
  offObservabilityEvent(handler: (envelope: ObservabilityEventEnvelope) => void): void {
    this.emitter.removeListener('observability_event', handler);
  }

  // ------ telemetry_batch (Wave D T11 / DRC-4) ------
  // 注意:本通道仅用于"显式投递已通过 CRC-6 gate 的 batch"。caller 必须先用
  // buildComponentTelemetryBatch 构造 batch(其内部已强制 redaction_result_ref 非空、
  // event identity 完整、snapshot 一致),然后显式调用 emitTelemetryBatch。
  // 本总线不会从其它通道(stream_event / tool_call / observability_event ...)自动抄送,
  // 也不会构造 batch —— INV-D13: dropped event 原文不可由 bus 重新读取。
  // 真实 listener(local buffer / flush / sink)由 Wave E M-052 接入。
  emitTelemetryBatch(batch: ComponentTelemetryBatch): void {
    this.emitter.emit('telemetry_batch', batch);
  }
  onTelemetryBatch(handler: (batch: ComponentTelemetryBatch) => void): void {
    this.emitter.on('telemetry_batch', handler);
  }
  offTelemetryBatch(handler: (batch: ComponentTelemetryBatch) => void): void {
    this.emitter.removeListener('telemetry_batch', handler);
  }

  /** 移除所有监听器 */
  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
